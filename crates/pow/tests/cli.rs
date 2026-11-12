use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::{Arc, Mutex};

use rchat_pow::cli;
use rchat_pow::{decode_nonces, encode_nonces, open, seal, seed_of, solve, target_for, verify};
use serde_json::{Value, json};

const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";
const TOKEN: &str = "t1.1.eyJ2IjoxfQ.3zNRILTD7EPHkOT1Xs2Rjw";

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    auth: Option<String>,
    client: Option<String>,
    body: Value,
}

#[derive(Clone, Copy, PartialEq)]
enum Mood {
    Fine,
    PowOff,
    RefusesSolutions,
    NotJson,
    TooMuchWork,
    Huge,
}

fn answer(mood: Mood, seen: &Seen) -> (u16, String) {
    match (mood, seen.path.as_str()) {
        (Mood::PowOff, _) => (404, json!({"error": "Not found"}).to_string()),
        (Mood::NotJson, _) => (200, "<html>Checking your browser</html>".to_string()),
        (Mood::Huge, _) => (
            200,
            json!({"challenge": "c".repeat(2 * 1024 * 1024)}).to_string(),
        ),
        (Mood::TooMuchWork, _) => (
            200,
            json!({"challenge": "c1.1.e30.AAAA", "alg": "s256", "k": 4, "target": "1", "work": 4096})
                .to_string(),
        ),
        (_, "/api/v1/pow/challenge") => {
            let cls = seen.body["class"].as_str().unwrap_or("general");
            let payload = json!({"v": 1, "alg": "s256", "cls": cls, "sub": "g:5e3c1d2a9f0b7c41a2b3",
                "k": 4, "w": 4096, "iat": 1767225600, "exp": 1767225901, "r": "AAECAwQFBgcICQoLDA0ODw"});
            let challenge = seal(KEY, "c1", "1", payload.to_string().as_bytes());
            let body = json!({"challenge": challenge, "alg": "s256", "k": 4,
                "target": target_for(4, 4096).to_string(), "work": 4096, "expires_at": 1767225901,
                "estimate": {"laptop_ms": 1, "phone_ms": 1, "slow_phone_ms": 2}});
            (200, body.to_string())
        }
        (Mood::Fine, "/api/v1/pow/token") => {
            let challenge = seen.body["challenge"].as_str().unwrap_or_default();
            let payload = open(|_| Some(KEY.to_vec()), "c1", challenge);
            let cls = payload
                .and_then(|p| serde_json::from_slice::<Value>(&p).ok())
                .map(|p| p["cls"].as_str().unwrap_or_default().to_string());
            let nonces = decode_nonces(seen.body["nonces"].as_str().unwrap_or_default(), 4);
            let solved =
                nonces.is_some_and(|n| verify(&seed_of(challenge), 4, target_for(4, 4096), &n));
            match (cls, solved) {
                (Some(cls), true) => (
                    200,
                    json!({"token": format!("{TOKEN}{cls}"), "kind": cls, "expires_at": 1767268810,
                        "budget": 30000, "renew_at": 1767260170, "level": 4096})
                    .to_string(),
                ),
                (_, _) => (
                    400,
                    json!({"error": "Invalid or expired challenge"}).to_string(),
                ),
            }
        }
        (_, "/api/v1/pow/token") => (
            400,
            json!({"error": "Invalid or expired challenge"}).to_string(),
        ),
        (_, _) => (404, json!({"error": "Not found"}).to_string()),
    }
}

fn serve(mut stream: TcpStream, mood: Mood, log: &Mutex<Vec<Seen>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let path = line.split(' ').nth(1).unwrap_or_default().to_string();
    let (mut length, mut auth, mut client) = (0, None, None);
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
        let Some((name, value)) = header.trim_end().split_once(':') else {
            break;
        };
        let value = value.trim().to_string();
        match name.to_ascii_lowercase().as_str() {
            "content-length" => length = value.parse().unwrap(),
            "authorization" => auth = Some(value),
            "x-trust-client" => client = Some(value),
            _ => {}
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    let seen = Seen {
        path,
        auth,
        client,
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    };
    let (status, text) = answer(mood, &seen);
    log.lock().unwrap().push(seen);
    let head = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        text.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(text.as_bytes()).unwrap();
}

/// A stand-in instance on a loopback port: the two endpoints a script needs, as the API
/// answers them.
fn instance(mood: Mood) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let seen = log.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            serve(stream, mood, &seen);
        }
    });
    (url, log)
}

fn args(list: &[&str]) -> Vec<String> {
    std::iter::once("rchat-pow")
        .chain(list.iter().copied())
        .map(String::from)
        .collect()
}

/// The command with an environment and a standard input of the test's making.
fn run_in(list: &[&str], env: &[(&str, &str)], stdin: &str) -> Result<String, String> {
    let var = |name: &str| {
        let found = env.iter().find(|(n, _)| *n == name);
        found.map(|(_, value)| value.to_string())
    };
    cli::run(args(list), &var, &mut stdin.as_bytes())
}

fn run(list: Vec<String>) -> Result<String, String> {
    cli::run(list, &|_| None, &mut std::io::empty())
}

fn session_file(name: &str, text: &str) -> String {
    let path = std::env::temp_dir().join(format!("rchat-pow-test-{}-{name}", std::process::id()));
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn token_solves_for_a_guest_and_prints_the_token() {
    let (url, log) = instance(Mood::Fine);
    assert_eq!(run(args(&["token", &url])), Ok(format!("{TOKEN}general")));
    let log = log.lock().unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].path, "/api/v1/pow/challenge");
    assert_eq!(log[0].body, json!({"class": "general", "algs": ["s256"]}));
    assert_eq!(log[1].path, "/api/v1/pow/token");
    assert_eq!(
        log[1].body["challenge"].as_str().unwrap().split('.').next(),
        Some("c1")
    );
    assert_eq!(log[1].body["nonces"].as_str().unwrap().len(), 64);
    assert!(log[1].body["elapsed_ms"].is_u64());
    assert!(log.iter().all(|s| s.auth.is_none() && s.client.is_none()));
}

#[test]
fn the_session_comes_from_the_environment_a_file_or_standard_input() {
    let bearer = |log: &Mutex<Vec<Seen>>| {
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].path, "/api/v1/pow/challenge");
        log.iter().map(|s| s.auth.clone()).collect::<Vec<_>>()
    };
    let sent = |token: &str| vec![Some(format!("Bearer {token}")); 2];
    let (url, log) = instance(Mood::Fine);
    let slash = format!("{url}/");
    assert_eq!(
        run_in(&["token", &slash], &[("RCHAT_SESSION", "s3cret")], ""),
        Ok(format!("{TOKEN}general"))
    );
    assert_eq!(bearer(&log), sent("s3cret"));

    let (url, log) = instance(Mood::Fine);
    let file = session_file("file", "from-a-file\n");
    assert_eq!(
        run_in(&["token", &url, "--session-file", &file], &[], ""),
        Ok(format!("{TOKEN}general"))
    );
    assert_eq!(bearer(&log), sent("from-a-file"));

    let (url, log) = instance(Mood::Fine);
    assert_eq!(
        run_in(
            &["token", &url, "--session-file", "-"],
            &[],
            "  from-stdin \r\n"
        ),
        Ok(format!("{TOKEN}general"))
    );
    assert_eq!(bearer(&log), sent("from-stdin"));

    let (url, log) = instance(Mood::Fine);
    run_in(
        &["token", &url, "--session-file", &file],
        &[("RCHAT_SESSION", "from-the-environment")],
        "",
    )
    .unwrap();
    assert_eq!(
        bearer(&log),
        sent("from-a-file"),
        "the file is the more explicit of the two"
    );
    std::fs::remove_file(&file).unwrap();

    let (url, log) = instance(Mood::Fine);
    run_in(&["token", &url], &[("RCHAT_SESSION", "")], "").unwrap();
    assert_eq!(
        bearer(&log),
        vec![None, None],
        "an empty variable is no session"
    );
}

#[test]
fn the_session_is_never_taken_as_an_argument() {
    let (url, log) = instance(Mood::Fine);
    for list in [
        &["token", url.as_str(), "--session", "s3cret"][..],
        &["token", "--session=s3cret", url.as_str()],
        &["token", url.as_str(), "--session"],
    ] {
        let e = run_in(list, &[], "").unwrap_err();
        assert!(
            e.contains("RCHAT_SESSION") && e.contains("--session-file"),
            "{e}"
        );
        assert!(e.contains("never taken on the command line"), "{e}");
        assert!(!e.contains("s3cret"), "{e}");
    }
    assert!(log.lock().unwrap().is_empty(), "nothing was sent");
    let help = run_in(&["token", "--help"], &[], "").unwrap();
    assert!(
        help.contains("--session-file") && help.contains("RCHAT_SESSION"),
        "{help}"
    );
    assert!(
        !help.contains("--session <") && !help.contains("--session "),
        "{help}"
    );
}

#[test]
fn no_secret_is_printed() {
    let secret = "s3cret-s3ss10n";
    let env = [("RCHAT_SESSION", secret)];
    for mood in [
        Mood::RefusesSolutions,
        Mood::PowOff,
        Mood::NotJson,
        Mood::TooMuchWork,
        Mood::Huge,
    ] {
        let (url, _) = instance(mood);
        let e = run_in(&["token", &url], &env, "").unwrap_err();
        assert!(!e.contains(secret), "{e}");
    }
    let e = run_in(&["token", "http://127.0.0.1:1"], &env, "").unwrap_err();
    assert!(!e.contains(secret), "{e}");
    let (url, log) = instance(Mood::Fine);
    for odd in [
        "two words",
        "line\nbreak",
        "tab\tbed",
        "caf\u{e9}",
        "nul\u{0}",
    ] {
        let e = run_in(&["token", &url, "--session-file", "-"], &[], odd).unwrap_err();
        assert_eq!(e, "error: the session token has a character no token has");
        let e = run_in(&["token", &url], &[("RCHAT_SESSION", odd)], "").unwrap_err();
        assert_eq!(e, "error: the session token has a character no token has");
    }
    let long = "a".repeat(4097);
    let e = run_in(&["token", &url, "--session-file", "-"], &[], &long).unwrap_err();
    assert_eq!(e, "error: the session token is over 4096 bytes");
    let e = run_in(&["token", &url, "--session-file", "-"], &[], " \n").unwrap_err();
    assert_eq!(e, "error: the session file is empty");
    let missing = std::env::temp_dir().join("rchat-pow-test-no-such-file");
    let missing = missing.to_string_lossy();
    let e = run_in(&["token", &url, "--session-file", &missing], &[], "").unwrap_err();
    assert!(
        e.starts_with(&format!("error: can't read the session file {missing}: ")),
        "{e}"
    );
    assert!(log.lock().unwrap().is_empty(), "nothing was sent");
}

#[test]
fn work_past_2_to_the_32_and_answers_past_1_mib_are_refused() {
    let (url, log) = instance(Mood::TooMuchWork);
    assert_eq!(
        run(args(&["token", &url])),
        Err("POST /api/v1/pow/challenge asks for too much work: more than 2^32 tries".to_string())
    );
    assert_eq!(
        log.lock().unwrap().len(),
        1,
        "the solution was never started or sent"
    );
    for (k, target) in [
        ("4", "1"),
        ("16", "68719476735"),
        ("1", "0"),
        ("64", "274877906943"),
    ] {
        assert_eq!(
            run(args(&["solve", "c1.1.e30.AAAA", k, target])),
            Err("error: too much work: more than 2^32 tries".to_string()),
            "{k} {target}"
        );
    }
    let (url, _) = instance(Mood::Huge);
    assert_eq!(
        run(args(&["token", &url])),
        Err("POST /api/v1/pow/challenge answered with more than 1 MiB".to_string())
    );
}

#[test]
fn a_sign_in_token_names_its_class_and_username() {
    let (url, log) = instance(Mood::Fine);
    assert_eq!(
        run(args(&[
            "token",
            &url,
            "--class",
            "signin",
            "--username",
            "Alice"
        ])),
        Ok(format!("{TOKEN}signin"))
    );
    assert_eq!(
        log.lock().unwrap()[0].body,
        json!({"class": "signin", "algs": ["s256"], "username": "Alice"})
    );
    let (url, log) = instance(Mood::Fine);
    run(args(&[
        "token",
        &url,
        "--class",
        "signin",
        "--threads",
        "1",
    ]))
    .unwrap();
    assert_eq!(
        log.lock().unwrap()[0].body,
        json!({"class": "signin", "algs": ["s256"]})
    );
}

#[test]
fn refusals_carry_the_instances_words() {
    let (url, _) = instance(Mood::RefusesSolutions);
    assert_eq!(
        run(args(&["token", &url])),
        Err("POST /api/v1/pow/token answered 400: Invalid or expired challenge".to_string())
    );
    let (url, log) = instance(Mood::PowOff);
    assert_eq!(
        run(args(&["token", &url])),
        Err("POST /api/v1/pow/challenge answered 404: Not found".to_string())
    );
    assert_eq!(log.lock().unwrap().len(), 1);
    let (url, _) = instance(Mood::NotJson);
    let e = run(args(&["token", &url])).unwrap_err();
    assert!(
        e.starts_with("POST /api/v1/pow/challenge answered 200 without JSON"),
        "{e}"
    );
    let e = run(args(&["token", "http://127.0.0.1:1"])).unwrap_err();
    assert!(e.starts_with("POST /api/v1/pow/challenge failed"), "{e}");
}

#[test]
fn solve_prints_winning_nonces() {
    let v: Value = serde_json::from_str(include_str!("vectors.json")).unwrap();
    let (challenge, target) = (
        v["challenge"].as_str().unwrap(),
        v["target"].as_str().unwrap(),
    );
    assert_eq!(
        run(args(&["solve", challenge, "4", target, "--threads", "1"])).as_deref(),
        Ok(v["nonces_wire"].as_str().unwrap())
    );
    let wire = run(args(&["solve", challenge, "4", target])).unwrap();
    let nonces = decode_nonces(&wire, 4).unwrap();
    assert!(verify(
        &seed_of(challenge),
        4,
        target.parse().unwrap(),
        &nonces
    ));
    assert_eq!(
        run(args(&["solve", "c1.1.x.y", "0", "1"])).as_deref(),
        Ok("")
    );
    let (nonces, _) = solve(&seed_of("c1.1.x.y"), 2, u64::MAX);
    assert_eq!(
        run(args(&[
            "solve",
            "c1.1.x.y",
            "2",
            &u64::MAX.to_string(),
            "--threads",
            "1"
        ])),
        Ok(encode_nonces(&nonces))
    );
}

#[test]
fn bad_arguments_are_refused_with_the_usage() {
    for bad in [
        &[][..],
        &["token"],
        &["mine", "x"],
        &["token", "http://127.0.0.1:1", "--class", "page"],
        &["token", "http://127.0.0.1:1", "--username", "alice"],
        &["solve", "c1.1.x.y", "4"],
        &["solve", "c1.1.x.y", "65", "1"],
        &["solve", "c1.1.x.y", "4", "many"],
        &["solve", "c1.1.x.y", "4", "1", "--threads", "0"],
    ] {
        let e = run(args(bad)).unwrap_err();
        assert!(
            e.contains("Usage") || e.contains("usage") || e.contains("error:"),
            "{bad:?}: {e}"
        );
    }
}

#[test]
fn the_binary_prints_the_token_and_exits_with_the_outcome() {
    let (url, log) = instance(Mood::Fine);
    let out = Command::new(env!("CARGO_BIN_EXE_rchat-pow"))
        .args(["token", &url])
        .env("RCHAT_SESSION", "s3cret")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        format!("{TOKEN}general\n")
    );
    assert!(out.stderr.is_empty());
    assert_eq!(
        log.lock().unwrap()[1].auth.as_deref(),
        Some("Bearer s3cret")
    );

    let (url, log) = instance(Mood::Fine);
    let mut child = Command::new(env!("CARGO_BIN_EXE_rchat-pow"))
        .args(["token", &url, "--session-file", "-"])
        .env_remove("RCHAT_SESSION")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"piped-in\n")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert_eq!(
        log.lock().unwrap()[0].auth.as_deref(),
        Some("Bearer piped-in")
    );

    let (url, _) = instance(Mood::PowOff);
    let out = Command::new(env!("CARGO_BIN_EXE_rchat-pow"))
        .args(["token", &url, "--session", "s3cret"])
        .env_remove("RCHAT_SESSION")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    let said = String::from_utf8(out.stderr).unwrap();
    assert!(
        said.contains("never taken on the command line") && !said.contains("s3cret"),
        "{said}"
    );

    let out = Command::new(env!("CARGO_BIN_EXE_rchat-pow"))
        .args(["token", &url])
        .env_remove("RCHAT_SESSION")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(
        String::from_utf8(out.stderr).unwrap(),
        "POST /api/v1/pow/challenge answered 404: Not found\n"
    );
}

#[test]
fn generated_command_lines_never_panic_and_answer_the_same_in_every_build() {
    use sha2::{Digest, Sha256};
    let words = [
        "solve",
        "token",
        "help",
        "--help",
        "--threads",
        "--session",
        "--session=x",
        "--session-file",
        "-",
        "--class",
        "signin",
        "general",
        "page",
        "--username",
        "alice",
        "c1.1.x.y",
        "0",
        "1",
        "2",
        "64",
        "65",
        "-1",
        "18446744073709551615",
        "18446744073709551616",
        "",
        "\u{e9}",
        "--",
    ];
    let mut state = 9u64;
    let mut below = |n: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state.wrapping_mul(0x2545_f491_4f6c_dd1d) % n as u64) as usize
    };
    let mut seen = Sha256::new();
    for _ in 0..3000 {
        let list: Vec<&str> = match below(3) {
            0 => {
                let k = ["0", "1", "2", "64", "65", "-1", ""][below(7)];
                let target = [
                    "18446744073709551615",
                    "18446744073709551616",
                    "0",
                    "1",
                    "65",
                    "-1",
                ][below(6)];
                let mut list = vec!["solve", "c1.1.x.y", k, target];
                if below(3) == 0 {
                    list.extend(["--threads", ["0", "1", "2", "x"][below(4)]]);
                }
                list
            }
            _ => (0..below(7)).map(|_| words[below(words.len())]).collect(),
        };
        let answer = run_in(&list, &[], "tok\n");
        if let Ok(line) = &answer {
            assert!(line.is_ascii(), "{list:?}: {line}");
        }
        let said = match &answer {
            Ok(line) if list.first() == Some(&"solve") => format!("solved {}", line.len()),
            Ok(line) => format!("ok {line}"),
            Err(e) if e.contains("failed: ") => "the request could not be made".to_string(),
            Err(e) => format!("no {e}"),
        };
        seen.update((said.len() as u64).to_le_bytes());
        seen.update(said);
    }
    let digest: String = seen.finalize().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        digest,
        "fd56520b3c28f5a36eed54511e1a7b1b76ec1e570488e92e729c4959e761866f"
    );
}
