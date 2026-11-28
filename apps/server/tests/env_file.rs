//! The env file the server reads at start, read the way the server reads it: a file it refuses
//! stops the server with the file, the line and what is wrong, never a value, and sets none of
//! its settings. A file it takes sets each of its settings as dotenvy reads them, and no setting
//! takes in the lines after it outside a value quoted from its first character.
#![cfg(unix)]
// This test waits for another process, on the machine's clock.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Set for a child of this test binary, which then loads the `.env.local` of its directory.
const CHILD: &str = "RCHAT_ENV_FILE_CHILD";
const SENTINEL: &str = "s3ntinel-7c1d";
const NUL: &str = "a NUL character";
const MIXED: &str = "a quote inside the value. Put the whole value in single quotes, or in double quotes if it has a single quote";
const BACKSLASH: &str = "a backslash right before a closing single quote. Put the value in double quotes and double each backslash";

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A directory holding `.env.local` with `text`.
fn scratch(name: &str, text: &[u8]) -> Scratch {
    let dir = std::env::temp_dir().join(format!("rchat-env-file-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("a scratch directory");
    fs::write(dir.join(".env.local"), text).expect("the env file");
    Scratch(dir)
}

/// Runs `command` to its end, with both streams kept.
fn run(command: &mut Command) -> Output {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("it starts");
    let deadline = Instant::now() + Duration::from_secs(60);
    while child.try_wait().expect("its state").is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            let out = child.wait_with_output().expect("its output");
            panic!(
                "it did not end: {}",
                String::from_utf8_lossy(&out.stderr).escape_debug()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    child.wait_with_output().expect("its output")
}

/// Bad files: a setting the server takes, then the bad one on line 2, then more settings.
fn bad_files() -> Vec<(&'static str, String, &'static str)> {
    let first = format!("RCHAT_ENV_TEST_FIRST={SENTINEL}-first\n");
    vec![
        (
            "nul",
            format!(
                "{first}RCHAT_ENV_TEST_NUL={SENTINEL}\0{SENTINEL}\nRCHAT_ENV_TEST_AFTER='{SENTINEL}'\n"
            ),
            NUL,
        ),
        (
            "quote",
            format!(
                "{first}RCHAT_ENV_TEST_QUOTE={SENTINEL}'s\nRCHAT_ENV_TEST_B=2\nRCHAT_ENV_TEST_C={SENTINEL}'s\nRCHAT_ENV_TEST_D=4\n"
            ),
            MIXED,
        ),
        (
            "hash",
            format!(
                "{first}RCHAT_ENV_TEST_HASH=#{SENTINEL}'s\nRCHAT_ENV_TEST_B=2\nRCHAT_ENV_TEST_C=won't\nRCHAT_ENV_TEST_D=4\n"
            ),
            MIXED,
        ),
        (
            "backslash",
            format!(
                "{first}RCHAT_ENV_TEST_PATH='C:\\{SENTINEL}\\' # a path\nRCHAT_ENV_TEST_B=2\nRCHAT_ENV_TEST_C=it's\nRCHAT_ENV_TEST_D=4\n"
            ),
            BACKSLASH,
        ),
    ]
}

#[test]
fn a_file_the_server_refuses_stops_it_with_the_line_and_no_value() {
    for (name, text, what) in bad_files() {
        let dir = scratch(name, text.as_bytes());
        let out = run(Command::new(env!("CARGO_BIN_EXE_server"))
            .current_dir(&dir.0)
            .env_clear());
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(
            out.status.code(),
            Some(1),
            "{name}: {}",
            stderr.escape_debug()
        );
        assert_eq!(stdout, "", "{name}");
        let file = dir.0.join(".env.local");
        assert_eq!(
            stderr,
            format!("Error: {} line 2: {what}\n", file.display()),
            "{name}"
        );
        assert!(stderr.is_ascii(), "{name}");
        for stream in [&stdout, &stderr] {
            assert!(!stream.contains(SENTINEL), "{name}");
        }
    }
}

/// When `CHILD` is set: loads `.env.local` as the server does and writes the error and every
/// variable it then has to `loaded.json`.
#[test]
#[allow(clippy::disallowed_methods)]
fn in_a_child_loads_the_env_file_of_its_directory() {
    if std::env::var_os(CHILD).is_none() {
        return;
    }
    let error = rust_next::env_file::load(".env.local")
        .err()
        .map(|e| e.to_string());
    let vars: BTreeMap<String, String> = std::env::vars().filter(|(k, _)| k != CHILD).collect();
    let loaded = serde_json::json!({ "error": error, "vars": vars });
    fs::write("loaded.json", loaded.to_string()).expect("loaded.json");
}

/// The error and the variables of a child that loaded the `.env.local` of `dir`, started with
/// only `env` set.
fn loaded(dir: &Path, env: &[(&str, &str)]) -> (Option<String>, BTreeMap<String, String>) {
    let out = run(
        Command::new(std::env::current_exe().expect("this test binary"))
            .args([
                "--exact",
                "in_a_child_loads_the_env_file_of_its_directory",
                "--test-threads=1",
            ])
            .current_dir(dir)
            .env_clear()
            .env(CHILD, "1")
            .envs(env.iter().copied()),
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = fs::read_to_string(dir.join("loaded.json")).expect("loaded.json");
    let loaded: serde_json::Value = serde_json::from_str(&text).expect("json");
    let error = loaded["error"].as_str().map(str::to_string);
    let vars = serde_json::from_value(loaded["vars"].clone()).expect("variables");
    (error, vars)
}

fn vars(list: &[(&str, &str)]) -> BTreeMap<String, String> {
    list.iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn a_refused_file_sets_none_of_its_settings() {
    for (name, text, what) in bad_files() {
        let dir = scratch(&format!("child-{name}"), text.as_bytes());
        let (error, set) = loaded(&dir.0, &[("RCHAT_ENV_TEST_KEPT", "kept")]);
        let file = dir.0.join(".env.local");
        assert_eq!(
            error,
            Some(format!("{} line 2: {what}", file.display())),
            "{name}"
        );
        assert_eq!(set, vars(&[("RCHAT_ENV_TEST_KEPT", "kept")]), "{name}");
    }
}

#[test]
fn quoted_values_load_as_the_dev_launcher_reads_them() {
    let text = "\
# Settings
RCHAT_ENV_TEST_PLAIN=plain
RCHAT_ENV_TEST_APOSTROPHE=\"don't\"
RCHAT_ENV_TEST_QUOTES='say \"hi\"'
RCHAT_ENV_TEST_JSON='{\"local.gossip.perRoom\": 16}'
RCHAT_ENV_TEST_LINES='first
second'
RCHAT_ENV_TEST_JOINED=\"${RCHAT_ENV_TEST_PLAIN} and more\"
RCHAT_ENV_TEST_KEPT='from the file'
RCHAT_ENV_TEST_LAST=last # a comment
";
    let want = vars(&[
        ("RCHAT_ENV_TEST_PLAIN", "plain"),
        ("RCHAT_ENV_TEST_APOSTROPHE", "don't"),
        ("RCHAT_ENV_TEST_QUOTES", "say \"hi\""),
        ("RCHAT_ENV_TEST_JSON", "{\"local.gossip.perRoom\": 16}"),
        ("RCHAT_ENV_TEST_LINES", "first\nsecond"),
        ("RCHAT_ENV_TEST_JOINED", "plain and more"),
        ("RCHAT_ENV_TEST_KEPT", "from the environment"),
        ("RCHAT_ENV_TEST_LAST", "last"),
    ]);
    let kept = [("RCHAT_ENV_TEST_KEPT", "from the environment")];
    for (name, text) in [
        ("lf", text.to_string()),
        ("crlf", text.replace('\n', "\r\n")),
    ] {
        let dir = scratch(&format!("quoted-{name}"), text.as_bytes());
        let (error, set) = loaded(&dir.0, &kept);
        assert_eq!(error, None, "{name}");
        assert_eq!(set, want, "{name}");
    }
}

#[test]
fn the_example_file_uncommented_loads_every_documented_value() {
    let example = include_str!("../../../.env.local.example");
    let mut text = String::new();
    let mut want = BTreeMap::new();
    for line in example.lines() {
        let line = match line.strip_prefix("# ") {
            Some(rest)
                if rest.split_once('=').is_some_and(|(name, _)| {
                    !name.is_empty()
                        && name
                            .chars()
                            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                }) =>
            {
                rest
            }
            _ => line,
        };
        if let Some((name, value)) = line.split_once('=')
            && !line.starts_with('#')
        {
            let value = value
                .strip_prefix('\'')
                .and_then(|v| v.strip_suffix('\''))
                .unwrap_or(value);
            want.entry(name.to_string())
                .or_insert_with(|| value.to_string());
        }
        text.push_str(line);
        text.push('\n');
    }
    assert!(want.len() > 120, "{} settings", want.len());
    let dir = scratch("example", text.as_bytes());
    let (error, set) = loaded(&dir.0, &[]);
    assert_eq!(error, None);
    assert_eq!(set, want);
}
