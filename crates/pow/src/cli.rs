//! The `rchat-pow` command for scripts: gets a trust token from an instance, or solves a
//! challenge.

use std::fs::File;
use std::io::Read;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use clap::error::ErrorKind;
use clap::{Parser, Subcommand, ValueEnum};
use serde_json::{Value, json};

use crate::{K_MAX, encode_nonces, seed_of, solve_parallel, work_of};

/// The most tries one solve may take, whatever an instance asks.
const WORK_MAX: f64 = 4_294_967_296.0;
const ANSWER_MAX: u64 = 1024 * 1024;
const SESSION_MAX: usize = 4096;
const SESSION_ENV: &str = "RCHAT_SESSION";
const SESSION_ARG: &str = "error: the session token is never taken on the command line, where other users and the shell history can read it. Put it in the RCHAT_SESSION environment variable, or in a file and pass --session-file <path> (- reads standard input)";

#[derive(Parser)]
#[command(name = "rchat-pow", about = "Solve an instance's proof of work")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Ask an instance for a challenge, solve it and print the trust token it gives.
    /// Send the token as X-Trust-Token.
    Token {
        /// The instance, for example https://chat.example.com
        url: String,
        /// A file holding the session token of an account; - reads standard input. Without it
        /// the RCHAT_SESSION environment variable is read, and without both the token is a
        /// guest's.
        #[arg(long)]
        session_file: Option<String>,
        #[arg(long, hide = true, num_args = 0..=1)]
        session: Option<Option<String>>,
        /// The kind of token.
        #[arg(long, value_enum, default_value_t = Class::General)]
        class: Class,
        /// The username a sign-in token is for.
        #[arg(long)]
        username: Option<String>,
        /// Threads to solve on. All cores but one when absent.
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
        threads: Option<u32>,
    },
    /// Solve a challenge and print the nonces as POST /pow/token takes them.
    Solve {
        /// The sealed challenge string, as the instance sent it.
        challenge: String,
        /// The number of sub-puzzles.
        #[arg(value_parser = clap::value_parser!(u32).range(..=i64::from(K_MAX)))]
        k: u32,
        /// The target, in decimal.
        target: u64,
        /// Threads to solve on. All cores but one when absent.
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
        threads: Option<u32>,
    },
}

#[derive(Clone, Copy, PartialEq, ValueEnum)]
enum Class {
    General,
    Signin,
}

fn threads(asked: Option<u32>) -> usize {
    let spare = std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1));
    asked.map_or(spare.max(1), |n| n as usize)
}

fn too_much(k: u32, target: u64) -> bool {
    k > 0 && work_of(k, target) > WORK_MAX
}

/// The session token, from the file (`-` is standard input) or else the environment. It is
/// never taken as an argument and never printed.
fn session(
    file: Option<&str>,
    env: &dyn Fn(&str) -> Option<String>,
    stdin: &mut dyn Read,
) -> Result<Option<String>, String> {
    let capped = |from: &mut dyn Read| {
        let mut text = String::new();
        from.take(16 * SESSION_MAX as u64)
            .read_to_string(&mut text)
            .map(|_| text)
    };
    let raw = match file {
        Some("-") => Some(
            capped(stdin)
                .map_err(|e| format!("error: can't read the session from standard input: {e}"))?,
        ),
        Some(path) => Some(
            File::open(path)
                .and_then(|mut f| capped(&mut f))
                .map_err(|e| format!("error: can't read the session file {path}: {e}"))?,
        ),
        None => env(SESSION_ENV).filter(|v| !v.trim().is_empty()),
    };
    let Some(raw) = raw else {
        return Ok(None);
    };
    let token = raw.trim();
    if token.is_empty() {
        return Err("error: the session file is empty".to_string());
    }
    if token.len() > SESSION_MAX {
        return Err(format!(
            "error: the session token is over {SESSION_MAX} bytes"
        ));
    }
    if !token.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("error: the session token has a character no token has".to_string());
    }
    Ok(Some(token.to_string()))
}

fn solved(challenge: &str, k: u32, target: u64, asked: Option<u32>) -> Result<String, String> {
    let cancel = AtomicBool::new(false);
    solve_parallel(
        &seed_of(challenge),
        k,
        target,
        threads(asked),
        |_| {},
        &cancel,
    )
    .map(|nonces| encode_nonces(&nonces))
    .ok_or_else(|| "The challenge has too many sub-puzzles".to_string())
}

fn post(
    client: &reqwest::blocking::Client,
    base: &str,
    path: &str,
    session: Option<&str>,
    body: Value,
) -> Result<Value, String> {
    let request = client
        .post(format!("{base}{path}"))
        .header("content-type", "application/json")
        .body(body.to_string());
    let request = match session {
        Some(token) => request.bearer_auth(token),
        None => request,
    };
    let answer = request
        .send()
        .map_err(|e| format!("POST {path} failed: {e}"))?;
    let status = answer.status().as_u16();
    let mut text = Vec::new();
    answer
        .take(ANSWER_MAX + 1)
        .read_to_end(&mut text)
        .map_err(|e| format!("POST {path} failed: {e}"))?;
    if text.len() as u64 > ANSWER_MAX {
        return Err(format!("POST {path} answered with more than 1 MiB"));
    }
    let json = serde_json::from_slice::<Value>(&text).ok();
    match ((200..300).contains(&status), json) {
        (true, Some(json)) => Ok(json),
        (true, None) => Err(format!("POST {path} answered {status} without JSON")),
        (false, json) => {
            let said = json.as_ref().and_then(|j| j["error"].as_str());
            Err(format!(
                "POST {path} answered {status}: {}",
                said.unwrap_or("no reason given")
            ))
        }
    }
}

fn token(
    url: &str,
    session: Option<&str>,
    class: Class,
    username: Option<&str>,
    asked: Option<u32>,
) -> Result<String, String> {
    let base = url.trim_end_matches('/');
    let client = reqwest::blocking::Client::new();
    let class = match class {
        Class::General => "general",
        Class::Signin => "signin",
    };
    let mut ask = json!({"class": class, "algs": ["s256"]});
    if let Some(name) = username {
        ask["username"] = json!(name);
    }
    let path = "/api/v1/pow/challenge";
    let given = post(&client, base, path, session, ask)?;
    let puzzle = (
        given["challenge"].as_str(),
        given["k"].as_u64().and_then(|k| u32::try_from(k).ok()),
        given["target"].as_str().and_then(|t| t.parse::<u64>().ok()),
    );
    let (Some(challenge), Some(k), Some(target)) = puzzle else {
        return Err(format!("POST {path} answered without a challenge"));
    };
    if too_much(k, target) {
        return Err(format!(
            "POST {path} asks for too much work: more than 2^32 tries"
        ));
    }
    let started = Instant::now();
    let nonces = solved(challenge, k, target, asked)?;
    let elapsed = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let redeem = json!({"challenge": challenge, "nonces": nonces, "elapsed_ms": elapsed});
    let path = "/api/v1/pow/token";
    let given = post(&client, base, path, session, redeem)?;
    given["token"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("POST {path} answered without a token"))
}

/// Runs the command line `args` (the program name first) with the environment and standard
/// input it is given: the line to print, or the error.
pub fn run(
    args: Vec<String>,
    env: &dyn Fn(&str) -> Option<String>,
    stdin: &mut dyn Read,
) -> Result<String, String> {
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(e) => {
            let text = e.to_string().trim_end().to_string();
            return match e.kind() {
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => Ok(text),
                _ => Err(text),
            };
        }
    };
    match cli.command {
        Command::Token {
            url,
            session_file,
            session: on_the_command_line,
            class,
            username,
            threads,
        } => match (on_the_command_line, class, &username) {
            (Some(_), _, _) => Err(SESSION_ARG.to_string()),
            (None, Class::General, Some(_)) => {
                Err("error: --username needs --class signin".to_string())
            }
            (None, Class::General, None) | (None, Class::Signin, _) => {
                let session = session(session_file.as_deref(), env, stdin)?;
                token(
                    &url,
                    session.as_deref(),
                    class,
                    username.as_deref(),
                    threads,
                )
            }
        },
        Command::Solve {
            challenge,
            k,
            target,
            threads,
        } => match too_much(k, target) {
            true => Err("error: too much work: more than 2^32 tries".to_string()),
            false => solved(&challenge, k, target, threads),
        },
    }
}
