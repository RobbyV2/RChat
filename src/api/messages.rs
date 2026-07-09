use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use crate::api::{
    ApiError, Authed, Embed, MaybeAuthed, MediaRef, Message, UserRef, check_profanity, embeds,
    header_grants, require_guest_ok, require_server_view, user_ref,
};
use crate::db::{
    ChannelAccess, ChannelKind, Db, MediaKind, Perm, User, channel_access, effective_perms,
    has_perm, now, touch_interaction,
};
use crate::state::AppState;
use crate::ws::WsEvent;

const COLS: &str = "m.id, m.channel_id, m.dm_id, m.thread_root_id, m.author, m.content, m.media_id, m.media_filename, m.media_removed, m.media_spoiler, m.created_at, (SELECT COUNT(*) FROM messages r WHERE r.thread_root_id = m.id), m.media_kind, m.media_hoster, m.media_expires_at, m.media_size, m.media_mime";

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

async fn row_message(db: &Db, r: &AnyRow) -> Result<Message, ApiError> {
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
    Ok(Message {
        id: r.try_get(0)?,
        channel_id: r.try_get(1)?,
        dm_id: r.try_get(2)?,
        thread_root_id: r.try_get(3)?,
        author: user_ref(db, &r.try_get::<String, _>(4)?).await,
        content: r.try_get(5)?,
        created_at: r.try_get(10)?,
        reply_count: r.try_get(11)?,
        media,
        embeds: Vec::new(),
    })
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
    let mut query = sqlx::query(&sql);
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
    let rows = sqlx::query(&sql)
        .bind(key)
        .bind(q.before.unwrap_or(i64::MAX))
        .bind(min_ts.unwrap_or(i64::MIN))
        .bind(q.limit.unwrap_or(50))
        .fetch_all(db)
        .await?;
    let mut msgs = Vec::with_capacity(rows.len());
    for r in &rows {
        msgs.push(row_message(db, r).await?);
    }
    msgs.reverse();
    attach_embeds(db, &mut msgs).await?;
    Ok(msgs)
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
    let spoiler = media_spoiler.unwrap_or(false);
    let media = match (&media_id, p2p) {
        (Some(_), Some(_)) => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Choose server or P2P attachment, not both".to_string(),
            ));
        }
        (Some(id), None) => {
            let row = sqlx::query("SELECT filename FROM media WHERE id = $1")
                .bind(id)
                .fetch_optional(db)
                .await?;
            match row {
                Some(r) => Some(MediaRef::server(id.clone(), r.try_get(0)?, spoiler)),
                None => {
                    return Err(ApiError(
                        StatusCode::BAD_REQUEST,
                        "Unknown media".to_string(),
                    ));
                }
            }
        }
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
    .fetch_one(db)
    .await?
    .try_get(0)?;
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

#[utoipa::path(get, path = "/api/channels/{id}/messages", params(("id" = i64, Path), PageQuery), responses((status = 200, body = Vec<Message>)), security((), ("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/channels/{id}/messages", params(("id" = i64, Path)), request_body = SendReq, responses((status = 200, body = Message)), security(("bearer" = [])))]
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

#[utoipa::path(get, path = "/api/messages/{id}/thread", params(("id" = i64, Path), PageQuery), responses((status = 200, body = Vec<Message>)), security((), ("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/messages/{id}/thread", params(("id" = i64, Path)), request_body = SendReq, responses((status = 200, body = Message)), security(("bearer" = [])))]
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

#[utoipa::path(get, path = "/api/dms/{id}/messages", params(("id" = i64, Path), PageQuery), responses((status = 200, body = Vec<Message>)), security(("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/dms/{id}/messages", params(("id" = i64, Path)), request_body = SendReq, responses((status = 200, body = Message)), security(("bearer" = [])))]
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

#[utoipa::path(get, path = "/api/search", params(SearchQuery), responses((status = 200, body = Vec<SearchResult>)), security((), ("bearer" = [])))]
pub(crate) async fn search(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Query(sq): Query<SearchQuery>,
) -> Result<Json<Vec<SearchResult>>, ApiError> {
    require_guest_ok(&state.db, user.as_ref()).await?;
    let SearchQuery {
        q,
        server,
        channel_id,
        from,
        has,
        before,
        after,
        offset,
        servers,
    } = sq;
    let mut conds: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    match &user {
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
                    .fetch_all(&state.db)
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
            let grants = header_grants(&headers);
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
                return Ok(Json(Vec::new()));
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
        binds.push(Bind::S(format!("%{}%", text.to_lowercase())));
        conds.push(format!("lower(m.content) LIKE ${}", binds.len()));
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
    binds.push(Bind::I(offset.unwrap_or(0).max(0)));
    let sql = format!(
        "SELECT {COLS}, c.server, c.name FROM messages m JOIN channels c ON c.id = m.channel_id WHERE {} ORDER BY m.id DESC LIMIT 25 OFFSET ${}",
        conds.join(" AND "),
        binds.len()
    );
    let mut query = sqlx::query(&sql);
    for b in &binds {
        query = match b {
            Bind::S(s) => query.bind(s),
            Bind::I(i) => query.bind(*i),
        };
    }
    let rows = query.fetch_all(&state.db).await?;
    let mut msgs = Vec::with_capacity(rows.len());
    let mut ctx: Vec<(String, String)> = Vec::with_capacity(rows.len());
    for r in &rows {
        msgs.push(row_message(&state.db, r).await?);
        ctx.push((r.try_get(17)?, r.try_get(18)?));
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

#[utoipa::path(get, path = "/api/unreads", responses((status = 200, body = Unreads)), security(("bearer" = [])))]
pub(crate) async fn unreads(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Unreads>, ApiError> {
    let mut items = Vec::new();
    let channel_rows = sqlx::query(
        "SELECT 'c' || m.channel_id AS scope, MAX(m.id) AS latest, COALESCE(MAX(rs.last_read), 0) AS last_read FROM messages m JOIN channels c ON c.id = m.channel_id JOIN members mem ON mem.server = c.server AND mem.username = $1 LEFT JOIN read_state rs ON rs.username = $1 AND rs.scope = 'c' || m.channel_id WHERE c.kind = 'text' AND m.thread_root_id IS NULL GROUP BY m.channel_id",
    )
    .bind(&user.username)
    .fetch_all(&state.db)
    .await?;
    let dm_rows = sqlx::query(
        "SELECT 'd' || m.dm_id AS scope, MAX(m.id) AS latest, COALESCE(MAX(rs.last_read), 0) AS last_read FROM messages m JOIN dms d ON d.id = m.dm_id LEFT JOIN read_state rs ON rs.username = $1 AND rs.scope = 'd' || m.dm_id WHERE d.user_a = $1 OR d.user_b = $1 GROUP BY m.dm_id",
    )
    .bind(&user.username)
    .fetch_all(&state.db)
    .await?;
    for r in channel_rows.iter().chain(dm_rows.iter()) {
        items.push(Unread {
            scope: r.try_get(0)?,
            latest: r.try_get(1)?,
            last_read: r.try_get(2)?,
        });
    }
    Ok(Json(Unreads { items }))
}

#[utoipa::path(post, path = "/api/read", request_body = ReadReq, responses((status = 200, body = ReadState)), security(("bearer" = [])))]
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
            Query(SearchQuery {
                q: None,
                server: None,
                channel_id: None,
                from: None,
                has: None,
                before: None,
                after: None,
                offset: None,
                servers: None,
            }),
        )
        .await
        .expect("search")
        .0;
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message.content, "after");
        done(state, path).await;
    }
}
