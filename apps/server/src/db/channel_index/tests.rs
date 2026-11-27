use sqlx::Row;

use super::*;
use crate::api::test_util::{done, temp_state};
use crate::db::{close, open_started};

async fn general_id(db: &Db) -> i64 {
    sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
        .fetch_one(db)
        .await
        .expect("general channel")
        .try_get(0)
        .expect("channel id")
}

async fn channel_with_id(db: &Db, id: i64) {
    sqlx::query("INSERT INTO channels(id, server, name, kind, created_at) VALUES($1, 'rchat', 'c' || $1, 'text', 0)")
        .bind(id)
        .execute(db)
        .await
        .expect("insert channel");
}

async fn post(db: &Db, channel: i64, content: &str) -> i64 {
    sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', $2, 1) RETURNING id")
        .bind(channel)
        .bind(content)
        .fetch_one(db)
        .await
        .expect("insert message")
        .try_get(0)
        .expect("message id")
}

async fn dm_post(db: &Db, content: &str) -> i64 {
    let dm: i64 =
        sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
            .fetch_one(db)
            .await
            .expect("dm")
            .try_get(0)
            .expect("dm id");
    sqlx::query("INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'alice', $2, 1) RETURNING id")
        .bind(dm)
        .bind(content)
        .fetch_one(db)
        .await
        .expect("insert dm message")
        .try_get(0)
        .expect("message id")
}

pub(crate) async fn hits(db: &Db, text: &str, channel: i64) -> Vec<i64> {
    let mut tokenizer = Tokenizer::open().await.unwrap();
    let term = tokenizer
        .terms(&text.chars().take(3).collect::<String>())
        .await
        .unwrap()
        .pop()
        .unwrap();
    let rows = sqlx::query("SELECT p.id,m.content FROM search_streams s JOIN search_postings p ON s.id=p.stream JOIN messages m ON m.id=p.id WHERE s.channel_id=$1 AND p.term IN ($2,$3,'~' || $2,'~' || $3,'') ORDER BY p.id")
        .bind(channel).bind(&term).bind(term_bucket(&term)).fetch_all(db).await.unwrap();
    let phrase = format!("\"{}\"", text.replace('"', "\"\""));
    let mut ids = Vec::new();
    for row in rows {
        let body: String = row.try_get(1).unwrap();
        if tokenizer.matches(&body, &phrase).await.unwrap() {
            ids.push(row.try_get(0).unwrap());
        }
    }
    ids
}

async fn indexed(db: &Db, id: i64) -> bool {
    sqlx::query("SELECT 1 FROM search_documents WHERE id=$1")
        .bind(id)
        .fetch_optional(db)
        .await
        .unwrap()
        .is_some()
}

async fn integrity(db: &Db) {
    let result: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(db)
        .await
        .unwrap();
    assert_eq!(result, "ok");
}

async fn next(db: &Db) -> Option<i64> {
    sqlx::query(
        "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'messages_fts_channel_next'",
    )
    .fetch_optional(db)
    .await
    .expect("build position")
    .map(|r| r.try_get(0).expect("position"))
}

async fn reached(db: &Db) -> Option<i64> {
    stored(&mut db.acquire().await.expect("connection"), DONE)
        .await
        .expect("build position")
}

async fn streams(db: &Db, channel: i64) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM search_streams WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(db)
        .await
        .expect("streams")
}

async fn postings(db: &Db, id: i64) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM search_postings WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("postings")
}

/// The database as a binary without the channel index leaves it.
pub(crate) async fn without_channel_index(db: &Db) {
    for stmt in [
        "DROP TRIGGER search_message_insert",
        "DROP TRIGGER search_root_insert",
        "DROP TRIGGER search_message_delete",
        "DROP TRIGGER search_message_update",
        "DROP TRIGGER search_message_edit",
        "DROP TRIGGER search_message_seal",
        "DROP TABLE search_documents",
        "DROP TABLE search_streams",
        "DROP VIEW search_input",
        "DROP TABLE search_postings",
        "DROP TABLE search_merge",
        "DROP TABLE search_positions",
        "DELETE FROM settings WHERE key IN ('messages_fts_channel_next', 'messages_fts_channel_done')",
    ] {
        sqlx::query(stmt).execute(db).await.expect(stmt);
    }
}

#[tokio::test]
async fn each_channel_finds_its_own_text_and_no_other() {
    let (state, path) = temp_state("channel_index_terms").await;
    let db = &state.db;
    let general = general_id(db).await;
    for id in [655_359, 655_360, 700_000] {
        channel_with_id(db, id).await;
    }
    let mixed = post(db, general, "Weekly NOTES from Zoë").await;
    let last_single = post(db, 655_359, "weekly notes").await;
    let first_pair = post(db, 655_360, "weekly notes").await;
    let quoted = post(db, 700_000, "say \"quoted\" here").await;
    let long = post(
        db,
        general,
        &format!("{}needle{}", "x".repeat(70), "y".repeat(70)),
    )
    .await;
    let odd = post(db, general, "marked \u{40005} and \u{F0001} chars").await;
    let dm = dm_post(db, "weekly notes").await;
    assert_eq!(hits(db, "weekly notes", general).await, [mixed]);
    assert_eq!(hits(db, "WEEKLY notes", general).await, [mixed]);
    assert_eq!(hits(db, "zoë", general).await, [mixed]);
    assert_eq!(hits(db, "ZOË", general).await, [mixed]);
    assert_eq!(hits(db, "weekly notes", 655_359).await, [last_single]);
    assert_eq!(hits(db, "weekly notes", 655_360).await, [first_pair]);
    assert!(hits(db, "weekly notes", 700_000).await.is_empty());
    assert_eq!(hits(db, "\"quoted\"", 700_000).await, [quoted]);
    assert_eq!(hits(db, "xneedley", general).await, [long]);
    assert_eq!(hits(db, &"x".repeat(70), general).await, [long]);
    assert_eq!(hits(db, &"y".repeat(70), general).await, [long]);
    assert_eq!(hits(db, "\u{40005} and \u{F0001}", general).await, [odd]);
    assert!(!indexed(db, dm).await, "DMs are never searched");
    integrity(db).await;
    done(state, path).await;
}

#[tokio::test]
async fn the_index_follows_edits_deletes_and_removed_channels() {
    let (state, path) = temp_state("channel_index_sync").await;
    let db = &state.db;
    let general = general_id(db).await;
    channel_with_id(db, 50).await;
    let sent = post(db, general, "alpha beta").await;
    assert_eq!(hits(db, "beta", general).await, [sent]);
    sqlx::query("UPDATE messages SET content = 'gamma delta' WHERE id = $1")
        .bind(sent)
        .execute(db)
        .await
        .expect("edit");
    assert!(hits(db, "beta", general).await.is_empty());
    assert_eq!(hits(db, "delta", general).await, [sent]);
    sqlx::query("UPDATE messages SET media_removed = 1 WHERE id = $1")
        .bind(sent)
        .execute(db)
        .await
        .expect("unrelated update");
    assert_eq!(hits(db, "delta", general).await, [sent]);
    sqlx::query("UPDATE messages SET channel_id = 50 WHERE id = $1")
        .bind(sent)
        .execute(db)
        .await
        .expect("move");
    assert!(hits(db, "delta", general).await.is_empty());
    assert_eq!(hits(db, "delta", 50).await, [sent]);
    let empty = post(db, general, "").await;
    assert!(
        indexed(db, empty).await,
        "a message without text keeps its place"
    );
    assert_eq!(postings(db, empty).await, 0, "empty text has no terms");
    let before = streams(db, general).await;
    sqlx::query("UPDATE messages SET content = 'now delta too' WHERE id = $1")
        .bind(empty)
        .execute(db)
        .await
        .expect("fill in");
    assert_eq!(hits(db, "delta", general).await, [empty]);
    sqlx::query("UPDATE messages SET author = 'renamed', media_id = 'file' WHERE id = $1")
        .bind(empty)
        .execute(db)
        .await
        .expect("author and attachment");
    assert_eq!(hits(db, "delta", general).await, [empty]);
    assert_eq!(streams(db, general).await, before);
    let root = post(db, general, "root delta").await;
    let reply: i64 = sqlx::query("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES($1, $2, 'alice', 'reply delta', 2) RETURNING id")
        .bind(general)
        .bind(root)
        .fetch_one(db)
        .await
        .expect("reply")
        .try_get(0)
        .expect("reply id");
    assert_eq!(hits(db, "delta", general).await, [empty, root, reply]);
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(root)
        .execute(db)
        .await
        .expect("delete the root and its replies");
    assert_eq!(hits(db, "delta", general).await, [empty]);
    sqlx::query("DELETE FROM channels WHERE id = 50")
        .execute(db)
        .await
        .expect("delete a channel");
    assert!(hits(db, "delta", 50).await.is_empty());
    assert!(!indexed(db, sent).await);
    integrity(db).await;
    done(state, path).await;
}

#[tokio::test]
async fn the_index_is_built_in_batches_and_resumes_after_a_restart() {
    let (state, path) = temp_state("channel_index_build").await;
    let db = state.db.clone();
    assert!(
        has_channel_index(&db).await.expect("readiness"),
        "an empty database starts complete"
    );
    assert_eq!(next(&db).await, Some(0));
    without_channel_index(&db).await;
    let general = general_id(&db).await;
    let mut old = Vec::new();
    for n in 0..30 {
        old.push(post(&db, general, &format!("old note {n}")).await);
    }
    let dm = dm_post(&db, "old note in a dm").await;
    close(&db).await;
    let db = open_started(path.to_str())
        .await
        .expect("start with messages");
    let top = *old.last().expect("old");
    assert!(dm > top);
    assert_eq!(next(&db).await, Some(dm), "every message that exists waits");
    assert!(!has_channel_index(&db).await.expect("readiness"));
    assert!(hits(&db, "old note", general).await.is_empty());
    let fresh = post(&db, general, "new note").await;
    assert_eq!(
        hits(&db, "note", general).await,
        [fresh],
        "new rows go in at once"
    );
    sqlx::query("UPDATE messages SET content = 'edited note' WHERE id = $1")
        .bind(old[3])
        .execute(&db)
        .await
        .expect("edit an old message");
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(old[4])
        .execute(&db)
        .await
        .expect("delete an old message");
    assert_eq!(reached(&db).await, Some(i64::MIN));
    assert!(!build_step(&db, 10).await.expect("first batch"));
    assert_eq!(next(&db).await, Some(dm));
    assert_eq!(reached(&db).await, Some(old[10]));
    assert!(!has_channel_index(&db).await.expect("readiness"));
    close(&db).await;
    let db = open_started(path.to_str())
        .await
        .expect("restart mid-build");
    assert_eq!(
        reached(&db).await,
        Some(old[10]),
        "a restart keeps the position"
    );
    assert!(!has_channel_index(&db).await.expect("readiness"));
    let mut steps = 0;
    while !build_step(&db, 10).await.expect("batch") {
        steps += 1;
        assert!(!has_channel_index(&db).await.expect("readiness"));
        assert!(steps < 10, "the build ends");
    }
    assert!(has_channel_index(&db).await.expect("readiness"));
    assert_eq!(next(&db).await, Some(0));
    assert_eq!(reached(&db).await, Some(i64::MAX));
    let mut want: Vec<i64> = old
        .iter()
        .copied()
        .filter(|id| *id != old[4])
        .chain([fresh])
        .collect();
    want.sort();
    assert_eq!(hits(&db, "note", general).await, want);
    assert_eq!(hits(&db, "edited note", general).await, [old[3]]);
    assert!(hits(&db, "old note 3", general).await.is_empty());
    assert!(!indexed(&db, dm).await);
    assert!(build_step(&db, 10).await.expect("nothing left"));
    integrity(&db).await;
    close(&db).await;
    let db = open_started(path.to_str()).await.expect("restart complete");
    assert!(has_channel_index(&db).await.expect("readiness"));
    close(&db).await;
}

#[tokio::test]
async fn the_background_build_ends_with_its_batches_merged() {
    let (state, path) = temp_state("channel_index_merge").await;
    let db = state.db.clone();
    without_channel_index(&db).await;
    let general = general_id(&db).await;
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, 'alice', 'batch note ' || i || ' 道', i FROM n")
        .bind(general)
        .execute(&db)
        .await
        .expect("messages");
    close(&db).await;
    let db = open_started(path.to_str())
        .await
        .expect("start with messages");
    assert!(!has_channel_index(&db).await.expect("readiness"));
    while !build_step(&db, 32).await.expect("batch") {}
    let pending = |db: Db| async move {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM search_merge")
            .fetch_one(&db)
            .await
            .unwrap()
    };
    assert_eq!(pending(db.clone()).await, 150);
    close(&db).await;
    let db = open_started(path.to_str())
        .await
        .expect("resume maintenance");
    assert!(has_channel_index(&db).await.expect("readiness"));
    assert_eq!(hits(&db, "batch note", general).await.len(), 150);
    build_channel_index(&db).await.expect("merge");
    assert_eq!(pending(db.clone()).await, 0);
    assert_eq!(hits(&db, "batch note", general).await.len(), 150);
    integrity(&db).await;
    close(&db).await;
}

#[tokio::test]
async fn search_distinguishes_literal_private_use_characters() {
    let (state, path) = temp_state("channel_index_unicode").await;
    let db = &state.db;
    let general = general_id(db).await;
    let first = post(db, general, "team \u{f0001} west").await;
    post(db, general, "team \u{f0002} west").await;
    post(db, general, "team \u{fffd} west").await;
    assert_eq!(hits(db, "team \u{f0001} west", general).await, [first]);
    done(state, path).await;
}

#[tokio::test]
async fn embedded_nuls_in_stored_text_follow_the_trigram_tokenizer() {
    let (state, path) = temp_state("channel_index_stored_nul").await;
    let db = &state.db;
    let general = general_id(db).await;
    let id = post(db, general, "weekly\0 notes with literal \\u0000").await;
    for phrase in ["weekly notes", "literal \\u0000"] {
        assert_eq!(hits(db, phrase, general).await, [id]);
    }
    done(state, path).await;
}

#[tokio::test]
async fn interleaved_posts_and_replies_reuse_their_ordered_streams() {
    let (state, path) = temp_state("channel_index_interleaved").await;
    let db = &state.db;
    let channel = general_id(db).await;
    let root = post(db, channel, "thread topic").await;
    for sent in 100..150 {
        for thread in [None, Some(root)] {
            sqlx::query("INSERT INTO messages(channel_id, author, content, created_at, thread_root_id) VALUES($1, 'alice', 'weekly notes', $2, $3)")
                .bind(channel).bind(i64::from(sent)).bind(thread).execute(db).await.expect("post");
        }
    }
    assert_eq!(streams(db, channel).await, 2);
    assert_eq!(hits(db, "weekly notes", channel).await.len(), 100);
    done(state, path).await;
}

#[tokio::test]
async fn the_build_and_live_writes_make_the_same_streams() {
    let (state, path) = temp_state("channel_index_build_streams").await;
    let db = state.db.clone();
    without_channel_index(&db).await;
    let channel = general_id(&db).await;
    let send = "INSERT INTO messages(channel_id, author, content, created_at, thread_root_id) VALUES($1, 'alice', 'weekly notes', $2, $3)";
    let root = post(&db, channel, "thread topic").await;
    for sent in 100..150 {
        for thread in [None, Some(root)] {
            sqlx::query(send)
                .bind(channel)
                .bind(i64::from(sent))
                .bind(thread)
                .execute(&db)
                .await
                .expect("post");
        }
    }
    close(&db).await;
    let db = open_started(path.to_str())
        .await
        .expect("start with messages");
    for sent in 150..160 {
        for thread in [None, Some(root)] {
            sqlx::query(send)
                .bind(channel)
                .bind(i64::from(sent))
                .bind(thread)
                .execute(&db)
                .await
                .expect("post during the build");
        }
        assert!(!build_step(&db, 7).await.expect("batch"));
    }
    assert_eq!(streams(&db, channel).await, 4, "old and new rows apart");
    while !build_step(&db, 7).await.expect("batch") {}
    assert_eq!(streams(&db, channel).await, 4);
    for sent in 160..170 {
        for thread in [None, Some(root)] {
            sqlx::query(send)
                .bind(channel)
                .bind(i64::from(sent))
                .bind(thread)
                .execute(&db)
                .await
                .expect("post after the build");
        }
    }
    assert_eq!(streams(&db, channel).await, 4);
    assert_eq!(hits(&db, "weekly notes", channel).await.len(), 140);
    integrity(&db).await;
    close(&db).await;
}
