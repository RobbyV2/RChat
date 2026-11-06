use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::{Proof, ResolvedMessage, resolve_message};
use crate::api::messages::{Quotes, load_message};
use crate::api::pings::{PingKind, PingScope, PingSpec, RETRACTED, announce_counts, create_pings};
use crate::api::{
    ApiError, ApiErrorBody, Authed, MaybeAuthed, Message, OkResp, UserRef, bad, now_ms, ok,
    placeholders, require_guest_ok, user_from, user_refs,
};
use crate::db::{Db, User};
use crate::state::AppState;
use crate::ws::WsEvent;

/// Longest accepted reaction in UTF-8 bytes (the longest emoji the picker offers, a kiss with
/// two skin tones, takes 35).
pub const EMOJI_MAX_BYTES: usize = 64;
/// Distinct emojis one message can carry.
pub const REACTIONS_MAX: i64 = 20;
const REACTORS_MAX: i64 = 100;

/// One emoji on a message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Reaction {
    /// The emoji, as sent by the reactors (skin tones included), for example U+1F44D (thumbs
    /// up).
    pub emoji: String,
    /// How many users reacted with it.
    pub count: i64,
    /// Whether the caller is one of them.
    pub me: bool,
    /// When the first of them reacted; reactions are listed in this order.
    pub first_at: i64,
}

/// Reactor list paging.
#[derive(Clone, Copy, Deserialize, IntoParams)]
pub struct ReactorsQuery {
    /// How many reactors to return. Default and maximum 100.
    #[param(example = 100)]
    limit: Option<i64>,
}

/// The stored form of `text` when it is exactly one emoji of the Unicode emoji list (skin
/// tones, ZWJ sequences, keycaps and flags included): its fully-qualified sequence, so U+2764 and
/// U+2764 U+FE0F (red heart) are the same reaction.
pub fn canonical_emoji(text: &str) -> Option<&'static str> {
    match text.is_empty() || text.len() > EMOJI_MAX_BYTES {
        true => None,
        false => emojis::get(text).map(|e| e.as_str()),
    }
}

fn check_emoji(emoji: &str) -> Result<&'static str, ApiError> {
    canonical_emoji(emoji).ok_or_else(|| bad("Not an emoji"))
}

/// Reaction summaries of `msgs` from `viewer`'s point of view (`me`), in one query.
pub(crate) async fn attach_reactions(
    db: &Db,
    msgs: &mut [Message],
    viewer: Option<&User>,
) -> Result<(), ApiError> {
    if msgs.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "SELECT message_id, emoji, COUNT(*), MIN(created_at) / 1000, MAX(CASE WHEN username = $1 THEN 1 ELSE 0 END) FROM reactions WHERE message_id IN ({}) GROUP BY message_id, emoji ORDER BY message_id, MIN(created_at), emoji",
        placeholders(2, msgs.len())
    );
    let mut query =
        sqlx::query(sqlx::AssertSqlSafe(sql)).bind(viewer.map_or("", |u| u.username.as_str()));
    for m in msgs.iter() {
        query = query.bind(m.id);
    }
    let mut map: HashMap<i64, Vec<Reaction>> = HashMap::new();
    for r in query.fetch_all(db).await? {
        map.entry(r.try_get(0)?).or_default().push(Reaction {
            emoji: r.try_get(1)?,
            count: r.try_get(2)?,
            first_at: r.try_get(3)?,
            me: r.try_get::<i64, _>(4)? != 0,
        });
    }
    for m in msgs.iter_mut() {
        m.reactions = map.remove(&m.id).unwrap_or_default();
    }
    Ok(())
}

struct Target {
    resolved: ResolvedMessage,
    message: Message,
}

/// The message `user` reacts to. Reading it is enough to take a reaction back; adding one also
/// needs `react_gate` (send permission, live DM).
async fn react_target(
    state: &AppState,
    id: i64,
    user: &User,
    adding: bool,
) -> Result<Target, ApiError> {
    let resolved = resolve_message(&state.db, id, Some(user), &Proof::none()).await?;
    if adding {
        resolved.react_gate(&state.db).await?;
    }
    let message = load_message(&state.db, id, Quotes::Skip)
        .await?
        .ok_or_else(crate::api::access::not_found)?;
    Ok(Target { resolved, message })
}

/// Serializes reaction writes on one message (Postgres row lock; SQLite has a single writer),
/// so the emoji cap and the counts sent with events hold under concurrent requests.
async fn lock_message(db: &Db, conn: &mut sqlx::AnyConnection, id: i64) -> sqlx::Result<()> {
    if !crate::db::is_sqlite(db) {
        sqlx::query("SELECT id FROM messages WHERE id = $1 FOR NO KEY UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    }
    Ok(())
}

async fn emoji_count(
    conn: &mut sqlx::AnyConnection,
    message_id: i64,
    emoji: &str,
) -> sqlx::Result<i64> {
    sqlx::query("SELECT COUNT(*) FROM reactions WHERE message_id = $1 AND emoji = $2")
        .bind(message_id)
        .bind(emoji)
        .fetch_one(&mut *conn)
        .await?
        .try_get(0)
}

fn reaction_event(
    target: &Target,
    emoji: &str,
    username: &str,
    count: i64,
    added: bool,
) -> WsEvent {
    let scope = target.resolved.scope();
    let (server, channel_id, dm_id, dm_users, message_id, thread_root_id, emoji, username) = (
        scope.server.clone(),
        scope.channel_id,
        scope.dm_id,
        scope.dm_users.clone(),
        target.message.id,
        scope.thread_root_id,
        emoji.to_string(),
        username.to_string(),
    );
    match added {
        true => WsEvent::ReactionAdded {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            thread_root_id,
            emoji,
            username,
            count,
        },
        false => WsEvent::ReactionRemoved {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            thread_root_id,
            emoji,
            username,
            count,
        },
    }
}

async fn ping_author(state: &AppState, target: &Target, actor: &User, emoji: &str) {
    let Target { resolved, message } = target;
    let author = &message.author.username;
    if *author == actor.username {
        return;
    }
    let scope = match (
        resolved.channel(),
        &resolved.scope().dm_users,
        message.dm_id,
    ) {
        (Some(channel), _, _) => PingScope::Channel(channel),
        (None, Some(users), Some(id)) => PingScope::Dm { id, users },
        (None, _, _) => return,
    };
    let run = async {
        let known = sqlx::query(
            "SELECT 1 FROM pings WHERE kind = 'reaction' AND message_id = $1 AND actor = $2 AND emoji = $3 AND username = $4",
        )
        .bind(message.id)
        .bind(&actor.username)
        .bind(emoji)
        .bind(author)
        .fetch_optional(&state.db)
        .await?;
        if known.is_some() {
            return Ok(());
        }
        let recipients = scope
            .recipients(&state.db, std::slice::from_ref(author), message)
            .await?;
        if recipients.is_empty() {
            return Ok(());
        }
        let spec = PingSpec {
            kind: PingKind::Reaction,
            scope: scope.key(),
            server: scope.server(),
            message,
            actor,
            emoji: Some(emoji.to_string()),
        };
        create_pings(state, &spec, &recipients).await.map(|_| ())
    };
    let res: Result<(), ApiError> = run.await;
    if let Err(ApiError(_, e)) = res {
        tracing::warn!("reaction ping for message {} failed: {e}", message.id);
    }
}

/// Retracts the author's unseen ping for a removed reaction: it stops counting, and the kept
/// row stops the same reaction from pinging again when it is re-added.
async fn unping_author(state: &AppState, message_id: i64, actor: &str, emoji: &str) {
    let res = sqlx::query(
        "UPDATE pings SET seen = $4 WHERE kind = 'reaction' AND message_id = $1 AND actor = $2 AND emoji = $3 AND seen = 0 RETURNING username, scope",
    )
    .bind(message_id)
    .bind(actor)
    .bind(emoji)
    .bind(RETRACTED)
    .fetch_all(&state.db)
    .await;
    match res {
        Ok(rows) => {
            let pairs = rows
                .iter()
                .filter_map(|r| Some((r.try_get(0).ok()?, r.try_get(1).ok()?)))
                .collect();
            announce_counts(state, pairs).await;
        }
        Err(e) => {
            tracing::warn!("retracting the reaction ping on message {message_id} failed: {e}")
        }
    }
}

/// Add a reaction
///
/// Reacts to a message with one emoji (percent-encoded in the path). All emoji of the Unicode
/// emoji list are accepted (skin tones, ZWJ sequences, keycaps, flags). The server stores the
/// fully qualified form, so U+2764 and U+2764 U+FE0F (red heart) are one reaction. Requires a bearer token.
/// Guests cannot react. Needs read access to the message. In server channels, also needs membership and the
/// send permission. In DMs, needs to be a participant. Only normal messages take reactions (not
/// call logs). A message has at most 20 different emojis. A repeated reaction changes nothing. A
/// new reaction emits `reaction_added` (`{server, channel_id, dm_id, dm_users, message_id,
/// thread_root_id, emoji, username, count}`, `count` = reactors of that emoji after the change)
/// to clients that can see the message. If the message is from someone else and the author can
/// still see it, the author gets one `ping` (kind `reaction`) per reactor and emoji. Removing and
/// adding the reaction again does not ping again. General rate-limit bucket.
#[utoipa::path(put, path = "/api/messages/{id}/reactions/{emoji}", tag = "Messages", params(("id" = i64, Path, description = "Message id"), ("emoji" = String, Path, description = "The emoji, percent-encoded: one emoji of the Unicode emoji list with optional skin tone, a ZWJ sequence, a keycap or a flag, at most 64 bytes")), responses((status = 200, description = "Reacted (or already reacted); body `{\"ok\": true}`", body = OkResp), (status = 400, description = "`Not an emoji`, `Cannot react to this message` (a call log), or `Too many reactions` (the message already has 20 other emojis). A non-numeric id gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Not a member of the channel's server, or no permission to send in the channel, or a block between the DM participants (`This user is not accepting messages from you.` for the blocked side, `You blocked this user. Unblock them to send messages.` for the blocker)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket (plain text), or `Too many attempts. Try again later` (JSON) after more than 30 reactions, pins and edits in 10 seconds", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn add_reaction(
    State(state): State<AppState>,
    Path((id, emoji)): Path<(i64, String)>,
    Authed(user): Authed,
) -> Result<Json<OkResp>, ApiError> {
    let emoji = check_emoji(&emoji)?;
    let target = react_target(&state, id, &user, true).await?;
    if !matches!(target.message.kind.as_str(), "user" | "poll") {
        return Err(bad("Cannot react to this message"));
    }
    let mut tx = state.db.begin().await?;
    lock_message(&state.db, &mut tx, id).await?;
    let added = sqlx::query(
        "INSERT INTO reactions(message_id, username, emoji, created_at) SELECT $1, $2, $3, $4 WHERE (SELECT COUNT(DISTINCT r.emoji) FROM reactions r WHERE r.message_id = $1) < $5 OR EXISTS(SELECT 1 FROM reactions r WHERE r.message_id = $1 AND r.emoji = $3) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(&user.username)
    .bind(emoji)
    .bind(now_ms())
    .bind(REACTIONS_MAX)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    let count = emoji_count(&mut tx, id, emoji).await?;
    tx.commit().await?;
    if !added {
        return match reaction_exists(&state.db, id, &user.username, emoji).await? {
            true => Ok(ok()),
            false => Err(bad("Too many reactions")),
        };
    }
    state
        .hub
        .broadcast(reaction_event(&target, emoji, &user.username, count, true));
    ping_author(&state, &target, &user, emoji).await;
    Ok(ok())
}

/// Remove a reaction
///
/// Removes the caller's reaction with one emoji (percent-encoded in the path, matched like
/// adding one, so U+2764 removes U+2764 U+FE0F). Requires a bearer token and read access to the
/// message; unlike adding, no send permission is needed, so reactions can be taken back in read-only
/// channels. Removing a reaction that does not exist changes nothing. A removed reaction emits
/// `reaction_removed` (same fields as `reaction_added`) and retracts the author's unseen ping
/// for it; the author then gets `ping_count` with the scope's new unseen count. General
/// rate-limit bucket.
#[utoipa::path(delete, path = "/api/messages/{id}/reactions/{emoji}", tag = "Messages", params(("id" = i64, Path, description = "Message id"), ("emoji" = String, Path, description = "The emoji, percent-encoded")), responses((status = 200, description = "Removed (or there was nothing to remove); body `{\"ok\": true}`", body = OkResp), (status = 400, description = "`Not an emoji`. A non-numeric id gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn remove_reaction(
    State(state): State<AppState>,
    Path((id, emoji)): Path<(i64, String)>,
    Authed(user): Authed,
) -> Result<Json<OkResp>, ApiError> {
    let emoji = check_emoji(&emoji)?;
    let target = react_target(&state, id, &user, false).await?;
    let mut tx = state.db.begin().await?;
    lock_message(&state.db, &mut tx, id).await?;
    let removed =
        sqlx::query("DELETE FROM reactions WHERE message_id = $1 AND username = $2 AND emoji = $3")
            .bind(id)
            .bind(&user.username)
            .bind(emoji)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            > 0;
    let count = emoji_count(&mut tx, id, emoji).await?;
    tx.commit().await?;
    if removed {
        state
            .hub
            .broadcast(reaction_event(&target, emoji, &user.username, count, false));
        unping_author(&state, id, &user.username, emoji).await;
    }
    Ok(ok())
}

/// List reactors
///
/// Returns who reacted to a message with one emoji (percent-encoded in the path, matched like
/// adding one), in the order they reacted. Access is checked like reading the message (guests
/// allowed when guest access is on, password-protected servers, bans, channel view and
/// read-history permissions, DM participants). General rate-limit bucket.
#[utoipa::path(get, path = "/api/messages/{id}/reactions/{emoji}", tag = "Messages", params(("id" = i64, Path, description = "Message id"), ("emoji" = String, Path, description = "The emoji, percent-encoded"), ReactorsQuery), responses((status = 200, description = "Up to `limit` (default and maximum 100) users who reacted with the emoji, earliest first", body = Vec<UserRef>), (status = 400, description = "`Not an emoji`. A non-numeric id or limit gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
pub(crate) async fn list_reactors(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path((id, emoji)): Path<(i64, String)>,
    Query(q): Query<ReactorsQuery>,
) -> Result<Json<Vec<UserRef>>, ApiError> {
    let emoji = check_emoji(&emoji)?;
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    resolve_message(
        db,
        id,
        user.as_ref(),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    let ReactorsQuery { limit } = q;
    let rows = sqlx::query(
        "SELECT r.username FROM reactions r WHERE r.message_id = $1 AND r.emoji = $2 AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username = r.username AND pu.password_hash = '!purging') ORDER BY r.created_at, r.username LIMIT $3",
    )
    .bind(id)
    .bind(emoji)
    .bind(limit.unwrap_or(REACTORS_MAX).clamp(1, REACTORS_MAX))
    .fetch_all(db)
    .await?;
    let names = rows
        .iter()
        .map(|r| r.try_get::<String, _>(0))
        .collect::<Result<Vec<_>, _>>()?;
    let refs = user_refs(db, &names).await;
    Ok(Json(names.iter().map(|n| user_from(&refs, n)).collect()))
}

/// Whether `username`'s reaction with `emoji` on `message_id` is stored.
pub(crate) async fn reaction_exists(
    db: &Db,
    message_id: i64,
    username: &str,
    emoji: &str,
) -> sqlx::Result<bool> {
    Ok(sqlx::query(
        "SELECT 1 FROM reactions WHERE message_id = $1 AND username = $2 AND emoji = $3",
    )
    .bind(message_id)
    .bind(username)
    .bind(emoji)
    .fetch_optional(db)
    .await?
    .is_some())
}

/// Whether `username`'s reaction with `emoji` on `message_id` is stored, and how many users
/// reacted with that emoji (replays of `reaction_added`/`reaction_removed` are dropped when
/// the first no longer matches and carry the current count).
pub(crate) async fn reaction_state(
    db: &Db,
    message_id: i64,
    username: &str,
    emoji: &str,
) -> sqlx::Result<(bool, i64)> {
    let row = sqlx::query(
        "SELECT COUNT(*), COALESCE(MAX(CASE WHEN username = $3 THEN 1 ELSE 0 END), 0) FROM reactions WHERE message_id = $1 AND emoji = $2",
    )
    .bind(message_id)
    .bind(emoji)
    .bind(username)
    .fetch_one(db)
    .await?;
    Ok((row.try_get::<i64, _>(1)? != 0, row.try_get(0)?))
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};

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

    async fn add_user(db: &Db, name: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $2, '', 'text', 'identicon', 1)")
            .bind(name)
            .bind(name.to_uppercase())
            .execute(db)
            .await
            .expect("user");
    }

    async fn post(
        db: &Db,
        cid: Option<i64>,
        dm: Option<i64>,
        root: Option<i64>,
        author: &str,
    ) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, dm_id, thread_root_id, author, content, created_at) VALUES($1, $2, $3, $4, 'hello', 5) RETURNING id")
            .bind(cid)
            .bind(dm)
            .bind(root)
            .bind(author)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id")
    }

    async fn react(state: &AppState, who: &str, id: i64, emoji: &str) -> Result<(), ApiError> {
        add_reaction(
            State(state.clone()),
            Path((id, emoji.to_string())),
            Authed(mem_user(who, false)),
        )
        .await
        .map(|_| ())
    }

    async fn unreact(state: &AppState, who: &str, id: i64, emoji: &str) -> Result<(), ApiError> {
        remove_reaction(
            State(state.clone()),
            Path((id, emoji.to_string())),
            Authed(mem_user(who, false)),
        )
        .await
        .map(|_| ())
    }

    async fn summary(state: &AppState, who: Option<&str>, id: i64) -> Vec<(String, i64, bool)> {
        let mut msgs = vec![
            load_message(&state.db, id, Quotes::Skip)
                .await
                .expect("load")
                .expect("message"),
        ];
        let viewer = who.map(|w| mem_user(w, false));
        attach_reactions(&state.db, &mut msgs, viewer.as_ref())
            .await
            .expect("attach");
        msgs[0]
            .reactions
            .iter()
            .map(|r| (r.emoji.clone(), r.count, r.me))
            .collect()
    }

    async fn reactors(
        state: &AppState,
        who: Option<&str>,
        id: i64,
        emoji: &str,
    ) -> Result<Vec<String>, ApiError> {
        list_reactors(
            State(state.clone()),
            MaybeAuthed(who.map(|w| mem_user(w, false))),
            HeaderMap::new(),
            Path((id, emoji.to_string())),
            Query(ReactorsQuery { limit: None }),
        )
        .await
        .map(|Json(list)| list.into_iter().map(|u| u.username).collect())
    }

    fn status(res: Result<(), ApiError>) -> Option<StatusCode> {
        res.err().map(|ApiError(code, _)| code)
    }

    fn events(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::ReactionAdded {
                    message_id,
                    emoji,
                    username,
                    count,
                    ..
                } => Some(format!("+{message_id} {emoji} {username} ={count}")),
                WsEvent::ReactionRemoved {
                    message_id,
                    emoji,
                    username,
                    count,
                    ..
                } => Some(format!("-{message_id} {emoji} {username} ={count}")),
                WsEvent::Ping { username, ping } => Some(format!(
                    "ping {username} {:?} {} {}",
                    ping.kind,
                    ping.message_id,
                    ping.emoji.unwrap_or_default()
                )),
                WsEvent::PingCount {
                    username, pings, ..
                } => Some(format!("count {username} {pings}")),
                _ => None,
            })
            .collect()
    }

    async fn reaction_pings(db: &Db, who: &str) -> Vec<(i64, String, String, i64)> {
        sqlx::query("SELECT message_id, actor, emoji, seen FROM pings WHERE username = $1 AND kind = 'reaction' ORDER BY id")
            .bind(who)
            .fetch_all(db)
            .await
            .expect("pings")
            .iter()
            .map(|r| {
                (
                    r.try_get(0).expect("message"),
                    r.try_get(1).expect("actor"),
                    r.try_get(2).expect("emoji"),
                    r.try_get(3).expect("seen"),
                )
            })
            .collect()
    }

    async fn general(db: &Db) -> i64 {
        id_of(db, "SELECT id FROM channels WHERE server = 'rchat'").await
    }

    async fn world(tag: &str) -> (AppState, std::path::PathBuf, i64) {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for name in ["alice", "bob", "carol"] {
            add_user(db, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        add_user(db, "nina").await;
        let cid = general(db).await;
        (state, path, cid)
    }

    #[test]
    fn emoji_validation_accepts_known_emoji_only() {
        for ok in [
            "👍",
            "👍🏽",
            "❤️",
            "😶‍🌫️",
            "🏳️‍🌈",
            "🏳️‍⚧️",
            "👨‍👩‍👧‍👦",
            "🧑🏻‍❤️‍💋‍🧑🏼",
            "👩🏾‍🚀",
            "🫱🏻‍🫲🏿",
            "🇫🇷",
            "🇺🇸",
            "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
            "1️⃣",
            "#️⃣",
            "*️⃣",
            "©️",
            "®️",
            "™️",
            "‼️",
            "〰️",
            "〽️",
            "㊗️",
            "🅰️",
            "Ⓜ️",
            "ℹ️",
            "↔️",
            "🙂‍↔️",
            "❤️‍🔥",
            "👁️‍🗨️",
            "🕵🏻‍♂️",
            "🀄",
            "🃏",
            "🫩",
        ] {
            assert_eq!(canonical_emoji(ok), Some(ok), "{ok} is an emoji");
        }
        for (loose, full) in [
            ("❤", "❤️"),
            ("1⃣", "1️⃣"),
            ("☺", "☺️"),
            ("🏳‍🌈", "🏳️‍🌈"),
            ("©", "©️"),
        ] {
            assert_eq!(
                canonical_emoji(loose),
                Some(full),
                "{loose:?} is stored as {full}"
            );
        }
        for bad in [
            "",
            "a",
            "1",
            "11",
            ":)",
            " 👍",
            "👍 ",
            "👍👍",
            "👍a",
            "a👍",
            "é",
            "中",
            "あ",
            "\u{200D}",
            "👍\u{200D}",
            "\u{200D}👍",
            "👍\u{200D}\u{200D}👍",
            "🇫",
            "🇫🇷🇫🇷",
            "🇦🇦",
            "1️⃣1",
            "\u{20E3}",
            "\u{FE0F}",
            "🏴\u{E0067}",
            "🏴\u{E007F}",
            "👍\u{E0067}\u{E007F}",
            "👍\u{2060}",
            "\u{2028}",
            "\u{3000}",
            "\u{2800}",
            "★",
            "♤",
            "⌘",
            "→",
            "🏽",
            "🏽🏽",
            "👍🏽🏽",
            "👍🏽🏽🏽",
            "😀\u{200D}😀",
            "👨‍👩‍👧‍👦‍👦",
            "🧑\u{200D}🧑\u{200D}🧑\u{200D}🧑\u{200D}🧑",
            "<b>",
            "%F0",
        ] {
            assert_eq!(canonical_emoji(bad), None, "{bad:?} is not an emoji");
        }
        assert_eq!(canonical_emoji(&"👍".repeat(17)), None);
    }

    #[test]
    fn every_emoji_the_picker_offers_is_accepted_as_is() {
        let file = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../node_modules/emojibase-data/en/data.json"
        );
        let Ok(raw) = std::fs::read_to_string(file) else {
            assert!(
                std::env::var_os("CI").is_none(),
                "{file} is missing: run bun install first"
            );
            eprintln!("skipped: {file} is missing (run bun install)");
            return;
        };
        let data: Vec<serde_json::Value> = serde_json::from_str(&raw).expect("dataset");
        let mut checked = 0;
        for e in data
            .iter()
            .filter(|e| e["group"].as_i64().is_some_and(|g| g != 2))
        {
            let skins = e["skins"].as_array().cloned().unwrap_or_default();
            for emoji in std::iter::once(&e["emoji"]).chain(skins.iter().map(|s| &s["emoji"])) {
                let emoji = emoji.as_str().expect("emoji");
                assert_eq!(
                    canonical_emoji(emoji),
                    Some(emoji),
                    "{emoji} ({}) is accepted unchanged",
                    e["label"]
                );
                checked += 1;
            }
        }
        assert!(checked > 3500, "checked {checked}");
    }

    #[tokio::test]
    async fn reactions_toggle_idempotently_in_chronological_order() {
        let (state, path, cid) = world("reaction_toggle").await;
        let db = &state.db;
        let id = post(db, Some(cid), None, None, "alice").await;
        let mut rx = state.hub.subscribe();
        react(&state, "bob", id, "😭").await.expect("bob cries");
        let mut fresh = vec![
            load_message(db, id, Quotes::Skip)
                .await
                .expect("load")
                .expect("message"),
        ];
        attach_reactions(db, &mut fresh, None)
            .await
            .expect("attach");
        assert!(
            (fresh[0].reactions[0].first_at - crate::db::now()).abs() <= 2,
            "first_at is in seconds"
        );
        react(&state, "bob", id, "😭").await.expect("again");
        react(&state, "carol", id, "✅")
            .await
            .expect("carol checks");
        react(&state, "carol", id, "😭").await.expect("carol cries");
        react(&state, "alice", id, "💀")
            .await
            .expect("alice on her own");
        assert_eq!(
            events(&mut rx),
            vec![
                format!("+{id} 😭 bob =1"),
                format!("ping alice Reaction {id} 😭"),
                format!("+{id} ✅ carol =1"),
                format!("ping alice Reaction {id} ✅"),
                format!("+{id} 😭 carol =2"),
                format!("ping alice Reaction {id} 😭"),
                format!("+{id} 💀 alice =1"),
            ]
        );
        exec(
            db,
            "UPDATE reactions SET created_at = 30 WHERE emoji = '😭' AND username = 'bob'",
        )
        .await;
        exec(
            db,
            "UPDATE reactions SET created_at = 10 WHERE emoji = '😭' AND username = 'carol'",
        )
        .await;
        exec(
            db,
            "UPDATE reactions SET created_at = 20 WHERE emoji = '✅'",
        )
        .await;
        exec(
            db,
            "UPDATE reactions SET created_at = 40 WHERE emoji = '💀'",
        )
        .await;
        let s = |e: &str, n, me| (e.to_string(), n, me);
        assert_eq!(
            summary(&state, Some("bob"), id).await,
            vec![s("😭", 2, true), s("✅", 1, false), s("💀", 1, false)]
        );
        assert_eq!(
            summary(&state, Some("carol"), id).await,
            vec![s("😭", 2, true), s("✅", 1, true), s("💀", 1, false)]
        );
        assert_eq!(
            summary(&state, None, id).await,
            vec![s("😭", 2, false), s("✅", 1, false), s("💀", 1, false)]
        );
        assert_eq!(
            reactors(&state, Some("alice"), id, "😭")
                .await
                .expect("list"),
            vec!["carol", "bob"]
        );
        assert_eq!(
            reactors(&state, None, id, "😭")
                .await
                .expect("guests may look"),
            vec!["carol", "bob"]
        );
        assert!(
            reactors(&state, Some("alice"), id, "🙃")
                .await
                .expect("none")
                .is_empty()
        );

        unreact(&state, "carol", id, "😭")
            .await
            .expect("carol stops crying");
        unreact(&state, "carol", id, "😭").await.expect("twice");
        unreact(&state, "nina", id, "😭")
            .await
            .expect("nina can read the public server but has nothing to remove");
        assert_eq!(
            events(&mut rx),
            vec![format!("-{id} 😭 carol =1"), "count alice 2".to_string()]
        );
        assert_eq!(
            summary(&state, Some("carol"), id).await,
            vec![s("✅", 1, true), s("😭", 1, false), s("💀", 1, false)],
            "an emoji is placed by its earliest remaining reaction"
        );
        unreact(&state, "bob", id, "😭").await.expect("bob too");
        assert_eq!(
            summary(&state, Some("bob"), id).await,
            vec![s("✅", 1, false), s("💀", 1, false)]
        );
        react(&state, "bob", id, "😭").await.expect("bob again");
        assert_eq!(
            summary(&state, Some("bob"), id).await.last(),
            Some(&s("😭", 1, true)),
            "a re-added emoji goes last"
        );
        exec(db, &format!("DELETE FROM messages WHERE id = {id}")).await;
        assert_eq!(
            id_of(db, "SELECT COUNT(*) FROM reactions").await,
            0,
            "deleted with the message"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn reactions_are_validated_and_capped() {
        let (state, path, cid) = world("reaction_limits").await;
        let db = &state.db;
        let id = post(db, Some(cid), None, None, "alice").await;
        for bad in ["a", "👍 ", "👍👍", ""] {
            assert_eq!(
                status(react(&state, "bob", id, bad).await),
                Some(StatusCode::BAD_REQUEST),
                "{bad:?}"
            );
            assert_eq!(
                status(unreact(&state, "bob", id, bad).await),
                Some(StatusCode::BAD_REQUEST)
            );
        }
        let many: Vec<String> = (0..20)
            .map(|i| char::from_u32(0x1F600 + i).expect("emoji").to_string())
            .collect();
        for (i, e) in many.iter().enumerate() {
            let who = ["bob", "carol"][i % 2];
            react(&state, who, id, e).await.expect("within the cap");
        }
        assert_eq!(
            status(react(&state, "bob", id, "🦀").await),
            Some(StatusCode::BAD_REQUEST),
            "a 21st emoji is refused"
        );
        react(&state, "alice", id, &many[3])
            .await
            .expect("an existing emoji still works");
        unreact(&state, "carol", id, &many[1])
            .await
            .expect("free a slot");
        react(&state, "bob", id, "🦀").await.expect("now it fits");
        let call = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, kind, created_at) VALUES({cid}, 'alice', '', 'call', 5) RETURNING id")).await;
        assert_eq!(
            status(react(&state, "bob", call, "👍").await),
            Some(StatusCode::BAD_REQUEST)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn reacting_needs_read_access_and_send_permission() {
        let (state, path, cid) = world("reaction_access").await;
        let db = &state.db;
        let id = post(db, Some(cid), None, None, "alice").await;
        assert_eq!(
            status(react(&state, "nina", id, "👍").await),
            Some(StatusCode::FORBIDDEN),
            "not a member of the public server"
        );
        assert_eq!(
            status(react(&state, "bob", id + 1000, "👍").await),
            Some(StatusCode::NOT_FOUND)
        );
        let hidden = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'hidden', 1) RETURNING id").await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden}, 'r:0', 0, 1, 1), ({hidden}, 'u:alice', 1, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        let secret = post(db, Some(hidden), None, None, "alice").await;
        assert_eq!(
            status(react(&state, "bob", secret, "👍").await),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            reactors(&state, Some("bob"), secret, "👍")
                .await
                .err()
                .map(|ApiError(c, _)| c),
            Some(StatusCode::NOT_FOUND)
        );
        react(&state, "alice", secret, "👍")
            .await
            .expect("alice sees it");
        let quiet = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'quiet', 1) RETURNING id").await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({quiet}, 'u:bob', 1, 0, 1), ({quiet}, 'u:carol', 1, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        let announcement = post(db, Some(quiet), None, None, "alice").await;
        assert_eq!(
            status(react(&state, "bob", announcement, "👍").await),
            Some(StatusCode::FORBIDDEN)
        );
        react(&state, "carol", announcement, "👍")
            .await
            .expect("carol may send there");
        exec(db, &format!("INSERT INTO reactions(message_id, username, emoji, created_at) VALUES({announcement}, 'bob', '🎉', 1)")).await;
        let mut rx = state.hub.subscribe();
        unreact(&state, "bob", announcement, "🎉")
            .await
            .expect("bob takes his reaction back without send permission");
        assert_eq!(events(&mut rx), vec![format!("-{announcement} 🎉 bob =0")]);
        assert_eq!(
            status(unreact(&state, "bob", secret, "👍").await),
            Some(StatusCode::NOT_FOUND),
            "removing still needs read access"
        );
        let read_only = |who: Option<&'static str>| {
            let state = state.clone();
            async move {
                crate::api::servers::get_server(
                    State(state),
                    MaybeAuthed(who.map(|w| mem_user(w, false))),
                    HeaderMap::new(),
                    Path("rchat".to_string()),
                )
                .await
                .map(|Json(d)| d.read_only)
                .map_err(|ApiError(c, _)| c)
            }
        };
        assert_eq!(read_only(Some("bob")).await, Ok(vec![quiet]));
        assert_eq!(read_only(Some("carol")).await, Ok(vec![]));
        assert_eq!(read_only(Some("nina")).await, Ok(vec![]));
        assert_eq!(read_only(None).await, Ok(vec![]));
        exec(
            db,
            "UPDATE settings SET value = '0' WHERE key = 'guests_enabled'",
        )
        .await;
        crate::api::Settings::forget(db);
        assert_eq!(
            reactors(&state, None, id, "👍")
                .await
                .err()
                .map(|ApiError(c, _)| c),
            Some(StatusCode::UNAUTHORIZED)
        );

        let dm = id_of(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let private = post(db, None, Some(dm), None, "alice").await;
        assert_eq!(
            status(react(&state, "carol", private, "👍").await),
            Some(StatusCode::NOT_FOUND)
        );
        let mut rx = state.hub.subscribe();
        react(&state, "bob", private, "👍")
            .await
            .expect("participant");
        let routed: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::ReactionAdded {
                    server,
                    dm_id,
                    dm_users,
                    ..
                } => Some((server, dm_id, dm_users)),
                _ => None,
            })
            .collect();
        assert_eq!(
            routed,
            vec![(
                None,
                Some(dm),
                Some(vec!["alice".to_string(), "bob".to_string()])
            )]
        );
        exec(
            db,
            "UPDATE users SET password_hash = '!purging' WHERE username = 'alice'",
        )
        .await;
        assert_eq!(
            status(unreact(&state, "bob", private, "👍").await),
            Some(StatusCode::NOT_FOUND)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn reactions_ping_the_author_once_while_they_can_see_it() {
        let (state, path, cid) = world("reaction_pings").await;
        let db = &state.db;
        let id = post(db, Some(cid), None, None, "alice").await;
        let mut rx = state.hub.subscribe();
        react(&state, "bob", id, "👍").await.expect("react");
        assert_eq!(
            reaction_pings(db, "alice").await,
            vec![(id, "bob".to_string(), "👍".to_string(), 0)]
        );
        unreact(&state, "bob", id, "👍").await.expect("unreact");
        assert_eq!(
            reaction_pings(db, "alice").await,
            vec![(id, "bob".to_string(), "👍".to_string(), RETRACTED)],
            "an unseen ping is retracted with the reaction"
        );
        let unseen = |db: Db| async move {
            crate::api::pings::unseen_counts(&db, "alice")
                .await
                .expect("counts")
                .get(&format!("c{cid}"))
                .map_or(0, |p| p.pings)
        };
        assert_eq!(
            unseen(db.clone()).await,
            0,
            "a retracted ping does not count"
        );
        for _ in 0..5 {
            react(&state, "bob", id, "👍").await.expect("toggle on");
            unreact(&state, "bob", id, "👍").await.expect("toggle off");
        }
        react(&state, "bob", id, "👍").await.expect("and on again");
        assert_eq!(
            events(&mut rx),
            std::iter::once(format!("+{id} 👍 bob =1"))
                .chain(std::iter::once(format!("ping alice Reaction {id} 👍")))
                .chain(std::iter::once(format!("-{id} 👍 bob =0")))
                .chain(std::iter::once("count alice 0".to_string()))
                .chain(
                    (0..5).flat_map(|_| [format!("+{id} 👍 bob =1"), format!("-{id} 👍 bob =0")])
                )
                .chain(std::iter::once(format!("+{id} 👍 bob =1")))
                .collect::<Vec<_>>(),
            "toggling a reaction pings its author once"
        );
        assert_eq!(unseen(db.clone()).await, 0);
        assert_eq!(reaction_pings(db, "alice").await.len(), 1);
        react(&state, "bob", id, "👀").await.expect("another emoji");
        exec(db, "UPDATE pings SET seen = 1 WHERE emoji = '👀'").await;
        unreact(&state, "bob", id, "👀").await.expect("unreact");
        react(&state, "bob", id, "👀").await.expect("and again");
        assert_eq!(
            reaction_pings(db, "alice").await,
            vec![
                (id, "bob".to_string(), "👍".to_string(), RETRACTED),
                (id, "bob".to_string(), "👀".to_string(), 1)
            ],
            "a seen ping stays and is not repeated"
        );
        crate::db::sweep_stale(db, &state.limits)
            .await
            .expect("sweep");
        unreact(&state, "bob", id, "👀")
            .await
            .expect("unreact after the sweep");
        react(&state, "bob", id, "👀")
            .await
            .expect("react after the sweep");
        assert_eq!(
            reaction_pings(db, "alice").await,
            vec![
                (id, "bob".to_string(), "👍".to_string(), RETRACTED),
                (id, "bob".to_string(), "👀".to_string(), 1)
            ],
            "seen and retracted reaction pings stay until they age out, so the sweep does not allow a new ping"
        );
        react(&state, "alice", id, "🎉").await.expect("own message");
        assert_eq!(
            reaction_pings(db, "alice").await.len(),
            2,
            "no ping for yourself"
        );

        let hidden = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'hidden', 1) RETURNING id").await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden}, 'u:bob', 1, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        let old = post(db, Some(hidden), None, None, "alice").await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden}, 'u:alice', 0, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        react(&state, "bob", old, "👀")
            .await
            .expect("bob still sees it");
        assert_eq!(
            reaction_pings(db, "alice").await.len(),
            2,
            "alice cannot see that channel any more"
        );

        let root = post(db, Some(cid), None, None, "carol").await;
        let reply = post(db, Some(cid), None, Some(root), "alice").await;
        react(&state, "bob", reply, "🧵")
            .await
            .expect("thread reply");
        let thread: Option<i64> =
            sqlx::query("SELECT thread_root_id FROM pings WHERE message_id = $1")
                .bind(reply)
                .fetch_one(db)
                .await
                .expect("thread ping")
                .try_get(0)
                .expect("root");
        assert_eq!(
            thread,
            Some(root),
            "a reaction to a thread reply is a thread ping"
        );

        let dm = id_of(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let private = post(db, None, Some(dm), None, "alice").await;
        react(&state, "bob", private, "💌").await.expect("dm");
        let scope: String = sqlx::query("SELECT scope FROM pings WHERE message_id = $1")
            .bind(private)
            .fetch_one(db)
            .await
            .expect("dm ping")
            .try_get(0)
            .expect("scope");
        assert_eq!(scope, format!("d{dm}"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn loose_and_fully_qualified_emoji_are_one_reaction() {
        let (state, path, cid) = world("reaction_normalize").await;
        let db = &state.db;
        let id = post(db, Some(cid), None, None, "alice").await;
        let mut rx = state.hub.subscribe();
        react(&state, "bob", id, "❤").await.expect("text heart");
        react(&state, "carol", id, "❤️").await.expect("emoji heart");
        react(&state, "bob", id, "❤️")
            .await
            .expect("same as before");
        assert_eq!(
            summary(&state, Some("bob"), id).await,
            vec![("❤️".to_string(), 2, true)]
        );
        assert_eq!(
            reactors(&state, None, id, "❤").await.expect("list"),
            vec!["bob", "carol"]
        );
        unreact(&state, "carol", id, "❤")
            .await
            .expect("either form removes");
        assert_eq!(
            events(&mut rx),
            vec![
                format!("+{id} ❤️ bob =1"),
                format!("ping alice Reaction {id} ❤️"),
                format!("+{id} ❤️ carol =2"),
                format!("ping alice Reaction {id} ❤️"),
                format!("-{id} ❤️ carol =1"),
                "count alice 1".to_string(),
            ]
        );
        assert_eq!(
            id_of(db, "SELECT COUNT(*) FROM reactions WHERE emoji = '❤'").await,
            0,
            "stored fully qualified"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn concurrent_reactions_never_pass_the_cap() {
        let (state, path, cid) = world("reaction_cap_race").await;
        let db = &state.db;
        let id = post(db, Some(cid), None, None, "alice").await;
        for i in 0..REACTIONS_MAX - 1 {
            let e = char::from_u32(0x1F600 + i as u32).expect("emoji");
            react(&state, "carol", id, &e.to_string())
                .await
                .expect("below the cap");
        }
        let fresh: Vec<String> = ["🦀", "🐙", "🦊", "🐢", "🦉", "🐝", "🦄", "🐳"]
            .iter()
            .map(|e| e.to_string())
            .collect();
        let tasks: Vec<_> = fresh
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let (state, e) = (state.clone(), e.clone());
                tokio::spawn(async move {
                    react(&state, ["bob", "carol", "alice"][i % 3], id, &e).await
                })
            })
            .collect();
        let mut codes = Vec::new();
        for t in tasks {
            codes.push(status(t.await.expect("task")));
        }
        assert_eq!(codes.iter().filter(|c| c.is_none()).count(), 1, "{codes:?}");
        assert!(
            codes
                .iter()
                .flatten()
                .all(|c| *c == StatusCode::BAD_REQUEST)
        );
        assert_eq!(
            id_of(
                db,
                &format!("SELECT COUNT(DISTINCT emoji) FROM reactions WHERE message_id = {id}")
            )
            .await,
            REACTIONS_MAX
        );
        let twice: Vec<_> = (0..6)
            .map(|i| {
                let state = state.clone();
                tokio::spawn(async move {
                    react(&state, ["bob", "nina", "carol"][i % 3], id, "😀").await
                })
            })
            .collect();
        let mut ok = 0;
        for t in twice {
            ok += usize::from(t.await.expect("task").is_ok());
        }
        assert_eq!(
            ok, 4,
            "an emoji already on a full message still takes reactions"
        );
        done(state, path).await;
    }
}
