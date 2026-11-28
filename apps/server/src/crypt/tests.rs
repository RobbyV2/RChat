use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::ring::{KeyConfig, NoRing, Readiness, Ring, Source, create_key_file, instance_key_file};
use super::*;

const VECTORS: &str = include_str!("../../../../assets/seal_vectors.json");
const VECTORS_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../assets/seal_vectors.json"
);

fn key(fill: u8) -> Key {
    Zeroizing::new([fill; KEY_LEN])
}

fn encoded(id: &str, fill: u8) -> String {
    Kek::new(id, key(fill)).encoded().to_string()
}

#[test]
fn a_record_round_trips_with_a_fixed_overhead() {
    let aad = row_aad("messages", "body", "7\0c3\0alice", 9);
    for plain in [&b""[..], b"x", &[7u8; 5000]] {
        let record = seal(9, &key(1), &aad, plain);
        assert_eq!(record.len(), plain.len() + 46);
        assert_eq!(&record[..2], &[0x52, 0x01]);
        assert_eq!(
            header(&record),
            Ok(Header {
                version: SERVER_RECORD,
                key_id: 9
            })
        );
        assert_eq!(open(&key(1), &aad, &record).as_deref(), Ok(plain));
    }
    let (a, b) = (
        seal(9, &key(1), &aad, b"same"),
        seal(9, &key(1), &aad, b"same"),
    );
    assert_ne!(a, b, "every record has its own nonce");
}

#[test]
fn a_record_opens_only_under_its_own_binding_and_key() {
    let aad = row_aad("messages", "body", "7\0c3\0alice", 9);
    let record = seal(9, &key(1), &aad, b"hello");
    for other in [
        row_aad("messages", "body", "8\0c3\0alice", 9),
        row_aad("messages", "body", "7\0c4\0alice", 9),
        row_aad("messages", "body", "7\0c3\0bob", 9),
        row_aad("polls", "body", "7\0c3\0alice", 9),
        row_aad("messages", "content", "7\0c3\0alice", 9),
        row_aad("messages", "body", "7\0c3\0alice", 10),
    ] {
        assert_eq!(open(&key(1), &other, &record), Err(CryptError::Open));
    }
    assert_eq!(open(&key(2), &aad, &record), Err(CryptError::Open));
    for cut in [0, 1, 5, 45] {
        assert_eq!(open(&key(1), &aad, &record[..cut]), Err(CryptError::Format));
    }
    assert_eq!(
        open(&key(1), &aad, &record[..record.len() - 1]),
        Err(CryptError::Open)
    );
    let mut flipped = record.clone();
    *flipped.last_mut().unwrap() ^= 1;
    assert_eq!(open(&key(1), &aad, &flipped), Err(CryptError::Open));
    let mut versioned = record.clone();
    versioned[1] = 0x03;
    assert_eq!(open(&key(1), &aad, &versioned), Err(CryptError::Format));
    versioned[1] = DEVICE_RECORD;
    assert_eq!(open(&key(1), &aad, &versioned), Err(CryptError::Format));
    let mut plain = b"hello".to_vec();
    plain.resize(60, b' ');
    assert_eq!(open(&key(1), &aad, &plain), Err(CryptError::Format));
}

#[test]
fn a_wrapped_data_key_stays_with_its_purpose_generation_and_root_key() {
    let (k1, dek) = (Kek::new("k1", key(1)), key(9));
    let wrapped = k1.wrap(Purpose::Content, 1, &dek);
    assert_eq!(
        k1.unwrap(Purpose::Content, 1, &wrapped).map(|k| *k),
        Ok(*dek)
    );
    assert!(k1.unwrap(Purpose::Media, 1, &wrapped).is_err());
    assert!(k1.unwrap(Purpose::Content, 2, &wrapped).is_err());
    assert!(
        Kek::new("k2", key(1))
            .unwrap(Purpose::Content, 1, &wrapped)
            .is_err()
    );
    assert!(
        Kek::new("k1", key(2))
            .unwrap(Purpose::Content, 1, &wrapped)
            .is_err()
    );
    assert_eq!(
        k1.unwrap(Purpose::Content, 1, "not base64!").err(),
        Some(CryptError::Format)
    );
    assert_eq!(
        k1.unwrap(Purpose::Content, 1, "AAAA").err(),
        Some(CryptError::Format)
    );
}

#[test]
fn keys_parse_strictly() {
    let two = format!("{}, {}", encoded("k1", 1), encoded("k2", 2));
    let keys = parse_keys(&two).expect("two keys");
    assert_eq!(
        keys.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(),
        ["k1", "k2"]
    );
    assert_eq!(keys[0].encoded().as_str(), encoded("k1", 1));
    assert_eq!(keys[0].fingerprint().len(), 8);
    assert_ne!(keys[0].fingerprint(), keys[1].fingerprint());
    assert_eq!(
        format!("{:?}", keys[0]),
        "Kek { id: \"k1\", .. }",
        "a key never prints itself"
    );
    for bad in [
        "".to_owned(),
        " , ".to_owned(),
        "k1".to_owned(),
        "k1:!!!!".to_owned(),
        "k1:AAAA".to_owned(),
        format!(":{}", &encoded("k1", 1)[3..]),
        format!("k 1:{}", &encoded("k1", 1)[3..]),
        format!("{},{}", encoded("k1", 1), encoded("k1", 2)),
        format!("{}A", encoded("k1", 1)),
        format!("db:{}", &encoded("k1", 1)[3..]),
    ] {
        assert!(parse_keys(&bad).is_err(), "{bad}");
    }
    let reserved = parse_keys(&format!("k1:{0},db:{0}", &encoded("k1", 1)[3..])).unwrap_err();
    assert!(reserved.contains("db"), "{reserved}");
}

#[test]
fn subkeys_differ_by_scope_and_leave_the_cache_oldest_first() {
    let dek = key(3);
    let (a, b) = (subkey(&dek, "c:1"), subkey(&dek, "c:2"));
    assert_ne!(*a, *b);
    assert_ne!(*a, *dek);
    assert_eq!(*subkey(&dek, "c:1"), *a);
    assert_ne!(*subkey(&key(4), "c:1"), *a);
    let cache = Subkeys::with_capacity(2);
    assert_eq!(*cache.get(1, &dek, "c:1"), *a);
    assert_eq!(*cache.get(1, &dek, "c:2"), *b);
    assert_eq!(*cache.get(1, &dek, "c:1"), *a);
    cache.get(1, &dek, "i");
    assert_eq!(cache.len(), 2);
    let held: Vec<(u32, String)> = cache
        .cached
        .lock()
        .unwrap()
        .order
        .values()
        .cloned()
        .collect();
    assert_eq!(held, [(1, "c:1".to_owned()), (1, "i".to_owned())]);
    for _ in 0..3 {
        cache.get(1, &dek, "c:1");
    }
    let cached = cache.cached.lock().unwrap();
    assert_eq!(
        cached.order.len(),
        cached.keys.len(),
        "one place in line per subkey"
    );
    assert!(cached.keys.capacity() >= 2);
    drop(cached);
    cache.get(2, &key(5), "i");
    cache.forget(Some(1));
    assert_eq!(cache.len(), 1);
    cache.forget(None);
    assert!(cache.is_empty());
    assert_eq!(Subkeys::default().capacity, 4096);
}

fn device_seal(key_id: u32, key: &Key, nonce: [u8; 12], aad: &[u8], plain: &[u8]) -> Vec<u8> {
    let cipher = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key[..]).unwrap());
    let mut sealed = plain.to_vec();
    cipher
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad),
            &mut sealed,
        )
        .unwrap();
    let mut out = vec![MAGIC, DEVICE_RECORD];
    out.extend_from_slice(&key_id.to_be_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    out
}

fn device_open(key: &Key, aad: &[u8], record: &[u8]) -> Option<Vec<u8>> {
    let head = header(record).ok()?;
    if head.version != DEVICE_RECORD {
        return None;
    }
    let (nonce, sealed) = record[HEADER_LEN..].split_at(DEVICE_NONCE_LEN);
    let cipher = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key[..]).unwrap());
    let mut sealed = sealed.to_vec();
    let plain = cipher
        .open_in_place(
            Nonce::try_assume_unique_for_key(nonce).ok()?,
            Aad::from(aad),
            &mut sealed,
        )
        .ok()?;
    Some(plain.to_vec())
}

fn vectors() -> Value {
    let seq = |from: u8, len: usize| -> Vec<u8> { (0..len).map(|i| from + i as u8).collect() };
    let mut server_key = key(0);
    server_key.copy_from_slice(&seq(0x10, 32));
    let mut device_key = key(0);
    device_key.copy_from_slice(&seq(0x40, 32));
    let server_nonce: [u8; NONCE_LEN] = seq(0x80, NONCE_LEN).try_into().unwrap();
    let device_nonce: [u8; DEVICE_NONCE_LEN] = seq(0xa0, DEVICE_NONCE_LEN).try_into().unwrap();
    let row = row_aad("messages", "body", "41\0c7\0alice", 3);
    let dev = device_aad("events", "0000000041", "room-1");
    let server = |name: &str, plain: &[u8]| {
        json!({
            "name": name, "version": SERVER_RECORD, "key_id": 3, "key": hex::encode(&server_key[..]),
            "nonce": hex::encode(server_nonce), "aad": hex::encode(&row), "plain": hex::encode(plain),
            "record": hex::encode(seal_with(3, &server_key, &server_nonce, &row, plain)),
        })
    };
    let device = |name: &str, key_id: u32, plain: &[u8]| {
        json!({
            "name": name, "version": DEVICE_RECORD, "key_id": key_id, "key": hex::encode(&device_key[..]),
            "nonce": hex::encode(device_nonce), "aad": hex::encode(&dev), "plain": hex::encode(plain),
            "record": hex::encode(device_seal(key_id, &device_key, device_nonce, &dev, plain)),
        })
    };
    json!({
        "v": 1,
        "aad": [
            {"kind": "row", "parts": ["messages", "body", "41\0c7\0alice", "3"], "hex": hex::encode(&row)},
            {"kind": "row", "parts": ["settings", "value", "password_pepper.sealed", "4294967295"],
             "hex": hex::encode(row_aad("settings", "value", "password_pepper.sealed", u32::MAX))},
            {"kind": "dek", "parts": ["content", "1", "k1"], "hex": hex::encode(dek_aad(Purpose::Content, 1, "k1"))},
            {"kind": "dek", "parts": ["secrets", "12", "db"], "hex": hex::encode(dek_aad(Purpose::Secrets, 12, "db"))},
            {"kind": "dev", "parts": ["events", "0000000041", "room-1"], "hex": hex::encode(&dev)},
            {"kind": "dev", "parts": ["outbox", "k", ""], "hex": hex::encode(device_aad("outbox", "k", ""))},
        ],
        "records": [
            server("a server record", "hello \u{1F512}".as_bytes()),
            server("an empty server record", b""),
            device("a device record", 1, "hello \u{1F512}".as_bytes()),
            device("an empty device record", 0x0102_0304, b""),
        ],
        "malformed": ["", "52", "5201000000", "5301000000030000", "5203000000030000",
            hex::encode([&[MAGIC, SERVER_RECORD, 0, 0, 0, 3][..], &[0u8; 39]].concat()),
            hex::encode([&[MAGIC, DEVICE_RECORD, 0, 0, 0, 3][..], &[0u8; 27]].concat())],
    })
}

#[test]
fn seal_vectors_are_what_this_build_writes_and_reads() {
    let built = vectors();
    if crate::config::test_env("SEAL_VECTORS_WRITE").is_some() {
        let text = serde_json::to_string_pretty(&built).unwrap() + "\n";
        std::fs::write(VECTORS_PATH, text).unwrap();
        return;
    }
    let stored: Value = serde_json::from_str(VECTORS).expect("vectors");
    assert_eq!(stored, built);
    let bytes = |v: &Value| hex::decode(v.as_str().unwrap()).unwrap();
    for case in stored["aad"].as_array().unwrap() {
        let parts: Vec<&str> = case["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        let label = format!("rchat-{}1", case["kind"].as_str().unwrap());
        let mut want = label.into_bytes();
        for part in parts {
            want.push(0);
            want.extend_from_slice(part.as_bytes());
        }
        assert_eq!(bytes(&case["hex"]), want);
    }
    for case in stored["records"].as_array().unwrap() {
        let record = bytes(&case["record"]);
        let mut k = key(0);
        k.copy_from_slice(&bytes(&case["key"]));
        let head = header(&record).expect("header");
        assert_eq!(u64::from(head.key_id), case["key_id"].as_u64().unwrap());
        assert_eq!(u64::from(head.version), case["version"].as_u64().unwrap());
        let opened = match head.version {
            SERVER_RECORD => open(&k, &bytes(&case["aad"]), &record).ok(),
            _ => device_open(&k, &bytes(&case["aad"]), &record),
        };
        assert_eq!(opened, Some(bytes(&case["plain"])), "{}", case["name"]);
    }
    for bad in stored["malformed"].as_array().unwrap() {
        assert_eq!(header(&bytes(bad)), Err(CryptError::Format), "{bad}");
    }
}

fn env<'a>(pairs: &'a [(&'a str, String)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |name| {
        pairs
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.clone())
    }
}

fn temp_file(tag: &str) -> std::path::PathBuf {
    let path = crate::db::temp_db_path(tag);
    for suffix in ["", ".keys", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    path
}

#[test]
fn a_malformed_key_setting_is_an_error_naming_the_variable() {
    let load = |pairs: &[(&str, String)]| KeyConfig::load(&env(pairs));
    assert!(load(&[]).unwrap().keys.is_none());
    let bad = load(&[("ENCRYPTION_KEYS", "k1:short".to_owned())]).unwrap_err();
    assert!(
        bad.to_string().starts_with("ENCRYPTION_KEYS is malformed"),
        "{bad}"
    );
    let bad = load(&[("ACCOUNT_SECRETS_KEY", "nope".to_owned())]).unwrap_err();
    assert!(
        bad.to_string()
            .starts_with("ACCOUNT_SECRETS_KEY is malformed"),
        "{bad}"
    );
    let bad = load(&[("ENCRYPTION_ALLOW_LOST", "yes".to_owned())]).unwrap_err();
    assert!(bad.to_string().contains("ENCRYPTION_ALLOW_LOST"), "{bad}");
    let bad = load(&[("SEARCH_SEALED", "grams".to_owned())]).unwrap_err();
    assert_eq!(bad.to_string(), "SEARCH_SEALED is keyed or scan");
    for (value, scan) in [("keyed", false), ("scan", true), (" scan ", true)] {
        let config = load(&[("SEARCH_SEALED", value.to_owned())]).unwrap();
        assert_eq!(config.search_scan, scan, "{value}");
        assert_eq!(Ring::load(&config, None).unwrap().scans(), scan);
    }
    let file = temp_file("crypt_keys_file");
    std::fs::write(&file, "k1:short\n").unwrap();
    let named = [("ENCRYPTION_KEYS_FILE", file.display().to_string())];
    let bad = load(&named).unwrap_err();
    assert!(
        bad.to_string()
            .starts_with("ENCRYPTION_KEYS_FILE is malformed"),
        "{bad}"
    );
    std::fs::write(&file, "").unwrap();
    let bad = load(&named).unwrap_err();
    assert!(bad.to_string().contains("ENCRYPTION_KEYS_FILE"), "{bad}");
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    let bad = load(&named).unwrap_err();
    assert!(
        bad.to_string()
            .contains("ENCRYPTION_KEYS_FILE cannot be read"),
        "{bad}"
    );
    std::fs::remove_dir(&file).unwrap();
    let db_id = format!("db:{}", &encoded("k1", 1)[3..]);
    std::fs::write(&file, format!("{db_id}\n")).unwrap();
    for (pairs, name) in [
        (vec![("ENCRYPTION_KEYS", db_id.clone())], "ENCRYPTION_KEYS"),
        (named.to_vec(), "ENCRYPTION_KEYS_FILE"),
        (
            vec![("ACCOUNT_SECRETS_KEY", db_id.clone())],
            "ACCOUNT_SECRETS_KEY",
        ),
    ] {
        let bad = load(&pairs).unwrap_err().to_string();
        assert!(bad.starts_with(name) && bad.contains("db"), "{bad}");
    }
    std::fs::remove_file(&file).unwrap();
    let absent = load(&named).expect("a file that is not there yet is where the key file goes");
    assert!(absent.keys.is_none());
    assert_eq!(absent.keys_file.as_deref(), Some(file.as_path()));
    std::fs::write(&file, format!("{}\n", encoded("k1", 1))).unwrap();
    assert_eq!(
        load(&named).unwrap().keys.unwrap().as_str(),
        encoded("k1", 1)
    );
    let both = [
        ("ENCRYPTION_KEYS", encoded("k9", 9)),
        ("ENCRYPTION_KEYS_FILE", file.display().to_string()),
        ("ENCRYPTION_ALLOW_LOST", "on".to_owned()),
    ];
    let config = load(&both).unwrap();
    assert_eq!(config.keys.as_ref().unwrap().as_str(), encoded("k9", 9));
    assert!(config.allow_lost);
    assert!(!format!("{config:?}").contains(&encoded("k9", 9)[3..]));
    std::fs::remove_file(&file).unwrap();
}

#[test]
fn the_instance_key_file_sits_beside_a_sqlite_database() {
    let at = |url| instance_key_file(url, None).map(|p| p.display().to_string());
    assert_eq!(at(None).as_deref(), Some("rchat.db.keys"));
    assert_eq!(
        at(Some("/data/rchat.db")).as_deref(),
        Some("/data/rchat.db.keys")
    );
    assert_eq!(
        at(Some("sqlite:///data/rchat.db?mode=rwc")).as_deref(),
        Some("/data/rchat.db.keys")
    );
    assert_eq!(
        at(Some("sqlite://rchat.db")).as_deref(),
        Some("rchat.db.keys")
    );
    assert_eq!(
        at(Some("sqlite:///data/my%20chat.db")).as_deref(),
        Some("/data/my chat.db.keys")
    );
    assert_eq!(
        at(Some("sqlite:////data/rchat.db")).as_deref(),
        Some("//data/rchat.db.keys"),
        "the path sqlx opens"
    );
    assert_eq!(
        at(Some("sqlite:rchat.db")).as_deref(),
        Some("rchat.db.keys")
    );
    assert_eq!(at(Some("sqlite::memory:")), None);
    assert_eq!(at(Some("sqlite://x.db?mode=memory")), None);
    assert_eq!(at(Some("postgres://h/db")), None);
    assert_eq!(at(Some("postgresql://h/db")), None);
    let named = std::path::Path::new("/keys/site.keys");
    assert_eq!(
        instance_key_file(Some("postgres://h/db"), Some(named)).as_deref(),
        Some(named)
    );
}

async fn open_db(path: &std::path::Path) -> crate::db::Db {
    crate::db::open(path.to_str()).await.expect("open db")
}

async fn count(db: &crate::db::Db, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(db).await.expect("count")
}

#[cfg(unix)]
fn mode(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn the_first_need_makes_a_key_file_and_no_key_reaches_the_database() {
    let path = temp_file("crypt_first_need");
    let db = open_db(&path).await;
    let ring = Ring::load(&KeyConfig::default(), path.to_str()).unwrap();
    let keys = ring.key_file().unwrap().to_owned();
    assert_eq!(
        keys.display().to_string(),
        format!("{}.keys", path.display())
    );
    assert!(!ring.ready());
    assert!(
        ring.data_key(&db, Purpose::Content)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!keys.exists(), "nothing is made before a ring is needed");
    assert_eq!(ring.status(&db).await.unwrap().source, "none");
    assert_eq!(ring.readiness(true, &[]), Readiness::FirstNeed);
    let (one, two) = tokio::join!(ring.ensure_ring(&db, false), ring.ensure_ring(&db, false));
    assert_eq!((one.unwrap(), two.unwrap()), (Ok(()), Ok(())));
    assert!(ring.ready());
    assert_eq!(ring.readiness(true, &[]), Readiness::Ready);
    let dir = keys.parent().unwrap();
    let stem = keys.file_name().unwrap().to_str().unwrap().to_owned();
    let beside: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with(&stem))
        .collect();
    assert_eq!(beside, [stem], "no temporary file is left");
    #[cfg(unix)]
    assert_eq!(mode(&keys), 0o600);
    let text = std::fs::read_to_string(&keys).unwrap();
    let made = parse_keys(&text).expect("the key file parses as ENCRYPTION_KEYS does");
    assert_eq!(made.len(), 1);
    assert_eq!(ring.ensure_ring(&db, false).await.unwrap(), Ok(()));
    assert_eq!(std::fs::read_to_string(&keys).unwrap(), text, "made once");
    assert_eq!(
        create_key_file(&keys, &made).unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists
    );
    let (id, dek) = ring.data_key(&db, Purpose::Content).await.unwrap().unwrap();
    assert_eq!(
        ring.data_key(&db, Purpose::Content)
            .await
            .unwrap()
            .unwrap()
            .0,
        id
    );
    let secret = text.trim().split_once(':').unwrap().1.to_owned();
    let stored: Vec<String> = sqlx::query_scalar(
        "SELECT value FROM settings UNION ALL SELECT wrapped FROM data_keys UNION ALL SELECT kek FROM data_keys",
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert!(stored.iter().all(|v| !v.contains(&secret)));
    let status = ring.status(&db).await.unwrap();
    assert_eq!(status.source, Source::File.name());
    assert_eq!(
        status.fingerprints,
        [format!("k1:{}", made[0].fingerprint())]
    );
    assert_eq!(status.key_file.as_deref(), keys.to_str());
    assert!(status.needs_backup() && !status.database_key);
    assert!(status.data_keys.iter().all(|k| k.held && !k.mismatch));
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM settings WHERE key = 'keys_source' AND value = 'file'"
        )
        .await,
        1
    );

    let again = Ring::load(&KeyConfig::default(), path.to_str()).unwrap();
    assert!(again.ready(), "the next start loads the file");
    assert_eq!(again.check(&db).await.unwrap(), Vec::<i64>::new());
    let (same, key) = again
        .data_key(&db, Purpose::Content)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((same, *key), (id, *dek));
    assert_eq!(
        again
            .key_by_id(&db, id)
            .await
            .unwrap()
            .map(|(p, k)| (p, *k)),
        Some((Purpose::Content, *dek))
    );
    assert_eq!(again.generation(id), Some(1));
    assert!(again.key_by_id(&db, id + 100).await.unwrap().is_none());

    std::fs::remove_file(&keys).unwrap();
    let lost = Ring::load(&KeyConfig::default(), path.to_str()).unwrap();
    let refused = lost.check(&db).await.unwrap_err().to_string();
    assert!(
        refused.contains(&format!("the data key {id} ")) && refused.contains("k1"),
        "{refused}"
    );
    assert!(refused.contains(&keys.display().to_string()), "{refused}");
    let allowed = KeyConfig {
        allow_lost: true,
        ..KeyConfig::default()
    };
    let lost = Ring::load(&allowed, path.to_str()).unwrap();
    assert_eq!(lost.check(&db).await.unwrap(), [i64::from(id)]);
    assert!(lost.key_by_id(&db, id).await.unwrap().is_none());
    let status = lost.status(&db).await.unwrap();
    assert!(status.data_keys.iter().all(|k| !k.held && !k.mismatch));

    let other_k1 = KeyConfig {
        keys: Some(Zeroizing::new(encoded("k1", 42))),
        ..KeyConfig::default()
    };
    let refused = Ring::load(&other_k1, path.to_str())
        .unwrap()
        .check(&db)
        .await
        .unwrap_err()
        .to_string();
    let print = parse_keys(&encoded("k1", 42)).unwrap()[0].fingerprint();
    assert!(
        refused.contains("is a different key") && refused.contains(&print),
        "{refused}"
    );
    let wrong = Ring::load(
        &KeyConfig {
            allow_lost: true,
            ..other_k1
        },
        path.to_str(),
    )
    .unwrap();
    assert_eq!(wrong.check(&db).await.unwrap(), [i64::from(id)]);
    let status = wrong.status(&db).await.unwrap();
    assert!(
        status.data_keys.iter().all(|k| !k.held && k.mismatch),
        "a key under the same id that does not open it is not held"
    );
    let reused = wrong.data_key(&db, Purpose::Media).await.unwrap_err();
    assert!(
        reused
            .to_string()
            .contains("but the key k1 here is a different key"),
        "{reused}"
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM data_keys WHERE purpose = 'media'"
        )
        .await,
        0,
        "no new data key under an id that names another key"
    );
    assert!(super::cli::printed(&status).contains("the key k1 here is a different key"));
    crate::db::close(&db).await;
    let _ = temp_file("crypt_first_need");
}

#[tokio::test]
async fn a_root_key_named_db_never_reaches_the_ring() {
    let path = temp_file("crypt_db_id");
    let keys = std::path::PathBuf::from(format!("{}.keys", path.display()));
    std::fs::write(&keys, format!("db:{}\n", &encoded("k1", 3)[3..])).unwrap();
    let refused = Ring::load(&KeyConfig::default(), path.to_str()).unwrap_err();
    assert!(refused.to_string().contains("db"), "{refused}");
    assert!(super::RESERVED_IDS.contains(&super::ring::DATABASE_KEK));
    let _ = temp_file("crypt_db_id");
}

#[tokio::test]
async fn operator_keys_win_over_the_key_file_and_rotate_k2_first() {
    let path = temp_file("crypt_operator");
    let db = open_db(&path).await;
    let keys = std::path::PathBuf::from(format!("{}.keys", path.display()));
    create_key_file(&keys, &[Kek::new("f1", key(7))]).unwrap();
    let operator = |text: String| KeyConfig {
        keys: Some(Zeroizing::new(text)),
        ..KeyConfig::default()
    };
    let ring = Ring::load(&operator(encoded("k1", 1)), path.to_str()).unwrap();
    assert_eq!(ring.kek_ids(), ["k1"]);
    assert_eq!(ring.ensure_ring(&db, true).await.unwrap(), Ok(()));
    let status = ring.status(&db).await.unwrap();
    assert_eq!(
        (status.source.as_str(), status.key_file.as_deref()),
        ("operator", None)
    );
    assert!(!status.needs_backup());
    let (id, dek) = ring.data_key(&db, Purpose::Media).await.unwrap().unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM data_keys WHERE kek = 'k1' AND purpose = 'media' AND gen = 1 AND state = 'active'").await, 1);
    assert_eq!(ring.export().unwrap().as_str(), encoded("k1", 1));

    let rotated = Ring::load(
        &operator(format!("{},{}", encoded("k2", 2), encoded("k1", 1))),
        path.to_str(),
    )
    .unwrap();
    assert_eq!(rotated.kek_ids(), ["k2", "k1"]);
    assert_eq!(rotated.check(&db).await.unwrap(), Vec::<i64>::new());
    assert_eq!(
        rotated
            .data_key(&db, Purpose::Media)
            .await
            .unwrap()
            .map(|(i, k)| (i, *k)),
        Some((id, *dek))
    );
    let (_, search) = rotated
        .data_key(&db, Purpose::Search)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(*search, *dek);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM data_keys WHERE kek = 'k2' AND purpose = 'search'"
        )
        .await,
        1
    );
    let (scoped, a) = rotated
        .scope_key(&db, Purpose::Media, "i")
        .await
        .unwrap()
        .unwrap();
    assert_eq!((scoped, *a), (id, *subkey(&dek, "i")));

    let dropped = Ring::load(&operator(encoded("k2", 2)), path.to_str()).unwrap();
    let refused = dropped.check(&db).await.unwrap_err().to_string();
    assert!(
        refused.contains("needs the key k1") && refused.contains("ENCRYPTION_KEYS"),
        "{refused}"
    );
    crate::db::close(&db).await;
    let _ = temp_file("crypt_operator");
}

#[tokio::test]
async fn secrets_run_on_a_database_key_until_a_ring_exists() {
    let path = temp_file("crypt_db_kek");
    let db = open_db(&path).await;
    let ring = Ring::none();
    assert_eq!(
        ring.ensure_ring(&db, false).await.unwrap(),
        Err(NoRing::NoPlace)
    );
    for purpose in [
        Purpose::Content,
        Purpose::Media,
        Purpose::Search,
        Purpose::Bus,
    ] {
        assert!(
            ring.data_key(&db, purpose).await.unwrap().is_none(),
            "{purpose:?}"
        );
    }
    let (id, dek) = ring.data_key(&db, Purpose::Secrets).await.unwrap().unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM data_keys").await, 1);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM data_keys WHERE kek = 'db' AND purpose = 'secrets'"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM settings WHERE key = 'secrets_db_kek'"
        )
        .await,
        1
    );
    let status = ring.status(&db).await.unwrap();
    assert!(status.database_key && status.source == "none" && status.data_keys[0].held);
    let other = Ring::none();
    assert_eq!(other.check(&db).await.unwrap(), Vec::<i64>::new());
    assert_eq!(
        other
            .data_key(&db, Purpose::Secrets)
            .await
            .unwrap()
            .map(|(i, k)| (i, *k)),
        Some((id, *dek))
    );

    let alias = KeyConfig {
        account_secrets_key: Some(Zeroizing::new(encoded("k1", 5))),
        ..KeyConfig::default()
    };
    let aliased = Ring::load(&alias, Some("sqlite::memory:")).unwrap();
    assert!(!aliased.ready(), "the alias is no ring for content");
    assert!(
        aliased
            .data_key(&db, Purpose::Content)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("UPDATE data_keys SET state = 'retired'")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO data_keys(purpose, gen, kek, wrapped, created_at) VALUES('secrets', 2, 'acct:k1', $1, 1)")
        .bind(Kek::new("acct:k1", key(5)).wrap(Purpose::Secrets, 2, &key(8)))
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        aliased
            .data_key(&db, Purpose::Secrets)
            .await
            .unwrap()
            .map(|(_, k)| *k),
        Some(*key(8))
    );
    let refused = Ring::none().check(&db).await.unwrap_err().to_string();
    assert!(refused.contains("ACCOUNT_SECRETS_KEY"), "{refused}");

    sqlx::query("UPDATE settings SET value = '!sealed' WHERE key = 'secrets_db_kek'")
        .execute(&db)
        .await
        .unwrap();
    let refused = aliased.check(&db).await.unwrap_err().to_string();
    assert!(refused.contains("secrets_db_kek"), "{refused}");
    let status = aliased.status(&db).await.unwrap();
    assert_eq!(
        status
            .data_keys
            .iter()
            .map(|k| (k.kek.as_str(), k.held))
            .collect::<Vec<_>>(),
        [("db", false), ("acct:k1", true)],
        "a key the database no longer holds is not held"
    );
    crate::db::close(&db).await;
    let _ = temp_file("crypt_db_kek");
}

#[tokio::test]
async fn postgres_makes_a_key_file_only_where_one_is_named_and_no_other_copy_is_live() {
    let Some(pg) = crate::api::test_util::pg_temp("crypt_pg_ring").await else {
        return;
    };
    let db = crate::db::open(Some(&pg.url)).await.unwrap();
    let unnamed = Ring::load(&KeyConfig::default(), Some(&pg.url)).unwrap();
    assert_eq!(unnamed.readiness(false, &[]), Readiness::NoKeys);
    assert_eq!(
        unnamed.ensure_ring(&db, false).await.unwrap(),
        Err(NoRing::NoPlace)
    );
    assert!(
        unnamed
            .data_key(&db, Purpose::Content)
            .await
            .unwrap()
            .is_none()
    );
    let file = temp_file("crypt_pg_ring_keys");
    let named = KeyConfig {
        keys_file: Some(file.clone()),
        ..KeyConfig::default()
    };
    let ring = Ring::load(&named, Some(&pg.url)).unwrap();
    let live: Option<crate::hub::CopyNote> =
        serde_json::from_value(json!({"build": "0", "seal": true, "keks": []})).ok();
    assert_eq!(ring.readiness(false, &[live]), Readiness::NoKeys);
    assert_eq!(ring.readiness(false, &[]), Readiness::FirstNeed);
    assert_eq!(
        ring.ensure_ring(&db, true).await.unwrap(),
        Err(NoRing::OtherCopies)
    );
    assert!(!file.exists());
    assert_eq!(ring.ensure_ring(&db, false).await.unwrap(), Ok(()));
    #[cfg(unix)]
    assert_eq!(mode(&file), 0o600);
    let (id, dek) = ring.data_key(&db, Purpose::Content).await.unwrap().unwrap();
    let again = Ring::load(&named, Some(&pg.url)).unwrap();
    assert_eq!(again.status(&db).await.unwrap().source, "file");
    assert_eq!(
        again
            .data_key(&db, Purpose::Content)
            .await
            .unwrap()
            .map(|(i, k)| (i, *k)),
        Some((id, *dek))
    );
    let name = file.display().to_string();
    let started = KeyConfig::load(&env(&[("ENCRYPTION_KEYS_FILE", name.clone())])).unwrap();
    let started = Ring::load(&started, Some(&pg.url)).unwrap();
    let status = started.status(&db).await.unwrap();
    assert_eq!(
        (status.source.as_str(), status.key_file.as_deref()),
        ("file", Some(name.as_str())),
        "a file the instance made keeps its back-up warning"
    );
    assert!(status.needs_backup());
    assert!(
        super::cli::printed(&status).starts_with(&format!("Keys: the instance key file {name}"))
    );
    started.note_source(&db).await.unwrap();
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM settings WHERE key = 'keys_source' AND value = 'file'"
        )
        .await,
        1
    );

    std::fs::remove_file(&file).unwrap();
    std::fs::write(&file, format!("{}\n", encoded("k1", 9))).unwrap();
    let own = KeyConfig::load(&env(&[("ENCRYPTION_KEYS_FILE", name.clone())])).unwrap();
    let own = Ring::load(&own, Some(&pg.url)).unwrap();
    let status = own.status(&db).await.unwrap();
    assert_eq!(
        (status.source.as_str(), status.key_file.as_deref()),
        ("operator", Some(name.as_str())),
        "a file of the operator's own is no key file the instance made"
    );
    assert!(!status.needs_backup());
    assert!(
        super::cli::printed(&status).starts_with(&format!("Keys: ENCRYPTION_KEYS_FILE {name}"))
    );
    own.note_source(&db).await.unwrap();
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM settings WHERE key = 'keys_source' AND value = 'operator'"
        )
        .await,
        1
    );
    crate::db::close(&db).await;
    std::fs::remove_file(&file).unwrap();
}

#[test]
fn an_export_opens_only_with_its_passphrase() {
    use super::cli::{opened_export, sealed_export};
    let keys = format!("{},{}", encoded("k2", 2), encoded("k1", 1));
    assert!(sealed_export(&keys, "too short").is_err());
    let file = sealed_export(&keys, "correct horse battery").unwrap();
    assert!(!file.contains(&encoded("k2", 2)[3..]) && !file.contains(&encoded("k1", 1)[3..]));
    assert_ne!(file, sealed_export(&keys, "correct horse battery").unwrap());
    assert_eq!(
        opened_export(&file, "correct horse battery")
            .unwrap()
            .as_str(),
        keys
    );
    let wrong = opened_export(&file, "correct horse battery!").unwrap_err();
    assert!(wrong.to_string().contains("wrong passphrase"), "{wrong}");
    let changed = file.replace("\"kdf\": \"argon2id\"", "\"kdf\": \"none\"");
    assert!(opened_export(&changed, "correct horse battery").is_err());
    let written: Value = serde_json::from_str(&file).unwrap();
    let super::cli::Kdf {
        version,
        m_cost,
        t_cost,
        p_cost,
    } = super::cli::EXPORT_KDF;
    assert_eq!(
        (
            &written["kdf_version"],
            &written["m_cost"],
            &written["t_cost"],
            &written["p_cost"]
        ),
        (
            &json!(version),
            &json!(m_cost),
            &json!(t_cost),
            &json!(p_cost)
        ),
        "the file names the settings that open it"
    );
    let mut cheaper = written.clone();
    cheaper["t_cost"] = json!(1);
    let cheaper = serde_json::to_string(&cheaper).unwrap();
    assert!(opened_export(&cheaper, "correct horse battery").is_err());
    for (name, value) in [
        ("m_cost", json!(u64::from(u32::MAX) + 1)),
        ("m_cost", json!(1 << 30)),
        ("p_cost", json!(0)),
        ("kdf_version", json!(7)),
        ("t_cost", Value::Null),
    ] {
        let mut odd = written.clone();
        odd[name] = value;
        let odd = serde_json::to_string(&odd).unwrap();
        assert!(
            opened_export(&odd, "correct horse battery").is_err(),
            "{name}"
        );
    }
    assert!(opened_export("{}", "correct horse battery").is_err());
    assert!(opened_export("keys", "correct horse battery").is_err());
}

#[tokio::test]
async fn the_keys_command_prints_a_key_reports_status_and_exports_once() {
    use super::cli::{KeysCommand, opened_export, run};
    let path = temp_file("crypt_cli");
    let made = run(
        &crate::config::AppConfig::from_map(&[] as &[(&str, &str)]).unwrap(),
        KeysCommand::New {
            id: "k7".to_owned(),
        },
    )
    .await
    .unwrap();
    assert_eq!(parse_keys(&made).unwrap()[0].id, "k7");
    for id in ["k 7", "db"] {
        let bad = KeysCommand::New { id: id.to_owned() };
        let refused = run(
            &crate::config::AppConfig::from_map(&[] as &[(&str, &str)]).unwrap(),
            bad,
        )
        .await
        .unwrap_err();
        assert!(refused.to_string().starts_with("--id"), "{refused}");
    }
    let database = path.display().to_string();
    let bare = crate::config::AppConfig::from_map(&[("DATABASE_URL", database.as_str())]).unwrap();
    assert_eq!(run(&bare, KeysCommand::Status).await.unwrap(), "Keys: none");
    let out = temp_file("crypt_cli_export");
    let phrase = temp_file("crypt_cli_phrase");
    std::fs::write(&phrase, "correct horse battery\n").unwrap();
    let export = || KeysCommand::Export {
        out: out.clone(),
        passphrase_file: Some(phrase.clone()),
    };
    let out_file = out.clone();
    let none = run(&bare, export()).await.unwrap_err();
    assert!(none.to_string().contains("no encryption key"), "{none}");
    let config = crate::config::AppConfig::from_map(&[
        ("DATABASE_URL", database.as_str()),
        ("ENCRYPTION_KEYS", made.as_str()),
    ])
    .unwrap();
    let status = run(&config, KeysCommand::Status).await.unwrap();
    let print = parse_keys(&made).unwrap()[0].fingerprint();
    assert_eq!(status, format!("Keys: ENCRYPTION_KEYS\n  k7:{print}"));
    assert!(
        run(&config, export())
            .await
            .unwrap()
            .starts_with("Wrote the keys to ")
    );
    #[cfg(unix)]
    assert_eq!(mode(&out), 0o600);
    let file = std::fs::read_to_string(&out).unwrap();
    assert_eq!(
        opened_export(&file, "correct horse battery")
            .unwrap()
            .as_str(),
        made
    );
    let twice = run(&config, export()).await.unwrap_err();
    assert!(twice.to_string().contains("cannot be written"), "{twice}");

    let restored = temp_file("crypt_cli_restored");
    let import = |out: Option<std::path::PathBuf>| KeysCommand::Import {
        input: out_file.clone(),
        passphrase_file: Some(phrase.clone()),
        out,
    };
    assert_eq!(
        run(&bare, import(None)).await.unwrap(),
        made,
        "prints the keys"
    );
    assert!(
        run(&bare, import(Some(restored.clone())))
            .await
            .unwrap()
            .starts_with("Wrote the keys to ")
    );
    #[cfg(unix)]
    assert_eq!(mode(&restored), 0o600);
    let named = KeyConfig::load(&env(&[(
        "ENCRYPTION_KEYS_FILE",
        restored.display().to_string(),
    )]))
    .unwrap();
    assert_eq!(
        Ring::load(&named, Some(database.as_str()))
            .unwrap()
            .export()
            .unwrap()
            .as_str(),
        made,
        "the written file starts the site as ENCRYPTION_KEYS_FILE"
    );
    let again = run(&bare, import(Some(restored.clone())))
        .await
        .unwrap_err();
    assert!(again.to_string().contains("cannot be written"), "{again}");
    std::fs::write(&phrase, "not the passphrase\n").unwrap();
    let wrong = run(&bare, import(None)).await.unwrap_err();
    assert!(wrong.to_string().contains("wrong passphrase"), "{wrong}");
    for file in [&out, &phrase, &restored] {
        std::fs::remove_file(file).unwrap();
    }
    let _ = temp_file("crypt_cli");
}

#[test]
fn sealing_waits_for_every_live_copy() {
    use super::ring::readiness;
    let note = |seal: bool, keks: &[&str]| -> Option<crate::hub::CopyNote> {
        serde_json::from_value(json!({"build": "0", "seal": seal, "keks": keks})).ok()
    };
    let held = ["k2".to_owned(), "k1".to_owned()];
    assert_eq!(readiness(&[], false, &[]), Readiness::NoKeys);
    assert_eq!(
        readiness(&[], false, &[note(true, &["k1"])]),
        Readiness::NoKeys
    );
    assert_eq!(readiness(&[], true, &[]), Readiness::FirstNeed);
    assert_eq!(
        readiness(&[], true, &[note(true, &["k1"])]),
        Readiness::FirstNeed
    );
    assert_eq!(
        readiness(&[], true, &[note(false, &[])]),
        Readiness::Updating
    );
    assert_eq!(readiness(&[], true, &[None]), Readiness::Updating);
    assert_eq!(readiness(&held, false, &[]), Readiness::Ready);
    assert_eq!(
        readiness(&held, false, &[note(true, &["k1", "k2", "k3"])]),
        Readiness::Ready
    );
    for behind in [
        None,
        note(false, &["k1", "k2"]),
        note(true, &["k1"]),
        note(true, &[]),
    ] {
        let others = [note(true, &["k1", "k2"]), behind];
        assert_eq!(readiness(&held, true, &others), Readiness::Updating);
    }
    assert_eq!(
        [
            Readiness::Ready,
            Readiness::FirstNeed,
            Readiness::NoKeys,
            Readiness::Updating
        ]
        .map(Readiness::name),
        ["ready", "first_need", "keys", "updating"]
    );
}

mod body {
    use std::sync::Arc;

    use super::super::body::{OPTIONS, Opener, POLLS, Parts, SNAPSHOTS, Scope, Writer};
    use super::super::ring::Ring;
    use crate::db::{Db, close, open_keyed, temp_db_path};

    async fn keyed(tag: &str) -> (Db, std::path::PathBuf, Arc<Ring>) {
        let path = temp_db_path(tag);
        let _ = std::fs::remove_file(&path);
        let db = open_keyed(path.to_str()).await.expect("open");
        let ring = crate::db::ring(&db);
        (db, path, ring)
    }

    async fn writer(db: &Db, ring: &Ring, scope: Scope) -> Writer {
        ring.data_key(db, super::super::Purpose::Content)
            .await
            .expect("content key");
        let mut conn = db.acquire().await.expect("connection");
        Writer::of(ring, &mut conn, scope)
            .await
            .expect("key")
            .expect("writer")
    }

    #[tokio::test]
    async fn a_message_record_opens_only_as_its_own_row() {
        let (db, path, ring) = keyed("body_binding").await;
        let channel = Scope::Channel(7);
        let w = writer(&db, &ring, channel).await;
        let parts = Parts {
            content: "hello \u{1F600} there".into(),
            embeds: Some("[{\"title\":\"t\"}]".into()),
            filename: Some("notes.txt".into()),
            dropped: Some("left.bin".into()),
            alt: Some("A cat on a mat".into()),
        };
        let record = w.message(41, "alice", &parts);
        assert_eq!(&record[..2], [0x52, 0x01]);
        let text = String::from_utf8_lossy(&record);
        assert!(!text.contains("hello") && !text.contains("notes.txt") && !text.contains("cat"));
        let opener = Opener::of(&db, [record.as_slice()]).await.expect("opener");
        let own = opener.message(41, Some(channel), "alice", Some(&record), Parts::default());
        assert_eq!((own.parts, own.unreadable), (parts.clone(), false));
        let plain = opener.message(41, Some(channel), "alice", None, Parts::text("as stored"));
        assert_eq!(
            (plain.parts.content.as_str(), plain.unreadable),
            ("as stored", false),
            "a row without a record holds its plain columns"
        );
        for (id, scope, author, why) in [
            (
                42,
                Some(channel),
                "alice",
                "another message by the same author",
            ),
            (41, Some(Scope::Channel(8)), "alice", "another channel"),
            (
                41,
                Some(Scope::Dm(7)),
                "alice",
                "a DM with the channel's number",
            ),
            (41, Some(channel), "bob", "another author"),
            (41, None, "alice", "no place"),
        ] {
            let moved = opener.message(id, scope, author, Some(&record), Parts::text("plain"));
            assert_eq!(
                (moved.parts, moved.unreadable),
                (Parts::default(), true),
                "{why}"
            );
        }
        let again = w.message(41, "alice", &parts);
        assert_ne!(again, record, "a new nonce every time");
        for cut in [0, 5, 20, record.len() - 1] {
            assert!(
                opener
                    .message(
                        41,
                        Some(channel),
                        "alice",
                        Some(&record[..cut]),
                        Parts::default()
                    )
                    .unreadable
            );
        }
        assert_eq!(ring.unreadable(), 9);
        close(&db).await;
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn poll_text_is_bound_to_its_table_and_row() {
        let (db, path, ring) = keyed("body_poll").await;
        let scope = Scope::Dm(3);
        let w = writer(&db, &ring, scope).await;
        let record = w.text(POLLS, 5, "Which one");
        let opener = Opener::of(&db, [record.as_slice()]).await.expect("opener");
        assert_eq!(
            opener.text(POLLS, 5, Some(scope), Some(&record), String::new()),
            "Which one"
        );
        assert_eq!(
            opener.text(POLLS, 5, Some(scope), None, "plain".into()),
            "plain"
        );
        for (table, id) in [(OPTIONS, 5), (SNAPSHOTS, 5), (POLLS, 6)] {
            assert_eq!(
                opener.text(table, id, Some(scope), Some(&record), "plain".into()),
                "",
                "{table} {id}"
            );
        }
        let as_message = opener.message(5, Some(scope), "alice", Some(&record), Parts::default());
        assert!(as_message.unreadable);
        close(&db).await;
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn a_record_under_a_key_another_copy_made_opens_after_one_lookup() {
        let (db, path, ring) = keyed("body_other_copy").await;
        let scope = Scope::Channel(1);
        let record =
            writer(&db, &ring, scope)
                .await
                .message(1, "alice", &Parts::text("from another copy"));
        ring.forget_data_keys();
        assert!(ring.held(1).is_none() && ring.held(2).is_none());
        let opener = Opener::of(&db, [record.as_slice()]).await.expect("opener");
        let opened = opener.message(1, Some(scope), "alice", Some(&record), Parts::default());
        assert_eq!(opened.parts.content, "from another copy");
        close(&db).await;
        let _ = std::fs::remove_file(path);
    }
}

mod copies {
    use super::super::copies::{BACKUPS, BIOS, DELIVERIES, Opener, REPORTS, Sealer};
    use crate::db::{close, open_keyed, temp_db_path};

    #[tokio::test]
    async fn a_copy_opens_only_as_its_own_row_and_column() {
        let path = temp_db_path("copies_binding");
        let _ = std::fs::remove_file(&path);
        let db = open_keyed(path.to_str()).await.expect("open");
        let ring = crate::db::ring(&db);
        let mut conn = db.acquire().await.expect("connection");
        assert!(
            Sealer::of(&ring, &mut conn).await.expect("read").is_none(),
            "a sealer never makes the key"
        );
        drop(conn);
        ring.data_key(&db, super::super::Purpose::Content)
            .await
            .expect("content key");
        let mut conn = db.acquire().await.expect("connection");
        let sealer = Sealer::of(&ring, &mut conn)
            .await
            .expect("read")
            .expect("sealer");
        drop(conn);
        let record = sealer.seal(REPORTS, "7", b"what was reported");
        assert_eq!(&record[..2], [0x52, 0x01]);
        assert!(!String::from_utf8_lossy(&record).contains("reported"));
        let opener = Opener::of(&db, [record.as_slice()]).await.expect("opener");
        let before = ring.unreadable();
        assert_eq!(
            opener.text(REPORTS, "7", &record).as_deref(),
            Some("what was reported")
        );
        for (at, binding) in [
            (REPORTS, "8"),
            (DELIVERIES, "7"),
            (BIOS, "7"),
            (BACKUPS, "7"),
        ] {
            assert!(
                opener.open(at, binding, &record).is_none(),
                "{}.{} {binding}",
                at.table,
                at.column
            );
        }
        assert_eq!(ring.unreadable(), before + 4, "each miss is counted");
        let again = opener
            .reseal(REPORTS, "7", &record, b"what was kept")
            .expect("resealed");
        assert_ne!(again, record);
        assert_eq!(again[2..6], record[2..6], "under the same key");
        assert_eq!(
            opener.text(REPORTS, "7", &again).as_deref(),
            Some("what was kept")
        );
        let mut cut = record.clone();
        cut.truncate(record.len() - 1);
        assert!(opener.open(REPORTS, "7", &cut).is_none(), "a cut record");
        close(&db).await;
        let _ = std::fs::remove_file(path);
    }
}

mod media {
    use super::super::media::{
        CHUNK, Facts, MediaKey, OBJECT_HEADER, ObjectReader, chunk_len, chunks, object_len,
    };
    use super::super::{CryptError, Purpose};
    use crate::db::{close, open_keyed, temp_db_path};

    async fn key(tag: &str) -> (crate::db::Db, MediaKey, std::path::PathBuf) {
        let path = temp_db_path(tag);
        let _ = std::fs::remove_file(&path);
        let db = open_keyed(path.to_str()).await.expect("open");
        let ring = crate::db::ring(&db);
        let mut conn = db.acquire().await.expect("connection");
        assert!(
            MediaKey::stored_on(&ring, &mut conn)
                .await
                .expect("read")
                .is_none(),
            "reading the key never makes it"
        );
        drop(conn);
        ring.data_key(&db, Purpose::Media).await.expect("media key");
        let mut conn = db.acquire().await.expect("connection");
        let key = MediaKey::stored_on(&ring, &mut conn)
            .await
            .expect("read")
            .expect("key");
        drop(conn);
        (db, key, path)
    }

    fn bytes(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 7 % 251) as u8).collect()
    }

    #[test]
    fn sizes_count_their_chunks() {
        for (size, total) in [(0, 0), (1, 1), (CHUNK, 1), (CHUNK + 1, 2), (3 * CHUNK, 3)] {
            assert_eq!(chunks(size as u64), total, "{size}");
        }
        assert_eq!(chunk_len(CHUNK as u64 + 1, 0), CHUNK);
        assert_eq!(chunk_len(CHUNK as u64 + 1, 1), 1);
        assert_eq!(object_len(0), OBJECT_HEADER as u64);
    }

    #[tokio::test]
    async fn a_chunk_opens_only_in_its_own_place() {
        let (db, key, path) = key("media_chunks_binding").await;
        let record = key.seal_chunk("f1", 0, 2, b"first");
        assert_eq!(&record[..2], [0x52, 0x01]);
        assert_eq!(key.open_chunk("f1", 0, 2, &record).expect("open"), b"first");
        for (id, seq, total) in [("f2", 0, 2), ("f1", 1, 2), ("f1", 0, 1), ("f1", 0, 3)] {
            assert!(
                key.open_chunk(id, seq, total, &record).is_err(),
                "{id} {seq}/{total}"
            );
        }
        let facts = Facts {
            name: "notes.txt".to_string(),
        };
        let kept = key.seal_facts("f1", &facts);
        assert!(!String::from_utf8_lossy(&kept).contains("notes"));
        assert_eq!(key.open_facts("f1", &kept), Some(facts));
        assert_eq!(key.open_facts("f2", &kept), None);
        close(&db).await;
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn an_object_opens_as_it_arrives_in_any_pieces() {
        let (db, key, path) = key("media_objects").await;
        for size in [0, 1, CHUNK, CHUNK + 1] {
            let data = bytes(size);
            let object = key.seal_object("f1", &data);
            assert_eq!(object.len() as u64, object_len(size as u64), "{size}");
            assert_eq!(&object[..2], [0x52, 0x03]);
            for step in [1, 7, 4096, object.len().max(1)] {
                let mut reader = ObjectReader::new("f1", size as u64, key.clone());
                let mut got = Vec::new();
                for piece in object.chunks(step) {
                    for chunk in reader.feed(piece).expect("feed") {
                        got.extend_from_slice(&chunk);
                    }
                }
                assert!(reader.finished(), "{size} in pieces of {step}");
                assert_eq!(got, data, "{size} in pieces of {step}");
            }
            let mut cut = ObjectReader::new("f1", size as u64, key.clone());
            let _ = cut.feed(&object[..object.len() - 1]);
            assert!(!cut.finished(), "a cut object never finishes ({size})");
            let mut other = ObjectReader::new("f2", size as u64, key.clone());
            let opened = other.feed(&object);
            match size {
                0 => assert!(opened.is_ok() && other.finished()),
                _ => assert_eq!(opened.err(), Some(CryptError::Open), "{size}"),
            }
            let mut longer = ObjectReader::new("f1", size as u64 + 1, key.clone());
            assert!(
                longer.feed(&object).is_err() || !longer.finished(),
                "a size the object was not sealed for ({size})"
            );
        }
        close(&db).await;
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn facts_ignore_what_they_do_not_know() {
        let read: Facts =
            serde_json::from_str(r#"{"f":"a.png","t":"later","w":4}"#).expect("facts");
        assert_eq!(read.name, "a.png");
    }
}

mod reads {
    /// The string literals of `code`, each with the line it starts on.
    fn literals(code: &str) -> Vec<(usize, String)> {
        let bytes = code.as_bytes();
        let (mut out, mut i, mut line) = (Vec::new(), 0, 1);
        while i < bytes.len() {
            match bytes[i] {
                b'\n' => line += 1,
                b'/' if bytes.get(i + 1) == Some(&b'/') => {
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                    continue;
                }
                b'\'' if bytes.get(i + 2) == Some(&b'\'') => i += 2,
                b'\'' if bytes.get(i + 1) == Some(&b'\\') && bytes.get(i + 3) == Some(&b'\'') => {
                    i += 3
                }
                b'"' => {
                    let (start, at) = (i + 1, line);
                    i += 1;
                    while i < bytes.len() && bytes[i] != b'"' {
                        if bytes[i] == b'\\' {
                            i += 1;
                        }
                        if bytes.get(i) == Some(&b'\n') {
                            line += 1;
                        }
                        i += 1;
                    }
                    out.push((at, code[start..i.min(code.len())].to_owned()));
                }
                _ => {}
            }
            i += 1;
        }
        out
    }

    fn word(text: &str, name: &str) -> bool {
        text.match_indices(name).any(|(at, _)| {
            let before = text[..at].chars().next_back();
            let after = text[at + name.len()..].chars().next();
            let part = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
            !part(before) && !part(after)
        })
    }

    /// Each column that may be stored sealed: its table, the column and the column of its
    /// record.
    const COLUMNS: [(&str, &str, &str); 21] = [
        ("scheduled_messages", "content", "body"),
        ("scheduled_messages", "media_name", "body"),
        ("scheduled_messages", "media_alt", "body"),
        ("scheduled_messages", "poll", "body"),
        ("messages", "content", "body"),
        ("messages", "webhook_embeds", "body"),
        ("messages", "media_filename", "body"),
        ("messages", "fwd_dropped", "body"),
        ("messages", "media_alt", "body"),
        ("polls", "question", "body"),
        ("poll_options", "text", "body"),
        ("poll_snapshots", "data", "body"),
        ("reports", "snapshot", "sealed"),
        ("reports", "answers", "sealed"),
        ("reports", "note", "sealed"),
        ("report_events", "detail", "detail_sealed"),
        ("webhook_deliveries", "payload", "payload_sealed"),
        ("users", "bio", "bio_sealed"),
        ("member_profiles", "bio", "bio_sealed"),
        ("p2p_backups", "data", "data_sealed"),
        ("media", "filename", "name_sealed"),
    ];

    /// The sealed columns a query reads: `(table, column, record)` for each column of a table
    /// the query names.
    fn sealed_reads(sql: &str) -> Vec<(&'static str, &'static str, &'static str)> {
        COLUMNS
            .into_iter()
            .filter(|(table, column, _)| word(sql, table) && word(sql, column))
            .collect()
    }

    /// Queries that read a sealed column without its record, each for a stated reason.
    const PLAIN_READS: [(&str, &str, &str); 8] = [
        (
            "db/channel_index.rs",
            "",
            "the plain search index; a sealed row has blank content, and its keyed terms come from its record",
        ),
        (
            "db/schema.rs",
            "",
            "the full-text triggers index the plain column, blank in a sealed row",
        ),
        (
            "db/migrate.rs",
            "SELECT id, media_filename FROM messages WHERE id > $1 AND media_filename IS NOT NULL AND media_filename <> ''",
            "a file name backfill of plain rows; a sealed row keeps the column blank",
        ),
        ("api/seal/sweep.rs", "", "reads plain rows to seal them"),
        (
            "api/polls.rs",
            "UPDATE polls SET max_choices",
            "names no sealed column of its own",
        ),
        (
            "api/audit.rs",
            "",
            "audit details are JSON text in a column named data of another table",
        ),
        (
            "api/media/sealed.rs",
            "seal_key",
            "reads the names of files stored plain to seal them",
        ),
        (
            "api/reports/store.rs",
            "snapshot LIKE $1",
            "finds the plain reports that name an account; a sealed report has blank columns and is read whole after",
        ),
    ];

    /// Message and poll text, and the copies of content beside it, are read in SQL only together
    /// with their records, which `crypt::body` and `crypt::copies` open: a query that selects a
    /// sealed column alone would show a sealed row as empty.
    #[test]
    fn content_reads_go_through_open_body() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        crate::db::test_sources(&src, &mut files);
        assert!(files.len() > 50, "the scan reads the sources");
        let (mut misses, mut seen) = (Vec::new(), 0);
        for (path, code) in &files {
            for (line, sql) in literals(code) {
                let reads = sealed_reads(&sql);
                let select = sql.contains("SELECT ");
                let writes = ["INSERT INTO", "CREATE ", "DELETE FROM"]
                    .iter()
                    .any(|start| sql.trim_start().starts_with(start));
                if reads.is_empty() || !select || writes {
                    continue;
                }
                seen += 1;
                let allowed = PLAIN_READS
                    .iter()
                    .any(|(file, part, _)| file == path && sql.contains(part));
                let without: Vec<_> = reads
                    .iter()
                    .filter(|(_, _, record)| !word(&sql, record))
                    .collect();
                if !without.is_empty() && !allowed {
                    misses.push(format!(
                        "{path}:{line} reads {without:?} without its record"
                    ));
                }
            }
        }
        assert!(seen > 20, "the scan finds the queries: {seen}");
        assert!(misses.is_empty(), "{}", misses.join("\n"));
        let found = literals("let a = \"SELECT content FROM messages\"; // \"x\"\nlet b = 'c';");
        assert_eq!(found, [(1, "SELECT content FROM messages".to_owned())]);
        assert_eq!(
            sealed_reads("SELECT m.content FROM messages m"),
            [("messages", "content", "body")]
        );
        assert_eq!(
            sealed_reads("SELECT bio, bio_sealed FROM users"),
            [("users", "bio", "bio_sealed")]
        );
        assert!(sealed_reads("SELECT contents FROM messages_fts").is_empty());
    }
}

mod grams {
    use super::super::grams::{
        BUCKETS, Grams, array, bucket, fold, found, postings, term, windows,
    };
    use super::{key, subkey};

    #[test]
    fn text_folds_character_by_character() {
        assert_eq!(
            fold("Weekly NOTES from Zoë ΣΑΣ"),
            "weekly notes from zoë σασ"
        );
        for (a, b) in [("ΟΔΟΣ", "ΚΑΙ"), ("İx", "Ab"), ("", "ẞ")] {
            assert_eq!(fold(&format!("{a}{b}")), fold(a) + &fold(b));
        }
        assert!(found("say HELLO again", "hello a"));
        assert!(found("ΟΔΟΣΚ", "ΟΔΟΣ"), "a final sigma folds like any other");
        assert!(!found("hello", "hello!"));
        assert_eq!(windows("ab"), Vec::<String>::new());
        assert_eq!(windows("日本語🙂"), ["日本語", "本語🙂"]);
        assert_eq!(windows("aaaa"), ["aaa", "aaa"]);
    }

    #[test]
    fn grams_are_keyed_by_channel_and_stay_in_31_bits() {
        let dek = key(7);
        let one = Grams::new(subkey(&dek, "c:1"));
        let two = Grams::new(subkey(&dek, "c:2"));
        assert_eq!(one.gram("abc"), one.gram("abc"));
        assert_ne!(one.gram("abc"), two.gram("abc"));
        assert_ne!(one.gram("abc"), one.gram("abd"));
        let doc = one.document("Abc abc ABCD");
        assert!(doc.windows(2).all(|w| w[0] < w[1]), "distinct and sorted");
        assert!(doc.iter().all(|g| *g >= 0));
        assert_eq!(doc.len(), 5, "abc, bc_, c_a, _ab, bcd");
        assert!(one.needle("BCD").iter().all(|g| doc.contains(g)));
        assert!(one.needle("ab").is_empty());
        let long: String = "x".repeat(40) + "needle";
        assert_eq!(one.needle(&long), one.document(&"x".repeat(32)));
        // The gram of a run is part of what existing indexes hold.
        assert_eq!(Grams::new(key(1)).gram("abc"), 0x7386_0612);
    }

    #[test]
    fn terms_name_their_gram_and_fold_into_buckets_past_the_limit() {
        assert_eq!(term(0x2fd3_f6c6), "k2fd3f6c6");
        assert_eq!(term(5), "k00000005");
        assert_eq!(bucket(BUCKETS as i32 + 3), "k#003");
        let few: Vec<i32> = (0..BUCKETS as i32).collect();
        assert_eq!(postings(&few).len(), BUCKETS);
        assert!(postings(&few).iter().all(|t| t.len() == 9));
        let many: Vec<i32> = (0..BUCKETS as i32 * 3).collect();
        let folded = postings(&many);
        assert_eq!(folded.len(), BUCKETS);
        assert!(folded.iter().all(|t| t.starts_with("k#") && t.len() == 5));
        assert_eq!(array(&[1, 22, 333]), "{1,22,333}");
        assert_eq!(array(&[]), "{}");
    }
}
