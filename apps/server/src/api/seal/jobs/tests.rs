use std::sync::atomic::{AtomicU64, Ordering};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::json;

use super::{
    Direction, JobState, JobsQuery, NewSealJob, SealJob, Target, begin, get_job, list_jobs,
    start_job, step,
};
use crate::api::media::{Charge, save_within};
use crate::api::messages::{
    PageQuery, channel_messages, dm_messages, send_channel_message, send_dm_message,
};
use crate::api::reauth::{AuthedSession, Session};
use crate::api::test_util::{add_member, each_db_keyed, mem_user};
use crate::api::{ApiError, Authed, MaybeAuthed, Message};
use crate::db::{Db, now};
use crate::state::AppState;

const PASSWORD: &str = "correct horse battery staple";

/// A session per confirmation: one session may try once every 3 seconds.
static SESSIONS: AtomicU64 = AtomicU64::new(0);

async fn people(db: &Db) -> i64 {
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
    sqlx::query_scalar("SELECT id FROM channels WHERE server = 'rchat' ORDER BY id LIMIT 1")
        .fetch_one(db)
        .await
        .expect("channel")
}

async fn user(db: &Db, name: &str) -> crate::db::User {
    crate::db::get_user(db, name)
        .await
        .expect("load")
        .expect("user")
}

async fn start(
    state: &AppState,
    who: &str,
    place: &str,
    direction: Direction,
    password: &str,
) -> Result<SealJob, ApiError> {
    let session = Session {
        user: user(&state.db, who).await,
        token: format!("session-{who}-{}", SESSIONS.fetch_add(1, Ordering::Relaxed)),
        created_at: now(),
    };
    let body: NewSealJob = serde_json::from_value(json!({
        "place": place,
        "direction": direction,
        "reauth": {"password": password},
    }))
    .expect("request");
    start_job(State(state.clone()), AuthedSession(session), Json(body))
        .await
        .map(|Json(job)| job)
}

/// Waits until job `id` ended, and answers it.
async fn ended(state: &AppState, id: i64) -> SealJob {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let (job, _) = super::load(&state.db, id)
            .await
            .expect("load")
            .expect("job");
        if job.state != JobState::Running {
            return job;
        }
        assert!(tokio::time::Instant::now() < deadline, "job {id} runs on");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

async fn say(state: &AppState, cid: i64, who: &str, body: serde_json::Value) -> Message {
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

async fn switch(state: &AppState, on: bool) {
    crate::api::servers::update_server(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path("rchat".to_string()),
        Json(serde_json::from_value(json!({"seal": on})).expect("patch")),
    )
    .await
    .map(|_| ())
    .expect("switch");
}

/// How many messages of the channel are stored encrypted and plain, and how many files.
async fn forms(db: &Db, cid: i64) -> (i64, i64, i64, i64) {
    let count = |sql: String| async move {
        sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
            .fetch_one(db)
            .await
            .expect("count")
    };
    (
        count(format!("SELECT COUNT(*) FROM messages WHERE channel_id = {cid} AND kind = 'user' AND body IS NOT NULL AND content = ''")).await,
        count(format!("SELECT COUNT(*) FROM messages WHERE channel_id = {cid} AND kind = 'user' AND body IS NULL")).await,
        count("SELECT COUNT(*) FROM media WHERE seal_key IS NOT NULL AND filename = ''".to_string()).await,
        count("SELECT COUNT(*) FROM media WHERE seal_key IS NULL AND filename <> ''".to_string()).await,
    )
}

#[tokio::test]
async fn earlier_messages_of_a_server_are_encrypted_and_back() {
    for (state, temp) in each_db_keyed("seal_jobs_server").await {
        let db = &state.db;
        let cid = people(db).await;
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let (file, _) = save_within(
            &state,
            "earlier.bin",
            "application/octet-stream",
            &data,
            "bob",
            Charge::own("bob"),
            0,
            None,
        )
        .await
        .expect("upload");
        say(
            &state,
            cid,
            "bob",
            json!({"content": "from before, with a file", "media_id": file}),
        )
        .await;
        say(&state, cid, "alice", json!({"content": "also from before"})).await;
        switch(&state, true).await;
        say(&state, cid, "bob", json!({"content": "while it encrypts"})).await;
        let before = page(&state, cid).await;
        assert_eq!(forms(db, cid).await, (1, 2, 0, 1));

        let refused = |r: Result<SealJob, ApiError>| r.map(|_| ()).map_err(|e| (e.0, e.1));
        assert_eq!(
            refused(start(&state, "bob", "s:rchat", Direction::Seal, PASSWORD).await),
            Err((StatusCode::FORBIDDEN, "Missing permission".to_string()))
        );
        assert_eq!(
            refused(start(&state, "alice", "s:rchat", Direction::Unseal, PASSWORD).await),
            Err((StatusCode::NOT_FOUND, "Not found".to_string())),
            "only the site admin decrypts"
        );
        assert_eq!(
            refused(start(&state, "alice", "s:rchat", Direction::Seal, "wrong").await)
                .map_err(|e| e.0),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            refused(start(&state, "alice", "x:1", Direction::Seal, PASSWORD).await)
                .map_err(|e| e.0),
            Err(StatusCode::BAD_REQUEST)
        );

        let job = start(&state, "alice", "s:rchat", Direction::Seal, PASSWORD)
            .await
            .expect("start");
        assert_eq!(job.place, "s:rchat");
        let done = ended(&state, job.id).await;
        assert_eq!((done.state, done.done), (JobState::Done, done.upto));
        assert_eq!(
            forms(db, cid).await,
            (3, 0, 1, 0),
            "every earlier message and its file encrypted"
        );
        assert_eq!(page(&state, cid).await, before, "and read the same");
        let seen = get_job(
            State(state.clone()),
            Authed(user(db, "alice").await),
            Path(job.id),
        )
        .await
        .expect("get")
        .0;
        assert_eq!(seen, done);
        assert_eq!(
            get_job(
                State(state.clone()),
                Authed(user(db, "bob").await),
                Path(job.id)
            )
            .await
            .map(|_| ())
            .map_err(|e| e.0),
            Err(StatusCode::NOT_FOUND)
        );
        let listed = list_jobs(
            State(state.clone()),
            Authed(user(db, "alice").await),
            Query(JobsQuery {
                place: "s:rchat".to_string(),
            }),
        )
        .await
        .expect("list")
        .0;
        assert_eq!(listed, std::slice::from_ref(&done));

        let back = start(&state, "carol", "s:rchat", Direction::Unseal, PASSWORD)
            .await
            .expect("unseal");
        assert_eq!(ended(&state, back.id).await.state, JobState::Done);
        assert_eq!(
            forms(db, cid).await,
            (0, 3, 0, 1),
            "every message plain again"
        );
        assert_eq!(page(&state, cid).await, before, "and read the same");
        let unsealed = list_jobs(
            State(state.clone()),
            Authed(user(db, "alice").await),
            Query(JobsQuery {
                place: "s:rchat".to_string(),
            }),
        )
        .await
        .expect("list")
        .0;
        assert_eq!(
            unsealed.iter().map(|j| j.direction).collect::<Vec<_>>(),
            [Direction::Seal],
            "a manager sees no decrypting job"
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_dm_job_is_for_its_participants() {
    for (state, temp) in each_db_keyed("seal_jobs_dm").await {
        let db = &state.db;
        people(db).await;
        let dm: i64 = sqlx::query_scalar(
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .fetch_one(db)
        .await
        .expect("dm");
        send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            Json(serde_json::from_value(json!({"content": "a dm from before"})).expect("send")),
        )
        .await
        .map(|_| ())
        .expect("send");
        crate::api::seal::put_dm_seal(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path(dm),
            Json(crate::api::seal::SealReq { on: true }),
        )
        .await
        .map(|_| ())
        .expect("switch");
        let place = format!("d:{dm}");
        assert_eq!(
            start(&state, "carol", &place, Direction::Seal, PASSWORD)
                .await
                .map(|_| ())
                .map_err(|e| e.0),
            Err(StatusCode::NOT_FOUND),
            "someone who is not in the DM, even the site admin, gets the uniform 404"
        );
        let job = start(&state, "bob", &place, Direction::Seal, PASSWORD)
            .await
            .expect("start");
        assert_eq!(ended(&state, job.id).await.state, JobState::Done);
        let shown = dm_messages(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            Query(PageQuery::default()),
        )
        .await
        .expect("page")
        .0;
        assert!(shown.iter().any(|m| m.content == "a dm from before"));
        let stored: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages WHERE dm_id = $1 AND kind = 'user' AND body IS NOT NULL AND content = ''",
        )
        .bind(dm)
        .fetch_one(db)
        .await
        .expect("count");
        assert_eq!(stored, 1);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_job_over_every_place_covers_bios_and_its_way_back_the_copies() {
    for (state, temp) in each_db_keyed("seal_jobs_site").await {
        let db = &state.db;
        let cid = people(db).await;
        sqlx::query("UPDATE users SET bio = 'about bob' WHERE username = 'bob'")
            .execute(db)
            .await
            .expect("bio");
        say(
            &state,
            cid,
            "bob",
            json!({"content": "before the site required it"}),
        )
        .await;
        crate::api::seal::put_required(
            State(state.clone()),
            Authed(user(db, "carol").await),
            Json(crate::api::seal::RequireReq { on: true }),
        )
        .await
        .map(|_| ())
        .expect("require");
        crate::api::auth::patch_me(
            State(state.clone()),
            Authed(user(db, "alice").await),
            Json(serde_json::from_value(json!({"bio": "about alice"})).expect("patch")),
        )
        .await
        .map(|_| ())
        .expect("alice's bio");
        assert_eq!(
            start(&state, "alice", "*", Direction::Seal, PASSWORD)
                .await
                .map(|_| ())
                .map_err(|e| e.0),
            Err(StatusCode::NOT_FOUND),
            "only the site admin runs a job over every place"
        );
        let job = start(&state, "carol", "*", Direction::Seal, PASSWORD)
            .await
            .expect("start");
        assert_eq!(ended(&state, job.id).await.state, JobState::Done);
        let bob = user(db, "bob").await;
        assert_eq!(bob.bio, None, "bob's earlier bio is stored encrypted");
        assert!(bob.bio_sealed.is_some());
        assert_eq!(
            crate::crypt::copies::bio_of(db, &bob)
                .await
                .expect("bio")
                .as_deref(),
            Some("about bob")
        );
        let plain: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND kind = 'user' AND body IS NULL",
        )
        .bind(cid)
        .fetch_one(db)
        .await
        .expect("count");
        assert_eq!(plain, 0, "the earlier message too");

        let back = start(&state, "carol", "*", Direction::Unseal, PASSWORD)
            .await
            .expect("unseal");
        assert_eq!(ended(&state, back.id).await.state, JobState::Done);
        for (name, bio) in [("alice", "about alice"), ("bob", "about bob")] {
            let u = user(db, name).await;
            assert_eq!(
                (u.bio.as_deref(), u.bio_sealed.is_none()),
                (Some(bio), true)
            );
        }
        let sealed_left: i64 = sqlx::query_scalar(
            "SELECT (SELECT COUNT(*) FROM messages WHERE body IS NOT NULL) + (SELECT COUNT(*) FROM users WHERE bio_sealed IS NOT NULL)",
        )
        .fetch_one(db)
        .await
        .expect("count");
        assert_eq!(sealed_left, 0, "nothing encrypted is left");
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_job_goes_on_from_where_it_stopped() {
    for (state, temp) in each_db_keyed("seal_jobs_resume").await {
        let db = &state.db;
        let cid = people(db).await;
        let first = say(&state, cid, "bob", json!({"content": "one"})).await;
        let second = say(&state, cid, "bob", json!({"content": "two"})).await;
        switch(&state, true).await;
        let job = begin(
            &state,
            &Target::Server("rchat".into()),
            Direction::Seal,
            Some("alice"),
        )
        .await
        .expect("begin");
        let first_id: i64 = sqlx::query_scalar(
            "SELECT MIN(id) FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server = 'rchat')",
        )
        .fetch_one(db)
        .await
        .expect("first");
        assert_eq!(
            job.from,
            first_id - 1,
            "it starts before the place's first message"
        );
        assert_eq!(
            begin(
                &state,
                &Target::Server("rchat".into()),
                Direction::Seal,
                Some("alice")
            )
            .await
            .expect("again")
            .id,
            job.id,
            "one running job per place and direction"
        );
        sqlx::query("UPDATE seal_jobs SET done_id = $1 WHERE id = $2")
            .bind(first.id)
            .bind(job.id)
            .execute(db)
            .await
            .expect("as a stopped job left it");
        assert!(super::hold(db, job.id).await.expect("hold"));
        assert!(!step(&state, job.id).await.expect("step"));
        let forms: Vec<(i64, bool)> = sqlx::query_as(
            "SELECT id, CASE WHEN body IS NULL THEN 0 ELSE 1 END FROM messages WHERE id IN ($1, $2) ORDER BY id",
        )
        .bind(first.id)
        .bind(second.id)
        .fetch_all(db)
        .await
        .expect("rows")
        .into_iter()
        .map(|(id, sealed): (i64, i64)| (id, sealed == 1))
        .collect();
        assert_eq!(forms, [(first.id, false), (second.id, true)]);
        let (ended, _) = super::load(db, job.id).await.expect("load").expect("job");
        assert_eq!((ended.state, ended.from), (JobState::Done, 0));
        temp.done(state).await;
    }
}

#[tokio::test]
async fn the_command_line_decrypts_a_server_and_compacts_the_file() {
    let path = crate::db::temp_db_path("seal_jobs_cli");
    let _ = std::fs::remove_file(&path);
    let url = path.display().to_string();
    let keys = crate::crypt::Kek::generate("k1").encoded().to_string();
    let config = crate::config::AppConfig::from_map(&[
        ("DATABASE_URL", url.as_str()),
        ("ENCRYPTION_KEYS", keys.as_str()),
    ])
    .expect("config");
    let opts = crate::db::DbOptions {
        ring: Some(std::sync::Arc::new(
            crate::crypt::ring::Ring::load(&config.encryption, Some(&url)).expect("ring"),
        )),
        ..config.db_options()
    };
    let db = crate::db::open_with(Some(&url), &opts).await.expect("open");
    let instance = crate::instance::Instance::load(&db, &config.instance())
        .await
        .expect("instance");
    let state = AppState::new(db, crate::ws::Hub::new(), None, None, instance);
    let cid = people(&state.db).await;
    switch(&state, true).await;
    let sealed = say(
        &state,
        cid,
        "bob",
        json!({"content": "kept by the command line"}),
    )
    .await;
    let stored = |db: Db| async move {
        sqlx::query_as::<_, (String, Option<Vec<u8>>)>(
            "SELECT content, body FROM messages WHERE id = $1",
        )
        .bind(sealed.id)
        .fetch_one(&db)
        .await
        .expect("row")
    };
    assert!(stored(state.db.clone()).await.1.is_some());
    crate::db::close(&state.db).await;
    let out = crate::crypt::cli::run(
        &config,
        crate::crypt::cli::KeysCommand::Unseal {
            server: Some("RChat".to_string()),
            dm: None,
        },
    )
    .await
    .expect("unseal");
    assert!(out.contains("s:rchat"), "{out}");
    let compacted = crate::db::cli::run(&config, crate::db::cli::DbCommand::Compact)
        .await
        .expect("compact");
    assert!(compacted.starts_with("Compacted"), "{compacted}");
    let db = crate::db::open_with(Some(&url), &opts)
        .await
        .expect("reopen");
    assert_eq!(
        stored(db.clone()).await,
        ("kept by the command line".to_string(), None)
    );
    crate::db::close(&db).await;
    let _ = std::fs::remove_file(&path);
    let postgres = crate::config::AppConfig::from_map(&[(
        "DATABASE_URL",
        "postgres://nobody@127.0.0.1:1/none",
    )])
    .expect("config");
    let refused = crate::db::cli::run(&postgres, crate::db::cli::DbCommand::Compact)
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("VACUUM FULL"), "{refused}");
}

/// The stored bytes of the file `id`, from its database chunks.
async fn chunks_of(db: &Db, id: &str) -> Vec<u8> {
    let rows: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT data FROM media_chunks WHERE media_id = $1 ORDER BY seq")
            .bind(id)
            .fetch_all(db)
            .await
            .expect("chunks");
    rows.concat()
}

async fn sealed_file(db: &Db, id: &str) -> bool {
    sqlx::query_scalar::<_, Option<i64>>("SELECT seal_key FROM media WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("media")
        .is_some()
}

async fn upload(state: &AppState, data: &[u8]) -> String {
    save_within(
        state,
        "kept.bin",
        "application/octet-stream",
        data,
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
async fn decrypting_reaches_files_of_messages_edited_plain_and_files_no_message_carries() {
    for (state, temp) in each_db_keyed("seal_jobs_files").await {
        let db = &state.db;
        let cid = people(db).await;
        switch(&state, true).await;
        let data: Vec<u8> = (0..70_000u32).map(|i| (i % 241) as u8).collect();
        let (edited, orphan) = (upload(&state, &data).await, upload(&state, &data).await);
        let first = say(
            &state,
            cid,
            "bob",
            json!({"content": "a file", "media_id": edited}),
        )
        .await;
        let second = say(
            &state,
            cid,
            "bob",
            json!({"content": "another", "media_id": orphan}),
        )
        .await;
        for file in [&edited, &orphan] {
            crate::api::media::sealed::seal_now(&state, file)
                .await
                .expect("seal");
            assert!(sealed_file(db, file).await);
        }
        switch(&state, false).await;
        sqlx::query("UPDATE messages SET body = NULL, content = 'edited while off' WHERE id = $1")
            .bind(first.id)
            .execute(db)
            .await
            .expect("an edit stored plain");
        sqlx::query("UPDATE messages SET media_id = NULL WHERE id = $1")
            .bind(second.id)
            .execute(db)
            .await
            .expect("no message carries it");
        let job = start(&state, "carol", "s:rchat", Direction::Unseal, PASSWORD)
            .await
            .expect("unseal");
        assert_eq!(ended(&state, job.id).await.state, JobState::Done);
        assert!(!sealed_file(db, &edited).await, "the edited message's file");
        assert_eq!(chunks_of(db, &edited).await, data);
        assert!(sealed_file(db, &orphan).await, "not of this place");
        assert_eq!(
            super::still_sealed(db, &Target::Server("rchat".into()))
                .await
                .expect("left"),
            0
        );
        assert_eq!(
            super::still_sealed(db, &Target::All).await.expect("left"),
            1
        );
        let job = start(&state, "carol", "*", Direction::Unseal, PASSWORD)
            .await
            .expect("unseal all");
        assert_eq!(ended(&state, job.id).await.state, JobState::Done);
        assert!(!sealed_file(db, &orphan).await, "every place reaches it");
        assert_eq!(chunks_of(db, &orphan).await, data);
        assert_eq!(
            super::still_sealed(db, &Target::All).await.expect("left"),
            0
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_poll_with_a_record_that_does_not_open_stays_encrypted_whole() {
    for (state, temp) in each_db_keyed("seal_jobs_poll").await {
        let db = &state.db;
        let cid = people(db).await;
        switch(&state, true).await;
        let poll = say(
            &state,
            cid,
            "bob",
            json!({"content": "", "poll": {"kind": "single", "question": "Which one", "options": [{"text": "Left"}, {"text": "Right"}]}}),
        )
        .await;
        let options: Vec<(i64, Vec<u8>)> =
            sqlx::query_as("SELECT id, body FROM poll_options WHERE message_id = $1 ORDER BY id")
                .bind(poll.id)
                .fetch_all(db)
                .await
                .expect("options");
        assert_eq!(options.len(), 2);
        sqlx::query("UPDATE poll_options SET body = $1 WHERE id = $2")
            .bind(&options[1].1)
            .bind(options[0].0)
            .execute(db)
            .await
            .expect("an option's record moved onto another");
        let job = start(&state, "carol", "s:rchat", Direction::Unseal, PASSWORD)
            .await
            .expect("unseal");
        assert_eq!(ended(&state, job.id).await.state, JobState::Done);
        let kept: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM messages WHERE id = $1 AND body IS NOT NULL), (SELECT COUNT(*) FROM polls WHERE message_id = $1 AND body IS NOT NULL AND question = ''), (SELECT COUNT(*) FROM poll_options WHERE message_id = $1 AND body IS NOT NULL AND text = '')",
        )
        .bind(poll.id)
        .fetch_one(db)
        .await
        .expect("forms");
        assert_eq!(kept, (1, 1, 2), "nothing of it is blanked");
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_file_that_can_not_be_encrypted_is_left_and_the_job_ends() {
    for (state, temp) in each_db_keyed("seal_jobs_bad_file").await {
        let db = &state.db;
        let cid = people(db).await;
        let file = upload(&state, b"twelve bytes").await;
        let message = say(
            &state,
            cid,
            "bob",
            json!({"content": "with a file", "media_id": file}),
        )
        .await;
        say(&state, cid, "alice", json!({"content": "after it"})).await;
        sqlx::query("UPDATE media SET size = size + 1 WHERE id = $1")
            .bind(&file)
            .execute(db)
            .await
            .expect("damage");
        switch(&state, true).await;
        let job = start(&state, "alice", "s:rchat", Direction::Seal, PASSWORD)
            .await
            .expect("start");
        assert_eq!(ended(&state, job.id).await.state, JobState::Done);
        assert_eq!(forms(db, cid).await.0, 2, "both messages are encrypted");
        assert!(!sealed_file(db, &file).await, "the file stays as it was");
        let sealed: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE id = $1 AND body IS NOT NULL")
                .bind(message.id)
                .fetch_one(db)
                .await
                .expect("count");
        assert_eq!(sealed, 1);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn decrypting_every_place_goes_past_copies_that_do_not_open() {
    for (state, temp) in each_db_keyed("seal_jobs_copies").await {
        let db = &state.db;
        people(db).await;
        crate::api::seal::put_required(
            State(state.clone()),
            Authed(user(db, "carol").await),
            Json(crate::api::seal::RequireReq { on: true }),
        )
        .await
        .map(|_| ())
        .expect("require");
        crate::api::auth::patch_me(
            State(state.clone()),
            Authed(user(db, "bob").await),
            Json(serde_json::from_value(json!({"bio": "about bob"})).expect("patch")),
        )
        .await
        .map(|_| ())
        .expect("bio");
        let record = user(db, "bob").await.bio_sealed.expect("sealed");
        for n in 0..(super::COPIES_BATCH + 1) {
            let name = format!("aa{n:04}");
            crate::db::NewUser::plain(&name).add(db).await;
            sqlx::query("UPDATE users SET bio_sealed = $1 WHERE username = $2")
                .bind(&record)
                .bind(&name)
                .execute(db)
                .await
                .expect("a copy bound to another account");
        }
        let job = start(&state, "carol", "*", Direction::Unseal, PASSWORD)
            .await
            .expect("unseal");
        assert_eq!(ended(&state, job.id).await.state, JobState::Done);
        let bob = user(db, "bob").await;
        assert_eq!(
            (bob.bio.as_deref(), bob.bio_sealed.is_none()),
            (Some("about bob"), true)
        );
        assert_eq!(
            super::still_sealed(db, &Target::All).await.expect("left"),
            super::COPIES_BATCH + 1
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_job_another_process_holds_runs_there_until_its_lease_ends() {
    for (state, temp) in each_db_keyed("seal_jobs_lease").await {
        let db = &state.db;
        let cid = people(db).await;
        say(&state, cid, "bob", json!({"content": "from before"})).await;
        switch(&state, true).await;
        let job = begin(
            &state,
            &Target::Server("rchat".into()),
            Direction::Seal,
            Some("alice"),
        )
        .await
        .expect("begin");
        sqlx::query("UPDATE seal_jobs SET runner = 'elsewhere', lease_until = $1 WHERE id = $2")
            .bind(now() + 600)
            .bind(job.id)
            .execute(db)
            .await
            .expect("held elsewhere");
        assert!(!super::run_job(&state, job.id).await);
        let (held, _) = super::load(db, job.id).await.expect("load").expect("job");
        assert_eq!((held.state, held.done), (JobState::Running, 0));
        assert_eq!(forms(db, cid).await.1, 1, "nothing done here");
        sqlx::query("UPDATE seal_jobs SET lease_until = $1 WHERE id = $2")
            .bind(now() - 1)
            .bind(job.id)
            .execute(db)
            .await
            .expect("the other process went away");
        assert!(super::run_job(&state, job.id).await);
        assert_eq!(ended(&state, job.id).await.state, JobState::Done);
        assert_eq!(forms(db, cid).await.1, 0);
        temp.done(state).await;
    }
}
