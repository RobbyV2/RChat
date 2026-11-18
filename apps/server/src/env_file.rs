use std::cell::Cell;
use std::io::{self, Read};
use std::path::Path;

const NAME: &str = "expected NAME=value, with a name that starts with a letter or _";
const EQUALS: &str = "expected = after the name, which has only letters, digits, _ and dots";
const SPACE: &str =
    "a space outside quotes ends the value, and more follows it. Put the value in single quotes";
const ESCAPE: &str =
    "a backslash escapes only \\, ', \", $, a space or n. Put the value in single quotes";
const QUOTE: &str = "a quote that is never closed";
const BRACE: &str = "a ${ without a } on the same line";
const END: &str = "the last line ends with a space or a backslash. End the file with a new line";
const TEXT: &str = "not UTF-8 text";
const NUL: &str = "a NUL character";
const MIXED: &str = "a quote inside the value. Put the whole value in single quotes, or in double quotes if it has a single quote";
const NAMED: &str = "a $NAME right before a closing quote. Write it as ${NAME}";
const DOLLAR: &str = "a $ right before a closing quote. Put the value in single quotes";
const BACKSLASH: &str = "a backslash right before a closing single quote. Put the value in double quotes and double each backslash";
const UNREADABLE: &str = "not a NAME=value line";

/// Where an env file stops parsing: its line and what is wrong there, without its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub line: usize,
    pub what: &'static str,
}

/// Gives dotenvy one line per read and counts the bytes it took, so a parse error has a line.
struct Lines<'a> {
    rest: &'a [u8],
    taken: &'a Cell<usize>,
}

impl Read for Lines<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let line = self
            .rest
            .iter()
            .position(|&b| b == b'\n')
            .map_or(self.rest.len(), |at| at + 1);
        let n = line.min(buf.len());
        buf[..n].copy_from_slice(&self.rest[..n]);
        self.rest = &self.rest[n..];
        self.taken.set(self.taken.get() + n);
        Ok(n)
    }
}

/// The `NAME=value` pairs of an env file, in file order, read by dotenvy's rules. A line they
/// refuse refuses the file, and so do a NUL character, a quote that doesn't hold the whole
/// value, which the dev launcher reads as text, and a setting that takes in the lines after it
/// outside a value quoted from its first character.
pub fn parse(text: &[u8]) -> Result<Vec<(String, String)>, Refusal> {
    let bytes = text.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(text);
    let line_at = |at: usize| 1 + bytes[..at].iter().filter(|&&b| b == b'\n').count();
    let text = std::str::from_utf8(bytes).map_err(|e| Refusal {
        line: line_at(e.valid_up_to()),
        what: TEXT,
    })?;
    if let Some(at) = text.find('\0') {
        return Err(Refusal {
            line: line_at(at),
            what: NUL,
        });
    }
    let taken = Cell::new(0);
    let mut pairs = Vec::new();
    let mut done = 0;
    let lines = Lines {
        rest: bytes,
        taken: &taken,
    };
    for item in dotenvy::from_read_iter(lines) {
        let end = taken.get();
        let start = done + skipped(&text[done..end]);
        let setting = &text[start..end];
        let refused = match (item, fault(setting)) {
            (Ok(_), Some((at, what @ (MIXED | NAMED | DOLLAR | BRACE | BACKSLASH)))) => {
                Some((at, what))
            }
            (Ok(pair), _) => {
                pairs.push(pair);
                None
            }
            (Err(_), Some(found)) => Some(found),
            (Err(_), None) => match end == text.len() && !text.ends_with('\n') {
                true => Some((setting.len().saturating_sub(1), END)),
                false => Some((0, UNREADABLE)),
            },
        };
        if let Some((at, what)) = refused {
            return Err(Refusal {
                line: line_at(start + at),
                what,
            });
        }
        done = end;
    }
    Ok(pairs)
}

/// The bytes of the blank and comment lines that start `text`.
fn skipped(text: &str) -> usize {
    text.split_inclusive('\n')
        .take_while(|line| {
            let line = line.trim_start();
            line.is_empty() || line.starts_with('#')
        })
        .map(str::len)
        .sum()
}

/// A name at the start of `line` and what follows it.
fn name(line: &str) -> Option<(&str, &str)> {
    if !line.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        return None;
    }
    let end = line
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
        .unwrap_or(line.len());
    Some(line.split_at(end))
}

/// What is wrong with a setting and where in it: what dotenvy refuses, a quote that doesn't
/// hold the whole value, or a value that runs onto the next line outside its quotes.
fn fault(setting: &str) -> Option<(usize, &'static str)> {
    let line = setting.trim_end();
    let at = |rest: &str| line.len() - rest.len();
    let start = line.trim_start();
    let Some((key, rest)) = name(start) else {
        return Some((at(start), NAME));
    };
    let mut rest = rest.trim_start();
    if key == "export" && !rest.starts_with('=') {
        let Some((_, after)) = name(rest) else {
            return Some((at(rest), NAME));
        };
        rest = after.trim_start();
    }
    let Some(value) = rest.strip_prefix('=') else {
        return Some((at(rest), EQUALS));
    };
    let value = value.trim_start();
    if value.starts_with('#') {
        return value.contains('\n').then_some((at(value), MIXED));
    }
    value_fault(value).map(|(i, what)| (at(value) + i, what))
}

#[derive(Clone, Copy, PartialEq)]
enum Sub {
    Off,
    Name { empty: bool },
    Braced,
}

/// Whitespace that ends a value outside quotes, and before a `#` starts a comment.
fn blank(c: char) -> bool {
    c.is_whitespace() && c != '\n' && c != '\r'
}

/// What is wrong in a value and where: what dotenvy refuses (more text after a space outside
/// quotes, an escape it doesn't know, a quote or `${` left open, a `$NAME` or `$` right before a
/// closing quote), a quote after the value's first character or inside `${...}`, text right
/// after its closing quote, a backslash right before a closing single quote, which dotenvy's line
/// reader takes as an escape, a `${` closed on a later line, or a new line outside quotes.
fn value_fault(value: &str) -> Option<(usize, &'static str)> {
    let (mut single, mut double, mut ended, mut closed) = (false, false, false, false);
    let (mut dollar, mut brace) = (0, 0);
    let (mut escaped, mut slash) = (None, None);
    let (mut sub, mut spaced) = (Sub::Off, false);
    for (at, c) in value.char_indices() {
        match (c, sub, single || double) {
            ('\n', Sub::Braced, _) => return Some((brace, BRACE)),
            ('\'' | '"', Sub::Braced, _) | ('\n', _, false) => return Some((at, MIXED)),
            _ => {}
        }
        if std::mem::take(&mut spaced) && c == '#' {
            return value[at..].contains('\n').then_some((at, MIXED));
        }
        if ended {
            match c {
                '#' => return value[at..].contains('\n').then_some((at, MIXED)),
                c if blank(c) => {}
                _ => return Some((at, SPACE)),
            }
        } else if let Some(from) = escaped {
            if !matches!(c, '\\' | '\'' | '"' | '$' | ' ' | 'n') {
                return Some((from, ESCAPE));
            }
            escaped = None;
        } else if single {
            match (c, slash) {
                ('\'', Some(from)) => return Some((from, BACKSLASH)),
                ('\'', None) => {
                    single = false;
                    closed = true;
                }
                ('\\', None) => slash = Some(at),
                _ => slash = None,
            }
        } else if closed {
            match c {
                c if blank(c) => ended = true,
                _ => return Some((at, MIXED)),
            }
        } else if let (Sub::Name { empty }, '"' | '\'') = (sub, c) {
            match (double, c, empty) {
                (true, '"', true) => return Some((at, DOLLAR)),
                (true, '"', false) => return Some((at, NAMED)),
                (true, _, _) => sub = Sub::Off,
                (false, _, _) => return Some((at, MIXED)),
            }
        } else if let (Sub::Name { empty: _ }, false) = (sub, double)
            && blank(c)
        {
            sub = Sub::Off;
            spaced = true;
        } else if sub != Sub::Off {
            sub = match sub {
                Sub::Name { empty: _ } if c.is_alphanumeric() => Sub::Name { empty: false },
                Sub::Name { empty: true } if c == '{' => {
                    brace = dollar;
                    Sub::Braced
                }
                Sub::Name { empty: _ } if c == '$' => {
                    dollar = at;
                    Sub::Name { empty: true }
                }
                Sub::Name { empty: _ } => Sub::Off,
                Sub::Braced if c == '}' => Sub::Off,
                Sub::Braced => Sub::Braced,
                Sub::Off => Sub::Off,
            };
        } else if c == '$' {
            dollar = at;
            sub = Sub::Name { empty: true };
        } else if double {
            match c {
                '"' => {
                    double = false;
                    closed = true;
                }
                '\\' => escaped = Some(at),
                _ => {}
            }
        } else {
            match c {
                '\'' | '"' if at > 0 => return Some((at, MIXED)),
                '\'' => single = true,
                '"' => double = true,
                '\\' => escaped = Some(at),
                c if blank(c) => ended = true,
                _ => {}
            }
        }
    }
    match (sub, single || double) {
        (Sub::Braced, _) => Some((brace, BRACE)),
        (_, true) => Some((0, QUOTE)),
        (Sub::Off | Sub::Name { empty: _ }, false) => None,
    }
}

/// `path` as plain ASCII: other characters as `\u{..}` escapes.
fn shown(path: &Path) -> String {
    let mut out = String::new();
    for c in path.display().to_string().chars() {
        match c.is_ascii() && !c.is_ascii_control() {
            true => out.push(c),
            false => out.extend(c.escape_unicode()),
        }
    }
    out
}

/// Loads the env file at `path` into the process environment, as dotenvy does: variables
/// already set keep their values, and a value over several lines has plain new lines, as the
/// dev launcher gives it. A file `parse` refuses sets nothing, and the error names the file,
/// the line and what is wrong, never a value.
pub fn load_path(path: &Path) -> anyhow::Result<()> {
    let file = shown(path);
    let raw =
        std::fs::read(path).map_err(|e| anyhow::anyhow!("{file} can't be read: {}", e.kind()))?;
    let text: Vec<u8> = raw
        .iter()
        .enumerate()
        .filter(|&(i, &b)| !(b == b'\r' && raw.get(i + 1) == Some(&b'\n')))
        .map(|(_, &b)| b)
        .collect();
    if let Err(Refusal { line, what }) = parse(&text) {
        anyhow::bail!("{file} line {line}: {what}");
    }
    dotenvy::from_read(text.as_slice()).map_err(|_| anyhow::anyhow!("{file} can't be read"))
}

/// Loads the first file called `name` in the working directory or a directory above it, if
/// there is one.
pub fn load(name: &str) -> anyhow::Result<()> {
    let Ok(here) = std::env::current_dir() else {
        return Ok(());
    };
    match here
        .ancestors()
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
    {
        Some(path) => load_path(&path),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn temp_file(tag: &str, text: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rchat_env_file_{tag}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(".env.local");
        std::fs::write(&path, text).expect("write");
        path
    }

    #[test]
    fn a_line_that_does_not_parse_refuses_the_file_with_its_line_number() {
        let text = "A=1\n# a comment\n\nP2P_LIMITS={\"local.gossip.perRoom\": 16}\nB=2\n";
        assert_eq!(
            parse(text.as_bytes()),
            Err(Refusal {
                line: 4,
                what: MIXED
            })
        );
        let crlf = text.replace('\n', "\r\n");
        assert_eq!(parse(crlf.as_bytes()).map_err(|r| r.line), Err(4));
        let last = "A=1\nB=x y";
        assert_eq!(parse(last.as_bytes()).map_err(|r| r.line), Err(2));
        let bom = "\u{feff}A=1\nB=x y\n";
        assert_eq!(parse(bom.as_bytes()).map_err(|r| r.line), Err(2));
        let spanning = "A='one\ntwo\nthree'\n\nB=1\nC=x y\nD=2\n";
        assert_eq!(parse(spanning.as_bytes()).map_err(|r| r.line), Err(6));
        let long = format!(
            "A={}\n# {}\nB=x y\n",
            "a".repeat(20_000),
            "c".repeat(20_000)
        );
        assert_eq!(parse(long.as_bytes()).map_err(|r| r.line), Err(3));
    }

    #[test]
    fn each_kind_of_bad_line_says_what_is_wrong() {
        for (text, line, what) in [
            (&b"A=1\n1A=2\n"[..], 2, NAME),
            (&b"A=1\n=2\n"[..], 2, NAME),
            (&b"A-B=1\n"[..], 1, EQUALS),
            (&b"A\n"[..], 1, EQUALS),
            (&b"export A B=1\n"[..], 1, EQUALS),
            (&b"A=one two\n"[..], 1, SPACE),
            (&b"A=\"one\" two\n"[..], 1, SPACE),
            (&b"A=\"one\\qtwo\"\n"[..], 1, ESCAPE),
            (&b"A=one\\q\n"[..], 1, ESCAPE),
            (&b"A=1\nB='one\nC=2\n"[..], 2, QUOTE),
            (&b"A=1\nB=\"one\nC=2\n"[..], 2, QUOTE),
            (&b"A=1\nB=x${C\n"[..], 2, BRACE),
            (&b"A=1\nB=x "[..], 2, END),
            (&b"A=1\nB=x\\"[..], 2, END),
            (&b"A=1\nB=\xff\n"[..], 2, TEXT),
            (&b"A=1\nB=x\0y\nC=2\n"[..], 2, NUL),
            (&b"A=1\n# a\0comment\n"[..], 2, NUL),
            (&b"A=don't\nB=2\nC=won't\nD=4\n"[..], 1, MIXED),
            (&b"A=1\nB=it's\nC=2\n"[..], 2, MIXED),
            (&b"A=ab\"cd\"ef\n"[..], 1, MIXED),
            (&b"A=x#it's\nB=2\nC='\n"[..], 1, MIXED),
            (&b"A=\"one\"two\n"[..], 1, MIXED),
            (&b"A='one'#two\n"[..], 1, MIXED),
            (&b"A='one'$B\n"[..], 1, MIXED),
            (&b"A='one\ntwo'three\nB=2\n"[..], 2, MIXED),
            (&b"A='one\ntwo' three\n"[..], 2, SPACE),
            (&b"A=\"one\ntwo\\q\"\n"[..], 2, ESCAPE),
            (&b"A=1\nB=$A's\nC=2\n"[..], 2, MIXED),
            (&b"A=1\nB=x$A\"y\nC=\"\n"[..], 2, MIXED),
            (&b"A=1\nB=\"x $A\"\nC=2\n"[..], 2, NAMED),
            (&b"A=1\nB=\"hunter2$\"\nC=2\n"[..], 2, DOLLAR),
            (
                &b"RCHAT_NOTE=#don't\nINSTANCE_NAME=Swallowed\nRCHAT_OTHER=won't\nRCHAT_LAST=4\n"[..],
                1,
                MIXED,
            ),
            (
                &b"RCHAT_PATH='C:\\dir\\' # a path\nINSTANCE_NAME=Swallowed\nRCHAT_OTHER=it's\nRCHAT_LAST=4\n"[..],
                1,
                BACKSLASH,
            ),
            (&b"RCHAT_A=#don't\nRCHAT_B=2\nRCHAT_C=won't\nRCHAT_D=4\n"[..], 1, MIXED),
            (&b"A=#\"\nB= \"xx}\nC=x\n"[..], 1, MIXED),
            (&b"A='C:\\dir\\'\nB=2\n"[..], 1, BACKSLASH),
            (&b"A=b\nB=${\t\"\\\nC={{\nD='\nE=a\"x}\n"[..], 2, MIXED),
            (&b"A=\"${B\nC=2}\"\n"[..], 1, BRACE),
            (&b"A=${B'}\nC=${D'}\n"[..], 1, MIXED),
            (&b"A=${B'} # a\nC=2\nD='\n"[..], 1, MIXED),
            (&b"A=\"$B\\\" # it's\nC=2\n\"\n"[..], 1, MIXED),
            (&b"A={\nB=$\t\"==\nC=}\"}\n"[..], 2, MIXED),
            (&b"A=\"$#\nB=''\nC=${\"\"#} \nD=\"\n"[..], 3, MIXED),
            (&b"A=${B'} #'\n"[..], 1, MIXED),
        ] {
            let found = parse(text);
            let shown = String::from_utf8_lossy(text);
            assert_eq!(found, Err(Refusal { line, what }), "{shown:?}");
        }
    }

    #[test]
    fn lines_that_parse_keep_their_values() {
        let text = "\
# a comment
  # an indented comment

A=plain
export B=exported
C='single \"quoted\" $A'
D=\"double \\\"quoted\\\" ${A}\"
E=value # a comment after it
F=
G='first
second'
H=a=b
I.J=dotted
K=\"don't\"
L='say \"hi\"' # a comment
M=\"$A's\"
N=$A-${A}x
O=$A #it's a comment
P='a\\\\b' # it's
";
        assert_eq!(
            parse(text.as_bytes()),
            Ok(pairs(&[
                ("A", "plain"),
                ("B", "exported"),
                ("C", "single \"quoted\" $A"),
                ("D", "double \"quoted\" plain"),
                ("E", "value"),
                ("F", ""),
                ("G", "first\nsecond"),
                ("H", "a=b"),
                ("I.J", "dotted"),
                ("K", "don't"),
                ("L", "say \"hi\""),
                ("M", "plain's"),
                ("N", "plain-plainx"),
                ("O", "plain"),
                ("P", "a\\\\b"),
            ]))
        );
        assert_eq!(parse(b""), Ok(Vec::new()));
    }

    /// The names of the settings in `text` for a reader that gives each `NAME=` line its own
    /// setting, except the lines inside a value quoted from its first character.
    fn names_by_line(text: &str) -> Option<Vec<String>> {
        let blank = [' ', '\t'];
        let mut names = Vec::new();
        let mut at = 0;
        while at < text.len() {
            let end = text[at..].find('\n').map_or(text.len(), |n| at + n);
            let line = text[at..end].trim_start_matches(blank);
            at = end + 1;
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let line = match line.strip_prefix("export ") {
                Some(rest) => rest.trim_start_matches(blank),
                None => line,
            };
            let (key, rest) = name(line)?;
            let value = rest
                .trim_start_matches(blank)
                .strip_prefix('=')?
                .trim_start_matches(blank);
            names.push(key.to_string());
            let quote = match value.chars().next() {
                Some(q @ ('\'' | '"')) => q,
                _ => continue,
            };
            let from = end - value.len() + 1;
            let mut chars = text[from..].char_indices();
            let mut close = None;
            while let Some((i, c)) = chars.next() {
                match c {
                    '\\' if quote == '"' => {
                        chars.next();
                    }
                    c if c == quote => {
                        close = Some(from + i);
                        break;
                    }
                    _ => {}
                }
            }
            let close = close?;
            at = text[close..]
                .find('\n')
                .map_or(text.len(), |n| close + n + 1);
        }
        Some(names)
    }

    #[test]
    fn an_accepted_file_has_a_setting_for_each_line_outside_quoted_values() {
        let atoms = [
            "a", "b", "n", "=", "'", "\"", "#", " ", "\t", "\\", "$", "{", "}",
        ];
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        let (mut accepted, mut spanning) = (0, 0);
        for _ in 0..100_000 {
            let mut text = String::new();
            for j in 0..2 + next(4) {
                match next(12) {
                    0 => text.push_str("# "),
                    1 => text.push_str("export "),
                    2 => text.push_str("  "),
                    _ => {}
                }
                text.push_str(&format!("K{j}="));
                for _ in 0..next(8) {
                    text.push_str(atoms[next(atoms.len())]);
                }
                text.push('\n');
            }
            let Ok(found) = parse(text.as_bytes()) else {
                continue;
            };
            accepted += 1;
            spanning += usize::from(found.iter().any(|(_, v)| v.contains('\n')));
            let names: Vec<String> = found.into_iter().map(|(k, _)| k).collect();
            assert_eq!(Some(names), names_by_line(&text), "{text:?}");
        }
        assert!(accepted > 10_000 && spanning > 100, "{accepted} {spanning}");
    }

    #[test]
    fn a_refused_file_names_its_line_and_problem_and_never_its_values() {
        let secret = "hunter2-s3cr3t";
        for (tag, bad, what) in [
            ("space", format!("{secret} {secret}"), SPACE),
            ("nul", format!("{secret}\0{secret}"), NUL),
            ("quote", format!("{secret}'s"), MIXED),
        ] {
            let path = temp_file(
                &format!("refused_{tag}_\u{e9}"),
                &format!(
                    "RCHAT_ENV_FILE_TEST_BEFORE={secret}\nRCHAT_ENV_FILE_TEST_BAD={bad}\nRCHAT_ENV_FILE_TEST_AFTER='{secret}'\n"
                ),
            );
            let err = load_path(&path).unwrap_err().to_string();
            let file = path.display().to_string().replace('\u{e9}', "\\u{e9}");
            assert_eq!(err, format!("{file} line 2: {what}"));
            assert!(err.is_ascii());
            assert!(!err.contains(secret) && !err.contains("RCHAT_ENV_FILE_TEST"));
            for name in ["BEFORE", "BAD", "AFTER"] {
                let name = format!("RCHAT_ENV_FILE_TEST_{name}");
                assert!(std::env::var_os(&name).is_none(), "{name} is not set");
            }
            let _ = std::fs::remove_dir_all(path.parent().expect("dir"));
        }
    }

    #[test]
    fn a_file_that_parses_loads_and_keeps_variables_already_set() {
        unsafe {
            std::env::set_var("RCHAT_ENV_FILE_TEST_KEPT", "from the environment");
        }
        let path = temp_file(
            "loaded",
            "RCHAT_ENV_FILE_TEST_KEPT='from the file'\nRCHAT_ENV_FILE_TEST_NEW='{\"a\": 1}'\n",
        );
        load_path(&path).expect("loads");
        assert_eq!(
            std::env::var("RCHAT_ENV_FILE_TEST_KEPT").as_deref(),
            Ok("from the environment")
        );
        assert_eq!(
            std::env::var("RCHAT_ENV_FILE_TEST_NEW").as_deref(),
            Ok("{\"a\": 1}")
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn an_unreadable_or_missing_file() {
        let dir = std::env::temp_dir().join(format!("rchat_env_file_dir_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let err = load_path(&dir).unwrap_err().to_string();
        assert!(
            err.starts_with(&format!("{} can't be read: ", dir.display())),
            "{err}"
        );
        assert!(err.is_ascii());
        load("rchat-env-file-test-that-no-directory-has").expect("no file is fine");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_example_line_uncommented_loads_the_value_its_comment_documents() {
        let example = include_str!("../../../.env.local.example");
        let mut uncommented = String::new();
        let mut documented = Vec::new();
        let mut lines = Vec::new();
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
                lines.push(line);
                documented.push((name.to_string(), value.to_string()));
            }
            uncommented.push_str(line);
            uncommented.push('\n');
        }
        assert!(documented.len() > 120, "{} settings", documented.len());
        assert_eq!(parse(uncommented.as_bytes()), Ok(documented.clone()));
        for (line, pair) in lines.iter().zip(&documented) {
            assert_eq!(parse(line.as_bytes()), Ok(vec![pair.clone()]), "{line}");
        }
        let ice = documented
            .iter()
            .find(|(name, _)| name == "ICE_SERVERS")
            .map(|(_, value)| value.as_str())
            .expect("ICE_SERVERS is documented");
        let config = crate::config::AppConfig::from_map(&[("ICE_SERVERS", ice)]).expect("loads");
        assert_eq!(
            config.ice().expect("ICE servers").extra,
            vec![crate::relay::IceServer {
                urls: vec!["turn:turn.example.com:3478".to_string()],
                username: Some("u".to_string()),
                credential: Some("p".to_string()),
            }]
        );
    }
}
