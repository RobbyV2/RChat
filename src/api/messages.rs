use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use crate::api::admin::like_pattern;
use crate::api::{
    ApiError, Authed, CallLog, Embed, LIST_MAX, LIST_PAGE, MESSAGE_MAX, MaybeAuthed, MediaRef,
    Message, UserRef, check_len, check_profanity, embeds, header_grants, media::MEDIA_TTL_SECS,
    require_guest_ok, require_server_view, user_from, user_refs,
};
use crate::db::{
    ChannelAccess, ChannelKind, Db, MediaKind, Perm, User, channel_access, effective_perms,
    has_fts, has_perm, now, touch_interaction,
};
use crate::state::AppState;
use crate::ws::WsEvent;

const COLS: &str = "m.id, m.channel_id, m.dm_id, m.thread_root_id, m.author, m.content, m.media_id, m.media_filename, m.media_removed, m.media_spoiler, m.created_at, (SELECT COUNT(*) FROM messages r WHERE r.thread_root_id = m.id), m.media_kind, m.media_hoster, m.media_expires_at, m.media_size, m.media_mime, m.kind, m.call_answered_at, m.call_ended_at, m.call_outcome";

#[derive(Deserialize, IntoParams)]
pub struct PageQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

#[derive(Deserialize, ToSchema)]
pub struct SendReq {
    content: String,
    media_id: Option<String>,
    media_spoiler: Option<bool>,
    p2p: Option<P2pAttachment>,
}

#[derive(Deserialize, ToSchema)]
pub struct P2pAttachment {
    filename: String,
    size: i64,
    mime: String,
    p2p_id: String,
    expires_in_seconds: Option<i64>,
}

#[derive(Deserialize, IntoParams)]
pub struct SearchQuery {
    q: Option<String>,
    server: Option<String>,
    channel_id: Option<i64>,
    from: Option<String>,
    has: Option<String>,
    before: Option<i64>,
    after: Option<i64>,
    before_ts: Option<i64>,
    after_ts: Option<i64>,
    offset: Option<i64>,
    servers: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct SearchResult {
    pub message: Message,
    pub server: String,
    pub channel_name: String,
}

#[derive(Serialize, ToSchema)]
pub struct Unread {
    pub scope: String,
    pub server: Option<String>,
    pub last_read: i64,
    pub latest: i64,
}

#[derive(Serialize, ToSchema)]
pub struct Unreads {
    pub items: Vec<Unread>,
}

#[derive(Deserialize, ToSchema)]
pub struct ReadReq {
    scope: String,
    last_read: i64,
}

#[derive(Serialize, ToSchema)]
pub struct ReadState {
    pub scope: String,
    pub last_read: i64,
}

fn valid_scope(scope: &str) -> bool {
    let bytes = scope.as_bytes();
    bytes.len() >= 2
        && matches!(bytes[0], b'c' | b'd')
        && bytes[1..].iter().all(|b| b.is_ascii_digit())
}

fn row_message(r: &AnyRow, refs: &HashMap<String, UserRef>) -> Result<Message, ApiError> {
    let media = match r.try_get::<Option<String>, _>(6)? {
        Some(id) => {
            let removed = r.try_get::<i64, _>(8)?;
            Some(MediaRef {
                id,
                filename: r.try_get::<Option<String>, _>(7)?.unwrap_or_default(),
                kind: MediaKind::parse(&r.try_get::<String, _>(12)?)?,
                hoster: r.try_get(13)?,
                expires_at: r.try_get(14)?,
                size: r.try_get(15)?,
                mime: r.try_get(16)?,
                removed: removed != 0,
                removed_by_author: removed == 2,
                spoiler: r.try_get::<i64, _>(9)? != 0,
            })
        }
        None => None,
    };
    let kind: String = r.try_get(17)?;
    let call = match kind.as_str() {
        "call" => Some(CallLog {
            from: r.try_get(4)?,
            answered_at: r.try_get(18)?,
            ended_at: r.try_get(19)?,
            outcome: r.try_get(20)?,
        }),
        _ => None,
    };
    Ok(Message {
        id: r.try_get(0)?,
        channel_id: r.try_get(1)?,
        dm_id: r.try_get(2)?,
        thread_root_id: r.try_get(3)?,
        author: user_from(refs, &r.try_get::<String, _>(4)?),
        content: r.try_get(5)?,
        created_at: r.try_get(10)?,
        reply_count: r.try_get(11)?,
        media,
        embeds: Vec::new(),
        kind,
        call,
    })
}

async fn rows_messages(db: &Db, rows: &[AnyRow]) -> Result<Vec<Message>, ApiError> {
    let mut authors = Vec::with_capacity(rows.len());
    for r in rows {
        authors.push(r.try_get::<String, _>(4)?);
    }
    let refs = user_refs(db, &authors).await;
    rows.iter().map(|r| row_message(r, &refs)).collect()
}

pub(crate) async fn load_message(db: &Db, id: i64) -> Result<Option<Message>, ApiError> {
    let sql = format!("SELECT {COLS} FROM messages m WHERE m.id = $1");
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_all(db)
        .await?;
    Ok(rows_messages(db, &rows).await?.pop())
}

async fn attach_embeds(db: &Db, msgs: &mut [Message]) -> Result<(), ApiError> {
    if msgs.is_empty() {
        return Ok(());
    }
    let ph: Vec<String> = (1..=msgs.len()).map(|n| format!("${n}")).collect();
    let sql = format!(
        "SELECT me.message_id, me.ord, me.url, me.banner_removed, e.site_name, e.title, e.description, e.image_url FROM message_embeds me JOIN embeds e ON e.url = me.url WHERE me.removed = 0 AND me.message_id IN ({}) ORDER BY me.message_id, me.ord",
        ph.join(", ")
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for m in msgs.iter() {
        query = query.bind(m.id);
    }
    let rows = query.fetch_all(db).await?;
    let mut map: HashMap<i64, Vec<Embed>> = HashMap::new();
    for r in &rows {
        map.entry(r.try_get(0)?).or_default().push(Embed {
            ord: r.try_get(1)?,
            url: r.try_get(2)?,
            site_name: r.try_get(4)?,
            title: r.try_get(5)?,
            description: r.try_get(6)?,
            image_url: r.try_get(7)?,
            banner_removed: r.try_get::<i64, _>(3)? != 0,
        });
    }
    for m in msgs.iter_mut() {
        if let Some(embeds) = map.remove(&m.id) {
            m.embeds = embeds;
        }
    }
    Ok(())
}

async fn page(
    db: &Db,
    cond: &str,
    key: i64,
    q: &PageQuery,
    min_ts: Option<i64>,
) -> Result<Vec<Message>, ApiError> {
    let sql = format!(
        "SELECT {COLS} FROM messages m WHERE {cond} AND m.id < $2 AND m.created_at >= $3 ORDER BY m.id DESC LIMIT $4"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(key)
        .bind(q.before.unwrap_or(i64::MAX))
        .bind(min_ts.unwrap_or(i64::MIN))
        .bind(q.limit.unwrap_or(LIST_PAGE).clamp(1, LIST_MAX))
        .fetch_all(db)
        .await?;
    let mut msgs = rows_messages(db, &rows).await?;
    msgs.reverse();
    attach_embeds(db, &mut msgs).await?;
    Ok(msgs)
}

pub(crate) async fn recent_channel_messages(
    db: &Db,
    channel_id: i64,
    limit: i64,
) -> Result<Vec<Message>, ApiError> {
    page(
        db,
        "m.channel_id = $1 AND m.thread_root_id IS NULL",
        channel_id,
        &PageQuery {
            before: None,
            limit: Some(limit),
        },
        None,
    )
    .await
}

async fn claim_media(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    id: &str,
    username: &str,
    spoiler: bool,
) -> Result<MediaRef, ApiError> {
    let claimed = sqlx::query(
        "UPDATE media SET uploader = $1 WHERE id = $2 AND (uploader IS NULL OR uploader = $1)",
    )
    .bind(username)
    .bind(id)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    let row = sqlx::query("SELECT filename, uploaded_at FROM media WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    let (filename, uploaded_at): (String, i64) = match &row {
        Some(r) => (r.try_get(0)?, r.try_get(1)?),
        None => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Unknown media".to_string(),
            ));
        }
    };
    if claimed == 0 {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "You can only attach files you uploaded".to_string(),
        ));
    }
    let attached =
        sqlx::query("SELECT 1 FROM messages WHERE media_id = $1 AND media_kind = 'server'")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .is_some();
    if attached {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "This file is already attached to a message".to_string(),
        ));
    }
    Ok(MediaRef::server(
        id.to_string(),
        filename,
        spoiler,
        uploaded_at + MEDIA_TTL_SECS,
    ))
}

async fn insert_message(
    db: &Db,
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    thread_root_id: Option<i64>,
    user: &User,
    req: SendReq,
) -> Result<Message, ApiError> {
    let SendReq {
        content,
        media_id,
        media_spoiler,
        p2p,
    } = req;
    check_len(&content, MESSAGE_MAX, "Message")?;
    let spoiler = media_spoiler.unwrap_or(false);
    let mut tx = db.begin().await?;
    let media = match (&media_id, p2p) {
        (Some(_), Some(_)) => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Choose server or P2P attachment, not both".to_string(),
            ));
        }
        (Some(id), None) => Some(claim_media(&mut tx, id, &user.username, spoiler).await?),
        (None, Some(p2p)) => {
            let P2pAttachment {
                filename,
                size,
                mime,
                p2p_id,
                expires_in_seconds,
            } = p2p;
            let valid_id = p2p_id.len() == 32 && p2p_id.chars().all(|c| c.is_ascii_hexdigit());
            if !valid_id {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    "Invalid p2p_id".to_string(),
                ));
            }
            if size < 0 || expires_in_seconds.is_some_and(|s| s <= 0) {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    "Invalid P2P attachment".to_string(),
                ));
            }
            Some(MediaRef {
                id: p2p_id,
                filename,
                kind: MediaKind::P2p,
                hoster: Some(user.username.clone()),
                expires_at: expires_in_seconds.map(|s| now() + s),
                size: Some(size),
                mime: Some(mime),
                removed: false,
                removed_by_author: false,
                spoiler,
            })
        }
        (None, None) => None,
    };
    if content.trim().is_empty() && media.is_none() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Message is empty".to_string(),
        ));
    }
    let t = now();
    let id: i64 = sqlx::query(
        "INSERT INTO messages(channel_id, dm_id, thread_root_id, author, content, media_id, media_filename, media_removed, media_spoiler, media_kind, media_hoster, media_expires_at, media_size, media_mime, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13, $14) RETURNING id",
    )
    .bind(channel_id)
    .bind(dm_id)
    .bind(thread_root_id)
    .bind(&user.username)
    .bind(&content)
    .bind(media.as_ref().map(|m| m.id.clone()))
    .bind(media.as_ref().map(|m| m.filename.clone()))
    .bind(spoiler as i64)
    .bind(media.as_ref().map_or(MediaKind::Server, |m| m.kind).as_str())
    .bind(media.as_ref().and_then(|m| m.hoster.clone()))
    .bind(media.as_ref().and_then(|m| m.expires_at))
    .bind(media.as_ref().and_then(|m| m.size))
    .bind(media.as_ref().and_then(|m| m.mime.clone()))
    .bind(t)
    .fetch_one(&mut *tx)
    .await?
    .try_get(0)?;
    tx.commit().await?;
    Ok(Message {
        id,
        channel_id,
        dm_id,
        thread_root_id,
        author: UserRef::from_user(user),
        content,
        created_at: t,
        reply_count: 0,
        media,
        embeds: Vec::new(),
        kind: "user".to_string(),
        call: None,
    })
}

async fn channel_server(db: &Db, id: i64) -> Result<String, ApiError> {
    let row = sqlx::query("SELECT server FROM channels WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    match row {
        Some(r) => Ok(r.try_get(0)?),
        None => Err(ApiError(
            StatusCode::NOT_FOUND,
            "Channel not found".to_string(),
        )),
    }
}

async fn dm_users(db: &Db, id: i64) -> Result<Vec<String>, ApiError> {
    let row = sqlx::query("SELECT user_a, user_b FROM dms WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    match row {
        Some(r) => Ok(vec![r.try_get(0)?, r.try_get(1)?]),
        None => Err(ApiError(StatusCode::NOT_FOUND, "DM not found".to_string())),
    }
}

async fn require_member(db: &Db, server: &str, username: &str) -> Result<(), ApiError> {
    let member = sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
        .bind(server)
        .bind(username)
        .fetch_optional(db)
        .await?;
    match member {
        Some(_) => Ok(()),
        None => Err(ApiError(StatusCode::FORBIDDEN, "Not a member".to_string())),
    }
}

async fn thread_root_channel(db: &Db, id: i64) -> Result<i64, ApiError> {
    let row = sqlx::query("SELECT channel_id, thread_root_id FROM messages WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    let (channel_id, root): (Option<i64>, Option<i64>) = match &row {
        Some(r) => (r.try_get(0)?, r.try_get(1)?),
        None => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "Message not found".to_string(),
            ));
        }
    };
    match (channel_id, root) {
        (Some(cid), None) => Ok(cid),
        (_, _) => Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Threads only start on channel messages".to_string(),
        )),
    }
}

async fn read_gate(
    db: &Db,
    headers: &HeaderMap,
    channel_id: i64,
    user: Option<&User>,
) -> Result<Option<i64>, ApiError> {
    let server = channel_server(db, channel_id).await?;
    let lite = crate::api::servers::require_server(db, &server).await?;
    require_server_view(db, headers, &lite, user).await?;
    let ChannelAccess {
        view,
        send: _,
        history,
    } = channel_access(db, &server, channel_id, user).await?;
    if !view {
        return Err(ApiError(StatusCode::FORBIDDEN, "Not allowed".to_string()));
    }
    match history {
        true => Ok(None),
        false => {
            let user = match user {
                Some(u) => u,
                None => return Ok(Some(now())),
            };
            let row =
                sqlx::query("SELECT joined_at FROM members WHERE server = $1 AND username = $2")
                    .bind(&server)
                    .bind(&user.username)
                    .fetch_optional(db)
                    .await?;
            match &row {
                Some(r) => Ok(Some(r.try_get(0)?)),
                None => Ok(Some(now())),
            }
        }
    }
}

async fn send_gate(db: &Db, server: &str, channel_id: i64, user: &User) -> Result<(), ApiError> {
    let row = sqlx::query("SELECT kind, slowmode_seconds FROM channels WHERE id = $1")
        .bind(channel_id)
        .fetch_one(db)
        .await?;
    if ChannelKind::parse(&row.try_get::<String, _>(0)?)? == ChannelKind::Voice {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Voice channels cannot receive messages".to_string(),
        ));
    }
    let ChannelAccess {
        view: _,
        send,
        history: _,
    } = channel_access(db, server, channel_id, Some(user)).await?;
    if !send {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "No permission to send in this channel".to_string(),
        ));
    }
    let slow: i64 = row.try_get(1)?;
    if slow <= 0 {
        return Ok(());
    }
    let exempt = effective_perms(db, server, user).await?
        & (Perm::ManageChannels as i64 | Perm::DeleteMessages as i64)
        != 0;
    if exempt {
        return Ok(());
    }
    let last: Option<i64> =
        sqlx::query("SELECT MAX(created_at) FROM messages WHERE channel_id = $1 AND author = $2")
            .bind(channel_id)
            .bind(&user.username)
            .fetch_one(db)
            .await?
            .try_get(0)?;
    match last {
        Some(t) if now() - t < slow => Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            format!("Slow mode: wait {}s", slow - (now() - t)),
        )),
        _ => Ok(()),
    }
}

#[utoipa::path(get, path = "/api/channels/{id}/messages", params(("id" = i64, Path), PageQuery), responses((status = 200, description = "Up to `limit` (default 50) top-level messages before `before`, oldest first; without read-history access only messages since joining are returned", body = Vec<Message>)), security((), ("bearer" = [])))]
pub(crate) async fn channel_messages(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    require_guest_ok(&state.db, user.as_ref()).await?;
    let min_ts = read_gate(&state.db, &headers, id, user.as_ref()).await?;
    Ok(Json(
        page(
            &state.db,
            "m.channel_id = $1 AND m.thread_root_id IS NULL",
            id,
            &q,
            min_ts,
        )
        .await?,
    ))
}

#[utoipa::path(post, path = "/api/channels/{id}/messages", params(("id" = i64, Path)), request_body = SendReq, responses((status = 200, description = "The posted message; link previews arrive later as an `EmbedsResolved` WebSocket event", body = Message)), security(("bearer" = [])))]
pub(crate) async fn send_channel_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<SendReq>,
) -> Result<Json<Message>, ApiError> {
    check_profanity(&state.db, &req.content).await?;
    let server = channel_server(&state.db, id).await?;
    require_member(&state.db, &server, &user.username).await?;
    send_gate(&state.db, &server, id, &user).await?;
    let message = insert_message(&state.db, Some(id), None, None, &user, req).await?;
    touch_interaction(&state.db, &server, &user.username).await?;
    embeds::spawn_unfurl(
        &state,
        Some(server.clone()),
        Some(id),
        None,
        None,
        message.id,
        &message.content,
    );
    state.hub.broadcast(WsEvent::Message {
        server: Some(server),
        channel_id: Some(id),
        dm_id: None,
        dm_users: None,
        message: Box::new(message.clone()),
    });
    Ok(Json(message))
}

#[utoipa::path(get, path = "/api/messages/{id}/thread", params(("id" = i64, Path), PageQuery), responses((status = 200, description = "Up to `limit` (default 50) thread replies before `before`, oldest first", body = Vec<Message>)), security((), ("bearer" = [])))]
pub(crate) async fn thread_messages(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    require_guest_ok(&state.db, user.as_ref()).await?;
    let channel_id = thread_root_channel(&state.db, id).await?;
    let min_ts = read_gate(&state.db, &headers, channel_id, user.as_ref()).await?;
    Ok(Json(
        page(&state.db, "m.thread_root_id = $1", id, &q, min_ts).await?,
    ))
}

#[utoipa::path(post, path = "/api/messages/{id}/thread", params(("id" = i64, Path)), request_body = SendReq, responses((status = 200, description = "The posted thread reply; link previews arrive later as an `EmbedsResolved` WebSocket event", body = Message)), security(("bearer" = [])))]
pub(crate) async fn send_thread_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<SendReq>,
) -> Result<Json<Message>, ApiError> {
    let channel_id = thread_root_channel(&state.db, id).await?;
    check_profanity(&state.db, &req.content).await?;
    let server = channel_server(&state.db, channel_id).await?;
    require_member(&state.db, &server, &user.username).await?;
    send_gate(&state.db, &server, channel_id, &user).await?;
    let message = insert_message(&state.db, Some(channel_id), None, Some(id), &user, req).await?;
    touch_interaction(&state.db, &server, &user.username).await?;
    embeds::spawn_unfurl(
        &state,
        Some(server.clone()),
        Some(channel_id),
        None,
        None,
        message.id,
        &message.content,
    );
    state.hub.broadcast(WsEvent::Message {
        server: Some(server),
        channel_id: Some(channel_id),
        dm_id: None,
        dm_users: None,
        message: Box::new(message.clone()),
    });
    Ok(Json(message))
}

#[utoipa::path(get, path = "/api/dms/{id}/messages", params(("id" = i64, Path), PageQuery), responses((status = 200, description = "Up to `limit` (default 50) DM messages before `before`, oldest first", body = Vec<Message>)), security(("bearer" = [])))]
pub(crate) async fn dm_messages(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Query(q): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let users = dm_users(&state.db, id).await?;
    if !users.contains(&user.username) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Not a participant".to_string(),
        ));
    }
    Ok(Json(page(&state.db, "m.dm_id = $1", id, &q, None).await?))
}

#[utoipa::path(post, path = "/api/dms/{id}/messages", params(("id" = i64, Path)), request_body = SendReq, responses((status = 200, description = "The posted DM message; link previews arrive later as an `EmbedsResolved` WebSocket event", body = Message)), security(("bearer" = [])))]
pub(crate) async fn send_dm_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<SendReq>,
) -> Result<Json<Message>, ApiError> {
    let users = dm_users(&state.db, id).await?;
    if !users.contains(&user.username) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Not a participant".to_string(),
        ));
    }
    let message = insert_message(&state.db, None, Some(id), None, &user, req).await?;
    embeds::spawn_unfurl(
        &state,
        None,
        None,
        Some(id),
        Some(users.clone()),
        message.id,
        &message.content,
    );
    state.hub.broadcast(WsEvent::Message {
        server: None,
        channel_id: None,
        dm_id: Some(id),
        dm_users: Some(users),
        message: Box::new(message.clone()),
    });
    Ok(Json(message))
}

pub(crate) struct MsgScope {
    pub channel_id: Option<i64>,
    pub dm_id: Option<i64>,
    pub thread_root_id: Option<i64>,
    pub author: String,
    pub media_id: Option<String>,
    pub media_filename: Option<String>,
    pub media_kind: MediaKind,
    pub server: Option<String>,
    pub dm_users: Option<Vec<String>>,
}

pub(crate) async fn message_scope(db: &Db, id: i64) -> Result<MsgScope, ApiError> {
    let row = sqlx::query(
        "SELECT channel_id, dm_id, thread_root_id, author, media_id, media_filename, media_kind FROM messages WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let r = match &row {
        Some(r) => r,
        None => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "Message not found".to_string(),
            ));
        }
    };
    let channel_id: Option<i64> = r.try_get(0)?;
    let dm_id: Option<i64> = r.try_get(1)?;
    let thread_root_id: Option<i64> = r.try_get(2)?;
    let author: String = r.try_get(3)?;
    let media_id: Option<String> = r.try_get(4)?;
    let media_filename: Option<String> = r.try_get(5)?;
    let media_kind = MediaKind::parse(&r.try_get::<String, _>(6)?)?;
    let (server, dm_users) = match (channel_id, dm_id) {
        (Some(cid), _) => (Some(channel_server(db, cid).await?), None),
        (None, Some(did)) => (None, Some(dm_users(db, did).await?)),
        (None, None) => (None, None),
    };
    Ok(MsgScope {
        channel_id,
        dm_id,
        thread_root_id,
        author,
        media_id,
        media_filename,
        media_kind,
        server,
        dm_users,
    })
}

pub(crate) async fn require_can_delete(
    db: &Db,
    user: &User,
    scope: &MsgScope,
) -> Result<(), ApiError> {
    let allowed = scope.author == user.username
        || match &scope.server {
            Some(server) => has_perm(db, server, user, Perm::DeleteMessages).await,
            None => false,
        };
    match allowed {
        true => Ok(()),
        false => Err(ApiError(StatusCode::FORBIDDEN, "Not allowed".to_string())),
    }
}

#[utoipa::path(delete, path = "/api/messages/{id}", params(("id" = i64, Path)), responses((status = 200, description = "Deleted")), security(("bearer" = [])))]
pub(crate) async fn delete_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<serde_json::Value>, ApiError> {
    let scope = message_scope(&state.db, id).await?;
    require_can_delete(&state.db, &user, &scope).await?;
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    let MsgScope {
        channel_id,
        dm_id,
        thread_root_id,
        author: _,
        media_id: _,
        media_filename: _,
        media_kind: _,
        server,
        dm_users,
    } = scope;
    state.hub.broadcast(WsEvent::MessageDeleted {
        server,
        channel_id,
        dm_id,
        dm_users,
        id,
        thread_root_id,
    });
    Ok(Json(serde_json::json!({ "ok": true })))
}

enum Bind {
    S(String),
    I(i64),
}

const SEARCH_PAGE: i64 = 25;
const FTS_MIN_CHARS: usize = 3;

fn fts_phrase(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

#[utoipa::path(get, path = "/api/search", params(SearchQuery), responses((status = 200, description = "Up to 25 messages from channels the caller can view whose content contains `q` (case-insensitive), newest first; `before`/`after` bound the message id (pass the oldest returned id as `before` for the next page) and `before_ts`/`after_ts` bound `created_at` (exclusive, unix seconds)", body = Vec<SearchResult>)), security((), ("bearer" = [])))]
pub(crate) async fn search(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Query(sq): Query<SearchQuery>,
) -> Result<Json<Vec<SearchResult>>, ApiError> {
    require_guest_ok(&state.db, user.as_ref()).await?;
    let (sql, binds) = match search_sql(&state.db, user.as_ref(), &headers, sq).await? {
        Some(built) => built,
        None => return Ok(Json(Vec::new())),
    };
    let rows = bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
        .fetch_all(&state.db)
        .await?;
    let mut msgs = rows_messages(&state.db, &rows).await?;
    let mut ctx: Vec<(String, String)> = Vec::with_capacity(rows.len());
    for r in &rows {
        ctx.push((r.try_get(21)?, r.try_get(22)?));
    }
    attach_embeds(&state.db, &mut msgs).await?;
    let out = msgs
        .into_iter()
        .zip(ctx)
        .map(|(message, (server, channel_name))| SearchResult {
            message,
            server,
            channel_name,
        })
        .collect();
    Ok(Json(out))
}

fn bind_all<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments>,
    binds: &'q [Bind],
) -> sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments> {
    for b in binds {
        query = match b {
            Bind::S(s) => query.bind(s),
            Bind::I(i) => query.bind(*i),
        };
    }
    query
}

async fn search_sql(
    db: &Db,
    user: Option<&User>,
    headers: &HeaderMap,
    sq: SearchQuery,
) -> Result<Option<(String, Vec<Bind>)>, ApiError> {
    let SearchQuery {
        q,
        server,
        channel_id,
        from,
        has,
        before,
        after,
        before_ts,
        after_ts,
        offset,
        servers,
    } = sq;
    let mut conds: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    match user {
        Some(u) => {
            binds.push(Bind::S(u.username.clone()));
            conds.push(format!(
                "c.server IN (SELECT server FROM members WHERE username = ${})",
                binds.len()
            ));
            if !u.is_site_admin {
                let mut subjects = vec![format!("u:{}", u.username)];
                let role_rows = sqlx::query("SELECT role_id FROM user_roles WHERE username = $1")
                    .bind(&u.username)
                    .fetch_all(db)
                    .await?;
                for r in &role_rows {
                    subjects.push(format!("r:{}", r.try_get::<i64, _>(0)?));
                }
                let mut ph = Vec::with_capacity(subjects.len());
                for subject in subjects {
                    binds.push(Bind::S(subject));
                    ph.push(format!("${}", binds.len()));
                }
                conds.push(format!(
                    "(NOT EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id) OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id AND cp.can_view != 0 AND cp.subject IN ({})))",
                    ph.join(", ")
                ));
                conds.push(format!(
                    "(NOT EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id) OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id AND cp.can_read_history != 0 AND cp.subject IN ({})) OR m.created_at >= (SELECT joined_at FROM members mm WHERE mm.server = c.server AND mm.username = $1))",
                    ph.join(", ")
                ));
            }
        }
        None => {
            conds.push(
                "NOT EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id)"
                    .to_string(),
            );
            let grants = header_grants(headers);
            match grants.is_empty() {
                true => conds.push(
                    "c.server IN (SELECT name FROM servers WHERE password_hash IS NULL)"
                        .to_string(),
                ),
                false => {
                    let mut ph = Vec::with_capacity(grants.len());
                    for grant in grants {
                        binds.push(Bind::S(grant));
                        ph.push(format!("${}", binds.len()));
                    }
                    conds.push(format!(
                        "(c.server IN (SELECT name FROM servers WHERE password_hash IS NULL) OR c.server IN (SELECT server FROM guest_grants WHERE \"grant\" IN ({})))",
                        ph.join(", ")
                    ));
                }
            }
            let names: Vec<String> = servers
                .as_deref()
                .unwrap_or("")
                .split(',')
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect();
            if names.is_empty() {
                return Ok(None);
            }
            let mut ph = Vec::with_capacity(names.len());
            for name in names {
                binds.push(Bind::S(name));
                ph.push(format!("${}", binds.len()));
            }
            conds.push(format!("c.server IN ({})", ph.join(", ")));
        }
    }
    if let Some(text) = q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        match text.chars().count() >= FTS_MIN_CHARS && !text.contains('\0') && has_fts(db).await {
            true => {
                binds.push(Bind::S(fts_phrase(text)));
                binds.push(Bind::I(before.unwrap_or(i64::MAX)));
                conds.push(format!(
                    "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${} AND rowid < ${})",
                    binds.len() - 1,
                    binds.len()
                ));
            }
            false => {
                binds.push(Bind::S(like_pattern(text, false)));
                conds.push(format!(
                    "lower(m.content) LIKE lower(${}) ESCAPE '\\'",
                    binds.len()
                ));
            }
        }
    }
    if let Some(s) = server {
        binds.push(Bind::S(s.to_lowercase()));
        conds.push(format!("c.server = ${}", binds.len()));
    }
    if let Some(cid) = channel_id {
        binds.push(Bind::I(cid));
        conds.push(format!("m.channel_id = ${}", binds.len()));
    }
    if let Some(author) = from {
        binds.push(Bind::S(author.to_lowercase()));
        conds.push(format!("m.author = ${}", binds.len()));
    }
    if has.as_deref() == Some("file") {
        conds.push("m.media_id IS NOT NULL".to_string());
    }
    if let Some(b) = before {
        binds.push(Bind::I(b));
        conds.push(format!("m.id < ${}", binds.len()));
    }
    if let Some(a) = after {
        binds.push(Bind::I(a));
        conds.push(format!("m.id > ${}", binds.len()));
    }
    if let Some(t) = before_ts {
        binds.push(Bind::I(t));
        conds.push(format!("m.created_at < ${}", binds.len()));
    }
    if let Some(t) = after_ts {
        binds.push(Bind::I(t));
        conds.push(format!("m.created_at > ${}", binds.len()));
    }
    let skip = match offset {
        Some(n) if n > 0 => {
            binds.push(Bind::I(n));
            format!(" OFFSET ${}", binds.len())
        }
        _ => String::new(),
    };
    let sql = format!(
        "SELECT {COLS}, c.server, c.name FROM messages m CROSS JOIN channels c WHERE c.id = m.channel_id AND {} ORDER BY m.id DESC LIMIT {SEARCH_PAGE}{skip}",
        conds.join(" AND ")
    );
    Ok(Some((sql, binds)))
}

async fn restricted_access(db: &Db, user: &User) -> Result<HashMap<i64, ChannelAccess>, ApiError> {
    let rows = sqlx::query(
        "SELECT cp.channel_id, c.server, cp.subject, cp.can_view, cp.can_send, cp.can_read_history FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id JOIN members mem ON mem.server = c.server AND mem.username = $1 WHERE c.kind = 'text'",
    )
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(HashMap::new());
    }
    let mut subjects = vec![format!("u:{}", user.username)];
    let role_rows = sqlx::query("SELECT role_id FROM user_roles WHERE username = $1")
        .bind(&user.username)
        .fetch_all(db)
        .await?;
    for r in &role_rows {
        subjects.push(format!("r:{}", r.try_get::<i64, _>(0)?));
    }
    let mut restricted: HashMap<i64, (String, ChannelAccess)> = HashMap::new();
    for r in &rows {
        let (id, server, subject): (i64, String, String) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        let entry = restricted
            .entry(id)
            .or_insert_with(|| (server, ChannelAccess::all(false)));
        if subjects.contains(&subject) {
            entry.1.view |= r.try_get::<i64, _>(3)? != 0;
            entry.1.send |= r.try_get::<i64, _>(4)? != 0;
            entry.1.history |= r.try_get::<i64, _>(5)? != 0;
        }
    }
    let mut manages: HashMap<String, bool> = HashMap::new();
    let mut out = HashMap::with_capacity(restricted.len());
    for (id, (server, acc)) in restricted {
        let ChannelAccess {
            view,
            send,
            history,
        } = acc;
        let can_manage = match (view && send && history, manages.get(&server)) {
            (true, _) => false,
            (false, Some(m)) => *m,
            (false, None) => {
                let m =
                    effective_perms(db, &server, user).await? & Perm::ManageChannels as i64 != 0;
                manages.insert(server, m);
                m
            }
        };
        let access = match (can_manage, view) {
            (true, _) => ChannelAccess::all(true),
            (false, true) => acc,
            (false, false) => ChannelAccess::all(false),
        };
        out.insert(id, access);
    }
    Ok(out)
}

#[utoipa::path(get, path = "/api/unreads", responses((status = 200, description = "Latest top-level and last-read message ids for each text channel the caller can view (with its server) and each DM, skipping ones without messages", body = Unreads)), security(("bearer" = [])))]
pub(crate) async fn unreads(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Unreads>, ApiError> {
    let db = &state.db;
    let restricted = restricted_access(db, &user).await?;
    let channel_rows = sqlx::query(
        "SELECT x.id, x.server, x.latest, (SELECT lm.created_at FROM messages lm WHERE lm.id = x.latest), x.last_read, x.joined_at FROM (SELECT c.id, c.server, (SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id AND m.thread_root_id IS NULL) AS latest, COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'c' || c.id), 0) AS last_read, mem.joined_at FROM channels c JOIN members mem ON mem.server = c.server AND mem.username = $1 WHERE c.kind = 'text') x",
    )
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    let dm_rows = sqlx::query(
        "SELECT d.id, (SELECT MAX(m.id) FROM messages m WHERE m.dm_id = d.id), COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'd' || d.id), 0) FROM dms d WHERE d.user_a = $1 OR d.user_b = $1",
    )
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    let mut items = Vec::with_capacity(channel_rows.len() + dm_rows.len());
    for r in &channel_rows {
        let id: i64 = r.try_get(0)?;
        let (latest, latest_at): (Option<i64>, Option<i64>) = (r.try_get(2)?, r.try_get(3)?);
        let joined_at: i64 = r.try_get(5)?;
        let readable = match restricted.get(&id) {
            None => true,
            Some(ChannelAccess {
                view,
                send: _,
                history,
            }) => *view && (*history || latest_at.is_some_and(|t| t >= joined_at)),
        };
        if let (Some(latest), true) = (latest, readable) {
            items.push(Unread {
                scope: format!("c{id}"),
                server: Some(r.try_get(1)?),
                last_read: r.try_get(4)?,
                latest,
            });
        }
    }
    for r in &dm_rows {
        let id: i64 = r.try_get(0)?;
        if let Some(latest) = r.try_get::<Option<i64>, _>(1)? {
            items.push(Unread {
                scope: format!("d{id}"),
                server: None,
                last_read: r.try_get(2)?,
                latest,
            });
        }
    }
    Ok(Json(Unreads { items }))
}

#[utoipa::path(post, path = "/api/read", request_body = ReadReq, responses((status = 200, description = "The stored read position, which never moves backwards", body = ReadState)), security(("bearer" = [])))]
pub(crate) async fn mark_read(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<ReadReq>,
) -> Result<Json<ReadState>, ApiError> {
    let ReadReq { scope, last_read } = req;
    if !valid_scope(&scope) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid scope".to_string(),
        ));
    }
    let stored: i64 = sqlx::query(
        "INSERT INTO read_state(username, scope, last_read) VALUES($1, $2, $3) ON CONFLICT(username, scope) DO UPDATE SET last_read = CASE WHEN excluded.last_read > read_state.last_read THEN excluded.last_read ELSE read_state.last_read END RETURNING last_read",
    )
    .bind(&user.username)
    .bind(&scope)
    .bind(last_read)
    .fetch_one(&state.db)
    .await?
    .try_get(0)?;
    state.hub.broadcast(WsEvent::ReadUpdated {
        username: user.username,
        scope: scope.clone(),
        last_read: stored,
    });
    Ok(Json(ReadState {
        scope,
        last_read: stored,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};

    async fn general_id(db: &Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id")
    }

    async fn send(state: &AppState, cid: i64, name: &str) -> Result<Json<Message>, ApiError> {
        send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user(name, false)),
            Json(SendReq {
                content: "hello".to_string(),
                media_id: None,
                media_spoiler: None,
                p2p: None,
            }),
        )
        .await
    }

    async fn list(
        state: &AppState,
        cid: i64,
        user: Option<&str>,
    ) -> Result<Vec<Message>, ApiError> {
        channel_messages(
            State(state.clone()),
            MaybeAuthed(user.map(|name| mem_user(name, false))),
            HeaderMap::new(),
            Path(cid),
            Query(PageQuery {
                before: None,
                limit: None,
            }),
        )
        .await
        .map(|r| r.0)
    }

    async fn send_with(
        state: &AppState,
        cid: i64,
        name: &str,
        content: String,
        media_id: Option<&str>,
    ) -> Result<Json<Message>, ApiError> {
        send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user(name, false)),
            Json(SendReq {
                content,
                media_id: media_id.map(str::to_string),
                media_spoiler: None,
                p2p: None,
            }),
        )
        .await
    }

    async fn add_media(db: &Db, id: &str, uploader: Option<&str>) {
        sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES($1, 'a.txt', 'text/plain', 1, $2, $3, $4)")
            .bind(id)
            .bind(vec![0u8])
            .bind(uploader)
            .bind(now())
            .execute(db)
            .await
            .expect("insert media");
    }

    #[tokio::test]
    async fn message_length_limit() {
        let (state, path) = temp_state("msg_len").await;
        let cid = general_id(&state.db).await;
        add_member(&state.db, "rchat", "alice", 0, 0, now()).await;
        let ok = send_with(&state, cid, "alice", "😀".repeat(MESSAGE_MAX), None).await;
        assert_eq!(
            ok.expect("4000 emoji ok").0.content.chars().count(),
            MESSAGE_MAX
        );
        let long = send_with(&state, cid, "alice", "a".repeat(MESSAGE_MAX + 1), None).await;
        assert!(matches!(long, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'alice') RETURNING id")
                .fetch_one(&state.db)
                .await
                .expect("insert dm")
                .try_get(0)
                .expect("dm id");
        let dm_long = send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            Json(SendReq {
                content: "a".repeat(MESSAGE_MAX + 1),
                media_id: None,
                media_spoiler: None,
                p2p: None,
            }),
        )
        .await;
        assert!(matches!(dm_long, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        done(state, path).await;
    }

    #[tokio::test]
    async fn media_single_use() {
        let (state, path) = temp_state("media_once").await;
        let cid = general_id(&state.db).await;
        add_member(&state.db, "rchat", "alice", 0, 0, now()).await;
        add_member(&state.db, "rchat", "bob", 0, 0, now()).await;
        let owned = "aa".repeat(16);
        add_media(&state.db, &owned, Some("alice")).await;
        let stolen = send_with(&state, cid, "bob", String::new(), Some(&owned)).await;
        assert!(matches!(stolen, Err(ApiError(StatusCode::FORBIDDEN, _))));
        let first = send_with(&state, cid, "alice", String::new(), Some(&owned))
            .await
            .expect("owner attaches")
            .0;
        assert_eq!(first.media.map(|m| m.id), Some(owned.clone()));
        let reuse = send_with(&state, cid, "alice", String::new(), Some(&owned)).await;
        assert!(matches!(reuse, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        let legacy = "bb".repeat(16);
        add_media(&state.db, &legacy, None).await;
        let _ = send_with(&state, cid, "bob", String::new(), Some(&legacy))
            .await
            .expect("legacy upload attachable once");
        let other = send_with(&state, cid, "alice", String::new(), Some(&legacy)).await;
        assert!(matches!(other, Err(ApiError(StatusCode::FORBIDDEN, _))));
        let again = send_with(&state, cid, "bob", String::new(), Some(&legacy)).await;
        assert!(matches!(again, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        let unknown = send_with(&state, cid, "bob", String::new(), Some(&"cc".repeat(16))).await;
        assert!(matches!(unknown, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        let count: i64 = sqlx::query("SELECT COUNT(*) FROM messages WHERE media_id IS NOT NULL")
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value");
        assert_eq!(count, 2);
        done(state, path).await;
    }

    #[tokio::test]
    async fn slowmode_gap() {
        let (state, path) = temp_state("slowmode").await;
        let cid = general_id(&state.db).await;
        sqlx::query("UPDATE channels SET slowmode_seconds = 60 WHERE id = $1")
            .bind(cid)
            .execute(&state.db)
            .await
            .expect("set slowmode");
        add_member(&state.db, "rchat", "alice", 0, 0, now()).await;
        add_member(&state.db, "rchat", "boss", 1, 0, now()).await;
        let _ = send(&state, cid, "alice").await.expect("first send");
        let second = send(&state, cid, "alice").await;
        match second {
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, msg)) => {
                assert!(msg.starts_with("Slow mode"))
            }
            _ => panic!("expected slow mode rejection"),
        }
        let _ = send(&state, cid, "boss").await.expect("admin send 1");
        let _ = send(&state, cid, "boss").await.expect("admin send 2");
        done(state, path).await;
    }

    #[tokio::test]
    async fn private_channel_history() {
        let (state, path) = temp_state("history").await;
        let cid = general_id(&state.db).await;
        let joined = now() - 1000;
        add_member(&state.db, "rchat", "alice", 0, 0, joined).await;
        for (content, at) in [("before", joined - 500), ("after", joined + 500)] {
            sqlx::query(
                "INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', $2, $3)",
            )
            .bind(cid)
            .bind(content)
            .bind(at)
            .execute(&state.db)
            .await
            .expect("insert message");
        }
        sqlx::query(
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 0)",
        )
        .bind(cid)
        .execute(&state.db)
        .await
        .expect("insert perm");
        let visible = list(&state, cid, Some("alice")).await.expect("alice list");
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].content, "after");
        let bob = list(&state, cid, Some("bob")).await;
        assert!(matches!(bob, Err(ApiError(StatusCode::FORBIDDEN, _))));
        let guest = list(&state, cid, None).await;
        assert!(matches!(guest, Err(ApiError(StatusCode::FORBIDDEN, _))));
        let found = search(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("alice", false))),
            HeaderMap::new(),
            Query(query(None)),
        )
        .await
        .expect("search")
        .0;
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message.content, "after");
        done(state, path).await;
    }

    fn query(q: Option<&str>) -> SearchQuery {
        SearchQuery {
            q: q.map(str::to_string),
            server: None,
            channel_id: None,
            from: None,
            has: None,
            before: None,
            after: None,
            before_ts: None,
            after_ts: None,
            offset: None,
            servers: None,
        }
    }

    async fn add_user(db: &Db, name: &str, display: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, avatar_color, created_at) VALUES($1, $2, '', 'text', 'identicon', NULL, $3)")
            .bind(name)
            .bind(display)
            .bind(now())
            .execute(db)
            .await
            .expect("insert user");
    }

    async fn insert(
        db: &Db,
        cid: Option<i64>,
        dm: Option<i64>,
        root: Option<i64>,
        author: &str,
    ) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, dm_id, thread_root_id, author, content, created_at) VALUES($1, $2, $3, $4, 'x', $5) RETURNING id")
            .bind(cid)
            .bind(dm)
            .bind(root)
            .bind(author)
            .bind(now())
            .fetch_one(db)
            .await
            .expect("insert message")
            .try_get(0)
            .expect("message id")
    }

    async fn add_channel(db: &Db, name: &str, kind: &str) -> i64 {
        sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', $1, $2, 0) RETURNING id")
            .bind(name)
            .bind(kind)
            .fetch_one(db)
            .await
            .expect("insert channel")
            .try_get(0)
            .expect("channel id")
    }

    async fn perm(db: &Db, cid: i64, subject: &str, view: i64) {
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, $3, 1, 1)")
            .bind(cid)
            .bind(subject)
            .bind(view)
            .execute(db)
            .await
            .expect("insert perm");
    }

    #[tokio::test]
    async fn pages_batch_authors_and_clamp() {
        let (state, path) = temp_state("page_batch").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_user(db, "alice", "Alice A").await;
        add_user(db, "bob", "Bob B").await;
        let mut ids = Vec::new();
        for n in 0..150 {
            let author = ["alice", "bob", "ghost"][n % 3];
            ids.push(insert(db, Some(cid), None, None, author).await);
        }
        let root = ids[0];
        for author in ["bob", "ghost"] {
            insert(db, Some(cid), None, Some(root), author).await;
        }
        let get = |before: Option<i64>, limit: Option<i64>| {
            let state = state.clone();
            async move {
                channel_messages(
                    State(state),
                    MaybeAuthed(None),
                    HeaderMap::new(),
                    Path(cid),
                    Query(PageQuery { before, limit }),
                )
                .await
                .expect("page")
                .0
            }
        };
        let latest = get(None, None).await;
        assert_eq!(latest.len(), 50);
        assert_eq!(latest.last().map(|m| m.id), ids.last().copied());
        assert!(latest.windows(2).all(|w| w[0].id < w[1].id));
        assert_eq!(get(None, Some(500)).await.len(), 100);
        assert_eq!(get(None, Some(0)).await.len(), 1);
        let tail = get(Some(ids[40]), None).await;
        assert_eq!(tail.len(), 40);
        assert_eq!(tail[0].id, root);
        assert_eq!(tail[0].reply_count, 2);
        let names: HashMap<String, String> = latest
            .iter()
            .map(|m| (m.author.username.clone(), m.author.display_name.clone()))
            .collect();
        assert_eq!(names["alice"], "Alice A");
        assert_eq!(names["bob"], "Bob B");
        assert_eq!(names["ghost"], "ghost");
        let thread = thread_messages(
            State(state.clone()),
            MaybeAuthed(None),
            HeaderMap::new(),
            Path(root),
            Query(PageQuery {
                before: None,
                limit: None,
            }),
        )
        .await
        .expect("thread")
        .0;
        let authors: Vec<&str> = thread
            .iter()
            .map(|m| m.author.display_name.as_str())
            .collect();
        assert_eq!(authors, ["Bob B", "ghost"]);
        let loaded = load_message(db, ids[1])
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(loaded.author.display_name, "Bob B");
        assert!(load_message(db, i64::MAX).await.expect("load").is_none());
        done(state, path).await;
    }

    async fn unread_map(
        state: &AppState,
        name: &str,
    ) -> HashMap<String, (Option<String>, i64, i64)> {
        unreads(State(state.clone()), Authed(mem_user(name, false)))
            .await
            .expect("unreads")
            .0
            .items
            .into_iter()
            .map(|u| (u.scope, (u.server, u.latest, u.last_read)))
            .collect()
    }

    #[tokio::test]
    async fn unreads_respect_visibility() {
        let (state, path) = temp_state("unread_vis").await;
        let db = &state.db;
        let general = general_id(db).await;
        let private = add_channel(db, "private", "text").await;
        let roled = add_channel(db, "roled", "text").await;
        let empty = add_channel(db, "empty", "text").await;
        let voice = add_channel(db, "voice", "voice").await;
        let t = now();
        for (name, admin, perms) in [
            ("alice", 0, 0),
            ("bob", 0, 0),
            ("mod", 1, Perm::ManageChannels as i64),
            ("kicker", 1, Perm::Kick as i64),
        ] {
            add_member(db, "rchat", name, admin, perms, t).await;
        }
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'r', '#ffffff', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'bob', $1)")
            .bind(role)
            .execute(db)
            .await
            .expect("assign role");
        perm(db, private, "u:alice", 0).await;
        perm(db, private, "u:bob", 1).await;
        perm(db, roled, &format!("r:{role}"), 1).await;
        perm(db, empty, "u:alice", 0).await;
        let nohist = add_channel(db, "nohist", "text").await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 0)")
            .bind(nohist)
            .execute(db)
            .await
            .expect("no history perm");
        let at = |when: i64| {
            sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'bob', 'x', $2) RETURNING id")
                .bind(nohist)
                .bind(when)
        };
        let before_join: i64 = at(t - 10)
            .fetch_one(db)
            .await
            .expect("old message")
            .try_get(0)
            .expect("old id");
        let g = insert(db, Some(general), None, None, "bob").await;
        let reply = insert(db, Some(general), None, Some(g), "bob").await;
        let p = insert(db, Some(private), None, None, "bob").await;
        let r = insert(db, Some(roled), None, None, "bob").await;
        insert(db, Some(voice), None, None, "bob").await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        let call: i64 = sqlx::query("INSERT INTO messages(dm_id, author, content, kind, created_at) VALUES($1, 'bob', '', 'call', $2) RETURNING id")
            .bind(dm)
            .bind(t)
            .fetch_one(db)
            .await
            .expect("call log")
            .try_get(0)
            .expect("call id");
        sqlx::query("INSERT INTO read_state(username, scope, last_read) VALUES('alice', $1, $2)")
            .bind(format!("c{general}"))
            .bind(g)
            .execute(db)
            .await
            .expect("read state");
        assert!(reply > g);
        let alice = unread_map(&state, "alice").await;
        let rchat = Some("rchat".to_string());
        assert_eq!(alice.len(), 2);
        assert_eq!(alice[&format!("c{general}")], (rchat.clone(), g, g));
        assert_eq!(alice[&format!("d{dm}")], (None, call, 0));
        let bob = unread_map(&state, "bob").await;
        assert_eq!(bob[&format!("c{private}")], (rchat.clone(), p, 0));
        assert_eq!(bob[&format!("c{roled}")], (rchat.clone(), r, 0));
        assert_eq!(bob.len(), 4);
        let moderator = unread_map(&state, "mod").await;
        assert!(moderator.contains_key(&format!("c{private}")));
        assert!(moderator.contains_key(&format!("c{roled}")));
        assert!(!moderator.contains_key(&format!("c{empty}")));
        assert!(!moderator.contains_key(&format!("c{voice}")));
        assert_eq!(
            moderator[&format!("c{nohist}")],
            (rchat.clone(), before_join, 0)
        );
        let outsider = unread_map(&state, "zed").await;
        assert!(outsider.is_empty());
        let after_join: i64 = at(t + 10)
            .fetch_one(db)
            .await
            .expect("new message")
            .try_get(0)
            .expect("new id");
        let alice = unread_map(&state, "alice").await;
        assert_eq!(alice[&format!("c{nohist}")], (rchat.clone(), after_join, 0));
        assert!(
            !unread_map(&state, "bob")
                .await
                .contains_key(&format!("c{nohist}"))
        );
        for name in ["alice", "bob", "mod", "kicker"] {
            let user = mem_user(name, false);
            let restricted = restricted_access(db, &user).await.expect("restricted");
            let open = ChannelAccess::all(true);
            for cid in [general, private, roled, empty, nohist] {
                let want = channel_access(db, "rchat", cid, Some(&user))
                    .await
                    .expect("access");
                let got = restricted.get(&cid).unwrap_or(&open);
                assert_eq!(
                    (got.view, got.send, got.history),
                    (want.view, want.send, want.history),
                    "{name} channel {cid}"
                );
            }
        }
        done(state, path).await;
    }

    async fn post(db: &Db, cid: i64, author: &str, content: &str, at: i64) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, $2, $3, $4) RETURNING id")
            .bind(cid)
            .bind(author)
            .bind(content)
            .bind(at)
            .fetch_one(db)
            .await
            .expect("insert message")
            .try_get(0)
            .expect("message id")
    }

    async fn found(
        state: &AppState,
        user: Option<User>,
        headers: HeaderMap,
        sq: SearchQuery,
    ) -> Vec<i64> {
        search(State(state.clone()), MaybeAuthed(user), headers, Query(sq))
            .await
            .expect("search")
            .0
            .iter()
            .map(|r| r.message.id)
            .collect()
    }

    async fn drop_fts(db: &Db) {
        for stmt in [
            "DROP TRIGGER messages_fts_insert",
            "DROP TRIGGER messages_fts_delete",
            "DROP TRIGGER messages_fts_update",
            "DROP TABLE messages_fts",
        ] {
            sqlx::query(stmt).execute(db).await.expect("drop fts");
        }
    }

    async fn fts_ok(db: &Db) {
        sqlx::query("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)")
            .execute(db)
            .await
            .expect("fts index matches messages");
    }

    async fn fts_hits(db: &Db, phrase: &str) -> i64 {
        sqlx::query("SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH $1")
            .bind(fts_phrase(phrase))
            .fetch_one(db)
            .await
            .expect("fts count")
            .try_get(0)
            .expect("count value")
    }

    async fn seed(db: &Db, cid: i64, count: i64) {
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $2) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, 'alice', CASE WHEN i % 50 = 0 THEN 'find the needle ' || i ELSE 'plain hay ' || i END, i FROM n")
            .bind(cid)
            .bind(count)
            .execute(db)
            .await
            .expect("seed messages");
    }

    #[tokio::test]
    async fn search_substring_and_wildcards() {
        let (state, path) = temp_state("search_substr").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        let t = now();
        let hello = post(db, cid, "alice", "Hello World", t).await;
        let shout = post(db, cid, "alice", "say HELLO again", t).await;
        let pct = post(db, cid, "alice", "100% sure", t).await;
        let snake = post(db, cid, "alice", "snake_case name", t).await;
        let slash = post(db, cid, "alice", r"back\slash", t).await;
        let quoted = post(db, cid, "alice", r#"she said "hi there" twice"#, t).await;
        post(db, cid, "alice", "unrelated", t).await;
        let cases: Vec<(&str, Vec<i64>)> = vec![
            ("hello", vec![shout, hello]),
            ("HeLLo", vec![shout, hello]),
            ("  lo wo ", vec![hello]),
            ("lo", vec![shout, hello]),
            ("O", vec![shout, hello]),
            ("%", vec![pct]),
            ("_", vec![snake]),
            ("0%", vec![pct]),
            ("e_c", vec![snake]),
            ("%%%", vec![]),
            (r"\", vec![slash]),
            (r"k\s", vec![slash]),
            (r#""hi"#, vec![quoted]),
            (r#""hi there""#, vec![quoted]),
            ("hi there", vec![quoted]),
            ("zzz", vec![]),
        ];
        for fts in [true, false] {
            assert_eq!(has_fts(db).await, fts);
            for (q, want) in &cases {
                let got = found(
                    &state,
                    Some(mem_user("alice", false)),
                    HeaderMap::new(),
                    query(Some(q)),
                )
                .await;
                assert_eq!(&got, want, "q={q:?} fts={fts}");
            }
            found(
                &state,
                Some(mem_user("alice", false)),
                HeaderMap::new(),
                query(Some("hel\0lo")),
            )
            .await;
            if fts {
                drop_fts(db).await;
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_respects_visibility() {
        let (state, path) = temp_state("search_vis").await;
        let db = &state.db;
        let t = now();
        for (name, password) in [("locked", Some("x")), ("other", None)] {
            sqlx::query("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES($1, $1, $2, 0)")
                .bind(name)
                .bind(password)
                .execute(db)
                .await
                .expect("insert server");
        }
        let general = general_id(db).await;
        let private = add_channel(db, "private", "text").await;
        let roled = add_channel(db, "roled", "text").await;
        let history = add_channel(db, "history", "text").await;
        let mut ids = HashMap::new();
        for (server, name) in [("locked", "vault"), ("other", "lobby")] {
            let cid: i64 = sqlx::query(
                "INSERT INTO channels(server, name, created_at) VALUES($1, $2, 0) RETURNING id",
            )
            .bind(server)
            .bind(name)
            .fetch_one(db)
            .await
            .expect("insert channel")
            .try_get(0)
            .expect("channel id");
            ids.insert(name, post(db, cid, "bob", "a needle here", t).await);
        }
        for (server, name) in [
            ("rchat", "alice"),
            ("rchat", "bob"),
            ("rchat", "root"),
            ("locked", "alice"),
        ] {
            add_member(db, server, name, 0, 0, t).await;
        }
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'r', '#ffffff', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query(
            "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'alice', $1)",
        )
        .bind(role)
        .execute(db)
        .await
        .expect("assign role");
        perm(db, private, "u:bob", 1).await;
        perm(db, roled, &format!("r:{role}"), 1).await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 0)")
            .bind(history)
            .execute(db)
            .await
            .expect("history perm");
        sqlx::query(
            "INSERT INTO guest_grants(\"grant\", server, created_at) VALUES('g1', 'locked', 0)",
        )
        .execute(db)
        .await
        .expect("grant");
        ids.insert("general", post(db, general, "bob", "the needle", t).await);
        ids.insert("private", post(db, private, "bob", "needle!", t).await);
        ids.insert("roled", post(db, roled, "bob", "NEEDLE", t).await);
        ids.insert("old", post(db, history, "bob", "old needle", t - 100).await);
        ids.insert("new", post(db, history, "bob", "new needle", t + 100).await);
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        sqlx::query("INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'bob', 'dm needle', $2)")
            .bind(dm)
            .bind(t)
            .execute(db)
            .await
            .expect("dm message");
        let grant = |value: &str| {
            let mut h = HeaderMap::new();
            h.insert("x-guest-grant", value.parse().expect("header"));
            h
        };
        let expect = |names: &[&str]| {
            let mut want: Vec<i64> = names.iter().map(|n| ids[n]).collect();
            want.sort_by(|a, b| b.cmp(a));
            want
        };
        for q in [Some("needle"), Some("ee"), None] {
            let guest = |servers: Option<&str>| {
                let mut sq = query(q);
                sq.servers = servers.map(str::to_string);
                sq
            };
            let cases: Vec<(Option<User>, HeaderMap, SearchQuery, Vec<i64>)> = vec![
                (
                    Some(mem_user("alice", false)),
                    HeaderMap::new(),
                    query(q),
                    expect(&["general", "roled", "new", "vault"]),
                ),
                (
                    Some(mem_user("bob", false)),
                    HeaderMap::new(),
                    query(q),
                    expect(&["general", "private"]),
                ),
                (
                    Some(mem_user("root", true)),
                    HeaderMap::new(),
                    query(q),
                    expect(&["general", "private", "roled", "old", "new"]),
                ),
                (
                    Some(mem_user("zed", false)),
                    HeaderMap::new(),
                    query(q),
                    Vec::new(),
                ),
                (
                    None,
                    HeaderMap::new(),
                    guest(Some("rchat,locked,other")),
                    expect(&["general", "lobby"]),
                ),
                (
                    None,
                    grant("g1"),
                    guest(Some("rchat, LOCKED")),
                    expect(&["general", "vault"]),
                ),
                (None, grant("nope"), guest(Some("locked")), Vec::new()),
                (None, grant("g1"), guest(None), Vec::new()),
            ];
            for (n, (user, headers, sq, want)) in cases.into_iter().enumerate() {
                let got = found(&state, user, headers, sq).await;
                assert_eq!(got, want, "case {n} q={q:?}");
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_keyset_pages_and_dates() {
        let (state, path) = temp_state("search_pages").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        seed(db, cid, 6000).await;
        let alice = || Some(mem_user("alice", false));
        for q in ["needle", "ne", "NeEdLe"] {
            let all: Vec<i64> = sqlx::query(
                "SELECT id FROM messages WHERE lower(content) LIKE $1 ORDER BY id DESC",
            )
            .bind(format!("%{}%", q.to_lowercase()))
            .fetch_all(db)
            .await
            .expect("expected ids")
            .iter()
            .map(|r| r.try_get(0).expect("id"))
            .collect();
            assert!(all.len() > 50, "q={q}");
            let mut seen: Vec<i64> = Vec::new();
            let mut before = None;
            loop {
                let mut sq = query(Some(q));
                sq.before = before;
                let page = found(&state, alice(), HeaderMap::new(), sq).await;
                assert!(page.len() <= 25);
                assert!(page.windows(2).all(|w| w[0] > w[1]), "q={q}");
                if let (Some(last), Some(first)) = (seen.last(), page.first()) {
                    assert!(last > first, "pages overlap for q={q}");
                }
                seen.extend(&page);
                match page.len() {
                    25 => before = page.last().copied(),
                    _ => break,
                }
            }
            assert_eq!(seen, all, "q={q}");
            let mut legacy = query(Some(q));
            legacy.offset = Some(25);
            assert_eq!(
                found(&state, alice(), HeaderMap::new(), legacy).await,
                all[25..50]
            );
        }
        let window = |before_ts: Option<i64>, after_ts: Option<i64>, q: Option<&str>| {
            let mut sq = query(q);
            sq.before_ts = before_ts;
            sq.after_ts = after_ts;
            sq
        };
        let cases: Vec<(SearchQuery, Vec<i64>)> = vec![
            (window(Some(150), Some(50), Some("needle")), vec![100]),
            (window(Some(150), Some(100), Some("needle")), vec![]),
            (window(Some(100), Some(0), Some("needle")), vec![50]),
            (window(Some(51), None, Some("ne")), vec![50]),
            (window(None, Some(5949), Some("needle")), vec![6000, 5950]),
            (window(Some(4), None, None), vec![3, 2, 1]),
            (window(Some(3), Some(1), None), vec![2]),
        ];
        for (n, (sq, want)) in cases.into_iter().enumerate() {
            assert_eq!(
                found(&state, alice(), HeaderMap::new(), sq).await,
                want,
                "case {n}"
            );
        }
        let mut sq = window(Some(5000), Some(1000), Some("needle"));
        sq.before = Some(2001);
        let page = found(&state, alice(), HeaderMap::new(), sq).await;
        assert_eq!(page.len(), 20);
        assert_eq!(page.first(), Some(&2000));
        assert_eq!(page.last(), Some(&1050));
        done(state, path).await;
    }

    async fn plan(db: &Db, user: &User, sq: SearchQuery) -> String {
        let (sql, binds) = search_sql(db, Some(user), &HeaderMap::new(), sq)
            .await
            .expect("search sql")
            .expect("built");
        let explain = format!("EXPLAIN QUERY PLAN {sql}");
        bind_all(sqlx::query(sqlx::AssertSqlSafe(explain)), &binds)
            .fetch_all(db)
            .await
            .expect("explain")
            .iter()
            .map(|r| r.try_get::<String, _>(3).expect("detail"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tokio::test]
    async fn search_plans_use_indexes() {
        let (state, path) = temp_state("search_plan").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        seed(db, cid, 5000).await;
        let alice = mem_user("alice", false);
        let fts = plan(db, &alice, query(Some("needle"))).await;
        assert!(fts.contains("SCAN messages_fts VIRTUAL TABLE"), "{fts}");
        assert!(
            fts.contains("SEARCH m USING INTEGER PRIMARY KEY (rowid=?)"),
            "{fts}"
        );
        let mut paged = query(Some("needle"));
        paged.before = Some(3000);
        paged.from = Some("alice".to_string());
        paged.channel_id = Some(cid);
        paged.before_ts = Some(4000);
        let filtered = plan(db, &alice, paged).await;
        assert!(
            filtered.contains("SCAN messages_fts VIRTUAL TABLE"),
            "{filtered}"
        );
        let mut short = query(Some("ne"));
        short.before = Some(3000);
        let like = plan(db, &alice, short).await;
        assert!(
            like.contains("SEARCH m USING INTEGER PRIMARY KEY (rowid<?)"),
            "{like}"
        );
        let mut dated = query(None);
        dated.after_ts = Some(10);
        let browse = plan(db, &alice, dated).await;
        assert!(browse.contains("SCAN m"), "{browse}");
        for detail in [fts, filtered, like, browse] {
            assert!(!detail.contains("TEMP B-TREE"), "{detail}");
            assert!(!detail.contains("SCAN c"), "{detail}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_index_tracks_edits_and_deletes() {
        let (state, path) = temp_state("search_sync").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        let sent = send_with(&state, cid, "alice", "alpha beta".to_string(), None)
            .await
            .expect("send")
            .0
            .id;
        let alice = || Some(mem_user("alice", false));
        let hits = |q: &str| found(&state, alice(), HeaderMap::new(), query(Some(q)));
        assert_eq!(hits("beta").await, vec![sent]);
        sqlx::query("UPDATE messages SET content = 'gamma delta' WHERE id = $1")
            .bind(sent)
            .execute(db)
            .await
            .expect("edit");
        assert_eq!(hits("beta").await, Vec::<i64>::new());
        assert_eq!(hits("delta").await, vec![sent]);
        assert_eq!(fts_hits(db, "beta").await, 0);
        sqlx::query("UPDATE messages SET media_removed = 1 WHERE id = $1")
            .bind(sent)
            .execute(db)
            .await
            .expect("unrelated update");
        assert_eq!(hits("delta").await, vec![sent]);
        fts_ok(db).await;
        let root = post(db, cid, "alice", "root delta", 1).await;
        sqlx::query("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES($1, $2, 'alice', 'reply delta', 2)")
            .bind(cid)
            .bind(root)
            .execute(db)
            .await
            .expect("reply");
        assert_eq!(fts_hits(db, "delta").await, 3);
        let _ = delete_message(
            State(state.clone()),
            Path(sent),
            Authed(mem_user("alice", false)),
        )
        .await
        .expect("delete");
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(root)
            .execute(db)
            .await
            .expect("delete root");
        assert_eq!(fts_hits(db, "delta").await, 0);
        assert_eq!(hits("delta").await, Vec::<i64>::new());
        let doomed = add_channel(db, "doomed", "text").await;
        post(db, doomed, "alice", "epsilon", 3).await;
        assert_eq!(fts_hits(db, "epsilon").await, 1);
        sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(doomed)
            .execute(db)
            .await
            .expect("delete channel");
        assert_eq!(fts_hits(db, "epsilon").await, 0);
        fts_ok(db).await;
        done(state, path).await;
    }

    fn reopened(db: Db) -> AppState {
        AppState {
            db,
            hub: crate::ws::Hub::new(),
            s3: None,
        }
    }

    #[tokio::test]
    async fn search_index_backfills_existing_db() {
        let (state, path) = temp_state("search_backfill").await;
        let cid = general_id(&state.db).await;
        add_member(&state.db, "rchat", "alice", 0, 0, 0).await;
        drop_fts(&state.db).await;
        seed(&state.db, cid, 500).await;
        let alice = || Some(mem_user("alice", false));
        let like = found(&state, alice(), HeaderMap::new(), query(Some("needle"))).await;
        assert_eq!(like.len(), 10);
        state.db.close().await;
        for _ in 0..2 {
            let state = reopened(crate::db::open(path.to_str()).await.expect("reopen"));
            assert!(has_fts(&state.db).await);
            assert_eq!(fts_hits(&state.db, "needle").await, 10);
            fts_ok(&state.db).await;
            let got = found(&state, alice(), HeaderMap::new(), query(Some("needle"))).await;
            assert_eq!(got, like);
            state.db.close().await;
        }
        let state = reopened(crate::db::open(path.to_str()).await.expect("reopen"));
        done(state, path).await;
    }
}
