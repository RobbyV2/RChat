use std::sync::atomic::{AtomicU64, Ordering};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use serde_json::json;
use zeroize::Zeroizing;

use super::{SETTLE, begin, current, destroy_due, run};
use crate::api::media::{Charge, save_within};
use crate::api::messages::{PageQuery, channel_messages, send_channel_message};
use crate::api::reauth::{AuthedSession, Session};
use crate::api::test_util::{add_member, each_db_keyed, mem_user, temp_state};
use crate::api::{Authed, MaybeAuthed};
use crate::crypt::ring::{KeyConfig, Ring};
use crate::crypt::{Purpose, header};
use crate::db::{Db, now};
use crate::state::AppState;

/// Rotations in tests have no other process to wait for.
fn no_settle() {
    SETTLE.store(0, std::sync::atomic::Ordering::Relaxed);
}

const K1: &str = "k1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU";
const K2: &str = "k2:MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY";
const PASSWORD: &str = "correct horse battery staple";

fn ring(keys: &str, database: Option<&str>) -> Ring {
    let config = KeyConfig {
        keys: Some(Zeroizing::new(keys.to_owned())),
        ..Default::default()
    };
    Ring::load(&config, database).expect("ring")
}

async fn count(db: &Db, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(db)
        .await
        .expect(sql)
}

/// `alice` managing the default server with encrypted storage on, `bob` writing in it: its
/// first channel.
async fn place(state: &AppState) -> i64 {
    let db = &state.db;
    let hash = crate::api::auth::hash_password(PASSWORD)
        .await
        .expect("hash");
    for name in ["alice", "bob", "carol"] {
        crate::db::NewUser::plain(name).hash(&hash).add(db).await;
    }
    sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username = 'carol'")
        .execute(db)
        .await
        .expect("admin");
    add_member(db, "rchat", "alice", 1, 0, 1).await;
    add_member(db, "rchat", "bob", 0, 0, 1).await;
    crate::api::servers::update_server(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path("rchat".to_string()),
        Json(serde_json::from_value(json!({"seal": true})).expect("patch")),
    )
    .await
    .map(|_| ())
    .expect("switch");
    sqlx::query_scalar("SELECT id FROM channels WHERE server = 'rchat' ORDER BY id LIMIT 1")
        .fetch_one(db)
        .await
        .expect("channel")
}

async fn say(state: &AppState, cid: i64, body: serde_json::Value) {
    send_channel_message(
        State(state.clone()),
        Path(cid),
        Authed(mem_user("bob", false)),
        Json(serde_json::from_value(body).expect("request")),
    )
    .await
    .map(|_| ())
    .expect("send");
}

async fn page(state: &AppState, cid: i64) -> String {
    let shown = channel_messages(
        State(state.clone()),
        MaybeAuthed(Some(mem_user("bob", false))),
        HeaderMap::new(),
        Path(cid),
        Query(PageQuery::default()),
    )
    .await
    .expect("page")
    .0;
    serde_json::to_string(&shown).expect("json")
}

/// The key ids the encrypted records of `sql` (one blob column) name.
async fn key_ids(db: &Db, sql: &str) -> Vec<u32> {
    let rows: Vec<Vec<u8>> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_all(db)
        .await
        .expect(sql);
    let mut ids: Vec<u32> = rows
        .iter()
        .map(|r| header(r).expect("record").key_id)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

async fn active(db: &Db, purpose: Purpose) -> u32 {
    crate::db::ring(db)
        .stored_data_key(db, purpose)
        .await
        .expect("key")
        .expect("active")
        .0
}

async fn file(state: &AppState) -> String {
    let data: Vec<u8> = (0..70_000u32).map(|i| (i % 239) as u8).collect();
    save_within(
        state,
        "kept.bin",
        "application/octet-stream",
        &data,
        "bob",
        Charge::own("bob"),
        0,
        None,
    )
    .await
    .expect("upload")
    .0
}

#[tokio::test]
async fn a_rotation_seals_every_record_again_and_the_old_keys_retire_then_go() {
    no_settle();
    for (state, temp) in each_db_keyed("rotate_all").await {
        let db = &state.db;
        let cid = place(&state).await;
        let kept = file(&state).await;
        say(&state, cid, json!({"content": "a file", "media_id": kept})).await;
        say(&state, cid, json!({"content": "", "poll": {"kind": "single", "question": "Which one", "options": [{"text": "Left"}, {"text": "Right"}]}})).await;
        say(&state, cid, json!({"content": "and some words"})).await;
        crate::api::media::sealed::seal_now(&state, &kept)
            .await
            .expect("seal the file");
        crate::api::seal::put_required(
            State(state.clone()),
            Authed(mem_user("carol", true)),
            Json(crate::api::seal::RequireReq { on: true }),
        )
        .await
        .map(|_| ())
        .expect("require");
        crate::api::auth::patch_me(
            State(state.clone()),
            Authed(
                crate::db::get_user(db, "bob")
                    .await
                    .expect("load")
                    .expect("bob"),
            ),
            Json(serde_json::from_value(json!({"bio": "about bob"})).expect("patch")),
        )
        .await
        .map(|_| ())
        .expect("bio");
        let hook: i64 = sqlx::query_scalar("INSERT INTO outgoing_webhooks(server, name, url, events, secret, created_at) VALUES('rchat', 'hook', 'https://example.invalid/', '[]', '', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("hook");
        let sealed = crate::crypt::secrets::Sealer::of(db)
            .await
            .expect("sealer")
            .seal(
                "outgoing_webhooks",
                "secret",
                &hook.to_string(),
                "hook secret",
            )
            .expect("sealed");
        sqlx::query("UPDATE outgoing_webhooks SET secret_sealed = $1 WHERE id = $2")
            .bind(sealed)
            .bind(hook)
            .execute(db)
            .await
            .expect("hook secret");
        let before = page(&state, cid).await;
        let old = [
            active(db, Purpose::Content).await,
            active(db, Purpose::Media).await,
            active(db, Purpose::Secrets).await,
        ];
        let rotation = begin(&state, &Purpose::ALL).await.expect("begin");
        assert!(
            ["content", "media", "secrets", "search"]
                .iter()
                .all(|p| rotation.purposes.iter().any(|n| n == p)),
            "{rotation:?}"
        );
        assert!(crate::db::ring(db).rotating(Purpose::Search));
        assert!(run(&state).await.expect("run"));
        assert_eq!(current(db).await.expect("current"), None, "it ended");
        let new = [
            active(db, Purpose::Content).await,
            active(db, Purpose::Media).await,
            active(db, Purpose::Secrets).await,
        ];
        assert!(old.iter().zip(&new).all(|(o, n)| o != n));
        assert_eq!(
            key_ids(db, "SELECT body FROM messages WHERE body IS NOT NULL").await,
            [new[0]]
        );
        for table in ["polls", "poll_options"] {
            assert_eq!(
                key_ids(
                    db,
                    &format!("SELECT body FROM {table} WHERE body IS NOT NULL")
                )
                .await,
                [new[0]],
                "{table}"
            );
        }
        assert_eq!(
            count(db, "SELECT seal_key FROM media WHERE seal_key IS NOT NULL").await,
            i64::from(new[1])
        );
        assert_eq!(
            key_ids(
                db,
                "SELECT data FROM media_chunks WHERE media_id IN (SELECT id FROM media WHERE seal_key IS NOT NULL)"
            )
            .await,
            [new[1]]
        );
        assert_eq!(
            key_ids(
                db,
                "SELECT bio_sealed FROM users WHERE bio_sealed IS NOT NULL"
            )
            .await,
            [new[0]]
        );
        assert_eq!(
            key_ids(
                db,
                "SELECT secret_sealed FROM outgoing_webhooks WHERE secret_sealed IS NOT NULL"
            )
            .await,
            [new[2]]
        );
        let bob = crate::db::get_user(db, "bob")
            .await
            .expect("load")
            .expect("bob");
        assert_eq!(
            crate::crypt::copies::bio_of(db, &bob)
                .await
                .expect("bio")
                .as_deref(),
            Some("about bob")
        );
        let settings: Vec<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key LIKE '%.sealed' ORDER BY key")
                .fetch_all(db)
                .await
                .expect("secrets");
        assert!(!settings.is_empty());
        for value in &settings {
            use base64::Engine;
            let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(value.trim())
                .expect("record");
            assert_eq!(header(&raw).expect("header").key_id, new[2]);
        }
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM data_keys WHERE state = 'retiring'"
            )
            .await,
            0
        );
        assert!(!crate::db::ring(db).rotating(Purpose::Search));
        assert_eq!(page(&state, cid).await, before, "everything reads the same");
        destroy_due(&state, now() + 1).await.expect("destroy");
        assert!(
            count(
                db,
                "SELECT COUNT(*) FROM data_keys WHERE state = 'destroyed' AND wrapped = ''"
            )
            .await
                >= 3
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM data_keys WHERE state = 'retired'").await,
            0
        );
        assert_eq!(
            page(&state, cid).await,
            before,
            "and after the old keys are gone"
        );
        temp.done(state).await;
    }
}

/// The picture file of `size` pixels as it is served, or the status that refuses it.
async fn picture(state: &AppState, id: &str, size: &str) -> Result<Vec<u8>, u16> {
    use axum::response::IntoResponse;
    let served = crate::api::avatars::get_avatar(
        State(state.clone()),
        HeaderMap::new(),
        Path((id.to_string(), size.to_string())),
    )
    .await
    .map_err(|e| e.0.as_u16())?
    .into_response();
    Ok(axum::body::to_bytes(served.into_body(), usize::MAX)
        .await
        .expect("body")
        .to_vec())
}

#[tokio::test]
async fn a_rotation_seals_stored_pictures_again_and_the_old_key_goes() {
    no_settle();
    for (state, temp) in each_db_keyed("rotate_pictures").await {
        let db = &state.db;
        place(&state).await;
        let image = rchat_avatar::samples::png(&rchat_avatar::samples::halves(90, 90));
        let id = crate::api::avatars::put_server_icon(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("rchat".to_string()),
            Query(serde_json::from_value(json!({})).expect("crop")),
            HeaderMap::new(),
            axum::body::Body::from(image),
        )
        .await
        .unwrap_or_else(|e| panic!("picture: {}", e.1))
        .0
        .icon_image
        .expect("a picture id");
        let old = active(db, Purpose::Content).await;
        let under = |key: u32| format!("SELECT COUNT(*) FROM avatar_images WHERE seal_key = {key}");
        assert_eq!(count(db, &under(old)).await, 1, "stored encrypted");
        for column in ["s64", "s128", "s512"] {
            let sql = format!("SELECT {column} FROM avatar_images");
            assert_eq!(key_ids(db, &sql).await, [old], "{column}");
        }
        assert_eq!(
            super::names(db, old, Purpose::Content)
                .await
                .unwrap_or_else(|e| panic!("names: {}", e.1)),
            1,
            "the picture holds its key"
        );
        let before = picture(&state, &id, "128").await.expect("served");
        assert!(rchat_avatar::samples::read(&before).is_some(), "an image");

        begin(&state, &[Purpose::Content]).await.expect("begin");
        assert!(run(&state).await.expect("run"));
        let new = active(db, Purpose::Content).await;
        assert_ne!(new, old);
        assert_eq!(count(db, &under(new)).await, 1);
        for column in ["s64", "s128", "s512"] {
            let sql = format!("SELECT {column} FROM avatar_images");
            assert_eq!(key_ids(db, &sql).await, [new], "{column}");
        }
        assert_eq!(
            super::names(db, old, Purpose::Content)
                .await
                .unwrap_or_else(|e| panic!("names: {}", e.1)),
            0
        );
        destroy_due(&state, now() + 1).await.expect("destroy");
        assert_eq!(
            picture(&state, &id, "128").await.as_ref(),
            Ok(&before),
            "it reads the same after the old key is gone"
        );

        sqlx::query("UPDATE avatar_images SET s128 = s64")
            .execute(db)
            .await
            .expect("move");
        assert_eq!(
            picture(&state, &id, "128").await,
            Err(404),
            "a file moved to another size does not open"
        );
        assert!(picture(&state, &id, "64").await.is_ok());
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_record_that_does_not_open_does_not_hold_the_old_key_back() {
    no_settle();
    for (state, temp) in each_db_keyed("rotate_lost").await {
        let db = &state.db;
        let cid = place(&state).await;
        for text in ["one", "two"] {
            say(&state, cid, json!({"content": text})).await;
        }
        let bodies: Vec<(i64, Vec<u8>)> =
            sqlx::query_as("SELECT id, body FROM messages WHERE body IS NOT NULL ORDER BY id")
                .fetch_all(db)
                .await
                .expect("bodies");
        sqlx::query("UPDATE messages SET body = $1 WHERE id = $2")
            .bind(&bodies[1].1)
            .bind(bodies[0].0)
            .execute(db)
            .await
            .expect("a record moved onto another row");
        begin(&state, &[Purpose::Content]).await.expect("begin");
        assert!(run(&state).await.expect("run"));
        assert_eq!(current(db).await.expect("current"), None);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM data_keys WHERE purpose = 'content' AND state = 'retired'"
            )
            .await,
            1,
            "it opens with no key, so it does not keep one"
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_record_left_for_now_keeps_the_old_key_until_run_again() {
    no_settle();
    for (state, temp) in each_db_keyed("rotate_left").await {
        let db = &state.db;
        let cid = place(&state).await;
        let kept = file(&state).await;
        say(&state, cid, json!({"content": "a file", "media_id": kept})).await;
        crate::api::media::sealed::seal_now(&state, &kept)
            .await
            .expect("seal the file");
        sqlx::query("DELETE FROM media_chunks WHERE media_id = $1")
            .bind(&kept)
            .execute(db)
            .await
            .expect("the file as one kept in S3, which this site can't reach now");
        begin(&state, &[Purpose::Media]).await.expect("begin");
        assert!(run(&state).await.expect("run"));
        let left = current(db).await.expect("current").expect("kept");
        assert_eq!((left.left, left.ended), (1, true));
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM data_keys WHERE purpose = 'media' AND state = 'retiring'"
            )
            .await,
            1,
            "the old key stays"
        );
        let again = begin(&state, &[Purpose::Media]).await.expect("again");
        assert_eq!((again.step, again.left, again.ended), (0, 0, false));
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM data_keys WHERE purpose = 'media'").await,
            2,
            "running it again makes no new generation"
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_process_holding_the_old_key_is_caught_before_the_key_is_destroyed() {
    no_settle();
    for (state, temp) in each_db_keyed("rotate_stale").await {
        let db = &state.db;
        let ring = crate::db::ring(db);
        let cid = place(&state).await;
        say(&state, cid, json!({"content": "before"})).await;
        let old = active(db, Purpose::Content).await;
        begin(&state, &[Purpose::Content]).await.expect("begin");
        assert!(run(&state).await.expect("run"));
        assert_eq!(current(db).await.expect("current"), None);
        ring.pin_active(Purpose::Content, old);
        say(
            &state,
            cid,
            json!({"content": "from a process that holds the old key"}),
        )
        .await;
        assert!(
            key_ids(db, "SELECT body FROM messages WHERE body IS NOT NULL")
                .await
                .contains(&old)
        );
        destroy_due(&state, now() + 1).await.expect("destroy");
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM data_keys WHERE purpose = 'content' AND state = 'retiring'"
            )
            .await,
            1,
            "a key a record names is not destroyed: it retires again"
        );
        assert!(current(db).await.expect("current").is_some());
        ring.note_keys(db).await.expect("note");
        say(&state, cid, json!({"content": "under the new key now"})).await;
        assert!(run(&state).await.expect("run again"));
        destroy_due(&state, now() + 1).await.expect("destroy");
        let fresh = active(db, Purpose::Content).await;
        assert_ne!(fresh, old);
        assert_eq!(
            key_ids(db, "SELECT body FROM messages WHERE body IS NOT NULL").await,
            [fresh]
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM data_keys WHERE purpose = 'content' AND state = 'destroyed'"
            )
            .await,
            1
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn data_keys_move_under_a_new_first_key_once_every_copy_holds_it() {
    let (state, path) = temp_state("rotate_rewrap").await;
    let db = &state.db;
    let first = ring(K1, None);
    first
        .data_key(db, Purpose::Content)
        .await
        .expect("content")
        .expect("made");
    assert_eq!(
        count(db, "SELECT COUNT(*) FROM data_keys WHERE kek = 'db'").await,
        1,
        "the secrets key starts under the database key"
    );
    let both = ring(&format!("{K2},{K1}"), None);
    assert_eq!(both.rewrap(db, false).await.expect("wait"), 0);
    assert_eq!(both.rewrap(db, true).await.expect("move"), 2);
    assert_eq!(
        count(db, "SELECT COUNT(*) FROM data_keys WHERE kek <> 'k2'").await,
        0
    );
    let blanked: String =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'secrets_db_kek'")
            .fetch_one(db)
            .await
            .expect("database key");
    assert_eq!(
        blanked, "!sealed",
        "the database key is gone once nothing uses it"
    );
    let only = ring(K2, None);
    assert_eq!(only.check(db).await.expect("check"), Vec::<i64>::new());
    assert!(
        only.data_key(db, Purpose::Content)
            .await
            .expect("open")
            .is_some()
    );
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn the_key_file_stays_readable_beside_operator_keys_until_nothing_needs_it() {
    let (state, path) = temp_state("rotate_file").await;
    let db = &state.db;
    let url = path.to_str().expect("path");
    let keys = format!("{url}.keys");
    std::fs::write(&keys, format!("{K1}\n")).expect("key file");
    let from_file = Ring::load(&KeyConfig::default(), Some(url)).expect("file ring");
    from_file
        .data_key(db, Purpose::Content)
        .await
        .expect("content")
        .expect("made");
    let operator = ring(K2, Some(url));
    assert_eq!(operator.check(db).await.expect("check"), Vec::<i64>::new());
    let status = operator.status(db).await.expect("status");
    assert_eq!(status.kept.len(), 1);
    assert!(status.kept[0].starts_with("k1:"));
    assert!(operator.rewrap(db, true).await.expect("move") >= 1);
    let status = operator.status(db).await.expect("status");
    assert!(
        status
            .data_keys
            .iter()
            .all(|k| k.kek == "k2" || k.state == "destroyed")
    );
    let printed = crate::crypt::cli::printed(&status);
    assert!(printed.contains("it can be deleted"), "{printed}");
    let _ = std::fs::remove_file(keys);
    let _ = std::fs::remove_file(path);
}

static SESSIONS: AtomicU64 = AtomicU64::new(0);

#[tokio::test]
async fn only_the_site_admin_rotates_after_a_confirmation() {
    no_settle();
    for (state, temp) in each_db_keyed("rotate_admin").await {
        let db = &state.db;
        place(&state).await;
        let post = |who: &'static str, body: serde_json::Value| {
            let state = state.clone();
            async move {
                let user = crate::db::get_user(&state.db, who)
                    .await
                    .expect("load")
                    .expect("user");
                let session = Session {
                    user,
                    token: format!("rotate-{who}-{}", SESSIONS.fetch_add(1, Ordering::Relaxed)),
                    created_at: now(),
                };
                crate::api::encryption::post_rotate(
                    State(state.clone()),
                    AuthedSession(session),
                    Json(serde_json::from_value(body).expect("body")),
                )
                .await
                .map(|Json(r)| r)
                .map_err(|e| e.0.as_u16())
            }
        };
        let ok = json!({"purposes": ["content"], "reauth": {"password": PASSWORD}});
        assert_eq!(post("alice", ok.clone()).await.err(), Some(404));
        assert_eq!(
            post(
                "carol",
                json!({"purposes": ["nope"], "reauth": {"password": PASSWORD}})
            )
            .await
            .err(),
            Some(400)
        );
        assert_eq!(
            post(
                "carol",
                json!({"purposes": ["content"], "reauth": {"password": "wrong"}})
            )
            .await
            .err(),
            Some(401)
        );
        let rotation = post("carol", ok).await.expect("rotate");
        assert_eq!(rotation.purposes, ["content"]);
        let audited = count(
            db,
            "SELECT COUNT(*) FROM instance_audit WHERE action = 'encryption.rotate'",
        )
        .await;
        assert_eq!(audited, 1);
        temp.done(state).await;
    }
}
