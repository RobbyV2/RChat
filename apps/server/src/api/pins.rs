use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use sqlx::Row;

use crate::api::access::{
    MsgScope, Proof, ResolvedMessage, not_found, resolve_channel, resolve_dm, resolve_message,
};
use crate::api::audit;
use crate::api::messages::{Quotes, load_broadcast, load_message, moderated, pinned_messages};
use crate::api::{
    ApiError, ApiErrorBody, Authed, MaybeAuthed, Message, OkResp, bad, now_ms, ok, require_guest_ok,
};
use crate::db::{Db, User, is_sqlite, now};
use crate::state::AppState;
use crate::ws::WsEvent;

/// Pinned messages one channel or DM can hold.
pub const PINS_MAX: i64 = 100;

/// A message pinned again within this many seconds of its last pin notice gets no new notice.
pub const PIN_NOTICE_SECS: i64 = 600;

/// When `id` was pinned (Unix seconds); `None` when it is not pinned or does not exist.
pub(crate) async fn pinned_at(db: &Db, id: i64) -> Result<Option<i64>, ApiError> {
    let row = sqlx::query("SELECT pinned_at / 1000 FROM messages WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    match row {
        Some(r) => Ok(r.try_get(0)?),
        None => Ok(None),
    }
}

/// The message `user` pins or unpins: readable by them, and `pin_gate` passes.
async fn pin_target(state: &AppState, id: i64, user: &User) -> Result<ResolvedMessage, ApiError> {
    let resolved = resolve_message(&state.db, id, Some(user), &Proof::none()).await?;
    resolved.pin_gate(&state.db).await?;
    Ok(resolved)
}

struct Place {
    column: &'static str,
    lock: &'static str,
    key: i64,
    full: &'static str,
}

fn place_of(scope: &MsgScope) -> Result<Place, ApiError> {
    match (scope.channel_id, scope.dm_id) {
        (Some(key), _) => Ok(Place {
            column: "channel_id",
            lock: "SELECT id FROM channels WHERE id = $1 FOR NO KEY UPDATE",
            key,
            full: "This channel has reached the pin limit",
        }),
        (None, Some(key)) => Ok(Place {
            column: "dm_id",
            lock: "SELECT id FROM dms WHERE id = $1 FOR NO KEY UPDATE",
            key,
            full: "This conversation has reached the pin limit",
        }),
        (None, None) => Err(not_found()),
    }
}

fn cannot_pin() -> ApiError {
    bad("Cannot pin this message")
}

/// Pin a message
///
/// Pins a top-level message of a channel or DM. Requires a bearer token. Guests cannot pin.
/// Needs read access to the message. In server channels, also needs membership, the Manage
/// messages permission (bit 2, which also lets you delete messages of others) and the right to
/// send in the channel. In DMs, needs to be a participant. Only normal messages can be pinned
/// (not thread replies, call logs or pin notices). A channel or DM has at most 100 pins. Pinning
/// a pinned message changes nothing. A new pin adds a `pin` message ("alice pinned a message";
/// empty `content`, `pin_message_id` is the pinned message) and emits `message` with it, unless
/// the same message got a pin notice in the last 10 minutes. In a channel with read-history
/// rules the live `message` leaves `pin_message_id` out; the message list has it. Then it emits
/// `message_pinned` (`{server, channel_id, dm_id, dm_users, message_id, pinned_at, pinned_by}`,
/// ids only) to clients that can see the channel, or to both DM participants. General rate-limit
/// bucket.
#[utoipa::path(put, path = "/api/v1/messages/{id}/pin", tag = "Messages", params(("id" = i64, Path, description = "Message id")), responses((status = 200, description = "Pinned (or already pinned); body `{\"ok\": true}`", body = OkResp), (status = 400, description = "`Cannot pin this message`: a thread reply, a call log or a pin notice. A non-numeric id gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Not a member of the channel's server, no Manage messages permission, or no permission to send in the channel, or a block between the DM participants (`This user is not accepting messages from you.` for the blocked side, `You blocked this user. Unblock them to send messages.` for the blocker)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 409, description = "`This channel has reached the pin limit` or `This conversation has reached the pin limit` (100 pinned messages)", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket (plain text), or `Too many attempts. Try again later` (JSON) after more than 30 reactions, pins and edits in 10 seconds", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn pin_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<OkResp>, ApiError> {
    let resolved = pin_target(&state, id, &user).await?;
    let message = load_message(&state.db, id, Quotes::Skip)
        .await?
        .ok_or_else(not_found)?;
    if !matches!(message.kind.as_str(), "user" | "poll") || message.thread_root_id.is_some() {
        return Err(cannot_pin());
    }
    let audit = moderated(&state.db, id, &resolved, &user, false).await?;
    let scope = resolved.into_scope();
    let Place {
        column,
        lock,
        key,
        full,
    } = place_of(&scope)?;
    let at = now_ms();
    let mut tx = state.db.begin().await?;
    if !is_sqlite(&state.db) {
        sqlx::query(lock).bind(key).fetch_optional(&mut *tx).await?;
    }
    let sql = format!(
        "UPDATE messages SET pinned_at = $2, pinned_by = $3 WHERE id = $1 AND pinned_at IS NULL AND (SELECT COUNT(*) FROM messages p WHERE p.{column} = $4 AND p.pinned_at IS NOT NULL) < $5"
    );
    let pinned = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(at)
        .bind(&user.username)
        .bind(key)
        .bind(PINS_MAX)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0;
    if !pinned {
        let already = sqlx::query("SELECT 1 FROM messages WHERE id = $1 AND pinned_at IS NOT NULL")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
        tx.rollback().await?;
        return match already {
            true => Ok(ok()),
            false => Err(ApiError(StatusCode::CONFLICT, full.to_string())),
        };
    }
    let t = now();
    let notice: Option<i64> = sqlx::query(
        "INSERT INTO messages(channel_id, dm_id, author, content, kind, pin_message_id, created_at) SELECT $1, $2, $3, '', 'pin', $4, $5 WHERE NOT EXISTS(SELECT 1 FROM messages n WHERE n.pin_message_id = $4 AND n.kind = 'pin' AND n.created_at > $6) RETURNING id",
    )
    .bind(scope.channel_id)
    .bind(scope.dm_id)
    .bind(&user.username)
    .bind(id)
    .bind(t)
    .bind(t - PIN_NOTICE_SECS)
    .fetch_optional(&mut *tx)
    .await?
    .map(|r| r.try_get(0))
    .transpose()?;
    if let Some((server, actor, channel)) = &audit {
        audit::record(
            &mut tx,
            audit::message_entry(
                server,
                actor,
                audit::Action::MessagePin,
                id,
                &scope.author,
                channel,
            ),
        )
        .await?;
    }
    tx.commit().await?;
    let history_rules = match scope.channel_id {
        Some(cid) => sqlx::query(
            "SELECT 1 FROM channel_perms WHERE channel_id = $1 AND can_read_history = 0",
        )
        .bind(cid)
        .fetch_optional(&state.db)
        .await?
        .is_some(),
        None => false,
    };
    let MsgScope {
        channel_id,
        dm_id,
        thread_root_id: _,
        kind: _,
        author: _,
        media_id: _,
        media_filename: _,
        media_kind: _,
        server,
        dm_users,
    } = scope;
    if let Some(notice) = notice
        && let Some(mut row) = load_broadcast(&state.db, notice).await?
    {
        if history_rules {
            row.pin_message_id = None;
        }
        if let (Some(id), Some(users)) = (dm_id, &dm_users) {
            crate::api::dms::reopen_for(&state, id, &user.username, users).await;
        }
        state.hub.broadcast(WsEvent::Message {
            server: server.clone(),
            channel_id,
            dm_id,
            dm_users: dm_users.clone(),
            message: Box::new(row),
        });
    }
    state.hub.broadcast(WsEvent::MessagePinned {
        server,
        channel_id,
        dm_id,
        dm_users,
        message_id: id,
        pinned_at: at / 1000,
        pinned_by: user.username,
    });
    Ok(ok())
}

/// Unpin a message
///
/// Removes a message from the pinned messages of its channel or DM, with the same access rules
/// as pinning. Unpinning adds no message. Unpinning a message that is not pinned changes
/// nothing. Emits `message_unpinned` (`{server, channel_id, dm_id, dm_users, message_id}`) to
/// clients that can see the channel, or to both DM participants. General rate-limit bucket.
#[utoipa::path(delete, path = "/api/v1/messages/{id}/pin", tag = "Messages", params(("id" = i64, Path, description = "Message id")), responses((status = 200, description = "Unpinned (or was not pinned); body `{\"ok\": true}`", body = OkResp), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Not a member of the channel's server, no Manage messages permission, or no permission to send in the channel, or a block between the DM participants (`This user is not accepting messages from you.` for the blocked side, `You blocked this user. Unblock them to send messages.` for the blocker)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket (plain text), or `Too many attempts. Try again later` (JSON) after more than 30 reactions, pins and edits in 10 seconds", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn unpin_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<OkResp>, ApiError> {
    let resolved = pin_target(&state, id, &user).await?;
    let audit = moderated(&state.db, id, &resolved, &user, false).await?;
    let mut tx = state.db.begin().await?;
    let unpinned = sqlx::query(
        "UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1 AND pinned_at IS NOT NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    if unpinned && let Some((server, actor, channel)) = &audit {
        audit::record(
            &mut tx,
            audit::message_entry(
                server,
                actor,
                audit::Action::MessageUnpin,
                id,
                &resolved.scope().author,
                channel,
            ),
        )
        .await?;
    }
    tx.commit().await?;
    if unpinned {
        let MsgScope {
            channel_id,
            dm_id,
            thread_root_id: _,
            kind: _,
            author: _,
            media_id: _,
            media_filename: _,
            media_kind: _,
            server,
            dm_users,
        } = resolved.into_scope();
        state.hub.broadcast(WsEvent::MessageUnpinned {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id: id,
        });
    }
    Ok(ok())
}

/// List channel pins
///
/// Returns the pinned messages of a channel, most recently pinned first, with link previews
/// and `pinned_at`. Access is checked like reading the channel (guests allowed when guest
/// access is on, password-protected servers, bans, channel view permission). Without
/// read-history access only messages sent since you joined are listed, so older pins stay
/// hidden. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/channels/{id}/pins", tag = "Messages", params(("id" = i64, Path, description = "Channel id")), responses((status = 200, description = "Up to 100 pinned top-level messages, most recently pinned first", body = Vec<Message>), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a server you have no access to (password-protected without access, or banned); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
pub(crate) async fn channel_pins(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    let channel = resolve_channel(
        db,
        id,
        user.as_ref(),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    let floor = channel.read_since(db).await?;
    Ok(Json(
        pinned_messages(db, Some(id), None, floor, PINS_MAX).await?,
    ))
}

/// List DM pins
///
/// Returns the pinned messages of a direct-message conversation, most recently pinned first,
/// with link previews and `pinned_at`. Requires a bearer token and being one of the two
/// participants. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/dms/{id}/pins", tag = "Direct messages", params(("id" = i64, Path, description = "DM conversation id")), responses((status = 200, description = "Up to 100 pinned messages, most recently pinned first", body = Vec<Message>), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no such DM, you are not a participant, or a participant's account is being deleted; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn dm_pins(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<Vec<Message>>, ApiError> {
    let db = &state.read();
    resolve_dm(db, id, &user).await?;
    Ok(Json(
        pinned_messages(db, None, Some(id), None, PINS_MAX).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::messages::{send_thread_message, thread_messages};
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use axum::extract::Query;

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

    async fn count(db: &Db, sql: &str) -> i64 {
        id_of(db, sql).await
    }

    async fn add_user(db: &Db, name: &str) {
        crate::db::NewUser::plain(name)
            .shown(&name.to_uppercase())
            .at(1)
            .add(db)
            .await;
    }

    async fn post(db: &Db, cid: Option<i64>, dm: Option<i64>, author: &str, at: i64) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, dm_id, author, content, created_at) VALUES($1, $2, $3, 'secret words', $4) RETURNING id")
            .bind(cid)
            .bind(dm)
            .bind(author)
            .bind(at)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id")
    }

    async fn pin(state: &AppState, who: &str, id: i64) -> Result<(), ApiError> {
        pin_message(State(state.clone()), Path(id), Authed(mem_user(who, false)))
            .await
            .map(|_| ())
    }

    async fn unpin(state: &AppState, who: &str, id: i64) -> Result<(), ApiError> {
        unpin_message(State(state.clone()), Path(id), Authed(mem_user(who, false)))
            .await
            .map(|_| ())
    }

    async fn pins_of(state: &AppState, who: Option<&str>, cid: i64) -> Result<Vec<i64>, ApiError> {
        channel_pins(
            State(state.clone()),
            MaybeAuthed(who.map(|w| mem_user(w, false))),
            HeaderMap::new(),
            Path(cid),
        )
        .await
        .map(|Json(list)| list.iter().map(|m| m.id).collect())
    }

    fn code(res: Result<(), ApiError>) -> Option<(StatusCode, String)> {
        res.err().map(|ApiError(code, e)| (code, e))
    }

    fn events(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::Message { message, .. } => Some(format!(
                    "message {} by {} '{}' -> {:?}",
                    message.kind, message.author.username, message.content, message.pin_message_id
                )),
                WsEvent::MessagePinned {
                    message_id,
                    pinned_by,
                    channel_id,
                    dm_id,
                    ..
                } => Some(format!(
                    "pinned {message_id} by {pinned_by} c{channel_id:?} d{dm_id:?}"
                )),
                WsEvent::MessageUnpinned { message_id, .. } => {
                    Some(format!("unpinned {message_id}"))
                }
                _ => None,
            })
            .collect()
    }

    async fn world(tag: &str) -> (AppState, std::path::PathBuf, i64) {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dora", "nina"] {
            add_user(db, name).await;
        }
        add_member(db, "rchat", "alice", 1, Perm::DeleteMessages as i64, 1).await;
        add_member(db, "rchat", "bob", 0, 0, 1).await;
        add_member(db, "rchat", "carol", 1, Perm::Kick as i64, 1).await;
        add_member(db, "rchat", "dora", 0, 0, 100).await;
        let cid = id_of(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        (state, path, cid)
    }

    use crate::api::access::perms::Perm;

    #[tokio::test]
    async fn manage_messages_pins_top_level_user_messages_with_a_notice() {
        let (state, path, cid) = world("pins_perms").await;
        let db = &state.db;
        let msg = post(db, Some(cid), None, "bob", 5).await;
        let reply = id_of(db, &format!("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES({cid}, {msg}, 'bob', 'reply', 6) RETURNING id")).await;
        let call = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, kind, created_at) VALUES({cid}, 'bob', '', 'call', 6) RETURNING id")).await;
        let mut rx = state.hub.subscribe();

        let forbidden = Some((
            StatusCode::FORBIDDEN,
            "No permission to manage messages".to_string(),
        ));
        assert_eq!(code(pin(&state, "bob", msg).await), forbidden);
        assert_eq!(
            code(pin(&state, "carol", msg).await),
            forbidden,
            "kick only"
        );
        assert_eq!(
            code(pin(&state, "nina", msg).await),
            Some((StatusCode::FORBIDDEN, "Not a member".to_string()))
        );
        assert_eq!(
            code(pin(&state, "alice", 999_999).await),
            Some((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        let bad = Some((
            StatusCode::BAD_REQUEST,
            "Cannot pin this message".to_string(),
        ));
        assert_eq!(code(pin(&state, "alice", reply).await), bad);
        assert_eq!(code(pin(&state, "alice", call).await), bad);
        assert!(events(&mut rx).is_empty());

        pin(&state, "alice", msg).await.expect("pin");
        assert_eq!(
            events(&mut rx),
            vec![
                format!("message pin by alice '' -> Some({msg})"),
                format!("pinned {msg} by alice c Some({cid}) dNone").replace("c Some", "cSome"),
            ]
        );
        let notice = id_of(db, "SELECT id FROM messages WHERE kind = 'pin'").await;
        let loaded = load_message(db, notice, Quotes::Skip)
            .await
            .expect("load")
            .expect("notice");
        assert_eq!((loaded.kind.as_str(), loaded.content.as_str()), ("pin", ""));
        assert_eq!(loaded.pin_message_id, Some(msg));
        assert_eq!(loaded.channel_id, Some(cid));
        assert!(loaded.pinned_at.is_none());
        assert_eq!(
            code(pin(&state, "alice", notice).await),
            bad,
            "pin notices cannot be pinned"
        );
        let pinned = load_message(db, msg, Quotes::Skip)
            .await
            .expect("load")
            .expect("pinned");
        assert!(pinned.pinned_at.is_some_and(|t| (now() - t).abs() < 5));
        assert_eq!(
            count(db, &format!("SELECT COUNT(*) FROM messages WHERE id = {msg} AND pinned_by = 'alice' AND pinned_at > 1000000000000")).await,
            1,
            "stored in milliseconds"
        );

        pin(&state, "alice", msg).await.expect("pin again");
        assert!(events(&mut rx).is_empty(), "pinning twice changes nothing");
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE kind = 'pin'").await,
            1
        );

        assert_eq!(code(unpin(&state, "bob", msg).await), forbidden);
        unpin(&state, "alice", msg).await.expect("unpin");
        assert_eq!(events(&mut rx), vec![format!("unpinned {msg}")]);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE kind = 'pin'").await,
            1,
            "unpinning adds no message"
        );
        unpin(&state, "alice", msg).await.expect("unpin again");
        assert!(events(&mut rx).is_empty());
        assert_eq!(
            pins_of(&state, Some("bob"), cid).await.expect("list"),
            Vec::<i64>::new()
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn pins_list_newest_first_and_respect_read_history() {
        let (state, path, cid) = world("pins_list").await;
        let db = &state.db;
        let old = post(db, Some(cid), None, "bob", 50).await;
        let newer = post(db, Some(cid), None, "bob", 150).await;
        let third = post(db, Some(cid), None, "bob", 160).await;
        for id in [newer, old, third] {
            pin(&state, "alice", id).await.expect("pin");
        }
        assert_eq!(
            pins_of(&state, Some("bob"), cid).await.expect("list"),
            vec![third, old, newer],
            "most recently pinned first"
        );
        assert_eq!(
            pins_of(&state, None, cid).await.expect("guest"),
            vec![third, old, newer]
        );
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({cid}, 'u:dora', 1, 1, 0), ({cid}, 'u:bob', 1, 1, 1), ({cid}, 'u:alice', 1, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        assert_eq!(
            pins_of(&state, Some("dora"), cid)
                .await
                .expect("no history"),
            vec![third, newer],
            "pins older than the viewer's floor are left out"
        );
        assert_eq!(
            code(pin(&state, "alice", 999).await).map(|c| c.0),
            Some(StatusCode::NOT_FOUND)
        );

        let page: crate::api::messages::PageQuery = serde_json::from_str("{}").expect("page query");
        let rows = |who: &str| {
            crate::api::messages::channel_messages(
                State(state.clone()),
                MaybeAuthed(Some(mem_user(who, false))),
                HeaderMap::new(),
                Path(cid),
                Query(page),
            )
        };
        let Json(list) = rows("dora").await.expect("dora list");
        let links: Vec<Option<i64>> = list
            .iter()
            .filter(|m| m.kind == "pin")
            .map(|m| m.pin_message_id)
            .collect();
        assert_eq!(
            links,
            vec![Some(newer), None, Some(third)],
            "no link to a message before the floor"
        );
        assert!(
            list.iter()
                .all(|m| m.content != "secret words" || m.id != old)
        );
        let Json(list) = rows("bob").await.expect("bob list");
        let links: Vec<Option<i64>> = list
            .iter()
            .filter(|m| m.kind == "pin")
            .map(|m| m.pin_message_id)
            .collect();
        assert_eq!(links, vec![Some(newer), Some(old), Some(third)]);

        exec(db, &format!("DELETE FROM messages WHERE id = {old}")).await;
        assert_eq!(
            pins_of(&state, Some("bob"), cid).await.expect("list"),
            vec![third, newer],
            "deleting a pinned message removes the pin"
        );
        let Json(list) = rows("bob").await.expect("bob list");
        let links: Vec<Option<i64>> = list
            .iter()
            .filter(|m| m.kind == "pin")
            .map(|m| m.pin_message_id)
            .collect();
        assert_eq!(links, vec![Some(newer), None, Some(third)]);

        let hidden = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'staff', 1) RETURNING id").await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden}, 'r:0', 0, 1, 1), ({hidden}, 'u:alice', 1, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        let secret = post(db, Some(hidden), None, "alice", 170).await;
        pin(&state, "alice", secret).await.expect("pin hidden");
        assert_eq!(
            pins_of(&state, Some("bob"), hidden)
                .await
                .err()
                .map(|e| e.0),
            Some(StatusCode::NOT_FOUND)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn pins_are_capped_per_channel_and_dm() {
        let (state, path, cid) = world("pins_cap").await;
        let db = &state.db;
        for n in 0..PINS_MAX - 1 {
            let id = post(db, Some(cid), None, "bob", 10 + n).await;
            exec(
                db,
                &format!(
                    "UPDATE messages SET pinned_at = {}, pinned_by = 'alice' WHERE id = {id}",
                    1000 + n
                ),
            )
            .await;
        }
        let last = post(db, Some(cid), None, "bob", 500).await;
        let over = post(db, Some(cid), None, "bob", 501).await;
        pin(&state, "alice", last).await.expect("the 100th pin");
        assert_eq!(
            code(pin(&state, "alice", over).await),
            Some((
                StatusCode::CONFLICT,
                "This channel has reached the pin limit".to_string()
            ))
        );
        pin(&state, "alice", last)
            .await
            .expect("re-pinning at the cap is fine");
        assert_eq!(
            pins_of(&state, Some("bob"), cid).await.expect("list").len() as i64,
            PINS_MAX
        );
        unpin(&state, "alice", last).await.expect("unpin");
        pin(&state, "alice", over).await.expect("room again");

        let dm = id_of(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        for n in 0..PINS_MAX {
            let id = post(db, None, Some(dm), "alice", 10 + n).await;
            exec(
                db,
                &format!(
                    "UPDATE messages SET pinned_at = {}, pinned_by = 'bob' WHERE id = {id}",
                    1000 + n
                ),
            )
            .await;
        }
        let extra = post(db, None, Some(dm), "bob", 600).await;
        assert_eq!(
            code(pin(&state, "bob", extra).await),
            Some((
                StatusCode::CONFLICT,
                "This conversation has reached the pin limit".to_string()
            ))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn either_dm_participant_pins_and_outsiders_get_404() {
        let (state, path, _) = world("pins_dm").await;
        let db = &state.db;
        let dm = id_of(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let a = post(db, None, Some(dm), "alice", 10).await;
        let b = post(db, None, Some(dm), "alice", 11).await;
        let mut rx = state.hub.subscribe();
        assert_eq!(
            code(pin(&state, "carol", a).await),
            Some((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        pin(&state, "bob", a)
            .await
            .expect("bob pins alice's message");
        pin(&state, "alice", b).await.expect("alice pins her own");
        assert_eq!(
            events(&mut rx),
            vec![
                format!("message pin by bob '' -> Some({a})"),
                format!("pinned {a} by bob cNone dSome({dm})"),
                format!("message pin by alice '' -> Some({b})"),
                format!("pinned {b} by alice cNone dSome({dm})"),
            ]
        );
        let list =
            |who: &str| dm_pins(State(state.clone()), Path(dm), Authed(mem_user(who, false)));
        let Json(got) = list("alice").await.expect("alice");
        assert_eq!(got.iter().map(|m| m.id).collect::<Vec<_>>(), vec![b, a]);
        assert!(got.iter().all(|m| m.pinned_at.is_some()));
        assert_eq!(
            list("carol").await.err().map(|e| e.0),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            code(unpin(&state, "carol", a).await).map(|c| c.0),
            Some(StatusCode::NOT_FOUND)
        );
        unpin(&state, "alice", a)
            .await
            .expect("either participant unpins");
        let Json(got) = list("bob").await.expect("bob");
        assert_eq!(got.iter().map(|m| m.id).collect::<Vec<_>>(), vec![b]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn replays_follow_the_stored_pin_state() {
        let (state, path, cid) = world("pins_replay").await;
        let db = &state.db;
        let msg = post(db, Some(cid), None, "bob", 5).await;
        let pinned = |pinned_at| WsEvent::MessagePinned {
            server: Some("rchat".to_string()),
            channel_id: Some(cid),
            dm_id: None,
            dm_users: None,
            message_id: msg,
            pinned_at,
            pinned_by: "alice".to_string(),
        };
        let unpinned = WsEvent::MessageUnpinned {
            server: Some("rchat".to_string()),
            channel_id: Some(cid),
            dm_id: None,
            dm_users: None,
            message_id: msg,
        };
        assert!(crate::ws::current(&state, pinned(1)).await.is_none());
        assert!(crate::ws::current(&state, unpinned.clone()).await.is_some());
        pin(&state, "alice", msg).await.expect("pin");
        let at = pinned_at(db, msg).await.expect("read").expect("pinned");
        match crate::ws::current(&state, pinned(1)).await {
            Some(WsEvent::MessagePinned { pinned_at, .. }) => assert_eq!(pinned_at, at),
            _ => panic!("replay of a live pin"),
        }
        assert!(crate::ws::current(&state, unpinned).await.is_none());
        done(state, path).await;
    }

    #[tokio::test]
    async fn threads_do_not_start_on_pin_notices() {
        let (state, path, cid) = world("pins_thread").await;
        let db = &state.db;
        let msg = post(db, Some(cid), None, "bob", 5).await;
        pin(&state, "alice", msg).await.expect("pin");
        let notice = id_of(db, "SELECT id FROM messages WHERE kind = 'pin'").await;
        let reply = |id| {
            send_thread_message(
                State(state.clone()),
                Path(id),
                Authed(mem_user("bob", false)),
                Json(serde_json::from_str(r#"{"content":"hi"}"#).expect("req")),
            )
        };
        let bad = StatusCode::BAD_REQUEST;
        assert_eq!(reply(notice).await.err().map(|ApiError(c, _)| c), Some(bad));
        let listed = thread_messages(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("bob", false))),
            HeaderMap::new(),
            Path(notice),
            Query::try_from_uri(&"/thread".parse().expect("uri")).expect("query"),
        )
        .await;
        assert_eq!(listed.err().map(|ApiError(c, _)| c), Some(bad));
        assert!(reply(msg).await.is_ok());
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM messages WHERE thread_root_id IS NOT NULL"
            )
            .await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn repinning_soon_adds_no_second_notice() {
        let (state, path, cid) = world("pins_notice_throttle").await;
        let db = &state.db;
        let msg = post(db, Some(cid), None, "bob", 5).await;
        for _ in 0..3 {
            pin(&state, "alice", msg).await.expect("pin");
            unpin(&state, "alice", msg).await.expect("unpin");
        }
        assert_eq!(
            id_of(
                db,
                &format!(
                    "SELECT COUNT(*) FROM messages WHERE kind = 'pin' AND pin_message_id = {msg}"
                )
            )
            .await,
            1
        );
        sqlx::query("UPDATE messages SET created_at = created_at - $1 WHERE kind = 'pin'")
            .bind(PIN_NOTICE_SECS + 1)
            .execute(db)
            .await
            .expect("age");
        pin(&state, "alice", msg).await.expect("pin later");
        assert_eq!(
            id_of(
                db,
                &format!(
                    "SELECT COUNT(*) FROM messages WHERE kind = 'pin' AND pin_message_id = {msg}"
                )
            )
            .await,
            2
        );
        done(state, path).await;
    }
}
