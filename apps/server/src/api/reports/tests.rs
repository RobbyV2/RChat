use std::path::PathBuf;

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::Row;

use super::*;
use crate::api::admin;
use crate::api::test_util::{add_member, done, pg_done, pg_state, temp_state};
use crate::db::{NewUser, get_user};
use crate::limits::Limits;

pub(super) const HOUR: i64 = 3600;
pub(super) const DAY: i64 = 86400;
/// A time far from now, so the windows of a test never meet the clock.
pub(super) const T0: i64 = 2_000_000_000;

pub(super) async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

pub(super) async fn int(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
        .try_get(0)
        .expect("int")
}

pub(super) async fn text(db: &Db, sql: &str) -> String {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
        .try_get(0)
        .expect("text")
}

pub(super) async fn who(db: &Db, name: &str) -> User {
    get_user(db, name)
        .await
        .expect("user")
        .unwrap_or_else(|| panic!("{name} exists"))
}

pub(super) fn body(v: Value) -> CreateReport {
    serde_json::from_value(v).expect("report body")
}

/// The status and text of a refusal.
pub(super) fn refusal<T: std::fmt::Debug>(res: Result<T, ApiError>) -> (u16, String) {
    match res {
        Err(ApiError(status, text, _)) => (status.as_u16(), text),
        Ok(got) => panic!("accepted: {got:?}"),
    }
}

/// The whole answer of a refusal as a client gets it.
pub(super) async fn wire<T: std::fmt::Debug>(res: Result<T, ApiError>) -> (u16, String) {
    use axum::response::IntoResponse;
    let res = match res {
        Err(e) => e.into_response(),
        Ok(got) => panic!("accepted: {got:?}"),
    };
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .expect("body");
    (status, String::from_utf8(bytes.to_vec()).expect("utf8"))
}

pub(super) async fn message(db: &Db, channel: i64, author: &str, content: &str, at: i64) -> i64 {
    sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, $2, $3, $4) RETURNING id")
        .bind(channel)
        .bind(author)
        .bind(content)
        .bind(at)
        .fetch_one(db)
        .await
        .expect("message")
        .try_get(0)
        .expect("id")
}

pub(super) struct World {
    pub state: AppState,
    pub general: i64,
    pub ops: i64,
    pub mods: i64,
}

/// The server `s` ("Server S", made by olga) with the members alice, bob, carol, dave and mo
/// (role `mod`: Manage reports) and the channels #general and #ops, which only olga and the
/// role `staff` (nobody) may view. `hush` is a password server with zed in it. erin and zed
/// share nothing with alice. root is the site admin and a member of nothing.
pub(super) async fn fill(state: AppState) -> World {
    let db = &state.db;
    for name in [
        "olga", "alice", "bob", "carol", "dave", "mo", "erin", "zed", "frank", "gina",
    ] {
        NewUser::plain(name).add(db).await;
    }
    NewUser {
        is_site_admin: true,
        ..NewUser::plain("root")
    }
    .add(db)
    .await;
    exec(
        db,
        "UPDATE users SET display_name = 'Bob B' WHERE username = 'bob'",
    )
    .await;
    exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('s', 'Server S', 'olga', 0)").await;
    exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('hush', 'Hush', 'zed', 'x', 0)").await;
    let general = int(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('s', 'general', 0) RETURNING id",
    )
    .await;
    let ops = int(db, "INSERT INTO channels(server, name, restrict_view, created_at) VALUES('s', 'ops', 1, 0) RETURNING id").await;
    add_member(db, "s", "olga", 1, 0, 0).await;
    for name in ["alice", "bob", "carol", "dave", "mo", "frank", "gina"] {
        add_member(db, "s", name, 0, 0, 0).await;
    }
    add_member(db, "hush", "zed", 1, 0, 0).await;
    let mods = int(db, "INSERT INTO roles(server, name, color, perms) VALUES('s', 'mod', '#ffffff', 512) RETURNING id").await;
    let staff = int(db, "INSERT INTO roles(server, name, color, perms) VALUES('s', 'staff', '#ffffff', 0) RETURNING id").await;
    exec(
        db,
        &format!("INSERT INTO user_roles(server, username, role_id) VALUES('s', 'mo', {mods})"),
    )
    .await;
    exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({ops}, 'r:{staff}', 1, 1, 1)")).await;
    World {
        state,
        general,
        ops,
        mods,
    }
}

pub(super) async fn world(tag: &str) -> (World, PathBuf) {
    let (state, path) = temp_state(tag).await;
    (fill(state).await, path)
}

impl World {
    pub(super) fn db(&self) -> &Db {
        &self.state.db
    }

    /// Sends `req` as `by` at `t`.
    pub(super) async fn send(&self, by: &str, req: Value, t: i64) -> Result<Created, ApiError> {
        let user = who(self.db(), by).await;
        create_at(&self.state, &user, body(req), t).await
    }

    pub(super) async fn with_limits(self, limits: Limits) -> World {
        World {
            state: self.state.with_limits(std::sync::Arc::new(limits)),
            ..self
        }
    }
}

fn member(name: &str) -> Value {
    json!({"kind": "member", "server": "s", "username": name})
}

#[tokio::test]
async fn a_server_message_report_keeps_its_evidence() {
    let (w, path) = world("reports_evidence").await;
    let db = w.db();
    for n in 1..=5 {
        message(db, w.general, "carol", &format!("before {n}"), 100 + n).await;
    }
    let reported = message(db, w.general, "bob", "buy my coins", 200).await;
    message(db, w.general, "carol", "after", 300).await;
    let mut events = w.state.hub.subscribe();
    let id = w
        .send(
            "alice",
            json!({"to": "server", "target": {"kind": "message", "id": reported}, "reason": "spam", "note": "x", "context": 3}),
            T0,
        )
        .await
        .expect("report")
        .id;
    let row = sqlx::query("SELECT kind, server, server_name, target_kind, target_key, target_user, message_id, channel_id, channel_private, reporter, form, form_label, form_rev, reason, reason_label, note, answers, snapshot, status, created_at, updated_at, role_id FROM reports WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("row");
    let col = |n: usize| row.try_get::<Option<String>, _>(n).expect("text");
    assert_eq!(col(0).as_deref(), Some("server"));
    assert_eq!(col(1).as_deref(), Some("s"));
    assert_eq!(col(2).as_deref(), Some("Server S"));
    assert_eq!(col(3).as_deref(), Some("message"));
    assert_eq!(col(4).as_deref(), Some("u:bob"));
    assert_eq!(col(5).as_deref(), Some("bob"));
    assert_eq!(row.try_get::<i64, _>(6).expect("message"), reported);
    assert_eq!(row.try_get::<i64, _>(7).expect("channel"), w.general);
    assert_eq!(row.try_get::<i64, _>(8).expect("private"), 0);
    assert_eq!(col(9).as_deref(), Some("alice"));
    assert_eq!(col(10).as_deref(), Some("message"));
    assert_eq!(col(11).as_deref(), Some("Report message"));
    assert_eq!(row.try_get::<i64, _>(12).expect("rev"), 1);
    assert_eq!(col(13).as_deref(), Some("spam"));
    assert_eq!(col(14).as_deref(), Some("Spam"));
    assert_eq!(col(15), None, "the note is the answer to details");
    let answers: Value = serde_json::from_str(&col(16).expect("answers")).expect("json");
    assert_eq!(
        answers,
        json!([{"id": "details", "label": "Note", "kind": "long_text", "value": "x"}])
    );
    let stored = col(17).expect("snapshot");
    let snapshot: Snapshot = serde_json::from_str(&stored).expect("snapshot");
    let shown = snapshot.message.as_ref().expect("message");
    assert_eq!(
        (shown.id, shown.content.as_str()),
        (reported, "buy my coins")
    );
    assert_eq!(
        shown.author,
        Some(SnapUser::named("bob", "Bob B")),
        "the names at report time"
    );
    assert_eq!(snapshot.channel.as_deref(), Some("general"));
    assert_eq!(
        snapshot
            .context
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        ["before 3", "before 4", "before 5"],
        "the 3 newest earlier messages, oldest first"
    );
    assert_eq!(col(18).as_deref(), Some("open"));
    assert_eq!(
        (
            row.try_get::<i64, _>(19).expect("created"),
            row.try_get::<i64, _>(20).expect("updated")
        ),
        (T0, T0)
    );
    assert_eq!(row.try_get::<Option<i64>, _>(21).expect("role"), None);
    assert_eq!(
        text(db, &format!("SELECT kind || '|' || COALESCE(actor, '-') FROM report_events WHERE report_id = {id}")).await,
        "created|-",
        "the history starts without naming the reporter"
    );
    let sent = events.try_recv().expect("an event");
    assert_eq!(
        serde_json::to_value(&sent).expect("json"),
        json!({"type": "reports_changed", "server": "s"}),
        "the event carries only the server"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&crate::ws::to_bus_json(&sent).expect("json")).expect("json"),
        json!({"type": "reports_changed", "server": "s", "about": "bob", "channel": [w.general, false]}),
        "between the copies of the server it also says who must not get it"
    );

    exec(
        db,
        &format!(
            "UPDATE messages SET content = 'nothing to see', edited_at = 400 WHERE id = {reported}"
        ),
    )
    .await;
    exec(db, &format!("DELETE FROM messages WHERE id = {reported}")).await;
    assert_eq!(
        text(db, &format!("SELECT snapshot FROM reports WHERE id = {id}")).await,
        stored,
        "edits and deletes leave the evidence as it was"
    );

    exec(
        db,
        &format!(
            "INSERT INTO user_roles(server, username, role_id) VALUES('s', 'carol', {})",
            w.mods
        ),
    )
    .await;
    let hook = int(db, &format!("INSERT INTO messages(channel_id, author, content, webhook_id, webhook_name, created_at) VALUES({}, '@webhook:7', 'beep', 7, 'Builds', 500) RETURNING id", w.general)).await;
    let about_role = w
        .send(
            "alice",
            json!({"to": "instance", "target": member("carol"), "reason": "hate"}),
            T0,
        )
        .await
        .expect("member")
        .id;
    assert_eq!(
        text(db, &format!("SELECT kind || '|' || server || '|' || role_name || '|' || CAST(role_id AS TEXT) FROM reports WHERE id = {about_role}")).await,
        format!("instance|s|mod|{}", w.mods),
        "the member's first role at report time"
    );
    let by_hook = w
        .send(
            "alice",
            json!({"to": "server", "target": {"kind": "message", "id": hook}, "reason": "spam"}),
            T0,
        )
        .await
        .expect("webhook post")
        .id;
    assert_eq!(
        text(db, &format!("SELECT target_key || '|' || COALESCE(target_user, '-') FROM reports WHERE id = {by_hook}")).await,
        "u:@webhook:7|-"
    );
    let snapshot: Snapshot = serde_json::from_str(
        &text(
            db,
            &format!("SELECT snapshot FROM reports WHERE id = {by_hook}"),
        )
        .await,
    )
    .expect("snapshot");
    let post = snapshot.message.expect("post");
    assert_eq!(
        (post.author, post.webhook.as_deref()),
        (None, Some("Builds"))
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn context_takes_only_what_the_reporter_may_read() {
    let (w, path) = world("reports_context").await;
    let db = w.db();
    exec(
        db,
        "UPDATE members SET joined_at = 250 WHERE server = 's' AND username = 'alice'",
    )
    .await;
    exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({}, 'u:alice', 1, 1, 0)", w.general)).await;
    for n in 1..=4 {
        message(db, w.general, "carol", &format!("m{n}"), 100 * n).await;
    }
    exec(db, &format!("INSERT INTO messages(channel_id, author, content, kind, created_at) VALUES({}, 'dave', '', 'join', 410)", w.general)).await;
    let reported = message(db, w.general, "bob", "bad", 500).await;
    let context_of = |id: i64| async move {
        let snapshot: Snapshot = serde_json::from_str(
            &text(db, &format!("SELECT snapshot FROM reports WHERE id = {id}")).await,
        )
        .expect("snapshot");
        snapshot
            .context
            .into_iter()
            .map(|m| m.content)
            .collect::<Vec<_>>()
    };
    let id = w
        .send("alice", json!({"to": "server", "target": {"kind": "message", "id": reported}, "reason": "spam", "context": 10}), T0)
        .await
        .expect("report")
        .id;
    assert_eq!(
        context_of(id).await,
        ["m3", "m4"],
        "nothing from before alice may read, and no join message"
    );

    let root = message(db, w.general, "carol", "root", 600).await;
    let mut replies = Vec::new();
    for n in 1..=3 {
        replies.push(int(db, &format!("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES({}, {root}, 'dave', 'r{n}', {}) RETURNING id", w.general, 600 + n)).await);
    }
    message(db, w.general, "carol", "elsewhere", 650).await;
    let id = w
        .send("alice", json!({"to": "server", "target": {"kind": "message", "id": replies[2]}, "reason": "spam", "context": 10}), T0)
        .await
        .expect("reply")
        .id;
    assert_eq!(
        context_of(id).await,
        ["root", "r1", "r2"],
        "the thread's own"
    );

    let none = w
        .send("alice", json!({"to": "instance", "target": {"kind": "message", "id": reported}, "reason": "spam"}), T0)
        .await
        .expect("no context")
        .id;
    assert!(context_of(none).await.is_empty());
    assert_eq!(
        refusal(
            w.send("alice", json!({"to": "server", "target": {"kind": "message", "id": root}, "reason": "spam", "context": 11}), T0)
                .await
        ),
        (400, "Context must be 0 to 10 messages".to_string())
    );

    let dm = int(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    for (n, author) in ["bob", "alice", "bob"].iter().enumerate() {
        exec(db, &format!("INSERT INTO messages(dm_id, author, content, created_at) VALUES({dm}, '{author}', 'd{n}', {})", 700 + n)).await;
    }
    let last = int(
        db,
        &format!("SELECT MAX(id) FROM messages WHERE dm_id = {dm}"),
    )
    .await;
    let id = w
        .send("alice", json!({"to": "instance", "target": {"kind": "message", "id": last}, "reason": "harassment", "context": 5}), T0 + 10 * DAY)
        .await
        .expect("dm")
        .id;
    assert_eq!(context_of(id).await, ["d0", "d1"]);
    assert_eq!(
        text(db, &format!("SELECT COALESCE(server, '-') || '|' || CAST(dm_id AS TEXT) FROM reports WHERE id = {id}")).await,
        format!("-|{dm}")
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn targets_follow_the_kind_rules() {
    let (w, path) = world("reports_kinds").await;
    let db = w.db();
    let in_channel = message(db, w.general, "bob", "one", 100).await;
    let dm = int(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id",
    )
    .await;
    let in_dm = int(db, &format!("INSERT INTO messages(dm_id, author, content, created_at) VALUES({dm}, 'carol', 'two', 100) RETURNING id")).await;
    let instance_only = (400, INSTANCE_ONLY.to_string());
    let cases = [
        (
            json!({"kind": "message", "id": in_channel}),
            true,
            "message",
            "u:bob",
        ),
        (
            json!({"kind": "message", "id": in_dm}),
            false,
            "message",
            "u:carol",
        ),
        (member("dave"), true, "user", "u:dave"),
        (
            json!({"kind": "account", "username": "Frank"}),
            false,
            "user",
            "u:frank",
        ),
        (
            json!({"kind": "server", "server": "S"}),
            false,
            "server",
            "s:s",
        ),
    ];
    for (n, (target, to_server, kind, key)) in cases.into_iter().enumerate() {
        let t = T0 + n as i64 * 10 * DAY;
        let res = w
            .send(
                "alice",
                json!({"to": "server", "target": target, "reason": "spam"}),
                t,
            )
            .await;
        match to_server {
            true => {
                let id = res.expect("to the server").id;
                assert_eq!(
                    text(db, &format!("SELECT kind || '|' || target_kind || '|' || target_key FROM reports WHERE id = {id}")).await,
                    format!("server|{kind}|{key}")
                );
            }
            false => assert_eq!(refusal(res), instance_only, "{target}"),
        }
        let id = w
            .send(
                "alice",
                json!({"to": "instance", "target": target, "reason": "spam"}),
                t,
            )
            .await
            .unwrap_or_else(|e| panic!("{target} to the instance: {e:?}"))
            .id;
        assert_eq!(
            text(db, &format!("SELECT kind || '|' || target_kind || '|' || target_key FROM reports WHERE id = {id}")).await,
            format!("instance|{kind}|{key}")
        );
    }
    let about_server: Snapshot = serde_json::from_str(
        &text(
            db,
            "SELECT snapshot FROM reports WHERE target_kind = 'server'",
        )
        .await,
    )
    .expect("snapshot");
    let server = about_server.server.expect("server");
    assert_eq!(
        (
            server.name.as_str(),
            server.display_name.as_str(),
            server.creator.as_deref(),
            server.member_count,
            server.has_password
        ),
        ("s", "Server S", Some("olga"), 8, false)
    );
    assert_eq!(
        refusal(
            w.send("alice", json!({"to": "server", "target": {"kind": "none"}, "form": "bug", "answers": [{"id": "summary", "value": "x"}]}), T0)
                .await
        ),
        instance_only
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn invisible_targets_are_uniform_404s() {
    let (w, path) = world("reports_404").await;
    let db = w.db();
    let hidden = message(db, w.ops, "olga", "secret", 100).await;
    let dm = int(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('bob', 'carol') RETURNING id",
    )
    .await;
    let theirs = int(db, &format!("INSERT INTO messages(dm_id, author, content, created_at) VALUES({dm}, 'carol', 'private', 100) RETURNING id")).await;
    exec(
        db,
        "UPDATE users SET password_hash = '!purging' WHERE username = 'gina'",
    )
    .await;
    let ask = |target: Value, to: &'static str| {
        let w = &w;
        async move {
            wire(
                w.send(
                    "alice",
                    json!({"to": to, "target": target, "reason": "spam"}),
                    T0,
                )
                .await,
            )
            .await
        }
    };
    let not_found = (404, r#"{"error":"Not found"}"#.to_string());
    let denied = (
        404,
        r#"{"error":"Server not found or wrong password"}"#.to_string(),
    );
    for to in ["server", "instance"] {
        assert_eq!(
            ask(json!({"kind": "message", "id": hidden}), to).await,
            not_found
        );
        assert_eq!(
            ask(json!({"kind": "message", "id": theirs}), to).await,
            not_found
        );
        assert_eq!(
            ask(json!({"kind": "message", "id": 999_999}), to).await,
            not_found
        );
        assert_eq!(
            ask(
                json!({"kind": "member", "server": "hush", "username": "zed"}),
                to
            )
            .await,
            denied
        );
        assert_eq!(
            ask(
                json!({"kind": "member", "server": "nowhere", "username": "zed"}),
                to
            )
            .await,
            denied
        );
        assert_eq!(
            ask(json!({"kind": "server", "server": "hush"}), to).await,
            denied
        );
        assert_eq!(
            ask(json!({"kind": "server", "server": "nowhere"}), to).await,
            denied
        );
        for name in ["erin", "nobody", "gina", "zed"] {
            assert_eq!(
                ask(json!({"kind": "account", "username": name}), to).await,
                not_found,
                "{name}: hidden, missing and being deleted answer alike"
            );
        }
        for name in ["erin", "nobody", "gina"] {
            assert_eq!(
                ask(member(name), to).await,
                not_found,
                "{name} is no member"
            );
        }
    }
    assert_eq!(int(db, "SELECT COUNT(*) FROM reports").await, 0);
    exec(db, "INSERT INTO friends(username, friend, created_at) VALUES('alice', 'erin', 0), ('erin', 'alice', 0)").await;
    w.send("alice", json!({"to": "instance", "target": {"kind": "account", "username": "erin"}, "reason": "spam"}), T0)
        .await
        .expect("a friend is visible");
    done(w.state, path).await;
}

#[tokio::test]
async fn self_and_system_messages_are_refused() {
    let (w, path) = world("reports_self").await;
    let db = w.db();
    let mine = message(db, w.general, "alice", "me", 100).await;
    let join = int(db, &format!("INSERT INTO messages(channel_id, author, content, kind, created_at) VALUES({}, 'bob', '', 'join', 100) RETURNING id", w.general)).await;
    let theirs = message(db, w.general, "bob", "x", 100).await;
    let myself = (400, SELF_REPORT.to_string());
    for target in [
        json!({"kind": "message", "id": mine}),
        member("alice"),
        json!({"kind": "account", "username": "ALICE"}),
    ] {
        assert_eq!(
            refusal(
                w.send(
                    "alice",
                    json!({"to": "instance", "target": target, "reason": "spam"}),
                    T0
                )
                .await
            ),
            myself,
            "{target}"
        );
    }
    assert_eq!(
        refusal(w.send("alice", json!({"to": "server", "target": {"kind": "message", "id": join}, "reason": "spam"}), T0).await),
        (400, NOT_REPORTABLE.to_string())
    );
    let noted = |note: String| json!({"to": "server", "target": {"kind": "message", "id": theirs}, "reason": "spam", "note": note});
    assert_eq!(
        refusal(w.send("alice", noted("a".repeat(1001)), T0).await),
        (400, "Note must be at most 1000 characters".to_string())
    );
    w.send("alice", noted("a".repeat(1000)), T0)
        .await
        .expect("1,000 characters pass");
    assert_eq!(
        refusal(
            w.send(
                "alice",
                json!({"to": "server", "target": member("bob")}),
                T0 + 10 * DAY
            )
            .await
        ),
        (400, "Missing required field: reason".to_string())
    );
    let e = w
        .send(
            "alice",
            json!({"to": "instance", "target": member("alice"), "reason": "spam"}),
            T0,
        )
        .await
        .expect_err("refused");
    assert_eq!(
        e.2.map(|r| (r.kind, r.field)),
        Some((
            crate::api::error::ReasonKind::Invalid,
            Some("target".to_string())
        ))
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn limits_per_kind() {
    let (w, path) = world("reports_limits").await;
    let db = w.db();
    let over = (429, OVER_LIMIT.to_string());
    let to = |to: &str, name: &str| json!({"to": to, "target": member(name), "reason": "spam"});
    w.send("alice", to("server", "bob"), T0)
        .await
        .expect("first");
    assert_eq!(
        refusal(w.send("alice", to("server", "bob"), T0 + 71 * HOUR).await),
        over,
        "the same target inside 72 hours"
    );
    let bobs = message(db, w.general, "bob", "x", 100).await;
    assert_eq!(
        refusal(
            w.send("alice", json!({"to": "server", "target": {"kind": "message", "id": bobs}, "reason": "spam"}), T0 + HOUR)
                .await
        ),
        over,
        "a message of bob's is the same target"
    );
    w.send("alice", to("instance", "bob"), T0 + HOUR)
        .await
        .expect("the instance kind counts apart");
    w.send("alice", to("server", "bob"), T0 + 73 * HOUR)
        .await
        .expect("after 72 hours");
    let e = w
        .send("alice", to("server", "bob"), T0 + 74 * HOUR)
        .await
        .expect_err("refused");
    assert_eq!(
        e.2.map(|r| (r.kind, r.control)),
        Some((crate::api::error::ReasonKind::Rate, None)),
        "the answer names no limit"
    );

    let t = T0 + 30 * DAY;
    for name in ["bob", "carol", "dave"] {
        w.send("mo", to("server", name), t).await.expect(name);
    }
    assert_eq!(
        refusal(w.send("mo", to("server", "frank"), t + DAY - 1).await),
        over,
        "a 4th target inside 24 hours"
    );
    w.send("mo", to("server", "frank"), t + DAY + 1)
        .await
        .expect("after 24 hours");

    let caps = Limits {
        report_same_target_hours: 0,
        report_targets_per_day: 0,
        ..Limits::default()
    };
    let w = w.with_limits(caps).await;
    let t = T0 + 60 * DAY;
    for n in 0..10 {
        w.send("carol", to("server", "bob"), t + n * HOUR)
            .await
            .unwrap_or_else(|e| panic!("report {n}: {e:?}"));
    }
    assert_eq!(
        refusal(w.send("carol", to("server", "bob"), t + 7 * DAY - 1).await),
        over,
        "the 11th inside 7 days"
    );
    w.send("carol", to("server", "bob"), t + 7 * DAY + 1)
        .await
        .expect("the first has aged out");

    exec(
        &w.state.db,
        "UPDATE reports SET escalated_from = id WHERE reporter = 'carol'",
    )
    .await;
    for n in 0..10 {
        w.send("carol", to("server", "bob"), t + 7 * DAY + 2 + n)
            .await
            .expect("escalated copies never count");
    }
    done(w.state, path).await;
}

#[tokio::test]
async fn caps_of_zero_mean_no_cap() {
    let (w, path) = world("reports_no_caps").await;
    let w = w
        .with_limits(Limits {
            report_same_target_hours: 0,
            report_targets_per_day: 0,
            report_max_per_week: 0,
            report_feedback_per_week: 0,
            ..Limits::default()
        })
        .await;
    for n in 0..30 {
        w.send(
            "alice",
            json!({"to": "server", "target": member("bob"), "reason": "spam"}),
            T0 + n * 60,
        )
        .await
        .unwrap_or_else(|e| panic!("report {n}: {e:?}"));
        w.send("alice", json!({"to": "instance", "target": {"kind": "none"}, "form": "bug", "answers": [{"id": "summary", "value": "x"}]}), T0 + n * 60)
            .await
            .unwrap_or_else(|e| panic!("bug {n}: {e:?}"));
    }
    assert_eq!(int(w.db(), "SELECT COUNT(*) FROM reports").await, 60);
    done(w.state, path).await;
}

async fn burst(state: AppState) {
    let w = fill(state).await;
    let db = w.db().clone();
    for n in 0..20 {
        NewUser::plain(&format!("t{n}")).add(&db).await;
        add_member(&db, "s", &format!("t{n}"), 0, 0, 0).await;
    }
    let alice = who(&db, "alice").await;
    let mut jobs = Vec::new();
    for n in 0..20 {
        let (state, alice) = (w.state.clone(), alice.clone());
        jobs.push(tokio::spawn(async move {
            let req =
                body(json!({"to": "server", "target": member(&format!("t{n}")), "reason": "spam"}));
            create_at(&state, &alice, req, T0).await
        }));
    }
    let (mut sent, mut refused) = (0, 0);
    for job in jobs {
        match job.await.expect("join") {
            Ok(_) => sent += 1,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, text, _)) if text == OVER_LIMIT => {
                refused += 1
            }
            Err(e) => panic!("another answer: {e:?}"),
        }
    }
    assert_eq!((sent, refused), (3, 17));
    assert_eq!(int(&db, "SELECT COUNT(*) FROM reports").await, 3);
    assert_eq!(int(&db, "SELECT COUNT(*) FROM report_events").await, 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_reports_stop_at_the_cap() {
    let (state, path) = temp_state("reports_burst").await;
    burst(state.clone()).await;
    done(state, path).await;
    if let Some((state, temp)) = pg_state("reports_burst").await {
        burst(state.clone()).await;
        pg_done(state, temp).await;
    }
}

#[tokio::test]
async fn muted_reporters_get_the_limit_answer() {
    let (w, path) = world("reports_muted").await;
    let db = w.db();
    exec(db, "INSERT INTO report_mutes(server, username, muted_by, created_at) VALUES('s', 'alice', 'mo', 0)").await;
    let to = |to: &str| json!({"to": to, "target": member("bob"), "reason": "spam"});
    let muted = wire(w.send("alice", to("server"), T0).await).await;
    w.send("carol", to("server"), T0).await.expect("carol");
    let capped = wire(w.send("carol", to("server"), T0 + 1).await).await;
    assert_eq!(muted, capped, "a mute answers as a cap does");
    assert_eq!(muted.0, 429);
    assert_eq!(
        int(db, "SELECT COUNT(*) FROM reports WHERE reporter = 'alice'").await,
        0
    );
    w.send("alice", to("instance"), T0)
        .await
        .expect("the instance kind is not muted");
    exec(
        db,
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('t', 'T', 'zed', 0)",
    )
    .await;
    add_member(db, "t", "zed", 1, 0, 0).await;
    add_member(db, "t", "alice", 0, 0, 0).await;
    w.send("alice", json!({"to": "server", "target": {"kind": "member", "server": "t", "username": "zed"}, "reason": "spam"}), T0)
        .await
        .expect("a mute in one server leaves her reports to another server's moderators alone");
    exec(
        db,
        "INSERT INTO instance_report_mutes(username, created_at) VALUES('dave', 0)",
    )
    .await;
    assert_eq!(wire(w.send("dave", to("instance"), T0).await).await, muted);
    assert_eq!(
        wire(
            w.send("dave", json!({"to": "instance", "target": {"kind": "none"}, "form": "bug", "answers": [{"id": "summary", "value": "x"}]}), T0)
                .await
        )
        .await,
        muted,
        "muted for feedback of that kind too"
    );
    w.send("dave", to("server"), T0)
        .await
        .expect("dave to the server");
    done(w.state, path).await;
}

#[tokio::test]
async fn a_report_that_names_nothing_visible_counts_as_a_lookup_miss() {
    let (w, path) = world("reports_misses").await;
    let w = w
        .with_limits(Limits {
            lookup_misses_per_hour: 2,
            ..Limits::default()
        })
        .await;
    let alice = who(w.db(), "alice").await;
    let about = |name: &'static str| {
        let (state, alice) = (w.state.clone(), alice.clone());
        async move {
            let req = json!({"to": "instance", "target": {"kind": "account", "username": name}, "reason": "spam"});
            create_report(State(state), Authed(alice), Json(body(req)))
                .await
                .map(|Json(created)| created)
        }
    };
    let not_found = (404, "Not found".to_string());
    assert_eq!(refusal(about("nobody").await), not_found, "no such account");
    about("bob")
        .await
        .expect("a report that is sent is no miss");
    assert_eq!(
        refusal(about("erin").await),
        not_found,
        "an account she can't see, as the second miss"
    );
    assert_eq!(
        refusal(about("carol").await),
        (429, lookup::TOO_MANY.to_string()),
        "past the misses of the hour every report is refused, whoever it names"
    );
    assert_eq!(int(w.db(), "SELECT COUNT(*) FROM reports").await, 1);
    done(w.state, path).await;
}

/// The answer to a report about the member `name` of `s` over HTTP, sent with the header
/// `header` (none for a signed-out reader).
async fn member_report_over_http(
    client: &reqwest::Client,
    url: &str,
    header: Option<(&str, &str)>,
    name: &str,
) -> (u16, String) {
    let req = json!({"to": "server", "target": member(name), "reason": "spam"});
    let post = client
        .post(url)
        .header("content-type", "application/json")
        .body(req.to_string());
    let post = match header {
        Some((key, value)) => post.header(key, value),
        None => post,
    };
    let res = post.send().await.expect("send");
    let status = res.status().as_u16();
    (status, res.text().await.expect("text"))
}

/// `s` keeps its members to itself: erin and zed read it from outside, signed in, and bob is a
/// member while nobody has no account.
async fn hidden_members(state: AppState) {
    let w = fill(state).await;
    let db = w.db().clone();
    exec(
        &db,
        "UPDATE servers SET members_visible = 0 WHERE name = 's'",
    )
    .await;
    let (addr, server) = serve(w.state.clone()).await;
    let client = reqwest::Client::new();
    let url = format!("http://{addr}/api/v1/reports");
    let bearer = |token: String| format!("Bearer {token}");
    let erin = bearer(token(&db, "erin").await);
    let alice = bearer(token(&db, "alice").await);
    let root = bearer(token(&db, "root").await);
    let grant = "a".repeat(64);
    let ask = |header: Option<(&'static str, &str)>, name: &'static str| {
        let (client, url) = (&client, &url);
        let header = header.map(|(key, value)| (key, value.to_string()));
        async move {
            let header = header.as_ref().map(|(key, value)| (*key, value.as_str()));
            member_report_over_http(client, url, header, name).await
        }
    };
    let not_found = (404, r#"{"error":"Not found"}"#.to_string());
    let callers = [
        ("a signed-out reader", None),
        ("a guest", Some(("x-guest-grant", grant.as_str()))),
        (
            "a signed-in non-member",
            Some(("authorization", erin.as_str())),
        ),
    ];
    for (caller, header) in callers {
        let member = ask(header, "bob").await;
        assert_eq!(
            member,
            ask(header, "nobody").await,
            "{caller}: a member and a missing name answer alike"
        );
        let expected = match header {
            Some(("authorization", _)) => not_found.clone(),
            _ => (401, r#"{"error":"Unauthorized"}"#.to_string()),
        };
        assert_eq!(member, expected, "{caller}");
    }
    let as_erin = Some(("authorization", erin.as_str()));
    exec(
        &db,
        "UPDATE servers SET members_visible = 1 WHERE name = 's'",
    )
    .await;
    for name in ["carol", "dave", "frank"] {
        assert_eq!(ask(as_erin, name).await.0, 200, "{name}");
    }
    let capped = ask(as_erin, "bob").await;
    assert_eq!(capped.0, 429, "erin has used up her targets of the day");
    exec(
        &db,
        "UPDATE servers SET members_visible = 0 WHERE name = 's'",
    )
    .await;
    assert_eq!(ask(as_erin, "bob").await, not_found, "past the caps too");
    assert_eq!(ask(as_erin, "nobody").await, not_found);
    for (caller, token) in [("a member", &alice), ("the site admin", &root)] {
        let header = Some(("authorization", token.as_str()));
        assert_eq!(ask(header, "bob").await.0, 200, "{caller}");
        assert_eq!(ask(header, "nobody").await, not_found, "{caller}");
    }
    server.abort();
    let sent = |name: &str| format!("SELECT COUNT(*) FROM reports WHERE reporter = '{name}'");
    assert_eq!(int(&db, &sent("erin")).await, 3);
    assert_eq!(int(&db, &sent("alice")).await, 1);
    assert_eq!(int(&db, &sent("root")).await, 1);

    let w = w
        .with_limits(Limits {
            lookup_misses_per_hour: 2,
            ..Limits::default()
        })
        .await;
    let zed = who(&db, "zed").await;
    let about = |name: &'static str| {
        let (state, zed) = (w.state.clone(), zed.clone());
        async move {
            create_report(
                State(state),
                Authed(zed),
                Json(body(
                    json!({"to": "server", "target": member(name), "reason": "spam"}),
                )),
            )
            .await
            .map(|Json(created)| created)
        }
    };
    let plain_not_found = (404, "Not found".to_string());
    assert_eq!(refusal(about("bob").await), plain_not_found, "a member");
    assert_eq!(
        refusal(about("nobody").await),
        plain_not_found,
        "no account"
    );
    exec(
        &db,
        "UPDATE servers SET members_visible = 1 WHERE name = 's'",
    )
    .await;
    assert_eq!(
        refusal(about("carol").await),
        (429, lookup::TOO_MANY.to_string()),
        "both took a miss"
    );
    assert_eq!(int(&db, &sent("zed")).await, 0);
}

#[tokio::test]
async fn a_server_that_hides_its_members_answers_outsiders_alike() {
    let (state, path) = temp_state("reports_hidden_members").await;
    hidden_members(state.clone()).await;
    done(state, path).await;
    if let Some((state, temp)) = pg_state("reports_hidden_members").await {
        hidden_members(state.clone()).await;
        pg_done(state, temp).await;
    }
}

#[tokio::test]
async fn the_switches_turn_each_kind_off() {
    let (w, path) = world("reports_switches").await;
    let db = w.db();
    exec(
        db,
        "UPDATE settings SET value = '0' WHERE key = 'server_reports'",
    )
    .await;
    Settings::forget(db);
    let send = |by: &'static str, to: &'static str, name: &'static str| {
        let w = &w;
        async move {
            let user = who(w.db(), by).await;
            let req = body(json!({"to": to, "target": member(name), "reason": "spam"}));
            create_report(State(w.state.clone()), Authed(user), Json(req))
                .await
                .map(|Json(created)| created)
        }
    };
    let off = wire(send("alice", "server", "bob").await).await;
    assert_eq!(
        off,
        (
            404,
            r#"{"error":"Not found","reason":{"kind":"off_site","control":"server_reports"}}"#
                .to_string()
        )
    );
    assert_eq!(wire(send("alice", "server", "nobody").await).await, off);
    send("alice", "instance", "bob")
        .await
        .expect("the instance kind is on");
    exec(
        db,
        "UPDATE settings SET value = '1' WHERE key = 'server_reports'",
    )
    .await;
    exec(
        db,
        "UPDATE settings SET value = '0' WHERE key = 'instance_reports'",
    )
    .await;
    Settings::forget(db);
    send("alice", "server", "bob").await.expect("back on");
    assert_eq!(
        wire(send("alice", "instance", "carol").await).await,
        (
            404,
            r#"{"error":"Not found","reason":{"kind":"off_site","control":"instance_reports"}}"#
                .to_string()
        )
    );
    assert_eq!(int(db, "SELECT COUNT(*) FROM reports").await, 2);
    done(w.state, path).await;
}

#[tokio::test]
async fn answers_follow_the_form() {
    let (w, path) = world("reports_answers").await;
    let db = w.db();
    let mut doc = serde_json::to_value(forms::ReportForms::defaults()).expect("json");
    let options = json!([{"id": "a", "label": "Apple"}, {"id": "b", "label": "Banana"}, {"id": "other", "label": "Something else"}]);
    doc["forms"].as_array_mut().expect("forms").push(json!({"id": "all", "label": "Everything", "base": "none", "fields": [
        {"id": "topic", "kind": "single_choice", "label": "Topic", "reason": true, "options": options},
        {"id": "short", "kind": "short_text", "label": "Short", "max": 5, "required": true},
        {"id": "long", "kind": "long_text", "label": "Long", "max": 300},
        {"id": "many", "kind": "multiple_choice", "label": "Many", "max": 2, "options": options},
        {"id": "sure", "kind": "checkbox", "label": "I am sure"},
        {"id": "who", "kind": "user", "label": "Who"},
        {"id": "where", "kind": "server", "label": "Where"},
        {"id": "what", "kind": "message", "label": "What"},
    ]}));
    doc["forms"][0]["fields"][1]["options"] =
        json!([{"id": "spam", "label": "Junk"}, {"id": "other", "label": "Other"}]);
    doc["rev"] = json!(4);
    let custom = forms::ReportForms::parse(&doc.to_string()).expect("forms");
    exec(db, "DELETE FROM settings WHERE key = 'report_forms'").await;
    sqlx::query("INSERT INTO settings(key, value) VALUES('report_forms', $1)")
        .bind(custom.stored())
        .execute(db)
        .await
        .expect("forms");
    Policy::load(db).await;
    let evidence = message(db, w.general, "bob", "look at this", 100).await;
    let all = |answers: Value| json!({"to": "instance", "target": {"kind": "none"}, "form": "all", "answers": answers});
    let id = w
        .send(
            "alice",
            all(json!([
                {"id": "what", "value": {"message_id": evidence}},
                {"id": "where", "value": {"server": "S"}},
                {"id": "who", "value": {"username": "Bob"}},
                {"id": "sure", "value": true},
                {"id": "many", "value": ["b", "a"]},
                {"id": "long", "value": "one\r\ntwo"},
                {"id": "short", "value": "hello"},
                {"id": "topic", "value": "b"},
            ])),
            T0,
        )
        .await
        .expect("every kind")
        .id;
    let row = sqlx::query("SELECT target_kind, target_key, form, form_label, form_rev, reason, reason_label, answers, snapshot, kind, server FROM reports WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("row");
    let col = |n: usize| row.try_get::<Option<String>, _>(n).expect("text");
    assert_eq!(col(0).as_deref(), Some("none"));
    assert_eq!(col(1).as_deref(), Some("-"));
    assert_eq!(
        (col(2).as_deref(), col(3).as_deref()),
        (Some("all"), Some("Everything"))
    );
    assert_eq!(row.try_get::<i64, _>(4).expect("rev"), 4);
    assert_eq!(
        (col(5).as_deref(), col(6).as_deref()),
        (Some("b"), Some("Banana"))
    );
    assert_eq!(
        serde_json::from_str::<Value>(&col(7).expect("answers")).expect("json"),
        json!([
            {"id": "topic", "label": "Topic", "kind": "single_choice", "value": "b", "shown": ["Banana"]},
            {"id": "short", "label": "Short", "kind": "short_text", "value": "hello"},
            {"id": "long", "label": "Long", "kind": "long_text", "value": "one\ntwo"},
            {"id": "many", "label": "Many", "kind": "multiple_choice", "value": ["b", "a"], "shown": ["Banana", "Apple"]},
            {"id": "sure", "label": "I am sure", "kind": "checkbox", "value": true},
            {"id": "who", "label": "Who", "kind": "user", "value": {"username": "bob", "display_name": "Bob B"}},
            {"id": "where", "label": "Where", "kind": "server", "value": {"server": "s", "display_name": "Server S"}},
            {"id": "what", "label": "What", "kind": "message", "value": {"message_id": evidence, "author": {"username": "bob", "display_name": "Bob B"}}},
        ]),
        "in form order, with the labels and names at report time"
    );
    assert_eq!(
        col(8).as_deref(),
        Some(r#"{"message":null,"context":[],"user":null,"server":null,"channel":null}"#)
    );
    assert_eq!((col(9).as_deref(), col(10)), (Some("instance"), None));

    let reason_of = |id: i64| async move {
        text(
            db,
            &format!(
                "SELECT reason || '|' || COALESCE(reason_label, '-') FROM reports WHERE id = {id}"
            ),
        )
        .await
    };
    let unknown = w
        .send(
            "alice",
            all(json!([{"id": "short", "value": "x"}, {"id": "topic", "value": "zzz"}])),
            T0,
        )
        .await
        .expect("an unknown option of the reason field")
        .id;
    assert_eq!(reason_of(unknown).await, "other|Something else");
    let unanswered = w
        .send("alice", all(json!([{"id": "short", "value": "x"}])), T0)
        .await
        .expect("no reason answer")
        .id;
    assert_eq!(reason_of(unanswered).await, "other|-");
    for (n, (given, kept)) in [
        ("spam", "spam|Junk"),
        ("hate", "other|Other"),
        ("nonsense", "other|Other"),
    ]
    .into_iter()
    .enumerate()
    {
        let id = w
            .send(
                "alice",
                json!({"to": "instance", "target": member("bob"), "reason": given, "form": "user"}),
                T0 + n as i64 * 10 * DAY,
            )
            .await
            .expect("a reason")
            .id;
        assert_eq!(
            reason_of(id).await,
            kept,
            "{given}: a reason the form doesn't offer is other"
        );
    }

    for (answers, message) in [
        (json!([]), "Missing required field: short"),
        (
            json!([{"id": "short", "value": "x"}, {"id": "nope", "value": "x"}]),
            "Unknown field",
        ),
        (
            json!([{"id": "short", "value": "toolong"}]),
            "Answer too long",
        ),
        (
            json!([{"id": "short", "value": "x"}, {"id": "long", "value": "a".repeat(301)}]),
            "Answer too long",
        ),
        (
            json!([{"id": "short", "value": "x"}, {"id": "many", "value": ["a", "b", "other"]}]),
            "Too many options picked",
        ),
        (
            json!([{"id": "short", "value": "x"}, {"id": "many", "value": ["zzz"]}]),
            "Unknown option",
        ),
        (
            json!([{"id": "short", "value": "x"}, {"id": "sure", "value": "yes"}]),
            "Answer of the wrong kind",
        ),
        (
            json!([{"id": "short", "value": "x"}, {"id": "short", "value": "y"}]),
            "Field answered twice",
        ),
    ] {
        let e = w
            .send("alice", all(answers.clone()), T0)
            .await
            .expect_err("refused");
        assert_eq!(
            e.2.as_ref().map(|r| (r.kind, r.field.as_deref())),
            Some((crate::api::error::ReasonKind::Invalid, Some("answers"))),
            "{answers}"
        );
        assert_eq!(
            refusal::<()>(Err(e)),
            (400, message.to_string()),
            "{answers}"
        );
    }
    for (req, message) in [
        (
            json!({"to": "instance", "target": {"kind": "message"}, "reason": "spam"}),
            "Incomplete target",
        ),
        (
            json!({"to": "instance", "target": {"kind": "member", "server": "s"}, "reason": "spam"}),
            "Incomplete target",
        ),
        (
            json!({"to": "instance", "target": {"kind": "none"}, "form": "nope"}),
            "Unknown form",
        ),
        (
            json!({"to": "instance", "target": {"kind": "none"}}),
            "Unknown form",
        ),
        (
            json!({"to": "instance", "target": {"kind": "none"}, "form": "user", "reason": "spam"}),
            WRONG_TARGET,
        ),
        (
            json!({"to": "instance", "target": member("bob"), "form": "all", "answers": [{"id": "short", "value": "x"}]}),
            WRONG_TARGET,
        ),
        (
            json!({"to": "instance", "target": member("bob"), "form": "user", "reason": "spam", "answers": [{"id": "reason", "value": "spam"}]}),
            "Unknown field",
        ),
    ] {
        assert_eq!(
            refusal(w.send("alice", req.clone(), T0 + 90 * DAY).await),
            (400, message.to_string()),
            "{req}"
        );
    }
    doc["forms"][1]["enabled"] = json!(false);
    let off = forms::ReportForms::parse(&doc.to_string()).expect("forms");
    sqlx::query("UPDATE settings SET value = $1 WHERE key = 'report_forms'")
        .bind(off.stored())
        .execute(db)
        .await
        .expect("forms");
    Policy::load(db).await;
    assert_eq!(
        refusal(
            w.send("alice", json!({"to": "instance", "target": {"kind": "none"}, "form": "bug", "answers": [{"id": "summary", "value": "x"}]}), T0)
                .await
        ),
        (400, "Unknown form".to_string()),
        "a category that is turned off"
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn feedback_does_not_use_abuse_caps() {
    let (w, path) = world("reports_feedback").await;
    let db = w.db();
    let bug = || json!({"to": "instance", "target": {"kind": "none"}, "form": "bug", "answers": [{"id": "summary", "value": "The page is blank"}, {"id": "kind", "value": "looks"}]});
    let over = (429, OVER_LIMIT.to_string());
    for n in 0..10 {
        w.send("alice", bug(), T0 + n)
            .await
            .unwrap_or_else(|e| panic!("bug {n}: {e:?}"));
    }
    assert_eq!(
        refusal(w.send("alice", bug(), T0 + 20).await),
        over,
        "the 11th bug in a week"
    );
    assert_eq!(
        text(db, "SELECT DISTINCT target_kind || '|' || target_key || '|' || reason || '|' || reason_label || '|' || form_label FROM reports").await,
        "none|-|looks|Looks wrong|Report a bug"
    );
    for name in ["bob", "carol", "dave"] {
        w.send(
            "alice",
            json!({"to": "instance", "target": member(name), "reason": "spam"}),
            T0 + 30,
        )
        .await
        .unwrap_or_else(|e| panic!("{name} after ten bugs: {e:?}"));
    }
    assert_eq!(
        refusal(
            w.send(
                "alice",
                json!({"to": "instance", "target": member("frank"), "reason": "spam"}),
                T0 + 40
            )
            .await
        ),
        over,
        "the abuse caps are as before"
    );
    w.send("alice", bug(), T0 + 7 * DAY + 1)
        .await
        .expect("a bug a week later");

    for name in ["alice", "carol", "dave"] {
        w.send(
            "bob",
            json!({"to": "instance", "target": member(name), "reason": "spam"}),
            T0,
        )
        .await
        .expect("abuse first");
    }
    for n in 0..10 {
        w.send("bob", bug(), T0 + n)
            .await
            .unwrap_or_else(|e| panic!("bug {n} after three reports: {e:?}"));
    }
    let general = w
        .send("carol", json!({"to": "instance", "target": {"kind": "none"}, "form": "general", "answers": [{"id": "details", "value": "A long thought about the app."}]}), T0)
        .await
        .expect("general")
        .id;
    assert_eq!(
        text(db, &format!("SELECT reason || '|' || COALESCE(reason_label, '-') FROM reports WHERE id = {general}")).await,
        "other|-"
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn bodies_without_a_form_or_answers_work() {
    let (w, path) = world("reports_no_form").await;
    let db = w.db();
    let bobs = message(db, w.general, "bob", "x", 100).await;
    let cases = [
        (
            json!({"to": "server", "target": {"kind": "message", "id": bobs}, "reason": "harassment", "note": "rude", "context": 2}),
            "message",
            "Report message",
            "Harassment",
        ),
        (
            json!({"to": "instance", "target": {"kind": "member", "server": "s", "username": "carol"}, "reason": "impersonation"}),
            "user",
            "Report a user",
            "Impersonation",
        ),
        (
            json!({"to": "instance", "target": {"kind": "account", "username": "dave"}, "reason": "violence", "note": "threats"}),
            "user",
            "Report a user",
            "Violence or self-harm",
        ),
        (
            json!({"to": "instance", "target": {"kind": "server", "server": "s"}, "reason": "illegal"}),
            "server",
            "Report a server",
            "Illegal content",
        ),
    ];
    for (req, form, label, reason) in cases {
        let id = w
            .send("alice", req.clone(), T0)
            .await
            .unwrap_or_else(|e| panic!("{req}: {e:?}"))
            .id;
        assert_eq!(
            text(db, &format!("SELECT form || '|' || form_label || '|' || reason_label FROM reports WHERE id = {id}")).await,
            format!("{form}|{label}|{reason}")
        );
    }
    assert_eq!(
        text(
            db,
            "SELECT answers FROM reports WHERE target_key = 'u:dave'"
        )
        .await,
        r#"[{"id":"details","label":"What happened","kind":"long_text","value":"threats"}]"#
    );
    let mut doc = serde_json::to_value(forms::ReportForms::defaults()).expect("json");
    doc["forms"][0]["fields"][4]["max"] = json!(3);
    doc["forms"][0]["fields"][4]["template"] = Value::Null;
    let short = forms::ReportForms::parse(&doc.to_string()).expect("forms");
    exec(db, "DELETE FROM settings WHERE key = 'report_forms'").await;
    sqlx::query("INSERT INTO settings(key, value) VALUES('report_forms', $1)")
        .bind(short.stored())
        .execute(db)
        .await
        .expect("forms");
    Policy::load(db).await;
    let id = w
        .send("alice", json!({"to": "instance", "target": {"kind": "account", "username": "frank"}, "reason": "spam", "note": "a longer note"}), T0 + 2 * DAY)
        .await
        .expect("a note the field doesn't take stays a note")
        .id;
    assert_eq!(
        text(
            db,
            &format!("SELECT note || '|' || answers FROM reports WHERE id = {id}")
        )
        .await,
        "a longer note|[]"
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn hidden_references_are_404() {
    let (w, path) = world("reports_references").await;
    let db = w.db();
    let hidden = message(db, w.ops, "olga", "secret", 100).await;
    let seen = message(db, w.general, "bob", "public", 100).await;
    let mut doc = serde_json::to_value(forms::ReportForms::defaults()).expect("json");
    let fields = doc["forms"][3]["fields"].as_array_mut().expect("fields");
    fields.push(json!({"id": "who", "kind": "user", "label": "Who"}));
    fields.push(json!({"id": "where", "kind": "server", "label": "Where"}));
    fields.push(json!({"id": "what", "kind": "message", "label": "What"}));
    let custom = forms::ReportForms::parse(&doc.to_string()).expect("forms");
    exec(db, "DELETE FROM settings WHERE key = 'report_forms'").await;
    sqlx::query("INSERT INTO settings(key, value) VALUES('report_forms', $1)")
        .bind(custom.stored())
        .execute(db)
        .await
        .expect("forms");
    Policy::load(db).await;
    let general = |extra: Value| {
        let mut answers = vec![json!({"id": "details", "value": "see this"})];
        answers.push(extra);
        json!({"to": "instance", "target": {"kind": "none"}, "form": "general", "answers": answers})
    };
    let not_found = (404, r#"{"error":"Not found"}"#.to_string());
    for extra in [
        json!({"id": "who", "value": {"username": "erin"}}),
        json!({"id": "who", "value": {"username": "nobody"}}),
        json!({"id": "where", "value": {"server": "hush"}}),
        json!({"id": "where", "value": {"server": "nowhere"}}),
        json!({"id": "what", "value": {"message_id": hidden}}),
        json!({"id": "what", "value": {"message_id": 999_999}}),
    ] {
        assert_eq!(
            wire(w.send("alice", general(extra.clone()), T0).await).await,
            not_found,
            "{extra}"
        );
    }
    assert_eq!(int(db, "SELECT COUNT(*) FROM reports").await, 0);
    for extra in [
        json!({"id": "who", "value": {"username": "bob"}}),
        json!({"id": "where", "value": {"server": "s"}}),
        json!({"id": "what", "value": {"message_id": seen}}),
    ] {
        w.send("alice", general(extra.clone()), T0)
            .await
            .unwrap_or_else(|e| panic!("{extra}: {e:?}"));
    }
    let evidence = w
        .send("alice", json!({"to": "server", "target": member("bob"), "reason": "spam", "form": "user", "answers": [{"id": "evidence", "value": {"message_id": hidden}}]}), T0)
        .await;
    assert_eq!(wire(evidence).await, not_found);
    done(w.state, path).await;
}

async fn serve(state: AppState) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let config = crate::config::AppConfig {
        roles: crate::config::Roles {
            web: false,
            ..crate::config::Roles::ALL
        },
        ..crate::config::AppConfig::defaults()
    };
    let app = crate::server::build_router(None, None, &config, state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    (addr, server)
}

pub(super) async fn token(db: &Db, user: &str) -> String {
    let token = format!("tok-{user}");
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, 0)")
        .bind(crate::db::secret_key(&token))
        .bind(user)
        .execute(db)
        .await
        .expect("token");
    token
}

#[tokio::test]
async fn reports_go_over_http_and_need_an_account() {
    let (w, path) = world("reports_http").await;
    let (addr, server) = serve(w.state.clone()).await;
    let client = reqwest::Client::new();
    let url = format!("http://{addr}/api/v1/reports");
    let req = json!({"to": "server", "target": member("bob"), "reason": "spam"});
    let post = |url: &str| {
        client
            .post(url)
            .header("content-type", "application/json")
            .body(req.to_string())
    };
    let anonymous = post(&url).send().await.expect("send");
    assert_eq!(anonymous.status(), 401);
    let alice = token(w.db(), "alice").await;
    let sent = post(&url).bearer_auth(&alice).send().await.expect("send");
    assert_eq!(sent.status(), 200);
    let created: Value = serde_json::from_str(&sent.text().await.expect("text")).expect("json");
    assert_eq!(
        created,
        json!({"id": int(w.db(), "SELECT id FROM reports").await})
    );
    let again = post(&format!("http://{addr}/api/reports"))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("send");
    assert_eq!(again.status(), 429);
    assert_eq!(
        again.text().await.expect("text"),
        r#"{"error":"You've sent a lot of reports. Try again later.","reason":{"kind":"rate"}}"#
    );
    let info = client
        .get(format!("http://{addr}/api/v1/instance"))
        .send()
        .await
        .expect("send")
        .text()
        .await
        .expect("text");
    let info: Value = serde_json::from_str(&info).expect("json");
    assert_eq!(info["features"]["reports"], true);
    assert_eq!(info["features"]["report_forms"], true);
    server.abort();
    done(w.state, path).await;
}

// Reading.

pub(super) fn query(v: Value) -> ReportQuery {
    serde_json::from_value(v).expect("query")
}

impl World {
    /// A report by `by` about the member `about` of `s` to its moderators, and its id.
    pub(super) async fn about(&self, by: &str, about: &str, t: i64) -> i64 {
        self.send(
            by,
            json!({"to": "server", "target": member(about), "reason": "spam"}),
            t,
        )
        .await
        .unwrap_or_else(|e| panic!("{by} reports {about}: {e:?}"))
        .id
    }

    /// The reports of `s` as `by` lists them.
    pub(super) async fn listed(&self, by: &str, q: Value) -> Result<Vec<ReportRow>, ApiError> {
        let user = who(self.db(), by).await;
        list_reports(
            State(self.state.clone()),
            Authed(user),
            Path("s".to_string()),
            Query(query(q)),
        )
        .await
        .map(|Paged(rows, _)| rows)
    }

    pub(super) async fn ids(&self, by: &str, q: Value) -> Vec<i64> {
        self.listed(by, q)
            .await
            .unwrap_or_else(|e| panic!("{by} lists: {e:?}"))
            .iter()
            .map(|r| r.id)
            .collect()
    }

    /// The groups of `s` as `by` sees them: key, count and open.
    pub(super) async fn grouped(&self, by: &str, q: Value) -> Vec<(String, i64, i64)> {
        let user = who(self.db(), by).await;
        let Paged(groups, _) = list_groups(
            State(self.state.clone()),
            Authed(user),
            Path("s".to_string()),
            Query(query(q)),
        )
        .await
        .unwrap_or_else(|e| panic!("{by} groups: {e:?}"));
        groups
            .into_iter()
            .map(|g| (g.key, g.count, g.open))
            .collect()
    }

    pub(super) async fn open(&self, by: &str) -> i64 {
        let user = who(self.db(), by).await;
        server_open(
            State(self.state.clone()),
            Authed(user),
            Path("s".to_string()),
        )
        .await
        .unwrap_or_else(|e| panic!("{by} counts: {e:?}"))
        .0
        .open
    }

    pub(super) async fn detail(&self, by: &str, id: i64) -> Result<ReportDetail, ApiError> {
        let user = who(self.db(), by).await;
        get_report(State(self.state.clone()), Authed(user), Path(id))
            .await
            .map(|Json(detail)| detail)
    }

    pub(super) async fn my_open(&self, by: &str) -> Vec<OpenCount> {
        let user = who(self.db(), by).await;
        let Paged(counts, _) = my_open(
            State(self.state.clone()),
            Authed(user),
            Query(OpenQuery::default()),
        )
        .await
        .unwrap_or_else(|e| panic!("{by} counts: {e:?}"));
        counts
    }

    /// The reports the admin routes list for `by`.
    pub(super) async fn admin_ids(
        &self,
        by: &str,
        scope: Value,
        q: Value,
    ) -> Result<Vec<i64>, ApiError> {
        let user = who(self.db(), by).await;
        admin::list_reports(
            State(self.state.clone()),
            Authed(user),
            Query(serde_json::from_value(scope).expect("scope")),
            Query(query(q)),
        )
        .await
        .map(|Paged(rows, _)| rows.iter().map(|r| r.id).collect())
    }
}

/// Lets carol into #ops (the role `staff`) and has olga report a message of hers there.
async fn ops_report(w: &World, t: i64) -> i64 {
    let db = w.db();
    let staff = int(
        db,
        "SELECT id FROM roles WHERE server = 's' AND name = 'staff'",
    )
    .await;
    exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('s', 'carol', {staff}) ON CONFLICT DO NOTHING")).await;
    let secret = message(db, w.ops, "carol", "ops talk", 100).await;
    w.send(
        "olga",
        json!({"to": "server", "target": {"kind": "message", "id": secret}, "reason": "hate"}),
        t,
    )
    .await
    .expect("a report in #ops")
    .id
}

#[tokio::test]
async fn moderators_list_and_group_server_reports() {
    let (w, path) = world("reports_list").await;
    let db = w.db();
    let first = w.about("alice", "bob", T0).await;
    let dismissed = w.about("carol", "bob", T0 + 10).await;
    exec(
        db,
        &format!(
            "UPDATE reports SET status = 'dismissed', resolved_at = {} WHERE id = {dismissed}",
            T0 + 20
        ),
    )
    .await;
    let about_carol = w.about("dave", "carol", T0 + 30).await;
    let in_ops = ops_report(&w, T0 + 40).await;
    assert_eq!(
        w.ids("olga", json!({})).await,
        [in_ops, about_carol, dismissed, first],
        "newest first, for someone who sees every channel"
    );
    assert_eq!(
        w.ids("mo", json!({})).await,
        [about_carol, dismissed, first],
        "a holder of Manage reports who can't view #ops"
    );
    let row = &w
        .listed("mo", json!({"limit": 1, "oldest": true}))
        .await
        .expect("list")[0];
    assert_eq!(
        (
            row.id,
            row.kind,
            row.status,
            row.reason.as_str(),
            row.reason_label.as_deref(),
            row.form.as_str(),
            row.form_label.as_str(),
        ),
        (
            first,
            ReportKind::Server,
            Status::Open,
            "spam",
            Some("Spam"),
            "user",
            "Report a user",
        )
    );
    assert_eq!(
        (
            row.target_kind.as_str(),
            row.target_key.as_str(),
            row.excerpt.as_str(),
            row.server.as_deref(),
            row.server_name.as_deref(),
            row.escalated,
            row.created_at
        ),
        (
            "user",
            "u:bob",
            "bob",
            Some("s"),
            Some("Server S"),
            false,
            T0
        )
    );
    assert_eq!(
        (
            row.target.as_ref().map(|u| u.display_name.as_str()),
            row.reporter.as_ref().map(|u| u.username.as_str()),
            row.assignee.as_ref()
        ),
        (Some("Bob B"), Some("alice"), None),
        "moderators see who reported"
    );
    assert_eq!(
        w.grouped("mo", json!({"by": "member"})).await,
        [("u:bob".to_string(), 2, 1), ("u:carol".to_string(), 1, 1)]
    );
    assert_eq!(
        w.grouped("olga", json!({"by": "member"})).await,
        [("u:carol".to_string(), 2, 2), ("u:bob".to_string(), 2, 1)],
        "the most open reports first"
    );
    assert_eq!(
        w.ids("mo", json!({"by": "status", "key": "dismissed"}))
            .await,
        [dismissed]
    );
    assert_eq!(
        w.ids("mo", json!({"by": "member", "key": "u:bob"})).await,
        [dismissed, first]
    );
    assert_eq!(
        w.ids("mo", json!({"status": "open", "reason": "spam"}))
            .await,
        [about_carol, first]
    );
    assert_eq!(w.ids("olga", json!({"reason": "hate"})).await, [in_ops]);
    assert_eq!(
        w.ids("mo", json!({"from": T0 + 5, "to": T0 + 30})).await,
        [about_carol, dismissed]
    );
    assert_eq!(
        w.grouped("olga", json!({"by": "form"})).await,
        [("user".to_string(), 3, 2), ("message".to_string(), 1, 1)]
    );
    assert_eq!(w.ids("olga", json!({"form": "message"})).await, [in_ops]);
    assert_eq!(
        w.grouped("olga", json!({"by": "channel"})).await,
        [("".to_string(), 3, 2), (w.ops.to_string(), 1, 1)]
    );
    assert_eq!(
        w.grouped("mo", json!({"by": "reporter"})).await,
        [
            ("alice".to_string(), 1, 1),
            ("dave".to_string(), 1, 1),
            ("carol".to_string(), 1, 0)
        ]
    );
    assert_eq!(w.open("mo").await, 2);
    assert_eq!(w.open("olga").await, 3);

    let midnight = (T0 / DAY + 400) * DAY;
    let late = w.about("frank", "dave", midnight + HOUR).await;
    let day = |tz: i64| {
        let w = &w;
        async move {
            w.grouped("mo", json!({"by": "day", "tz": tz, "from": midnight}))
                .await
        }
    };
    let (utc, west) = (
        query::date_of(midnight / DAY),
        query::date_of(midnight / DAY - 1),
    );
    assert_eq!(day(0).await, [(utc.clone(), 1, 1)]);
    assert_eq!(day(-300).await, [(west.clone(), 1, 1)], "the local date");
    assert_eq!(
        w.ids("mo", json!({"by": "day", "tz": -300, "key": west}))
            .await,
        [late]
    );
    assert!(
        w.ids("mo", json!({"by": "day", "tz": -300, "key": utc}))
            .await
            .is_empty()
    );
    for (q, message) in [
        (json!({"by": "server"}), "Unknown grouping"),
        (json!({"by": "day", "tz": 900}), "Invalid tz"),
        (json!({"by": "day", "key": "tomorrow"}), "Invalid day"),
    ] {
        assert_eq!(
            refusal(w.listed("mo", q.clone()).await),
            (400, message.to_string()),
            "{q}"
        );
    }
    let user = who(db, "mo").await;
    let no_grouping = list_groups(
        State(w.state.clone()),
        Authed(user.clone()),
        Path("s".to_string()),
        Query(query(json!({}))),
    )
    .await
    .map(|Paged(groups, _)| groups);
    assert_eq!(refusal(no_grouping), (400, "Unknown grouping".to_string()));

    for n in 0..60 {
        exec(db, &format!("INSERT INTO reports(kind, server, server_name, target_kind, target_key, target_user, reporter, form, form_label, reason, snapshot, created_at, updated_at) VALUES('server', 's', 'Server S', 'user', 'u:t{n}', 't{n}', 'alice', 'user', 'Report a user', 'other', '{{}}', {at}, {at})", at = T0 + 1000 + n)).await;
    }
    let Paged(page, next) = list_reports(
        State(w.state.clone()),
        Authed(user.clone()),
        Path("s".to_string()),
        Query(query(json!({"to": T0 + 2000}))),
    )
    .await
    .expect("first page");
    assert_eq!(page.len(), 50);
    let Paged(rest, end) = list_reports(
        State(w.state.clone()),
        Authed(user.clone()),
        Path("s".to_string()),
        Query(query(
            json!({"to": T0 + 2000, "cursor": next.expect("a cursor")}),
        )),
    )
    .await
    .expect("second page");
    assert_eq!((rest.len(), end), (13, None));
    let mut seen: Vec<i64> = page.iter().chain(&rest).map(|r| r.id).collect();
    seen.dedup();
    assert_eq!(seen.len(), 63, "no report twice");
    assert!(seen.windows(2).all(|pair| pair[0] > pair[1]));
    let Paged(groups, next) = list_groups(
        State(w.state.clone()),
        Authed(user.clone()),
        Path("s".to_string()),
        Query(query(json!({"by": "member"}))),
    )
    .await
    .expect("groups");
    assert_eq!(groups.len(), 50);
    let Paged(rest, end) = list_groups(
        State(w.state.clone()),
        Authed(user),
        Path("s".to_string()),
        Query(query(
            json!({"by": "member", "cursor": next.expect("a cursor")}),
        )),
    )
    .await
    .expect("more groups");
    assert_eq!((rest.len(), end), (13, None));
    done(w.state, path).await;
}

#[tokio::test]
async fn reason_labels_come_from_the_report() {
    let (w, path) = world("reports_labels").await;
    let db = w.db();
    let old = w.about("alice", "bob", T0).await;
    let mut doc = serde_json::to_value(forms::ReportForms::defaults()).expect("json");
    doc["forms"][0]["label"] = json!("Tell on someone");
    doc["forms"][0]["fields"][1]["options"][0]["label"] = json!("Junk mail");
    let edited = forms::ReportForms::parse(&doc.to_string()).expect("forms");
    exec(db, "DELETE FROM settings WHERE key = 'report_forms'").await;
    sqlx::query("INSERT INTO settings(key, value) VALUES('report_forms', $1)")
        .bind(edited.stored())
        .execute(db)
        .await
        .expect("forms");
    Policy::load(db).await;
    let user = who(db, "mo").await;
    let groups = |by: &'static str| {
        let (state, user) = (w.state.clone(), user.clone());
        async move {
            let Paged(groups, _) = list_groups(
                State(state),
                Authed(user),
                Path("s".to_string()),
                Query(query(json!({"by": by}))),
            )
            .await
            .expect("groups");
            groups
                .into_iter()
                .map(|g| (g.key, g.label, g.count))
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(
        groups("reason").await,
        [("spam".to_string(), Some("Spam".to_string()), 1)],
        "the label the reason had when the report was sent"
    );
    assert_eq!(
        groups("form").await,
        [("user".to_string(), Some("Report a user".to_string()), 1)]
    );
    let row = &w.listed("mo", json!({})).await.expect("list")[0];
    assert_eq!(
        (row.id, row.reason_label.as_deref(), row.form_label.as_str()),
        (old, Some("Spam"), "Report a user")
    );
    let new = w.about("carol", "dave", T0).await;
    let row = &w.listed("mo", json!({"limit": 1})).await.expect("list")[0];
    assert_eq!(
        (row.id, row.reason_label.as_deref(), row.form_label.as_str()),
        (new, Some("Junk mail"), "Tell on someone")
    );
    exec(
        db,
        &format!(
            "INSERT INTO user_roles(server, username, role_id) VALUES('s', 'gina', {})",
            w.mods
        ),
    )
    .await;
    w.about("alice", "gina", T0 + 10 * DAY).await;
    assert_eq!(
        groups("role").await,
        [
            ("".to_string(), Some("No role".to_string()), 2),
            (w.mods.to_string(), Some("mod".to_string()), 1)
        ]
    );
    assert_eq!(
        groups("assignee").await,
        [("".to_string(), Some("Unassigned".to_string()), 3)]
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn feedback_shows_its_answers() {
    let (w, path) = world("reports_feedback_read").await;
    let db = w.db();
    let bug = w
        .send(
            "alice",
            json!({"to": "instance", "target": {"kind": "none"}, "form": "bug", "answers": [
                {"id": "summary", "value": "The page is blank"},
                {"id": "steps", "value": "1. Open the app\n2. Wait"},
                {"id": "kind", "value": "broke"},
            ]}),
            T0,
        )
        .await
        .expect("bug")
        .id;
    let short = w
        .send("bob", json!({"to": "instance", "target": {"kind": "none"}, "form": "bug", "answers": [{"id": "summary", "value": "Slow"}]}), T0 + 1)
        .await
        .expect("bug")
        .id;
    let about_bob = w
        .send(
            "alice",
            json!({"to": "instance", "target": member("bob"), "reason": "spam"}),
            T0 + 2,
        )
        .await
        .expect("abuse")
        .id;
    assert_eq!(
        w.admin_ids("root", json!({}), json!({}))
            .await
            .expect("instance"),
        [about_bob, short, bug]
    );
    let root = who(db, "root").await;
    let Paged(groups, _) = admin::report_groups(
        State(w.state.clone()),
        Authed(root.clone()),
        Query(AdminScope::default()),
        Query(query(json!({"by": "form"}))),
    )
    .await
    .expect("groups");
    assert_eq!(
        groups
            .iter()
            .map(|g| (g.key.as_str(), g.label.as_deref(), g.count))
            .collect::<Vec<_>>(),
        [
            ("bug", Some("Report a bug"), 2),
            ("user", Some("Report a user"), 1)
        ],
        "by category"
    );
    let Paged(groups, _) = admin::report_groups(
        State(w.state.clone()),
        Authed(root.clone()),
        Query(AdminScope::default()),
        Query(query(json!({"by": "server"}))),
    )
    .await
    .expect("groups");
    assert_eq!(
        groups
            .iter()
            .map(|g| (g.key.as_str(), g.label.as_deref(), g.count))
            .collect::<Vec<_>>(),
        [("", Some("No server"), 2), ("s", Some("Server S"), 1)]
    );
    assert_eq!(
        w.admin_ids(
            "root",
            json!({}),
            json!({"form": "bug", "by": "reason", "key": "broke"})
        )
        .await
        .expect("bugs"),
        [bug]
    );
    let detail = w.detail("root", bug).await.expect("detail");
    assert_eq!(
        (
            detail.report.excerpt.as_str(),
            detail.report.reason.as_str(),
            detail.report.reason_label.as_deref(),
            detail.report.target_kind.as_str(),
            detail.report.target.as_ref()
        ),
        (
            "1. Open the app\n2. Wait",
            "broke",
            Some("Something broke"),
            "none",
            None
        ),
        "the first long answer is the excerpt"
    );
    assert_eq!(
        serde_json::to_value(&detail.answers).expect("json"),
        json!([
            {"id": "kind", "label": "What kind", "kind": "single_choice", "value": "broke", "shown": ["Something broke"]},
            {"id": "summary", "label": "What went wrong", "kind": "short_text", "value": "The page is blank"},
            {"id": "steps", "label": "Steps to make it happen", "kind": "long_text", "value": "1. Open the app\n2. Wait"},
        ])
    );
    assert!(
        detail.related.is_empty(),
        "reports without a target are not related"
    );
    assert_eq!(
        w.detail("root", short)
            .await
            .expect("detail")
            .report
            .excerpt,
        "Slow"
    );
    let open = admin::reports_open(
        State(w.state.clone()),
        Authed(root),
        Query(AdminScope::default()),
    )
    .await
    .expect("open");
    assert_eq!(open.0, Open { open: 3 });
    done(w.state, path).await;
}

#[tokio::test]
async fn reported_moderators_never_see_their_reports() {
    let (w, path) = world("reports_about_mods").await;
    let db = w.db();
    exec(
        db,
        &format!(
            "INSERT INTO user_roles(server, username, role_id) VALUES('s', 'frank', {})",
            w.mods
        ),
    )
    .await;
    let about_mo = w.about("alice", "mo", T0).await;
    let also_mo = w.about("carol", "mo", T0 + 1).await;
    let about_bob = w.about("alice", "bob", T0 + 2).await;
    assert_eq!(
        w.ids("frank", json!({})).await,
        [about_bob, also_mo, about_mo]
    );
    assert_eq!(
        w.grouped("frank", json!({"by": "member"})).await,
        [("u:mo".to_string(), 2, 2), ("u:bob".to_string(), 1, 1)]
    );
    assert_eq!(w.open("frank").await, 3);
    let detail = w.detail("frank", about_mo).await.expect("frank reads it");
    assert_eq!(
        detail.related.iter().map(|r| r.id).collect::<Vec<_>>(),
        [also_mo]
    );
    assert_eq!(
        w.my_open("frank").await,
        [OpenCount {
            server: "s".to_string(),
            open: 3
        }]
    );

    assert_eq!(w.ids("mo", json!({})).await, [about_bob]);
    assert_eq!(
        w.grouped("mo", json!({"by": "member"})).await,
        [("u:bob".to_string(), 1, 1)]
    );
    assert_eq!(
        w.grouped("mo", json!({"by": "reporter"})).await,
        [("alice".to_string(), 1, 1)],
        "nor who reported them"
    );
    assert_eq!(w.open("mo").await, 1);
    assert_eq!(
        w.my_open("mo").await,
        [OpenCount {
            server: "s".to_string(),
            open: 1
        }]
    );
    let missing = wire(w.detail("mo", 999_999).await).await;
    assert_eq!(missing, (404, r#"{"error":"Not found"}"#.to_string()));
    for id in [about_mo, also_mo] {
        assert_eq!(wire(w.detail("mo", id).await).await, missing);
    }
    assert!(
        w.detail("mo", about_bob)
            .await
            .expect("bob's")
            .related
            .is_empty()
    );
    exec(
        db,
        &format!("UPDATE reports SET status = 'resolved' WHERE id = {about_bob}"),
    )
    .await;
    assert!(
        w.my_open("mo").await.is_empty(),
        "nothing open that mo can see"
    );

    add_member(db, "s", "root", 0, 0, 0).await;
    let about_root = w
        .send(
            "alice",
            json!({"to": "instance", "target": member("root"), "reason": "spam"}),
            T0,
        )
        .await
        .expect("about the admin")
        .id;
    let other = w
        .send(
            "carol",
            json!({"to": "instance", "target": member("bob"), "reason": "spam"}),
            T0,
        )
        .await
        .expect("about bob")
        .id;
    assert_eq!(
        w.admin_ids("root", json!({}), json!({}))
            .await
            .expect("instance"),
        [other]
    );
    assert_eq!(wire(w.detail("root", about_root).await).await, missing);
    w.detail("root", other).await.expect("the other one");
    let open = admin::reports_open(
        State(w.state.clone()),
        Authed(who(db, "root").await),
        Query(AdminScope::default()),
    )
    .await
    .expect("open");
    assert_eq!(open.0, Open { open: 1 });
    done(w.state, path).await;
}

#[tokio::test]
async fn restricted_channel_reports_follow_the_audit_rule() {
    let (w, path) = world("reports_restricted").await;
    let db = w.db();
    let in_ops = ops_report(&w, T0).await;
    let open_channel = int(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('s', 'lounge', 0) RETURNING id",
    )
    .await;
    let said = message(db, open_channel, "bob", "lounge talk", 100).await;
    let in_lounge = w
        .send(
            "alice",
            json!({"to": "server", "target": {"kind": "message", "id": said}, "reason": "spam"}),
            T0 + 1,
        )
        .await
        .expect("lounge")
        .id;
    assert_eq!(
        int(
            db,
            &format!("SELECT channel_private FROM reports WHERE id = {in_ops}")
        )
        .await,
        1
    );
    let hidden = (404, r#"{"error":"Not found"}"#.to_string());
    let check = |stage: &'static str| {
        let w = &w;
        let hidden = hidden.clone();
        async move {
            assert_eq!(w.ids("mo", json!({})).await, [in_lounge], "{stage}");
            assert_eq!(w.open("mo").await, 1, "{stage}");
            assert_eq!(
                w.grouped("mo", json!({"by": "channel"})).await,
                [(open_channel.to_string(), 1, 1)],
                "{stage}"
            );
            assert_eq!(wire(w.detail("mo", in_ops).await).await, hidden, "{stage}");
            assert_eq!(
                w.ids("olga", json!({})).await,
                [in_lounge, in_ops],
                "{stage}"
            );
            let detail = w.detail("olga", in_ops).await.expect("a channel manager");
            assert_eq!(
                detail.snapshot.message.map(|m| m.content),
                Some("ops talk".to_string()),
                "{stage}"
            );
            assert_eq!(detail.report.channel.as_deref(), Some("ops"), "{stage}");
        }
    };
    check("while #ops exists").await;
    exec(db, &format!("DELETE FROM channels WHERE id = {}", w.ops)).await;
    check("after #ops is deleted").await;
    exec(
        db,
        &format!("DELETE FROM channels WHERE id = {open_channel}"),
    )
    .await;
    assert_eq!(
        w.ids("mo", json!({})).await,
        [in_lounge],
        "a report from an open channel stays visible when the channel goes"
    );
    let detail = w.detail("mo", in_lounge).await.expect("still there");
    assert_eq!(detail.report.channel.as_deref(), Some("lounge"));
    assert_eq!(
        w.grouped("mo", json!({"by": "channel"})).await,
        [(open_channel.to_string(), 1, 1)]
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn non_holders_get_uniform_answers() {
    let (w, path) = world("reports_non_holders").await;
    let db = w.db();
    let id = w.about("bob", "carol", T0).await;
    exec(
        db,
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('t', 'T', 'zed', 0)",
    )
    .await;
    add_member(db, "t", "zed", 1, 0, 0).await;
    add_member(db, "t", "erin", 0, 0, 0).await;
    let elsewhere = w
        .send("erin", json!({"to": "server", "target": {"kind": "member", "server": "t", "username": "zed"}, "reason": "spam"}), T0)
        .await
        .expect("in t")
        .id;
    let missing_permission = (403, "Missing permission".to_string());
    let denied = (404, "Server not found or wrong password".to_string());
    for (name, expected) in [("alice", &missing_permission), ("erin", &denied)] {
        assert_eq!(
            &refusal(w.listed(name, json!({})).await),
            expected,
            "{name} lists"
        );
        let user = who(db, name).await;
        let groups = list_groups(
            State(w.state.clone()),
            Authed(user.clone()),
            Path("s".to_string()),
            Query(query(json!({"by": "member"}))),
        )
        .await
        .map(|Paged(groups, _)| groups);
        assert_eq!(&refusal(groups), expected, "{name} groups");
        let open = server_open(State(w.state.clone()), Authed(user), Path("s".to_string()))
            .await
            .map(|Json(open)| open);
        assert_eq!(&refusal(open), expected, "{name} counts");
        assert!(w.my_open(name).await.is_empty());
    }
    let missing = wire(w.detail("mo", 999_999).await).await;
    assert_eq!(missing, (404, r#"{"error":"Not found"}"#.to_string()));
    assert_eq!(
        wire(w.detail("mo", elsewhere).await).await,
        missing,
        "another server's"
    );
    assert_eq!(
        wire(w.detail("alice", id).await).await,
        missing,
        "a plain member"
    );
    assert_eq!(
        wire(w.detail("bob", id).await).await,
        missing,
        "the reporter"
    );
    assert_eq!(
        wire(w.detail("erin", id).await).await,
        missing,
        "a non-member"
    );
    w.detail("mo", id).await.expect("a holder");
    for name in ["mo", "olga", "alice"] {
        assert_eq!(
            wire(w.admin_ids(name, json!({}), json!({})).await).await,
            missing,
            "{name} on the admin route"
        );
        assert_eq!(
            wire(
                w.admin_ids(name, json!({"scope": "server", "server": "s"}), json!({}))
                    .await
            )
            .await,
            missing
        );
    }
    done(w.state, path).await;
}

#[tokio::test]
async fn timed_out_moderators_can_read() {
    let (w, path) = world("reports_timed_out").await;
    let db = w.db();
    let id = w.about("alice", "bob", T0).await;
    exec(db, &format!("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('s', 'mo', {}, 0)", now() + 3600)).await;
    assert_eq!(w.ids("mo", json!({})).await, [id]);
    assert_eq!(w.open("mo").await, 1);
    w.detail("mo", id).await.expect("detail");
    let mo = who(db, "mo").await;
    assert_eq!(
        refusal(
            report_scope(db, &mo, Some("s"), ReportMode::Write)
                .await
                .map(|s| s.viewer)
        ),
        (403, "You are timed out in this server".to_string())
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn site_admin_reads_any_server_read_only() {
    let (w, path) = world("reports_staff").await;
    let db = w.db();
    let id = w.about("alice", "bob", T0).await;
    let in_ops = ops_report(&w, T0 + 1).await;
    assert_eq!(
        w.admin_ids("root", json!({"scope": "server", "server": "S"}), json!({}))
            .await
            .expect("staff"),
        [in_ops, id],
        "every channel"
    );
    assert!(
        w.admin_ids("root", json!({}), json!({}))
            .await
            .expect("instance")
            .is_empty()
    );
    assert_eq!(
        refusal(
            w.admin_ids("root", json!({"scope": "nonsense"}), json!({}))
                .await
        ),
        (400, "Unknown scope".to_string())
    );
    assert_eq!(
        refusal(
            w.admin_ids(
                "root",
                json!({"scope": "server", "server": "nowhere"}),
                json!({})
            )
            .await
        ),
        (404, "Server not found or wrong password".to_string())
    );
    w.detail("root", id).await.expect("staff reads the detail");
    let root = who(db, "root").await;
    let read = report_scope(db, &root, Some("s"), ReportMode::Read)
        .await
        .expect("read");
    assert!(read.staff && read.all_channels);
    assert_eq!(
        refusal(
            report_scope(db, &root, Some("s"), ReportMode::Write)
                .await
                .map(|s| s.viewer)
        ),
        (404, "Server not found or wrong password".to_string())
    );
    assert!(
        w.my_open("root").await.is_empty(),
        "staff powers give no badge"
    );
    for name in ["olga", "mo", "alice"] {
        let user = who(db, name).await;
        assert_eq!(
            refusal(
                report_scope(db, &user, Some("s"), ReportMode::Staff)
                    .await
                    .map(|s| s.viewer)
            ),
            (404, "Not found".to_string()),
            "{name}: only the site admin reads with the instance's powers"
        );
    }
    add_member(db, "s", "root", 0, 0, 0).await;
    assert_eq!(
        refusal(
            report_scope(db, &root, Some("s"), ReportMode::Write)
                .await
                .map(|s| s.viewer)
        ),
        (403, "Missing permission".to_string()),
        "as a member, only their own permission counts"
    );
    let read = report_scope(db, &root, Some("s"), ReportMode::Read)
        .await
        .expect("read");
    assert!(
        read.staff && read.all_channels,
        "a member without the permission reads with the instance's powers, as staff"
    );
    assert_eq!(w.ids("root", json!({})).await, [in_ops, id]);
    exec(
        db,
        &format!(
            "INSERT INTO user_roles(server, username, role_id) VALUES('s', 'root', {})",
            w.mods
        ),
    )
    .await;
    let own = report_scope(db, &root, Some("s"), ReportMode::Write)
        .await
        .expect("write");
    assert!(!own.staff);
    done(w.state, path).await;
}

#[tokio::test]
async fn a_site_admin_with_the_permission_reads_as_that_member() {
    let (w, path) = world("reports_admin_member").await;
    let db = w.db();
    let id = w.about("alice", "bob", T0).await;
    let in_ops = ops_report(&w, T0 + 1).await;
    add_member(db, "s", "root", 0, 0, 0).await;
    exec(
        db,
        &format!(
            "INSERT INTO user_roles(server, username, role_id) VALUES('s', 'root', {})",
            w.mods
        ),
    )
    .await;
    let root = who(db, "root").await;
    for mode in [ReportMode::Read, ReportMode::Write] {
        let own = report_scope(db, &root, Some("s"), mode)
            .await
            .expect("a holder");
        assert_eq!(
            (own.staff, own.all_channels, own.closed.as_slice()),
            (false, false, [w.ops].as_slice()),
            "{mode:?}: the membership decides what they see"
        );
    }
    assert_eq!(w.ids("root", json!({})).await, [id]);
    assert_eq!(
        wire(w.detail("root", in_ops).await).await,
        (404, r#"{"error":"Not found"}"#.to_string())
    );
    assert_eq!(
        w.my_open("root").await,
        [OpenCount {
            server: "s".to_string(),
            open: 1
        }]
    );
    assert_eq!(
        w.admin_ids("root", json!({"scope": "server", "server": "s"}), json!({}))
            .await
            .expect("the admin routes read with the instance's powers"),
        [in_ops, id]
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn related_reports_leave_out_channels_the_viewer_cant_view() {
    let (w, path) = world("reports_related_channels").await;
    let in_ops = ops_report(&w, T0).await;
    let about_carol = w.about("alice", "carol", T0 + 1).await;
    let related = |by: &'static str| {
        let w = &w;
        async move {
            w.detail(by, about_carol)
                .await
                .unwrap_or_else(|e| panic!("{by}: {e:?}"))
                .related
                .iter()
                .map(|r| r.id)
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(related("olga").await, [in_ops]);
    assert!(
        related("mo").await.is_empty(),
        "a report about a message in #ops stays out of what mo sees of the same account"
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn a_long_history_comes_in_pages() {
    let (w, path) = world("reports_history_pages").await;
    let db = w.db();
    let id = w.about("alice", "bob", T0).await;
    for n in 1..=120 {
        exec(db, &format!("INSERT INTO report_events(report_id, actor, kind, detail, created_at) VALUES({id}, 'mo', 'note', '{{\"text\": \"note {n}\"}}', {})", T0 + n)).await;
    }
    let texts = |events: &[ReportEvent]| {
        events
            .iter()
            .map(|e| match e.kind.as_str() {
                "note" => e.detail["text"].as_str().expect("text").to_string(),
                kind => kind.to_string(),
            })
            .collect::<Vec<_>>()
    };
    let notes = |range: std::ops::RangeInclusive<i64>| {
        range.map(|n| format!("note {n}")).collect::<Vec<_>>()
    };
    let detail = w.detail("mo", id).await.expect("detail");
    assert_eq!(
        texts(&detail.events),
        notes(71..=120),
        "the newest 50 lines, oldest first"
    );
    let page = |by: &'static str, cursor: Option<String>| {
        let w = &w;
        async move {
            let user = who(w.db(), by).await;
            list_events(
                State(w.state.clone()),
                Authed(user),
                Path(id),
                Query(EventsQuery { cursor }),
            )
            .await
        }
    };
    let Paged(newest, next) = page("mo", None).await.expect("the newest page");
    assert_eq!(texts(&newest), notes(71..=120));
    assert_eq!(next, detail.events_cursor);
    let Paged(middle, next) = page("mo", detail.events_cursor).await.expect("earlier");
    assert_eq!(texts(&middle), notes(21..=70));
    let Paged(first, end) = page("mo", next).await.expect("the first lines");
    let mut start = vec!["created".to_string()];
    start.extend(notes(1..=20));
    assert_eq!(texts(&first), start);
    assert_eq!(end, None);
    assert_eq!(
        first[0].actor, None,
        "the first line never names the reporter"
    );

    let short = w.about("carol", "dave", T0).await;
    let detail = w.detail("mo", short).await.expect("detail");
    assert_eq!((detail.events.len(), detail.events_cursor), (1, None));
    for name in ["alice", "bob", "erin"] {
        assert_eq!(
            wire(page(name, None).await.map(|Paged(events, _)| events)).await,
            (404, r#"{"error":"Not found"}"#.to_string()),
            "{name}: a plain member, the one reported, a non-member"
        );
    }
    assert_eq!(
        refusal(
            page("mo", Some("nonsense".to_string()))
                .await
                .map(|Paged(events, _)| events)
        )
        .0,
        400
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn oldest_first_lists_the_oldest_open_report() {
    let (w, path) = world("reports_oldest").await;
    let db = w.db();
    let closed = w.about("alice", "bob", T0).await;
    exec(
        db,
        &format!("UPDATE reports SET status = 'resolved' WHERE id = {closed}"),
    )
    .await;
    let oldest = w.about("carol", "bob", T0 + 1).await;
    let newer = w.about("dave", "bob", T0 + 2).await;
    assert_eq!(
        w.ids("mo", json!({"status": "open", "oldest": true, "limit": 1}))
            .await,
        [oldest]
    );
    assert_eq!(
        w.ids("mo", json!({"status": "open", "oldest": true})).await,
        [oldest, newer]
    );
    let user = who(db, "mo").await;
    let Paged(first, next) = list_reports(
        State(w.state.clone()),
        Authed(user.clone()),
        Path("s".to_string()),
        Query(query(json!({"oldest": true, "limit": 2}))),
    )
    .await
    .expect("page");
    assert_eq!(
        first.iter().map(|r| r.id).collect::<Vec<_>>(),
        [closed, oldest]
    );
    let Paged(second, _) = list_reports(
        State(w.state.clone()),
        Authed(user),
        Path("s".to_string()),
        Query(query(
            json!({"oldest": true, "limit": 2, "cursor": next.expect("cursor")}),
        )),
    )
    .await
    .expect("page");
    assert_eq!(second.iter().map(|r| r.id).collect::<Vec<_>>(), [newer]);
    done(w.state, path).await;
}

#[tokio::test]
async fn detail_shows_snapshot_events_and_related() {
    let (w, path) = world("reports_detail").await;
    let db = w.db();
    let older = w.about("carol", "bob", T0).await;
    message(db, w.general, "carol", "before", 100).await;
    let said = message(db, w.general, "bob", "buy my coins", 200).await;
    let id = w
        .send("alice", json!({"to": "server", "target": {"kind": "message", "id": said}, "reason": "spam", "context": 5, "form": "message", "answers": [{"id": "details", "value": "third time today"}]}), T0 + 5)
        .await
        .expect("report")
        .id;
    let detail = w.detail("mo", id).await.expect("detail");
    assert_eq!(detail.report.id, id);
    assert_eq!(detail.report.excerpt, "buy my coins");
    assert_eq!(detail.report.channel.as_deref(), Some("general"));
    assert_eq!(detail.note, None);
    assert_eq!(
        serde_json::to_value(&detail.answers).expect("json"),
        json!([{"id": "details", "label": "Note", "kind": "long_text", "value": "third time today"}])
    );
    let shown = detail.snapshot.message.as_ref().expect("message");
    assert_eq!(shown.content, "buy my coins");
    assert_eq!(
        detail
            .snapshot
            .context
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        ["before"]
    );
    assert!(!detail.franked);
    assert_eq!(
        serde_json::to_value(&detail.events).expect("json"),
        json!([{"kind": "created", "actor": null, "detail": {}, "created_at": T0 + 5}]),
        "the history never repeats who reported"
    );
    assert_eq!(
        detail.related.iter().map(|r| r.id).collect::<Vec<_>>(),
        [older]
    );
    exec(db, &format!("INSERT INTO report_events(report_id, actor, kind, detail, created_at) VALUES({id}, 'mo', 'note', '{{\"text\": \"looking\"}}', {})", T0 + 9)).await;
    let detail = w.detail("mo", id).await.expect("detail");
    assert_eq!(
        serde_json::to_value(&detail.events[1]).expect("json")["actor"]["username"],
        "mo"
    );
    assert_eq!(detail.events[1].detail, json!({"text": "looking"}));
    let mut conn = db.acquire().await.expect("conn");
    forget_user(&mut conn, "bob").await.expect("forget");
    drop(conn);
    let detail = w.detail("mo", id).await.expect("after the account is gone");
    assert_eq!(
        (
            detail.report.target,
            detail.report.target_key.as_str(),
            detail
                .snapshot
                .message
                .as_ref()
                .and_then(|m| m.author.clone())
        ),
        (
            None,
            format!("d:{id}").as_str(),
            Some(SnapUser {
                deleted: true,
                ..SnapUser::default()
            })
        )
    );
    assert_eq!(
        w.grouped("mo", json!({"by": "member"})).await,
        [(format!("d:{older}"), 1, 1), (format!("d:{id}"), 1, 1)]
    );
    done(w.state, path).await;
}

#[tokio::test]
async fn open_counts_cover_my_servers() {
    let (w, path) = world("reports_open").await;
    let db = w.db();
    exec(
        db,
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('s2', 'S2', 'mo', 0)",
    )
    .await;
    add_member(db, "s2", "mo", 1, 0, 0).await;
    add_member(db, "s2", "alice", 0, 0, 0).await;
    exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('s3', 'S3', 'olga', 0)").await;
    add_member(db, "s3", "mo", 1, 4, 0).await;
    w.about("alice", "bob", T0).await;
    w.about("alice", "carol", T0).await;
    let closed = w.about("carol", "dave", T0).await;
    exec(
        db,
        &format!("UPDATE reports SET status = 'in_review' WHERE id = {closed}"),
    )
    .await;
    let mo = who(db, "mo").await;
    assert_eq!(
        crate::api::access::report_servers(db, &mo)
            .await
            .expect("servers"),
        ["s", "s2"],
        "a role and an admin with every permission, not an admin with Kick only"
    );
    assert_eq!(
        w.my_open("mo").await,
        [OpenCount {
            server: "s".to_string(),
            open: 2
        }]
    );
    assert!(w.my_open("alice").await.is_empty());
    assert!(w.my_open("root").await.is_empty());
    done(w.state, path).await;
}

#[test]
fn days_and_dates() {
    for (days, date) in [
        (0, "1970-01-01"),
        (59, "1970-03-01"),
        (11_016, "2000-02-29"),
        (19_358, "2023-01-01"),
        (20_513, "2026-03-01"),
    ] {
        assert_eq!(query::date_of(days), date);
        assert_eq!(query::day_of(date), Some(days));
    }
    for bad in [
        "",
        "2026",
        "2026-02-30",
        "2026-13-01",
        "2026-1-1x",
        "2026-01-01-01",
    ] {
        assert_eq!(query::day_of(bad), None, "{bad}");
    }
}
