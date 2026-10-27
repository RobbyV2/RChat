use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use crate::api::admin::like_pattern;
use crate::api::{
    ApiError, Authed, CallLog, Embed, LIST_MAX, LIST_PAGE, MESSAGE_MAX, MaybeAuthed, MediaRef,
    Message, Paged, ProfanityTarget, Settings, UserRef, check_len, check_profanity, cursor_int,
    decode_cursor, embeds, encode_cursor, header_grants, media::MEDIA_TTL_SECS, require_guest_ok,
    require_server_view, unique_capped, user_from, user_refs,
};
use crate::db::{
    ChannelAccess, ChannelKind, Db, LIVE_AUTHOR, LIVE_DM, MediaKind, Perm, PermRow, User,
    channel_access, channel_manager_servers, effective_perms, fold_access, has_fts, has_perm,
    is_sqlite, manages_channels, now, perm_row, perm_subjects, touch_interaction,
};
use crate::state::AppState;
use crate::ws::WsEvent;

const COLS: &str = "m.id, m.channel_id, m.dm_id, m.thread_root_id, m.author, m.content, m.media_id, m.media_filename, m.media_removed, m.media_spoiler, m.created_at, (SELECT COUNT(*) FROM messages r WHERE r.thread_root_id = m.id), m.media_kind, m.media_hoster, m.media_expires_at, m.media_size, m.media_mime, m.kind, m.call_answered_at, m.call_ended_at, m.call_outcome";

#[derive(Clone, Copy, Deserialize, IntoParams)]
pub struct PageQuery {
    before: Option<i64>,
    after: Option<i64>,
    around: Option<i64>,
    limit: Option<i64>,
}

#[derive(Clone, Copy)]
enum Span {
    Before,
    From,
    After,
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

#[derive(Clone, Default, IntoParams)]
#[into_params(parameter_in = Query)]
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
    cursor: Option<String>,
    servers: Option<Vec<String>>,
}

impl SearchQuery {
    fn parse(raw: &str) -> Result<SearchQuery, ApiError> {
        let int = |v: &str| {
            v.parse::<i64>()
                .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid number".to_string()))
        };
        let mut sq = SearchQuery::default();
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "q" => sq.q = Some(value.into_owned()),
                "server" => sq.server = Some(value.into_owned()),
                "channel_id" => sq.channel_id = Some(int(&value)?),
                "from" => sq.from = Some(value.into_owned()),
                "has" => sq.has = Some(value.into_owned()),
                "before" => sq.before = Some(int(&value)?),
                "after" => sq.after = Some(int(&value)?),
                "before_ts" => sq.before_ts = Some(int(&value)?),
                "after_ts" => sq.after_ts = Some(int(&value)?),
                "offset" => sq.offset = Some(int(&value)?),
                "cursor" if !value.trim().is_empty() => sq.cursor = Some(value.into_owned()),
                "servers" => sq
                    .servers
                    .get_or_insert_with(Vec::new)
                    .push(value.into_owned()),
                _ => {}
            }
        }
        Ok(sq)
    }
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
    pub more: bool,
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
    let sql = format!("SELECT {COLS} FROM messages m WHERE m.id = $1 AND {LIVE_AUTHOR}");
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_all(db)
        .await?;
    Ok(rows_messages(db, &rows).await?.pop())
}

pub(crate) async fn load_message_with_embeds(
    db: &Db,
    id: i64,
) -> Result<Option<Message>, ApiError> {
    let Some(message) = load_message(db, id).await? else {
        return Ok(None);
    };
    let mut msgs = [message];
    attach_embeds(db, &mut msgs).await?;
    let [message] = msgs;
    Ok(Some(message))
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

async fn slice(
    db: &Db,
    cond: &str,
    key: i64,
    span: Span,
    edge: i64,
    min_ts: Option<i64>,
    limit: i64,
) -> Result<Vec<Message>, ApiError> {
    let (bound, order) = match span {
        Span::Before => ("m.id < $2", "DESC"),
        Span::From => ("m.id >= $2", "ASC"),
        Span::After => ("m.id > $2", "ASC"),
    };
    let sql = format!(
        "SELECT {COLS} FROM messages m WHERE {cond} AND {bound} AND m.created_at >= $3 AND {LIVE_AUTHOR} ORDER BY m.id {order} LIMIT $4"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(key)
        .bind(edge)
        .bind(min_ts.unwrap_or(i64::MIN))
        .bind(limit)
        .fetch_all(db)
        .await?;
    let mut msgs = rows_messages(db, &rows).await?;
    if let Span::Before = span {
        msgs.reverse();
    }
    Ok(msgs)
}

async fn page(
    db: &Db,
    cond: &str,
    key: i64,
    q: &PageQuery,
    min_ts: Option<i64>,
) -> Result<Vec<Message>, ApiError> {
    let PageQuery {
        before,
        after,
        around,
        limit,
    } = *q;
    let limit = limit.unwrap_or(LIST_PAGE).clamp(1, LIST_MAX);
    let mut msgs = match (around, after) {
        (Some(id), _) => {
            let older = limit / 2;
            let mut out = match older {
                0 => Vec::new(),
                n => slice(db, cond, key, Span::Before, id, min_ts, n).await?,
            };
            out.extend(slice(db, cond, key, Span::From, id, min_ts, limit - older).await?);
            out
        }
        (None, Some(id)) => slice(db, cond, key, Span::After, id, min_ts, limit).await?,
        (None, None) => {
            let edge = before.unwrap_or(i64::MAX);
            slice(db, cond, key, Span::Before, edge, min_ts, limit).await?
        }
    };
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
            after: None,
            around: None,
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
    let settings = match channel_id {
        Some(_) => Some(Settings::cached(db).await),
        None => None,
    };
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
    if let (Some(settings), Some(media)) = (&settings, &media) {
        settings.check_profanity(ProfanityTarget::FileNames, &media.filename)?;
    }
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
    dm_pair(db, id, "SELECT user_a, user_b FROM dms WHERE id = $1").await
}

async fn live_dm_users(db: &Db, id: i64) -> Result<Vec<String>, ApiError> {
    let sql = format!("SELECT user_a, user_b FROM dms WHERE id = $1 AND {LIVE_DM}");
    dm_pair(db, id, &sql).await
}

async fn dm_pair(db: &Db, id: i64, sql: &str) -> Result<Vec<String>, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?;
    match row {
        Some(r) => Ok(vec![r.try_get(0)?, r.try_get(1)?]),
        None => Err(ApiError(StatusCode::NOT_FOUND, "DM not found".to_string())),
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

async fn send_gate(db: &Db, channel_id: i64, user: &User) -> Result<String, ApiError> {
    let row = sqlx::query(
        "SELECT c.server, c.kind, c.slowmode_seconds, (SELECT COUNT(*) FROM members m WHERE m.server = c.server AND m.username = $2) FROM channels c WHERE c.id = $1",
    )
    .bind(channel_id)
    .bind(&user.username)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Channel not found".to_string()))?;
    let server: String = row.try_get(0)?;
    if row.try_get::<i64, _>(3)? == 0 {
        return Err(ApiError(StatusCode::FORBIDDEN, "Not a member".to_string()));
    }
    let server = server.as_str();
    if ChannelKind::parse(&row.try_get::<String, _>(1)?)? == ChannelKind::Voice {
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
    let slow: i64 = row.try_get(2)?;
    if slow <= 0 {
        return Ok(server.to_string());
    }
    let exempt = effective_perms(db, server, user).await?
        & (Perm::ManageChannels as i64 | Perm::DeleteMessages as i64)
        != 0;
    if exempt {
        return Ok(server.to_string());
    }
    let last: Option<i64> = sqlx::query(
        "SELECT created_at FROM messages WHERE channel_id = $1 AND author = $2 ORDER BY id DESC LIMIT 1",
    )
    .bind(channel_id)
    .bind(&user.username)
    .fetch_optional(db)
    .await?
    .map(|r| r.try_get(0))
    .transpose()?;
    match last {
        Some(t) if now() - t < slow => Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            format!("Slow mode: wait {}s", slow - (now() - t)),
        )),
        _ => Ok(server.to_string()),
    }
}

#[utoipa::path(get, path = "/api/channels/{id}/messages", params(("id" = i64, Path), PageQuery), responses((status = 200, description = "Up to `limit` (default 50, max 100) top-level messages, oldest first: the newest ones before `before` (or the latest), or with `after` the oldest ones after that id, or with `around` a window of `limit / 2` messages before that id followed by the message itself and newer ones (`around` wins over `after`, which wins over `before`); without read-history access only messages since joining are returned", body = Vec<Message>)), security((), ("bearer" = [])))]
pub(crate) async fn channel_messages(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    let min_ts = read_gate(db, &headers, id, user.as_ref()).await?;
    Ok(Json(
        page(
            db,
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
    check_profanity(&state.db, ProfanityTarget::Messages, &req.content).await?;
    let server = send_gate(&state.db, id, &user).await?;
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

#[utoipa::path(get, path = "/api/messages/{id}/thread", params(("id" = i64, Path), PageQuery), responses((status = 200, description = "Up to `limit` (default 50, max 100) thread replies, oldest first, paged with `before`, `after` or `around` like channel messages", body = Vec<Message>)), security((), ("bearer" = [])))]
pub(crate) async fn thread_messages(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    let channel_id = thread_root_channel(db, id).await?;
    let min_ts = read_gate(db, &headers, channel_id, user.as_ref()).await?;
    Ok(Json(
        page(db, "m.thread_root_id = $1", id, &q, min_ts).await?,
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
    check_profanity(&state.db, ProfanityTarget::Messages, &req.content).await?;
    let server = send_gate(&state.db, channel_id, &user).await?;
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

#[utoipa::path(get, path = "/api/dms/{id}/messages", params(("id" = i64, Path), PageQuery), responses((status = 200, description = "Up to `limit` (default 50, max 100) DM messages, oldest first, paged with `before`, `after` or `around` like channel messages", body = Vec<Message>)), security(("bearer" = [])))]
pub(crate) async fn dm_messages(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Query(q): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let db = &state.read();
    let users = live_dm_users(db, id).await?;
    if !users.contains(&user.username) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Not a participant".to_string(),
        ));
    }
    Ok(Json(page(db, "m.dm_id = $1", id, &q, None).await?))
}

#[utoipa::path(post, path = "/api/dms/{id}/messages", params(("id" = i64, Path)), request_body = SendReq, responses((status = 200, description = "The posted DM message; link previews arrive later as an `EmbedsResolved` WebSocket event", body = Message)), security(("bearer" = [])))]
pub(crate) async fn send_dm_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<SendReq>,
) -> Result<Json<Message>, ApiError> {
    let users = live_dm_users(&state.db, id).await?;
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
    let sql = format!(
        "SELECT m.channel_id, m.dm_id, m.thread_root_id, m.author, m.media_id, m.media_filename, m.media_kind FROM messages m WHERE m.id = $1 AND {LIVE_AUTHOR}"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
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

const SEARCH_OFFSET_MAX: i64 = 500;
const SEARCH_WINDOW: i64 = 4096;
const LIKE_BUDGET: i64 = 250_000;
const FTS_BATCH: i64 = 500;
const FTS_ROUNDS: usize = 8;

#[utoipa::path(get, path = "/api/search", params(SearchQuery), responses((status = 200, description = "Up to 25 messages from channels the caller can view whose content contains `q` (case-insensitive), newest first; `before`/`after` bound the message id and `before_ts`/`after_ts` bound `created_at` (exclusive, unix seconds). When more results may follow, the `X-Next-Cursor` response header holds a `cursor` for the next page (it is absent once the search reached the oldest message); a page can hold fewer than 25 results and still have a next cursor. Passing the oldest returned id as `before` also works when the page is full. The legacy `offset` is capped at 500. Guests pass the servers to search as repeated `servers` params (`servers=a&servers=b`, max 100)", body = Vec<SearchResult>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid number or cursor, or text containing a NUL character")), security((), ("bearer" = [])))]
pub(crate) async fn search(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Result<Paged<SearchResult>, ApiError> {
    let sq = SearchQuery::parse(raw.as_deref().unwrap_or(""))?;
    let (results, next) = search_paged(&state, user.as_ref(), &headers, sq).await?;
    Ok(Paged(
        results,
        next.map(|id| encode_cursor(&[&id.to_string()])),
    ))
}

#[cfg(test)]
async fn search_with(
    state: &AppState,
    user: Option<&User>,
    headers: &HeaderMap,
    sq: SearchQuery,
) -> Result<Vec<SearchResult>, ApiError> {
    Ok(search_paged(state, user, headers, sq).await?.0)
}

async fn search_paged(
    state: &AppState,
    user: Option<&User>,
    headers: &HeaderMap,
    mut sq: SearchQuery,
) -> Result<(Vec<SearchResult>, Option<i64>), ApiError> {
    let db = &state.read();
    require_guest_ok(db, user).await?;
    check_nul([&sq.q, &sq.server, &sq.from, &sq.has], &sq.servers)?;
    if let Some(raw) = sq.cursor.take() {
        sq.before = Some(cursor_int(&decode_cursor(&raw, 1)?[0])?);
        sq.offset = None;
    }
    sq.offset = sq.offset.map(|n| n.min(SEARCH_OFFSET_MAX));
    let text = sq.q.as_deref().map(str::trim).unwrap_or("");
    let short = text.chars().count() < FTS_MIN_CHARS || !has_fts(db);
    let unscoped = sq.server.is_none() && sq.channel_id.is_none();
    let first_page = sq.offset.is_none_or(|n| n <= 0);
    if !text.is_empty() && !short && is_sqlite(db) && first_page {
        let phrase = fts_phrase(text);
        return fts_paged(db, user, headers, sq, &phrase).await;
    }
    let windowed = !text.is_empty() && (short || unscoped) && is_sqlite(db) && first_page;
    let budget = match short {
        true => LIKE_BUDGET,
        false => i64::MAX,
    };
    if !windowed {
        let results = search_once(db, user, headers, sq, None, SEARCH_PAGE).await?;
        let next = match results.len() as i64 == SEARCH_PAGE {
            true => results.last().map(|r| r.message.id),
            false => None,
        };
        return Ok((results, next));
    }
    let floor = sq.after.unwrap_or(0).max(0);
    let mut hi = match sq.before {
        Some(b) => b,
        None => {
            sqlx::query("SELECT MAX(id) FROM messages")
                .fetch_one(db)
                .await?
                .try_get::<Option<i64>, _>(0)?
                .unwrap_or(0)
                + 1
        }
    };
    let mut size = SEARCH_WINDOW;
    let mut scanned = 0i64;
    let mut results: Vec<SearchResult> = Vec::new();
    while (results.len() as i64) < SEARCH_PAGE && hi > floor + 1 && scanned < budget {
        let lo = hi.saturating_sub(size).max(floor + 1);
        let want = SEARCH_PAGE - results.len() as i64;
        let page = search_once(db, user, headers, sq.clone(), Some((lo, hi)), want).await?;
        results.extend(page);
        scanned = scanned.saturating_add(hi - lo);
        hi = lo;
        size = size.saturating_mul(8);
    }
    let next = match (results.len() as i64 == SEARCH_PAGE, hi > floor + 1) {
        (true, _) => results.last().map(|r| r.message.id),
        (false, true) => Some(hi),
        (false, false) => None,
    };
    Ok((results, next))
}

async fn fts_paged(
    db: &Db,
    user: Option<&User>,
    headers: &HeaderMap,
    sq: SearchQuery,
    phrase: &str,
) -> Result<(Vec<SearchResult>, Option<i64>), ApiError> {
    let floor = sq.after.unwrap_or(0).max(0);
    let mut hi = sq.before.unwrap_or(i64::MAX);
    let mut results: Vec<SearchResult> = Vec::new();
    let mut more = true;
    for _ in 0..FTS_ROUNDS {
        if results.len() as i64 >= SEARCH_PAGE {
            break;
        }
        let rows = sqlx::query(
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH $1 AND rowid < $2 AND rowid > $3 ORDER BY rowid DESC LIMIT $4",
        )
        .bind(phrase)
        .bind(hi)
        .bind(floor)
        .bind(FTS_BATCH)
        .fetch_all(db)
        .await?;
        let Some(last) = rows.last() else {
            more = false;
            break;
        };
        let lo: i64 = last.try_get(0)?;
        let want = SEARCH_PAGE - results.len() as i64;
        results.extend(search_once(db, user, headers, sq.clone(), Some((lo, hi)), want).await?);
        hi = lo;
        if (rows.len() as i64) < FTS_BATCH {
            more = false;
            break;
        }
    }
    let next = match (results.len() as i64 == SEARCH_PAGE, more) {
        (true, _) => results.last().map(|r| r.message.id),
        (false, true) => Some(hi),
        (false, false) => None,
    };
    Ok((results, next))
}

async fn search_once(
    db: &Db,
    user: Option<&User>,
    headers: &HeaderMap,
    sq: SearchQuery,
    window: Option<(i64, i64)>,
    limit: i64,
) -> Result<Vec<SearchResult>, ApiError> {
    let (sql, binds) = match search_sql(db, user, headers, sq, window, limit).await? {
        Some(built) => built,
        None => return Ok(Vec::new()),
    };
    let rows = bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
        .fetch_all(db)
        .await?;
    let mut msgs = rows_messages(db, &rows).await?;
    let mut ctx: Vec<(String, String)> = Vec::with_capacity(rows.len());
    for r in &rows {
        ctx.push((r.try_get(21)?, r.try_get(22)?));
    }
    attach_embeds(db, &mut msgs).await?;
    Ok(msgs
        .into_iter()
        .zip(ctx)
        .map(|(message, (server, channel_name))| SearchResult {
            message,
            server,
            channel_name,
        })
        .collect())
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

fn check_nul(texts: [&Option<String>; 4], servers: &Option<Vec<String>>) -> Result<(), ApiError> {
    let nul = texts
        .iter()
        .any(|t| t.as_deref().is_some_and(|v| v.contains('\0')))
        || servers.iter().flatten().any(|v| v.contains('\0'));
    match nul {
        true => Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Search text cannot contain NUL characters".to_string(),
        )),
        false => Ok(()),
    }
}

async fn search_sql(
    db: &Db,
    user: Option<&User>,
    headers: &HeaderMap,
    sq: SearchQuery,
    window: Option<(i64, i64)>,
    limit: i64,
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
        cursor: _,
        servers,
    } = sq;
    let (lo, hi) = match window {
        Some((lo, hi)) => (lo, hi),
        None => (i64::MIN, before.unwrap_or(i64::MAX)),
    };
    check_nul([&q, &server, &from, &has], &servers)?;
    let mut conds: Vec<String> = vec![LIVE_AUTHOR.to_string()];
    let mut binds: Vec<Bind> = Vec::new();
    match user {
        Some(u) => {
            binds.push(Bind::S(u.username.clone()));
            conds.push(format!(
                "c.server IN (SELECT server FROM members WHERE username = ${})",
                binds.len()
            ));
            if !u.is_site_admin {
                let mut ph = Vec::new();
                for subject in perm_subjects(db, None, &u.username).await? {
                    binds.push(Bind::S(subject));
                    ph.push(format!("${}", binds.len()));
                }
                let mut managed = Vec::new();
                for server in channel_manager_servers(db, u).await? {
                    binds.push(Bind::S(server));
                    managed.push(format!("${}", binds.len()));
                }
                let bypass = match managed.is_empty() {
                    true => String::new(),
                    false => format!("c.server IN ({}) OR ", managed.join(", ")),
                };
                conds.push(format!(
                    "({bypass}NOT EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id) OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id AND cp.can_view != 0 AND cp.subject IN ({})))",
                    ph.join(", ")
                ));
                conds.push(format!(
                    "({bypass}NOT EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id) OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id AND cp.can_read_history != 0 AND cp.subject IN ({})) OR m.created_at >= (SELECT joined_at FROM members mm WHERE mm.server = c.server AND mm.username = $1))",
                    ph.join(", ")
                ));
            }
        }
        None => {
            conds.push(
                "NOT EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id)"
                    .to_string(),
            );
            let granted = crate::db::live_grant_servers(db, &header_grants(headers)).await?;
            match granted.is_empty() {
                true => conds.push(
                    "c.server IN (SELECT name FROM servers WHERE password_hash IS NULL)"
                        .to_string(),
                ),
                false => {
                    let mut ph = Vec::with_capacity(granted.len());
                    for server in granted {
                        binds.push(Bind::S(server));
                        ph.push(format!("${}", binds.len()));
                    }
                    conds.push(format!(
                        "(c.server IN (SELECT name FROM servers WHERE password_hash IS NULL) OR c.server IN ({}))",
                        ph.join(", "),
                    ));
                }
            }
            let names = unique_capped(
                servers
                    .unwrap_or_default()
                    .iter()
                    .map(|s| s.trim().to_lowercase()),
            );
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
        match text.chars().count() >= FTS_MIN_CHARS && has_fts(db) {
            true => {
                binds.push(Bind::S(fts_phrase(text)));
                binds.push(Bind::I(lo));
                binds.push(Bind::I(hi));
                conds.push(format!(
                    "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${} AND rowid >= ${} AND rowid < ${})",
                    binds.len() - 2,
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
    if window.is_some() {
        binds.push(Bind::I(lo));
        conds.push(format!("m.id >= ${}", binds.len()));
        binds.push(Bind::I(hi));
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
        "SELECT {COLS}, c.server, c.name FROM messages m CROSS JOIN channels c WHERE c.id = m.channel_id AND {} ORDER BY m.id DESC LIMIT {limit}{skip}",
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
    let subjects = perm_subjects(db, None, &user.username).await?;
    let mut restricted: HashMap<i64, (String, Vec<PermRow>)> = HashMap::new();
    for r in &rows {
        let (id, server): (i64, String) = (r.try_get(0)?, r.try_get(1)?);
        restricted
            .entry(id)
            .or_insert_with(|| (server, Vec::new()))
            .1
            .push(perm_row(r, 2)?);
    }
    let mut manages: HashMap<String, bool> = HashMap::new();
    let mut out = HashMap::with_capacity(restricted.len());
    for (id, (server, perms)) in restricted {
        let manage = match manages.get(&server) {
            Some(m) => *m,
            None => {
                let m = manages_channels(db, &server, user).await?;
                manages.insert(server, m);
                m
            }
        };
        out.insert(id, fold_access(&perms, &subjects, manage));
    }
    Ok(out)
}

const UNREADS_MAX: usize = 500;

#[derive(Deserialize, IntoParams)]
pub struct UnreadsQuery {
    all: Option<bool>,
}

#[utoipa::path(get, path = "/api/unreads", params(UnreadsQuery), responses((status = 200, description = "Unread scopes: the latest top-level message id from someone else and the last-read id for each text channel the caller can view (with its server) and each DM whose latest message is newer than its read position, newest first and capped at 500 (`more` is true when the cap cut the list). Scopes that are not listed are read. With `all=true` every viewable channel and DM with messages from others is listed, read or not (no cap)", body = Unreads)), security(("bearer" = [])))]
pub(crate) async fn unreads(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<UnreadsQuery>,
) -> Result<Json<Unreads>, ApiError> {
    let all = q.all.unwrap_or(false);
    let db = &state.read();
    let restricted = restricted_access(db, &user).await?;
    let channel_sql = format!(
        "SELECT x.id, x.server, x.latest, (SELECT lm.created_at FROM messages lm WHERE lm.id = x.latest), x.last_read, x.joined_at FROM (SELECT c.id, c.server, (SELECT m.id FROM messages m WHERE m.channel_id = c.id AND m.thread_root_id IS NULL AND m.author <> $1 AND {LIVE_AUTHOR} ORDER BY m.id DESC LIMIT 1) AS latest, COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'c' || c.id), 0) AS last_read, mem.joined_at FROM channels c JOIN members mem ON mem.server = c.server AND mem.username = $1 WHERE c.kind = 'text') x"
    );
    let channel_rows = sqlx::query(sqlx::AssertSqlSafe(channel_sql))
        .bind(&user.username)
        .fetch_all(db)
        .await?;
    let dm_sql = match all {
        true => {
            "SELECT d.id, (SELECT MAX(m.id) FROM messages m WHERE m.dm_id = d.id AND m.author <> $1), COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'd' || d.id), 0) FROM dms d WHERE (d.user_a = $1 OR d.user_b = $1) AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username IN (d.user_a, d.user_b) AND pu.password_hash = '!purging')"
        }
        false => {
            "SELECT x.id, (SELECT MAX(m.id) FROM messages m WHERE m.dm_id = x.id AND m.author <> $1), x.last_read FROM (SELECT d.id, d.last_message_id, COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'd' || d.id), 0) AS last_read FROM dms d WHERE (d.user_a = $1 OR d.user_b = $1) AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username IN (d.user_a, d.user_b) AND pu.password_hash = '!purging')) x WHERE x.last_message_id > x.last_read"
        }
    };
    let dm_rows = sqlx::query(dm_sql)
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
        let last_read: i64 = r.try_get(4)?;
        if let (Some(latest), true) = (latest, readable)
            && (all || latest > last_read)
        {
            items.push(Unread {
                scope: format!("c{id}"),
                server: Some(r.try_get(1)?),
                last_read,
                latest,
            });
        }
    }
    for r in &dm_rows {
        let id: i64 = r.try_get(0)?;
        let last_read: i64 = r.try_get(2)?;
        if let Some(latest) = r.try_get::<Option<i64>, _>(1)?
            && (all || latest > last_read)
        {
            items.push(Unread {
                scope: format!("d{id}"),
                server: None,
                last_read,
                latest,
            });
        }
    }
    let more = !all && items.len() > UNREADS_MAX;
    if !all {
        items.sort_by_key(|u| std::cmp::Reverse(u.latest));
        items.truncate(UNREADS_MAX);
    }
    Ok(Json(Unreads { items, more }))
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
    if stored == last_read {
        state.hub.broadcast(WsEvent::ReadUpdated {
            username: user.username,
            scope: scope.clone(),
            last_read: stored,
        });
    }
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
                after: None,
                around: None,
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
        let found = search_with(
            &state,
            Some(&mem_user("alice", false)),
            &HeaderMap::new(),
            query(None),
        )
        .await
        .expect("search");
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
            cursor: None,
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
    async fn channel_permission_paths_agree() {
        let (state, path) = temp_state("perm_paths").await;
        let db = &state.db;
        let private = add_channel(db, "private", "text").await;
        let t = now();
        for (name, admin, perms) in [
            ("alice", 0, 0),
            ("bob", 0, 0),
            ("mod", 1, Perm::ManageChannels as i64),
            ("kicker", 1, Perm::Kick as i64),
            ("roler", 0, 0),
            ("plainrole", 0, 0),
        ] {
            add_member(db, "rchat", name, admin, perms, t - 100).await;
        }
        for (holder, perms) in [
            ("roler", Perm::ManageChannels as i64),
            ("plainrole", Perm::Kick as i64),
        ] {
            let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', $1, '#ffffff', $2) RETURNING id")
                .bind(holder)
                .bind(perms)
                .fetch_one(db)
                .await
                .expect("role")
                .try_get(0)
                .expect("role id");
            sqlx::query(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', $1, $2)",
            )
            .bind(holder)
            .bind(role)
            .execute(db)
            .await
            .expect("assign role");
        }
        perm(db, private, "u:alice", 0).await;
        perm(db, private, "u:bob", 1).await;
        let needle = post(db, private, "eve", "secret needle", t - 200).await;
        for (name, want) in [
            ("alice", false),
            ("bob", true),
            ("mod", true),
            ("kicker", false),
            ("roler", true),
            ("plainrole", false),
        ] {
            let user = mem_user(name, false);
            let direct = channel_access(db, "rchat", private, Some(&user))
                .await
                .expect("access")
                .view;
            let unread = restricted_access(db, &user).await.expect("restricted")[&private].view;
            let listed =
                crate::api::servers::visible_restricted(db, "rchat", Some(&user), &[private])
                    .await
                    .expect("visible")
                    .contains(&private);
            let searched = found(&state, Some(user), HeaderMap::new(), query(Some("needle")))
                .await
                .contains(&needle);
            assert_eq!([direct, unread, listed, searched], [want; 4], "{name}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn common_terms_page_through_bounded_fts_batches() {
        let (state, path) = temp_state("fts_batches").await;
        let db = &state.db;
        let general = general_id(db).await;
        let private = add_channel(db, "hidden", "text").await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        perm(db, private, "u:alice", 0).await;
        let mut visible = Vec::new();
        for n in 0..3 {
            visible.push(post(db, general, "eve", &format!("common word {n}"), 1).await);
        }
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, 'eve', 'common word hidden ' || i, 2 FROM n")
            .bind(private)
            .execute(db)
            .await
            .expect("seed hidden");
        let alice = mem_user("alice", false);
        let mut sq = query(Some("common"));
        let mut got = Vec::new();
        let mut calls = 0;
        loop {
            calls += 1;
            let (page, next) = search_paged(&state, Some(&alice), &HeaderMap::new(), sq.clone())
                .await
                .expect("search");
            got.extend(page.iter().map(|r| r.message.id));
            match next {
                Some(before) => sq.before = Some(before),
                None => break,
            }
            assert!(calls < 10, "search never finished");
        }
        assert!(
            calls > 1,
            "a common term must not scan every match in one call"
        );
        visible.reverse();
        assert_eq!(got, visible);
        done(state, path).await;
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
                    Query(PageQuery {
                        before,
                        after: None,
                        around: None,
                        limit,
                    }),
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
                after: None,
                around: None,
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
        unreads(
            State(state.clone()),
            Authed(mem_user(name, false)),
            Query(UnreadsQuery { all: Some(true) }),
        )
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
            sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'eve', 'x', $2) RETURNING id")
                .bind(nohist)
                .bind(when)
        };
        let before_join: i64 = at(t - 10)
            .fetch_one(db)
            .await
            .expect("old message")
            .try_get(0)
            .expect("old id");
        let g = insert(db, Some(general), None, None, "eve").await;
        let reply = insert(db, Some(general), None, Some(g), "eve").await;
        let p = insert(db, Some(private), None, None, "eve").await;
        let r = insert(db, Some(roled), None, None, "eve").await;
        insert(db, Some(voice), None, None, "eve").await;
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
        assert!(!bob.contains_key(&format!("d{dm}")));
        assert_eq!(bob.len(), 3);
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
        search_with(state, user.as_ref(), &headers, sq)
            .await
            .expect("search")
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
        crate::db::set_fts(db, false);
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
            assert_eq!(has_fts(db), fts);
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
            let nul = search_with(
                &state,
                Some(&mem_user("alice", false)),
                &HeaderMap::new(),
                query(Some("hel\0lo")),
            )
            .await;
            assert!(matches!(nul, Err(ApiError(StatusCode::BAD_REQUEST, _))));
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
        for (name, password) in [("locked", Some("x")), ("other", None), ("comma, inc", None)] {
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
        for (server, name) in [
            ("locked", "vault"),
            ("other", "lobby"),
            ("comma, inc", "hall"),
        ] {
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
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g1', 'locked', 0, 4000000000)",
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
            let guest = |servers: Option<&[&str]>| {
                let mut sq = query(q);
                sq.servers = servers.map(|list| list.iter().map(|n| n.to_string()).collect());
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
                    guest(Some(&["rchat", "locked", "other"])),
                    expect(&["general", "lobby"]),
                ),
                (
                    None,
                    grant("g1"),
                    guest(Some(&["rchat", " LOCKED"])),
                    expect(&["general", "vault"]),
                ),
                (None, grant("nope"), guest(Some(&["locked"])), Vec::new()),
                (None, grant("g1"), guest(None), Vec::new()),
                (
                    None,
                    HeaderMap::new(),
                    guest(Some(&["comma, inc"])),
                    expect(&["hall"]),
                ),
                (
                    None,
                    HeaderMap::new(),
                    guest(Some(&["comma", " inc"])),
                    Vec::new(),
                ),
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
        let (sql, binds) = search_sql(db, Some(user), &HeaderMap::new(), sq, None, SEARCH_PAGE)
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
        AppState::new(
            db,
            crate::ws::Hub::new(),
            None,
            None,
            crate::instance::Instance::ephemeral(),
        )
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
            assert!(has_fts(&state.db));
            assert_eq!(fts_hits(&state.db, "needle").await, 10);
            fts_ok(&state.db).await;
            let got = found(&state, alice(), HeaderMap::new(), query(Some("needle"))).await;
            assert_eq!(got, like);
            state.db.close().await;
        }
        let state = reopened(crate::db::open(path.to_str()).await.expect("reopen"));
        done(state, path).await;
    }

    fn around(before: Option<i64>, after: Option<i64>, at: Option<i64>, limit: i64) -> PageQuery {
        PageQuery {
            before,
            after,
            around: at,
            limit: Some(limit),
        }
    }

    #[tokio::test]
    async fn pages_around_and_after() {
        let (state, path) = temp_state("page_around").await;
        let db = &state.db;
        let cid = general_id(db).await;
        let mut ids = Vec::new();
        for _ in 0..120 {
            ids.push(insert(db, Some(cid), None, None, "alice").await);
        }
        let root = ids[10];
        let mut replies = Vec::new();
        for _ in 0..30 {
            replies.push(insert(db, Some(cid), None, Some(root), "bob").await);
        }
        let channel = |q: PageQuery| {
            let state = state.clone();
            async move {
                channel_messages(
                    State(state),
                    MaybeAuthed(None),
                    HeaderMap::new(),
                    Path(cid),
                    Query(q),
                )
                .await
                .expect("page")
                .0
                .iter()
                .map(|m| m.id)
                .collect::<Vec<i64>>()
            }
        };
        assert_eq!(
            channel(around(None, None, Some(ids[60]), 50)).await,
            ids[35..85]
        );
        assert_eq!(
            channel(around(None, None, Some(ids[3]), 50)).await,
            ids[0..28]
        );
        assert_eq!(
            channel(around(None, None, Some(ids[110]), 50)).await,
            ids[85..120]
        );
        assert_eq!(
            channel(around(None, None, Some(ids[60]), 1)).await,
            ids[60..61]
        );
        assert_eq!(
            channel(around(None, Some(ids[20]), None, 10)).await,
            ids[21..31]
        );
        assert_eq!(
            channel(around(None, Some(ids[115]), None, 50)).await,
            ids[116..120]
        );
        assert_eq!(
            channel(around(Some(ids[5]), Some(ids[20]), Some(ids[60]), 4)).await,
            ids[58..62]
        );
        assert_eq!(
            channel(around(Some(ids[50]), Some(ids[20]), None, 5)).await,
            ids[21..26]
        );
        let thread = thread_messages(
            State(state.clone()),
            MaybeAuthed(None),
            HeaderMap::new(),
            Path(root),
            Query(around(None, None, Some(replies[15]), 10)),
        )
        .await
        .expect("thread")
        .0
        .iter()
        .map(|m| m.id)
        .collect::<Vec<i64>>();
        assert_eq!(thread, replies[10..20]);
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        let mut dm_ids = Vec::new();
        for _ in 0..20 {
            dm_ids.push(insert(db, None, Some(dm), None, "bob").await);
        }
        let dm_page = dm_messages(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            Query(around(None, None, Some(dm_ids[2]), 10)),
        )
        .await
        .expect("dm page")
        .0
        .iter()
        .map(|m| m.id)
        .collect::<Vec<i64>>();
        assert_eq!(dm_page, dm_ids[0..7]);
        let joined = now() - 100;
        add_member(db, "rchat", "late", 0, 0, joined).await;
        sqlx::query("UPDATE messages SET created_at = $1 WHERE channel_id = $2 AND id < $3")
            .bind(joined - 10)
            .bind(cid)
            .bind(ids[60])
            .execute(db)
            .await
            .expect("age messages");
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:late', 1, 1, 0)")
            .bind(cid)
            .execute(db)
            .await
            .expect("no history perm");
        let gated = channel_messages(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("late", false))),
            HeaderMap::new(),
            Path(cid),
            Query(around(None, None, Some(ids[62]), 50)),
        )
        .await
        .expect("gated page")
        .0
        .iter()
        .map(|m| m.id)
        .collect::<Vec<i64>>();
        assert_eq!(gated, ids[60..87]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn unreads_skip_own_messages() {
        let (state, path) = temp_state("unread_own").await;
        let db = &state.db;
        let general = general_id(db).await;
        let t = now();
        add_member(db, "rchat", "alice", 0, 0, t).await;
        add_member(db, "rchat", "bob", 0, 0, t).await;
        let theirs = insert(db, Some(general), None, None, "bob").await;
        let mine = insert(db, Some(general), None, None, "alice").await;
        assert!(mine > theirs);
        let only_mine = add_channel(db, "mine", "text").await;
        insert(db, Some(only_mine), None, None, "alice").await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        let sent = insert(db, None, Some(dm), None, "alice").await;
        let rchat = Some("rchat".to_string());
        let alice = unread_map(&state, "alice").await;
        assert_eq!(alice[&format!("c{general}")], (rchat.clone(), theirs, 0));
        assert!(!alice.contains_key(&format!("c{only_mine}")));
        assert!(!alice.contains_key(&format!("d{dm}")));
        let bob = unread_map(&state, "bob").await;
        assert_eq!(bob[&format!("c{general}")], (rchat.clone(), mine, 0));
        assert_eq!(bob[&format!("d{dm}")], (None, sent, 0));
        let reply = insert(db, None, Some(dm), None, "bob").await;
        let alice = unread_map(&state, "alice").await;
        assert_eq!(alice[&format!("d{dm}")], (None, reply, 0));
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_query_parsing() {
        let sq = SearchQuery::parse("q=hi&servers=a%2Cb&servers=c&channel_id=4&unknown=1")
            .expect("parse");
        assert_eq!(sq.q.as_deref(), Some("hi"));
        assert_eq!(sq.channel_id, Some(4));
        assert_eq!(sq.servers, Some(vec!["a,b".to_string(), "c".to_string()]));
        assert!(SearchQuery::parse("").expect("empty").servers.is_none());
        assert!(matches!(
            SearchQuery::parse("before=x"),
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        let (state, path) = temp_state("search_parse").await;
        add_member(&state.db, "rchat", "alice", 0, 0, 0).await;
        for raw in ["q=a%00b", "from=a%00", "servers=rch%00at", "server=x%00"] {
            let got = search(
                State(state.clone()),
                MaybeAuthed(Some(mem_user("alice", false))),
                HeaderMap::new(),
                RawQuery(Some(raw.to_string())),
            )
            .await;
            assert!(
                matches!(got, Err(ApiError(StatusCode::BAD_REQUEST, _))),
                "{raw}"
            );
        }
        let ok = search(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("alice", false))),
            HeaderMap::new(),
            RawQuery(Some("q=hello".to_string())),
        )
        .await;
        assert!(ok.is_ok());
        done(state, path).await;
    }

    #[tokio::test]
    async fn unreads_default_lists_only_unread_scopes() {
        let (state, path) = temp_state("unreads_only").await;
        let db = &state.db;
        let general = general_id(db).await;
        let quiet = add_channel(db, "quiet", "text").await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        add_member(db, "rchat", "bob", 0, 0, 0).await;
        let loud = insert(db, Some(general), None, None, "bob").await;
        let old = insert(db, Some(quiet), None, None, "bob").await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let read_dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let dm_msg = insert(db, None, Some(dm), None, "bob").await;
        let carol = insert(db, None, Some(read_dm), None, "carol").await;
        insert(db, None, Some(read_dm), None, "alice").await;
        for (scope, last) in [(format!("c{quiet}"), old), (format!("d{read_dm}"), carol)] {
            sqlx::query(
                "INSERT INTO read_state(username, scope, last_read) VALUES('alice', $1, $2)",
            )
            .bind(scope)
            .bind(last)
            .execute(db)
            .await
            .expect("read");
        }
        let got = unreads(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Query(UnreadsQuery { all: None }),
        )
        .await
        .expect("unreads")
        .0;
        assert!(!got.more);
        let scopes: Vec<(String, i64)> =
            got.items.into_iter().map(|u| (u.scope, u.latest)).collect();
        assert_eq!(
            scopes,
            vec![(format!("d{dm}"), dm_msg), (format!("c{general}"), loud)]
        );
        let all = unread_map(&state, "alice").await;
        assert_eq!(all.len(), 4);
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_cursor_header_walks_windows() {
        let (state, path) = temp_state("search_windows").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        seed(db, cid, 20000).await;
        let alice = Some(mem_user("alice", false));
        for q in ["needle", "ne"] {
            let expected: Vec<i64> = sqlx::query(
                "SELECT id FROM messages WHERE lower(content) LIKE $1 ORDER BY id DESC",
            )
            .bind(format!("%{q}%"))
            .fetch_all(db)
            .await
            .expect("expected")
            .iter()
            .map(|r| r.try_get(0).expect("id"))
            .collect();
            let mut seen = Vec::new();
            let mut cursor: Option<String> = None;
            let mut pages = 0;
            loop {
                let mut sq = query(Some(q));
                sq.cursor = cursor.clone();
                let (page, next) = search_paged(&state, alice.as_ref(), &HeaderMap::new(), sq)
                    .await
                    .expect("search");
                assert!(page.len() as i64 <= SEARCH_PAGE);
                seen.extend(page.iter().map(|r| r.message.id));
                pages += 1;
                match next {
                    Some(id) => cursor = Some(encode_cursor(&[&id.to_string()])),
                    None => break,
                }
            }
            assert_eq!(seen, expected, "q={q}");
            assert!(pages >= expected.len() / SEARCH_PAGE as usize, "q={q}");
        }
        let mut deep = query(Some("needle"));
        deep.offset = Some(10_000);
        let capped = found(&state, alice.clone(), HeaderMap::new(), deep).await;
        assert!(capped.is_empty());
        let mut bad = query(Some("needle"));
        bad.cursor = Some("nothex".to_string());
        assert!(matches!(
            search_paged(&state, alice.as_ref(), &HeaderMap::new(), bad).await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        done(state, path).await;
    }

    #[tokio::test]
    async fn send_path_checks_membership_and_slowmode() {
        let (state, path) = temp_state("send_gate").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        let send = |who: &str, cid: i64| {
            let state = state.clone();
            let who = who.to_string();
            async move {
                send_channel_message(
                    State(state),
                    Path(cid),
                    Authed(mem_user(&who, false)),
                    Json(SendReq {
                        content: "hello".to_string(),
                        media_id: None,
                        media_spoiler: None,
                        p2p: None,
                    }),
                )
                .await
                .map(|_| ())
            }
        };
        assert!(send("alice", cid).await.is_ok());
        assert!(matches!(
            send("mallory", cid).await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert!(matches!(
            send("alice", 9999).await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
        sqlx::query("UPDATE channels SET slowmode_seconds = 60 WHERE id = $1")
            .bind(cid)
            .execute(db)
            .await
            .expect("slowmode");
        assert!(matches!(
            send("alice", cid).await,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
        ));
        let voice = add_channel(db, "talk", "voice").await;
        assert!(matches!(
            send("alice", voice).await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        done(state, path).await;
    }
}
