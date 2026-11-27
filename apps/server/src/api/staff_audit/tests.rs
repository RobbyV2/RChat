use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::Row;

use super::*;
use crate::api::access::{Proof, resolve_channel, resolve_server, ws_channel_seen};
use crate::api::auth::hash_password;
use crate::api::test_util::{add_member, each_db};
use crate::db::{NewUser, get_user};

struct Places {
    general: i64,
    hidden: i64,
}

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .expect(sql);
}

async fn id_of(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("id")
}

/// `club`, a server nobody opens by its name, with `general` and `hidden`, which only alice
/// views. alice and bob are members; root is a site admin and a member; sage is a site admin
/// and no member.
async fn places(state: &AppState) -> Places {
    let db = &state.db;
    let hash = hash_password("pw").await.expect("hash");
    for (name, admin) in [
        ("alice", false),
        ("bob", false),
        ("root", true),
        ("sage", true),
    ] {
        NewUser::plain(name).hash(&hash).admin(admin).add(db).await;
    }
    club(db).await
}

/// `club` and its channels, for the accounts alice, bob and root.
async fn club(db: &Db) -> Places {
    let hash = hash_password("pw").await.expect("hash");
    sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('club', 'Club', 'alice', $1, 0)")
        .bind(&hash)
        .execute(db)
        .await
        .expect("club");
    add_member(db, "club", "alice", 1, 0, 0).await;
    add_member(db, "club", "bob", 0, 0, 0).await;
    add_member(db, "club", "root", 0, 0, 0).await;
    let general = id_of(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 0) RETURNING id",
    )
    .await;
    let hidden = id_of(
        db,
        "INSERT INTO channels(server, name, restrict_view, created_at) VALUES('club', 'hidden', 1, 0) RETURNING id",
    )
    .await;
    exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden}, 'u:alice', 1, 1, 1)")).await;
    Places { general, hidden }
}

/// Opens channel `channel` of `server` to the site admin `admin` as a confirmation does.
pub(crate) async fn confirmed(db: &Db, admin: &str, server: &str, channel: i64) {
    instance_audit::record(
        db,
        admin,
        VIEW_CHANNEL,
        Some(server),
        json!({ "channel": channel }),
    )
    .await
    .expect("confirmed");
}

async fn user(db: &Db, name: &str) -> User {
    get_user(db, name).await.expect("read").expect("user")
}

async fn session(db: &Db, name: &str) -> Session {
    Session {
        user: user(db, name).await,
        token: format!("token-{name}"),
        created_at: 0,
    }
}

fn password(secret: &str) -> ReAuthBody {
    serde_json::from_value(json!({ "password": secret })).expect("body")
}

/// The entries of `action`, oldest first, as (actor, target, detail).
async fn entries(db: &Db, action: &str) -> Vec<(Option<String>, Option<String>, Value)> {
    sqlx::query("SELECT actor, target, detail FROM instance_audit WHERE action = $1 ORDER BY id")
        .bind(action)
        .fetch_all(db)
        .await
        .expect("entries")
        .iter()
        .map(|r| {
            let detail: String = r.try_get(2).expect("detail");
            (
                r.try_get(0).expect("actor"),
                r.try_get(1).expect("target"),
                serde_json::from_str(&detail).expect("json"),
            )
        })
        .collect()
}

async fn age(db: &Db, action: &str, secs: i64) {
    sqlx::query("UPDATE instance_audit SET at = at - $1 WHERE action = $2")
        .bind(secs)
        .bind(action)
        .execute(db)
        .await
        .expect("age");
}

fn code<T>(res: Result<T, ApiError>) -> Option<(StatusCode, String)> {
    res.err().map(|ApiError(status, text, _)| (status, text))
}

fn named(actor: &str, target: &str, detail: Value) -> (Option<String>, Option<String>, Value) {
    (Some(actor.to_string()), Some(target.to_string()), detail)
}

async fn count(db: &Db, sql: &str) -> i64 {
    id_of(db, sql).await
}

/// root bans the account `name` from the instance through the admin route.
async fn ban(state: &AppState, name: &str) -> Result<(), ApiError> {
    let root = user(&state.db, "root").await;
    let req = serde_json::from_value(json!({ "username": name })).expect("ban");
    crate::api::admin::ban_user(State(state.clone()), crate::api::Authed(root), Json(req))
        .await
        .map(|_| ())
}

/// root deletes the account `name` through the admin route.
async fn drop_account(state: &AppState, name: &str) -> Result<(), ApiError> {
    let root = user(&state.db, "root").await;
    crate::api::admin::delete_user(
        State(state.clone()),
        crate::api::Authed(root),
        Path(name.to_string()),
    )
    .await
    .map(|_| ())
}

/// Waits until every started purge has finished.
async fn settle(db: &Db) {
    for _ in 0..400 {
        if count(db, "SELECT COUNT(*) FROM pending_purges").await == 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("purge did not finish");
}

#[test]
fn reasons_are_percent_decoded_trimmed_and_bounded() {
    let read = |raw: &str| parse_reason(raw.as_bytes()).ok();
    assert_eq!(read(""), Some(None));
    assert_eq!(read("  %20 "), Some(None));
    assert_eq!(
        read("Report%20%2312%3A%20caf%C3%A9"),
        Some(Some("Report #12: caf\u{e9}".to_string()))
    );
    assert_eq!(
        read(&"a".repeat(REASON_MAX)).flatten().map(|r| r.len()),
        Some(REASON_MAX)
    );
    assert_eq!(
        read(&"%C3%A9".repeat(REASON_MAX))
            .flatten()
            .map(|r| r.chars().count()),
        Some(REASON_MAX)
    );
    for bad in [
        "a".repeat(REASON_MAX + 1),
        "line%0Abreak".to_string(),
        "%FF".to_string(),
    ] {
        let refused = parse_reason(bad.as_bytes());
        assert_eq!(
            code(refused),
            Some((StatusCode::BAD_REQUEST, BAD_REASON.to_string())),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn a_server_opened_with_instance_powers_is_noted_once_an_hour() {
    for (state, temp) in each_db("staff_audit_server").await {
        places(&state).await;
        let db = &state.db;
        let (root, sage, bob) = (
            user(db, "root").await,
            user(db, "sage").await,
            user(db, "bob").await,
        );
        for _ in 0..3 {
            resolve_server(db, "club", Some(&sage), &Proof::none())
                .await
                .expect("staff");
        }
        resolve_server(db, "club", Some(&root), &Proof::none())
            .await
            .expect("member");
        resolve_server(db, "club", Some(&bob), &Proof::none())
            .await
            .expect("member");
        assert_eq!(
            entries(db, VIEW_SERVER).await,
            vec![named("sage", "club", json!({}))]
        );
        age(db, VIEW_SERVER, REPEAT_SECS + 1).await;
        with_reason(db, "Report%2012", async {
            resolve_server(&state.read(), "club", Some(&sage), &Proof::none())
                .await
                .expect("staff");
        })
        .await;
        assert_eq!(
            entries(db, VIEW_SERVER).await,
            vec![
                named("sage", "club", json!({})),
                named("sage", "club", json!({"reason": "Report 12"})),
            ]
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_reason_that_is_too_long_refuses_the_view() {
    for (state, temp) in each_db("staff_audit_reason").await {
        places(&state).await;
        let db = &state.db;
        let sage = user(db, "sage").await;
        let long = "a".repeat(REASON_MAX + 1);
        let refused = with_reason(db, &long, async {
            resolve_server(db, "club", Some(&sage), &Proof::none()).await
        })
        .await;
        assert_eq!(
            code(refused),
            Some((StatusCode::BAD_REQUEST, BAD_REASON.to_string()))
        );
        assert_eq!(entries(db, VIEW_SERVER).await, vec![]);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_private_channel_opens_to_a_site_admin_only_after_a_confirmation() {
    for (state, temp) in each_db("staff_audit_channel").await {
        let Places { general, hidden } = places(&state).await;
        let db = &state.db;
        let (root, bob) = (user(db, "root").await, user(db, "bob").await);
        let open = resolve_channel(db, general, Some(&root), &Proof::none())
            .await
            .expect("general");
        assert!(!open.staff_view());
        let asked = resolve_channel(db, hidden, Some(&root), &Proof::none()).await;
        assert!(asked.as_ref().is_err_and(asks_to_confirm));
        let reason = asked.as_ref().err().and_then(|e| e.2.clone());
        assert_eq!(
            reason.map(|r| (r.kind, r.control, r.channel)),
            Some((
                crate::api::ReasonKind::Confirm,
                Some(CONFIRM.to_string()),
                Some(hidden)
            ))
        );
        assert_eq!(
            code(asked),
            Some((StatusCode::FORBIDDEN, CONFIRM_FIRST.to_string()))
        );
        let plain = resolve_channel(db, hidden, Some(&bob), &Proof::none()).await;
        assert_eq!(
            code(plain),
            Some((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        assert_eq!(
            ws_channel_seen(db, "club", hidden, Some("root"))
                .await
                .expect("seen"),
            (false, None)
        );

        let t = now();
        let wrong =
            staff_view_at(&state, session(db, "root").await, hidden, password("no"), t).await;
        assert_eq!(
            code(wrong),
            Some((StatusCode::UNAUTHORIZED, "Wrong password".to_string()))
        );
        let fresh: ReAuthBody =
            serde_json::from_value(json!({"fresh_session": true})).expect("body");
        let unconfirmed = staff_view_at(&state, session(db, "root").await, hidden, fresh, t).await;
        assert_eq!(
            unconfirmed.err().map(|e| e.0),
            Some(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(entries(db, VIEW_CHANNEL).await, vec![]);
        let still = resolve_channel(db, hidden, Some(&root), &Proof::none()).await;
        assert!(still.is_err_and(|e| asks_to_confirm(&e)));

        let mut rx = state.hub.subscribe();
        let opened = with_reason(db, "Report%2012", async {
            staff_view_at(
                &state,
                session(db, "root").await,
                hidden,
                password("pw"),
                t + 10,
            )
            .await
        })
        .await
        .expect("confirmed");
        assert_eq!(opened.0.until, t + 10 + CHANNEL_OPEN_SECS);
        assert_eq!(opened.0.remaining, CHANNEL_OPEN_SECS);
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::StaffViewOpened { username, channel_id }) if username == "root" && channel_id == hidden
        ));
        assert!(rx.try_recv().is_err());
        assert_eq!(
            entries(db, VIEW_CHANNEL).await,
            vec![named(
                "root",
                "club",
                json!({"channel": hidden, "reason": "Report 12"})
            )]
        );
        let seen = resolve_channel(&state.read(), hidden, Some(&root), &Proof::none())
            .await
            .expect("open");
        assert!(seen.staff_view());
        let (view, until) = ws_channel_seen(db, "club", hidden, Some("root"))
            .await
            .expect("seen");
        assert!(view);
        assert!(
            until.is_some_and(
                |u| (now() + CHANNEL_OPEN_SECS - 5..=now() + CHANNEL_OPEN_SECS).contains(&u)
            ),
            "{until:?}"
        );
        assert_eq!(open_channels(db, "root").await.expect("open"), vec![hidden]);
        let other =
            resolve_channel(db, hidden, Some(&user(db, "sage").await), &Proof::none()).await;
        assert!(other.is_err_and(|e| asks_to_confirm(&e)));

        age(db, VIEW_CHANNEL, CHANNEL_OPEN_SECS + 1).await;
        let closed = resolve_channel(db, hidden, Some(&root), &Proof::none()).await;
        assert!(closed.is_err_and(|e| asks_to_confirm(&e)));
        assert_eq!(
            open_channels(db, "root").await.expect("open"),
            Vec::<i64>::new()
        );
        assert_eq!(
            ws_channel_seen(db, "club", hidden, Some("root"))
                .await
                .expect("seen"),
            (false, None)
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_channel_the_admin_s_own_membership_opens_needs_no_confirmation() {
    for (state, temp) in each_db("staff_audit_own").await {
        let Places { general, hidden } = places(&state).await;
        let db = &state.db;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden}, 'u:root', 1, 1, 1)")).await;
        let root = user(db, "root").await;
        for (n, id) in [(0, general), (1, hidden)] {
            let channel = resolve_channel(db, id, Some(&root), &Proof::none())
                .await
                .expect("own");
            assert!(!channel.staff_view());
            assert_eq!(
                ws_channel_seen(db, "club", id, Some("root"))
                    .await
                    .expect("seen"),
                (true, None)
            );
            let _ = staff_view_at(
                &state,
                session(db, "root").await,
                id,
                password("pw"),
                now() + n * 10,
            )
            .await
            .expect("nothing to confirm");
        }
        assert_eq!(entries(db, VIEW_CHANNEL).await, vec![]);
        assert_eq!(entries(db, VIEW_SERVER).await, vec![]);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn an_admin_who_is_no_member_reads_open_channels_as_staff_and_confirms_private_ones() {
    for (state, temp) in each_db("staff_audit_outside").await {
        let Places { general, hidden } = places(&state).await;
        let db = &state.db;
        let sage = user(db, "sage").await;
        let open = resolve_channel(db, general, Some(&sage), &Proof::none())
            .await
            .expect("general");
        assert!(open.staff_view());
        let asked = resolve_channel(db, hidden, Some(&sage), &Proof::none()).await;
        assert!(asked.is_err_and(|e| asks_to_confirm(&e)));
        let _ = staff_view_at(
            &state,
            session(db, "sage").await,
            hidden,
            password("pw"),
            now(),
        )
        .await
        .expect("confirmed");
        let seen = resolve_channel(db, hidden, Some(&sage), &Proof::none())
            .await
            .expect("open");
        assert!(seen.staff_view());
        assert_eq!(
            entries(db, VIEW_CHANNEL).await,
            vec![named("sage", "club", json!({"channel": hidden}))]
        );
        assert_eq!(
            entries(db, VIEW_SERVER).await,
            vec![named("sage", "club", json!({}))]
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn group_mentions_and_unreads_of_a_private_channel_wait_for_a_confirmation() {
    use crate::api::inbox::{InboxQuery, list_inbox};
    use crate::api::messages::{UnreadsQuery, unreads};
    use axum::extract::Query;
    for (state, temp) in each_db("staff_audit_groups").await {
        let Places { general: _, hidden } = places(&state).await;
        let db = &state.db;
        let role = id_of(
            db,
            "INSERT INTO roles(server, name, color, perms) VALUES('club', 'crew', '#ffffff', 2) RETURNING id",
        )
        .await;
        exec(
            db,
            &format!(
                "INSERT INTO user_roles(server, username, role_id) VALUES('club', 'root', {role})"
            ),
        )
        .await;
        let t = now();
        let mut said = Vec::new();
        for (text, kind, role_id) in [
            ("@everyone secret plans", "everyone", None),
            ("@crew secret plans", "role", Some(role)),
        ] {
            let id = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({hidden}, 'alice', '{text}', {t}) RETURNING id")).await;
            sqlx::query("INSERT INTO group_pings(message_id, channel_id, server, kind, role_id, actor, created_at) VALUES($1, $2, 'club', $3, $4, 'alice', $5)")
                .bind(id)
                .bind(hidden)
                .bind(kind)
                .bind(role_id)
                .bind(t)
                .execute(db)
                .await
                .expect("group ping");
            said.push(id);
        }
        let root = user(db, "root").await;
        let listed = || {
            let (state, root) = (state.clone(), root.clone());
            async move {
                let q: InboxQuery = serde_json::from_value(json!({})).expect("query");
                let page = list_inbox(State(state), crate::api::Authed(root), Query(q))
                    .await
                    .expect("inbox")
                    .0;
                let mut ids: Vec<i64> = page.items.iter().map(|i| i.id).collect();
                ids.sort_unstable();
                ids
            }
        };
        let unread = || {
            let (state, root) = (state.clone(), root.clone());
            async move {
                let q: UnreadsQuery = serde_json::from_value(json!({})).expect("query");
                unreads(State(state), crate::api::Authed(root), Query(q))
                    .await
                    .expect("unreads")
                    .0
                    .items
                    .iter()
                    .any(|u| u.scope == format!("c{hidden}"))
            }
        };
        assert_eq!(listed().await, Vec::<i64>::new());
        assert!(!unread().await);
        assert_eq!(entries(db, VIEW_CHANNEL).await, vec![]);
        confirmed(db, "root", "club", hidden).await;
        assert_eq!(listed().await, said);
        assert!(unread().await);
        age(db, VIEW_CHANNEL, CHANNEL_OPEN_SECS + 1).await;
        assert_eq!(listed().await, Vec::<i64>::new());
        assert!(!unread().await);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn history_from_before_a_site_admin_s_join_waits_for_a_confirmation() {
    use crate::api::access::{resolve_message, ws_channel_read_since};
    for (state, temp) in each_db("staff_audit_history").await {
        places(&state).await;
        let db = &state.db;
        exec(
            db,
            "UPDATE members SET joined_at = 100 WHERE server = 'club' AND username = 'root'",
        )
        .await;
        let notes = id_of(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('club', 'notes', 0) RETURNING id",
        )
        .await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({notes}, 'u:root', 1, 1, 0)")).await;
        let old = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({notes}, 'alice', 'before', 50) RETURNING id")).await;
        let new = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({notes}, 'alice', 'after', 150) RETURNING id")).await;
        let root = user(db, "root").await;
        let plain = User {
            is_site_admin: false,
            ..root.clone()
        };
        for who in [&plain, &root] {
            let before = resolve_message(db, old, Some(who), &Proof::none()).await;
            assert_eq!(
                code(before),
                Some((StatusCode::NOT_FOUND, "Not found".to_string())),
                "admin {}",
                who.is_site_admin
            );
            let seen = resolve_message(db, new, Some(who), &Proof::none())
                .await
                .expect("since the join");
            assert!(!seen.channel().expect("channel").staff_view());
        }
        let channel = resolve_channel(db, notes, Some(&root), &Proof::none())
            .await
            .expect("own membership");
        assert_eq!(channel.read_since(db).await.expect("since"), Some(100));
        assert_eq!(
            ws_channel_read_since(db, "club", notes, "root").await,
            Some(Some(100))
        );
        assert_eq!(
            ws_channel_seen(db, "club", notes, Some("root"))
                .await
                .expect("seen"),
            (true, None)
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM instance_audit WHERE action LIKE 'staff.%'"
            )
            .await,
            0
        );

        let _ = staff_view_at(
            &state,
            session(db, "root").await,
            notes,
            password("pw"),
            now(),
        )
        .await
        .expect("confirmed");
        assert_eq!(
            entries(db, VIEW_CHANNEL).await,
            vec![named("root", "club", json!({"channel": notes}))]
        );
        let opened = resolve_message(db, old, Some(&root), &Proof::none())
            .await
            .expect("whole history");
        assert!(opened.channel().expect("channel").staff_view());
        assert_eq!(
            ws_channel_read_since(db, "club", notes, "root").await,
            Some(None)
        );
        age(db, VIEW_CHANNEL, CHANNEL_OPEN_SECS + 1).await;
        let closed = resolve_message(db, old, Some(&root), &Proof::none()).await;
        assert_eq!(
            code(closed),
            Some((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        assert_eq!(
            ws_channel_read_since(db, "club", notes, "root").await,
            Some(Some(100))
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn only_a_site_admin_confirms_and_missing_channels_answer_alike() {
    for (state, temp) in each_db("staff_audit_hidden").await {
        let Places { general: _, hidden } = places(&state).await;
        let db = &state.db;
        let missing = (StatusCode::NOT_FOUND, "Not found".to_string());
        for (who, id) in [("bob", hidden), ("alice", hidden), ("root", hidden + 1000)] {
            let refused =
                staff_view_at(&state, session(db, who).await, id, password("pw"), now()).await;
            assert_eq!(code(refused), Some(missing.clone()), "{who} {id}");
        }
        assert_eq!(entries(db, VIEW_CHANNEL).await, vec![]);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn nothing_opens_when_the_entry_cannot_be_written() {
    for (state, temp) in each_db("staff_audit_closed").await {
        let Places { general, hidden } = places(&state).await;
        let db = &state.db;
        let (root, sage, bob) = (
            user(db, "root").await,
            user(db, "sage").await,
            user(db, "bob").await,
        );
        exec(db, "INSERT INTO p2p_identities(username, ik, record, updated_at) VALUES('bob', 'ik-one', '{}', 0)").await;
        exec(
            db,
            "ALTER TABLE instance_audit RENAME TO instance_audit_away",
        )
        .await;
        let down = (StatusCode::SERVICE_UNAVAILABLE, NOT_RECORDED.to_string());
        let server = resolve_server(db, "club", Some(&sage), &Proof::none()).await;
        assert_eq!(code(server), Some(down.clone()));
        let channel = resolve_channel(db, hidden, Some(&root), &Proof::none()).await;
        assert_eq!(code(channel), Some(down.clone()));
        let confirm = staff_view_at(
            &state,
            session(db, "root").await,
            hidden,
            password("pw"),
            now(),
        )
        .await;
        assert_eq!(code(confirm), Some(down.clone()));
        let (view, until) = ws_channel_seen(db, "club", hidden, Some("root"))
            .await
            .expect("seen");
        assert!(!view);
        assert!(
            until.is_some_and(|u| u <= now()),
            "closed until the next event: {until:?}"
        );
        let purge = ban(&state, "bob").await;
        assert_eq!(code(purge), Some(down));
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM users WHERE username = 'bob' AND password_hash <> '!purging'"
            )
            .await,
            1,
            "the account is banned only together with the entry"
        );
        assert_eq!(count(db, "SELECT COUNT(*) FROM pending_purges").await, 0);
        resolve_channel(db, general, Some(&root), &Proof::none())
            .await
            .expect("own membership");
        resolve_channel(db, general, Some(&bob), &Proof::none())
            .await
            .expect("member");
        exec(
            db,
            "ALTER TABLE instance_audit_away RENAME TO instance_audit",
        )
        .await;
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_purge_of_held_p2p_data_is_noted_once_with_counts_only() {
    for (state, temp) in each_db("staff_audit_p2p").await {
        places(&state).await;
        let db = &state.db;
        let hash = hash_password("pw").await.expect("hash");
        for name in ["carol", "dave"] {
            NewUser::plain(name).hash(&hash).add(db).await;
        }
        drop_account(&state, "carol").await.expect("nothing held");
        settle(db).await;
        assert_eq!(entries(db, P2P_DATA).await, vec![]);
        for version in [1, 2] {
            sqlx::query("INSERT INTO p2p_backups(username, ik, version, size, updated_at, data) VALUES('bob', 'ik-one', $1, 3, 0, $2)")
                .bind(version)
                .bind(b"abc".to_vec())
                .execute(db)
                .await
                .expect("backup");
        }
        for (name, ik) in [("bob", "ik-one"), ("alice", "ik-two"), ("dave", "ik-three")] {
            sqlx::query("INSERT INTO p2p_identities(username, ik, record, updated_at) VALUES($1, $2, '{}', 0)")
                .bind(name)
                .bind(ik)
                .execute(db)
                .await
                .expect("identity");
        }
        with_reason(db, "Court%20order", ban(&state, "bob"))
            .await
            .expect("banned");
        assert_eq!(
            entries(db, P2P_DATA).await,
            vec![named(
                "root",
                "bob",
                json!({"op": "purge", "backups": 2, "identities": 1, "reason": "Court order"})
            )]
        );
        settle(db).await;
        assert_eq!(
            entries(db, P2P_DATA).await,
            vec![(
                Some("root".to_string()),
                None,
                json!({"op": "purge", "backups": 2, "identities": 1, "reason": "Court order"})
            )],
            "the purge forgets whose data it was"
        );

        exec(
            db,
            "UPDATE users SET password_hash = '!purging' WHERE username = 'dave'",
        )
        .await;
        exec(db, "INSERT INTO pending_purges(kind, key, created_at, claimed_at) VALUES('user', 'dave', 1, 0)").await;
        ban(&state, "dave")
            .await
            .expect("banned while its purge waits");
        drop_account(&state, "dave")
            .await
            .expect("deleted while its purge waits");
        assert_eq!(
            entries(db, P2P_DATA).await.len(),
            1,
            "an account whose purge has begun is not noted again"
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM banned_usernames WHERE username = 'dave'"
            )
            .await,
            1
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn the_confirmation_works_over_http_and_keeps_the_reason_header() {
    use crate::config::{AppConfig, Roles};
    for (state, temp) in each_db("staff_audit_http").await {
        let db = &state.db;
        let config = AppConfig {
            roles: Roles {
                web: false,
                ..Roles::ALL
            },
            ..AppConfig::defaults()
        };
        let app = crate::server::build_router(None, None, &config, state.clone())
            .layer(crate::server::cors_layer());
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
        let base = format!("http://{addr}/api/v1");
        let client = reqwest::Client::new();
        let read = |res: reqwest::Response| async move {
            serde_json::from_slice::<Value>(&res.bytes().await.expect("body")).expect("json")
        };
        let registered = read(
            client
                .post(format!("{base}/auth/register"))
                .header("content-type", "application/json")
                .body(
                    json!({"username": "root", "password": "pw", "avatar_kind": "identicon"})
                        .to_string(),
                )
                .send()
                .await
                .expect("register"),
        )
        .await;
        let token = registered["token"].as_str().expect("token").to_string();
        assert!(user(db, "root").await.is_site_admin);
        for name in ["alice", "bob"] {
            NewUser::plain(name).add(db).await;
        }
        let Places { general: _, hidden } = club(db).await;

        let page = format!("{base}/channels/{hidden}/messages");
        let asked = client
            .get(&page)
            .bearer_auth(&token)
            .send()
            .await
            .expect("page");
        assert_eq!(asked.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            read(asked).await,
            json!({
                "error": "Confirm to open this channel",
                "reason": {"kind": "confirm", "control": "staff_view", "channel": hidden}
            })
        );
        let confirm = format!("{base}/admin/channels/{hidden}/staff_view");
        let long = client
            .post(&confirm)
            .bearer_auth(&token)
            .header(REASON_HEADER, "a".repeat(REASON_MAX + 1))
            .header("content-type", "application/json")
            .body(json!({"reauth": {"password": "pw"}}).to_string())
            .send()
            .await
            .expect("long reason");
        assert_eq!(long.status(), StatusCode::BAD_REQUEST);
        let opened = client
            .post(&confirm)
            .bearer_auth(&token)
            .header(REASON_HEADER, "Report%2012")
            .header("content-type", "application/json")
            .body(json!({"reauth": {"password": "pw"}}).to_string())
            .send()
            .await
            .expect("confirm");
        assert_eq!(opened.status(), StatusCode::OK);
        assert!(read(opened).await["until"].is_i64());
        assert_eq!(
            entries(db, VIEW_CHANNEL).await,
            vec![named(
                "root",
                "club",
                json!({"channel": hidden, "reason": "Report 12"})
            )]
        );
        let shown = client
            .get(&page)
            .bearer_auth(&token)
            .send()
            .await
            .expect("page");
        assert_eq!(shown.status(), StatusCode::OK);
        server.abort();
        temp.done(state).await;
    }
}
