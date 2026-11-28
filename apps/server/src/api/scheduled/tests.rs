use crate::db::now;
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::broadcast::Receiver;

use super::*;
use crate::api::test_util::{TempDb, add_member, each_db, temp_state};
use crate::api::{ReasonKind, Settings};
use crate::limits::Limits;

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

async fn user(db: &Db, name: &str) -> User {
    get_user(db, name).await.expect("read").expect("user")
}

/// The built-in server's #general with alice, bob and carol, a DM between alice and bob, and a
/// root message of bob's in #general.
struct Place {
    general: i64,
    dm: i64,
    root: i64,
}

async fn place(state: &AppState) -> Place {
    let db = &state.db;
    for name in ["alice", "bob", "carol"] {
        crate::db::NewUser::plain(name).add(db).await;
        add_member(db, "rchat", name, 0, 0, 1).await;
    }
    let general = num(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
    let dm = num(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let root = post(state, "bob", SendTo::Channel(general), "root").await;
    Place { general, dm, root }
}

async fn post(state: &AppState, author: &str, to: SendTo, text: &str) -> i64 {
    let author = user(&state.db, author).await;
    send_to(state, &author, to, SendReq::text(text.into(), None), None)
        .await
        .expect("post")
        .id
}

/// A time this many seconds before now.
fn ago(secs: i64) -> i64 {
    now() - secs
}

async fn schedule(
    state: &AppState,
    who: &str,
    body: Value,
    t: i64,
) -> Result<ScheduledMessage, (u16, String, Option<ReasonKind>, Option<String>)> {
    let u = user(&state.db, who).await;
    create_at(state, &u, serde_json::from_value(body).expect("body"), t)
        .await
        .map_err(refusal)
}

fn refusal(e: ApiError) -> (u16, String, Option<ReasonKind>, Option<String>) {
    let ApiError(code, text, reason) = e;
    let control = reason
        .as_ref()
        .and_then(|r| r.control.clone().or(r.field.clone()));
    (code.as_u16(), text, reason.map(|r| r.kind), control)
}

/// Schedules `content` from alice to `place` due 60 seconds after `t`.
async fn due(state: &AppState, to: Value, content: &str, t: i64) -> ScheduledMessage {
    due_as(state, "alice", to, content, t).await
}

async fn due_as(state: &AppState, who: &str, to: Value, content: &str, t: i64) -> ScheduledMessage {
    let mut body = to;
    body["content"] = json!(content);
    body["at"] = json!(t + 60);
    schedule(state, who, body, t).await.expect("schedule")
}

async fn status_of(db: &Db, id: i64) -> (String, Option<String>, Option<i64>) {
    let r =
        sqlx::query("SELECT status, error, sent_message_id FROM scheduled_messages WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("row");
    (
        r.try_get(0).expect("status"),
        r.try_get(1).expect("error"),
        r.try_get(2).expect("sent"),
    )
}

fn drain(rx: &mut Receiver<WsEvent>) -> Vec<WsEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
}

fn scheduled_events(evs: &[WsEvent]) -> Vec<(String, Value)> {
    evs.iter()
        .filter_map(|ev| match ev {
            WsEvent::ScheduledUpdated {
                username,
                scheduled,
            } => Some((
                username.clone(),
                serde_json::to_value(scheduled).expect("json"),
            )),
            WsEvent::ScheduledRemoved {
                username,
                id,
                sent_message_id,
            } => Some((
                username.clone(),
                json!({ "removed": id, "sent": sent_message_id }),
            )),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn scheduled_sends_through_the_send_path_at_its_time() {
    let (state, path) = temp_state("scheduled_sends").await;
    let db = &state.db;
    let p = place(&state).await;
    let quoted = post(&state, "bob", SendTo::Dm(p.dm), "question").await;
    let t = ago(300);
    let channel = due(&state, json!({ "channel_id": p.general }), "hi @bob", t).await;
    let thread = due(&state, json!({ "thread_root_id": p.root }), "in thread", t).await;
    let dm = due(
        &state,
        json!({ "dm_id": p.dm, "reply_to": quoted }),
        "answer",
        t,
    )
    .await;
    assert_eq!(
        (channel.scope.as_str(), channel.status),
        (format!("c{}", p.general).as_str(), ScheduledStatus::Waiting)
    );
    assert_eq!(thread.channel_id, Some(p.general));
    assert_eq!(thread.scope, format!("t{}", p.root));
    assert_eq!(
        dm.place
            .as_ref()
            .and_then(|pl| pl.dm_user.as_ref())
            .map(|u| u.username.as_str()),
        Some("bob")
    );
    let mut rx = state.hub.subscribe();
    let before = now();
    assert_eq!(run_due_at(&state, now()).await.expect("run"), 3);
    assert_eq!(run_due_at(&state, now()).await.expect("again"), 0);
    let evs = drain(&mut rx);
    for (row, content, scope) in [
        (&channel, "hi @bob", "channel_id"),
        (&thread, "in thread", "thread_root_id"),
        (&dm, "answer", "dm_id"),
    ] {
        let (status, error, sent) = status_of(db, row.id).await;
        assert_eq!((status.as_str(), error), ("sent", None), "{content}");
        let sent = sent.expect("sent message id");
        let msg = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT content, author, created_at, {scope} FROM messages WHERE id = $1"
        )))
        .bind(sent)
        .fetch_one(db)
        .await
        .expect("message");
        assert_eq!(msg.try_get::<String, _>(0).expect("c"), content);
        assert_eq!(msg.try_get::<String, _>(1).expect("a"), "alice");
        assert!(
            msg.try_get::<i64, _>(2).expect("at") >= before,
            "the real send time"
        );
        assert!(
            evs.iter()
                .any(|ev| matches!(ev, WsEvent::Message { message, .. } if message.id == sent))
        );
        assert!(evs.iter().any(|ev| matches!(ev, WsEvent::ScheduledRemoved { id, sent_message_id: Some(m), .. } if *id == row.id && *m == sent)));
    }
    let (_, _, dm_sent) = status_of(db, dm.id).await;
    assert_eq!(
        num(
            db,
            &format!(
                "SELECT reply_to FROM messages WHERE id = {}",
                dm_sent.expect("sent")
            )
        )
        .await,
        quoted
    );
    assert_eq!(
        num(
            db,
            "SELECT COUNT(*) FROM pings WHERE username = 'bob' AND kind = 'mention'"
        )
        .await,
        1
    );
    assert_eq!(
        num(
            db,
            "SELECT COUNT(*) FROM pings WHERE username = 'bob' AND kind = 'reply'"
        )
        .await,
        1
    );
    let page = list(
        State(state.clone()),
        Authed(user(db, "alice").await),
        Query(ScheduledQuery {
            scope: None,
            status: None,
            after: None,
            limit: None,
        }),
    )
    .await
    .expect("list")
    .0;
    assert!(page.items.is_empty() && page.waiting == 0 && page.failed == 0);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn an_account_that_must_change_its_password_sends_nothing() {
    let (state, path) = temp_state("scheduled_temp_password").await;
    let db = &state.db;
    let p = place(&state).await;
    let t = ago(300);
    let row = due(&state, json!({ "channel_id": p.general }), "later", t).await;
    let before = num(db, "SELECT COUNT(*) FROM messages").await;
    sqlx::query(
        "INSERT INTO temp_passwords(username, issued_at, expires_at) VALUES('alice', $1, NULL)",
    )
    .bind(t)
    .execute(db)
    .await
    .expect("temp password");
    assert_eq!(run_due_at(&state, now()).await.expect("run"), 0);
    let (status, error, sent) = status_of(db, row.id).await;
    assert_eq!(
        (status.as_str(), error.as_deref(), sent),
        ("failed", Some(crate::api::CHANGE_FIRST), None)
    );
    assert_eq!(num(db, "SELECT COUNT(*) FROM messages").await, before);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn scheduled_send_checks_the_gate_at_send_time() {
    let (state, path) = temp_state("scheduled_gate").await;
    let db = &state.db;
    let p = place(&state).await;
    let target = post(&state, "bob", SendTo::Channel(p.general), "target").await;
    let other = num(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'other', 0) RETURNING id",
    )
    .await;
    let t = ago(300);
    let cases = [
        (json!({ "channel_id": other }), "deleted channel", GONE),
        (json!({ "thread_root_id": p.root }), "deleted root", GONE),
        (
            json!({ "channel_id": p.general, "reply_to": target }),
            "deleted target",
            "The message it replies to is gone",
        ),
        (
            json!({ "dm_id": p.dm }),
            "blocked",
            crate::api::blocks::NOT_ACCEPTING,
        ),
        (
            json!({ "channel_id": p.general }),
            "well fuck",
            "Content blocked by profanity filter",
        ),
    ];
    let mut rows = Vec::new();
    for (to, content, _) in &cases {
        rows.push(due(&state, to.clone(), content, t).await);
    }
    let left = due(&state, json!({ "channel_id": p.general }), "left", now()).await;
    let timed = due(&state, json!({ "channel_id": p.general }), "timed", now()).await;
    exec(db, &format!("DELETE FROM channels WHERE id = {other}")).await;
    exec(
        db,
        &format!("DELETE FROM messages WHERE id IN ({}, {target})", p.root),
    )
    .await;
    exec(
        db,
        "INSERT INTO blocks(blocker, blocked, created_at) VALUES('bob', 'alice', 1)",
    )
    .await;
    crate::api::test_util::profanity_on(db).await;
    let messages = num(db, "SELECT COUNT(*) FROM messages").await;
    let mut rx = state.hub.subscribe();
    run_due_at(&state, now()).await.expect("run");
    for ((_, content, reason), row) in cases.iter().zip(&rows) {
        assert_eq!(
            status_of(db, row.id).await,
            ("failed".to_string(), Some(reason.to_string()), None),
            "{content}"
        );
    }
    assert_eq!(scheduled_events(&drain(&mut rx)).len(), cases.len());
    exec(db, &format!("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'alice', {}, 0)", now() + 600)).await;
    exec(
        db,
        &format!(
            "UPDATE scheduled_messages SET next_at = 0 WHERE id = {}",
            timed.id
        ),
    )
    .await;
    run_due_at(&state, now()).await.expect("timed out");
    assert_eq!(
        status_of(db, timed.id).await.1.as_deref(),
        Some("You're timed out in that server")
    );
    exec(db, "DELETE FROM member_timeouts").await;
    exec(db, "DELETE FROM members WHERE username = 'alice'").await;
    exec(
        db,
        &format!(
            "UPDATE scheduled_messages SET next_at = 0 WHERE id = {}",
            left.id
        ),
    )
    .await;
    run_due_at(&state, now()).await.expect("left");
    let reason = status_of(db, left.id).await.1;
    assert!(
        matches!(
            reason.as_deref(),
            Some("You're not in this server anymore") | Some(GONE)
        ),
        "{reason:?}"
    );
    assert_eq!(num(db, "SELECT COUNT(*) FROM messages").await, messages);
    let evs = scheduled_events(&drain(&mut rx));
    assert_eq!(evs.len(), 2);
    assert!(
        evs.iter()
            .all(|(who, ev)| who == "alice" && ev["status"] == "failed" && ev["place"].is_null())
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn scheduled_slow_mode_defers_then_fails() {
    let (state, path) = temp_state("scheduled_slow").await;
    let db = &state.db;
    let p = place(&state).await;
    exec(
        db,
        &format!(
            "UPDATE channels SET slowmode_seconds = 60 WHERE id = {}",
            p.general
        ),
    )
    .await;
    let soon = due(&state, json!({ "channel_id": p.general }), "soon", ago(300)).await;
    let late = due(
        &state,
        json!({ "channel_id": p.general }),
        "late",
        ago(4000),
    )
    .await;
    post(&state, "alice", SendTo::Channel(p.general), "just now").await;
    let t = now();
    run_due_at(&state, t).await.expect("run");
    let r = load(db, soon.id).await.expect("load").expect("row");
    assert_eq!(
        (r.status, r.error.as_deref()),
        (Stored::Waiting, Some(WAITING_SLOW))
    );
    assert!(r.next_at > t && r.next_at <= t + 60, "{}", r.next_at);
    assert_eq!((r.due_at, r.attempts), (soon.at, 0));
    assert_eq!(
        status_of(db, late.id).await,
        ("failed".to_string(), Some(SLOW_FAILED.to_string()), None)
    );
    exec(
        db,
        "UPDATE messages SET created_at = created_at - 120 WHERE content = 'just now'",
    )
    .await;
    assert_eq!(run_due_at(&state, r.next_at).await.expect("later"), 1);
    assert_eq!(status_of(db, soon.id).await.0, "sent");
    crate::api::test_util::done(state, path).await;
}

#[test]
fn scheduled_retries_server_failures_with_backoff() {
    let failed: Result<Message, ApiError> = Err(ApiError::internal("test"));
    let busy: Result<Message, ApiError> = Err(ApiError::unavailable("busy", Some(1)));
    for (attempts, wait) in RETRY_BACKOFF_SECS.iter().enumerate() {
        assert_eq!(
            settle_of(&failed, 1000, attempts as i64 + 1, 2000),
            Settle::Retry(2000 + wait)
        );
        assert_eq!(
            settle_of(&busy, 1000, attempts as i64 + 1, 2000),
            Settle::Retry(2000 + wait)
        );
    }
    assert_eq!(
        settle_of(&failed, 1000, 6, 2000),
        Settle::Fail(SERVER_FAILED.to_string())
    );
    let slow: Result<Message, ApiError> = Err(ApiError::rate("Slow mode: wait 30s", Some(30)));
    assert_eq!(settle_of(&slow, 1000, 3, 2000), Settle::Defer(2030));
    assert_eq!(
        settle_of(&slow, 1000, 1, 1000 + DEFER_MAX_SECS),
        Settle::Fail(SLOW_FAILED.to_string())
    );
    let gone: Result<Message, ApiError> = Err(not_found());
    assert_eq!(settle_of(&gone, 0, 1, 0), Settle::Fail(GONE.to_string()));
    let other: Result<Message, ApiError> =
        Err(crate::api::bad("Message must be at most 4000 characters"));
    assert_eq!(
        settle_of(&other, 0, 1, 0),
        Settle::Fail("Message must be at most 4000 characters".to_string())
    );
}

async fn each(tag: &str) -> Vec<(AppState, TempDb, Place)> {
    let mut out = Vec::new();
    for (state, temp) in each_db(tag).await {
        let p = place(&state).await;
        out.push((state, temp, p));
    }
    out
}

#[tokio::test]
async fn scheduled_never_sends_twice_across_copies() {
    for (state, temp, p) in each("scheduled_copies").await {
        let db = &state.db;
        let t = ago(300);
        for n in 0..50 {
            due(
                &state,
                json!({ "channel_id": p.general }),
                &format!("n{n}"),
                t,
            )
            .await;
        }
        let other = AppState::new(
            db.clone(),
            crate::ws::Hub::new(),
            None,
            None,
            state.instance.clone(),
        );
        let at = now();
        let (a, b) = tokio::join!(run_due_at(&state, at), run_due_at(&other, at));
        assert_eq!(a.expect("a") + b.expect("b"), 50);
        assert_eq!(
            num(db, "SELECT COUNT(*) FROM messages WHERE content LIKE 'n%'").await,
            50
        );
        assert_eq!(
            num(db, "SELECT COUNT(DISTINCT sent_message_id) FROM scheduled_messages WHERE status = 'sent'").await,
            50
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn lapsed_claims_are_taken_over_once() {
    for (state, temp, p) in each("scheduled_lapsed").await {
        let db = &state.db;
        let row = due(&state, json!({ "channel_id": p.general }), "once", ago(300)).await;
        let t = now();
        let held = claim_due(db, row.id, Stored::Waiting, t)
            .await
            .expect("claim")
            .expect("claimed");
        assert!(
            claim_due(db, row.id, Stored::Waiting, t)
                .await
                .expect("again")
                .is_none()
        );
        assert_eq!(
            run_due_at(&state, t + 5).await.expect("within the lease"),
            0
        );
        assert_eq!(
            run_due_at(&state, t + LEASE_SECS + 1)
                .await
                .expect("taken over"),
            1
        );
        let alice = user(db, "alice").await;
        let late = send_to(
            &state,
            &alice,
            SendTo::Channel(p.general),
            SendReq::text("once".into(), None),
            Some(&held.claim),
        )
        .await;
        assert!(matches!(late, Err(ApiError(StatusCode::CONFLICT, ref m, _)) if m == BEING_SENT));
        assert_eq!(
            num(db, "SELECT COUNT(*) FROM messages WHERE content = 'once'").await,
            1
        );
        assert_eq!(status_of(db, row.id).await.0, "sent");
        temp.done(state).await;
    }
}

#[tokio::test]
async fn send_now_and_the_runner_race_once() {
    for (state, temp, p) in each("scheduled_race").await {
        let db = &state.db;
        let row = due(&state, json!({ "channel_id": p.general }), "race", ago(300)).await;
        let alice = user(db, "alice").await;
        let at = now();
        let (now_sent, run) = tokio::join!(
            send_now_at(&state, &alice, row.id, at),
            run_due_at(&state, at)
        );
        let by_now = now_sent.is_ok() as u64;
        assert_eq!(by_now + run.expect("run"), 1);
        assert_eq!(
            num(db, "SELECT COUNT(*) FROM messages WHERE content = 'race'").await,
            1
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn patch_and_delete_refuse_a_row_being_sent() {
    let (state, path) = temp_state("scheduled_busy").await;
    let db = &state.db;
    let p = place(&state).await;
    let row = due(&state, json!({ "channel_id": p.general }), "busy", ago(300)).await;
    let alice = user(db, "alice").await;
    claim_due(db, row.id, Stored::Waiting, now())
        .await
        .expect("claim")
        .expect("claimed");
    let edit = ScheduledPatch {
        content: Some("other".into()),
        at: None,
        resume: false,
        remove_reply: false,
    };
    let refused = patch_at(&state, &alice, row.id, edit, now())
        .await
        .map_err(refusal);
    assert_eq!(
        refused.err().map(|e| (e.0, e.1, e.2)),
        Some((409, BEING_SENT.to_string(), Some(ReasonKind::Conflict)))
    );
    let refused = delete(State(state.clone()), Authed(alice.clone()), Path(row.id))
        .await
        .map(|_| ())
        .map_err(refusal);
    assert_eq!(refused.err().map(|e| e.0), Some(409));
    assert!(send_now_at(&state, &alice, row.id, now()).await.is_err());
    exec(
        db,
        &format!(
            "UPDATE scheduled_messages SET status = 'sent' WHERE id = {}",
            row.id
        ),
    )
    .await;
    let edit = ScheduledPatch {
        content: Some("other".into()),
        at: None,
        resume: false,
        remove_reply: false,
    };
    let refused = patch_at(&state, &alice, row.id, edit, now())
        .await
        .map_err(refusal);
    assert_eq!(refused.err().map(|e| e.1), Some(ALREADY_SENT.to_string()));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn scheduled_routes_are_own_rows_only() {
    let (state, path) = temp_state("scheduled_own").await;
    let db = &state.db;
    let p = place(&state).await;
    let t = now();
    let row = due(&state, json!({ "channel_id": p.general }), "mine", t).await;
    let bob = user(db, "bob").await;
    let edit = ScheduledPatch {
        content: Some("theirs".into()),
        at: None,
        resume: false,
        remove_reply: false,
    };
    assert_eq!(
        patch_at(&state, &bob, row.id, edit, t)
            .await
            .map_err(refusal)
            .err()
            .map(|e| e.0),
        Some(404)
    );
    assert_eq!(
        send_now_at(&state, &bob, row.id, t)
            .await
            .map_err(refusal)
            .err()
            .map(|e| e.0),
        Some(404)
    );
    let deleted = delete(State(state.clone()), Authed(bob), Path(row.id))
        .await
        .map(|_| ())
        .map_err(refusal);
    assert_eq!(deleted.err().map(|e| e.0), Some(404));
    assert_eq!(status_of(db, row.id).await.0, "waiting");
    let alice = user(db, "alice").await;
    let edit = ScheduledPatch {
        content: Some("changed".into()),
        at: Some(t + 600),
        resume: false,
        remove_reply: true,
    };
    let edited = patch_at(&state, &alice, row.id, edit, t)
        .await
        .expect("own edit");
    assert_eq!(
        (edited.content.as_str(), edited.at, edited.next_at),
        ("changed", t + 600, t + 600)
    );
    let _ = delete(State(state.clone()), Authed(alice), Path(row.id))
        .await
        .expect("own delete");
    assert!(load(db, row.id).await.expect("load").is_none());
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn schedule_needs_the_send_gate() {
    let (state, path) = temp_state("scheduled_needs_gate").await;
    let db = &state.db;
    let p = place(&state).await;
    crate::db::NewUser::plain("dave").add(db).await;
    let t = now();
    let at = t + 120;
    let hidden = num(db, "INSERT INTO channels(server, name, created_at, restrict_view) VALUES('rchat', 'hidden', 0, 1) RETURNING id").await;
    let gated = |who: &'static str, to: Value| {
        let state = state.clone();
        async move {
            let mut body = to;
            body["content"] = json!("hi");
            body["at"] = json!(at);
            schedule(&state, who, body, t)
                .await
                .map(|_| ())
                .map_err(|e| (e.0, e.1))
        }
    };
    assert_eq!(
        gated("dave", json!({ "channel_id": p.general })).await,
        Err((403, "Not a member".to_string()))
    );
    for to in [
        json!({ "channel_id": hidden }),
        json!({ "channel_id": 999_999 }),
        json!({ "thread_root_id": 999_999 }),
    ] {
        assert_eq!(gated("alice", to).await.map_err(|e| e.0), Err(404));
    }
    assert_eq!(
        gated("carol", json!({ "dm_id": p.dm }))
            .await
            .map_err(|e| e.0),
        Err(404)
    );
    exec(
        db,
        &format!(
            "INSERT INTO channel_perms(channel_id, subject, can_send) VALUES({}, 'u:carol', 0)",
            p.general
        ),
    )
    .await;
    assert_eq!(
        gated("carol", json!({ "channel_id": p.general })).await,
        Err((403, "No permission to send in this channel".to_string()))
    );
    exec(db, &format!("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'bob', {}, 0)", now() + 600)).await;
    assert_eq!(
        gated("bob", json!({ "channel_id": p.general })).await,
        Err((403, TIMED_OUT.to_string()))
    );
    assert_eq!(
        gated("alice", json!({ "channel_id": p.general, "dm_id": p.dm }))
            .await
            .map_err(|e| e.0),
        Err(400)
    );
    assert!(
        gated("alice", json!({ "channel_id": p.general }))
            .await
            .is_ok()
    );
    assert!(gated("alice", json!({ "dm_id": p.dm })).await.is_ok());
    assert!(
        gated("alice", json!({ "thread_root_id": p.root }))
            .await
            .is_ok()
    );
    assert_eq!(num(db, "SELECT COUNT(*) FROM scheduled_messages").await, 3);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn scheduled_range_and_caps() {
    let (state, path) = temp_state("scheduled_caps").await;
    let p = place(&state).await;
    let t = now();
    let body = |at: i64| json!({ "channel_id": p.general, "content": "hi", "at": at });
    for at in [t + 59, t + SCHEDULE_MAX_SECS + 1] {
        let e = schedule(&state, "alice", body(at), t)
            .await
            .expect_err("refused");
        assert_eq!(
            (e.0, e.2, e.3.as_deref()),
            (400, Some(ReasonKind::Invalid), Some("at"))
        );
    }
    let blank = json!({ "channel_id": p.general, "content": "  ", "at": t + 60 });
    let e = schedule(&state, "alice", blank, t)
        .await
        .expect_err("blank");
    assert_eq!(e.3.as_deref(), Some("content"));
    let capped = state.clone().with_limits(Arc::new(Limits {
        scheduled_per_account: 2,
        ..Limits::default()
    }));
    let first = schedule(&capped, "alice", body(t + 60), t)
        .await
        .expect("one");
    schedule(&capped, "alice", body(t + SCHEDULE_MAX_SECS), t)
        .await
        .expect("two");
    let e = schedule(&capped, "alice", body(t + 90), t)
        .await
        .expect_err("three");
    assert_eq!(
        e,
        (
            400,
            "You can have at most 2 scheduled messages waiting".to_string(),
            Some(ReasonKind::Limit),
            Some("scheduled_per_account".to_string())
        )
    );
    schedule(&capped, "bob", body(t + 90), t)
        .await
        .expect("bob has his own");
    exec(
        &state.db,
        &format!(
            "UPDATE scheduled_messages SET status = 'failed', error = 'x' WHERE id = {}",
            first.id
        ),
    )
    .await;
    schedule(&capped, "alice", body(t + 90), t)
        .await
        .expect("a failed one does not count");
    let alice = user(&state.db, "alice").await;
    let revive = ScheduledPatch {
        content: None,
        at: Some(t + 300),
        resume: false,
        remove_reply: false,
    };
    let e = patch_at(&capped, &alice, first.id, revive, t)
        .await
        .map_err(refusal)
        .expect_err("revive counts");
    assert_eq!(e.2, Some(ReasonKind::Limit));
    let open = state.clone().with_limits(Arc::new(Limits {
        scheduled_per_account: 0,
        ..Limits::default()
    }));
    for n in 0..5 {
        schedule(&open, "alice", body(t + 100 + n), t)
            .await
            .expect("0 means no limit");
    }
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn switch_off_refuses_new_and_keeps_sending() {
    let (state, path) = temp_state("scheduled_switch").await;
    let db = &state.db;
    let p = place(&state).await;
    let t = ago(300);
    let sends = due(&state, json!({ "channel_id": p.general }), "still due", t).await;
    let kept = due(&state, json!({ "channel_id": p.general }), "kept", now()).await;
    let gone = due(&state, json!({ "channel_id": p.general }), "gone", now()).await;
    exec(
        db,
        "UPDATE settings SET value = '0' WHERE key = 'scheduled_messages'",
    )
    .await;
    Settings::forget(db);
    let e = due_refused(&state, p.general).await;
    assert_eq!(
        e,
        (
            403,
            TURNED_OFF.to_string(),
            Some(ReasonKind::OffSite),
            Some("scheduled_messages".to_string())
        )
    );
    assert_eq!(run_due_at(&state, now()).await.expect("run"), 1);
    assert_eq!(status_of(db, sends.id).await.0, "sent");
    let alice = user(db, "alice").await;
    let edit = ScheduledPatch {
        content: Some("edited".into()),
        at: None,
        resume: false,
        remove_reply: false,
    };
    patch_at(&state, &alice, kept.id, edit, now())
        .await
        .expect("edit");
    let sent = send_now_at(&state, &alice, kept.id, now())
        .await
        .expect("send now");
    assert_eq!(sent.content, "edited");
    let _ = delete(State(state.clone()), Authed(alice), Path(gone.id))
        .await
        .expect("delete");
    crate::api::test_util::done(state, path).await;
}

async fn due_refused(
    state: &AppState,
    channel: i64,
) -> (u16, String, Option<ReasonKind>, Option<String>) {
    let t = now();
    schedule(
        state,
        "alice",
        json!({ "channel_id": channel, "content": "new", "at": t + 60 }),
        t,
    )
    .await
    .expect_err("refused")
}

#[tokio::test]
async fn send_now_refused_keeps_the_row() {
    let (state, path) = temp_state("scheduled_send_now").await;
    let db = &state.db;
    let p = place(&state).await;
    let row = due(&state, json!({ "dm_id": p.dm }), "later", now()).await;
    exec(
        db,
        "INSERT INTO blocks(blocker, blocked, created_at) VALUES('bob', 'alice', 1)",
    )
    .await;
    let alice = user(db, "alice").await;
    let before = load(db, row.id).await.expect("load").expect("row");
    assert!(send_now_at(&state, &alice, row.id, now()).await.is_err());
    let after = load(db, row.id).await.expect("load").expect("row");
    assert_eq!(
        (after.status, after.next_at, after.attempts, after.error),
        (before.status, before.next_at, before.attempts, before.error)
    );
    exec(
        db,
        &format!(
            "UPDATE scheduled_messages SET status = 'failed', error = 'old' WHERE id = {}",
            row.id
        ),
    )
    .await;
    let mut rx = state.hub.subscribe();
    assert!(send_now_at(&state, &alice, row.id, now()).await.is_err());
    assert_eq!(
        status_of(db, row.id).await,
        (
            "failed".to_string(),
            Some(crate::api::blocks::NOT_ACCEPTING.to_string()),
            None
        )
    );
    assert_eq!(scheduled_events(&drain(&mut rx)).len(), 1);
    exec(db, "DELETE FROM blocks").await;
    let sent = send_now_at(&state, &alice, row.id, now())
        .await
        .expect("retry");
    assert_eq!(
        status_of(db, row.id).await,
        ("sent".to_string(), None, Some(sent.id))
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn list_labels_follow_access() {
    let (state, path) = temp_state("scheduled_labels").await;
    let db = &state.db;
    let p = place(&state).await;
    let side = num(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'side', 0) RETURNING id",
    )
    .await;
    let t = now();
    for n in 0..55 {
        let to = match n % 3 {
            0 => json!({ "channel_id": side }),
            1 => json!({ "dm_id": p.dm }),
            _ => json!({ "thread_root_id": p.root }),
        };
        let mut body = to;
        body["content"] = json!(format!("m{n}"));
        body["at"] = json!(t + 100 + n);
        schedule(&state, "alice", body, t).await.expect("schedule");
    }
    exec(
        db,
        &format!("UPDATE channels SET restrict_view = 1 WHERE id = {side}"),
    )
    .await;
    let alice = user(db, "alice").await;
    let page = |after: Option<String>, scope: Option<String>| {
        let state = state.clone();
        let alice = alice.clone();
        async move {
            list(
                State(state),
                Authed(alice),
                Query(ScheduledQuery {
                    scope,
                    status: None,
                    after,
                    limit: None,
                }),
            )
            .await
            .expect("list")
            .0
        }
    };
    let first = page(None, None).await;
    assert_eq!(
        (first.items.len(), first.waiting, first.failed),
        (50, 55, 0)
    );
    let second = page(first.next.clone(), None).await;
    assert_eq!((second.items.len(), second.next), (5, None));
    let ats: Vec<i64> = first
        .items
        .iter()
        .chain(&second.items)
        .map(|i| i.at)
        .collect();
    assert!(ats.windows(2).all(|w| w[0] < w[1]));
    for item in &first.items {
        match item.scope.chars().next() {
            Some('c') => assert!(item.place.is_none(), "a channel alice can't see"),
            Some('d') => assert_eq!(
                item.place
                    .as_ref()
                    .and_then(|pl| pl.dm_user.as_ref())
                    .map(|u| u.username.as_str()),
                Some("bob")
            ),
            _ => assert_eq!(
                item.place
                    .as_ref()
                    .and_then(|pl| pl.channel_name.as_deref()),
                Some("general")
            ),
        }
    }
    let dms = page(None, Some(format!("d{}", p.dm))).await;
    assert_eq!((dms.items.len() as i64, dms.waiting), (18, 18));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn sweep_drops_sent_after_7_days_and_failed_after_30() {
    let (state, path) = temp_state("scheduled_sweep").await;
    let db = &state.db;
    let t = now();
    for (status, finished) in [
        ("sent", t - SENT_KEEP - 1),
        ("sent", t - SENT_KEEP + 60),
        ("failed", t - SENT_KEEP - 1),
        ("failed", t - FAILED_KEEP - 1),
        ("waiting", t - FAILED_KEEP - 100),
    ] {
        exec(db, &format!("INSERT INTO scheduled_messages(username, content, due_at, next_at, status, created_at, updated_at, finished_at) VALUES('alice', 'x', 0, 0, '{status}', 0, 0, {finished})")).await;
    }
    let swept = crate::db::sweep_stale_at(db, &state.limits, t)
        .await
        .expect("sweep");
    assert_eq!(swept.scheduled_messages, 2);
    assert_eq!(
        num(
            db,
            "SELECT COUNT(*) FROM scheduled_messages WHERE status = 'waiting'"
        )
        .await,
        1
    );
    assert_eq!(num(db, "SELECT COUNT(*) FROM scheduled_messages").await, 3);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn account_deletion_and_bans_drop_scheduled_rows() {
    let (state, path) = temp_state("scheduled_purge").await;
    let db = &state.db;
    let p = place(&state).await;
    due(&state, json!({ "channel_id": p.general }), "alice", now()).await;
    let bobs = schedule(
        &state,
        "bob",
        json!({ "dm_id": p.dm, "content": "bob", "at": now() + 60 }),
        now(),
    )
    .await
    .expect("bob");
    let mut tx = db.begin().await.expect("tx");
    crate::api::admin::ban_in(&mut tx, "alice")
        .await
        .expect("ban");
    tx.commit().await.expect("commit");
    assert_eq!(
        num(
            db,
            "SELECT COUNT(*) FROM scheduled_messages WHERE username = 'alice'"
        )
        .await,
        0
    );
    exec(
        db,
        &format!(
            "UPDATE scheduled_messages SET next_at = 0 WHERE id = {}",
            bobs.id
        ),
    )
    .await;
    run_due_at(&state, now()).await.expect("run");
    assert_eq!(
        status_of(db, bobs.id).await,
        ("failed".to_string(), Some(GONE.to_string()), None),
        "the other side of a DM with a deleted account"
    );
    crate::api::test_util::done(state, path).await;
}

/// Turns encrypted storage on for the built-in server and the DM `dm`.
async fn seal_places(state: &AppState, dm: i64) {
    crate::api::seal::make_ready(state).await.expect("a key");
    exec(
        &state.db,
        "UPDATE servers SET seal = 1 WHERE name = 'rchat'",
    )
    .await;
    exec(
        &state.db,
        &format!("UPDATE dms SET seal = 1 WHERE id = {dm}"),
    )
    .await;
    crate::api::seal::forget_site(&state.db);
}

/// The stored text column of row `id` and its record.
async fn stored_text(db: &Db, id: i64) -> (String, Option<Vec<u8>>) {
    let r = sqlx::query("SELECT content, body FROM scheduled_messages WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("row");
    (r.try_get(0).expect("content"), r.try_get(1).expect("body"))
}

fn holds(record: &[u8], text: &str) -> bool {
    record.windows(text.len()).any(|w| w == text.as_bytes())
}

#[tokio::test]
async fn a_sealed_place_stores_no_plain_scheduled_text() {
    for (state, temp) in crate::api::test_util::each_db_keyed("scheduled_sealed").await {
        let db = &state.db;
        let Place { general, dm, root } = place(&state).await;
        let alice = user(db, "alice").await;
        seal_places(&state, dm).await;
        let t = now();
        let rows = [
            due(&state, json!({"channel_id": general}), "channel secret", t).await,
            due(&state, json!({"thread_root_id": root}), "thread secret", t).await,
            due(&state, json!({"dm_id": dm}), "dm secret", t).await,
        ];
        for (row, text) in rows
            .iter()
            .zip(["channel secret", "thread secret", "dm secret"])
        {
            assert_eq!(row.content, text, "the author reads it back");
            let (plain, record) = stored_text(db, row.id).await;
            assert_eq!(plain, "", "{text}: the column is blank");
            let record = record.expect("a record");
            assert!(!holds(&record, text), "{text}: the record is not the text");
        }
        assert_eq!(
            num(
                db,
                "SELECT COUNT(*) FROM scheduled_messages WHERE content <> '' OR body IS NULL"
            )
            .await,
            0
        );
        let listed = list(
            State(state.clone()),
            Authed(alice.clone()),
            Query(ScheduledQuery {
                scope: None,
                status: None,
                after: None,
                limit: None,
            }),
        )
        .await
        .expect("list")
        .0;
        let mut texts: Vec<_> = listed.items.iter().map(|m| m.content.clone()).collect();
        texts.sort();
        assert_eq!(texts, ["channel secret", "dm secret", "thread secret"]);

        let patch = ScheduledPatch {
            content: Some("edited secret".into()),
            at: None,
            resume: false,
            remove_reply: false,
        };
        let edited = patch_at(&state, &alice, rows[0].id, patch, t)
            .await
            .map_err(refusal)
            .expect("edit");
        assert_eq!(edited.content, "edited secret");
        let (plain, record) = stored_text(db, rows[0].id).await;
        assert_eq!(plain, "");
        assert!(!holds(&record.expect("a record"), "edited secret"));

        let moved = "UPDATE scheduled_messages SET body = (SELECT body FROM scheduled_messages WHERE id = $1) WHERE id = $2";
        sqlx::query(moved)
            .bind(rows[0].id)
            .bind(rows[1].id)
            .execute(db)
            .await
            .expect("swap");
        assert_eq!(run_due_at(&state, t + 61).await.expect("run"), 2);
        let sent: Vec<String> = {
            let ids: Vec<i64> = sqlx::query_scalar(
                "SELECT sent_message_id FROM scheduled_messages WHERE status = 'sent' ORDER BY id",
            )
            .fetch_all(db)
            .await
            .expect("sent");
            let mut out = Vec::new();
            for id in ids {
                let ring = crate::db::ring(db);
                let mut conn = db.acquire().await.expect("conn");
                let (_, _, opened) = crate::api::seal::stored_parts(ring, &mut conn, id)
                    .await
                    .expect("read")
                    .expect("message");
                drop(conn);
                out.push(opened.parts.content);
                assert_eq!(
                    num(db, &format!("SELECT COUNT(*) FROM messages WHERE id = {id} AND content = '' AND body IS NOT NULL")).await,
                    1,
                    "the posted message is stored sealed"
                );
            }
            out
        };
        assert_eq!(sent, ["edited secret", "dm secret"]);
        assert_eq!(
            status_of(db, rows[1].id).await,
            (
                "failed".to_string(),
                Some(stored::UNREADABLE.to_string()),
                None
            ),
            "a record of another row does not open, and nothing is sent"
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn waiting_rows_follow_a_place_into_and_out_of_sealed_storage() {
    for (state, temp) in crate::api::test_util::each_db_keyed("scheduled_pending").await {
        let db = &state.db;
        let Place {
            general,
            dm,
            root: _,
        } = place(&state).await;
        let t = now();
        let channel = due(
            &state,
            json!({"channel_id": general}),
            "before the switch",
            t,
        )
        .await;
        let direct = due(&state, json!({"dm_id": dm}), "dm before the switch", t).await;
        assert_eq!(
            stored_text(db, channel.id).await,
            ("before the switch".to_string(), None)
        );
        assert_eq!(seal_pending(db).await.map_err(refusal).expect("idle"), 0);
        seal_places(&state, dm).await;
        exec(
            db,
            &format!(
                "UPDATE scheduled_messages SET status = 'failed' WHERE id = {}",
                direct.id
            ),
        )
        .await;
        assert_eq!(seal_pending(db).await.map_err(refusal).expect("seal"), 2);
        assert_eq!(seal_pending(db).await.map_err(refusal).expect("again"), 0);
        for id in [channel.id, direct.id] {
            let (plain, record) = stored_text(db, id).await;
            assert_eq!(plain, "");
            assert!(record.is_some());
        }
        let alice = user(db, "alice").await;
        assert_eq!(
            own_row(db, &alice, channel.id)
                .await
                .map_err(refusal)
                .expect("row")
                .content
                .shown(),
            "before the switch"
        );
        let server = crate::api::seal::jobs::Target::Server("rchat".to_string());
        assert_eq!(
            still_sealed(db, &server)
                .await
                .map_err(refusal)
                .expect("count"),
            1
        );
        let all = crate::api::seal::jobs::Target::All;
        assert_eq!(
            still_sealed(db, &all)
                .await
                .map_err(refusal)
                .expect("count"),
            2
        );
        assert_eq!(
            unseal_pending(db, &server)
                .await
                .map_err(refusal)
                .expect("unseal"),
            1
        );
        assert_eq!(
            stored_text(db, channel.id).await,
            ("before the switch".to_string(), None)
        );
        assert!(
            stored_text(db, direct.id).await.1.is_some(),
            "another place stays"
        );
        let direct_place = crate::api::seal::jobs::Target::Dm(dm);
        assert_eq!(
            unseal_pending(db, &direct_place)
                .await
                .map_err(refusal)
                .expect("unseal"),
            1
        );
        assert_eq!(
            stored_text(db, direct.id).await,
            ("dm before the switch".to_string(), None)
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn ending_every_session_pauses_what_the_account_scheduled() {
    let (state, path) = temp_state("scheduled_paused").await;
    let db = &state.db;
    let p = place(&state).await;
    let alice = user(db, "alice").await;
    let t = now();
    let first = due(&state, json!({ "channel_id": p.general }), "first", t).await;
    let second = due(&state, json!({ "dm_id": p.dm }), "second", t).await;
    let failed = due(&state, json!({ "channel_id": p.general }), "failed", t).await;
    exec(
        db,
        &format!(
            "UPDATE scheduled_messages SET status = 'failed', error = 'Gone' WHERE id = {}",
            failed.id
        ),
    )
    .await;
    let flying = due(
        &state,
        json!({ "channel_id": p.general }),
        "in flight",
        t - 30,
    )
    .await;
    let claimed = claim_due(db, flying.id, Stored::Waiting, t + 31)
        .await
        .expect("claim")
        .expect("due");
    let others = due_as(
        &state,
        "bob",
        json!({ "channel_id": p.general }),
        "bob's",
        t,
    )
    .await;
    exec(
        db,
        "INSERT INTO tokens(token, username, created_at) VALUES('kept', 'alice', 1), ('gone', 'alice', 1), ('bobs', 'bob', 1)",
    )
    .await;

    let mut conn = db.acquire().await.expect("conn");
    let ended = crate::api::auth::end_sessions(&mut conn, "alice", Some("kept"), t + 5)
        .await
        .expect("end");
    drop(conn);
    assert_eq!(ended, 1);
    assert_eq!(
        num(
            db,
            "SELECT COUNT(*) FROM tokens WHERE token IN ('kept', 'bobs')"
        )
        .await,
        2
    );
    assert_eq!(status_of(db, first.id).await.0, "paused");
    assert_eq!(status_of(db, second.id).await.0, "paused");
    assert_eq!(status_of(db, failed.id).await.0, "failed");
    assert_eq!(status_of(db, flying.id).await.0, "paused");
    let before = num(db, "SELECT COUNT(*) FROM messages").await;
    let req = SendReq::text("in flight".into(), None);
    let to = SendTo::Channel(p.general);
    let lost = send_to(&state, &alice, to, req, Some(&claimed.claim)).await;
    assert!(lost.is_err(), "the send that was under way stores nothing");
    assert_eq!(num(db, "SELECT COUNT(*) FROM messages").await, before);
    let busy: Result<Message, ApiError> = Err(ApiError::unavailable("busy", Some(1)));
    let retry = settle_of(&busy, claimed.due_at, claimed.attempts, t + 32);
    settle(&state, &claimed.claim, "alice", retry, t + 32)
        .await
        .expect("settle");
    assert_eq!(
        status_of(db, flying.id).await.0,
        "paused",
        "a retry does not make it wait again"
    );
    assert_eq!(status_of(db, others.id).await.0, "waiting");

    assert_eq!(
        run_due_at(&state, t + 61).await.expect("run"),
        1,
        "only bob's"
    );
    assert_eq!(status_of(db, first.id).await.0, "paused");

    let page = list(
        State(state.clone()),
        Authed(alice.clone()),
        Query(ScheduledQuery {
            scope: None,
            status: Some("failed".into()),
            after: None,
            limit: None,
        }),
    )
    .await
    .expect("list")
    .0;
    assert_eq!((page.waiting, page.failed, page.items.len()), (0, 4, 4));
    assert_eq!(
        page.items
            .iter()
            .filter(|m| m.status == ScheduledStatus::Paused)
            .count(),
        3
    );

    let (code, text, _, _) = send_now_at(&state, &alice, first.id, t + 62)
        .await
        .map(|_| ())
        .map_err(refusal)
        .expect_err("paused");
    assert_eq!((code, text.as_str()), (409, PAUSED));

    let resume = |id: i64| {
        let (state, alice) = (state.clone(), alice.clone());
        async move {
            let patch = ScheduledPatch {
                content: None,
                at: None,
                resume: true,
                remove_reply: false,
            };
            patch_at(&state, &alice, id, patch, t + 70)
                .await
                .map_err(refusal)
        }
    };
    let resumed = resume(first.id).await.expect("resume");
    assert_eq!(resumed.status, ScheduledStatus::Waiting);
    assert_eq!((resumed.at, resumed.next_at), (first.at, first.at));
    let same = resume(failed.id).await.expect("a failed one stays");
    assert_eq!(same.status, ScheduledStatus::Failed);
    assert_eq!(run_due_at(&state, t + 71).await.expect("run"), 1);
    assert_eq!(status_of(db, first.id).await.0, "sent");

    let later = ScheduledPatch {
        content: None,
        at: Some(t + 500),
        resume: false,
        remove_reply: false,
    };
    let moved = patch_at(&state, &alice, second.id, later, t + 72)
        .await
        .map_err(refusal)
        .expect("a new time resumes");
    assert_eq!(
        (moved.status, moved.at),
        (ScheduledStatus::Waiting, t + 500)
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn a_paused_message_counts_against_the_cap_when_it_resumes() {
    let (state, path) = temp_state("scheduled_paused_cap").await;
    let state = state.with_limits(Arc::new(Limits {
        scheduled_per_account: 1,
        ..Limits::default()
    }));
    let db = &state.db;
    let p = place(&state).await;
    let alice = user(db, "alice").await;
    let t = now();
    let held = due(&state, json!({ "channel_id": p.general }), "held", t).await;
    let mut conn = db.acquire().await.expect("conn");
    crate::api::scheduled::pause_account(&mut conn, "alice", t)
        .await
        .expect("pause");
    drop(conn);
    due(&state, json!({ "channel_id": p.general }), "new", t).await;
    let patch = ScheduledPatch {
        content: None,
        at: None,
        resume: true,
        remove_reply: false,
    };
    let (code, _, kind, control) = patch_at(&state, &alice, held.id, patch, t)
        .await
        .map(|_| ())
        .map_err(refusal)
        .expect_err("full");
    assert_eq!(
        (code, kind, control.as_deref()),
        (400, Some(ReasonKind::Limit), Some("scheduled_per_account"))
    );
    assert_eq!(status_of(db, held.id).await.0, "paused");
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn a_server_failure_waits_out_each_backoff_step_then_fails() {
    let (state, path) = temp_state("scheduled_backoff_rows").await;
    let db = &state.db;
    let p = place(&state).await;
    let t = now();
    let row = due(&state, json!({ "channel_id": p.general }), "retry me", t).await;
    let failed: Result<Message, ApiError> = Err(ApiError::internal("test"));
    let mut at = t + 60;
    for (tried, wait) in RETRY_BACKOFF_SECS.iter().enumerate() {
        let claimed = claim_due(db, row.id, Stored::Waiting, at)
            .await
            .expect("claim")
            .expect("due");
        assert_eq!(claimed.attempts, tried as i64 + 1);
        let result = settle_of(&failed, claimed.due_at, claimed.attempts, at);
        assert_eq!(result, Settle::Retry(at + wait));
        settle(&state, &claimed.claim, "alice", result, at)
            .await
            .expect("settle");
        let r = load(db, row.id).await.expect("load").expect("row");
        assert_eq!(
            (r.status, r.next_at, r.attempts, r.due_at),
            (Stored::Waiting, at + wait, tried as i64 + 1, row.at)
        );
        assert!(
            claim_due(db, row.id, Stored::Waiting, at + wait - 1)
                .await
                .expect("early")
                .is_none(),
            "not before its wait is over"
        );
        at += wait;
    }
    let claimed = claim_due(db, row.id, Stored::Waiting, at)
        .await
        .expect("claim")
        .expect("due");
    let result = settle_of(&failed, claimed.due_at, claimed.attempts, at);
    assert_eq!(result, Settle::Fail(SERVER_FAILED.to_string()));
    settle(&state, &claimed.claim, "alice", result, at)
        .await
        .expect("settle");
    assert_eq!(
        status_of(db, row.id).await,
        ("failed".to_string(), Some(SERVER_FAILED.to_string()), None)
    );
    crate::api::test_util::done(state, path).await;
}
