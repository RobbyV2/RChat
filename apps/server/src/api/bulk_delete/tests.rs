use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use sqlx::Row;

use super::*;
use crate::api::Authed;
use crate::api::test_util::{add_member, done, mem_user, temp_state};

fn who(name: &str) -> Authed {
    Authed(mem_user(name, name == "root"))
}

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .expect(sql);
}

async fn num(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("value")
}

struct Club {
    state: AppState,
    path: PathBuf,
    general: i64,
    dm: i64,
}

/// `club` (creator alice) with mo (role with Manage messages), tim (the same role, timed out),
/// bob and carol, erin (no read history in #general, joined at 500), dave who is not a member,
/// and root, a site admin who is not a member. A DM between bob and carol.
async fn club(tag: &str) -> Club {
    let (state, path) = temp_state(tag).await;
    let db = &state.db;
    for name in ["alice", "mo", "tim", "bob", "carol", "erin", "dave", "root"] {
        crate::db::NewUser::plain(name).add(db).await;
    }
    exec(
        db,
        "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
    )
    .await;
    exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 0)").await;
    let general = num(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 0) RETURNING id",
    )
    .await;
    add_member(db, "club", "alice", 1, 0, 0).await;
    for name in ["mo", "tim", "bob", "carol"] {
        add_member(db, "club", name, 0, 0, 0).await;
    }
    add_member(db, "club", "erin", 0, 0, 500).await;
    let mods = num(db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'mods', '#ffffff', 2) RETURNING id").await;
    exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('club', 'mo', {mods}), ('club', 'tim', {mods})")).await;
    exec(db, &format!("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('club', 'tim', {}, 0)", now() + 600)).await;
    exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({general}, 'u:erin', 1, 1, 0)")).await;
    let dm = num(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('bob', 'carol') RETURNING id",
    )
    .await;
    Club {
        state,
        path,
        general,
        dm,
    }
}

async fn post(db: &Db, channel: i64, author: &str, at: i64) -> i64 {
    num(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({channel}, '{author}', 'hi', {at}) RETURNING id")).await
}

async fn reply(db: &Db, channel: i64, root: i64, author: &str) -> i64 {
    num(db, &format!("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES({channel}, {root}, '{author}', 're', 1000) RETURNING id")).await
}

async fn dm_post(db: &Db, dm: i64, author: &str) -> i64 {
    num(db, &format!("INSERT INTO messages(dm_id, author, content, created_at) VALUES({dm}, '{author}', 'hey', 1000) RETURNING id")).await
}

async fn call(state: &AppState, user: &str, body: Value) -> Result<BulkDeleteResp, (u16, String)> {
    bulk_delete(
        State(state.clone()),
        who(user),
        Json(serde_json::from_value(body).expect("body")),
    )
    .await
    .map(|Json(r)| r)
    .map_err(|ApiError(code, msg)| (code.as_u16(), msg))
}

async fn exists(db: &Db, id: i64) -> bool {
    num(
        db,
        &format!("SELECT COUNT(*) FROM messages WHERE id = {id}"),
    )
    .await
        == 1
}

async fn wait_job(db: &Db, id: i64) -> BulkJob {
    for _ in 0..400 {
        let job = load_job(db, id).await.expect("job").expect("job row");
        if job.status != JobStatus::Running {
            return job;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("job {id} did not end");
}

async fn audits(db: &Db) -> Vec<(Option<String>, i64, Value)> {
    sqlx::query("SELECT actor, staff, details FROM audit_log WHERE action = 'message.bulk_delete' ORDER BY id")
        .fetch_all(db)
        .await
        .expect("audit")
        .iter()
        .map(|r| {
            (
                r.try_get(0).unwrap(),
                r.try_get(1).unwrap(),
                serde_json::from_str(&r.try_get::<String, _>(2).unwrap()).unwrap(),
            )
        })
        .collect()
}

/// Whether `DELETE /api/messages/{id}` would let `user` delete `id`: 0 allowed, 403 or 404.
async fn single(db: &Db, user: &str, id: i64) -> u16 {
    let Authed(u) = who(user);
    match resolve_message(db, id, Some(&u), &Proof::none()).await {
        Err(ApiError(code, _)) => code.as_u16(),
        Ok(m) => match m.require_can_delete(db).await {
            Ok(()) => 0,
            Err(ApiError(code, _)) => code.as_u16(),
        },
    }
}

#[tokio::test]
async fn every_message_follows_the_single_delete_rule() {
    let c = club("bulk_matrix").await;
    let db = &c.state.db;
    let old_bob = post(db, c.general, "bob", 100).await;
    let carols = post(db, c.general, "carol", 1000).await;
    let bobs = post(db, c.general, "bob", 1000).await;
    let tims = post(db, c.general, "tim", 1000).await;
    let erins = post(db, c.general, "erin", 1000).await;
    let roots = post(db, c.general, "root", 1000).await;
    let messages = [old_bob, carols, bobs, tims, erins, roots];
    let users = ["alice", "mo", "tim", "bob", "carol", "erin", "dave", "root"];
    let mut table = Vec::new();
    for user in users {
        let mut row = Vec::new();
        for id in messages {
            let bulk = call(
                &c.state,
                user,
                json!({ "scope": format!("c{}", c.general), "ids": [id], "dry_run": true }),
            )
            .await;
            let verdict = match bulk {
                Ok(r) if r.deletable == 1 => 0,
                Ok(r) if r.others == 1 => 403,
                Ok(r) if r.missing == 1 => 404,
                Ok(_) => 1,
                Err((code, _)) => code,
            };
            assert_eq!(verdict, single(db, user, id).await, "{user} on {id}");
            row.push(match verdict {
                0 => 'D',
                403 => 'o',
                _ => '-',
            });
        }
        table.push(format!("{user}:{}", row.into_iter().collect::<String>()));
    }
    assert_eq!(
        table,
        [
            "alice:DDDDDD",
            "mo:DDDDDD",
            "tim:oooDoo",
            "bob:DoDooo",
            "carol:oDoooo",
            "erin:-oooDo",
            "dave:oooooo",
            "root:DDDDDD",
        ]
        .map(|s| s.to_string())
    );
    done(c.state, c.path).await;
}

fn drain(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> (Vec<Value>, Vec<BulkJob>) {
    let (mut deleted, mut jobs) = (Vec::new(), Vec::new());
    while let Ok(ev) = rx.try_recv() {
        match &ev {
            WsEvent::MessagesDeleted { .. } => {
                deleted.push(serde_json::to_value(&ev).expect("json"));
            }
            WsEvent::BulkDeleteProgress { username: _, job } => jobs.push(job.clone()),
            _ => {}
        }
    }
    (deleted, jobs)
}

fn ids_of(ev: &Value) -> Vec<i64> {
    ev["ids"]
        .as_array()
        .expect("ids")
        .iter()
        .map(|v| v.as_i64().expect("id"))
        .collect()
}

#[tokio::test]
async fn ids_are_deleted_at_once_and_others_are_logged_once() {
    let c = club("bulk_ids").await;
    let state = &c.state;
    let db = &state.db;
    let scope = format!("c{}", c.general);
    let bobs = post(db, c.general, "bob", 1000).await;
    let carols = post(db, c.general, "carol", 1000).await;
    let mos = post(db, c.general, "mo", 1000).await;
    let root = post(db, c.general, "carol", 1000).await;
    let replies = [
        reply(db, c.general, root, "bob").await,
        reply(db, c.general, root, "carol").await,
    ];
    let dm_bob = dm_post(db, c.dm, "bob").await;
    let dm_carol = dm_post(db, c.dm, "carol").await;
    let mut rx = state.hub.subscribe();

    for (body, err) in [
        (json!({ "scope": "x1", "ids": [1] }), "Unknown scope"),
        (json!({ "scope": "c", "ids": [1] }), "Unknown scope"),
        (
            json!({ "scope": scope, "ids": [] }),
            "Choose messages to delete",
        ),
        (json!({ "scope": scope }), "Choose messages to delete"),
        (
            json!({ "scope": scope, "ids": [1], "all": true }),
            "Choose messages to delete",
        ),
        (
            json!({ "scope": scope, "ids": (1..=201).collect::<Vec<i64>>() }),
            "At most 200 messages at a time",
        ),
        (
            json!({ "scope": scope, "ids": [1], "except": [2] }),
            "except, before, after and author only go with all",
        ),
        (
            json!({ "scope": scope, "all": true, "except": (1..=1001).collect::<Vec<i64>>() }),
            "At most 1000 exceptions",
        ),
    ] {
        assert_eq!(
            call(state, "alice", body).await.err(),
            Some((400, err.to_string()))
        );
    }
    let hidden = num(db, "INSERT INTO channels(server, name, restrict_view, created_at) VALUES('club', 'staff', 1, 0) RETURNING id").await;
    let nf = Some((404, "Not found".to_string()));
    for (user, scope) in [
        ("bob", format!("c{hidden}")),
        ("bob", "c999999".to_string()),
        ("mo", format!("d{}", c.dm)),
        ("bob", format!("t{}", replies[0])),
        ("bob", format!("t{bobs}9")),
    ] {
        assert_eq!(
            call(state, user, json!({ "scope": scope, "ids": [bobs] }))
                .await
                .err(),
            nf,
            "{user} {scope}"
        );
    }

    let r = call(
        state,
        "mo",
        json!({ "scope": scope, "ids": [bobs, carols, mos, 999999, dm_bob, replies[0], bobs] }),
    )
    .await
    .expect("mo");
    assert_eq!(
        (r.total, r.deletable, r.others, r.missing, r.deleted),
        (6, 3, 0, 3, 3)
    );
    assert_eq!(r.ids, vec![mos, carols, bobs]);
    for id in [bobs, carols, mos] {
        assert!(!exists(db, id).await);
    }
    assert!(exists(db, dm_bob).await && exists(db, replies[0]).await);
    let logged = audits(db).await;
    assert_eq!(logged.len(), 1);
    assert_eq!(logged[0].0.as_deref(), Some("mo"));
    assert_eq!(logged[0].1, 0);
    assert_eq!(logged[0].2["count"], 2);
    assert_eq!(logged[0].2["total"], 3);
    assert_eq!(
        logged[0].2["authors"],
        json!([{ "name": "bob", "count": 1 }, { "name": "carol", "count": 1 }])
    );
    assert_eq!(logged[0].2["channel"]["id"], c.general);
    let (events, jobs) = drain(&mut rx);
    assert!(jobs.is_empty());
    assert_eq!(events.len(), 1);
    assert_eq!(ids_of(&events[0]), vec![mos, carols, bobs]);
    let keys: Vec<&String> = events[0].as_object().expect("object").keys().collect();
    assert_eq!(
        keys,
        [
            "channel_id",
            "dm_id",
            "dm_users",
            "ids",
            "server",
            "thread_root_id",
            "type"
        ]
    );
    assert_eq!(events[0]["type"], "messages_deleted");

    let again = call(
        state,
        "mo",
        json!({ "scope": scope, "ids": [bobs, carols] }),
    )
    .await
    .expect("again");
    assert_eq!((again.deleted, again.missing), (0, 2));
    assert_eq!(audits(db).await.len(), 1, "nothing deleted, nothing logged");

    let thread = call(
        state,
        "bob",
        json!({ "scope": format!("t{root}"), "ids": replies }),
    )
    .await
    .expect("thread");
    assert_eq!((thread.deleted, thread.others), (1, 1));
    assert_eq!(audits(db).await.len(), 1, "own messages are not logged");
    let (events, _) = drain(&mut rx);
    assert_eq!(events[0]["thread_root_id"], root);
    assert_eq!(ids_of(&events[0]), vec![replies[0]]);

    exec(
        db,
        "INSERT INTO blocks(blocker, blocked, created_at) VALUES('bob', 'carol', 0)",
    )
    .await;
    let dm = call(
        state,
        "carol",
        json!({ "scope": format!("d{}", c.dm), "ids": [dm_bob, dm_carol] }),
    )
    .await
    .expect("dm");
    assert_eq!((dm.deleted, dm.others, dm.missing), (1, 1, 0));
    assert!(exists(db, dm_bob).await && !exists(db, dm_carol).await);
    let (events, _) = drain(&mut rx);
    assert_eq!(events[0]["dm_id"], c.dm);
    assert_eq!(events[0]["dm_users"], json!(["bob", "carol"]));
    assert_eq!(audits(db).await.len(), 1, "DMs are not logged");

    let staff = call(state, "root", json!({ "scope": scope, "ids": [root] }))
        .await
        .expect("root");
    assert_eq!(staff.deleted, 1);
    assert!(!exists(db, replies[1]).await, "a root takes its replies");
    let logged = audits(db).await;
    assert_eq!(logged.len(), 2);
    assert_eq!((logged[1].0.as_deref(), logged[1].1), (None, 1));
    done(c.state, c.path).await;
}

#[tokio::test]
async fn all_runs_as_a_job_in_batches_with_except_and_bounds() {
    let c = club("bulk_all").await;
    let state = &c.state;
    let db = &state.db;
    let scope = format!("c{}", c.general);
    let mut bobs = Vec::new();
    for i in 0..450 {
        bobs.push(post(db, c.general, "bob", 1000 + i).await);
    }
    let mut carols = Vec::new();
    for _ in 0..50 {
        carols.push(post(db, c.general, "carol", 2000).await);
    }
    let old = post(db, c.general, "bob", 100).await;
    let replied = bobs[10];
    let replies = [
        reply(db, c.general, replied, "carol").await,
        reply(db, c.general, replied, "bob").await,
    ];
    let kept = bobs[300];

    let counts = call(
        state,
        "bob",
        json!({ "scope": scope, "all": true, "except": [kept, carols[0]], "dry_run": true }),
    )
    .await
    .expect("count");
    assert_eq!(
        (counts.total, counts.deletable, counts.others, counts.job),
        (499, 450, 49, None)
    );
    let erin = call(
        state,
        "erin",
        json!({ "scope": scope, "all": true, "dry_run": true }),
    )
    .await
    .expect("erin count");
    assert_eq!((erin.total, erin.deletable), (500, 0), "below the floor");
    let tim = call(
        state,
        "tim",
        json!({ "scope": scope, "all": true, "dry_run": true }),
    )
    .await
    .expect("tim count");
    assert_eq!(tim.deletable, 0, "timed out: own messages only");

    let mut rx = state.hub.subscribe();
    let started = call(
        state,
        "bob",
        json!({ "scope": scope, "all": true, "except": [kept] }),
    )
    .await
    .expect("start");
    let job = started.job.expect("job");
    assert_eq!((job.status, job.estimate), (JobStatus::Running, 450));
    let late = post(db, c.general, "bob", 3000).await;
    let again = call(state, "bob", json!({ "scope": scope, "all": true }))
        .await
        .expect("again");
    assert_eq!(again.job.map(|j| j.id), Some(job.id), "one job per scope");
    let finished = wait_job(db, job.id).await;
    assert_eq!(
        (finished.status, finished.deleted, finished.error),
        (JobStatus::Done, 450, None)
    );
    for id in &bobs {
        assert_eq!(exists(db, *id).await, *id == kept);
    }
    assert!(exists(db, late).await, "posted after the start");
    assert!(!exists(db, old).await, "older messages too");
    for id in &carols {
        assert!(exists(db, *id).await);
    }
    assert!(!exists(db, replies[0]).await && !exists(db, replies[1]).await);
    assert!(audits(db).await.is_empty(), "own messages only");
    let (events, jobs) = drain(&mut rx);
    let mut seen: Vec<i64> = events.iter().flat_map(ids_of).collect();
    assert!(events.iter().all(|e| ids_of(e).len() <= BATCH as usize));
    assert!(events.len() >= 3, "{} batches", events.len());
    seen.sort();
    let mut expected: Vec<i64> = bobs.iter().copied().filter(|id| *id != kept).collect();
    expected.push(old);
    expected.sort();
    assert_eq!(seen, expected);
    assert_eq!(jobs.last().map(|j| j.status), Some(JobStatus::Done));
    assert!(jobs.len() >= 4);
    assert!(jobs.windows(2).all(|w| w[0].deleted <= w[1].deleted));

    let range = call(
        state,
        "mo",
        json!({ "scope": scope, "all": true, "after": carols[9], "before": carols[20] }),
    )
    .await
    .expect("range");
    let job = wait_job(db, range.job.expect("job").id).await;
    assert_eq!(job.deleted, 10);
    for (i, id) in carols.iter().enumerate() {
        assert_eq!(exists(db, *id).await, !(10..20).contains(&i), "{i}");
    }
    let logged = audits(db).await;
    assert_eq!(logged.len(), 1);
    assert_eq!(logged[0].2["count"], 10);
    assert_eq!(
        logged[0].2["authors"],
        json!([{ "name": "carol", "count": 10 }])
    );
    done(c.state, c.path).await;
}

async fn insert_job(db: &Db, user: &str, scope: &str, channel: Option<i64>, claimed: i64) -> i64 {
    let key: i64 = scope[1..].parse().expect("scope id");
    let upto = num(
        db,
        &format!("SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = {key} OR dm_id = {key} OR thread_root_id = {key}"),
    )
    .await;
    sqlx::query("INSERT INTO bulk_delete_jobs(username, scope, channel_id, upto_id, cursor_id, claimed_at, created_at) VALUES($1, $2, $3, $4, $5, $6, 0) RETURNING id")
        .bind(user)
        .bind(scope)
        .bind(channel)
        .bind(upto)
        .bind(upto + 1)
        .bind(claimed)
        .fetch_one(db)
        .await
        .expect("job")
        .try_get(0)
        .expect("id")
}

#[tokio::test]
async fn jobs_cancel_resume_and_fail_cleanly() {
    let c = club("bulk_jobs").await;
    let state = &c.state;
    let db = &state.db;
    let scope = format!("c{}", c.general);
    for _ in 0..300 {
        post(db, c.general, "carol", 1000).await;
    }
    let id = insert_job(db, "mo", &scope, Some(c.general), now()).await;
    assert_eq!(resume_jobs(state).await.expect("resume"), 0, "lease held");
    assert!(step(state, id).await.expect("step"));
    let job = load_job(db, id).await.expect("load").expect("job");
    assert_eq!((job.status, job.deleted), (JobStatus::Running, 200));
    assert_eq!(
        cancel_job(State(state.clone()), who("bob"), Path(id))
            .await
            .err()
            .map(|ApiError(code, _)| code.as_u16()),
        Some(404),
        "not his job"
    );
    let Json(cancelled) = cancel_job(State(state.clone()), who("mo"), Path(id))
        .await
        .expect("cancel");
    assert_eq!(
        (cancelled.status, cancelled.deleted),
        (JobStatus::Cancelled, 200)
    );
    assert!(!step(state, id).await.expect("after cancel"));
    assert_eq!(
        num(db, "SELECT COUNT(*) FROM messages WHERE author = 'carol'").await,
        100
    );
    let Json(twice) = cancel_job(State(state.clone()), who("mo"), Path(id))
        .await
        .expect("cancel again");
    assert_eq!(twice, cancelled);
    let logged = audits(db).await;
    assert_eq!(logged.len(), 1, "one entry for the cancelled job");
    assert_eq!(logged[0].2["count"], 200);
    assert_eq!(logged[0].2["total"], 200);

    let stale = insert_job(db, "mo", &scope, Some(c.general), 0).await;
    assert_eq!(resume_jobs(state).await.expect("resume"), 1);
    let job = wait_job(db, stale).await;
    assert_eq!((job.status, job.deleted), (JobStatus::Done, 100));
    assert_eq!(resume_jobs(state).await.expect("resume"), 0);
    assert_eq!(audits(db).await.len(), 2);

    let side = num(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('club', 'side', 0) RETURNING id",
    )
    .await;
    post(db, side, "mo", 1000).await;
    let doomed = insert_job(db, "mo", &format!("c{side}"), Some(side), now()).await;
    exec(db, &format!("DELETE FROM channels WHERE id = {side}")).await;
    run_job(state, doomed).await;
    let job = load_job(db, doomed).await.expect("load").expect("job");
    assert_eq!(
        (job.status, job.error.as_deref()),
        (JobStatus::Failed, Some(GONE))
    );
    assert!(job.finished_at.is_some());

    for n in 0..3 {
        insert_job(db, "bob", &format!("t{}", 100 + n), None, now()).await;
    }
    assert_eq!(
        call(state, "bob", json!({ "scope": scope, "all": true }))
            .await
            .err(),
        Some((429, TOO_MANY_JOBS.to_string()))
    );
    let Json(listed) = list_jobs(State(state.clone()), who("mo"))
        .await
        .expect("list");
    assert_eq!(
        listed.iter().map(|j| j.id).collect::<Vec<_>>(),
        vec![doomed, stale, id]
    );
    done(c.state, c.path).await;
}

#[tokio::test]
async fn audit_authors_are_capped_and_forgotten_with_the_account() {
    let (named, more) = tally_for_tests(
        &(0..12)
            .map(|i| {
                (
                    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"][i],
                    i as i64 + 1,
                )
            })
            .collect::<Vec<_>>(),
        3,
    );
    assert_eq!(named.as_array().map(Vec::len), Some(AUDIT_AUTHORS));
    assert_eq!(named[0], json!({ "name": "l", "count": 12 }));
    assert_eq!(more, 3);
    let mut t = Tally::default();
    for i in 0..AUTHORS_KEPT + 5 {
        t.add(&format!("u{i}"), 1);
    }
    assert_eq!((t.authors.len(), t.unnamed), (AUTHORS_KEPT, 5));
    assert_eq!(Tally::decode(&t.encode(), true), Tally { staff: true, ..t });

    let c = club("bulk_forget").await;
    let db = &c.state.db;
    let carols = post(db, c.general, "carol", 1000).await;
    let bobs = post(db, c.general, "bob", 1000).await;
    call(
        &c.state,
        "mo",
        json!({ "scope": format!("c{}", c.general), "ids": [carols, bobs] }),
    )
    .await
    .expect("delete");
    let mut conn = db.acquire().await.expect("conn");
    audit::forget_user(&mut conn, "carol")
        .await
        .expect("forget");
    drop(conn);
    let logged = audits(db).await;
    assert_eq!(
        logged[0].2["authors"],
        json!([{ "name": "bob", "count": 1 }, { "deleted": true, "count": 1 }])
    );
    assert!(!logged[0].2.to_string().contains("carol"));
    done(c.state, c.path).await;
}

#[tokio::test]
async fn all_with_an_author_deletes_only_that_authors_messages() {
    let c = club("bulk_author").await;
    let state = &c.state;
    let db = &state.db;
    let scope = format!("c{}", c.general);
    let mut bobs = Vec::new();
    for _ in 0..250 {
        bobs.push(post(db, c.general, "bob", 1000).await);
    }
    let mut carols = Vec::new();
    for _ in 0..30 {
        carols.push(post(db, c.general, "carol", 1000).await);
    }
    let mos = post(db, c.general, "mo", 1000).await;
    for (body, err) in [
        (
            json!({ "scope": scope, "ids": [bobs[0]], "author": "bob" }),
            "except, before, after and author only go with all",
        ),
        (
            json!({ "scope": scope, "all": true, "author": " " }),
            "Unknown author",
        ),
    ] {
        assert_eq!(
            call(state, "mo", body).await.err(),
            Some((400, err.to_string()))
        );
    }
    let counted = call(
        state,
        "mo",
        json!({ "scope": scope, "all": true, "author": "carol", "except": [carols[0], bobs[0]], "dry_run": true }),
    )
    .await
    .expect("mo count");
    assert_eq!(
        (counted.total, counted.deletable, counted.upto),
        (29, 29, Some(mos))
    );
    let theirs = call(
        state,
        "bob",
        json!({ "scope": scope, "all": true, "author": "carol", "dry_run": true }),
    )
    .await
    .expect("bob count");
    assert_eq!((theirs.total, theirs.deletable, theirs.others), (30, 0, 30));
    let mine = call(
        state,
        "bob",
        json!({ "scope": scope, "all": true, "author": "BOB", "dry_run": true }),
    )
    .await
    .expect("bob mine");
    assert_eq!((mine.total, mine.deletable), (250, 250));
    let nothing = call(
        state,
        "mo",
        json!({ "scope": scope, "all": true, "before": i64::MIN, "dry_run": true }),
    )
    .await
    .expect("before min");
    assert_eq!(nothing.total, 0, "i64::MIN means nothing, not everything");

    let started = call(
        state,
        "mo",
        json!({ "scope": scope, "all": true, "author": "carol", "except": [carols[0]] }),
    )
    .await
    .expect("mo job");
    let job = wait_job(db, started.job.expect("job").id).await;
    assert_eq!((job.status, job.deleted), (JobStatus::Done, 29));
    for (i, id) in carols.iter().enumerate() {
        assert_eq!(exists(db, *id).await, i == 0, "carol {i}");
    }
    for id in bobs.iter().chain([&mos]) {
        assert!(exists(db, *id).await, "not carol's: {id}");
    }
    let logged = audits(db).await;
    assert_eq!(logged.len(), 1);
    assert_eq!(
        logged[0].2["authors"],
        json!([{ "name": "carol", "count": 29 }])
    );

    let other = call(
        state,
        "bob",
        json!({ "scope": scope, "all": true, "author": "mo" }),
    )
    .await
    .expect("bob on mo");
    let job = wait_job(db, other.job.expect("job").id).await;
    assert_eq!((job.status, job.deleted), (JobStatus::Done, 0));
    assert!(exists(db, mos).await);
    let own = call(
        state,
        "bob",
        json!({ "scope": scope, "all": true, "author": "bob" }),
    )
    .await
    .expect("bob mine");
    let job = wait_job(db, own.job.expect("job").id).await;
    assert_eq!((job.status, job.deleted), (JobStatus::Done, 250));
    for id in &bobs {
        assert!(!exists(db, *id).await);
    }
    assert!(exists(db, mos).await && exists(db, carols[0]).await);
    done(c.state, c.path).await;
}

#[tokio::test]
async fn a_job_is_logged_with_every_batch_even_if_its_requester_is_purged() {
    let c = club("bulk_logged").await;
    let state = &c.state;
    let db = &state.db;
    let scope = format!("c{}", c.general);
    for _ in 0..300 {
        post(db, c.general, "carol", 1000).await;
    }
    let id = insert_job(db, "mo", &scope, Some(c.general), now()).await;
    assert!(step(state, id).await.expect("step"));
    let logged = audits(db).await;
    assert_eq!(logged.len(), 1, "written with the batch");
    assert_eq!(logged[0].0.as_deref(), Some("mo"));
    assert_eq!(
        (logged[0].2["count"].clone(), logged[0].2["total"].clone()),
        (json!(200), json!(200))
    );
    let _ = crate::api::admin::hide_user_rows(state, "mo", crate::api::admin::PurgeKind::User)
        .await
        .expect("hide");
    assert!(!step(state, id).await.expect("after hide"));
    crate::api::admin::finish_purge(state, crate::api::admin::PurgeKind::User, "mo")
        .await
        .expect("purge");
    let logged = audits(db).await;
    assert_eq!(
        logged.len(),
        1,
        "the entry outlives the job and the account"
    );
    assert_eq!((logged[0].0.clone(), logged[0].1), (None, 0));
    assert_eq!(logged[0].2["count"], 200);
    assert_eq!(
        num(db, "SELECT COUNT(*) FROM messages WHERE author = 'carol'").await,
        100
    );
    done(c.state, c.path).await;
}

#[tokio::test]
async fn an_author_purged_mid_job_is_never_named() {
    let c = club("bulk_purged_author").await;
    let state = &c.state;
    let db = &state.db;
    let scope = format!("c{}", c.general);
    for _ in 0..50 {
        post(db, c.general, "bob", 1000).await;
    }
    for _ in 0..300 {
        post(db, c.general, "carol", 1000).await;
    }
    let id = insert_job(db, "mo", &scope, Some(c.general), now()).await;
    let other = insert_job(db, "alice", &format!("t{}", 1), None, now()).await;
    exec(db, &format!("UPDATE bulk_delete_jobs SET status = 'done', authors = '{{\"authors\":{{\"carol\":4}},\"unnamed\":1}}' WHERE id = {other}")).await;
    assert!(step(state, id).await.expect("step"));
    assert_eq!(
        audits(db).await[0].2["authors"],
        json!([{ "name": "carol", "count": 200 }]),
        "named while the account exists"
    );
    let _ = crate::api::admin::hide_user_rows(state, "carol", crate::api::admin::PurgeKind::User)
        .await
        .expect("hide");
    crate::api::admin::finish_purge(state, crate::api::admin::PurgeKind::User, "carol")
        .await
        .expect("purge");
    for job in [id, other] {
        let authors: String = sqlx::query("SELECT authors FROM bulk_delete_jobs WHERE id = $1")
            .bind(job)
            .fetch_one(db)
            .await
            .expect("authors")
            .try_get(0)
            .expect("text");
        assert!(!authors.contains("carol"), "job {job}: {authors}");
    }
    run_job(state, id).await;
    let job = load_job(db, id).await.expect("load").expect("job");
    assert_eq!((job.status, job.deleted), (JobStatus::Done, 250));
    let logged = audits(db).await;
    assert_eq!(logged.len(), 1);
    assert_eq!(logged[0].2["count"], 250);
    assert_eq!(
        logged[0].2["authors"],
        json!([{ "name": "bob", "count": 50 }])
    );
    assert_eq!(logged[0].2["more_authors"], 1);
    assert!(!logged[0].2.to_string().contains("carol"));
    done(c.state, c.path).await;
}

#[tokio::test]
async fn losing_manage_messages_between_batches_stops_deleting_others() {
    let c = club("bulk_demoted").await;
    let state = &c.state;
    let db = &state.db;
    let scope = format!("c{}", c.general);
    for _ in 0..5 {
        post(db, c.general, "mo", 500).await;
    }
    for _ in 0..300 {
        post(db, c.general, "carol", 1000).await;
    }
    let id = insert_job(db, "mo", &scope, Some(c.general), now()).await;
    assert!(step(state, id).await.expect("step"));
    exec(db, "DELETE FROM user_roles WHERE username = 'mo'").await;
    run_job(state, id).await;
    let job = load_job(db, id).await.expect("load").expect("job");
    assert_eq!((job.status, job.deleted), (JobStatus::Done, 205));
    assert_eq!(
        num(db, "SELECT COUNT(*) FROM messages WHERE author = 'carol'").await,
        100
    );
    assert_eq!(
        num(db, "SELECT COUNT(*) FROM messages WHERE author = 'mo'").await,
        0
    );
    done(c.state, c.path).await;
}

#[tokio::test]
async fn deleted_messages_leave_the_inbox() {
    let c = club("bulk_inbox").await;
    let state = &c.state;
    let db = &state.db;
    let scope = format!("c{}", c.general);
    let mention = post(db, c.general, "bob", 1000).await;
    let everyone = post(db, c.general, "bob", 1001).await;
    let kept = post(db, c.general, "bob", 1002).await;
    for (id, at) in [(mention, 1000), (kept, 1002)] {
        exec(db, &format!("INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at) VALUES('alice', 'mention', '{scope}', 'club', {id}, 'bob', {at})")).await;
    }
    exec(db, &format!("INSERT INTO group_pings(message_id, channel_id, server, kind, actor, created_at) VALUES({everyone}, {}, 'club', 'everyone', 'bob', 1001)", c.general)).await;
    let inbox = || async {
        let q: crate::api::inbox::InboxQuery = serde_json::from_value(json!({})).expect("query");
        crate::api::inbox::list_inbox(State(state.clone()), who("alice"), axum::extract::Query(q))
            .await
            .expect("inbox")
            .0
            .items
            .iter()
            .map(|i| i.message_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        inbox().await,
        vec![Some(kept), Some(everyone), Some(mention)]
    );
    let r = call(
        state,
        "bob",
        json!({ "scope": scope, "ids": [mention, everyone] }),
    )
    .await
    .expect("delete");
    assert_eq!(r.deleted, 2);
    assert_eq!(inbox().await, vec![Some(kept)]);
    let Club { state, path, .. } = c;
    done(state, path).await;
}

/// Postgres only (set `RCHAT_TEST_POSTGRES` to a database URL): purging an author locks the
/// jobs whose tally names them, and only those.
#[tokio::test]
async fn forgetting_an_author_locks_only_the_jobs_naming_them() {
    let Ok(url) = std::env::var("RCHAT_TEST_POSTGRES") else {
        return;
    };
    let db = crate::db::open_started(Some(&url)).await.expect("postgres");
    let tag = format!("fa{}", rand::random::<u32>());
    let job = |who: String| {
        let db = db.clone();
        let tag = tag.clone();
        async move {
            sqlx::query("INSERT INTO bulk_delete_jobs(username, scope, status, authors, created_at) VALUES($1, $2, 'done', $3, 1) RETURNING id")
                .bind(&tag)
                .bind(format!("{tag}:{who}"))
                .bind(json!({ "authors": { who: 2 }, "unnamed": 0 }).to_string())
                .fetch_one(&db)
                .await
                .expect("job")
                .get::<i64, _>(0)
        }
    };
    let named = job(format!("{tag}_v")).await;
    let other = job(format!("{tag}x")).await;
    let mut tx = db.begin().await.expect("tx");
    forget_author(&mut tx, &format!("{tag}_v"))
        .await
        .expect("forget");
    let nowait = |id: i64| {
        let db = db.clone();
        async move {
            sqlx::query("SELECT id FROM bulk_delete_jobs WHERE id = $1 FOR UPDATE NOWAIT")
                .bind(id)
                .fetch_optional(&db)
                .await
                .map(|_| ())
                .map_err(|e| {
                    e.as_database_error()
                        .and_then(|d| d.code())
                        .map(|c| c.to_string())
                })
        }
    };
    assert_eq!(nowait(named).await, Err(Some("55P03".to_string())));
    assert_eq!(nowait(other).await, Ok(()), "jobs naming others stay free");
    tx.rollback().await.expect("rollback");
    sqlx::query("DELETE FROM bulk_delete_jobs WHERE username = $1")
        .bind(&tag)
        .execute(&db)
        .await
        .expect("clean up");
}

#[tokio::test]
async fn a_closed_database_keeps_no_job_marked_as_running() {
    let (state, path) = temp_state("bulk_forget").await;
    let (other, other_path) = temp_state("bulk_forget_other").await;
    let marked = |db: &Db, id: i64| {
        RUNNING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(&running_key(db, id))
    };
    for (db, id) in [(&state.db, 7), (&state.db, 71), (&other.db, 7)] {
        RUNNING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(running_key(db, id));
    }
    forget(&state.db);
    assert!(!marked(&state.db, 7) && !marked(&state.db, 71));
    assert!(marked(&other.db, 7), "another database keeps its own");
    forget(&other.db);
    assert!(!marked(&other.db, 7));
    done(state, path).await;
    done(other, other_path).await;
}
