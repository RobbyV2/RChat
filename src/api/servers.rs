use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::admin::{fuzzy_match, is_fuzzy, like_pattern};
use crate::api::auth::{hash_password, new_token, verify_password};
use crate::api::{
    ApiError, Authed, Channel, ChannelPerm, MaybeAuthed, Member, Role, ServerDetail,
    ServerSummaryLite, UserRef, check_profanity, require_guest_ok, require_server_view, user_ref,
    valid_color,
};
use crate::db::{ALL_PERMS, ChannelKind, Db, Perm, User, channel_access, get_user, has_perm, now};
use crate::state::AppState;
use crate::ws::{Hub, WsEvent, evict_unviewable};

#[derive(Deserialize, ToSchema)]
pub struct CreateChannelReq {
    name: String,
    kind: Option<ChannelKind>,
}

#[derive(Deserialize, ToSchema)]
pub struct CreateServerReq {
    name: String,
    password: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct JoinReq {
    password: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct ServerPatch {
    name: Option<String>,
    password: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct ChannelPatch {
    name: Option<String>,
    slowmode_seconds: Option<i64>,
}

#[derive(Deserialize, ToSchema)]
pub struct UsernameReq {
    username: String,
}

#[derive(Deserialize, ToSchema)]
pub struct PermsReq {
    perms: i64,
}

#[derive(Deserialize, ToSchema)]
pub struct RoleReq {
    name: String,
    color: String,
    perms: i64,
}

#[derive(Deserialize, ToSchema)]
pub struct RolePatch {
    name: Option<String>,
    color: Option<String>,
    perms: Option<i64>,
}

#[derive(Deserialize, ToSchema)]
pub struct GuestAccessReq {
    password: String,
}

#[derive(Serialize, ToSchema)]
pub struct GuestGrant {
    grant: String,
}

#[derive(Serialize, ToSchema)]
pub struct ServerExists {
    has_password: bool,
}

#[derive(Deserialize, IntoParams)]
pub struct ServerSearchQuery {
    q: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct ServerMatch {
    pub name: String,
    pub display_name: String,
    pub has_password: bool,
}

#[derive(Serialize, ToSchema)]
pub struct OkResp {
    ok: bool,
}

#[derive(Deserialize, IntoParams)]
pub struct MembersQuery {
    offset: Option<i64>,
    limit: Option<i64>,
}

fn ok() -> Json<OkResp> {
    Json(OkResp { ok: true })
}

fn bad(msg: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.to_string())
}

fn not_found(msg: &str) -> ApiError {
    ApiError(StatusCode::NOT_FOUND, msg.to_string())
}

fn forbidden(msg: &str) -> ApiError {
    ApiError(StatusCode::FORBIDDEN, msg.to_string())
}

async fn check_name(db: &Db, name: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(bad("Name required"));
    }
    check_profanity(db, name).await
}

fn guard_rchat(key: &str) -> Result<(), ApiError> {
    match key {
        "rchat" => Err(forbidden("The rchat server is protected")),
        _ => Ok(()),
    }
}

pub(crate) async fn server_lite(
    db: &Db,
    name: &str,
) -> Result<Option<ServerSummaryLite>, ApiError> {
    let row = sqlx::query(
        "SELECT name, display_name, creator, password_hash FROM servers WHERE name = $1",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    match row {
        Some(r) => Ok(Some(ServerSummaryLite {
            name: r.try_get(0)?,
            display_name: r.try_get(1)?,
            creator: r.try_get(2)?,
            has_password: r.try_get::<Option<String>, _>(3)?.is_some(),
        })),
        None => Ok(None),
    }
}

pub(crate) async fn require_server(db: &Db, name: &str) -> Result<ServerSummaryLite, ApiError> {
    server_lite(db, name)
        .await?
        .ok_or_else(|| not_found("Server not found"))
}

async fn require_perm(db: &Db, server: &str, user: &User, perm: Perm) -> Result<(), ApiError> {
    match has_perm(db, server, user, perm).await {
        true => Ok(()),
        false => Err(forbidden("Missing permission")),
    }
}

async fn role_ids(db: &Db, server: &str, username: &str) -> Result<Vec<i64>, ApiError> {
    let rows = sqlx::query(
        "SELECT role_id FROM user_roles WHERE server = $1 AND username = $2 ORDER BY role_id",
    )
    .bind(server)
    .bind(username)
    .fetch_all(db)
    .await?;
    let mut ids = Vec::with_capacity(rows.len());
    for r in &rows {
        ids.push(r.try_get(0)?);
    }
    Ok(ids)
}

async fn channel_server(db: &Db, id: i64) -> Result<String, ApiError> {
    let row = sqlx::query("SELECT server FROM channels WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    match row {
        Some(r) => Ok(r.try_get(0)?),
        None => Err(not_found("Channel not found")),
    }
}

async fn build_member(
    db: &Db,
    hub: &Hub,
    server: &str,
    creator: Option<&str>,
    username: &str,
    is_admin: bool,
    perms: i64,
) -> Result<Member, ApiError> {
    Ok(Member {
        user: user_ref(db, username).await,
        is_admin,
        is_creator: creator == Some(username),
        online: hub.is_online(server, username),
        perms,
        role_ids: role_ids(db, server, username).await?,
    })
}

pub(crate) async fn server_roles(db: &Db, server: &str) -> Result<Vec<Role>, ApiError> {
    let rows =
        sqlx::query("SELECT id, name, color, perms FROM roles WHERE server = $1 ORDER BY id")
            .bind(server)
            .fetch_all(db)
            .await?;
    let mut roles = Vec::with_capacity(rows.len());
    for r in &rows {
        roles.push(Role {
            id: r.try_get(0)?,
            name: r.try_get(1)?,
            color: r.try_get(2)?,
            perms: r.try_get(3)?,
        });
    }
    Ok(roles)
}

async fn server_detail(
    db: &Db,
    hub: &Hub,
    name: &str,
    viewer: Option<&User>,
) -> Result<ServerDetail, ApiError> {
    let ServerSummaryLite {
        name,
        display_name,
        creator,
        has_password,
    } = require_server(db, name).await?;
    let rows = sqlx::query(
        "SELECT id, name, kind, slowmode_seconds FROM channels WHERE server = $1 ORDER BY id",
    )
    .bind(&name)
    .fetch_all(db)
    .await?;
    let restricted_rows = sqlx::query(
        "SELECT DISTINCT cp.channel_id FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id WHERE c.server = $1",
    )
    .bind(&name)
    .fetch_all(db)
    .await?;
    let mut restricted = Vec::with_capacity(restricted_rows.len());
    for r in &restricted_rows {
        restricted.push(r.try_get::<i64, _>(0)?);
    }
    let mut channels = Vec::new();
    for r in &rows {
        let id: i64 = r.try_get(0)?;
        if restricted.contains(&id) {
            let visible = match viewer {
                Some(user) => channel_access(db, &name, id, Some(user)).await?.view,
                None => false,
            };
            if !visible {
                continue;
            }
        }
        channels.push(Channel {
            id,
            name: r.try_get(1)?,
            kind: ChannelKind::parse(&r.try_get::<String, _>(2)?)?,
            slowmode_seconds: r.try_get(3)?,
        });
    }
    let member_count: i64 = sqlx::query("SELECT COUNT(*) FROM members WHERE server = $1")
        .bind(&name)
        .fetch_one(db)
        .await?
        .try_get(0)?;
    let online_count = hub.online_count(&name);
    Ok(ServerDetail {
        name: name.clone(),
        display_name,
        creator,
        has_password,
        channels,
        roles: server_roles(db, &name).await?,
        member_count,
        online_count,
    })
}

#[utoipa::path(get, path = "/api/servers/{name}/members", params(("name" = String, Path), MembersQuery), responses((status = 200, body = Vec<Member>)), security((), ("bearer" = [])))]
pub(crate) async fn list_members(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<MembersQuery>,
) -> Result<Json<Vec<Member>>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    let lite = require_server(&state.db, &key).await?;
    require_server_view(&state.db, &headers, &lite, viewer.as_ref()).await?;
    let creator = lite.creator;
    let offset = q.offset.unwrap_or(0).max(0) as usize;
    let limit = q.limit.unwrap_or(50).clamp(1, 50) as usize;
    let online = state.hub.online_set(&key);
    let rows = sqlx::query(
        "SELECT username, is_admin, perms FROM members WHERE server = $1 ORDER BY username",
    )
    .bind(&key)
    .fetch_all(&state.db)
    .await?;
    let mut on = Vec::new();
    let mut off = Vec::new();
    for r in &rows {
        let (username, is_admin, perms): (String, i64, i64) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        match online.contains(&username) {
            true => on.push((username, is_admin, perms)),
            false => off.push((username, is_admin, perms)),
        }
    }
    on.append(&mut off);
    let mut members = Vec::new();
    for (username, is_admin, perms) in on.into_iter().skip(offset).take(limit) {
        members.push(Member {
            online: online.contains(&username),
            is_admin: is_admin != 0,
            is_creator: creator.as_deref() == Some(username.as_str()),
            perms,
            role_ids: role_ids(&state.db, &key, &username).await?,
            user: user_ref(&state.db, &username).await,
        });
    }
    Ok(Json(members))
}

#[utoipa::path(get, path = "/api/servers/{name}/interacted", params(("name" = String, Path), MembersQuery), responses((status = 200, body = Vec<UserRef>)), security((), ("bearer" = [])))]
pub(crate) async fn list_interacted(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<MembersQuery>,
) -> Result<Json<Vec<UserRef>>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    let lite = require_server(&state.db, &key).await?;
    require_server_view(&state.db, &headers, &lite, viewer.as_ref()).await?;
    let offset = q.offset.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(50).clamp(1, 50);
    let rows = sqlx::query(
        "SELECT username FROM interactions WHERE server = $1 AND username NOT IN (SELECT username FROM members WHERE server = $2) ORDER BY last_at DESC LIMIT $3 OFFSET $4",
    )
    .bind(&key)
    .bind(&key)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;
    let mut users = Vec::with_capacity(rows.len());
    for r in &rows {
        users.push(user_ref(&state.db, &r.try_get::<String, _>(0)?).await);
    }
    Ok(Json(users))
}

#[utoipa::path(post, path = "/api/servers", request_body = CreateServerReq, responses((status = 200, body = ServerDetail)), security(("bearer" = [])))]
pub(crate) async fn create_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<CreateServerReq>,
) -> Result<Json<ServerDetail>, ApiError> {
    let display = req.name.trim().to_string();
    let key = display.to_lowercase();
    check_name(&state.db, &display).await?;
    if server_lite(&state.db, &key).await?.is_some() {
        return Err(bad("Server name is taken"));
    }
    let password_hash = match req
        .password
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        Some(password) => Some(hash_password(password)?),
        None => None,
    };
    let t = now();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES($1, $2, $3, $4, $5)",
    )
    .bind(&key)
    .bind(&display)
    .bind(&user.username)
    .bind(&password_hash)
    .bind(t)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO members(server, username, is_admin, joined_at) VALUES($1, $2, 1, $3)")
        .bind(&key)
        .bind(&user.username)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO channels(server, name, created_at) VALUES($1, 'general', $2)")
        .bind(&key)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let detail = server_detail(&state.db, &state.hub, &key, Some(&user)).await?;
    state.hub.broadcast(WsEvent::ServerCreated {
        server: ServerSummaryLite {
            name: key,
            display_name: display,
            creator: Some(user.username),
            has_password: password_hash.is_some(),
        },
    });
    Ok(Json(detail))
}

#[utoipa::path(get, path = "/api/servers/{name}", params(("name" = String, Path)), responses((status = 200, body = ServerDetail)), security((), ("bearer" = [])))]
pub(crate) async fn get_server(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<ServerDetail>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    let lite = require_server(&state.db, &key).await?;
    require_server_view(&state.db, &headers, &lite, viewer.as_ref()).await?;
    Ok(Json(
        server_detail(&state.db, &state.hub, &key, viewer.as_ref()).await?,
    ))
}

#[utoipa::path(get, path = "/api/servers/{name}/exists", params(("name" = String, Path)), responses((status = 200, body = ServerExists)), security((), ("bearer" = [])))]
pub(crate) async fn server_exists(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    Path(name): Path<String>,
) -> Result<Json<ServerExists>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let ServerSummaryLite {
        name: _,
        display_name: _,
        creator: _,
        has_password,
    } = require_server(&state.db, &name.to_lowercase()).await?;
    Ok(Json(ServerExists { has_password }))
}

#[utoipa::path(get, path = "/api/server_search", params(ServerSearchQuery), responses((status = 200, body = Vec<ServerMatch>)), security((), ("bearer" = [])))]
pub(crate) async fn search_servers(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    Query(sq): Query<ServerSearchQuery>,
) -> Result<Json<Vec<ServerMatch>>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let q = sq.q.as_deref().unwrap_or("").trim().to_lowercase();
    if q.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let fuzzy = is_fuzzy(&q);
    let rows = sqlx::query(
        "SELECT name, display_name, password_hash FROM servers WHERE lower(name) LIKE $1 ESCAPE '\\' OR lower(display_name) LIKE $1 ESCAPE '\\' ORDER BY name LIMIT 50",
    )
    .bind(like_pattern(&q, fuzzy))
    .fetch_all(&state.db)
    .await?;
    let mut out = Vec::new();
    for r in &rows {
        let name: String = r.try_get(0)?;
        let display_name: String = r.try_get(1)?;
        if fuzzy && !(fuzzy_match(&q, &name) || fuzzy_match(&q, &display_name)) {
            continue;
        }
        out.push(ServerMatch {
            name,
            display_name,
            has_password: r.try_get::<Option<String>, _>(2)?.is_some(),
        });
        if out.len() >= 10 {
            break;
        }
    }
    Ok(Json(out))
}

#[utoipa::path(post, path = "/api/servers/{name}/guest_access", params(("name" = String, Path)), request_body = GuestAccessReq, responses((status = 200, body = GuestGrant), (status = 401, description = "Wrong password"), (status = 400, description = "Server has no password")))]
pub(crate) async fn guest_access(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    Path(name): Path<String>,
    Json(req): Json<GuestAccessReq>,
) -> Result<Json<GuestGrant>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    require_server(&state.db, &key).await?;
    let hash: Option<String> = sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
        .bind(&key)
        .fetch_one(&state.db)
        .await?
        .try_get(0)?;
    let hash = match hash {
        Some(hash) => hash,
        None => return Err(bad("Server has no password")),
    };
    if !verify_password(&req.password, &hash) {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Wrong password".to_string(),
        ));
    }
    let grant = new_token();
    sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at) VALUES($1, $2, $3)")
        .bind(&grant)
        .bind(&key)
        .bind(now())
        .execute(&state.db)
        .await?;
    Ok(Json(GuestGrant { grant }))
}

#[utoipa::path(post, path = "/api/servers/{name}/join", params(("name" = String, Path)), request_body = JoinReq, responses((status = 200, body = ServerDetail)), security(("bearer" = [])))]
pub(crate) async fn join_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    body: Option<Json<JoinReq>>,
) -> Result<Json<ServerDetail>, ApiError> {
    let key = name.to_lowercase();
    let lite = require_server(&state.db, &key).await?;
    if lite.has_password {
        let already = sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
            .bind(&key)
            .bind(&user.username)
            .fetch_optional(&state.db)
            .await?
            .is_some();
        if !already {
            let hash: Option<String> =
                sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
                    .bind(&key)
                    .fetch_one(&state.db)
                    .await?
                    .try_get(0)?;
            let given = body.as_ref().and_then(|Json(j)| j.password.as_deref());
            let ok = match (&hash, given) {
                (Some(hash), Some(password)) => verify_password(password, hash),
                (_, _) => false,
            };
            if !ok {
                return Err(ApiError(
                    StatusCode::UNAUTHORIZED,
                    "Wrong password".to_string(),
                ));
            }
        }
    }
    let inserted = sqlx::query(
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES($1, $2, 0, $3) ON CONFLICT(server, username) DO NOTHING",
    )
    .bind(&key)
    .bind(&user.username)
    .bind(now())
    .execute(&state.db)
    .await?
    .rows_affected();
    let detail = server_detail(&state.db, &state.hub, &key, Some(&user)).await?;
    let member = build_member(
        &state.db,
        &state.hub,
        &key,
        lite.creator.as_deref(),
        &user.username,
        false,
        0,
    )
    .await?;
    if inserted > 0 {
        state.hub.broadcast(WsEvent::MemberJoined {
            server: key,
            member,
        });
    }
    Ok(Json(detail))
}

#[utoipa::path(post, path = "/api/servers/{name}/leave", params(("name" = String, Path)), responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn leave_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    require_server(&state.db, &key).await?;
    let removed = sqlx::query("DELETE FROM members WHERE server = $1 AND username = $2")
        .bind(&key)
        .bind(&user.username)
        .execute(&state.db)
        .await?
        .rows_affected();
    match removed {
        0 => Err(bad("Not a member")),
        _ => {
            sqlx::query("DELETE FROM user_roles WHERE server = $1 AND username = $2")
                .bind(&key)
                .bind(&user.username)
                .execute(&state.db)
                .await?;
            state.hub.broadcast(WsEvent::MemberLeft {
                server: key.clone(),
                username: user.username.clone(),
            });
            state.hub.force_offline(&key, &user.username);
            Ok(ok())
        }
    }
}

#[utoipa::path(patch, path = "/api/servers/{name}", params(("name" = String, Path)), request_body = ServerPatch, responses((status = 200, body = ServerSummaryLite)), security(("bearer" = [])))]
pub(crate) async fn update_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<ServerPatch>,
) -> Result<Json<ServerSummaryLite>, ApiError> {
    let key = name.to_lowercase();
    guard_rchat(&key)?;
    let lite = require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::DeleteServer).await?;
    let ServerPatch { name, password } = req;
    let (new_key, display) = match &name {
        Some(n) => {
            let display = n.trim().to_string();
            let new_key = display.to_lowercase();
            check_name(&state.db, &display).await?;
            if new_key != key && server_lite(&state.db, &new_key).await?.is_some() {
                return Err(bad("Server name is taken"));
            }
            (new_key, display)
        }
        None => (key.clone(), lite.display_name),
    };
    let password_hash = match password.as_deref().map(str::trim) {
        Some("") => Some(None),
        Some(p) => Some(Some(hash_password(p)?)),
        None => None,
    };
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE servers SET name = $1, display_name = $2 WHERE name = $3")
        .bind(&new_key)
        .bind(&display)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    if let Some(hash) = &password_hash {
        sqlx::query("UPDATE servers SET password_hash = $1 WHERE name = $2")
            .bind(hash)
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM guest_grants WHERE server = $1")
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let server = ServerSummaryLite {
        name: new_key,
        display_name: display,
        creator: lite.creator,
        has_password: match &password_hash {
            Some(hash) => hash.is_some(),
            None => lite.has_password,
        },
    };
    state.hub.broadcast(WsEvent::ServerRenamed {
        old_name: key,
        server: server.clone(),
    });
    Ok(Json(server))
}

#[utoipa::path(delete, path = "/api/servers/{name}", params(("name" = String, Path)), responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn delete_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    guard_rchat(&key)?;
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::DeleteServer).await?;
    sqlx::query("DELETE FROM servers WHERE name = $1")
        .bind(&key)
        .execute(&state.db)
        .await?;
    state.hub.broadcast(WsEvent::ServerDeleted { name: key });
    Ok(ok())
}

#[utoipa::path(post, path = "/api/servers/{name}/channels", params(("name" = String, Path)), request_body = CreateChannelReq, responses((status = 200, body = Channel)), security(("bearer" = [])))]
pub(crate) async fn create_channel(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<CreateChannelReq>,
) -> Result<Json<Channel>, ApiError> {
    let key = name.to_lowercase();
    let channel_name = req.name.trim().to_string();
    let kind = req.kind.unwrap_or(ChannelKind::Text);
    check_name(&state.db, &channel_name).await?;
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::ManageChannels).await?;
    let taken = sqlx::query("SELECT 1 FROM channels WHERE server = $1 AND name = $2")
        .bind(&key)
        .bind(&channel_name)
        .fetch_optional(&state.db)
        .await?
        .is_some();
    if taken {
        return Err(bad("Channel name is taken"));
    }
    let id: i64 = sqlx::query(
        "INSERT INTO channels(server, name, kind, created_at) VALUES($1, $2, $3, $4) RETURNING id",
    )
    .bind(&key)
    .bind(&channel_name)
    .bind(kind.as_str())
    .bind(now())
    .fetch_one(&state.db)
    .await?
    .try_get(0)?;
    let channel = Channel {
        id,
        name: channel_name,
        kind,
        slowmode_seconds: 0,
    };
    state.hub.broadcast(WsEvent::ChannelCreated {
        server: key,
        channel: channel.clone(),
    });
    Ok(Json(channel))
}

#[utoipa::path(patch, path = "/api/channels/{id}", params(("id" = i64, Path)), request_body = ChannelPatch, responses((status = 200, body = Channel)), security(("bearer" = [])))]
pub(crate) async fn update_channel(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(req): Json<ChannelPatch>,
) -> Result<Json<Channel>, ApiError> {
    let ChannelPatch {
        name,
        slowmode_seconds,
    } = req;
    let server = channel_server(&state.db, id).await?;
    require_perm(&state.db, &server, &user, Perm::ManageChannels).await?;
    if let Some(name) = &name {
        let channel_name = name.trim().to_string();
        check_name(&state.db, &channel_name).await?;
        let taken =
            sqlx::query("SELECT 1 FROM channels WHERE server = $1 AND name = $2 AND id != $3")
                .bind(&server)
                .bind(&channel_name)
                .bind(id)
                .fetch_optional(&state.db)
                .await?
                .is_some();
        if taken {
            return Err(bad("Channel name is taken"));
        }
        sqlx::query("UPDATE channels SET name = $1 WHERE id = $2")
            .bind(&channel_name)
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    if let Some(secs) = slowmode_seconds {
        sqlx::query("UPDATE channels SET slowmode_seconds = $1 WHERE id = $2")
            .bind(secs.max(0))
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    let row = sqlx::query("SELECT name, kind, slowmode_seconds FROM channels WHERE id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    let channel = Channel {
        id,
        name: row.try_get(0)?,
        kind: ChannelKind::parse(&row.try_get::<String, _>(1)?)?,
        slowmode_seconds: row.try_get(2)?,
    };
    state.hub.broadcast(WsEvent::ChannelRenamed {
        server,
        channel: channel.clone(),
    });
    Ok(Json(channel))
}

#[utoipa::path(delete, path = "/api/channels/{id}", params(("id" = i64, Path)), responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn delete_channel(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<OkResp>, ApiError> {
    let row = sqlx::query("SELECT server, kind FROM channels WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let (server, kind): (String, ChannelKind) = match &row {
        Some(r) => (
            r.try_get(0)?,
            ChannelKind::parse(&r.try_get::<String, _>(1)?)?,
        ),
        None => return Err(not_found("Channel not found")),
    };
    require_perm(&state.db, &server, &user, Perm::ManageChannels).await?;
    let count: i64 = sqlx::query("SELECT COUNT(*) FROM channels WHERE server = $1")
        .bind(&server)
        .fetch_one(&state.db)
        .await?
        .try_get(0)?;
    if count <= 1 {
        return Err(bad("Cannot delete the only channel"));
    }
    if kind == ChannelKind::Text {
        let text_count: i64 =
            sqlx::query("SELECT COUNT(*) FROM channels WHERE server = $1 AND kind = 'text'")
                .bind(&server)
                .fetch_one(&state.db)
                .await?
                .try_get(0)?;
        if text_count <= 1 {
            return Err(bad("Cannot delete the only text channel"));
        }
    }
    sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    state.hub.broadcast(WsEvent::ChannelDeleted {
        server,
        channel_id: id,
    });
    Ok(ok())
}

#[utoipa::path(post, path = "/api/servers/{name}/kick", params(("name" = String, Path)), request_body = UsernameReq, responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn kick_member(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    let target = req.username.to_lowercase();
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::Kick).await?;
    let removed = sqlx::query("DELETE FROM members WHERE server = $1 AND username = $2")
        .bind(&key)
        .bind(&target)
        .execute(&state.db)
        .await?
        .rows_affected();
    match removed {
        0 => Err(not_found("Not a member")),
        _ => {
            sqlx::query("DELETE FROM user_roles WHERE server = $1 AND username = $2")
                .bind(&key)
                .bind(&target)
                .execute(&state.db)
                .await?;
            state.hub.broadcast(WsEvent::MemberKicked {
                server: key.clone(),
                username: target.clone(),
            });
            state.hub.force_offline(&key, &target);
            Ok(ok())
        }
    }
}

async fn set_admin(
    state: &AppState,
    actor: &User,
    server: &str,
    target: &str,
    is_admin: bool,
) -> Result<Json<OkResp>, ApiError> {
    require_server(&state.db, server).await?;
    require_perm(&state.db, server, actor, Perm::ManageAdmins).await?;
    let changed = sqlx::query(
        "UPDATE members SET is_admin = $1, perms = 0 WHERE server = $2 AND username = $3",
    )
    .bind(i64::from(is_admin))
    .bind(server)
    .bind(target)
    .execute(&state.db)
    .await?
    .rows_affected();
    match changed {
        0 => Err(not_found("Not a member")),
        _ => {
            state.hub.broadcast(WsEvent::AdminChanged {
                server: server.to_string(),
                username: target.to_string(),
                is_admin,
                perms: 0,
            });
            Ok(ok())
        }
    }
}

#[utoipa::path(post, path = "/api/servers/{name}/admins", params(("name" = String, Path)), request_body = UsernameReq, responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn grant_admin(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    set_admin(
        &state,
        &user,
        &name.to_lowercase(),
        &req.username.to_lowercase(),
        true,
    )
    .await
}

#[utoipa::path(delete, path = "/api/servers/{name}/admins/{username}", params(("name" = String, Path), ("username" = String, Path)), responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn revoke_admin(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, target)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    set_admin(
        &state,
        &user,
        &name.to_lowercase(),
        &target.to_lowercase(),
        false,
    )
    .await
}

#[utoipa::path(post, path = "/api/servers/{name}/transfer_admin", params(("name" = String, Path)), request_body = UsernameReq, responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn transfer_admin(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    let target = req.username.to_lowercase();
    if target == user.username {
        return Err(bad("Cannot transfer to yourself"));
    }
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::ManageAdmins).await?;
    let mut tx = state.db.begin().await?;
    let granted =
        sqlx::query("UPDATE members SET is_admin = 1 WHERE server = $1 AND username = $2")
            .bind(&key)
            .bind(&target)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if granted == 0 {
        return Err(not_found("Not a member"));
    }
    let revoked =
        sqlx::query("UPDATE members SET is_admin = 0 WHERE server = $1 AND username = $2")
            .bind(&key)
            .bind(&user.username)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    tx.commit().await?;
    state.hub.broadcast(WsEvent::AdminChanged {
        server: key.clone(),
        username: target,
        is_admin: true,
        perms: 0,
    });
    if revoked > 0 {
        state.hub.broadcast(WsEvent::AdminChanged {
            server: key,
            username: user.username,
            is_admin: false,
            perms: 0,
        });
    }
    Ok(ok())
}

#[utoipa::path(patch, path = "/api/servers/{name}/admins/{username}/perms", params(("name" = String, Path), ("username" = String, Path)), request_body = PermsReq, responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn set_admin_perms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, target)): Path<(String, String)>,
    Json(req): Json<PermsReq>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    let target = target.to_lowercase();
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::ManageAdmins).await?;
    let changed = sqlx::query(
        "UPDATE members SET perms = $1 WHERE server = $2 AND username = $3 AND is_admin != 0",
    )
    .bind(req.perms & ALL_PERMS)
    .bind(&key)
    .bind(&target)
    .execute(&state.db)
    .await?
    .rows_affected();
    match changed {
        0 => Err(not_found("Not an admin")),
        _ => {
            state.hub.broadcast(WsEvent::AdminChanged {
                server: key,
                username: target,
                is_admin: true,
                perms: req.perms & ALL_PERMS,
            });
            Ok(ok())
        }
    }
}

async fn require_role(db: &Db, server: &str, id: i64) -> Result<(), ApiError> {
    let found = sqlx::query("SELECT 1 FROM roles WHERE id = $1 AND server = $2")
        .bind(id)
        .bind(server)
        .fetch_optional(db)
        .await?
        .is_some();
    match found {
        true => Ok(()),
        false => Err(not_found("Role not found")),
    }
}

async fn role_guard(state: &AppState, name: &str, user: &User) -> Result<String, ApiError> {
    let key = name.to_lowercase();
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, user, Perm::ManageAdmins).await?;
    Ok(key)
}

fn check_color(color: &str) -> Result<(), ApiError> {
    match valid_color(color) {
        true => Ok(()),
        false => Err(bad("Invalid color")),
    }
}

#[utoipa::path(post, path = "/api/servers/{name}/roles", params(("name" = String, Path)), request_body = RoleReq, responses((status = 200, body = Role)), security(("bearer" = [])))]
pub(crate) async fn create_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<RoleReq>,
) -> Result<Json<Role>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    let role_name = req.name.trim().to_string();
    check_name(&state.db, &role_name).await?;
    check_color(&req.color)?;
    let perms = req.perms & ALL_PERMS;
    let id: i64 = sqlx::query(
        "INSERT INTO roles(server, name, color, perms) VALUES($1, $2, $3, $4) RETURNING id",
    )
    .bind(&key)
    .bind(&role_name)
    .bind(&req.color)
    .bind(perms)
    .fetch_one(&state.db)
    .await?
    .try_get(0)?;
    state.hub.broadcast(WsEvent::RolesChanged { server: key });
    Ok(Json(Role {
        id,
        name: role_name,
        color: req.color,
        perms,
    }))
}

#[utoipa::path(patch, path = "/api/servers/{name}/roles/{id}", params(("name" = String, Path), ("id" = i64, Path)), request_body = RolePatch, responses((status = 200, body = Role)), security(("bearer" = [])))]
pub(crate) async fn update_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
    Json(req): Json<RolePatch>,
) -> Result<Json<Role>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    require_role(&state.db, &key, id).await?;
    let RolePatch { name, color, perms } = req;
    if let Some(role_name) = &name {
        let role_name = role_name.trim().to_string();
        check_name(&state.db, &role_name).await?;
        sqlx::query("UPDATE roles SET name = $1 WHERE id = $2")
            .bind(&role_name)
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    if let Some(color) = &color {
        check_color(color)?;
        sqlx::query("UPDATE roles SET color = $1 WHERE id = $2")
            .bind(color)
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    if let Some(perms) = perms {
        sqlx::query("UPDATE roles SET perms = $1 WHERE id = $2")
            .bind(perms & ALL_PERMS)
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    let row = sqlx::query("SELECT name, color, perms FROM roles WHERE id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    let role = Role {
        id,
        name: row.try_get(0)?,
        color: row.try_get(1)?,
        perms: row.try_get(2)?,
    };
    state.hub.broadcast(WsEvent::RolesChanged {
        server: key.clone(),
    });
    evict_unviewable(&state, &key, None).await;
    Ok(Json(role))
}

#[utoipa::path(delete, path = "/api/servers/{name}/roles/{id}", params(("name" = String, Path), ("id" = i64, Path)), responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn delete_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<OkResp>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    require_role(&state.db, &key, id).await?;
    sqlx::query("DELETE FROM roles WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM channel_perms WHERE subject = $1")
        .bind(format!("r:{id}"))
        .execute(&state.db)
        .await?;
    state.hub.broadcast(WsEvent::RolesChanged {
        server: key.clone(),
    });
    evict_unviewable(&state, &key, None).await;
    Ok(ok())
}

#[utoipa::path(post, path = "/api/servers/{name}/roles/{id}/assign", params(("name" = String, Path), ("id" = i64, Path)), request_body = UsernameReq, responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn assign_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    require_role(&state.db, &key, id).await?;
    let target = req.username.to_lowercase();
    let member = sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
        .bind(&key)
        .bind(&target)
        .fetch_optional(&state.db)
        .await?
        .is_some();
    if !member {
        return Err(not_found("Not a member"));
    }
    sqlx::query(
        "INSERT INTO user_roles(server, username, role_id) VALUES($1, $2, $3) ON CONFLICT(server, username, role_id) DO NOTHING",
    )
    .bind(&key)
    .bind(&target)
    .bind(id)
    .execute(&state.db)
    .await?;
    state.hub.broadcast(WsEvent::RolesChanged { server: key });
    Ok(ok())
}

#[utoipa::path(delete, path = "/api/servers/{name}/roles/{id}/assign/{username}", params(("name" = String, Path), ("id" = i64, Path), ("username" = String, Path)), responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn unassign_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id, target)): Path<(String, i64, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    require_role(&state.db, &key, id).await?;
    let removed =
        sqlx::query("DELETE FROM user_roles WHERE server = $1 AND username = $2 AND role_id = $3")
            .bind(&key)
            .bind(target.to_lowercase())
            .bind(id)
            .execute(&state.db)
            .await?
            .rows_affected();
    match removed {
        0 => Err(not_found("Not assigned")),
        _ => {
            state.hub.broadcast(WsEvent::RolesChanged {
                server: key.clone(),
            });
            evict_unviewable(&state, &key, None).await;
            Ok(ok())
        }
    }
}

async fn channel_perm_guard(state: &AppState, id: i64, user: &User) -> Result<String, ApiError> {
    let server = channel_server(&state.db, id).await?;
    require_perm(&state.db, &server, user, Perm::ManageChannels).await?;
    Ok(server)
}

async fn check_subject(db: &Db, server: &str, subject: &str) -> Result<(), ApiError> {
    match subject.split_once(':') {
        Some(("u", name)) => match get_user(db, name).await? {
            Some(_) => Ok(()),
            None => Err(not_found("User not found")),
        },
        Some(("r", id)) => {
            let id: i64 = id.parse().map_err(|_| bad("Invalid subject"))?;
            require_role(db, server, id).await
        }
        Some((_, _)) | None => Err(bad("Invalid subject")),
    }
}

#[utoipa::path(get, path = "/api/channels/{id}/perms", params(("id" = i64, Path)), responses((status = 200, body = Vec<ChannelPerm>)), security(("bearer" = [])))]
pub(crate) async fn list_channel_perms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<Vec<ChannelPerm>>, ApiError> {
    channel_perm_guard(&state, id, &user).await?;
    let rows = sqlx::query(
        "SELECT subject, can_view, can_send, can_read_history FROM channel_perms WHERE channel_id = $1 ORDER BY subject",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let mut perms = Vec::with_capacity(rows.len());
    for r in &rows {
        perms.push(ChannelPerm {
            subject: r.try_get(0)?,
            can_view: r.try_get::<i64, _>(1)? != 0,
            can_send: r.try_get::<i64, _>(2)? != 0,
            can_read_history: r.try_get::<i64, _>(3)? != 0,
        });
    }
    Ok(Json(perms))
}

#[utoipa::path(put, path = "/api/channels/{id}/perms", params(("id" = i64, Path)), request_body = ChannelPerm, responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn set_channel_perm(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(req): Json<ChannelPerm>,
) -> Result<Json<OkResp>, ApiError> {
    let server = channel_perm_guard(&state, id, &user).await?;
    let ChannelPerm {
        subject,
        can_view,
        can_send,
        can_read_history,
    } = req;
    let subject = subject.to_lowercase();
    check_subject(&state.db, &server, &subject).await?;
    sqlx::query(
        "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, $3, $4, $5) ON CONFLICT(channel_id, subject) DO UPDATE SET can_view = excluded.can_view, can_send = excluded.can_send, can_read_history = excluded.can_read_history",
    )
    .bind(id)
    .bind(&subject)
    .bind(i64::from(can_view))
    .bind(i64::from(can_send))
    .bind(i64::from(can_read_history))
    .execute(&state.db)
    .await?;
    state.hub.broadcast(WsEvent::ChannelPermsChanged {
        server: server.clone(),
        channel_id: id,
    });
    evict_unviewable(&state, &server, Some(id)).await;
    Ok(ok())
}

#[utoipa::path(delete, path = "/api/channels/{id}/perms/{subject}", params(("id" = i64, Path), ("subject" = String, Path)), responses((status = 200, body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn clear_channel_perm(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((id, subject)): Path<(i64, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let server = channel_perm_guard(&state, id, &user).await?;
    let removed = sqlx::query("DELETE FROM channel_perms WHERE channel_id = $1 AND subject = $2")
        .bind(id)
        .bind(subject.to_lowercase())
        .execute(&state.db)
        .await?
        .rows_affected();
    match removed {
        0 => Err(not_found("No such rule")),
        _ => {
            state.hub.broadcast(WsEvent::ChannelPermsChanged {
                server: server.clone(),
                channel_id: id,
            });
            evict_unviewable(&state, &server, Some(id)).await;
            Ok(ok())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{done, mem_user, temp_state};

    #[tokio::test]
    async fn sole_channel_guard() {
        let (state, path) = temp_state("sole_channel").await;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(&state.db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id");
        let blocked = delete_channel(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Path(cid),
        )
        .await;
        assert!(matches!(blocked, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        let extra: i64 = sqlx::query(
            "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'second', $1) RETURNING id",
        )
        .bind(now())
        .fetch_one(&state.db)
        .await
        .expect("insert channel")
        .try_get(0)
        .expect("extra id");
        let _ = delete_channel(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Path(extra),
        )
        .await
        .expect("delete second channel");
        let count: i64 = sqlx::query("SELECT COUNT(*) FROM channels WHERE server = 'rchat'")
            .fetch_one(&state.db)
            .await
            .expect("count channels")
            .try_get(0)
            .expect("count");
        assert_eq!(count, 1);
        sqlx::query(
            "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', $1)",
        )
        .bind(now())
        .execute(&state.db)
        .await
        .expect("insert voice channel");
        let sole_text = delete_channel(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Path(cid),
        )
        .await;
        assert!(matches!(
            sole_text,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        done(state, path).await;
    }
}
