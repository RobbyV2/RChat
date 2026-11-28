use std::path::{Path, PathBuf};
use std::sync::Arc;

use zeroize::Zeroizing;

use super::stub::Stub;
use super::*;
use crate::api::controls::ControlSeeds;
use crate::api::test_util::pg_temp;
use crate::crypt::ring::{KeyConfig, Ring};
use crate::db::{Db, DbOptions, open_with};

const TOKEN: &str = "s.stub-token";
const K1: &str = "k1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU";

fn token_file(tag: &str, token: &str) -> PathBuf {
    let path = crate::db::temp_db_path(&format!("{tag}_token"));
    std::fs::write(&path, format!("{token}\n")).expect("token file");
    path
}

fn settings(url: &str, token: &Path) -> impl Fn(&str) -> Option<String> {
    let (url, token) = (url.to_owned(), token.display().to_string());
    move |name| match name {
        "ENCRYPTION_KMS_URL" => Some(url.clone()),
        "ENCRYPTION_KMS_KEY" => Some("rchat".to_owned()),
        "ENCRYPTION_KMS_TOKEN_FILE" => Some(token.clone()),
        _ => None,
    }
}

fn ring(kms: Option<KmsConfig>, keys: Option<&str>, allow_lost: bool) -> Arc<Ring> {
    let config = KeyConfig {
        keys: keys.map(|k| Zeroizing::new(k.to_owned())),
        allow_lost,
        kms,
        ..KeyConfig::default()
    };
    Arc::new(Ring::load(&config, None).expect("ring"))
}

async fn start(url: &str, ring: &Arc<Ring>) -> anyhow::Result<Db> {
    let opts = DbOptions {
        ring: Some(ring.clone()),
        controls: Some(ControlSeeds::default()),
        ..DbOptions::default()
    };
    open_with(Some(url), &opts).await
}

/// A SQLite file and, when `TEST_POSTGRES_URL` is set, a Postgres database, each new.
async fn databases(tag: &str) -> Vec<(String, Option<crate::api::test_util::PgTemp>)> {
    let path = crate::db::temp_db_path(tag);
    let _ = std::fs::remove_file(&path);
    let mut out = vec![(path.display().to_string(), None)];
    if let Some(temp) = pg_temp(tag).await {
        out.push((temp.url.clone(), Some(temp)));
    }
    out
}

fn remove_sqlite(url: &str) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{url}{suffix}"));
    }
}

async fn keks(db: &Db) -> Vec<String> {
    sqlx::query_scalar("SELECT kek FROM data_keys WHERE state <> 'destroyed' ORDER BY id")
        .fetch_all(db)
        .await
        .expect("keks")
}

#[test]
fn the_key_service_is_set_by_all_three_settings_or_none() {
    let token = token_file("kms_settings", TOKEN);
    let load = |pairs: &[(&str, &str)]| {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        KeyConfig::load(&move |name| {
            pairs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        })
    };
    let file = token.display().to_string();
    assert!(load(&[]).expect("none").kms.is_none());
    let config = load(&[
        (
            "ENCRYPTION_KMS_URL",
            "https://vault.internal:8200/v1/transit/",
        ),
        ("ENCRYPTION_KMS_KEY", "rchat"),
        ("ENCRYPTION_KMS_TOKEN_FILE", &file),
    ])
    .expect("set")
    .kms
    .expect("kms");
    assert_eq!(config.url, "https://vault.internal:8200/v1/transit");
    for here in [
        "http://127.0.0.1:8200/v1/transit",
        "http://localhost:8200/v1/transit",
        "http://[::1]:8200/v1/transit",
    ] {
        let local = load(&[
            ("ENCRYPTION_KMS_URL", here),
            ("ENCRYPTION_KMS_KEY", "rchat"),
            ("ENCRYPTION_KMS_TOKEN_FILE", &file),
        ]);
        assert!(local.expect(here).kms.is_some(), "{here}");
    }
    assert!(!format!("{config:?}").contains(&file));
    let partial = load(&[(
        "ENCRYPTION_KMS_URL",
        "https://vault.internal:8200/v1/transit",
    )])
    .expect_err("partial")
    .to_string();
    assert!(
        partial.contains("ENCRYPTION_KMS_KEY and ENCRYPTION_KMS_TOKEN_FILE must be set too"),
        "{partial}"
    );
    for (url, key, named) in [
        ("ftp://vault/v1/transit", "rchat", "ENCRYPTION_KMS_URL"),
        (
            "https://user:pw@vault/v1/transit",
            "rchat",
            "ENCRYPTION_KMS_URL",
        ),
        (
            "https://vault/v1/transit?x=1",
            "rchat",
            "ENCRYPTION_KMS_URL",
        ),
        ("not a url", "rchat", "ENCRYPTION_KMS_URL"),
        (
            "http://vault.internal/v1/transit",
            "rchat",
            "ENCRYPTION_KMS_URL",
        ),
        ("https://vault/v1/transit", "a/b", "ENCRYPTION_KMS_KEY"),
        ("https://vault/v1/transit", "", "ENCRYPTION_KMS_KEY"),
    ] {
        let refused = load(&[
            ("ENCRYPTION_KMS_URL", url),
            ("ENCRYPTION_KMS_KEY", key),
            ("ENCRYPTION_KMS_TOKEN_FILE", &file),
        ])
        .expect_err(url)
        .to_string();
        assert!(refused.contains(named), "{url} {key}: {refused}");
    }
    for token in ["/nonexistent/rchat_token", ""] {
        let refused = load(&[
            ("ENCRYPTION_KMS_URL", "https://vault/v1/transit"),
            ("ENCRYPTION_KMS_KEY", "rchat"),
            ("ENCRYPTION_KMS_TOKEN_FILE", token),
        ])
        .expect_err(token)
        .to_string();
        assert!(refused.contains("ENCRYPTION_KMS_TOKEN_FILE"), "{refused}");
    }
    std::fs::write(&token, "\n").expect("empty");
    let empty = load(&[
        ("ENCRYPTION_KMS_URL", "https://vault/v1/transit"),
        ("ENCRYPTION_KMS_KEY", "rchat"),
        ("ENCRYPTION_KMS_TOKEN_FILE", &file),
    ])
    .expect_err("empty token")
    .to_string();
    assert_eq!(empty, "ENCRYPTION_KMS_TOKEN_FILE names an empty file");
    let _ = std::fs::remove_file(token);
}

#[tokio::test]
async fn the_key_service_wraps_every_data_key_and_is_asked_at_start_and_for_new_keys() {
    for (url, temp) in databases("kms_wraps").await {
        let (stub, mount) = Stub::start(TOKEN).await;
        let token = token_file("kms_wraps", TOKEN);
        let config = KeyConfig::load(&settings(&mount, &token))
            .expect("config")
            .kms;
        let first = ring(config.clone(), None, false);
        let db = start(&url, &first).await.expect("start");
        let at_start = stub.calls();
        assert!(at_start >= 3, "a probe and the secrets key: {at_start}");
        let (content, key) = first
            .data_key(&db, Purpose::Content)
            .await
            .expect("content")
            .expect("made");
        assert_eq!(stub.calls(), at_start + 1, "one wrap for the new key");
        for _ in 0..20 {
            first.data_key(&db, Purpose::Content).await.expect("held");
            first.key_by_id(&db, content).await.expect("held");
        }
        let status = first.status(&db).await.expect("status");
        assert_eq!(stub.calls(), at_start + 1, "held keys ask nothing");
        assert_eq!(status.source, "kms");
        assert_eq!(
            status.kms.as_deref(),
            Some(format!("{mount} (key rchat)").as_str())
        );
        assert_eq!(status.fingerprints, ["kms:rchat:"]);
        assert!(
            status
                .data_keys
                .iter()
                .all(|k| k.held && k.kek == "kms:rchat")
        );
        assert!(!status.database_key);
        assert_eq!(keks(&db).await, ["kms:rchat", "kms:rchat"]);
        assert_eq!(first.kek_ids(), ["kms:rchat"]);
        assert!(first.ready() && first.kms_only());
        crate::db::close(&db).await;
        let before = stub.calls();
        let again = ring(config.clone(), None, false);
        let db = start(&url, &again).await.expect("restart");
        assert_eq!(
            stub.calls(),
            before + 2 + 2,
            "a probe and one unwrap per data key"
        );
        let (same, reread) = again
            .data_key(&db, Purpose::Content)
            .await
            .expect("content")
            .expect("held");
        assert_eq!((same, &reread[..]), (content, &key[..]));
        assert_eq!(stub.calls(), before + 4);
        let (rotated, _) = again
            .rotate(&db, Purpose::Content)
            .await
            .expect("rotate")
            .expect("made");
        assert_ne!(rotated, content);
        assert_eq!(stub.calls(), before + 5, "a rotation wraps once");
        crate::db::close(&db).await;
        drop(temp);
        let _ = std::fs::remove_file(token);
        remove_sqlite(&url);
    }
}

#[tokio::test]
async fn a_start_is_refused_while_the_key_service_can_not_be_used() {
    for (url, temp) in databases("kms_refused").await {
        let (stub, mount) = Stub::start(TOKEN).await;
        let token = token_file("kms_refused", TOKEN);
        let config = KeyConfig::load(&settings(&mount, &token))
            .expect("config")
            .kms;
        let db = start(&url, &ring(config.clone(), None, false))
            .await
            .expect("start");
        crate::db::close(&db).await;
        stub.set_down(true);
        for allow_lost in [false, true] {
            let refused = start(&url, &ring(config.clone(), None, allow_lost))
                .await
                .expect_err("down")
                .to_string();
            assert!(
                refused.contains(&format!("the key service at {mount} can't be used"))
                    && refused.contains("503"),
                "{refused}"
            );
        }
        stub.set_down(false);
        std::fs::write(&token, "s.other").expect("token");
        let refused = start(&url, &ring(config.clone(), None, false))
            .await
            .expect_err("token")
            .to_string();
        assert!(!refused.contains("s.other") && !refused.contains(TOKEN));
        assert!(
            refused.contains("403") && refused.contains("permission denied"),
            "{refused}"
        );
        std::fs::remove_file(&token).expect("remove");
        let refused = start(&url, &ring(config.clone(), None, false))
            .await
            .expect_err("no token")
            .to_string();
        assert!(refused.contains("ENCRYPTION_KMS_TOKEN_FILE"), "{refused}");
        assert!(!refused.contains(&token.display().to_string()), "{refused}");
        std::fs::write(&token, TOKEN).expect("token");
        let db = start(&url, &ring(config.clone(), None, false))
            .await
            .expect("back");
        crate::db::close(&db).await;
        stub.replace("rchat");
        let refused = start(&url, &ring(config.clone(), None, false))
            .await
            .expect_err("replaced")
            .to_string();
        assert!(
            refused.contains("needs the key kms:rchat, which the key service does not open"),
            "{refused}"
        );
        drop(temp);
        let _ = std::fs::remove_file(token);
        remove_sqlite(&url);
    }
}

#[tokio::test]
async fn an_outage_while_running_reads_unheld_keys_as_missing_and_keeps_held_ones() {
    for (url, temp) in databases("kms_outage").await {
        let (stub, mount) = Stub::start(TOKEN).await;
        let token = token_file("kms_outage", TOKEN);
        let config = KeyConfig::load(&settings(&mount, &token))
            .expect("config")
            .kms;
        let first = ring(config.clone(), None, false);
        let db = start(&url, &first).await.expect("start");
        let (old, _) = first
            .data_key(&db, Purpose::Content)
            .await
            .expect("content")
            .expect("made");
        first
            .rotate(&db, Purpose::Content)
            .await
            .expect("rotate")
            .expect("made");
        first.retire(&db, Purpose::Content).await.expect("retire");
        assert!(first.destroy(&db, old).await.expect("destroy"));
        let other = ring(config.clone(), None, false);
        let (made, key) = other
            .rotate(&db, Purpose::Media)
            .await
            .expect("another copy rotates")
            .expect("made");
        let calls = stub.calls();
        let status = first.status(&db).await.expect("status");
        let destroyed = status
            .data_keys
            .iter()
            .find(|k| k.state == "destroyed")
            .expect("destroyed");
        assert!(!destroyed.held && !destroyed.mismatch);
        assert_eq!(
            stub.calls(),
            calls + 1,
            "only the key made by the other copy"
        );
        for _ in 0..5 {
            first.status(&db).await.expect("status");
        }
        assert_eq!(
            stub.calls(),
            calls + 1,
            "held and destroyed keys ask nothing"
        );
        stub.set_down(true);
        let fresh = ring(config.clone(), None, false);
        let started = tokio::time::Instant::now();
        assert!(fresh.key_by_id(&db, made).await.expect("read").is_none());
        assert!(fresh.key_by_id(&db, made).await.expect("read").is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(
            stub.calls(),
            calls + 2,
            "an unusable service is asked again only later"
        );
        let status = fresh.status(&db).await.expect("status while down");
        assert!(status.data_keys.iter().all(|k| !k.held && !k.mismatch));
        let (_, held) = first
            .key_by_id(&db, made)
            .await
            .expect("held")
            .expect("held key");
        assert_eq!(&held[..], &key[..]);
        let printed = crate::crypt::cli::printed(&first.status(&db).await.expect("status"));
        assert!(
            printed.starts_with(&format!(
                "Keys: the key service {mount} (key rchat)\n  kms:rchat\n"
            )),
            "{printed}"
        );
        assert!(!printed.contains("(its key is missing)"), "{printed}");
        stub.set_down(false);
        crate::db::close(&db).await;
        stub.replace("rchat");
        let refused = start(&url, &ring(config.clone(), None, true))
            .await
            .expect_err("a new key under a key the service no longer opens")
            .to_string();
        assert!(
            refused.contains("which the key service does not open. Restore that key in the key service, or name another key in ENCRYPTION_KMS_KEY"),
            "{refused}"
        );
        drop(temp);
        let _ = std::fs::remove_file(token);
        remove_sqlite(&url);
    }
}

#[tokio::test]
async fn data_keys_move_under_the_key_service_and_open_with_it_alone() {
    for (url, temp) in databases("kms_moves").await {
        let (_stub, mount) = Stub::start(TOKEN).await;
        let token = token_file("kms_moves", TOKEN);
        let config = KeyConfig::load(&settings(&mount, &token))
            .expect("config")
            .kms;
        let operator = ring(None, Some(K1), false);
        let db = start(&url, &operator).await.expect("start");
        let (content, key) = operator
            .data_key(&db, Purpose::Content)
            .await
            .expect("content")
            .expect("made");
        assert_eq!(keks(&db).await, ["k1", "k1"]);
        crate::db::close(&db).await;
        let both = ring(config.clone(), Some(K1), false);
        let db = start(&url, &both).await.expect("both");
        assert_eq!(both.kek_ids(), ["kms:rchat", "k1"]);
        assert_eq!(both.first_kek().as_deref(), Some("kms:rchat"));
        assert!(!both.kms_only());
        let status = both.status(&db).await.expect("status");
        assert_eq!(status.fingerprints, ["kms:rchat:"]);
        assert_eq!(status.kept.len(), 1);
        assert!(status.kept[0].starts_with("k1:"));
        assert_eq!(both.rewrap(&db, false).await.expect("not yet"), 0);
        assert_eq!(both.rewrap(&db, true).await.expect("rewrap"), 2);
        assert_eq!(keks(&db).await, ["kms:rchat", "kms:rchat"]);
        crate::db::close(&db).await;
        let alone = ring(config.clone(), None, false);
        let db = start(&url, &alone).await.expect("alone");
        let (same, reread) = alone
            .data_key(&db, Purpose::Content)
            .await
            .expect("content")
            .expect("held");
        assert_eq!((same, &reread[..]), (content, &key[..]));
        crate::db::close(&db).await;
        let refused = start(&url, &ring(None, Some(K1), false))
            .await
            .expect_err("k1 alone")
            .to_string();
        assert!(
            refused.contains("needs the key kms:rchat, which ENCRYPTION_KMS_KEY does not hold"),
            "{refused}"
        );
        drop(temp);
        let _ = std::fs::remove_file(token);
        remove_sqlite(&url);
    }
}

#[tokio::test]
async fn a_wrapped_key_moved_to_another_row_does_not_open() {
    for ignores_context in [false, true] {
        let tag = format!("kms_moved_{ignores_context}");
        for (url, temp) in databases(&tag).await {
            let (stub, mount) = Stub::start(TOKEN).await;
            stub.ignore_context(ignores_context);
            let token = token_file(&tag, TOKEN);
            let config = KeyConfig::load(&settings(&mount, &token))
                .expect("config")
                .kms;
            let first = ring(config.clone(), None, false);
            let db = start(&url, &first).await.expect("start");
            first
                .data_key(&db, Purpose::Content)
                .await
                .expect("content")
                .expect("made");
            first
                .data_key(&db, Purpose::Media)
                .await
                .expect("media")
                .expect("made");
            first
                .rotate(&db, Purpose::Search)
                .await
                .expect("search 1")
                .expect("made");
            first
                .rotate(&db, Purpose::Search)
                .await
                .expect("search 2")
                .expect("made");
            let swaps = [
                "UPDATE data_keys SET wrapped = (SELECT wrapped FROM data_keys WHERE purpose = 'media') WHERE purpose = 'content'",
                "UPDATE data_keys SET wrapped = (SELECT wrapped FROM data_keys WHERE purpose = 'search' AND gen = 2) WHERE purpose = 'search' AND gen = 1",
            ];
            for swap in swaps {
                sqlx::query(swap).execute(&db).await.expect("swap");
            }
            crate::db::close(&db).await;
            let refused = start(&url, &ring(config.clone(), None, false))
                .await
                .expect_err("moved")
                .to_string();
            assert!(
                refused.contains(
                    "(content) needs the key kms:rchat, which the key service does not open"
                ),
                "{refused}"
            );
            let lost = ring(config.clone(), None, true);
            let db = start(&url, &lost).await.expect("lost allowed");
            let status = lost.status(&db).await.expect("status");
            let shown = |purpose: &str, generation: i64| {
                status
                    .data_keys
                    .iter()
                    .find(|k| k.purpose == purpose && k.generation == generation)
                    .map(|k| (k.held, k.mismatch))
            };
            assert_eq!(shown("content", 1), Some((false, true)));
            assert_eq!(
                shown("search", 1),
                Some((false, true)),
                "another generation"
            );
            assert_eq!(shown("search", 2), Some((true, false)));
            assert_eq!(shown("media", 1), Some((true, false)));
            let calls = stub.calls();
            for _ in 0..5 {
                lost.status(&db).await.expect("status");
                for id in 1..=6 {
                    lost.key_by_id(&db, id).await.expect("read");
                }
            }
            assert_eq!(stub.calls(), calls, "what did not open is not asked again");
            crate::db::close(&db).await;
            drop(temp);
            let _ = std::fs::remove_file(token);
            remove_sqlite(&url);
        }
    }
}
