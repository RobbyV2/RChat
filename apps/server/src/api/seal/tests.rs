use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use serde_json::json;
use sqlx::Row;

use super::{COPIES, CopiesReq, FORCED, NEEDS_KEY, RequireReq, SITE_FROM, SealReq, UPDATING};
use crate::api::dms::open_dm;
use crate::api::messages::{
    EditReq, PageQuery, channel_messages, dm_messages, edit_message, send_channel_message,
    send_dm_message,
};
use crate::api::servers::update_server;
use crate::api::test_util::{TempDb, add_member, done, each_db_keyed, mem_user, temp_state};
use crate::api::{ApiError, Authed, MaybeAuthed, Message, ReasonKind};
use crate::db::{Db, is_sqlite, now};
use crate::state::AppState;
use crate::ws::WsEvent;

async fn general(db: &Db) -> i64 {
    sqlx::query_scalar("SELECT id FROM channels WHERE server = 'rchat' ORDER BY id LIMIT 1")
        .fetch_one(db)
        .await
        .expect("channel")
}

async fn staffed(db: &Db) -> i64 {
    add_member(db, "rchat", "alice", 1, 0, 1).await;
    add_member(db, "rchat", "bob", 0, 0, 1).await;
    general(db).await
}

async fn send(state: &AppState, cid: i64, who: &str, body: serde_json::Value) -> Message {
    send_channel_message(
        State(state.clone()),
        Path(cid),
        Authed(mem_user(who, false)),
        Json(serde_json::from_value(body).expect("request")),
    )
    .await
    .expect("send")
    .0
}

async fn say(state: &AppState, cid: i64, who: &str, text: &str) -> Message {
    send(state, cid, who, json!({"content": text})).await
}

async fn dm_say(state: &AppState, dm: i64, who: &str, text: &str) -> Result<Message, ApiError> {
    send_dm_message(
        State(state.clone()),
        Path(dm),
        Authed(mem_user(who, false)),
        Json(serde_json::from_value(json!({"content": text})).expect("request")),
    )
    .await
    .map(|Json(m)| m)
}

async fn edit(state: &AppState, id: i64, who: &str, text: &str) -> Message {
    edit_message(
        State(state.clone()),
        Path(id),
        Authed(mem_user(who, false)),
        Json(serde_json::from_value::<EditReq>(json!({"content": text})).expect("request")),
    )
    .await
    .expect("edit")
    .0
}

async fn page(state: &AppState, cid: i64) -> Vec<Message> {
    channel_messages(
        State(state.clone()),
        MaybeAuthed(Some(mem_user("bob", false))),
        HeaderMap::new(),
        Path(cid),
        Query(PageQuery::default()),
    )
    .await
    .expect("page")
    .0
}

async fn dm_page(state: &AppState, dm: i64, who: &str) -> Vec<Message> {
    dm_messages(
        State(state.clone()),
        Path(dm),
        Authed(mem_user(who, false)),
        Query(PageQuery::default()),
    )
    .await
    .expect("page")
    .0
}

async fn switch(state: &AppState, who: &str, on: bool) -> Result<super::SealView, ApiError> {
    update_server(
        State(state.clone()),
        Authed(mem_user(who, false)),
        Path("rchat".to_owned()),
        Json(serde_json::from_value(json!({"seal": on})).expect("patch")),
    )
    .await
    .map(|Json(updated)| updated.server.seal)
}

async fn dm_switch(state: &AppState, dm: i64, who: &str, on: bool) -> Result<(), ApiError> {
    super::put_dm_seal(
        State(state.clone()),
        Authed(mem_user(who, false)),
        Path(dm),
        Json(SealReq { on }),
    )
    .await
    .map(|_| ())
}

async fn users(db: &Db, names: &[&str]) {
    for name in names {
        crate::db::NewUser::plain(name).hash("x").add(db).await;
    }
}

async fn dm_of(state: &AppState, a: &str, b: &str) -> i64 {
    open_dm(
        State(state.clone()),
        Authed(mem_user(a, false)),
        Json(serde_json::from_value(json!({"username": b})).expect("request")),
    )
    .await
    .expect("dm")
    .0
    .id
}

/// The stored form of the message `id`: its plain content and whether it has a record.
async fn stored(db: &Db, id: i64) -> (String, bool) {
    let row = sqlx::query("SELECT content, body IS NOT NULL FROM messages WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("row");
    let sealed = match is_sqlite(db) {
        true => row.try_get::<i64, _>(1).expect("flag") != 0,
        false => row.try_get::<bool, _>(1).expect("flag"),
    };
    (row.try_get(0).expect("content"), sealed)
}

fn reason(result: Result<impl Sized, ApiError>) -> (u16, String, Option<ReasonKind>) {
    match result {
        Ok(_) => (200, String::new(), None),
        Err(ApiError(status, error, reason)) => (status.as_u16(), error, reason.map(|r| r.kind)),
    }
}

async fn storage_rows(db: &Db) -> Vec<(String, String)> {
    sqlx::query_as("SELECT author, content FROM messages WHERE kind = 'storage' ORDER BY id")
        .fetch_all(db)
        .await
        .expect("rows")
}

async fn finish(state: AppState, temp: TempDb) {
    temp.done(state).await;
}

#[tokio::test]
async fn messages_follow_the_switch_from_its_commit() {
    for (state, temp) in each_db_keyed("seal_switch").await {
        let db = &state.db;
        let cid = staffed(db).await;
        let before = say(&state, cid, "bob", "before the switch").await;
        assert_eq!(
            stored(db, before.id).await,
            ("before the switch".into(), false)
        );

        assert_eq!(
            reason(switch(&state, "bob", true).await).0,
            403,
            "a member without Manage server"
        );
        let view = switch(&state, "alice", true).await.expect("on");
        assert!(view.on && !view.forced && view.own && !view.server_forced);
        let during = say(&state, cid, "bob", "while it is on").await;
        assert_eq!(during.content, "while it is on");
        assert_eq!(stored(db, during.id).await, (String::new(), true));
        assert!(!stored(db, before.id).await.1, "earlier rows stay plain");
        let poll = send(
            &state,
            cid,
            "bob",
            json!({"content": "", "poll": {"kind": "single", "question": "Which one", "options": [{"text": "Left"}, {"text": "Right"}]}}),
        )
        .await;
        let (question, sealed): (String, i64) = sqlx::query_as(
            "SELECT question, CASE WHEN body IS NULL THEN 0 ELSE 1 END FROM polls WHERE message_id = $1",
        )
        .bind(poll.id)
        .fetch_one(db)
        .await
        .expect("poll");
        assert_eq!((question.as_str(), sealed), ("", 1));
        let plain_options: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM poll_options WHERE message_id = $1 AND (text <> '' OR body IS NULL)",
        )
        .bind(poll.id)
        .fetch_one(db)
        .await
        .expect("options");
        assert_eq!(plain_options, 0);
        let reply = send(
            &state,
            cid,
            "alice",
            json!({"content": "an answer", "reply_to": during.id}),
        )
        .await;
        let edited = edit(&state, before.id, "bob", "before, edited while on").await;
        assert_eq!(edited.content, "before, edited while on");
        assert_eq!(
            stored(db, before.id).await,
            (String::new(), true),
            "an edit follows the state"
        );

        let listed = page(&state, cid).await;
        let text = |id: i64| {
            listed
                .iter()
                .find(|m| m.id == id)
                .map(|m| m.content.clone())
        };
        assert_eq!(text(during.id).as_deref(), Some("while it is on"));
        assert_eq!(text(before.id).as_deref(), Some("before, edited while on"));
        let shown = listed.iter().find(|m| m.id == poll.id).expect("poll");
        let shown_poll = shown.poll.as_ref().expect("poll view");
        assert_eq!(shown.content, "Which one");
        assert_eq!(shown_poll.question, "Which one");
        assert_eq!(
            shown_poll
                .options
                .iter()
                .map(|o| o.text.as_str())
                .collect::<Vec<_>>(),
            ["Left", "Right"]
        );
        let quote = listed
            .iter()
            .find(|m| m.id == reply.id)
            .and_then(|m| m.reply_to.clone())
            .expect("quote");
        assert_eq!(quote.content, "while it is on");
        assert!(listed.iter().all(|m| !m.unreadable));

        let view = switch(&state, "alice", false).await.expect("off");
        assert!(!view.on);
        let after = say(&state, cid, "bob", "after it is off").await;
        assert_eq!(
            stored(db, after.id).await,
            ("after it is off".into(), false)
        );
        assert_eq!(
            stored(db, during.id).await,
            (String::new(), true),
            "sealed rows stay sealed"
        );
        let listed = page(&state, cid).await;
        assert!(
            listed
                .iter()
                .any(|m| m.id == during.id && m.content == "while it is on")
        );
        let edited = edit(&state, during.id, "bob", "edited after it is off").await;
        assert_eq!(edited.content, "edited after it is off");
        assert_eq!(
            stored(db, during.id).await,
            ("edited after it is off".into(), false)
        );
        assert_eq!(
            storage_rows(db).await,
            [
                ("alice".into(), "on".into()),
                ("alice".into(), "off".into())
            ]
        );
        let (seal, since): (i64, Option<i64>) =
            sqlx::query_as("SELECT seal, seal_since FROM servers WHERE name = 'rchat'")
                .fetch_one(db)
                .await
                .expect("server");
        assert!(
            seal == 0 && since.is_some(),
            "the first time stays recorded"
        );
        let keks: Vec<String> =
            sqlx::query_scalar("SELECT kek FROM data_keys WHERE purpose = 'content'")
                .fetch_all(db)
                .await
                .expect("keys");
        assert_eq!(keks, ["k1"]);
        finish(state, temp).await;
    }
}

#[tokio::test]
async fn every_change_posts_a_system_message_at_once() {
    for (state, temp) in each_db_keyed("seal_notices").await {
        let db = &state.db;
        let cid = staffed(db).await;
        let mut rx = state.hub.subscribe();
        for on in [true, false, true, false, true] {
            switch(&state, "alice", on).await.expect("switch");
        }
        assert!(switch(&state, "alice", true).await.expect("same").on);
        let rows = storage_rows(db).await;
        assert_eq!(
            rows.iter()
                .map(|(_, word)| word.as_str())
                .collect::<Vec<_>>(),
            ["on", "off", "on", "off", "on"],
            "one per change, none for a request that changes nothing"
        );
        let in_general: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages WHERE kind = 'storage' AND channel_id = $1",
        )
        .bind(cid)
        .fetch_one(db)
        .await
        .expect("count");
        assert_eq!(in_general, 5);
        let (mut notices, mut updates) = (0, 0);
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::Message { message, .. } if message.kind == "storage" => notices += 1,
                WsEvent::ServerUpdated { server } => {
                    updates += 1;
                    assert_eq!(server.name, "rchat");
                }
                _ => {}
            }
        }
        assert_eq!((notices, updates), (5, 6));
        let shown = page(&state, cid).await;
        let last = shown.last().expect("notice");
        assert_eq!(
            (
                last.kind.as_str(),
                last.content.as_str(),
                last.author.username.as_str()
            ),
            ("storage", "on", "alice")
        );
        finish(state, temp).await;
    }
}

#[tokio::test]
async fn either_participant_switches_a_dm_and_only_they_hear_of_it() {
    for (state, temp) in each_db_keyed("seal_dm").await {
        let db = &state.db;
        users(db, &["alice", "bob", "carol"]).await;
        let dm = dm_of(&state, "alice", "bob").await;
        let plain = dm_say(&state, dm, "alice", "plain").await.expect("send");
        assert_eq!(reason(dm_switch(&state, dm, "carol", true).await).0, 404);
        let mut rx = state.hub.subscribe();
        dm_switch(&state, dm, "bob", true)
            .await
            .expect("bob turns it on");
        let sealed = dm_say(&state, dm, "alice", "sealed").await.expect("send");
        assert_eq!(stored(db, sealed.id).await, (String::new(), true));
        assert_eq!(stored(db, plain.id).await, ("plain".into(), false));
        let mut heard = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::DmUpdated {
                dm_id,
                dm_users,
                seal,
            } = &ev
            {
                heard.push((*dm_id, dm_users.clone(), *seal));
            }
        }
        assert_eq!(heard.len(), 1);
        assert_eq!(heard[0].0, dm);
        assert!(heard[0].2.on && !heard[0].2.forced);
        let mut pair = heard[0].1.clone();
        pair.sort();
        assert_eq!(pair, ["alice", "bob"]);
        dm_switch(&state, dm, "alice", false)
            .await
            .expect("alice turns it off");
        let again = dm_say(&state, dm, "bob", "plain again")
            .await
            .expect("send");
        assert_eq!(stored(db, again.id).await, ("plain again".into(), false));
        let shown = dm_page(&state, dm, "bob").await;
        assert_eq!(
            shown
                .iter()
                .map(|m| (m.kind.as_str(), m.content.as_str()))
                .collect::<Vec<_>>(),
            [
                ("user", "plain"),
                ("storage", "on"),
                ("user", "sealed"),
                ("storage", "off"),
                ("user", "plain again")
            ]
        );
        let listed = crate::api::dms::dms_by_ids(db, "alice", &[dm])
            .await
            .expect("list");
        assert!(!listed[0].seal.on);
        finish(state, temp).await;
    }
}

#[tokio::test]
async fn a_requirement_locks_the_switch_and_never_changes_it() {
    for (state, temp) in each_db_keyed("seal_forced").await {
        let db = &state.db;
        let cid = staffed(db).await;
        users(db, &["alice", "bob"]).await;
        let dm = dm_of(&state, "alice", "bob").await;
        let root = || Authed(mem_user("root", true));
        let hidden = super::put_server_forced(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("rchat".to_owned()),
            Json(RequireReq { on: true }),
        )
        .await;
        assert_eq!(reason(hidden).0, 404);
        let view = super::put_server_forced(
            State(state.clone()),
            root(),
            Path("rchat".to_owned()),
            Json(RequireReq { on: true }),
        )
        .await
        .expect("force")
        .0;
        assert!(view.on && view.forced && view.server_forced && !view.own);
        assert_eq!(
            reason(switch(&state, "alice", false).await),
            (403, FORCED.into(), Some(ReasonKind::Forced))
        );
        let sealed = say(&state, cid, "bob", "required").await;
        assert_eq!(stored(db, sealed.id).await, (String::new(), true));
        let plain_dm = dm_say(&state, dm, "alice", "a server's rule is not a DM's")
            .await
            .expect("dm");
        assert!(!stored(db, plain_dm.id).await.1);
        let switch_value: i64 = sqlx::query_scalar("SELECT seal FROM servers WHERE name = 'rchat'")
            .fetch_one(db)
            .await
            .expect("seal");
        assert_eq!(switch_value, 0, "the stored switch is untouched");
        let _ = super::put_server_forced(
            State(state.clone()),
            root(),
            Path("rchat".to_owned()),
            Json(RequireReq { on: false }),
        )
        .await
        .expect("lift");
        let plain = say(&state, cid, "bob", "free again").await;
        assert_eq!(stored(db, plain.id).await, ("free again".into(), false));
        assert_eq!(
            storage_rows(db).await,
            [
                (String::new(), "forced".into()),
                (String::new(), "unforced".into())
            ]
        );

        let required =
            super::put_required(State(state.clone()), root(), Json(RequireReq { on: true }))
                .await
                .expect("site")
                .0;
        assert!(required.on && !required.pinned);
        assert!(
            crate::api::PublicSettings::load(db)
                .await
                .encryption_required
        );
        let everywhere = say(&state, cid, "bob", "site rule").await;
        assert!(stored(db, everywhere.id).await.1);
        let in_dm = dm_say(&state, dm, "alice", "site rule in a DM")
            .await
            .expect("dm");
        assert!(stored(db, in_dm.id).await.1);
        assert_eq!(
            reason(dm_switch(&state, dm, "bob", false).await),
            (403, FORCED.into(), Some(ReasonKind::Forced))
        );
        assert_eq!(reason(switch(&state, "alice", false).await).0, 403);
        let lite = crate::api::access::ws_server_lite(db, "rchat")
            .await
            .expect("lite")
            .expect("server");
        assert!(lite.seal.on && lite.seal.forced);
        assert!(
            !lite.seal.own && !lite.seal.server_forced,
            "the site's part is in the settings"
        );
        let _ = super::put_required(State(state.clone()), root(), Json(RequireReq { on: false }))
            .await
            .expect("site off");
        let site: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(SITE_FROM)
            .fetch_optional(db)
            .await
            .expect("setting");
        assert_eq!(site, None);
        let free = dm_say(&state, dm, "alice", "plain").await.expect("dm");
        assert!(!stored(db, free.id).await.1);
        assert_eq!(
            dm_page(&state, dm, "bob")
                .await
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            [
                "a server's rule is not a DM's",
                "site rule in a DM",
                "plain"
            ]
        );
        finish(state, temp).await;
    }
}

#[tokio::test]
async fn a_switch_needs_a_key_every_copy_holds() {
    let (state, path) = temp_state("seal_no_key").await;
    let db = &state.db;
    if !crate::db::ring(db).ready() {
        staffed(db).await;
        users(db, &["alice", "bob"]).await;
        let dm = dm_of(&state, "alice", "bob").await;
        let needs = (409, NEEDS_KEY.to_owned(), Some(ReasonKind::Keys));
        assert_eq!(
            crate::api::PublicSettings::load(db).await.encryption_ready,
            "keys",
            "members see it before a switch is refused"
        );
        assert_eq!(reason(switch(&state, "alice", true).await), needs);
        assert_eq!(reason(dm_switch(&state, dm, "bob", true).await), needs);
        let required = super::put_required(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Json(RequireReq { on: true }),
        )
        .await;
        assert_eq!(reason(required), needs);
        assert!(
            !switch(&state, "alice", false)
                .await
                .expect("off is always allowed")
                .on
        );
        assert!(storage_rows(db).await.is_empty());
    }
    done(state, path).await;

    for (state, temp) in each_db_keyed("seal_copies").await {
        let db = &state.db;
        if is_sqlite(db) {
            finish(state, temp).await;
            continue;
        }
        staffed(db).await;
        let root = || Authed(mem_user("root", true));
        let _ = super::put_copies(
            State(state.clone()),
            root(),
            Json(CopiesReq { confirmed: false }),
        )
        .await
        .expect("unconfirm");
        let ready = || async { crate::api::PublicSettings::load(db).await.encryption_ready };
        assert_eq!(ready().await, "updating");
        assert_eq!(
            reason(switch(&state, "alice", true).await),
            (409, UPDATING.to_owned(), Some(ReasonKind::Keys))
        );
        let hidden = super::put_copies(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Json(CopiesReq { confirmed: true }),
        )
        .await;
        assert_eq!(reason(hidden).0, 404);
        let _ = super::put_copies(
            State(state.clone()),
            root(),
            Json(CopiesReq { confirmed: true }),
        )
        .await
        .expect("confirm");
        assert_eq!(ready().await, "ready");
        let build: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(COPIES)
            .fetch_one(db)
            .await
            .expect("build");
        assert_eq!(build, env!("CARGO_PKG_VERSION"));
        assert!(switch(&state, "alice", true).await.expect("on").on);
        finish(state, temp).await;
    }
}

#[tokio::test]
async fn the_first_switch_makes_the_key_file_beside_the_database() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    use crate::crypt::ring::{KeyConfig, Ring};

    let path = crate::db::temp_db_path("seal_first_need");
    let keys = std::path::PathBuf::from(format!("{}.keys", path.display()));
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&keys);
    let ring = Arc::new(Ring::load(&KeyConfig::default(), path.to_str()).expect("ring"));
    let opts = crate::db::DbOptions {
        ring: Some(ring),
        ..crate::config::AppConfig::from_map(&[])
            .expect("config")
            .db_options()
    };
    let db = crate::db::open_with(path.to_str(), &opts)
        .await
        .expect("open");
    let instance = crate::instance::Instance::load(&db, &Default::default())
        .await
        .expect("instance");
    let state = AppState::new(db, crate::ws::Hub::new(), None, None, instance);
    let db = &state.db;
    let cid = staffed(db).await;
    assert!(!keys.exists());
    assert!(switch(&state, "alice", true).await.expect("on").on);
    let mode = std::fs::metadata(&keys)
        .expect("key file")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    let secret = std::fs::read_to_string(&keys).expect("keys");
    let secret = secret.trim().split_once(':').expect("id:key").1.to_owned();
    let sent = say(&state, cid, "bob", "sealed with the new key").await;
    assert_eq!(stored(db, sent.id).await, (String::new(), true));
    let settings: Vec<String> = sqlx::query_scalar("SELECT value FROM settings")
        .fetch_all(db)
        .await
        .expect("settings");
    let wrapped: Vec<String> = sqlx::query_scalar("SELECT wrapped FROM data_keys")
        .fetch_all(db)
        .await
        .expect("keys");
    assert!(
        settings
            .iter()
            .chain(&wrapped)
            .all(|v| !v.contains(&secret)),
        "the key never reaches the database"
    );
    assert_eq!(
        page(&state, cid).await.last().expect("message").content,
        "sealed with the new key"
    );
    let _ = std::fs::remove_file(&keys);
    done(state, path).await;
}

#[tokio::test]
async fn the_sweep_seals_what_a_sealed_place_got_stored_plain() {
    for (state, temp) in each_db_keyed("seal_sweep").await {
        let db = &state.db;
        let cid = staffed(db).await;
        let old = now() - 3600;
        let raw = |text: &'static str| async move {
            sqlx::query_scalar::<_, i64>("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'bob', $2, 'f00d', 'notes.txt', $3) RETURNING id")
                .bind(cid)
                .bind(text)
                .bind(old)
                .fetch_one(db)
                .await
                .expect("row")
        };
        let earlier = raw("written before the switch").await;
        assert_eq!(super::sweep(db).await.expect("idle"), 0);
        switch(&state, "alice", true).await.expect("on");
        let stray = raw("written plain by another copy").await;
        let young: i64 = sqlx::query_scalar("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'bob', 'too young to judge', $2) RETURNING id")
            .bind(cid)
            .bind(now())
            .fetch_one(db)
            .await
            .expect("row");
        let read = |id: i64| {
            let state = state.clone();
            async move {
                page(&state, cid)
                    .await
                    .into_iter()
                    .find(|m| m.id == id)
                    .expect("listed")
            }
        };
        assert_eq!(read(stray).await.content, "written plain by another copy");
        assert_eq!(super::sweep(db).await.expect("sweep"), 1);
        assert_eq!(stored(db, stray).await, (String::new(), true));
        assert!(!stored(db, earlier).await.1);
        assert!(!stored(db, young).await.1);
        let name: Option<String> =
            sqlx::query_scalar("SELECT media_filename FROM messages WHERE id = $1")
                .bind(stray)
                .fetch_one(db)
                .await
                .expect("name");
        assert_eq!(name.as_deref(), Some(""), "the file name is in the record");
        let shown = read(stray).await;
        assert_eq!(shown.content, "written plain by another copy");
        assert_eq!(super::sweep(db).await.expect("again"), 0);
        assert!(
            super::sweep::seal_row(db, young, false)
                .await
                .expect("one row")
        );
        assert!(
            !super::sweep::seal_row(db, earlier, false)
                .await
                .expect("before the switch")
        );
        finish(state, temp).await;
    }
}

#[tokio::test]
async fn a_damaged_record_is_one_unreadable_message() {
    for (state, temp) in each_db_keyed("seal_damaged").await {
        let db = &state.db;
        let cid = staffed(db).await;
        switch(&state, "alice", true).await.expect("on");
        let good = say(&state, cid, "bob", "opens").await;
        let bad = say(&state, cid, "bob", "damaged").await;
        let moved = say(&state, cid, "bob", "moved").await;
        let mut record: Vec<u8> = sqlx::query_scalar("SELECT body FROM messages WHERE id = $1")
            .bind(bad.id)
            .fetch_one(db)
            .await
            .expect("record");
        let last = record.len() - 1;
        record[last] ^= 1;
        sqlx::query("UPDATE messages SET body = $1 WHERE id = $2")
            .bind(record)
            .bind(bad.id)
            .execute(db)
            .await
            .expect("damage");
        sqlx::query(
            "UPDATE messages SET body = (SELECT body FROM messages WHERE id = $1) WHERE id = $2",
        )
        .bind(good.id)
        .bind(moved.id)
        .execute(db)
        .await
        .expect("swap");
        let before = crate::db::ring(db).unreadable();
        let shown = page(&state, cid).await;
        let of = |id: i64| shown.iter().find(|m| m.id == id).expect("listed");
        assert_eq!(
            (of(good.id).content.as_str(), of(good.id).unreadable),
            ("opens", false)
        );
        for id in [bad.id, moved.id] {
            assert_eq!((of(id).content.as_str(), of(id).unreadable), ("", true));
        }
        assert_eq!(crate::db::ring(db).unreadable() - before, 2);
        let refused = edit_message(
            State(state.clone()),
            Path(bad.id),
            Authed(mem_user("bob", false)),
            Json(serde_json::from_value::<EditReq>(json!({"content": "x"})).expect("request")),
        )
        .await;
        assert_eq!(reason(refused).0, 400);
        let sent = serde_json::to_value(of(good.id)).expect("json");
        assert!(sent.get("unreadable").is_none(), "left out when it opens");
        assert_eq!(
            serde_json::to_value(of(bad.id)).expect("json")["unreadable"],
            json!(true)
        );
        finish(state, temp).await;
    }
}

/// A state on a new pool of the database of `temp`, with a ring of its own that holds the same
/// root key, as another copy or the next start opens it.
async fn reopened(temp: &TempDb) -> AppState {
    let db = crate::db::open_keyed(Some(&temp.url()))
        .await
        .expect("reopen");
    let instance = crate::instance::Instance::load(&db, &Default::default())
        .await
        .expect("instance");
    AppState::new(db, crate::ws::Hub::new(), None, None, instance)
}

#[tokio::test]
async fn a_write_that_fails_leaves_the_content_key_it_reads() {
    for (state, temp) in each_db_keyed("seal_rolled_back").await {
        let db = &state.db;
        let cid = staffed(db).await;
        switch(&state, "alice", true).await.expect("on");
        let content_keys = || async {
            sqlx::query_scalar::<_, i64>("SELECT id FROM data_keys WHERE purpose = 'content'")
                .fetch_all(db)
                .await
                .expect("keys")
        };
        let made = content_keys().await;
        assert_eq!(made.len(), 1, "the switch makes the key before it turns on");
        let refused = send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user("bob", false)),
            Json(
                serde_json::from_value(json!({"content": "x", "media_id": "nope"}))
                    .expect("request"),
            ),
        )
        .await;
        assert_eq!(reason(refused).0, 400);
        let sent = say(&state, cid, "bob", "secret one").await;
        let record: Vec<u8> = sqlx::query_scalar("SELECT body FROM messages WHERE id = $1")
            .bind(sent.id)
            .fetch_one(db)
            .await
            .expect("record");
        let key_id = crate::crypt::header(&record).expect("header").key_id;
        assert_eq!(made, [i64::from(key_id)]);
        assert_eq!(content_keys().await, made);

        let other = reopened(&temp).await;
        crate::db::ring(&other.db).forget_data_keys();
        let refused = send_channel_message(
            State(other.clone()),
            Path(cid),
            Authed(mem_user("bob", false)),
            Json(
                serde_json::from_value(json!({"content": "y", "media_id": "nope"}))
                    .expect("request"),
            ),
        )
        .await;
        assert_eq!(reason(refused).0, 400);
        let next = say(&other, cid, "bob", "secret two").await;
        crate::db::close(&other.db).await;

        let fresh = reopened(&temp).await;
        let shown = page(&fresh, cid).await;
        for (id, text) in [(sent.id, "secret one"), (next.id, "secret two")] {
            let m = shown.iter().find(|m| m.id == id).expect("listed");
            assert_eq!((m.content.as_str(), m.unreadable), (text, false));
        }
        assert_eq!(content_keys().await, made);
        crate::db::close(&fresh.db).await;
        finish(state, temp).await;
    }
}

#[tokio::test]
async fn a_block_refuses_the_dm_switch_like_a_message() {
    for (state, temp) in each_db_keyed("seal_dm_blocked").await {
        let db = &state.db;
        users(db, &["alice", "bob"]).await;
        let dm = dm_of(&state, "alice", "bob").await;
        sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES('bob', 'alice', 1)")
            .execute(db)
            .await
            .expect("block");
        for who in ["alice", "bob"] {
            let sent = reason(dm_say(&state, dm, who, "hello").await);
            assert_eq!(sent.0, 403, "{who}");
            for on in [true, false, true] {
                assert_eq!(reason(dm_switch(&state, dm, who, on).await), sent, "{who}");
            }
        }
        assert!(storage_rows(db).await.is_empty());
        let seal: i64 = sqlx::query_scalar("SELECT seal FROM dms WHERE id = $1")
            .bind(dm)
            .fetch_one(db)
            .await
            .expect("dm");
        assert_eq!(seal, 0);
        sqlx::query("DELETE FROM blocks")
            .execute(db)
            .await
            .expect("unblock");
        dm_switch(&state, dm, "alice", true)
            .await
            .expect("on once nobody blocks");
        assert_eq!(
            storage_rows(db).await,
            [("alice".to_owned(), "on".to_owned())]
        );
        finish(state, temp).await;
    }
}

mod copies;
