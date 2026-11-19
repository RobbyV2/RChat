use crate::server::env::DB_FILE;
use crate::server::{backups, logs};
use crate::settings::ServerSettings;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

const FOLDER: &str = "server";
const BACKUPS: &str = "backups";
const LOGS: &str = "logs";
const PROBE: &str = ".rchat-write-check";

// What happens to the data when the folder changes.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MoveMode {
    // Copy the database to the new folder. The files in the current one stay.
    Move,
    // Run on the database the new folder holds.
    Use,
    Empty,
}

// The data folder of a server whose settings name none, under the app's data folder.
pub fn default_dir(app_data: &Path) -> PathBuf {
    app_data.join(FOLDER)
}

pub fn resolve(settings: &ServerSettings, default: &Path) -> PathBuf {
    match settings.data_dir.trim() {
        "" => default.to_path_buf(),
        named => PathBuf::from(named),
    }
}

// A folder the user typed or picked. Empty means the built-in one.
pub fn validate(text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    let path = Path::new(text);
    if text.contains('\0') || !path.is_absolute() {
        return Err("The data folder must be a full path.".into());
    }
    if path.is_file() {
        return Err("The data folder is a file. Pick a folder.".into());
    }
    if path.ancestors().skip(1).any(Path::is_file) {
        return Err("The data folder is inside a file. Pick a folder.".into());
    }
    Ok(())
}

pub fn db_path(dir: &Path) -> PathBuf {
    dir.join(DB_FILE)
}

pub fn backups_dir(dir: &Path) -> PathBuf {
    dir.join(BACKUPS)
}

pub fn logs_dir(dir: &Path) -> PathBuf {
    dir.join(LOGS)
}

// The database file with its write-ahead log and shared memory file.
pub fn db_files(dir: &Path) -> [PathBuf; 3] {
    ["", "-wal", "-shm"].map(|suffix| dir.join(format!("{DB_FILE}{suffix}")))
}

pub fn has_data(dir: &Path) -> bool {
    db_path(dir).is_file()
}

pub fn db_bytes(dir: &Path) -> u64 {
    let [db, wal, _] = db_files(dir);
    [db, wal]
        .iter()
        .filter_map(|file| fs::metadata(file).ok())
        .map(|meta| meta.len())
        .sum()
}

// Makes the folder and checks a file can be written in it.
pub fn open(dir: &Path) -> Result<(), String> {
    let probe = dir.join(PROBE);
    fs::create_dir_all(dir)
        .and_then(|()| fs::write(&probe, []))
        .and_then(|()| fs::remove_file(&probe))
        .map_err(|e| format!("Can't open the data folder: {e}"))
}

fn gone(done: std::io::Result<()>) -> std::io::Result<()> {
    match done {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

// Deletes the files in `folder` whose names `ours` knows.
fn delete_named(folder: &Path, ours: fn(&str) -> bool) -> std::io::Result<()> {
    let entries = match fs::read_dir(folder) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        entries => entries?,
    };
    for entry in entries {
        let entry = entry?;
        let named = entry.file_name().to_str().is_some_and(ours);
        if named && entry.file_type()?.is_file() {
            gone(fs::remove_file(entry.path()))?;
        }
    }
    Ok(())
}

// Deletes what the server wrote: the database, its backups and its logs, by the names it gives
// them. Then each folder goes when nothing else is in it.
pub fn delete_data(dir: &Path) -> std::io::Result<()> {
    for file in db_files(dir).into_iter().chain([dir.join(PROBE)]) {
        gone(fs::remove_file(file))?;
    }
    delete_named(&backups_dir(dir), backups::named_here)?;
    delete_named(&logs_dir(dir), logs::named_here)?;
    // Each fails when something else is in the folder, and then the folder stays.
    for folder in [backups_dir(dir), logs_dir(dir), dir.to_path_buf()] {
        let _ = fs::remove_dir(folder);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rchat core {name} {}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn named(data_dir: &str) -> ServerSettings {
        ServerSettings {
            data_dir: data_dir.into(),
            ..ServerSettings::default()
        }
    }

    #[test]
    fn the_built_in_folder_is_under_the_app_data() {
        let app = Path::new("/home/a b/.local/share/app");
        assert_eq!(default_dir(app), app.join("server"));
        assert_eq!(resolve(&named(""), &default_dir(app)), app.join("server"));
        assert_eq!(resolve(&named("  "), &default_dir(app)), app.join("server"));
    }

    #[test]
    fn a_named_folder_wins() {
        let dir = temp("named");
        let text = dir.display().to_string();
        assert_eq!(resolve(&named(&text), Path::new("/unused")), dir);
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_folder_must_be_a_full_path_that_is_no_file() {
        let dir = temp("validate");
        let file = dir.join("a file");
        fs::write(&file, "x").expect("file");
        assert_eq!(validate(""), Ok(()));
        assert_eq!(validate(&dir.display().to_string()), Ok(()));
        assert_eq!(validate(&dir.join("not yet").display().to_string()), Ok(()));
        for relative in ["data", "./data", "../data"] {
            assert_eq!(
                validate(relative),
                Err("The data folder must be a full path.".to_string()),
                "{relative}"
            );
        }
        assert_eq!(
            validate(&file.display().to_string()),
            Err("The data folder is a file. Pick a folder.".to_string())
        );
        assert_eq!(
            validate(&file.join("under").display().to_string()),
            Err("The data folder is inside a file. Pick a folder.".to_string())
        );
        assert_eq!(
            validate(&format!("{}\0", dir.display())),
            Err("The data folder must be a full path.".to_string())
        );
        fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn opening_makes_the_folder() {
        let dir = temp("open").join("a b").join("server");
        assert_eq!(open(&dir), Ok(()));
        assert!(dir.is_dir());
        assert_eq!(fs::read_dir(&dir).expect("list").count(), 0);
        let file = dir.join("file");
        fs::write(&file, "x").expect("file");
        let refused = open(&file.join("under")).expect_err("a file is in the way");
        assert!(
            refused.starts_with("Can't open the data folder: "),
            "{refused}"
        );
        fs::remove_dir_all(dir.parent().and_then(Path::parent).expect("temp")).expect("clean");
    }

    #[test]
    fn the_database_size_counts_its_log() {
        let dir = temp("bytes");
        assert_eq!(db_bytes(&dir), 0);
        assert!(!has_data(&dir));
        fs::write(dir.join("rchat.db"), [0; 10]).expect("db");
        fs::write(dir.join("rchat.db-wal"), [0; 5]).expect("wal");
        fs::write(dir.join("other.db"), [0; 100]).expect("other");
        assert_eq!(db_bytes(&dir), 15);
        assert!(has_data(&dir));
        fs::remove_dir_all(dir).expect("clean");
    }

    // Every file under `dir`, as paths from it with forward slashes.
    fn files_under(dir: &Path) -> Vec<String> {
        let mut found = Vec::new();
        for entry in fs::read_dir(dir).expect("list").flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            match entry.file_type().expect("type").is_dir() {
                true => found.extend(
                    files_under(&entry.path())
                        .into_iter()
                        .map(|under| format!("{name}/{under}")),
                ),
                false => found.push(name),
            }
        }
        found.sort();
        found
    }

    #[test]
    fn deleting_the_data_leaves_what_the_server_did_not_write() {
        let dir = temp("delete");
        let (backups, logs) = (backups_dir(&dir), logs_dir(&dir));
        fs::create_dir_all(&backups).expect("folder");
        fs::create_dir_all(&logs).expect("folder");
        let ours = [
            dir.join("rchat.db"),
            dir.join("rchat.db-wal"),
            dir.join("rchat.db-shm"),
            backups.join("rchat-20261109-101502.db"),
            backups.join("rchat-20261109-101502-2.db"),
            backups.join("rchat-schema5-20200101-000001.db"),
            backups.join("rchat-before-restore-20261109-101507.db"),
            logs.join("server.log"),
            logs.join("server.log.3"),
        ];
        let theirs = [
            dir.join("notes.txt"),
            backups.join("tax-2025.pdf"),
            backups.join("mine.db"),
            logs.join("diary.txt"),
            logs.join("server.log.old"),
        ];
        for file in ours.iter().chain(&theirs) {
            fs::write(file, "x").expect("file");
        }
        delete_data(&dir).expect("delete");
        assert_eq!(
            files_under(&dir),
            [
                "backups/mine.db",
                "backups/tax-2025.pdf",
                "logs/diary.txt",
                "logs/server.log.old",
                "notes.txt",
            ]
        );

        for file in &theirs {
            fs::remove_file(file).expect("remove");
        }
        fs::write(dir.join("rchat.db"), "x").expect("db");
        delete_data(&dir).expect("delete");
        assert!(!dir.exists());
        delete_data(&dir).expect("nothing left to delete");
    }
}
