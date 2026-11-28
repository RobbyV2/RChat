use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::time::Instant;
use utoipa::ToSchema;

use super::access::overwrite_sql::overwrite_sql;
use super::access::perms::{Perm, held};
use super::access::{Proof, not_found, resolve_channel, resolve_message};
use super::audit::{self, Action, Details, Entry, Target};
use super::budget;
use super::messages::{Quotes, cannot_reply, load_message, partial_quote};
use super::{ApiError, Authed, Message, OkResp, ProfanityTarget, check_len, check_profanity, ok};
use crate::crypt::body::{Parts, Scope};
use crate::db::{ChannelKind, Db, lock_server, now, pool_key, secret_key};
use crate::identity::random_id;
use crate::limits::bucket::{Keyed, Policy};
use crate::state::AppState;
use crate::ws::WsEvent;
use rchat_perms::masks;

static NEW_SESSIONS: LazyLock<Keyed> = LazyLock::new(|| {
    Keyed::new(
        Policy::Window {
            limit: 20,
            window: Duration::from_secs(3600),
        },
        100_000,
    )
});
pub(crate) const SESSION_TTL: i64 = 30 * 86400;
const PAUSE: i64 = 600;
const PAUSED_UNTIL: &str = "SELECT MAX(blocked_until) FROM guest_chat_sessions WHERE server = $1 AND (address = $2 OR secret = $3) AND blocked_until > $4";
const RENEW_SESSION: &str = "UPDATE guest_chat_sessions SET last_used = $3 WHERE secret = $1 AND server = $2 AND last_used > $4 RETURNING author, blocked_until";
const NEW_SESSION: &str = "INSERT INTO guest_chat_sessions(secret, server, author, address, last_used) VALUES($1, $2, $3, $4, $5)";
const ADDRESS_PAUSED: &str = "SELECT 1 FROM guest_chat_sessions WHERE server = $1 AND address = $2 AND blocked_until > $3 LIMIT 1";

/// Ordinary guest text in a server channel.
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GuestText {
    /// Non-blank message text, subject to the instance message limit and filter.
    pub content: String,
    /// Optional readable message quoted inline.
    pub reply_to: Option<i64>,
    /// Optional top-level message whose thread receives this reply.
    pub thread_root_id: Option<i64>,
}

/// A posted message and its server-scoped guest session.
#[derive(Serialize, ToSchema)]
pub struct Posted {
    /// The persisted message with its public guest author.
    pub message: Message,
    /// Private credential for this guest in this server. Keep it inside the client.
    pub session: String,
}

async fn address(db: &Db, server: &str) -> Result<String, ApiError> {
    let addr = budget::client()
        .map(budget::group)
        .map(|ip| ip.to_string())
        .unwrap_or_default();
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&crate::db::pepper(db).await?)
        .expect("HMAC accepts any key length");
    mac.update(b"guest chat address\0");
    mac.update(server.as_bytes());
    mac.update(&[0]);
    mac.update(addr.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn paused() -> ApiError {
    ApiError::locked_by(
        "Guest posting is paused by a moderator for up to 10 minutes",
        "pause",
        None,
    )
}

/// Whether a moderator pause applies to this guest in the given server.
pub(crate) async fn paused_until(
    db: &Db,
    server: &str,
    headers: &HeaderMap,
) -> Result<Option<i64>, ApiError> {
    let secret = headers
        .get("x-guest-session")
        .and_then(|v| v.to_str().ok())
        .map(secret_key);
    let row = sqlx::query(PAUSED_UNTIL)
        .bind(server)
        .bind(address(db, server).await?)
        .bind(secret)
        .bind(now())
        .fetch_one(db)
        .await?;
    Ok(row.try_get(0)?)
}

/// Check this guest's posting pause in a writable channel
///
/// A null value permits posting. Protected servers require X-Guest-Grant. A returning guest can send X-Guest-Session to check an existing moderator pause.
#[utoipa::path(get, path = "/api/v1/channels/{id}/guest-messages", operation_id = "guest_chat_status", tag = "Messages", params(("id" = i64, Path, description = "Text channel id")), responses((status = 200, description = "Unix time when guest posting resumes, or null", body = Option<i64>), (status = 404, description = "Posting unavailable")))]
pub(crate) async fn status(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Option<i64>>, ApiError> {
    let db = &state.db;
    let channel = resolve_channel(db, id, None, &Proof::headers(&headers, &state.limits)).await?;
    if channel.kind() != ChannelKind::Text || !channel.guest_participation(db).await? {
        return Err(not_found());
    }
    Ok(Json(
        paused_until(db, channel.server().name(), &headers).await?,
    ))
}

/// Post guest text in a channel
///
/// A first send returns a private session. Present it in X-Guest-Session for later sends.
/// Private servers also require their live X-Guest-Grant. Guest replies never notify anyone.
/// Guests hold what everyone holds in the channel: the first reply of a thread needs Start
/// threads, and without Embed links the message gets no link previews.
#[utoipa::path(post, path = "/api/v1/channels/{id}/guest-messages", operation_id = "guest_chat_post", tag = "Messages", params(("id" = i64, Path, description = "Text channel id")), request_body = GuestText, responses((status = 200, description = "Message sent", body = Posted), (status = 400, description = "Invalid text or reply"), (status = 401, description = "Guest session expired"), (status = 403, description = "Guest posting paused"), (status = 404, description = "Channel unavailable, or the first reply of a thread where everyone may not start threads"), (status = 429, description = "Slow mode, the message rate of the client address (`Sending too fast, try again in a moment`, with `Retry-After`) or request limit")))]
pub(crate) async fn post(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(req): Json<GuestText>,
) -> Result<Json<Posted>, ApiError> {
    if headers.contains_key("authorization") {
        return Err(ApiError::invalid(
            "Use the account message endpoint",
            "authorization",
        ));
    }
    let db = &state.db;
    let proof = Proof::headers(&headers, &state.limits);
    let channel = resolve_channel(db, id, None, &proof).await?;
    if channel.kind() != ChannelKind::Text || !channel.guest_participation(db).await? {
        return Err(not_found());
    }
    let GuestText {
        content,
        reply_to,
        thread_root_id,
    } = req;
    check_len(&content, state.limits.message_max_chars, "Message")?;
    if content.trim().is_empty() {
        return Err(ApiError::invalid("Message is empty", "content"));
    }
    check_profanity(db, ProfanityTarget::Messages, &content).await?;
    if let Some(root) = thread_root_id {
        let root = resolve_message(db, root, None, &proof).await?;
        if root.thread_channel()?.id() != id {
            return Err(not_found());
        }
    }
    if let Some(target) = reply_to {
        let message = super::allowed(resolve_message(db, target, None, &proof).await)?
            .ok_or_else(cannot_reply)?;
        let at = message.scope();
        if at.channel_id != Some(id)
            || !(at.thread_root_id == thread_root_id || thread_root_id == Some(target))
            || !matches!(at.kind.as_str(), "user" | "poll")
        {
            return Err(cannot_reply());
        }
    }

    super::messages::guest_message_rate(&state).await?;
    let server = channel.server().name();
    let addr = address(db, server).await?;
    let t = state.clock.unix();
    let reading = super::access::Reading::now(db).await;
    let mut tx = db.begin().await?;
    lock_server(&mut tx, server).await?;
    let expired = || {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "Guest session expired".into(),
            None,
        )
    };
    let (session, author) = match headers.get("x-guest-session") {
        Some(raw) => {
            let raw = raw.to_str().map_err(|_| expired())?;
            let row = sqlx::query(RENEW_SESSION)
                .bind(secret_key(raw))
                .bind(server)
                .bind(t)
                .bind(t - SESSION_TTL)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(expired)?;
            if row.try_get::<i64, _>(1)? > t {
                return Err(paused());
            }
            (raw.to_owned(), row.try_get::<String, _>(0)?)
        }
        None => {
            if !NEW_SESSIONS.take(&format!("{}:{addr}", pool_key(db)), 1.0, Instant::now()) {
                return Err(budget::slow_down());
            }
            let raw = random_id();
            let author = format!("@guest:{}", &random_id()[..16]);
            sqlx::query(NEW_SESSION)
                .bind(secret_key(&raw))
                .bind(server)
                .bind(&author)
                .bind(&addr)
                .bind(t)
                .execute(&mut *tx)
                .await?;
            (raw, author)
        }
    };
    if sqlx::query(ADDRESS_PAUSED)
        .bind(server)
        .bind(&addr)
        .bind(t)
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
    {
        return Err(paused());
    }
    sqlx::query("UPDATE guest_chat_sessions SET address = $2 WHERE secret = $1 AND address <> $2")
        .bind(secret_key(&session))
        .bind(&addr)
        .execute(&mut *tx)
        .await?;
    channel.slowmode_for(&mut *tx, &author).await?;
    let granted = proof.grants_server(db, &mut tx, server).await?;
    let mid = Stored {
        channel: id,
        server,
        thread_root_id,
        author: &author,
        content: &content,
        reply_to,
        at: t,
    }
    .insert(&state.db, &mut tx, reading, granted)
    .await?
    .ok_or_else(not_found)?;
    tx.commit().await?;
    let message = load_message(db, mid, Quotes::Since(channel.read_since(db).await?))
        .await?
        .ok_or_else(not_found)?;
    state.hub.broadcast(WsEvent::Message {
        server: Some(server.into()),
        channel_id: Some(id),
        dm_id: None,
        dm_users: None,
        message: Box::new(partial_quote(message.clone())),
    });
    Ok(Json(Posted { message, session }))
}

/// A guest message about to be stored.
struct Stored<'a> {
    channel: i64,
    server: &'a str,
    thread_root_id: Option<i64>,
    author: &'a str,
    content: &'a str,
    reply_to: Option<i64>,
    at: i64,
}

impl Stored<'_> {
    /// Stores the message only if, at the moment of the write, the server is still readable to
    /// this guest (publicly or with a live grant), the channel is a text channel where everyone
    /// may view and send (and, for the first reply of a thread, start threads), the server takes
    /// guest text and the site's guest switches are on. Where everyone may not embed links, the
    /// message gets no link previews.
    async fn insert(
        &self,
        db: &Db,
        tx: &mut sqlx::AnyConnection,
        reading: super::access::Reading,
        granted: bool,
    ) -> Result<Option<i64>, ApiError> {
        let public = reading.readable_sql();
        let view = overwrite_sql(masks::VIEW, None);
        let send = overwrite_sql(masks::SEND, None);
        let threads = overwrite_sql(held::THREADS, None);
        let embed = overwrite_sql(held::EMBED, None);
        let scope = Scope::Channel(self.channel);
        let writer = crate::api::seal::writer_of(db, tx, scope).await?;
        let parts = Parts::text(self.content);
        let stored = crate::api::seal::columns(writer.as_ref(), &parts);
        let reserved =
            crate::api::seal::reserve(tx, crate::db::is_sqlite(db), "messages", writer.as_ref())
                .await?;
        let (columns, values) = match reserved {
            Some(_) => (
                ", id, body, grams",
                format!(", $9, $10, {}", crate::api::seal::grams_value(11)),
            ),
            None => ("", String::new()),
        };
        let overriding = match reserved {
            Some(_) => " OVERRIDING SYSTEM VALUE",
            None => "",
        };
        let insert = format!(
            "INSERT INTO messages(channel_id, thread_root_id, author, content, reply_to, created_at, no_previews{columns}){overriding} SELECT $1, $2, $3, $4, $5, $6, CASE WHEN c.text_only <> 0 OR NOT {embed} THEN 1 ELSE 0 END{values} FROM channels c JOIN servers s ON s.name = c.server WHERE c.id = $1 AND s.name = $7 AND ($8 = 1 OR ({public})) AND COALESCE(s.password_hash, '') <> '!purging' AND c.kind = 'text' AND {view} AND {send} AND ($2 IS NULL OR {threads} OR EXISTS(SELECT 1 FROM messages tm WHERE tm.thread_root_id = $2)) AND s.guest_chat_opt_in = 1 AND (SELECT COUNT(*) FROM settings WHERE key IN ('guests_enabled', 'guest_chat_enabled') AND value = '1') = 2 RETURNING id"
        );
        let query = sqlx::query(sqlx::AssertSqlSafe(insert))
            .bind(self.channel)
            .bind(self.thread_root_id)
            .bind(self.author)
            .bind(&stored.content)
            .bind(self.reply_to)
            .bind(self.at)
            .bind(self.server)
            .bind(i64::from(granted));
        let query = match (reserved, &writer) {
            (Some(id), Some(writer)) => query
                .bind(id)
                .bind(writer.message(id, self.author, &parts))
                .bind(writer.grams(&parts)),
            (_, _) => query,
        };
        let row = query.fetch_optional(&mut *tx).await?;
        let id: Option<i64> = row.map(|r| r.try_get(0)).transpose()?;
        if let (Some(id), None, Some(writer)) = (id, reserved, &writer) {
            let record = writer.message(id, self.author, &parts);
            crate::api::seal::set_body(tx, "messages", "id", id, record).await?;
        }
        Ok(id)
    }
}

/// Pause a guest's text sends
///
/// Moderators with Timeout members can pause this guest and new sessions from its address in
/// this server for ten minutes.
#[utoipa::path(post, path = "/api/v1/messages/{id}/pause-guest", tag = "Moderation", params(("id" = i64, Path, description = "Guest message id")), responses((status = 200, description = "Guest posting paused", body = OkResp), (status = 404, description = "Not found")), security(("bearer" = [])))]
pub(crate) async fn pause(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<OkResp>, ApiError> {
    let db = &state.db;
    let message = resolve_message(db, id, Some(&user), &Proof::none()).await?;
    let server = message.channel().ok_or_else(not_found)?.server();
    server
        .require_perm(db, Perm::TimeoutMembers)
        .await
        .map_err(|e| if e.failed() { e } else { not_found() })?;
    let author = &message.scope().author;
    if !crate::ws::is_guest(author) {
        return Err(not_found());
    }
    let actor = server.audit_actor(db, Perm::TimeoutMembers).await?;
    let until = state.clock.unix() + PAUSE;
    let mut tx = db.begin().await?;
    if sqlx::query(
        "UPDATE guest_chat_sessions SET blocked_until = $3 WHERE server = $1 AND author = $2",
    )
    .bind(server.name())
    .bind(author)
    .bind(until)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 0
    {
        return Err(not_found());
    }
    audit::record(
        &mut tx,
        Entry::new(server.name(), &actor, Action::MemberTimeout)
            .target(Target::guest(author))
            .details(Details::new().set("until", until)),
    )
    .await?;
    tx.commit().await?;
    let current =
        super::access::resolve_server(db, server.name(), Some(&user), &Proof::none()).await?;
    state.hub.broadcast(WsEvent::ServerUpdated {
        server: current.lite().clone(),
    });
    Ok(ok())
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::path::PathBuf;

    use super::*;
    use crate::api::budget::as_client;
    use crate::api::test_util::{add_member, done, mem_user, site_sets, temp_state, test_grant};

    type Reply<T> = Result<T, (u16, String)>;

    fn code<T>(reply: &Reply<T>) -> u16 {
        match reply {
            Ok(_) => 200,
            Err((status, _)) => *status,
        }
    }

    fn headers(session: Option<&str>, grant: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(session) = session {
            headers.insert("x-guest-session", session.parse().expect("session"));
        }
        if let Some(grant) = grant {
            headers.insert("x-guest-grant", grant.parse().expect("grant"));
        }
        headers
    }

    fn from(at: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, at))
    }

    fn failed(ApiError(status, message, _): ApiError) -> (u16, String) {
        (status.as_u16(), message)
    }

    async fn send(
        state: &AppState,
        channel: i64,
        headers: HeaderMap,
        at: u8,
        body: serde_json::Value,
    ) -> Reply<Posted> {
        let text: GuestText = serde_json::from_value(body).expect("guest text");
        as_client(
            from(at),
            post(State(state.clone()), Path(channel), headers, Json(text)),
        )
        .await
        .map(|Json(posted)| posted)
        .map_err(failed)
    }

    async fn say(
        state: &AppState,
        channel: i64,
        session: Option<&str>,
        text: &str,
    ) -> Reply<Posted> {
        send(
            state,
            channel,
            headers(session, None),
            1,
            serde_json::json!({ "content": text }),
        )
        .await
    }

    async fn check(
        state: &AppState,
        channel: i64,
        headers: HeaderMap,
        at: u8,
    ) -> Reply<Option<i64>> {
        as_client(
            from(at),
            status(State(state.clone()), Path(channel), headers),
        )
        .await
        .map(|Json(until)| until)
        .map_err(failed)
    }

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    async fn scalar(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect(sql)
    }

    async fn channel(db: &Db, server: &str, name: &str, kind: &str) -> i64 {
        sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES($1, $2, $3, 0) RETURNING id")
            .bind(server)
            .bind(name)
            .bind(kind)
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id")
    }

    async fn switches(state: &AppState, guests: bool, chat: bool, voice: bool) {
        site_sets(
            state,
            serde_json::json!({
                "guests_enabled": guests,
                "guest_chat_enabled": chat,
                "guest_voice_enabled": voice,
            }),
        )
        .await;
    }

    async fn opt_in(db: &Db, server: &str, chat: bool, voice: bool) {
        sqlx::query(
            "UPDATE servers SET guest_chat_opt_in = $1, guest_voice_opt_in = $2 WHERE name = $3",
        )
        .bind(i64::from(chat))
        .bind(i64::from(voice))
        .bind(server)
        .execute(db)
        .await
        .expect("opt-in");
    }

    /// The built-in server with guest text on at both levels, its text channel, and a moderator.
    async fn open_world(tag: &str) -> (AppState, PathBuf, i64) {
        let (state, path) = temp_state(tag).await;
        let general = open_in(&state).await;
        (state, path, general)
    }

    /// `open_world` on a state already made: its text channel.
    async fn open_in(state: &AppState) -> i64 {
        let db = &state.db;
        crate::db::NewUser::plain("moderator")
            .hash("x")
            .add(db)
            .await;
        crate::db::NewUser::plain("member").hash("x").add(db).await;
        add_member(db, "rchat", "moderator", 1, 0, 0).await;
        add_member(db, "rchat", "member", 0, 0, 0).await;
        switches(state, true, true, false).await;
        opt_in(db, "rchat", true, false).await;
        scalar(
            db,
            "SELECT id FROM channels WHERE server = 'rchat' AND kind = 'text' ORDER BY id LIMIT 1",
        )
        .await
    }

    #[tokio::test]
    async fn guest_text_needs_both_the_site_and_the_server() {
        let (state, path, general) = open_world("guest_text_switches").await;
        let db = &state.db;
        for (guests, site, server, voice, open) in [
            (true, false, false, false, false),
            (true, true, false, false, false),
            (true, false, true, false, false),
            (true, true, true, false, true),
            (false, true, true, false, false),
            (true, false, false, true, false),
        ] {
            switches(&state, guests, site, voice).await;
            opt_in(db, "rchat", server, voice).await;
            let case = format!("guests {guests}, site {site}, server {server}, voice {voice}");
            let expect = if open { 200 } else { 404 };
            assert_eq!(
                code(&check(&state, general, headers(None, None), 1).await),
                expect,
                "status: {case}"
            );
            let sent = say(&state, general, None, "hello there").await;
            assert_eq!(code(&sent), expect, "post: {case}");
            if let Err((404, message)) = &sent {
                assert_eq!(message, "Not found", "{case}");
            }
        }
        assert_eq!(
            scalar(
                db,
                "SELECT COUNT(*) FROM messages WHERE author LIKE '@guest:%'"
            )
            .await,
            1,
            "only the open case stored a message"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn guests_post_only_where_they_can_read_and_send() {
        let (state, path, general) = open_world("guest_text_channels").await;
        let db = &state.db;
        let hidden = channel(db, "rchat", "hidden", "text").await;
        exec(
            db,
            &format!("UPDATE channels SET restrict_view = 1 WHERE id = {hidden}"),
        )
        .await;
        let locked = channel(db, "rchat", "announcements", "text").await;
        exec(
            db,
            &format!("UPDATE channels SET restrict_send = 1 WHERE id = {locked}"),
        )
        .await;
        let voice = channel(db, "rchat", "lounge", "voice").await;
        for (room, what) in [
            (hidden, "a hidden channel"),
            (locked, "a read-only channel"),
            (voice, "a voice channel"),
        ] {
            assert_eq!(
                code(&check(&state, room, headers(None, None), 1).await),
                404,
                "{what}"
            );
            assert_eq!(code(&say(&state, room, None, "hello").await), 404, "{what}");
        }
        assert_eq!(code(&say(&state, general, None, "hello").await), 200);

        let hash = crate::api::auth::hash_password("vault password")
            .await
            .expect("hash");
        sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'moderator', $1, 0)")
            .bind(hash)
            .execute(db)
            .await
            .expect("vault");
        opt_in(db, "vault", true, false).await;
        let vault = channel(db, "vault", "general", "text").await;
        let grant = test_grant("vault guest");
        let body = || serde_json::json!({ "content": "behind the password" });
        let without = send(&state, vault, headers(None, None), 2, body()).await;
        assert_eq!(code(&without), 404, "no grant");
        let stale = send(&state, vault, headers(None, Some(&grant)), 2, body()).await;
        assert_eq!(code(&stale), 404, "a grant the server never issued");
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'vault', 0, 4000000000)")
            .bind(crate::db::secret_key(&grant))
            .execute(db)
            .await
            .expect("grant");
        assert_eq!(
            code(&check(&state, vault, headers(None, Some(&grant)), 2).await),
            200
        );
        let first = send(&state, vault, headers(None, Some(&grant)), 2, body())
            .await
            .expect("with the grant");
        exec(db, "DELETE FROM guest_grants WHERE server = 'vault'").await;
        let revoked = send(
            &state,
            vault,
            headers(Some(&first.session), Some(&grant)),
            2,
            body(),
        )
        .await;
        assert_eq!(code(&revoked), 404, "the grant ended");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_paused_guest_and_its_address_wait_for_the_pause_to_end() {
        let (state, path, general) = open_world("guest_text_pause").await;
        let db = &state.db;
        let body = || serde_json::json!({ "content": "noise" });
        let first = send(&state, general, headers(None, None), 1, body())
            .await
            .expect("first");
        let pause_by = |who: &'static str, id: i64| {
            let state = state.clone();
            async move {
                pause(State(state), Authed(mem_user(who, false)), Path(id))
                    .await
                    .map(|_| ())
                    .map_err(failed)
            }
        };
        assert_eq!(
            code(&pause_by("member", first.message.id).await),
            404,
            "members can't pause"
        );
        let account = scalar(
            db,
            &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({general}, 'member', 'mine', 1) RETURNING id"),
        )
        .await;
        assert_eq!(
            code(&pause_by("moderator", account).await),
            404,
            "only guests are paused"
        );
        pause_by("moderator", first.message.id)
            .await
            .expect("pause");
        assert_eq!(
            scalar(
                db,
                "SELECT COUNT(*) FROM audit_log WHERE action = 'member.timeout' AND target_name LIKE '@guest:%'"
            )
            .await,
            1
        );
        let again = send(
            &state,
            general,
            headers(Some(&first.session), None),
            1,
            body(),
        )
        .await;
        assert_eq!(again.err().map(|e| e.0), Some(403), "the same session");
        let fresh = send(&state, general, headers(None, None), 1, body()).await;
        assert_eq!(
            fresh.err().map(|e| e.0),
            Some(403),
            "a new session from the same address"
        );
        let until = check(&state, general, headers(Some(&first.session), None), 1)
            .await
            .expect("status");
        assert!(
            until.is_some_and(|t| t > now()),
            "the paused guest sees when it ends"
        );
        let elsewhere = send(&state, general, headers(None, None), 2, body())
            .await
            .expect("another address");
        assert_eq!(
            check(&state, general, headers(Some(&elsewhere.session), None), 2).await,
            Ok(None)
        );
        exec(
            db,
            &format!(
                "UPDATE guest_chat_sessions SET blocked_until = {} WHERE blocked_until > 0",
                now() - 1
            ),
        )
        .await;
        let after = send(
            &state,
            general,
            headers(Some(&first.session), None),
            1,
            body(),
        )
        .await
        .expect("after the pause");
        assert_eq!(after.message.author.username, first.message.author.username);
        done(state, path).await;
    }

    #[tokio::test]
    async fn guest_authors_come_from_the_server_and_sessions_age_out() {
        let (state, path, general) = open_world("guest_text_sessions").await;
        let db = &state.db;
        let first = say(&state, general, None, "one").await.expect("first");
        let author = first.message.author.username.clone();
        assert!(crate::ws::is_guest(&author));
        assert_eq!(author.len(), "@guest:".len() + 16);
        assert!(
            author["@guest:".len()..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        );
        assert!(!author.contains(&first.session[..16]));
        let second = say(&state, general, Some(&first.session), "two")
            .await
            .expect("second");
        assert_eq!(
            second.message.author.username, author,
            "a session keeps its author"
        );
        assert_eq!(second.session, first.session);
        assert_eq!(
            scalar(db, &format!("SELECT COUNT(*) FROM guest_chat_sessions WHERE secret = '{}' OR address LIKE '%10.0.0%'", first.session)).await,
            0,
            "only digests of the secret and the address are stored"
        );
        let other = say(&state, general, None, "three")
            .await
            .expect("another guest");
        assert_ne!(other.message.author.username, author);
        exec(
            db,
            &format!(
                "UPDATE guest_chat_sessions SET last_used = {}",
                now() - SESSION_TTL - 1
            ),
        )
        .await;
        assert_eq!(
            say(&state, general, Some(&first.session), "four")
                .await
                .err(),
            Some((401, "Guest session expired".to_string()))
        );
        let renewed = say(&state, general, None, "five")
            .await
            .expect("a new session");
        assert_ne!(renewed.message.author.username, author);
        assert_eq!(
            say(&state, general, Some("not a session"), "six")
                .await
                .err()
                .map(|e| e.0),
            Some(401)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn guest_replies_stay_in_their_channel_and_thread() {
        let (state, path, general) = open_world("guest_text_replies").await;
        let db = &state.db;
        let other = channel(db, "rchat", "elsewhere", "text").await;
        let insert = |sql: String| async move { scalar(db, &sql).await };
        let root = insert(format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({general}, 'member', 'root', 1) RETURNING id")).await;
        let reply = insert(format!("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES({general}, {root}, 'member', 'in the thread', 2) RETURNING id")).await;
        let away = insert(format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({other}, 'member', 'away', 1) RETURNING id")).await;
        let notice = insert(format!("INSERT INTO messages(channel_id, author, content, kind, created_at) VALUES({general}, 'member', '', 'join', 1) RETURNING id")).await;
        let post = |body: serde_json::Value| send(&state, general, headers(None, None), 1, body);
        let quoted = post(serde_json::json!({ "content": "agreed", "reply_to": root }))
            .await
            .expect("a reply");
        assert_eq!(quoted.message.reply_to.map(|r| r.id), Some(root));
        let threaded = post(serde_json::json!({ "content": "also", "thread_root_id": root }))
            .await
            .expect("in the thread");
        assert_eq!(threaded.message.thread_root_id, Some(root));
        post(serde_json::json!({ "content": "yes", "thread_root_id": root, "reply_to": reply }))
            .await
            .expect("a reply in the thread");
        for (body, what) in [
            (
                serde_json::json!({ "content": "x", "reply_to": away }),
                "another channel",
            ),
            (
                serde_json::json!({ "content": "x", "reply_to": notice }),
                "a system message",
            ),
            (
                serde_json::json!({ "content": "x", "reply_to": reply }),
                "a thread reply outside its thread",
            ),
            (
                serde_json::json!({ "content": "x", "reply_to": 999999 }),
                "a missing message",
            ),
        ] {
            assert_eq!(code(&post(body).await), 400, "{what}");
        }
        for (body, what) in [
            (
                serde_json::json!({ "content": "x", "thread_root_id": away }),
                "a root in another channel",
            ),
            (
                serde_json::json!({ "content": "x", "thread_root_id": 999999 }),
                "a missing root",
            ),
        ] {
            assert_eq!(code(&post(body).await), 404, "{what}");
        }
        assert_ne!(
            code(&post(serde_json::json!({ "content": "x", "thread_root_id": reply })).await),
            200,
            "a reply is no root"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn guests_start_threads_and_get_previews_only_where_everyone_may() {
        for (state, temp) in crate::api::test_util::each_db("guest_text_bits").await {
            let general = open_in(&state).await;
            let db = &state.db;
            let insert = |sql: String| async move { scalar(db, &sql).await };
            let root = insert(format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({general}, 'member', 'root', 1) RETURNING id")).await;
            let busy = insert(format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({general}, 'member', 'busy', 1) RETURNING id")).await;
            insert(format!("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES({general}, {busy}, 'member', 'in the thread', 2) RETURNING id")).await;
            let deny = held::THREADS | held::EMBED;
            exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, allow, deny) VALUES({general}, 'everyone', 0, {deny})")).await;
            let post =
                |body: serde_json::Value| send(&state, general, headers(None, None), 1, body);
            let link = "see https://example.com";
            assert_eq!(
                code(
                    &post(serde_json::json!({ "content": "first", "thread_root_id": root })).await
                ),
                404,
                "the first reply of a thread"
            );
            let joined = post(serde_json::json!({ "content": link, "thread_root_id": busy }))
                .await
                .expect("a reply in a thread already started");
            assert!(
                joined.message.no_previews,
                "no previews without Embed links"
            );
            let top = post(serde_json::json!({ "content": link }))
                .await
                .expect("a message in the channel");
            assert!(top.message.no_previews);
            exec(
                db,
                &format!("DELETE FROM channel_perms WHERE channel_id = {general}"),
            )
            .await;
            let first = post(serde_json::json!({ "content": link, "thread_root_id": root }))
                .await
                .expect("the first reply where everyone may start threads");
            assert_eq!(first.message.thread_root_id, Some(root));
            assert!(!first.message.no_previews);
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn guest_text_is_plain_limited_text_from_no_account() {
        let (state, path, general) = open_world("guest_text_limits").await;
        let db = &state.db;
        let mut account = headers(None, None);
        account.insert("authorization", "Bearer someone".parse().expect("header"));
        let refused = send(
            &state,
            general,
            account,
            1,
            serde_json::json!({ "content": "hi" }),
        )
        .await;
        assert_eq!(code(&refused), 400, "an account uses its own endpoint");
        assert!(
            serde_json::from_value::<GuestText>(
                serde_json::json!({ "content": "x", "media_id": "f" })
            )
            .is_err()
        );
        let max = state.limits.message_max_chars;
        assert_eq!(
            code(&say(&state, general, None, &"a".repeat(max + 1)).await),
            400
        );
        assert_eq!(code(&say(&state, general, None, "   ").await), 400);
        let full = say(&state, general, None, &"a".repeat(max))
            .await
            .expect("the longest message");
        let pinged = say(
            &state,
            general,
            Some(&full.session),
            "@everyone @here @member look",
        )
        .await
        .expect("mentions");
        assert!(pinged.message.group_mentions.is_empty());
        for table in ["pings", "group_pings", "here_pings"] {
            assert_eq!(
                scalar(db, &format!("SELECT COUNT(*) FROM {table}")).await,
                0,
                "{table}"
            );
        }
        crate::api::test_util::profanity_on(db).await;
        assert_eq!(
            code(&say(&state, general, Some(&full.session), "shit").await),
            400,
            "the instance filter"
        );

        exec(
            db,
            &format!("UPDATE channels SET slowmode_seconds = 60 WHERE id = {general}"),
        )
        .await;
        let slow = say(&state, general, None, "slow one")
            .await
            .expect("first in slow mode");
        assert_eq!(
            code(&say(&state, general, Some(&slow.session), "slow two").await),
            429,
            "slow mode"
        );
        say(&state, general, None, "another guest")
            .await
            .expect("slow mode is per guest");
        exec(
            db,
            &format!("UPDATE channels SET slowmode_seconds = 0 WHERE id = {general}"),
        )
        .await;

        let mut made = 0;
        let limited = loop {
            let reply = send(
                &state,
                general,
                headers(None, None),
                9,
                serde_json::json!({ "content": "new" }),
            )
            .await;
            match reply {
                Ok(_) => made += 1,
                Err(e) => break e.0,
            }
            assert!(made <= 20, "new sessions from one address are limited");
        };
        assert_eq!((made, limited), (20, 429));
        say(&state, general, None, "elsewhere")
            .await
            .expect("another address still gets one");
        done(state, path).await;
    }

    #[tokio::test]
    async fn guest_text_counts_against_the_message_rate_of_its_address() {
        let (state, path, general) = open_world("guest_text_rate").await;
        let state = state.with_limits(std::sync::Arc::new(crate::limits::Limits {
            message_rate_burst: 2,
            message_rate_per_minute: 1,
            ..crate::limits::Limits::default()
        }));
        let first = say(&state, general, None, "one").await.expect("one");
        say(&state, general, Some(&first.session), "two")
            .await
            .expect("two");
        let too_fast = Err((429, crate::api::messages::SENDING_TOO_FAST.to_string()));
        assert_eq!(
            say(&state, general, Some(&first.session), "three")
                .await
                .map(|_| ()),
            too_fast
        );
        assert_eq!(
            say(&state, general, None, "a new session")
                .await
                .map(|_| ()),
            too_fast,
            "a new session of the same address counts with it"
        );
        send(
            &state,
            general,
            headers(None, None),
            2,
            serde_json::json!({ "content": "elsewhere" }),
        )
        .await
        .expect("another address has its own rate");
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_write_reads_every_condition_again() {
        let (state, path, general) = open_world("guest_text_write_guard").await;
        let db = &state.db;
        sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, guest_chat_opt_in, created_at) VALUES('vault', 'Vault', 'moderator', 'hash', 1, 0)")
            .execute(db)
            .await
            .expect("vault");
        let vault = channel(db, "vault", "general", "text").await;
        let voice = channel(db, "rchat", "lounge", "voice").await;
        let stored = |channel: i64, server: &'static str, granted: bool| async move {
            let mut tx = db.begin().await.expect("begin");
            let id = Stored {
                channel,
                server,
                thread_root_id: None,
                author: "@guest:00000000000000aa",
                content: "hello",
                reply_to: None,
                at: now(),
            }
            .insert(
                db,
                &mut tx,
                super::super::access::Reading::now(db).await,
                granted,
            )
            .await
            .expect("insert");
            tx.rollback().await.expect("rollback");
            id.is_some()
        };
        assert!(stored(general, "rchat", false).await, "an open channel");
        for (change, undo) in [
            (
                "UPDATE servers SET guest_chat_opt_in = 0 WHERE name = 'rchat'",
                "UPDATE servers SET guest_chat_opt_in = 1 WHERE name = 'rchat'",
            ),
            (
                "UPDATE settings SET value = '0' WHERE key = 'guest_chat_enabled'",
                "UPDATE settings SET value = '1' WHERE key = 'guest_chat_enabled'",
            ),
            (
                "UPDATE settings SET value = '0' WHERE key = 'guests_enabled'",
                "UPDATE settings SET value = '1' WHERE key = 'guests_enabled'",
            ),
            (
                "UPDATE channels SET restrict_view = 1 WHERE server = 'rchat'",
                "UPDATE channels SET restrict_view = 0 WHERE server = 'rchat'",
            ),
            (
                "UPDATE channels SET restrict_send = 1 WHERE server = 'rchat'",
                "UPDATE channels SET restrict_send = 0 WHERE server = 'rchat'",
            ),
            (
                "UPDATE servers SET password_hash = '!purging' WHERE name = 'rchat'",
                "UPDATE servers SET password_hash = NULL WHERE name = 'rchat'",
            ),
        ] {
            exec(db, change).await;
            assert!(!stored(general, "rchat", true).await, "{change}");
            exec(db, undo).await;
        }
        assert!(stored(general, "rchat", false).await, "open again");
        assert!(!stored(voice, "rchat", false).await, "a voice channel");
        assert!(
            !stored(general, "vault", true).await,
            "a channel of another server"
        );
        assert!(
            !stored(vault, "vault", false).await,
            "a password server without a grant"
        );
        assert!(stored(vault, "vault", true).await, "with a live grant");
        done(state, path).await;
    }
}
