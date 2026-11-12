use std::collections::HashSet;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::friends;
use crate::api::pings::announce_counts;
use crate::api::{
    ApiError, ApiErrorBody, Authed, OkResp, Paged, UserRef, bad, cursor_int, decode_cursor,
    encode_cursor, ok, placeholders,
};
use crate::db::{AvatarKind, Db, User, get_user, now};
use crate::state::AppState;
use crate::ws::WsEvent;

/// Most users one account can block.
pub const BLOCKS_MAX: i64 = 1000;
const BLOCKS_PAGE: i64 = 50;

/// The answer when a DM, call or friend request is refused because of the recipient's choice.
/// Friends-only DMs give the same text, so it does not tell a block apart.
pub const NOT_ACCEPTING: &str = "This user is not accepting messages from you.";
const YOU_BLOCKED: &str = "You blocked this user. Unblock them to send messages.";
/// The answer when your own "Who can DM you" setting is Friends only and the other user is not
/// your friend.
pub const YOU_FRIENDS_ONLY: &str =
    "You only accept DMs from friends. Change this in Settings > Privacy.";

/// The user to block.
#[derive(Deserialize, ToSchema)]
pub struct BlockReq {
    /// Username, case-insensitive.
    #[schema(example = "bob")]
    username: String,
}

/// A user you blocked.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct BlockedUser {
    /// The blocked user.
    pub user: UserRef,
    /// When you blocked them, Unix seconds.
    pub blocked_at: i64,
}

/// Paging and search for the blocked users list.
#[derive(Deserialize, IntoParams)]
pub struct BlockListQuery {
    /// Opaque cursor from the `X-Next-Cursor` header of the previous page. Empty means the first
    /// page.
    cursor: Option<String>,
    /// Page size, 1 to 50 (clamped), default 50.
    limit: Option<i64>,
    /// Only users whose username or display name starts with this text, case-insensitive.
    #[param(example = "bo")]
    q: Option<String>,
}

/// Whether `blocker` blocked `blocked`.
pub(crate) async fn is_blocked(db: &Db, blocker: &str, blocked: &str) -> Result<bool, ApiError> {
    Ok(
        sqlx::query("SELECT 1 FROM blocks WHERE blocker = $1 AND blocked = $2")
            .bind(blocker)
            .bind(blocked)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
}

/// The users among `users` who blocked `actor`.
pub(crate) async fn blockers_among(
    db: &Db,
    actor: &str,
    users: &[String],
) -> Result<HashSet<String>, ApiError> {
    let mut out = HashSet::new();
    for chunk in users.chunks(100) {
        let sql = format!(
            "SELECT blocker FROM blocks WHERE blocked = $1 AND blocker IN ({})",
            placeholders(2, chunk.len())
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(actor);
        for name in chunk {
            query = query.bind(name.as_str());
        }
        for r in query.fetch_all(db).await? {
            out.insert(r.try_get::<String, _>(0)?);
        }
    }
    Ok(out)
}

/// `users` without the ones who blocked `actor`, in order.
pub(crate) async fn not_blocking(
    db: &Db,
    actor: &str,
    users: &[String],
) -> Result<Vec<String>, ApiError> {
    if users.is_empty() {
        return Ok(Vec::new());
    }
    let blockers = blockers_among(db, actor, users).await?;
    Ok(users
        .iter()
        .filter(|u| !blockers.contains(u.as_str()))
        .cloned()
        .collect())
}

/// Refuses a DM message or call from `sender` to `other` when either blocked the other, or when
/// either takes DMs only from friends and they are not friends. The blocked side and non-friends
/// get the same answer; a refusal because of your own settings says so.
pub(crate) async fn check_dm(db: &Db, sender: &str, other: &str) -> Result<(), ApiError> {
    if sender == other {
        return Ok(());
    }
    if is_blocked(db, other, sender).await? {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            NOT_ACCEPTING.to_string(),
            None,
        ));
    }
    if is_blocked(db, sender, other).await? {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            YOU_BLOCKED.to_string(),
            None,
        ));
    }
    if friends::dm_refused(db, other, sender).await? {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            NOT_ACCEPTING.to_string(),
            None,
        ));
    }
    if friends::dm_refused(db, sender, other).await? {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            YOU_FRIENDS_ONLY.to_string(),
            None,
        ));
    }
    Ok(())
}

/// The one guard for every write into a DM with participants `users` (messages, edits,
/// reactions, pins, calls, call signalling, typing): `check_dm` against the other participant.
pub(crate) async fn check_dm_write(db: &Db, actor: &str, users: &[String]) -> Result<(), ApiError> {
    match users.iter().find(|u| u.as_str() != actor) {
        Some(other) => check_dm(db, actor, other).await,
        None => Ok(()),
    }
}

/// Removes the unseen pings `blocked` caused for `blocker` and sends `ping_count` for each
/// scope that had one.
async fn drop_pings(state: &AppState, blocker: &str, blocked: &str) -> Result<(), ApiError> {
    let rows = sqlx::query(
        "SELECT DISTINCT scope FROM pings WHERE username = $1 AND actor = $2 AND seen = 0",
    )
    .bind(blocker)
    .bind(blocked)
    .fetch_all(&state.db)
    .await?;
    let mut pairs = Vec::with_capacity(rows.len());
    for r in &rows {
        pairs.push((blocker.to_string(), r.try_get::<String, _>(0)?));
    }
    sqlx::query("DELETE FROM pings WHERE username = $1 AND actor = $2 AND seen = 0")
        .bind(blocker)
        .bind(blocked)
        .execute(&state.db)
        .await?;
    announce_counts(state, pairs).await;
    Ok(())
}

/// Block a user
///
/// Blocks `username` for the signed-in user. A blocked user can no longer open a new DM with you,
/// send, edit, react or pin in your DM, call you or answer your call (`403` with the same text a
/// user who does not accept messages gives), a call between you that is ringing or active ends
/// (`call_state` ended, the call log is finalized), and nothing they do pings you: mentions,
/// replies and reactions from them are dropped, and their unseen pings are removed (`ping_count`).
/// Your DM with them is closed (`dm_closed`, read up to its newest message) and does not reopen on
/// their messages. You can not message, edit, react, pin or call in that DM either until you
/// unblock them. Blocking is private: the blocked user gets no event and no answer tells them.
/// Emits `user_blocked` (`{username, user, blocked_at}`) to your connections when the user was not
/// blocked yet; blocking again changes nothing. At most 1000 blocked users. Requires a bearer
/// token. General rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/blocks", tag = "Blocking", request_body = BlockReq, responses((status = 200, description = "The blocked user (also when they were blocked already)", body = BlockedUser), (status = 400, description = "`You cannot block yourself`, or `You can block at most 1000 users`. Malformed JSON or a missing `Content-Type` give plain-text 400/415 framework errors", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "User not found", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn block_user(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<BlockReq>,
) -> Result<Json<BlockedUser>, ApiError> {
    let BlockReq { username } = req;
    let target = username.trim().to_lowercase();
    let Some(other) = get_user(&state.db, &target).await? else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "User not found".to_string(),
            None,
        ));
    };
    if other.username == user.username {
        return Err(bad("You cannot block yourself"));
    }
    let at = now();
    let mut tx = state.db.begin().await?;
    friends::lock_users(&mut tx, &state.db, &[&user.username, &other.username]).await?;
    let added = sqlx::query(
        "INSERT INTO blocks(blocker, blocked, created_at) SELECT $1, $2, $3 WHERE (SELECT COUNT(*) FROM blocks WHERE blocker = $1) < $4 ON CONFLICT(blocker, blocked) DO NOTHING",
    )
    .bind(&user.username)
    .bind(&other.username)
    .bind(at)
    .bind(BLOCKS_MAX)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    let stored = sqlx::query("SELECT created_at FROM blocks WHERE blocker = $1 AND blocked = $2")
        .bind(&user.username)
        .bind(&other.username)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(stored) = stored else {
        return Err(bad("You can block at most 1000 users"));
    };
    let ended = friends::end_rows(&mut tx, &user.username, &other.username).await?;
    tx.commit().await?;
    if !added {
        friends::end_events(&state, &user.username, &other.username, ended).await?;
        return Ok(Json(BlockedUser {
            user: UserRef::from_user(&other),
            blocked_at: stored.try_get(0)?,
        }));
    }
    let blocked = BlockedUser {
        user: UserRef::from_user(&other),
        blocked_at: at,
    };
    state.hub.broadcast(WsEvent::UserBlocked {
        username: user.username.clone(),
        blocked: blocked.clone(),
    });
    friends::end_events(&state, &user.username, &other.username, ended).await?;
    drop_pings(&state, &user.username, &other.username).await?;
    if let Some(dm_id) = crate::api::dms::close_with(&state, &user, &other.username).await? {
        crate::ws::end_dm_call(&state, &user.username, dm_id).await;
    }
    Ok(Json(blocked))
}

/// Unblock a user
///
/// Removes `username` from the signed-in user's blocked users. Their old messages show normally
/// again; pings and DMs work from now on (a DM closed by the block stays closed until a message
/// or `POST /api/v1/dms` reopens it). Emits `user_unblocked` (`{username, blocked}`) to your
/// connections when the user was blocked; unblocking someone who is not blocked changes nothing.
/// Requires a bearer token. General rate-limit bucket.
#[utoipa::path(delete, path = "/api/v1/blocks/{username}", tag = "Blocking", params(("username" = String, Path, description = "Username, case-insensitive")), responses((status = 200, description = "Not blocked anymore; body `{\"ok\": true}`", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn unblock_user(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    let target = username.trim().to_lowercase();
    let removed = sqlx::query("DELETE FROM blocks WHERE blocker = $1 AND blocked = $2")
        .bind(&user.username)
        .bind(&target)
        .execute(&state.db)
        .await?
        .rows_affected();
    if removed > 0 {
        state.hub.broadcast(WsEvent::UserUnblocked {
            username: user.username.clone(),
            blocked: target,
        });
    }
    Ok(ok())
}

pub(crate) fn prefix_pattern(q: &str) -> String {
    let mut p = String::with_capacity(q.len() + 1);
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            p.push('\\');
        }
        p.push(c);
    }
    p.push('%');
    p
}

pub(crate) async fn block_page(
    db: &Db,
    viewer: &str,
    q: &str,
    cursor: Option<&str>,
    limit: i64,
) -> Result<(Vec<BlockedUser>, Option<String>), ApiError> {
    let base = "SELECT b.blocked, u.display_name, u.avatar_kind, u.avatar_color, b.created_at FROM blocks b JOIN users u ON u.username = b.blocked WHERE b.blocker = $1 AND u.password_hash <> '!purging' AND (lower(u.username) LIKE $2 ESCAPE '\\' OR lower(u.display_name) LIKE $2 ESCAPE '\\')";
    let pattern = prefix_pattern(&q.trim().to_lowercase());
    let rows = match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            let sql = format!(
                "{base} AND (b.created_at, b.blocked) < ($3, $4) ORDER BY b.created_at DESC, b.blocked DESC LIMIT $5"
            );
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(viewer)
                .bind(&pattern)
                .bind(cursor_int(&parts[0])?)
                .bind(&parts[1])
                .bind(limit + 1)
                .fetch_all(db)
                .await?
        }
        None => {
            let sql = format!("{base} ORDER BY b.created_at DESC, b.blocked DESC LIMIT $3");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(viewer)
                .bind(&pattern)
                .bind(limit + 1)
                .fetch_all(db)
                .await?
        }
    };
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(BlockedUser {
            user: UserRef {
                username: r.try_get(0)?,
                display_name: r.try_get(1)?,
                avatar_kind: AvatarKind::parse(&r.try_get::<String, _>(2)?)?,
                avatar_color: r.try_get(3)?,
            },
            blocked_at: r.try_get(4)?,
        });
    }
    let more = out.len() as i64 > limit;
    out.truncate(limit as usize);
    let next = match (more, out.last()) {
        (true, Some(last)) => Some(encode_cursor(&[
            &last.blocked_at.to_string(),
            &last.user.username,
        ])),
        _ => None,
    };
    Ok((out, next))
}

/// List blocked users
///
/// Returns the signed-in user's blocked users, most recently blocked first, a page at a time
/// (default and max 50), optionally only those whose username or display name starts with `q`.
/// Requires a bearer token. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/blocks", tag = "Blocking", params(BlockListQuery), responses((status = 200, description = "A page of blocked users, most recently blocked first", body = Vec<BlockedUser>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid cursor (JSON), or a non-integer `limit` (plain-text framework error)", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn list_blocks(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<BlockListQuery>,
) -> Result<Paged<BlockedUser>, ApiError> {
    let BlockListQuery { cursor, limit, q } = q;
    let cursor = cursor.as_deref().filter(|c| !c.trim().is_empty());
    let limit = limit.unwrap_or(BLOCKS_PAGE).clamp(1, BLOCKS_PAGE);
    let (items, next) = block_page(
        &state.read(),
        &user.username,
        q.as_deref().unwrap_or(""),
        cursor,
        limit,
    )
    .await?;
    Ok(Paged(items, next))
}

/// List blocked usernames
///
/// Returns the usernames of everyone the signed-in user blocked (at most 1000), most recently
/// blocked first, so a client can hide their messages and typing everywhere. Requires a bearer
/// token. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/blocks/usernames", tag = "Blocking", responses((status = 200, description = "Lowercase usernames, most recently blocked first", body = Vec<String>), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn blocked_usernames(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Vec<String>>, ApiError> {
    Ok(Json(blocked_names(&state.read(), &user).await?))
}

pub(crate) async fn blocked_names(db: &Db, user: &User) -> Result<Vec<String>, ApiError> {
    let rows = sqlx::query(
        "SELECT blocked FROM blocks WHERE blocker = $1 ORDER BY created_at DESC, blocked DESC LIMIT $2",
    )
    .bind(&user.username)
    .bind(BLOCKS_MAX)
    .fetch_all(db)
    .await?;
    rows.iter()
        .map(|r| r.try_get::<String, _>(0).map_err(ApiError::from))
        .collect()
}

#[cfg(test)]
mod tests {
    use axum::extract::{Path, Query, State};
    use serde_json::json;

    use super::*;
    use crate::api::dms::{close_dm, dm_page, open_dm};
    use crate::api::messages::{edit_message, send_channel_message, send_dm_message};
    use crate::api::pins::{pin_message, unpin_message};
    use crate::api::reactions::add_reaction;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};

    async fn add_user(db: &Db, name: &str, display: &str) {
        crate::db::NewUser::plain(name)
            .shown(display)
            .at(1)
            .add(db)
            .await;
    }

    async fn block(state: &AppState, by: &str, name: &str) -> Result<BlockedUser, ApiError> {
        block_user(
            State(state.clone()),
            Authed(mem_user(by, false)),
            Json(BlockReq {
                username: name.to_string(),
            }),
        )
        .await
        .map(|Json(b)| b)
    }

    async fn unblock(state: &AppState, by: &str, name: &str) {
        let _ = unblock_user(
            State(state.clone()),
            Authed(mem_user(by, false)),
            Path(name.to_string()),
        )
        .await
        .expect("unblock");
    }

    async fn listed(
        state: &AppState,
        q: Option<&str>,
        limit: Option<i64>,
        cursor: Option<String>,
    ) -> (Vec<String>, Option<String>) {
        let Paged(items, next) = list_blocks(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Query(BlockListQuery {
                cursor,
                limit,
                q: q.map(str::to_string),
            }),
        )
        .await
        .expect("list");
        (items.into_iter().map(|b| b.user.username).collect(), next)
    }

    async fn names(state: &AppState) -> Vec<String> {
        blocked_usernames(State(state.clone()), Authed(mem_user("alice", false)))
            .await
            .expect("names")
            .0
    }

    fn code(res: Result<impl Sized, ApiError>) -> Option<(StatusCode, String)> {
        res.err().map(|ApiError(code, text, _)| (code, text))
    }

    fn drain(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::UserBlocked { username, blocked } => {
                    Some(format!("blocked {username} {}", blocked.user.username))
                }
                WsEvent::UserUnblocked { username, blocked } => {
                    Some(format!("unblocked {username} {blocked}"))
                }
                WsEvent::Ping { username, ping } => Some(format!(
                    "ping {username} {} {}",
                    ping.kind.as_str(),
                    ping.actor.username
                )),
                WsEvent::PingCount {
                    username,
                    scope,
                    pings,
                    ..
                } => Some(format!("count {username} {scope} {pings}")),
                WsEvent::DmClosed { username, dm_id } => Some(format!("closed {username} {dm_id}")),
                WsEvent::DmReopened { username, dm_id } => {
                    Some(format!("reopened {username} {dm_id}"))
                }
                WsEvent::ReactionAdded {
                    username, count, ..
                } => Some(format!("reaction {username} {count}")),
                WsEvent::MessageUpdated { .. } => Some("updated".to_string()),
                WsEvent::MessagePinned { pinned_by, .. } => Some(format!("pinned {pinned_by}")),
                WsEvent::MessageUnpinned { message_id, .. } => {
                    Some(format!("unpinned {message_id}"))
                }
                WsEvent::Message {
                    dm_id: Some(id), ..
                } => Some(format!("message d{id}")),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn block_list_search_and_unblock() {
        let (state, path) = temp_state("blocks_list").await;
        let db = &state.db;
        for (name, display) in [
            ("alice", "Alice"),
            ("bob", "Bob"),
            ("carol", "Carol"),
            ("dave", "Zed"),
            ("erin", "Erin"),
            ("root", "Root"),
        ] {
            add_user(db, name, display).await;
        }
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username = 'root'")
            .execute(db)
            .await
            .expect("admin");
        let mut rx = state.hub.subscribe();
        assert_eq!(
            code(block(&state, "alice", "Alice").await),
            Some((
                StatusCode::BAD_REQUEST,
                "You cannot block yourself".to_string()
            ))
        );
        assert_eq!(
            code(block(&state, "alice", "nobody").await),
            Some((StatusCode::NOT_FOUND, "User not found".to_string()))
        );
        let bob = block(&state, "alice", " Bob ").await.expect("block bob");
        assert_eq!(
            (bob.user.username.as_str(), bob.user.display_name.as_str()),
            ("bob", "Bob")
        );
        assert_eq!(drain(&mut rx), ["blocked alice bob"]);
        assert_eq!(
            block(&state, "alice", "bob")
                .await
                .expect("again")
                .blocked_at,
            bob.blocked_at
        );
        assert!(drain(&mut rx).is_empty());
        for name in ["carol", "dave", "root"] {
            block(&state, "alice", name).await.expect("block");
        }
        for (n, name) in ["bob", "carol", "dave", "root"].iter().enumerate() {
            sqlx::query("UPDATE blocks SET created_at = $1 WHERE blocked = $2")
                .bind(n as i64 + 1)
                .bind(*name)
                .execute(db)
                .await
                .expect("stamp");
        }
        assert_eq!(
            listed(&state, None, None, None).await,
            (
                vec![
                    "root".to_string(),
                    "dave".to_string(),
                    "carol".to_string(),
                    "bob".to_string()
                ],
                None
            )
        );
        let (first, next) = listed(&state, None, Some(3), None).await;
        assert_eq!(first, ["root", "dave", "carol"]);
        let (rest, end) = listed(&state, None, Some(3), next).await;
        assert_eq!((rest, end), (vec!["bob".to_string()], None));
        assert_eq!(listed(&state, Some("CA"), None, None).await.0, ["carol"]);
        assert_eq!(listed(&state, Some("z"), None, None).await.0, ["dave"]);
        assert!(listed(&state, Some("a"), None, None).await.0.is_empty());
        assert!(listed(&state, Some("%"), None, None).await.0.is_empty());
        assert_eq!(names(&state).await, ["root", "dave", "carol", "bob"]);
        assert!(
            blocked_usernames(State(state.clone()), Authed(mem_user("bob", false)))
                .await
                .expect("bob")
                .0
                .is_empty()
        );
        while rx.try_recv().is_ok() {}
        unblock(&state, "alice", "BOB").await;
        unblock(&state, "alice", "bob").await;
        unblock(&state, "alice", "erin").await;
        assert_eq!(drain(&mut rx), ["unblocked alice bob"]);
        assert_eq!(names(&state).await, ["root", "dave", "carol"]);

        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 997) INSERT INTO blocks(blocker, blocked, created_at) SELECT 'alice', 'x' || i, 0 FROM n")
            .execute(db)
            .await
            .expect("fill");
        assert_eq!(
            code(block(&state, "alice", "erin").await),
            Some((
                StatusCode::BAD_REQUEST,
                "You can block at most 1000 users".to_string()
            ))
        );
        block(&state, "alice", "dave")
            .await
            .expect("already blocked still answers");
        assert_eq!(names(&state).await.len(), 1000);
        done(state, path).await;
    }

    #[tokio::test]
    async fn blocked_users_cannot_dm_call_or_ping() {
        let (state, path) = temp_state("blocks_effects").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dave"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("id");
        let open = |by: &str, name: &str| {
            open_dm(
                State(state.clone()),
                Authed(mem_user(by, false)),
                Json(serde_json::from_value(json!({ "username": name })).expect("req")),
            )
        };
        let dm_send = |by: &str, id: i64, body: serde_json::Value| {
            send_dm_message(
                State(state.clone()),
                Path(id),
                Authed(mem_user(by, false)),
                Json(serde_json::from_value(body).expect("req")),
            )
        };
        let say = |by: &str, body: serde_json::Value| {
            send_channel_message(
                State(state.clone()),
                Path(cid),
                Authed(mem_user(by, false)),
                Json(serde_json::from_value(body).expect("req")),
            )
        };
        let listed = |who: &str| {
            let state = state.clone();
            let who = who.to_string();
            async move {
                dm_page(&state.db, &who, 0, None, 50)
                    .await
                    .expect("page")
                    .items
                    .iter()
                    .map(|d| d.id)
                    .collect::<Vec<i64>>()
            }
        };
        let unseen = |who: &str, actor: &str| {
            let db = state.db.clone();
            let (who, actor) = (who.to_string(), actor.to_string());
            async move {
                sqlx::query(
                    "SELECT COUNT(*) FROM pings WHERE username = $1 AND actor = $2 AND seen = 0",
                )
                .bind(who)
                .bind(actor)
                .fetch_one(&db)
                .await
                .expect("count")
                .try_get::<i64, _>(0)
                .expect("n")
            }
        };

        let dm = open("alice", "bob").await.expect("dm").0;
        let _ = dm_send("bob", dm.id, json!({ "content": "hey @alice" }))
            .await
            .expect("before the block");
        let _ = say("bob", json!({ "content": "@alice look" }))
            .await
            .expect("channel");
        assert_eq!(unseen("alice", "bob").await, 2);
        let mut rx = state.hub.subscribe();
        block(&state, "alice", "bob").await.expect("block");
        let mut got = drain(&mut rx);
        got.sort();
        let mut want = vec![
            "blocked alice bob".to_string(),
            format!("closed alice {}", dm.id),
            format!("count alice c{cid} 0"),
            format!("count alice d{} 0", dm.id),
        ];
        want.sort();
        assert_eq!(got, want);
        assert_eq!(unseen("alice", "bob").await, 0);
        assert!(!listed("alice").await.contains(&dm.id));
        assert!(listed("bob").await.contains(&dm.id));

        let refused = code(dm_send("bob", dm.id, json!({ "content": "hello?" })).await);
        assert_eq!(
            refused,
            Some((StatusCode::FORBIDDEN, NOT_ACCEPTING.to_string()))
        );
        assert_eq!(
            code(dm_send("alice", dm.id, json!({ "content": "bye" })).await),
            Some((StatusCode::FORBIDDEN, YOU_BLOCKED.to_string()))
        );
        assert!(open("bob", "alice").await.is_ok(), "an existing DM opens");
        assert!(!listed("alice").await.contains(&dm.id));
        let me = open("alice", "alice").await.expect("self").0;
        let _ = dm_send("alice", me.id, json!({ "content": "note" }))
            .await
            .expect("self DM still works");

        block(&state, "alice", "dave").await.expect("block dave");
        assert_eq!(
            code(open("dave", "alice").await),
            Some((StatusCode::FORBIDDEN, NOT_ACCEPTING.to_string()))
        );
        let none: i64 =
            sqlx::query("SELECT COUNT(*) FROM dms WHERE user_a = 'alice' AND user_b = 'dave'")
                .fetch_one(db)
                .await
                .expect("count")
                .try_get(0)
                .expect("n");
        assert_eq!(none, 0);
        assert!(
            crate::api::blocks::check_dm(db, "dave", "alice")
                .await
                .is_err()
        );
        assert!(
            crate::api::blocks::check_dm(db, "carol", "alice")
                .await
                .is_ok()
        );

        let mine = say("alice", json!({ "content": "mine" }))
            .await
            .expect("alice")
            .0;
        while rx.try_recv().is_ok() {}
        let _ = say(
            "bob",
            json!({ "content": "hi @alice", "reply_to": mine.id }),
        )
        .await
        .expect("bob still talks in channels");
        let _ = add_reaction(
            State(state.clone()),
            Path((mine.id, "👍".to_string())),
            Authed(mem_user("bob", false)),
        )
        .await
        .expect("bob reacts");
        let _ = say("carol", json!({ "content": "@alice @bob" }))
            .await
            .expect("carol");
        assert_eq!(
            drain(&mut rx),
            [
                "reaction bob 1",
                "ping alice mention carol",
                "ping bob mention carol"
            ]
        );
        assert_eq!(unseen("alice", "bob").await, 0);

        let old = sqlx::query("SELECT id FROM messages WHERE dm_id = $1 ORDER BY id LIMIT 1")
            .bind(dm.id)
            .fetch_one(db)
            .await
            .expect("old")
            .try_get::<i64, _>(0)
            .expect("id");
        let _ = pin_message(
            State(state.clone()),
            Path(old),
            Authed(mem_user("carol", false)),
        )
        .await
        .err()
        .expect("outsiders still get 404");
        let _ = close_dm(
            State(state.clone()),
            Path(dm.id),
            Authed(mem_user("bob", false)),
        )
        .await
        .expect("bob closes");
        while rx.try_recv().is_ok() {}
        let as_user = |who: &str| Authed(mem_user(who, false));
        let refusal = |who: &str| match who {
            "bob" => Some((StatusCode::FORBIDDEN, NOT_ACCEPTING.to_string())),
            _ => Some((StatusCode::FORBIDDEN, YOU_BLOCKED.to_string())),
        };
        let edited = edit_message(
            State(state.clone()),
            Path(old),
            as_user("bob"),
            Json(serde_json::from_value(json!({ "content": "new words" })).expect("req")),
        )
        .await;
        assert_eq!(code(edited), refusal("bob"));
        for who in ["bob", "alice"] {
            let reacted = add_reaction(
                State(state.clone()),
                Path((old, "👍".to_string())),
                as_user(who),
            )
            .await;
            assert_eq!(code(reacted), refusal(who), "{who} reacts");
            let pinned = pin_message(State(state.clone()), Path(old), as_user(who)).await;
            assert_eq!(code(pinned), refusal(who), "{who} pins");
            let unpinned = unpin_message(State(state.clone()), Path(old), as_user(who)).await;
            assert_eq!(code(unpinned), refusal(who), "{who} unpins");
        }
        assert!(
            drain(&mut rx).is_empty(),
            "no update, reaction, pin or reopen"
        );
        let text: String = sqlx::query("SELECT content FROM messages WHERE id = $1")
            .bind(old)
            .fetch_one(db)
            .await
            .expect("row")
            .try_get(0)
            .expect("text");
        assert_eq!(text, "hey @alice");
        let notices: i64 =
            sqlx::query("SELECT COUNT(*) FROM messages WHERE dm_id = $1 AND kind = 'pin'")
                .bind(dm.id)
                .fetch_one(db)
                .await
                .expect("count")
                .try_get(0)
                .expect("n");
        assert_eq!(notices, 0);
        let typing = |who: &str| {
            let db = state.db.clone();
            let (who, scope) = (who.to_string(), format!("d{}", dm.id));
            async move { crate::api::access::ws_typing_place(&db, &who, &scope).await }
        };
        assert!(typing("bob").await.is_none(), "bob's typing never goes out");
        assert!(typing("alice").await.is_none());
        assert!(!listed("alice").await.contains(&dm.id));

        unblock(&state, "alice", "bob").await;
        while rx.try_recv().is_ok() {}
        let _ = dm_send("bob", dm.id, json!({ "content": "@alice back" }))
            .await
            .expect("after unblock");
        assert_eq!(
            drain(&mut rx),
            [
                format!("reopened alice {}", dm.id),
                format!("reopened bob {}", dm.id),
                format!("message d{}", dm.id),
                "ping alice mention bob".to_string()
            ]
        );
        assert!(listed("alice").await.contains(&dm.id));
        assert!(typing("bob").await.is_some());
        let _ = pin_message(State(state.clone()), Path(old), as_user("bob"))
            .await
            .expect("pins work again");
        let _ = edit_message(
            State(state.clone()),
            Path(old),
            as_user("bob"),
            Json(serde_json::from_value(json!({ "content": "edited" })).expect("req")),
        )
        .await
        .expect("edits work again");
        done(state, path).await;
    }

    #[tokio::test]
    async fn concurrent_blocks_respect_the_cap_and_stored_times() {
        let (state, path) = temp_state("blocks_race").await;
        let db = &state.db;
        add_user(db, "alice", "Alice").await;
        let others: Vec<String> = (0..8).map(|i| format!("u{i}")).collect();
        for name in &others {
            add_user(db, name, name).await;
        }
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 996) INSERT INTO blocks(blocker, blocked, created_at) SELECT 'alice', 'x' || i, 0 FROM n")
            .execute(db)
            .await
            .expect("fill");
        let results =
            futures_util::future::join_all(others.iter().map(|name| block(&state, "alice", name)))
                .await;
        let added = results.iter().filter(|r| r.is_ok()).count();
        let total: i64 = sqlx::query("SELECT COUNT(*) FROM blocks WHERE blocker = 'alice'")
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("n");
        assert_eq!((added, total), (4, BLOCKS_MAX));
        sqlx::query("UPDATE blocks SET created_at = 7 WHERE blocker = 'alice'")
            .execute(db)
            .await
            .expect("stamp");
        let blocked = others
            .iter()
            .zip(&results)
            .find(|(_, r)| r.is_ok())
            .map(|(name, _)| name.clone())
            .expect("one blocked");
        let again =
            futures_util::future::join_all((0..3).map(|_| block(&state, "alice", &blocked))).await;
        for res in again {
            assert_eq!(res.expect("already blocked").blocked_at, 7);
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn group_mentions_skip_authors_the_reader_blocked() {
        let (state, path) = temp_state("blocks_groups").await;
        let db = &state.db;
        for name in ["boss", "bob", "carol"] {
            add_user(db, name, name).await;
        }
        add_member(db, "rchat", "boss", 1, 0, 1).await;
        add_member(db, "rchat", "bob", 0, 0, 1).await;
        add_member(db, "rchat", "carol", 0, 0, 1).await;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("id");
        for name in ["bob", "carol"] {
            let conn = state.hub.next_conn();
            state.hub.set_online(name, conn, &["rchat"]);
        }
        let _ = block(&state, "bob", "boss").await.expect("block");
        for content in ["@everyone", "@here"] {
            let _ = send_channel_message(
                State(state.clone()),
                Path(cid),
                Authed(mem_user("boss", false)),
                Json(serde_json::from_value(json!({ "content": content })).expect("req")),
            )
            .await
            .expect("send");
        }
        let unseen = |who: &str| {
            let db = state.db.clone();
            let who = who.to_string();
            async move {
                crate::api::pings::group_unseen(&db, &who, &[])
                    .await
                    .expect("unseen")
                    .values()
                    .map(Vec::len)
                    .sum::<usize>()
            }
        };
        assert_eq!(unseen("carol").await, 2);
        assert_eq!(unseen("bob").await, 0, "the blocker gets no group pings");
        assert_eq!(unseen("boss").await, 0);
        unblock(&state, "bob", "boss").await;
        assert_eq!(unseen("bob").await, 2, "counted again after unblocking");
        done(state, path).await;
    }
}
