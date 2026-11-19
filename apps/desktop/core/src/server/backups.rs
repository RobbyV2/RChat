// Copies of the SQLite database: one before each schema upgrade, and the ones the user asks for.

use crate::server::{dirs, env, logs};
use serde::Serialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

// Upgrade backups kept; older ones are deleted.
const KEPT_UPGRADES: usize = 3;
const MANUAL: &str = "rchat-";
const UPGRADE: &str = "rchat-schema";
const BEFORE_RESTORE: &str = "rchat-before-restore-";
const SUFFIX: &str = ".db";
const GONE: &str = "That backup is gone.";

pub const NEWER: &str =
    "This server's data was upgraded by a newer version of the app. Update the app to start it.";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Backup {
    pub name: String,
    pub bytes: u64,
    // Seconds since 1970.
    pub modified: u64,
}

// What a start finds in the data folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Found {
    Fresh,
    Current,
    // The database is older than this build: `backup` holds it as it was.
    Older { version: i64, backup: String },
}

// `20261109-101500`, in UTC.
pub fn stamp(unix: u64) -> String {
    let (year, month, day) = logs::date(unix / 86_400);
    let (hours, minutes, seconds) = logs::clock(unix);
    format!("{year:04}{month:02}{day:02}-{hours:02}{minutes:02}{seconds:02}")
}

fn is_number(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

// Whether `name` is one this module gives its copies: a prefix, the stamp, maybe a number.
pub fn named_here(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(SUFFIX) else {
        return false;
    };
    let after_schema = stem
        .strip_prefix(UPGRADE)
        .and_then(|rest| rest.split_once('-'))
        .filter(|(version, _)| is_number(version))
        .map(|(_, rest)| rest);
    let rest = after_schema
        .or_else(|| stem.strip_prefix(BEFORE_RESTORE))
        .or_else(|| stem.strip_prefix(MANUAL));
    let parts: Vec<&str> = rest.map_or_else(Vec::new, |rest| rest.split('-').collect());
    match parts.as_slice() {
        [date, time, more @ ..] => {
            date.len() == 8
                && time.len() == 6
                && [date, time].iter().all(|part| is_number(part))
                && more.len() <= 1
                && more.iter().all(|n| is_number(n))
        }
        _ => false,
    }
}

// A name in the backups folder that no file has yet.
fn free_name(dir: &Path, base: &str) -> String {
    let backups = dirs::backups_dir(dir);
    std::iter::once(format!("{base}{SUFFIX}"))
        .chain((2..).map(|n| format!("{base}-{n}{SUFFIX}")))
        .find(|name| !backups.join(name).exists())
        .unwrap_or_default()
}

// Copies the database into the backups folder; returns the copy's name.
async fn save(dir: &Path, base: &str) -> Result<String, String> {
    let backups = dirs::backups_dir(dir);
    fs::create_dir_all(&backups).map_err(|e| format!("Can't make the backups folder: {e}"))?;
    let name = free_name(dir, base);
    copy_db(&dirs::db_path(dir), &backups.join(&name)).await?;
    Ok(name)
}

// The time in an upgrade backup's name.
fn upgrade_stamp(name: &str) -> Option<&str> {
    let stem = name.strip_prefix(UPGRADE)?.strip_suffix(SUFFIX)?;
    stem.split_once('-').map(|(_, stamp)| stamp)
}

fn prune(dir: &Path) {
    let backups = dirs::backups_dir(dir);
    let mut upgrades: Vec<(String, String)> = list(dir)
        .into_iter()
        .filter_map(|b| upgrade_stamp(&b.name).map(|stamp| (stamp.to_string(), b.name.clone())))
        .collect();
    upgrades.sort();
    let extra = upgrades.len().saturating_sub(KEPT_UPGRADES);
    for (_, name) in upgrades.into_iter().take(extra) {
        let _ = fs::remove_file(backups.join(name));
    }
}

// Newest first.
pub fn list(dir: &Path) -> Vec<Backup> {
    let mut found: Vec<Backup> = fs::read_dir(dirs::backups_dir(dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let meta = entry.metadata().ok().filter(|meta| meta.is_file())?;
            let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
            let listed = name.ends_with(SUFFIX);
            listed.then_some(Backup {
                name,
                bytes: meta.len(),
                modified: modified.as_secs(),
            })
        })
        .collect();
    found.sort_by(|a, b| (b.modified, &b.name).cmp(&(a.modified, &a.name)));
    found
}

// A whole copy of a database that may be in use, as one new file.
pub async fn copy_db(from: &Path, to: &Path) -> Result<(), String> {
    let target = to.to_str().ok_or("The folder name can't be used.")?;
    let copied = async {
        let mut conn = SqliteConnectOptions::new().filename(from).connect().await?;
        let done = sqlx::query("VACUUM INTO ?1")
            .bind(target)
            .execute(&mut conn)
            .await;
        conn.close().await?;
        done.map(|_| ())
    };
    copied
        .await
        .map_err(|e: sqlx::Error| format!("Can't copy the database: {e}"))
}

// Before the server opens the database in `dir`: a database from an older build is copied
// first, and one from a newer build is refused untouched. `build` is this build's schema version.
pub async fn before_start(dir: &Path, build: i64, now: u64) -> Result<Found, String> {
    let url = env::sqlite_url(&dir.to_string_lossy());
    let stored = rust_next::db::stored_schema_version(Some(&url))
        .await
        .map_err(|e| format!("Can't read the database: {e:#}"))?;
    match stored {
        None => Ok(Found::Fresh),
        Some(version) if version > build => Err(NEWER.to_string()),
        Some(version) if version == build => Ok(Found::Current),
        Some(version) => {
            let backup = save(dir, &format!("{UPGRADE}{version}-{}", stamp(now))).await?;
            prune(dir);
            Ok(Found::Older { version, backup })
        }
    }
}

// Returns the new backup's name.
pub async fn backup_now(dir: &Path, now: u64) -> Result<String, String> {
    if !dirs::has_data(dir) {
        return Err("There is no data to back up yet.".into());
    }
    save(dir, &format!("{MANUAL}{}", stamp(now))).await
}

// Whether the backups list holds `name`.
pub fn listed(dir: &Path, name: &str) -> Result<(), String> {
    match list(dir).into_iter().any(|backup| backup.name == name) {
        true => Ok(()),
        false => Err(GONE.into()),
    }
}

// Puts the backup `name` in place of the database, which must be closed. The database as it was
// goes to the backups first; returns that copy's name, or None when there was no database.
pub async fn restore(dir: &Path, name: &str, now: u64) -> Result<Option<String>, String> {
    listed(dir, name)?;
    let source = dirs::backups_dir(dir).join(name);
    let db = dirs::db_path(dir);
    let replaced = match dirs::has_data(dir) {
        false => None,
        true => {
            let base = format!("{BEFORE_RESTORE}{}", stamp(now));
            Some(match save(dir, &base).await {
                Ok(kept) => kept,
                // A database too damaged to copy is kept as the file it is.
                Err(_) => {
                    let kept = free_name(dir, &base);
                    fs::rename(&db, dirs::backups_dir(dir).join(&kept))
                        .map_err(|e| format!("Can't set the current data aside: {e}"))?;
                    kept
                }
            })
        }
    };
    for file in dirs::db_files(dir) {
        match fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("Can't replace the database: {e}"));
            }
            _ => {}
        }
    }
    fs::copy(&source, &db).map_err(|e| format!("Can't restore the backup: {e}"))?;
    Ok(replaced)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::server::dirs::tests::temp;

    pub(crate) fn wait<T>(work: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(work)
    }

    pub(crate) async fn run(db: &Path, sql: &str) {
        let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(db)
            .create_if_missing(true)
            .connect()
            .await
            .expect("open");
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut conn)
            .await
            .expect("run");
        conn.close().await.expect("close");
    }

    pub(crate) async fn value(db: &Path, key: &str) -> Option<String> {
        use sqlx::Row;
        let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(db)
            .connect()
            .await
            .expect("open");
        let row = sqlx::query("SELECT value FROM settings WHERE key = ?1")
            .bind(key)
            .fetch_optional(&mut conn)
            .await
            .expect("read");
        conn.close().await.expect("close");
        row.map(|row| row.get(0))
    }

    // A database as a server at `version` leaves it.
    async fn database(dir: &Path, version: i64, marker: &str) {
        let db = dirs::db_path(dir);
        run(
            &db,
            "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )
        .await;
        run(
            &db,
            &format!(
                "INSERT OR REPLACE INTO settings(key, value) VALUES('schema_version', '{version}'), ('marker', '{marker}')"
            ),
        )
        .await;
    }

    fn names(dir: &Path) -> Vec<String> {
        list(dir).into_iter().map(|b| b.name).collect()
    }

    const NOW: u64 = 1_794_219_302;

    #[test]
    fn stamps_sort_by_time() {
        assert_eq!(stamp(NOW), "20261109-101502");
        assert_eq!(stamp(0), "19700101-000000");
        assert!(stamp(NOW) < stamp(NOW + 1));
        assert!(stamp(NOW) < stamp(NOW + 86_400 * 60));
    }

    #[test]
    fn a_folder_with_no_database_is_fresh() {
        let dir = temp("backup fresh");
        assert_eq!(wait(before_start(&dir, 33, NOW)), Ok(Found::Fresh));
        assert!(!dirs::has_data(&dir));
        assert!(!dirs::backups_dir(&dir).exists());
        assert_eq!(list(&dir), Vec::new());
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_database_at_this_build_is_left_alone() {
        let dir = temp("backup current");
        wait(database(&dir, 33, "kept"));
        assert_eq!(wait(before_start(&dir, 33, NOW)), Ok(Found::Current));
        assert_eq!(list(&dir), Vec::new());
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn an_older_database_is_copied_before_the_upgrade() {
        let dir = temp("backup older");
        wait(database(&dir, 31, "as it was"));
        let name = "rchat-schema31-20261109-101502.db";
        assert_eq!(
            wait(before_start(&dir, 33, NOW)),
            Ok(Found::Older {
                version: 31,
                backup: name.into()
            })
        );
        let copy = dirs::backups_dir(&dir).join(name);
        assert_eq!(wait(value(&copy, "marker")).as_deref(), Some("as it was"));
        assert_eq!(wait(value(&copy, "schema_version")).as_deref(), Some("31"));
        assert_eq!(
            wait(value(&dirs::db_path(&dir), "schema_version")).as_deref(),
            Some("31")
        );
        let listed = list(&dir);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, name);
        assert_eq!(listed[0].bytes, fs::metadata(&copy).expect("copy").len());
        assert!(listed[0].bytes > 0);
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn the_newest_three_upgrade_backups_stay() {
        let dir = temp("backup prune");
        wait(database(&dir, 31, "x"));
        let backups = dirs::backups_dir(&dir);
        fs::create_dir_all(&backups).expect("folder");
        let old = [
            "rchat-schema9-20260101-000004.db",
            "rchat-schema30-20250101-000003.db",
            "rchat-schema28-20240101-000002.db",
            "rchat-schema27-20230101-000001.db",
        ];
        let kept = [
            "rchat-20200101-000000.db",
            "rchat-before-restore-20200101-000000.db",
            "notes.txt",
        ];
        for name in old.iter().chain(&kept) {
            fs::write(backups.join(name), "old").expect("file");
        }
        wait(before_start(&dir, 33, NOW)).expect("upgrade");
        let mut left: Vec<String> = fs::read_dir(&backups)
            .expect("list")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "notes.txt",
                "rchat-20200101-000000.db",
                "rchat-before-restore-20200101-000000.db",
                "rchat-schema30-20250101-000003.db",
                "rchat-schema31-20261109-101502.db",
                "rchat-schema9-20260101-000004.db",
            ]
        );
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused_untouched() {
        let dir = temp("backup newer");
        wait(database(&dir, 34, "x"));
        let before = fs::read(dirs::db_path(&dir)).expect("read");
        assert_eq!(wait(before_start(&dir, 33, NOW)), Err(NEWER.to_string()));
        assert_eq!(fs::read(dirs::db_path(&dir)).expect("read"), before);
        assert_eq!(list(&dir), Vec::new());
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_file_that_is_no_database_is_reported() {
        let dir = temp("backup broken");
        fs::write(
            dirs::db_path(&dir),
            "not a database, but long enough to be read as one",
        )
        .expect("file");
        let refused = wait(before_start(&dir, 33, NOW)).expect_err("broken");
        assert!(
            refused.starts_with("Can't read the database: "),
            "{refused}"
        );
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_backup_on_request_is_never_pruned_and_never_overwritten() {
        let dir = temp("backup manual");
        assert_eq!(
            wait(backup_now(&dir, NOW)),
            Err("There is no data to back up yet.".to_string())
        );
        wait(database(&dir, 33, "one"));
        assert_eq!(
            wait(backup_now(&dir, NOW)),
            Ok("rchat-20261109-101502.db".to_string())
        );
        assert_eq!(
            wait(backup_now(&dir, NOW)),
            Ok("rchat-20261109-101502-2.db".to_string())
        );
        assert_eq!(
            wait(backup_now(&dir, NOW)),
            Ok("rchat-20261109-101502-3.db".to_string())
        );
        for n in 1..=5 {
            wait(backup_now(&dir, NOW + n)).expect("backup");
        }
        assert_eq!(list(&dir).len(), 8);
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn every_name_a_backup_gets_is_recognized() {
        let dir = temp("backup names");
        wait(database(&dir, 32, "x"));
        let mut made = vec![
            wait(backup_now(&dir, NOW)).expect("backup"),
            wait(backup_now(&dir, NOW)).expect("backup"),
        ];
        made.extend(wait(restore(&dir, &made[0], NOW)).expect("restore"));
        if let Found::Older { backup, .. } = wait(before_start(&dir, 33, NOW)).expect("upgrade") {
            made.push(backup);
        }
        assert_eq!(made.len(), 4, "{made:?}");
        for name in &made {
            assert!(named_here(name), "{name}");
        }
        for name in [
            "rchat-schema5-20200101-000001.db",
            "rchat-20261109-101502-12.db",
            "rchat-before-restore-20261109-101502.db",
        ] {
            assert!(named_here(name), "{name}");
        }
        for name in [
            "rchat.db",
            "mine.db",
            "rchat-mine.db",
            "rchat-20261109.db",
            "rchat-20261109-101502.txt",
            "rchat-20261109-101502-2-3.db",
            "rchat-20261109-1015.db",
            "rchat-schema-20261109-101502.db",
            "rchat-schemaX-20261109-101502.db",
            "rchat-before-20261109-101502.db",
            "tax-2025.pdf",
        ] {
            assert!(!named_here(name), "{name}");
        }
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn backups_are_listed_newest_first() {
        let dir = temp("backup list");
        let backups = dirs::backups_dir(&dir);
        fs::create_dir_all(backups.join("a folder.db")).expect("folder");
        for (name, age) in [("b.db", 20), ("a.db", 10), ("c.db", 30), ("skipped.txt", 0)] {
            let path = backups.join(name);
            fs::write(&path, "x").expect("file");
            let time = std::time::SystemTime::now() - std::time::Duration::from_secs(age);
            fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|f| f.set_modified(time))
                .expect("time");
        }
        assert_eq!(names(&dir), ["a.db", "b.db", "c.db"]);
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn restoring_puts_the_backup_back_and_keeps_what_it_replaced() {
        let dir = temp("backup restore");
        wait(database(&dir, 33, "before"));
        let name = wait(backup_now(&dir, NOW)).expect("backup");
        wait(database(&dir, 33, "after"));
        let db = dirs::db_path(&dir);
        assert_eq!(wait(value(&db, "marker")).as_deref(), Some("after"));
        let replaced = wait(restore(&dir, &name, NOW + 5)).expect("restore");
        assert_eq!(
            replaced.as_deref(),
            Some("rchat-before-restore-20261109-101507.db")
        );
        assert_eq!(wait(value(&db, "marker")).as_deref(), Some("before"));
        let kept = dirs::backups_dir(&dir).join(replaced.expect("name"));
        assert_eq!(wait(value(&kept, "marker")).as_deref(), Some("after"));
        // The backup stays, to restore again.
        assert!(names(&dir).contains(&name));
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn restoring_into_an_empty_folder_replaces_nothing() {
        let dir = temp("backup restore empty");
        wait(database(&dir, 33, "saved"));
        let name = wait(backup_now(&dir, NOW)).expect("backup");
        for file in dirs::db_files(&dir) {
            let _ = fs::remove_file(file);
        }
        assert_eq!(wait(restore(&dir, &name, NOW)), Ok(None));
        assert_eq!(
            wait(value(&dirs::db_path(&dir), "marker")).as_deref(),
            Some("saved")
        );
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn only_a_listed_backup_can_be_restored() {
        let dir = temp("backup restore name");
        wait(database(&dir, 33, "kept"));
        wait(backup_now(&dir, NOW)).expect("backup");
        fs::write(dir.join("outside.db"), "x").expect("file");
        for name in [
            "",
            "gone.db",
            "../outside.db",
            "../rchat.db",
            "..",
            "/etc/passwd",
        ] {
            assert_eq!(
                wait(restore(&dir, name, NOW)),
                Err("That backup is gone.".to_string()),
                "{name}"
            );
        }
        assert_eq!(
            wait(value(&dirs::db_path(&dir), "marker")).as_deref(),
            Some("kept")
        );
        fs::remove_dir_all(dir).expect("clean");
    }
}
