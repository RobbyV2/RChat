use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use sqlx::Connection;
use zeroize::Zeroizing;

use super::{DATABASE, KEYS, SMALL, backup, identities, is_age, open, recipients};
use crate::api::controls::ControlSeeds;
use crate::config::AppConfig;
use crate::crypt::Purpose;
use crate::crypt::ring::{KeyConfig, Ring};
use crate::db::cli::{DbCommand, run};
use crate::db::{Db, DbOptions};

const K1: &str = "k1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU";

fn pair() -> (String, age::x25519::Recipient) {
    use age::secrecy::ExposeSecret;
    let identity = age::x25519::Identity::generate();
    (
        identity.to_string().expose_secret().to_owned(),
        identity.to_public(),
    )
}

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rchat-backup-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch");
    dir
}

fn wipe(path: &Path) {
    for suffix in ["", "-wal", "-shm", ".keys"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).expect("meta").permissions().mode() & 0o777
}

/// A SQLite database opened with a ring holding `keys`.
async fn database(tag: &str, keys: Option<&str>) -> (Db, PathBuf, Arc<Ring>) {
    let path = crate::db::temp_db_path(tag);
    wipe(&path);
    let config = KeyConfig {
        keys: keys.map(|k| Zeroizing::new(k.to_owned())),
        ..Default::default()
    };
    let ring = Arc::new(Ring::load(&config, None).expect("ring"));
    let opts = DbOptions {
        ring: Some(ring.clone()),
        controls: Some(ControlSeeds::default()),
        ..Default::default()
    };
    let db = crate::db::open_with(path.to_str(), &opts)
        .await
        .expect("open db");
    (db, path, ring)
}

fn config(path: &Path, keys: Option<&str>) -> AppConfig {
    let url = path.display().to_string();
    let mut pairs = vec![("DATABASE_URL", url.as_str())];
    if let Some(keys) = keys {
        pairs.push(("ENCRYPTION_KEYS", keys));
    }
    AppConfig::from_map(pairs.as_slice()).expect("config")
}

async fn users(path: &Path) -> i64 {
    let mut conn = sqlx::SqliteConnection::connect(&format!("sqlite://{}?mode=ro", path.display()))
        .await
        .expect("open copy");
    let n = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&mut conn)
        .await
        .expect("users");
    conn.close().await.expect("close");
    n
}

#[tokio::test]
async fn a_backup_opens_with_its_identity_and_restores_the_database() {
    let (db, path, _) = database("backup_round", None).await;
    for name in ["alice", "bob"] {
        crate::db::NewUser::plain(name).add(&db).await;
    }
    let dir = scratch("round");
    let out = dir.join("site.backup");
    let (secret, recipient) = pair();
    let made = backup(&path, &out, &[recipient], None)
        .await
        .expect("backup");
    #[cfg(unix)]
    assert_eq!(mode(&out), 0o600);
    assert_eq!(
        names(&dir),
        ["site.backup"],
        "nothing else is left beside it"
    );
    let stem = format!(".{}.backup-", path.file_name().unwrap().to_string_lossy());
    assert!(
        !names(path.parent().unwrap())
            .iter()
            .any(|n| n.starts_with(&stem)),
        "the copy's folder is gone"
    );
    assert_eq!(
        made.files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        [DATABASE]
    );
    assert!(made.schema_version > 0);
    assert!(!made.instance_id.is_empty());
    assert_eq!(made.sealed.state, "plain");
    is_age(&out).expect("an age file");
    let ids = identities(&secret).expect("identity");
    assert_eq!(open(&out, &ids, None, &[]).expect("verify"), made);
    let to = dir.join("restored");
    std::fs::create_dir(&to).expect("to");
    open(&out, &ids, Some(&to), &[]).expect("restore");
    assert_eq!(names(&to), [DATABASE], "keys are left out by default");
    #[cfg(unix)]
    assert_eq!(mode(&to.join(DATABASE)), 0o600);
    assert_eq!(users(&to.join(DATABASE)).await, 2);
    assert!(
        open(&out, &ids, Some(&to), &[]).is_err(),
        "a restore never writes over a file"
    );
    assert_eq!(users(&to.join(DATABASE)).await, 2);
    let beside = dir.join("beside");
    std::fs::create_dir(&beside).expect("beside");
    std::fs::write(beside.join("rchat.db-wal"), b"old").expect("wal");
    let refused = open(&out, &ids, Some(&beside), &[]).expect_err("a WAL file is there");
    assert!(refused.to_string().contains("rchat.db-wal"), "{refused}");
    assert_eq!(names(&beside), ["rchat.db-wal"]);
    crate::db::close(&db).await;
    let _ = std::fs::remove_dir_all(&dir);
    wipe(&path);
}

#[tokio::test]
async fn the_database_is_only_read_and_never_made() {
    let (db, path, _) = database("backup_read", None).await;
    sqlx::query("UPDATE settings SET value = '1' WHERE key = 'schema_version'")
        .execute(&db)
        .await
        .expect("an older schema");
    crate::db::close(&db).await;
    let dir = scratch("read");
    let (_, recipient) = pair();
    let made = backup(
        &path,
        &dir.join("old.backup"),
        std::slice::from_ref(&recipient),
        None,
    )
    .await
    .expect("backup");
    assert_eq!(made.schema_version, 1);
    assert_eq!(
        crate::db::stored_schema_version(path.to_str())
            .await
            .expect("version"),
        Some(1),
        "the database is not upgraded"
    );
    let missing = dir.join("missing.db");
    let refused = run(
        &config(&missing, None),
        DbCommand::Backup {
            path: dir.join("missing.backup"),
            recipients: vec![recipient.to_string()],
            with_keys: false,
        },
    )
    .await
    .expect_err("no database there");
    assert!(
        refused.to_string().contains("not a database file"),
        "{refused}"
    );
    assert!(!missing.exists(), "no database is made");
    for url in ["postgres://rchat@localhost/rchat", "sqlite::memory:"] {
        let config = AppConfig::from_map([("DATABASE_URL", url)].as_slice()).expect("config");
        let refused = run(
            &config,
            DbCommand::Backup {
                path: dir.join("pg.backup"),
                recipients: vec![recipient.to_string()],
                with_keys: false,
            },
        )
        .await
        .expect_err("not a SQLite file");
        assert!(refused.to_string().contains("pg_dump"), "{refused}");
    }
    assert_eq!(names(&dir), ["old.backup"]);
    let _ = std::fs::remove_dir_all(&dir);
    wipe(&path);
}

#[tokio::test]
async fn a_backup_says_which_keys_it_needs_and_carries_them_when_asked() {
    let (db, path, ring) = database("backup_keys", Some(K1)).await;
    ring.data_key(&db, Purpose::Content)
        .await
        .expect("content key")
        .expect("under k1");
    crate::db::close(&db).await;
    let dir = scratch("keys");
    let (secret, recipient) = pair();
    let ids = dir.join("identity.txt");
    std::fs::write(&ids, &secret).expect("identity");
    let mut keyed = config(&path, Some(K1));
    keyed.backup_recipients = vec![recipient.to_string()];
    let plain = config(&dir.join("elsewhere.db"), None);
    let bare = dir.join("bare.backup");
    let said = run(
        &keyed,
        DbCommand::Backup {
            path: bare.clone(),
            recipients: Vec::new(),
            with_keys: false,
        },
    )
    .await
    .expect("backup");
    assert!(said.contains("encrypted to 1 recipient."), "{said}");
    assert!(
        said.ends_with(" Keep these root keys to restore it: k1."),
        "{said}"
    );
    let restore = |path: &Path, to: &Path| DbCommand::Restore {
        path: path.to_path_buf(),
        identity: ids.clone(),
        to: to.to_path_buf(),
    };
    let to = dir.join("bare");
    let refused = run(&plain, restore(&bare, &to))
        .await
        .expect_err("k1 missing");
    assert!(refused.to_string().contains("the key k1"), "{refused}");
    assert!(names(&to).is_empty(), "nothing is written");
    run(&keyed, restore(&bare, &to))
        .await
        .expect("with k1 at hand");
    assert_eq!(names(&to), [DATABASE]);
    let beside = dir.join("beside");
    std::fs::create_dir(&beside).expect("beside");
    crate::crypt::ring::write_new_file(&beside.join(KEYS), K1.as_bytes()).expect("key file");
    run(&plain, restore(&bare, &beside))
        .await
        .expect("the key file there holds k1");
    let carried = dir.join("keys.backup");
    let said = run(
        &keyed,
        DbCommand::Backup {
            path: carried.clone(),
            recipients: vec![recipient.to_string()],
            with_keys: true,
        },
    )
    .await
    .expect("backup with keys");
    assert!(said.ends_with(" Root keys inside: k1."), "{said}");
    let said = run(
        &plain,
        DbCommand::Verify {
            path: carried.clone(),
            identity: Some(ids.clone()),
        },
    )
    .await
    .expect("verify");
    assert!(said.ends_with(", with the root keys."), "{said}");
    let to = dir.join("carried");
    run(&plain, restore(&carried, &to))
        .await
        .expect("the keys inside cover it");
    assert_eq!(names(&to), [DATABASE, KEYS]);
    #[cfg(unix)]
    assert_eq!(mode(&to.join(KEYS)), 0o600);
    let restored = to.join(DATABASE);
    let ring = Arc::new(Ring::load(&KeyConfig::default(), restored.to_str()).expect("ring"));
    assert!(ring.held_ids().contains(&"k1".to_owned()));
    let opts = DbOptions {
        ring: Some(ring.clone()),
        controls: Some(ControlSeeds::default()),
        ..Default::default()
    };
    let db = crate::db::open_with(restored.to_str(), &opts)
        .await
        .expect("the restored database starts with the restored keys");
    assert!(
        ring.data_key(&db, Purpose::Content)
            .await
            .expect("key")
            .is_some()
    );
    crate::db::close(&db).await;
    let _ = std::fs::remove_dir_all(&dir);
    wipe(&path);
}

/// A manifest listing `files` with their sizes and hashes.
fn manifest(format: u32, files: &[(&str, &[u8])]) -> Vec<u8> {
    let files: Vec<serde_json::Value> = files
        .iter()
        .map(|(path, data)| {
            serde_json::json!({
                "path": path,
                "size": data.len(),
                "sha256": hex::encode(Sha256::digest(data)),
            })
        })
        .collect();
    serde_json::to_vec(&serde_json::json!({
        "format": format,
        "created_at": 0,
        "schema_version": 1,
        "instance_id": "i",
        "files": files,
        "sealed": {"state": "plain", "key_ids": []},
    }))
    .expect("json")
}

/// An archive entry: its name, its bytes, and whether it is a file (else a link).
type Entry<'a> = (&'a [u8], &'a [u8], bool);

/// An age file for `recipient` holding a tar+zstd archive of `entries`, each named as given.
fn craft(out: &Path, recipient: &age::x25519::Recipient, entries: &[Entry]) {
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(recipient as &dyn age::Recipient))
            .expect("encryptor");
    let sealed = encryptor
        .wrap_output(std::fs::File::create(out).expect("create"))
        .expect("wrap");
    let mut archive = tar::Builder::new(zstd::Encoder::new(sealed, 3).expect("zstd"));
    for (name, data, file) in entries {
        let mut header = tar::Header::new_old();
        header.as_old_mut().name[..name.len()].copy_from_slice(name);
        header.set_mode(0o600);
        match file {
            true => header.set_size(data.len() as u64),
            false => {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
            }
        }
        header.set_cksum();
        let data: &[u8] = if *file { data } else { &[] };
        archive.append(&header, data).expect("append");
    }
    let packed = archive.into_inner().expect("tar");
    packed.finish().expect("zstd").finish().expect("age");
}

#[tokio::test]
async fn a_changed_or_crafted_backup_is_refused_and_leaves_nothing() {
    let dir = scratch("crafted");
    let (secret, recipient) = pair();
    let ids = identities(&secret).expect("identity");
    let db: &[u8] = b"a database";
    let escape = dir.join("escape");
    let absolute = escape.display().to_string();
    let good = manifest(1, &[(DATABASE, db)]);
    let big = {
        let mut text = good.clone();
        text.resize(SMALL as usize + 8, b' ');
        text
    };
    let cases: Vec<(&str, Vec<u8>, Vec<Entry>)> = vec![
        (
            "a name outside its folder",
            manifest(1, &[(DATABASE, db), ("../escape", db)]),
            vec![(DATABASE.as_bytes(), db, true), (b"../escape", db, true)],
        ),
        (
            "an absolute name",
            manifest(1, &[(DATABASE, db), (absolute.as_str(), db)]),
            vec![
                (DATABASE.as_bytes(), db, true),
                (absolute.as_bytes(), db, true),
            ],
        ),
        (
            "a file the manifest does not list",
            good.clone(),
            vec![(DATABASE.as_bytes(), db, true), (b"../escape", db, true)],
        ),
        (
            "another size",
            good.clone(),
            vec![(DATABASE.as_bytes(), b"a database!", true)],
        ),
        (
            "other bytes",
            good.clone(),
            vec![(DATABASE.as_bytes(), b"a dAtabase", true)],
        ),
        ("a missing file", good.clone(), vec![]),
        (
            "a file twice",
            good.clone(),
            vec![
                (DATABASE.as_bytes(), db, true),
                (DATABASE.as_bytes(), db, true),
            ],
        ),
        (
            "a manifest listing a file twice",
            manifest(1, &[(DATABASE, db), (DATABASE, db)]),
            vec![(DATABASE.as_bytes(), db, true)],
        ),
        (
            "another format",
            manifest(2, &[(DATABASE, db)]),
            vec![(DATABASE.as_bytes(), db, true)],
        ),
        (
            "a link",
            good.clone(),
            vec![(DATABASE.as_bytes(), db, false)],
        ),
        (
            "a manifest too large",
            big,
            vec![(DATABASE.as_bytes(), db, true)],
        ),
    ];
    for (i, (case, text, rest)) in cases.into_iter().enumerate() {
        let out = dir.join(format!("{i}.backup"));
        let mut entries: Vec<Entry> = vec![(b"manifest.json", &text, true)];
        entries.extend(rest);
        craft(&out, &recipient, &entries);
        let to = dir.join(format!("{i}"));
        std::fs::create_dir(&to).expect("to");
        assert!(open(&out, &ids, Some(&to), &[]).is_err(), "{case}");
        assert!(names(&to).is_empty(), "{case}: nothing is left");
        assert!(!escape.exists(), "{case}: nothing is written outside");
    }
    let late = dir.join("late.backup");
    craft(
        &late,
        &recipient,
        &[
            (DATABASE.as_bytes(), db, true),
            (b"manifest.json", &good, true),
        ],
    );
    assert!(
        open(&late, &ids, None, &[]).is_err(),
        "the manifest comes first"
    );
    let made = dir.join("made.backup");
    craft(
        &made,
        &recipient,
        &[
            (b"manifest.json", &good, true),
            (DATABASE.as_bytes(), db, true),
        ],
    );
    let to = dir.join("made");
    std::fs::create_dir(&to).expect("to");
    open(&made, &ids, Some(&to), &[]).expect("a well-formed archive restores");
    assert_eq!(std::fs::read(to.join(DATABASE)).expect("db"), db);
    let (other, _) = pair();
    assert!(open(&made, &identities(&other).expect("other"), None, &[]).is_err());
    let mut bytes = std::fs::read(&made).expect("read");
    let at = bytes.len() / 2;
    bytes[at] ^= 0x01;
    let changed = dir.join("changed.backup");
    std::fs::write(&changed, &bytes).expect("write");
    assert!(open(&changed, &ids, None, &[]).is_err());
    assert!(is_age(&dir.join("missing")).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_backup_never_writes_over_a_file_and_needs_a_recipient() {
    let (db, path, _) = database("backup_over", None).await;
    let dir = scratch("over");
    let out = dir.join("site.backup");
    backup(&path, &out, &[pair().1], None)
        .await
        .expect("backup");
    let before = std::fs::read(&out).expect("read");
    assert!(backup(&path, &out, &[pair().1], None).await.is_err());
    assert_eq!(std::fs::read(&out).expect("read"), before);
    let stopped = dir.join("stopped.backup");
    std::fs::write(dir.join("stopped.backup.partial"), b"").expect("partial");
    let refused = backup(&path, &stopped, &[pair().1], None)
        .await
        .expect_err("a .partial is there");
    assert!(
        refused.to_string().contains("stopped.backup.partial"),
        "{refused}"
    );
    assert!(backup(&path, &dir.join("none"), &[], None).await.is_err());
    assert!(recipients(&["age1nope".to_owned()]).is_err());
    assert_eq!(
        recipients(&[format!("{}, {}", pair().1, pair().1)])
            .expect("two")
            .len(),
        2
    );
    crate::db::close(&db).await;
    let _ = std::fs::remove_dir_all(&dir);
    wipe(&path);
}
