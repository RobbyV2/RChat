use serde_json::json;
use zeroize::Zeroizing;

use super::*;
use crate::api::test_util::each_db_keyed;
use crate::crypt::bus_aad;
use crate::crypt::ring::KeyConfig;
use crate::db::{keyed_ring, ring};

const K1: &str = "k1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU";

fn note(bus: bool, keks: &[&str]) -> Option<CopyNote> {
    serde_json::from_value(json!({"build": "0", "seal": true, "bus": bus, "keks": keks})).ok()
}

#[test]
fn frames_are_sealed_only_once_every_copy_opens_them() {
    assert!(ready("k1", &[]));
    assert!(ready("k1", &[note(true, &["k2", "k1"])]));
    assert!(ready(
        "k1",
        &[note(true, &["k1"]), note(true, &["k1", "k3"])]
    ));
    for behind in [
        None,
        note(false, &["k1"]),
        note(true, &["k2"]),
        note(true, &[]),
        serde_json::from_value(json!({"build": "0", "seal": true, "keks": ["k1"]})).ok(),
    ] {
        assert!(!ready("k1", &[note(true, &["k1"]), behind]));
    }
    assert!(is_sealed(&[MAGIC, SERVER_RECORD, 0]));
    assert!(!is_sealed(b"{\"op\":1}"));
    assert!(!is_sealed(&[MAGIC, 0x02, 0]));
}

#[tokio::test]
async fn frames_go_plain_until_every_copy_opens_them_and_every_copy_reads_both() {
    for (state, _temp) in each_db_keyed("frames_sealed").await {
        let db = &state.db;
        let frames = Frames::new(ring(db), db.clone());
        assert!(!frames.sealed());
        assert_eq!(frames.seal(Stream::Hub, "", b"{}"), None);
        for others in [
            vec![None],
            vec![note(false, &["k1"])],
            vec![note(true, &["k2"])],
        ] {
            assert!(!frames.decide(&others).await.expect("decide"));
            assert_eq!(frames.seal(Stream::Hub, "", b"{}"), None);
        }
        let none: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM data_keys WHERE purpose = 'bus'")
            .fetch_one(db)
            .await
            .expect("count");
        assert_eq!(none, 0, "no bus key while a copy can't open frames");
        assert!(frames.decide(&[note(true, &["k1"])]).await.expect("decide"));
        assert!(frames.decide(&[]).await.expect("decide"));
        let sealed = frames.seal(Stream::Hub, "", b"{\"op\":1}").expect("sealed");
        assert!(is_sealed(&sealed));
        assert_eq!(
            frames.open(Stream::Hub, "", &sealed).await.expect("open"),
            b"{\"op\":1}"
        );
        assert!(frames.open(Stream::Jobs, "", &sealed).await.is_err());
        assert!(frames.open(Stream::Hub, "1-0", &sealed).await.is_err());
        let other = Frames::new(keyed_ring(), db.clone());
        assert_eq!(
            other
                .text(Stream::Hub, "", sealed.clone())
                .await
                .expect("text"),
            "{\"op\":1}"
        );
        assert_eq!(
            other
                .text(Stream::Hub, "", b"{\"op\":2}".to_vec())
                .await
                .expect("plain"),
            "{\"op\":2}"
        );
        assert!(
            Frames::plain()
                .open(Stream::Hub, "", &sealed)
                .await
                .is_err()
        );
        let (content, key) = ring(db)
            .data_key(db, Purpose::Content)
            .await
            .expect("content key")
            .expect("held");
        let foreign = seal(content, &key, &bus_aad("hub", "", content), b"{}");
        assert!(frames.open(Stream::Hub, "", &foreign).await.is_err());
        let snapshot = frames.seal(Stream::Snapshot, "7-0", b"{}").expect("sealed");
        assert!(
            frames
                .open(Stream::Snapshot, "8-0", &snapshot)
                .await
                .is_err()
        );
        assert_eq!(
            frames
                .open(Stream::Snapshot, "7-0", &snapshot)
                .await
                .expect("open"),
            b"{}"
        );
        assert!(!frames.decide(&[None]).await.expect("decide"));
        assert_eq!(frames.seal(Stream::Hub, "", b"{}"), None);
        assert!(
            !frames.decide(&[note(true, &["k2"])]).await.expect("decide"),
            "the bus key is wrapped under k1, which that copy lacks"
        );
        assert!(frames.opens(), "this copy still opens what is sealed");
        assert_eq!(
            frames
                .text(Stream::Hub, "", sealed)
                .await
                .expect("still opens"),
            "{\"op\":1}"
        );
    }
}

#[tokio::test]
async fn a_copy_that_can_not_unwrap_the_bus_key_goes_plain_and_says_so() {
    for (state, _temp) in each_db_keyed("frames_unwrap").await {
        let db = &state.db;
        let frames = Frames::new(ring(db), db.clone());
        assert!(frames.opens());
        assert!(frames.decide(&[]).await.expect("decide"));
        let both = Arc::new(
            Ring::load(
                &KeyConfig {
                    keys: Some(Zeroizing::new(format!(
                        "k2:{},{K1}",
                        "Wlk4WDdWNlU1VDRTM1IyUTFQME85TjhNN0w2SzVKNEk"
                    ))),
                    ..KeyConfig::default()
                },
                None,
            )
            .expect("ring"),
        );
        both.rotate(db, Purpose::Bus)
            .await
            .expect("rotate")
            .expect("made");
        assert!(
            !frames.decide(&[]).await.expect("decide"),
            "the new bus key is wrapped under k2, which this copy lacks"
        );
        assert!(!frames.opens());
        assert_eq!(frames.seal(Stream::Hub, "", b"{}"), None);
        let other = Frames::new(both.clone(), db.clone());
        assert!(
            other
                .decide(&[note(true, &["k2", "k1"])])
                .await
                .expect("decide")
        );
        assert!(!other.decide(&[note(false, &["k1"])]).await.expect("decide"));
        assert!(other.opens());
    }
}

#[tokio::test]
async fn a_replaced_bus_key_stops_sealing_and_opens_until_it_is_destroyed() {
    for (state, _temp) in each_db_keyed("frames_rotated").await {
        let db = &state.db;
        let frames = Frames::new(ring(db), db.clone());
        assert!(frames.decide(&[]).await.expect("decide"));
        let old = frames
            .seal(Stream::Jobs, "", b"{\"job\":1}")
            .expect("sealed");
        let other = keyed_ring();
        let (made, _) = other
            .rotate(db, Purpose::Bus)
            .await
            .expect("rotate")
            .expect("made");
        assert!(frames.decide(&[]).await.expect("decide"));
        let new = frames
            .seal(Stream::Jobs, "", b"{\"job\":2}")
            .expect("sealed");
        assert_eq!(header(&new).expect("header").key_id, made);
        assert_ne!(header(&old).expect("header").key_id, made);
        assert_eq!(
            frames
                .text(Stream::Jobs, "", old.clone())
                .await
                .expect("retiring"),
            "{\"job\":1}"
        );
        let fresh = Frames::new(keyed_ring(), db.clone());
        assert!(fresh.text(Stream::Jobs, "", old.clone()).await.is_ok());
        other.retire(db, Purpose::Bus).await.expect("retire");
        let gone = header(&old).expect("header").key_id;
        assert!(other.destroy(db, gone).await.expect("destroy"));
        let late = Frames::new(keyed_ring(), db.clone());
        assert!(late.text(Stream::Jobs, "", old.clone()).await.is_err());
        let missed = late.misses.lock().expect("misses").get(&gone).copied();
        assert!(missed.is_some());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(late.text(Stream::Jobs, "", old.clone()).await.is_err());
        assert_eq!(
            late.misses.lock().expect("misses").get(&gone).copied(),
            missed,
            "a skipped lookup does not push the next one back"
        );
        assert_eq!(
            late.text(Stream::Jobs, "", new).await.expect("new key"),
            "{\"job\":2}"
        );
    }
}

#[tokio::test]
async fn frames_never_use_the_database_key() {
    let path = crate::db::temp_db_path("frames_database_key");
    let _ = std::fs::remove_file(&path);
    let keyless = Arc::new(Ring::none());
    let opts = crate::db::DbOptions {
        ring: Some(keyless.clone()),
        controls: Some(crate::api::controls::ControlSeeds::default()),
        ..Default::default()
    };
    let db = crate::db::open_with(path.to_str(), &opts)
        .await
        .expect("open db");
    assert!(
        keyless
            .data_key(&db, Purpose::Secrets)
            .await
            .expect("secrets key")
            .is_some()
    );
    let frames = Frames::new(keyless, db.clone());
    assert!(!frames.opens() && frames.keks().is_empty());
    assert!(!frames.decide(&[]).await.expect("decide"));
    assert!(!frames.opens());
    assert_eq!(frames.seal(Stream::Jobs, "", b"{}"), None);
    assert!(!Frames::plain().decide(&[]).await.expect("decide"));
    crate::db::close(&db).await;
    let _ = std::fs::remove_file(path);
}
