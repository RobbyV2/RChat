use std::path::Path;
use std::sync::Arc;

use zeroize::Zeroizing;

use super::*;
use crate::api::controls::ControlSeeds;
use crate::crypt::Kek;
use crate::crypt::ring::KeyConfig;
use crate::db::{DbOptions, close, open, open_with, pepper, temp_db_path};
use crate::instance::{Instance, InstanceConfig};

fn temp_file(tag: &str) -> std::path::PathBuf {
    let path = temp_db_path(tag);
    wipe(&path);
    path
}

fn wipe(path: &Path) {
    for suffix in ["", ".keys", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

fn ring(keys: Option<&str>, allow_lost: bool) -> Arc<Ring> {
    let config = KeyConfig {
        keys: keys.map(|k| Zeroizing::new(k.to_owned())),
        allow_lost,
        ..KeyConfig::default()
    };
    Arc::new(Ring::load(&config, Some("sqlite::memory:")).expect("ring"))
}

fn started(ring: Arc<Ring>) -> DbOptions {
    DbOptions {
        ring: Some(ring),
        controls: Some(ControlSeeds::default()),
        ..DbOptions::default()
    }
}

async fn start(path: &Path, ring: Arc<Ring>) -> anyhow::Result<Db> {
    open_with(path.to_str(), &started(ring)).await
}

async fn row(db: &Db, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await
        .expect("setting")
}

async fn count(db: &Db, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(db).await.expect("count")
}

async fn secrets(db: &Db) -> Vec<String> {
    let mut out = Vec::new();
    for key in SETTINGS {
        out.push(secret_setting(db, key).await.expect(key).to_string());
    }
    out
}

async fn sealed_rows(db: &Db) -> Vec<String> {
    let mut out = Vec::new();
    for key in SETTINGS {
        out.push(row(db, &sealed_name(key)).await.expect(key));
    }
    out
}

#[tokio::test]
async fn a_start_seals_the_stored_secrets_and_never_makes_them_again() {
    let path = temp_file("secrets_default");
    let db = start(&path, Arc::default()).await.expect("first start");
    let first = secrets(&db).await;
    let records = sealed_rows(&db).await;
    for (key, (value, record)) in SETTINGS.iter().zip(first.iter().zip(&records)) {
        assert_eq!(row(&db, key).await, None, "{key} has no plain row");
        assert!(
            !value.is_empty() && !record.contains(value.as_str()),
            "{key}"
        );
    }
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM data_keys WHERE purpose = 'secrets' AND kek = 'db'"
        )
        .await,
        1
    );
    assert!(crate::db::ring(&db).status(&db).await.unwrap().database_key);
    assert_eq!(pepper(&db).await.unwrap(), first[1].as_bytes());
    let instance = Instance::load(&db, &InstanceConfig::default())
        .await
        .expect("instance");
    assert_eq!(
        (&instance.relay_secret, &instance.p2p_secret),
        (&first[2], &first[3])
    );
    close(&db).await;

    for _ in 0..2 {
        let db = start(&path, Arc::default()).await.expect("next start");
        assert_eq!(secrets(&db).await, first);
        assert_eq!(sealed_rows(&db).await, records, "nothing is sealed twice");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM data_keys").await, 1);
        close(&db).await;
    }

    let db = open(path.to_str()).await.expect("a tool");
    assert_eq!(secrets(&db).await, first);
    assert_eq!(pepper(&db).await.unwrap(), first[1].as_bytes());
    for key in SETTINGS {
        assert_eq!(row(&db, key).await, None, "{key} is not made again");
    }
    close(&db).await;
    wipe(&path);
}

#[tokio::test]
async fn a_tool_makes_plain_secrets_and_the_next_start_seals_the_same_values() {
    let path = temp_file("secrets_tool_first");
    let db = open(path.to_str()).await.expect("a tool");
    let mut plain = Vec::new();
    for key in SETTINGS {
        plain.push(row(&db, key).await.expect(key));
        assert_eq!(row(&db, &sealed_name(key)).await, None);
    }
    assert_eq!(secrets(&db).await, plain, "a plain row is read as it is");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM data_keys").await, 0);
    close(&db).await;

    let db = start(&path, Arc::default()).await.expect("start");
    assert_eq!(secrets(&db).await, plain);
    for key in SETTINGS {
        assert_eq!(row(&db, key).await, None, "{key}");
    }
    close(&db).await;
    wipe(&path);
}

#[tokio::test]
async fn a_start_without_the_key_of_the_pepper_is_refused_even_when_lost_keys_are_allowed() {
    let path = temp_file("secrets_lost");
    let keys = Kek::generate("k1").encoded();
    let db = start(&path, ring(Some(&keys), false))
        .await
        .expect("first start");
    let first = secrets(&db).await;
    let records = sealed_rows(&db).await;
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM data_keys WHERE purpose = 'secrets' AND kek = 'k1'"
        )
        .await,
        1
    );
    close(&db).await;

    let refused = start(&path, Arc::default()).await.unwrap_err().to_string();
    assert!(
        refused.contains("needs the key k1") && refused.contains("ENCRYPTION_ALLOW_LOST=on"),
        "{refused}"
    );
    let refused = start(&path, ring(None, true))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refused.contains("the stored instance_signing_key is encrypted and cannot be opened")
            && refused.contains("ENCRYPTION_ALLOW_LOST does not cover it"),
        "{refused}"
    );
    let signing_only = DbOptions {
        signing_key_set: true,
        ..started(ring(None, true))
    };
    let refused = open_with(path.to_str(), &signing_only)
        .await
        .unwrap_err()
        .to_string();
    assert!(refused.contains("the stored password_pepper"), "{refused}");

    let db = start(&path, ring(Some(&keys), false))
        .await
        .expect("the key is back");
    assert_eq!(secrets(&db).await, first, "a refused start changes nothing");
    assert_eq!(sealed_rows(&db).await, records);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM data_keys").await, 1);
    assert_eq!(row(&db, RESET_SETTING).await, None);
    close(&db).await;

    let supplied = DbOptions {
        pepper: Some("from the env".to_owned()),
        signing_key_set: true,
        ..started(ring(None, true))
    };
    let db = open_with(path.to_str(), &supplied)
        .await
        .expect("the env supplies the pepper and the signing key");
    assert_eq!(pepper(&db).await.unwrap(), b"from the env");
    let now = sealed_rows(&db).await;
    assert_eq!(now[..2], records[..2], "the lost records stay");
    assert!(now[2] != records[2] && now[3] != records[3]);
    let relay = secret_setting(&db, RELAY_SECRET).await.unwrap().to_string();
    let p2p = secret_setting(&db, P2P_SECRET).await.unwrap().to_string();
    assert!(relay != first[2] && p2p != first[3], "new secrets");
    let refused = secret_setting(&db, SIGNING_KEY)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refused.contains("the stored instance_signing_key is encrypted and cannot be opened"),
        "{refused}"
    );
    let unsigned = Instance::load(&db, &InstanceConfig::default()).await;
    assert!(unsigned.is_err(), "no stored signing key to run on");
    let status = crate::db::ring(&db).status(&db).await.unwrap();
    let reset = status.secrets_reset.clone().expect("reset");
    assert_eq!(reset.secrets, [RELAY_SECRET, P2P_SECRET]);
    assert!(crate::crypt::cli::printed(&status).contains(&format!(
        "Stored secrets that could not be opened were made again at {}: relay_secret, p2p_secret.",
        reset.at
    )));
    assert_eq!(
        status
            .data_keys
            .iter()
            .map(|k| (k.generation, k.kek.as_str(), k.state.as_str(), k.held))
            .collect::<Vec<_>>(),
        [(1, "k1", "retiring", false), (2, "db", "active", true)]
    );
    close(&db).await;

    let db = open_with(path.to_str(), &supplied).await.expect("again");
    assert_eq!(sealed_rows(&db).await, now, "one reset, not one a start");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM data_keys").await, 2);
    close(&db).await;

    let db = start(&path, ring(Some(&keys), false))
        .await
        .expect("the key is back");
    assert_eq!(
        secrets(&db).await,
        [first[0].clone(), first[1].clone(), relay, p2p]
    );
    close(&db).await;
    wipe(&path);
}

#[tokio::test]
async fn a_relay_or_p2p_secret_that_does_not_open_is_made_again_only_when_allowed() {
    let path = temp_file("secrets_reset");
    let db = start(&path, Arc::default()).await.expect("first start");
    let first = secrets(&db).await;
    let records = sealed_rows(&db).await;
    sqlx::query("UPDATE settings SET value = $1 WHERE key = 'relay_secret.sealed'")
        .bind(&records[3])
        .execute(&db)
        .await
        .unwrap();
    close(&db).await;

    let refused = start(&path, Arc::default()).await.unwrap_err().to_string();
    assert!(
        refused.contains("the stored relay_secret is encrypted and cannot be opened")
            && refused.contains("ENCRYPTION_ALLOW_LOST=on"),
        "{refused}"
    );
    let db = start(&path, ring(None, true)).await.expect("allowed");
    let now = secrets(&db).await;
    assert_eq!(
        (&now[0], &now[1], &now[3]),
        (&first[0], &first[1], &first[3])
    );
    assert_ne!(now[2], first[2]);
    let reset: SecretsReset =
        serde_json::from_str(&row(&db, RESET_SETTING).await.expect("reset")).expect("json");
    assert_eq!(
        reset.secrets,
        [RELAY_SECRET],
        "only the relay secret was made again"
    );
    assert_eq!(count(&db, "SELECT COUNT(*) FROM data_keys").await, 1);
    sqlx::query("UPDATE settings SET value = $1 WHERE key = 'password_pepper.sealed'")
        .bind(&records[0])
        .execute(&db)
        .await
        .unwrap();
    close(&db).await;

    let refused = start(&path, ring(None, true))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refused.contains("the stored password_pepper is encrypted and cannot be opened"),
        "{refused}"
    );
    wipe(&path);
}

#[tokio::test]
async fn a_sealed_secret_opens_only_for_its_own_row() {
    let path = temp_file("secrets_rows");
    let db = start(&path, Arc::default()).await.expect("start");
    let sealer = Sealer::of(&db).await.unwrap();
    assert!(sealer.seals());
    let record = sealer
        .seal("outgoing_webhooks", "secret", "7", "whsec_one")
        .expect("sealed");
    let opened = |binding: &'static str, column: &'static str| {
        open_or(
            &db,
            "outgoing_webhooks",
            column,
            binding,
            Some(record.clone()),
            String::new(),
        )
    };
    assert_eq!(opened("7", "secret").await.unwrap().as_str(), "whsec_one");
    assert!(opened("8", "secret").await.is_err());
    assert!(opened("7", "data").await.is_err());
    let plain = open_or(&db, "outgoing_webhooks", "secret", "7", None, "kept".into()).await;
    assert_eq!(plain.unwrap().as_str(), "kept");
    close(&db).await;
    wipe(&path);
}

#[tokio::test]
async fn a_lost_root_key_is_never_replaced_under_its_own_id() {
    let path = temp_file("secrets_db_kek_lost");
    let db = start(&path, Arc::default()).await.expect("first start");
    let first = secrets(&db).await;
    let kept = row(&db, "secrets_db_kek").await.expect("database key");
    close(&db).await;

    let lost = |keys: Option<&str>| DbOptions {
        pepper: Some("from the env".to_owned()),
        signing_key_set: true,
        ..started(ring(keys, true))
    };
    let other = Kek::generate("db").encoded();
    let other = other.split_once(':').expect("id:key").1.to_owned();
    for value in [None, Some(other)] {
        set_db_kek(&path, value.as_deref()).await;
        let refused = open_with(path.to_str(), &lost(None))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            refused.contains("the data key 1 (secrets) needs the key db")
                && refused.contains("Restore secrets_db_kek, or set ENCRYPTION_KEYS"),
            "{refused}"
        );
        let db = open(path.to_str()).await.expect("a tool");
        assert_eq!(row(&db, "secrets_db_kek").await, value, "no key was made");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM data_keys").await, 1);
        assert_eq!(row(&db, RESET_SETTING).await, None);
        close(&db).await;
    }

    set_db_kek(&path, Some(&kept)).await;
    let db = start(&path, Arc::default()).await.expect("restored");
    assert_eq!(secrets(&db).await, first);
    close(&db).await;

    set_db_kek(&path, None).await;
    let k1 = Kek::generate("k1").encoded();
    let db = open_with(path.to_str(), &lost(Some(&k1)))
        .await
        .expect("a new data key under an operator key");
    let relay = secret_setting(&db, RELAY_SECRET).await.unwrap().to_string();
    let p2p = secret_setting(&db, P2P_SECRET).await.unwrap().to_string();
    close(&db).await;
    set_db_kek(&path, Some(&kept)).await;
    let db = start(&path, ring(Some(&k1), false))
        .await
        .expect("the database key restored");
    assert_eq!(
        secrets(&db).await,
        [first[0].clone(), first[1].clone(), relay, p2p],
        "both generations open"
    );
    assert!(
        crate::db::ring(&db)
            .status(&db)
            .await
            .unwrap()
            .data_keys
            .iter()
            .all(|k| k.held)
    );
    close(&db).await;
    wipe(&path);

    let path = temp_file("secrets_kek_lost");
    let (k1, other, k2) = (
        Kek::generate("k1").encoded(),
        Kek::generate("k1").encoded(),
        Kek::generate("k2").encoded(),
    );
    let db = start(&path, ring(Some(&k1), false))
        .await
        .expect("first start");
    let first = secrets(&db).await;
    close(&db).await;
    let refused = open_with(path.to_str(), &lost(Some(&other)))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refused.contains("but the key k1 here is a different key")
            && refused.contains("give the new key another id"),
        "{refused}"
    );
    let db = open_with(path.to_str(), &lost(Some(&k2)))
        .await
        .expect("a new key under a new id");
    let relay = secret_setting(&db, RELAY_SECRET).await.unwrap().to_string();
    let p2p = secret_setting(&db, P2P_SECRET).await.unwrap().to_string();
    close(&db).await;
    let both = format!("{},{}", k2.as_str(), k1.as_str());
    let db = start(&path, ring(Some(&both), false))
        .await
        .expect("both keys");
    assert_eq!(
        secrets(&db).await,
        [first[0].clone(), first[1].clone(), relay, p2p],
        "both generations open"
    );
    assert!(
        crate::db::ring(&db)
            .status(&db)
            .await
            .unwrap()
            .data_keys
            .iter()
            .all(|k| k.held)
    );
    close(&db).await;
    wipe(&path);
}

#[tokio::test]
async fn a_start_seals_every_plain_webhook_secret_over_an_older_record() {
    let path = temp_file("secrets_hooks");
    let db = start(&path, Arc::default()).await.expect("first start");
    let hooks = HOOK_BATCH + 2;
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $1) INSERT INTO outgoing_webhooks(server, name, url, events, secret, created_at) SELECT 'rchat', 'Out', 'https://example.com/', 'message.created', 'whsec_' || i, 1 FROM n")
        .bind(hooks)
        .execute(&db)
        .await
        .unwrap();
    let (first, last): (i64, i64) =
        sqlx::query_as("SELECT MIN(id), MAX(id) FROM outgoing_webhooks")
            .fetch_one(&db)
            .await
            .unwrap();
    let older = Sealer::of(&db)
        .await
        .unwrap()
        .seal(HOOK_TABLE, HOOK_COLUMN, &first.to_string(), "whsec_older")
        .expect("sealed");
    sqlx::query("UPDATE outgoing_webhooks SET secret_sealed = $1 WHERE id = $2")
        .bind(older)
        .bind(first)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        hook_secret(&db, first).await,
        ((false, true), "whsec_1".to_owned()),
        "a plain secret is newer than a sealed one"
    );
    close(&db).await;

    let db = start(&path, Arc::default()).await.expect("next start");
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM outgoing_webhooks WHERE secret = '' AND secret_sealed IS NOT NULL"
        )
        .await,
        hooks
    );
    for (id, value) in [
        (first, "whsec_1".to_owned()),
        (last, format!("whsec_{hooks}")),
    ] {
        assert_eq!(hook_secret(&db, id).await, ((true, true), value));
    }
    close(&db).await;
    wipe(&path);
}

/// Replaces the stored database key while no server runs, or removes it.
async fn set_db_kek(path: &Path, value: Option<&str>) {
    let db = open(path.to_str()).await.expect("a tool");
    sqlx::query("DELETE FROM settings WHERE key = 'secrets_db_kek'")
        .execute(&db)
        .await
        .unwrap();
    if let Some(value) = value {
        sqlx::query("INSERT INTO settings(key, value) VALUES('secrets_db_kek', $1)")
            .bind(value)
            .execute(&db)
            .await
            .unwrap();
    }
    close(&db).await;
}

/// Whether a hook's plain column is empty and its sealed one set, and the secret it opens to.
async fn hook_secret(db: &Db, id: i64) -> ((bool, bool), String) {
    let (plain, sealed): (String, Option<Vec<u8>>) =
        sqlx::query_as("SELECT secret, secret_sealed FROM outgoing_webhooks WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap();
    let stored = (plain.is_empty(), sealed.is_some());
    let value = open_or(db, HOOK_TABLE, HOOK_COLUMN, &id.to_string(), sealed, plain)
        .await
        .unwrap();
    (stored, value.to_string())
}
