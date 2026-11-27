use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::Row;

use super::*;
use crate::api::messages::{edit_message, send_channel_message};
use crate::api::test_util::{add_member, each_db, each_db_keyed, mem_user, profanity_on};
use crate::api::{Authed, Message};
use crate::db::NewUser;
use crate::state::AppState;

async fn general(db: &Db) -> i64 {
    sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
        .fetch_one(db)
        .await
        .expect("general")
        .try_get(0)
        .expect("id")
}

async fn send(
    state: &AppState,
    cid: i64,
    who: &str,
    body: Value,
) -> Result<Message, (StatusCode, String)> {
    send_channel_message(
        State(state.clone()),
        Path(cid),
        Authed(mem_user(who, false)),
        Json(serde_json::from_value(body).expect("body")),
    )
    .await
    .map(|Json(m)| m)
    .map_err(|ApiError(code, text, _)| (code, text))
}

async fn edit(
    state: &AppState,
    id: i64,
    who: &str,
    body: Value,
) -> Result<Message, (StatusCode, String)> {
    edit_message(
        State(state.clone()),
        Path(id),
        Authed(mem_user(who, false)),
        Json(serde_json::from_value(body).expect("body")),
    )
    .await
    .map(|Json(m)| m)
    .map_err(|ApiError(code, text, _)| (code, text))
}

async fn stored(db: &Db, id: i64) -> Option<String> {
    sqlx::query("SELECT media_alt FROM messages WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("message")
        .try_get(0)
        .expect("alt")
}

fn picture(id: &str, alt: Option<&str>) -> Value {
    let mut body = json!({
        "content": "",
        "p2p": {
            "filename": "cat.png",
            "size": 10,
            "mime": "image/png",
            "p2p_id": id,
        },
    });
    if let Some(alt) = alt {
        body["media_alt"] = json!(alt);
    }
    body
}

fn alt_of(m: &Message) -> Option<&str> {
    m.media.as_ref().and_then(|media| media.alt.as_deref())
}

#[tokio::test]
async fn an_image_keeps_its_description_through_sends_edits_and_reads() {
    for (state, temp) in each_db("alt_text").await {
        let db = &state.db;
        let cid = general(db).await;
        for name in ["alice", "bob"] {
            NewUser::plain(name).add(db).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let sent = send(
            &state,
            cid,
            "alice",
            picture(
                &"ab".repeat(16),
                Some("  A cat\u{0007} asleep\n\n\n\non a mat "),
            ),
        )
        .await
        .expect("send");
        assert_eq!(alt_of(&sent), Some("A cat asleep\n\non a mat"));
        assert_eq!(
            stored(db, sent.id).await.as_deref(),
            Some("A cat asleep\n\non a mat")
        );
        let wire = serde_json::to_value(&sent).expect("json");
        assert_eq!(wire["media"]["alt"], json!("A cat asleep\n\non a mat"));

        let plain = send(&state, cid, "alice", picture(&"cd".repeat(16), None))
            .await
            .expect("plain");
        assert_eq!(alt_of(&plain), None);
        assert!(
            serde_json::to_value(&plain).expect("json")["media"]
                .get("alt")
                .is_none()
        );
        let blank = send(&state, cid, "alice", picture(&"ce".repeat(16), Some("   ")))
            .await
            .expect("blank");
        assert_eq!(stored(db, blank.id).await, None);

        assert_eq!(
            send(
                &state,
                cid,
                "alice",
                json!({ "content": "hi", "media_alt": "a cat" })
            )
            .await
            .map(|_| ()),
            Err((StatusCode::BAD_REQUEST, NOTHING_TO_DESCRIBE.to_string()))
        );
        let max = "\u{1F431}".repeat(ALT_MAX);
        assert!(
            send(&state, cid, "alice", picture(&"ef".repeat(16), Some(&max)))
                .await
                .is_ok()
        );
        assert_eq!(
            send(
                &state,
                cid,
                "alice",
                picture(&"fa".repeat(16), Some(&format!("{max}x")))
            )
            .await
            .map(|_| ()),
            Err((
                StatusCode::BAD_REQUEST,
                "Image description must be at most 1000 characters".to_string()
            ))
        );

        // The author edits or clears it; the text stays, and nobody else may.
        let changed = edit(
            &state,
            sent.id,
            "alice",
            json!({ "content": "", "media_alt": "A dog" }),
        )
        .await
        .expect("edit");
        assert_eq!(alt_of(&changed), Some("A dog"));
        assert!(changed.edited_at.is_some());
        let kept = edit(
            &state,
            sent.id,
            "alice",
            json!({ "content": "now with words" }),
        )
        .await
        .expect("text only");
        assert_eq!(alt_of(&kept), Some("A dog"), "an edit without it keeps it");
        let cleared = edit(
            &state,
            sent.id,
            "alice",
            json!({ "content": "now with words", "media_alt": null }),
        )
        .await
        .expect("clear");
        assert_eq!(alt_of(&cleared), None);
        assert_eq!(stored(db, sent.id).await, None);
        assert_eq!(
            edit(
                &state,
                sent.id,
                "bob",
                json!({ "content": "x", "media_alt": "mine" })
            )
            .await
            .map(|_| ())
            .map_err(|e| e.0),
            Err(StatusCode::FORBIDDEN)
        );
        let words = send(&state, cid, "alice", json!({ "content": "just words" }))
            .await
            .expect("text");
        assert_eq!(
            edit(
                &state,
                words.id,
                "alice",
                json!({ "content": "just words", "media_alt": "x" })
            )
            .await
            .map(|_| ()),
            Err((StatusCode::BAD_REQUEST, NOTHING_TO_DESCRIBE.to_string()))
        );

        // In a server channel it passes the profanity filter like the message.
        profanity_on(db).await;
        let rude = send(
            &state,
            cid,
            "alice",
            picture(&"fb".repeat(16), Some("what the fuck")),
        )
        .await;
        assert!(matches!(&rude, Err((StatusCode::BAD_REQUEST, m)) if m.contains("profanity")));
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_forward_keeps_the_description_of_a_file_it_carries() {
    for (state, temp) in each_db("alt_text_forward").await {
        let db = &state.db;
        let cid = general(db).await;
        NewUser::plain("alice").add(db).await;
        add_member(db, "rchat", "alice", 0, 0, 1).await;
        sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES('0123456789abcdef0123456789abcdef', 'cat.png', 'image/png', 3, NULL, 'alice', 1)")
            .execute(db)
            .await
            .expect("media");
        let sent = send(
            &state,
            cid,
            "alice",
            json!({ "content": "", "media_id": "0123456789abcdef0123456789abcdef", "media_alt": "A cat" }),
        )
        .await
        .expect("send");
        assert_eq!(alt_of(&sent), Some("A cat"));
        let copy = send(
            &state,
            cid,
            "alice",
            json!({ "content": "", "forward_of": sent.id }),
        )
        .await
        .expect("forward");
        assert_eq!(alt_of(&copy), Some("A cat"));
        assert_eq!(stored(db, copy.id).await.as_deref(), Some("A cat"));
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_removed_file_takes_its_description_along() {
    for (state, temp) in each_db("alt_text_removed").await {
        let db = &state.db;
        let cid = general(db).await;
        NewUser::plain("alice").add(db).await;
        add_member(db, "rchat", "alice", 0, 0, 1).await;
        let sent = send(
            &state,
            cid,
            "alice",
            picture(&"ab".repeat(16), Some("A cat")),
        )
        .await
        .expect("send");
        let _ = crate::api::media::delete_media(
            State(state.clone()),
            Path(sent.id),
            Authed(mem_user("alice", false)),
        )
        .await
        .map_err(|e| e.1)
        .expect("remove");
        assert_eq!(stored(db, sent.id).await, None);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_forward_into_a_filtered_channel_checks_the_description() {
    for (state, temp) in each_db("alt_text_forward_filter").await {
        let db = &state.db;
        let cid = general(db).await;
        NewUser::plain("alice").add(db).await;
        add_member(db, "rchat", "alice", 0, 0, 1).await;
        sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES('0123456789abcdef0123456789abcdef', 'cat.png', 'image/png', 3, NULL, 'alice', 1)")
            .execute(db)
            .await
            .expect("media");
        let sent = send(
            &state,
            cid,
            "alice",
            json!({ "content": "", "media_id": "0123456789abcdef0123456789abcdef", "media_alt": "what the fuck" }),
        )
        .await
        .expect("sent before the filter");
        profanity_on(db).await;
        let copy = send(
            &state,
            cid,
            "alice",
            json!({ "content": "", "forward_of": sent.id }),
        )
        .await;
        assert!(matches!(&copy, Err((StatusCode::BAD_REQUEST, m)) if m.contains("profanity")));
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_description_in_an_encrypted_place_is_kept_in_its_record() {
    for (state, temp) in each_db_keyed("alt_text_sealed").await {
        let db = &state.db;
        let cid = general(db).await;
        NewUser::plain("alice").add(db).await;
        add_member(db, "rchat", "alice", 1, 0, 1).await;
        sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES('0123456789abcdef0123456789abcdef', 'cat.png', 'image/png', 3, NULL, 'alice', 1)")
            .execute(db)
            .await
            .expect("media");
        let switch = |on: bool| {
            crate::api::servers::update_server(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path("rchat".to_owned()),
                Json(serde_json::from_value(json!({ "seal": on })).expect("patch")),
            )
        };
        let _ = switch(true).await.expect("on");
        let sent = send(
            &state,
            cid,
            "alice",
            json!({ "content": "", "media_id": "0123456789abcdef0123456789abcdef", "media_alt": "A cat" }),
        )
        .await
        .expect("send");
        assert_eq!(alt_of(&sent), Some("A cat"));
        assert_eq!(stored(db, sent.id).await, None, "the column stays blank");
        let record = |id: i64| async move {
            sqlx::query("SELECT body FROM messages WHERE id = $1")
                .bind(id)
                .fetch_one(db)
                .await
                .expect("row")
                .try_get::<Option<Vec<u8>>, _>(0)
                .expect("body")
        };
        let body = record(sent.id).await.expect("a record");
        assert!(!String::from_utf8_lossy(&body).contains("cat"));
        let edited = edit(
            &state,
            sent.id,
            "alice",
            json!({ "content": "", "media_alt": "A dog" }),
        )
        .await
        .expect("edit");
        assert_eq!(alt_of(&edited), Some("A dog"));
        assert_eq!(stored(db, sent.id).await, None);
        assert!(!String::from_utf8_lossy(&record(sent.id).await.expect("record")).contains("dog"));
        let kept = edit(
            &state,
            sent.id,
            "alice",
            json!({ "content": "same picture" }),
        )
        .await
        .expect("text edit");
        assert_eq!(
            alt_of(&kept),
            Some("A dog"),
            "a text edit keeps the description"
        );
        let _ = switch(false).await.expect("off");
        let copy = send(
            &state,
            cid,
            "alice",
            json!({ "content": "", "forward_of": sent.id }),
        )
        .await
        .expect("forward");
        assert_eq!(alt_of(&copy), Some("A dog"));
        assert_eq!(stored(db, copy.id).await.as_deref(), Some("A dog"));
        assert_eq!(
            record(copy.id).await,
            None,
            "the copy in a plain place is plain"
        );
        temp.done(state).await;
    }
}
