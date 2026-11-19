// The server's log: the last lines in memory for the settings page, and a file that rotates.

use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;

const LINES: usize = 2000;
const FILE: &str = "server.log";
const FILE_BYTES: u64 = 5 * 1024 * 1024;
// Rotated files kept next to the current one.
const KEPT: usize = 3;
// The server's own lines, and this crate's about it.
const SOURCES: [&str; 2] = ["rust_next", "rchat_desktop_core"];

fn ours(target: &str) -> bool {
    SOURCES.iter().any(|source| target.starts_with(source))
}

// Whether `name` is the log file's or one of its rotated files' (`server.log.2`).
pub fn named_here(name: &str) -> bool {
    match name.strip_prefix(FILE) {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('.')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub n: u64,
    pub text: String,
}

// `next` is what to pass as `after` to read on.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub lines: Vec<Line>,
    pub next: u64,
}

// The last `cap` lines, numbered from 1 in the order they came.
pub struct Ring {
    cap: usize,
    last: u64,
    lines: VecDeque<Line>,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Ring {
            cap,
            last: 0,
            lines: VecDeque::new(),
        }
    }

    pub fn push(&mut self, text: String) {
        self.last += 1;
        if self.lines.len() == self.cap {
            self.lines.pop_front();
        }
        self.lines.push_back(Line { n: self.last, text });
    }

    pub fn after(&self, after: u64) -> Page {
        Page {
            lines: self
                .lines
                .iter()
                .filter(|line| line.n > after)
                .cloned()
                .collect(),
            next: self.last,
        }
    }
}

// A log file that moves aside when a line would take it past `limit` bytes: `server.log.1` is
// the newest of the `kept` older files.
pub struct Rotating {
    path: PathBuf,
    limit: u64,
    kept: usize,
    file: Option<File>,
    bytes: u64,
}

impl Rotating {
    pub fn open(dir: &Path, limit: u64, kept: usize) -> std::io::Result<Self> {
        fs::create_dir_all(dir)?;
        let mut log = Rotating {
            path: dir.join(FILE),
            limit,
            kept,
            file: None,
            bytes: 0,
        };
        log.reopen()?;
        Ok(log)
    }

    fn reopen(&mut self) -> std::io::Result<&mut File> {
        let file = File::options().create(true).append(true).open(&self.path)?;
        self.bytes = file.metadata()?.len();
        Ok(self.file.insert(file))
    }

    fn numbered(&self, n: usize) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".{n}"));
        name.into()
    }

    // The file is closed first: Windows moves no open file.
    fn rotate(&mut self) -> std::io::Result<()> {
        self.file = None;
        let _ = fs::remove_file(self.numbered(self.kept));
        for n in (1..self.kept).rev() {
            let _ = fs::rename(self.numbered(n), self.numbered(n + 1));
        }
        if self.kept == 0 {
            fs::remove_file(&self.path)?;
        } else {
            fs::rename(&self.path, self.numbered(1))?;
        }
        self.reopen().map(|_| ())
    }

    pub fn write(&mut self, line: &str) -> std::io::Result<()> {
        let added = line.len() as u64 + 1;
        if self.bytes > 0 && self.bytes + added > self.limit {
            self.rotate()?;
        }
        let file = match &mut self.file {
            Some(file) => file,
            None => self.reopen()?,
        };
        file.write_all(format!("{line}\n").as_bytes())?;
        self.bytes += added;
        Ok(())
    }
}

pub struct Logs {
    ring: Mutex<Ring>,
    file: Mutex<Option<Rotating>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Logs {
    pub fn new() -> Arc<Self> {
        Arc::new(Logs {
            ring: Mutex::new(Ring::new(LINES)),
            file: Mutex::new(None),
        })
    }

    pub fn record(&self, text: String) {
        if let Some(file) = lock(&self.file).as_mut()
            && let Err(e) = file.write(&text)
        {
            eprintln!("server log: {e}");
        }
        lock(&self.ring).push(text);
    }

    pub fn after(&self, after: u64) -> Page {
        lock(&self.ring).after(after)
    }

    // Lines also go to `server.log` in `dir` from now on.
    pub fn to_dir(&self, dir: &Path) -> std::io::Result<()> {
        let file = Rotating::open(dir, FILE_BYTES, KEPT)?;
        *lock(&self.file) = Some(file);
        Ok(())
    }

    // Lets go of the file, so its folder can be moved or deleted.
    pub fn close_file(&self) {
        *lock(&self.file) = None;
    }

    // What the server reports at `info` and above goes to this log.
    pub fn layer<S: Subscriber>(self: &Arc<Self>) -> impl Layer<S> + use<S> {
        ServerLog(self.clone())
    }

    // Makes this log the process's log; false when another one is in place. With `stderr`,
    // the server's lines and every warning also go there.
    pub fn install(self: &Arc<Self>, stderr: bool) -> bool {
        let loud = stderr.then(|| {
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(tracing_subscriber::filter::filter_fn(|meta| {
                    *meta.level() <= Level::WARN
                        || (*meta.level() <= Level::INFO && ours(meta.target()))
                }))
        });
        tracing_subscriber::registry()
            .with(self.layer())
            .with(loud)
            .try_init()
            .is_ok()
    }
}

struct ServerLog(Arc<Logs>);

#[derive(Default)]
struct Text {
    message: String,
    fields: String,
}

impl Visit for Text {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        use std::fmt::Write;
        let _ = match field.name() {
            "message" => write!(self.message, "{value:?}"),
            name => write!(self.fields, " {name}={value:?}"),
        };
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "message" => self.message.push_str(value),
            name => {
                self.fields.push_str(&format!(" {name}={value}"));
            }
        }
    }
}

// The year, month and day of a count of days since 1970-01-01.
pub fn date(days: u64) -> (u64, u64, u64) {
    let shifted = days + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    (year_of_era + era * 400 + u64::from(month <= 2), month, day)
}

// The hours, minutes and seconds of a time in seconds since 1970.
pub fn clock(unix: u64) -> (u64, u64, u64) {
    (unix % 86_400 / 3_600, unix % 3_600 / 60, unix % 60)
}

// `2026-11-09T10:15:02Z`, from seconds since 1970.
pub fn utc(unix: u64) -> String {
    let (year, month, day) = date(unix / 86_400);
    let (hours, minutes, seconds) = clock(unix);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl<S: Subscriber> Layer<S> for ServerLog {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() > Level::INFO || !ours(meta.target()) {
            return;
        }
        let mut text = Text::default();
        event.record(&mut text);
        let Text { message, fields } = text;
        self.0
            .record(format!("{} {} {message}{fields}", utc(now()), meta.level()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::dirs::tests::temp;

    fn texts(page: &Page) -> Vec<(u64, &str)> {
        page.lines.iter().map(|l| (l.n, l.text.as_str())).collect()
    }

    #[test]
    fn lines_are_numbered_in_order() {
        let mut ring = Ring::new(10);
        assert_eq!(
            ring.after(0),
            Page {
                lines: Vec::new(),
                next: 0
            }
        );
        for text in ["a", "b", "c"] {
            ring.push(text.into());
        }
        let all = ring.after(0);
        assert_eq!(texts(&all), [(1, "a"), (2, "b"), (3, "c")]);
        assert_eq!(all.next, 3);
        assert_eq!(texts(&ring.after(2)), [(3, "c")]);
        assert_eq!(
            ring.after(3),
            Page {
                lines: Vec::new(),
                next: 3
            }
        );
        ring.push("d".into());
        let more = ring.after(all.next);
        assert_eq!(texts(&more), [(4, "d")]);
        assert_eq!(more.next, 4);
    }

    #[test]
    fn only_the_last_lines_are_kept() {
        let mut ring = Ring::new(3);
        for n in 1..=5 {
            ring.push(format!("line {n}"));
        }
        let page = ring.after(0);
        assert_eq!(texts(&page), [(3, "line 3"), (4, "line 4"), (5, "line 5")]);
        assert_eq!(page.next, 5);
        assert_eq!(texts(&ring.after(1)), texts(&page));
        assert_eq!(texts(&ring.after(4)), [(5, "line 5")]);
        // A reader ahead of the log, as after a restart of the app, starts over.
        assert_eq!(ring.after(99).next, 5);
        assert!(ring.after(99).lines.is_empty());
    }

    #[test]
    fn the_log_keeps_2000_lines() {
        let logs = Logs::new();
        for n in 1..=2005 {
            logs.record(format!("{n}"));
        }
        let page = logs.after(0);
        assert_eq!(page.lines.len(), 2000);
        assert_eq!(page.lines[0].n, 6);
        assert_eq!(page.next, 2005);
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("list")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_file_rotates_at_its_size_limit_and_three_older_files_stay() {
        let dir = temp("log rotate");
        let mut log = Rotating::open(&dir, 100, 3).expect("open");
        let line = |n: usize| format!("{n:039}");
        log.write(&line(1)).expect("write");
        log.write(&line(2)).expect("write");
        assert_eq!(files(&dir), ["server.log"]);
        assert_eq!(
            fs::read_to_string(dir.join("server.log")).expect("read"),
            format!("{}\n{}\n", line(1), line(2))
        );
        log.write(&line(3)).expect("write");
        assert_eq!(files(&dir), ["server.log", "server.log.1"]);
        assert_eq!(
            fs::read_to_string(dir.join("server.log.1")).expect("read"),
            format!("{}\n{}\n", line(1), line(2))
        );
        for n in 4..=20 {
            log.write(&line(n)).expect("write");
        }
        assert_eq!(
            files(&dir),
            ["server.log", "server.log.1", "server.log.2", "server.log.3"]
        );
        assert!(files(&dir).iter().all(|name| named_here(name)));
        for name in ["server.log.", "server.log.old", "server.logs", "diary.txt"] {
            assert!(!named_here(name), "{name}");
        }
        for (file, held) in [
            ("server.log", [19, 20]),
            ("server.log.1", [17, 18]),
            ("server.log.2", [15, 16]),
            ("server.log.3", [13, 14]),
        ] {
            assert_eq!(
                fs::read_to_string(dir.join(file)).expect("read"),
                format!("{}\n{}\n", line(held[0]), line(held[1])),
                "{file}"
            );
        }
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_file_from_an_earlier_run_is_continued() {
        let dir = temp("log reopen");
        {
            let mut log = Rotating::open(&dir, 100, 3).expect("open");
            log.write(&"a".repeat(60)).expect("write");
        }
        let mut log = Rotating::open(&dir, 100, 3).expect("open");
        log.write("short").expect("write");
        assert_eq!(files(&dir), ["server.log"]);
        log.write(&"b".repeat(60)).expect("write");
        assert_eq!(files(&dir), ["server.log", "server.log.1"]);
        // One line longer than the limit still gets written, alone in its file.
        log.write(&"c".repeat(300)).expect("write");
        log.write("d").expect("write");
        assert_eq!(
            fs::read_to_string(dir.join("server.log")).expect("read"),
            "d\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("server.log.1")).expect("read"),
            format!("{}\n", "c".repeat(300))
        );
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn recorded_lines_reach_the_file_once_a_folder_is_set() {
        let dir = temp("log dir").join("logs");
        let logs = Logs::new();
        logs.record("before".into());
        logs.to_dir(&dir).expect("dir");
        logs.record("after".into());
        logs.close_file();
        logs.record("closed".into());
        assert_eq!(
            fs::read_to_string(dir.join("server.log")).expect("read"),
            "after\n"
        );
        assert_eq!(logs.after(0).lines.len(), 3);
        fs::remove_dir_all(dir.parent().expect("temp")).expect("clean");
    }

    #[test]
    fn only_what_the_server_reports_at_info_and_above_is_logged() {
        let logs = Logs::new();
        let subscriber = tracing_subscriber::registry().with(logs.layer());
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "rust_next::run", "Listening on http://127.0.0.1:3470");
            tracing::warn!(target: "rust_next::db", port = 5, kind = "slow", "A warning");
            tracing::debug!(target: "rust_next::run", "noise");
            tracing::error!(target: "sqlx::query", "another crate");
        });
        let page = logs.after(0);
        let lines: Vec<&str> = page.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(lines.len(), 2, "{lines:?}");
        let (stamp, first) = lines[0].split_once(' ').expect("stamp");
        assert_eq!(stamp.len(), "2026-11-09T10:15:02Z".len());
        assert_eq!(first, "INFO Listening on http://127.0.0.1:3470");
        assert!(
            lines[1].ends_with(" WARN A warning port=5 kind=slow"),
            "{}",
            lines[1]
        );
    }

    #[test]
    fn stamps_are_utc() {
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc(1_794_219_302), "2026-11-09T10:15:02Z");
        assert_eq!(utc(951_782_399), "2000-02-28T23:59:59Z");
        assert_eq!(utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc(4_107_542_399), "2100-02-28T23:59:59Z");
        assert_eq!(utc(4_107_542_400), "2100-03-01T00:00:00Z");
    }
}
