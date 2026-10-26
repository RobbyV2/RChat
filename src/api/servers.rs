use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::admin::{fuzzy_match, is_fuzzy, like_pattern};
use crate::api::auth::{hash_password, new_token, verify_password};
use crate::api::{
    ApiError, Authed, Channel, ChannelPerm, MaybeAuthed, Member, NAME_MAX, Role, SLOWMODE_MAX,
    ServerDetail, ServerSummary, ServerSummaryLite, UserRef, check_len, check_profanity,
    page_bounds, placeholders, require_guest_ok, require_server_view, unique_capped, user_from,
    user_ref, user_refs, valid_color,
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

#[derive(IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MyServersQuery {
    offset: Option<i64>,
    limit: Option<i64>,
    names: Option<Vec<String>>,
}

impl MyServersQuery {
    fn parse(raw: &str) -> Result<MyServersQuery, ApiError> {
        let int = |v: &str| v.parse::<i64>().map_err(|_| bad("Invalid number"));
        let mut q = MyServersQuery {
            offset: None,
            limit: None,
            names: None,
        };
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "offset" => q.offset = Some(int(&value)?),
                "limit" => q.limit = Some(int(&value)?),
                "names" => q
                    .names
                    .get_or_insert_with(Vec::new)
                    .push(value.into_owned()),
                _ => {}
            }
        }
        Ok(q)
    }
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

async fn check_name(db: &Db, what: &str, name: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(bad("Name required"));
    }
    check_len(name, NAME_MAX, what)?;
    check_profanity(db, name).await
}

async fn check_server_name(db: &Db, name: &str) -> Result<(), ApiError> {
    check_name(db, "Server name", name).await?;
    match name {
        "." | ".." => Err(bad("Server name cannot be \".\" or \"..\"")),
        _ => Ok(()),
    }
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

async fn role_ids_of(
    db: &Db,
    server: &str,
    names: &[String],
) -> Result<HashMap<String, Vec<i64>>, ApiError> {
    let mut map: HashMap<String, Vec<i64>> = HashMap::new();
    if names.is_empty() {
        return Ok(map);
    }
    let sql = format!(
        "SELECT username, role_id FROM user_roles WHERE server = $1 AND username IN ({}) ORDER BY role_id",
        placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for name in names {
        query = query.bind(name);
    }
    for r in &query.fetch_all(db).await? {
        map.entry(r.try_get(0)?).or_default().push(r.try_get(1)?);
    }
    Ok(map)
}

const MY_SERVERS: &str = "SELECT s.name, s.display_name, s.creator, m.is_admin FROM members m JOIN servers s ON s.name = m.server WHERE m.username = $1";

fn summary_rows(rows: &[sqlx::any::AnyRow]) -> Result<Vec<ServerSummary>, ApiError> {
    let mut servers = Vec::with_capacity(rows.len());
    for r in rows {
        servers.push(ServerSummary {
            name: r.try_get(0)?,
            display_name: r.try_get(1)?,
            creator: r.try_get(2)?,
            is_admin: r.try_get::<i64, _>(3)? != 0,
        });
    }
    Ok(servers)
}

pub(crate) async fn my_servers_page(
    db: &Db,
    username: &str,
    offset: i64,
    limit: i64,
) -> Result<(Vec<ServerSummary>, bool), ApiError> {
    let sql = format!("{MY_SERVERS} ORDER BY m.joined_at, s.name LIMIT $2 OFFSET $3");
    let mut rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(username)
        .bind(limit + 1)
        .bind(offset)
        .fetch_all(db)
        .await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    Ok((summary_rows(&rows)?, more))
}

pub(crate) async fn my_servers_by_names(
    db: &Db,
    username: &str,
    names: &[String],
) -> Result<Vec<ServerSummary>, ApiError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "{MY_SERVERS} AND m.server IN ({}) ORDER BY m.joined_at, s.name",
        placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(username);
    for name in names {
        query = query.bind(name);
    }
    summary_rows(&query.fetch_all(db).await?)
}

#[utoipa::path(get, path = "/api/me/servers", params(MyServersQuery), responses((status = 200, description = "A page (`offset`, `limit` default 50, max 100) of the servers the signed-in user joined, oldest membership first. With `names` (repeated once per server, e.g. `names=a&names=b`, max 100) returns just those servers, skipping ones the user is not a member of", body = Vec<ServerSummary>)), security(("bearer" = [])))]
pub(crate) async fn list_my_servers(
    State(state): State<AppState>,
    Authed(user): Authed,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<ServerSummary>>, ApiError> {
    let MyServersQuery {
        offset,
        limit,
        names,
    } = MyServersQuery::parse(raw.as_deref().unwrap_or(""))?;
    match names {
        Some(names) => Ok(Json(
            my_servers_by_names(
                &state.db,
                &user.username,
                &unique_capped(names.iter().map(|n| n.to_lowercase())),
            )
            .await?,
        )),
        None => {
            let (offset, limit) = page_bounds(offset, limit);
            Ok(Json(
                my_servers_page(&state.db, &user.username, offset, limit)
                    .await?
                    .0,
            ))
        }
    }
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

#[utoipa::path(get, path = "/api/servers/{name}/members", params(("name" = String, Path), MembersQuery), responses((status = 200, description = "Up to 50 members, online first and then alphabetical", body = Vec<Member>)), security((), ("bearer" = [])))]
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
    let rows: Vec<(String, i64, i64)> = on.into_iter().skip(offset).take(limit).collect();
    let names: Vec<String> = rows.iter().map(|(name, _, _)| name.clone()).collect();
    let refs = user_refs(&state.db, &names).await;
    let mut roles = role_ids_of(&state.db, &key, &names).await?;
    let members = rows
        .into_iter()
        .map(|(username, is_admin, perms)| Member {
            online: online.contains(&username),
            is_admin: is_admin != 0,
            is_creator: creator.as_deref() == Some(username.as_str()),
            perms,
            role_ids: roles.remove(&username).unwrap_or_default(),
            user: user_from(&refs, &username),
        })
        .collect();
    Ok(Json(members))
}

#[utoipa::path(get, path = "/api/servers/{name}/interacted", params(("name" = String, Path), MembersQuery), responses((status = 200, description = "Up to 50 non-members who interacted with the server, most recent first", body = Vec<UserRef>)), security((), ("bearer" = [])))]
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
    let mut names = Vec::with_capacity(rows.len());
    for r in &rows {
        names.push(r.try_get::<String, _>(0)?);
    }
    let refs = user_refs(&state.db, &names).await;
    Ok(Json(names.iter().map(|n| user_from(&refs, n)).collect()))
}

#[utoipa::path(post, path = "/api/servers", request_body = CreateServerReq, responses((status = 200, description = "The created server, with the caller as admin and a default general channel", body = ServerDetail)), security(("bearer" = [])))]
pub(crate) async fn create_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<CreateServerReq>,
) -> Result<Json<ServerDetail>, ApiError> {
    let display = req.name.trim().to_string();
    let key = display.to_lowercase();
    check_server_name(&state.db, &display).await?;
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

#[utoipa::path(get, path = "/api/servers/{name}", params(("name" = String, Path)), responses((status = 200, description = "Server details: channels, roles, and member and online counts", body = ServerDetail)), security((), ("bearer" = [])))]
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

#[utoipa::path(get, path = "/api/servers/{name}/exists", params(("name" = String, Path)), responses((status = 200, description = "The server exists; reports whether it is password-protected", body = ServerExists)), security((), ("bearer" = [])))]
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

#[utoipa::path(get, path = "/api/server_search", params(ServerSearchQuery), responses((status = 200, description = "Up to 10 servers whose name or display name matches the query", body = Vec<ServerMatch>)), security((), ("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/servers/{name}/guest_access", params(("name" = String, Path)), request_body = GuestAccessReq, responses((status = 200, description = "Password accepted; returns a guest grant for viewing the server without an account", body = GuestGrant), (status = 401, description = "Wrong password"), (status = 400, description = "Server has no password")))]
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

#[utoipa::path(post, path = "/api/servers/{name}/join", params(("name" = String, Path)), request_body = JoinReq, responses((status = 200, description = "Joined, or already a member; returns the server details", body = ServerDetail)), security(("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/servers/{name}/leave", params(("name" = String, Path)), responses((status = 200, description = "Left the server and dropped its roles", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(patch, path = "/api/servers/{name}", params(("name" = String, Path)), request_body = ServerPatch, responses((status = 200, description = "Server renamed or password changed; changing the password revokes existing guest grants", body = ServerSummaryLite)), security(("bearer" = [])))]
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
            check_server_name(&state.db, &display).await?;
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

#[utoipa::path(delete, path = "/api/servers/{name}", params(("name" = String, Path)), responses((status = 200, description = "Server deleted along with its channels, members, and roles", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/servers/{name}/channels", params(("name" = String, Path)), request_body = CreateChannelReq, responses((status = 200, description = "The created channel", body = Channel)), security(("bearer" = [])))]
pub(crate) async fn create_channel(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<CreateChannelReq>,
) -> Result<Json<Channel>, ApiError> {
    let key = name.to_lowercase();
    let channel_name = req.name.trim().to_string();
    let kind = req.kind.unwrap_or(ChannelKind::Text);
    check_name(&state.db, "Channel name", &channel_name).await?;
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

#[utoipa::path(patch, path = "/api/channels/{id}", params(("id" = i64, Path)), request_body = ChannelPatch, responses((status = 200, description = "The updated channel", body = Channel)), security(("bearer" = [])))]
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
    if let Some(secs) = slowmode_seconds {
        if !(0..=SLOWMODE_MAX).contains(&secs) {
            return Err(bad(&format!(
                "Slow mode must be between 0 and {SLOWMODE_MAX} seconds"
            )));
        }
        if kind == ChannelKind::Voice && secs != 0 {
            return Err(bad("Slow mode only applies to text channels"));
        }
    }
    let channel_name = match &name {
        Some(name) => {
            let channel_name = name.trim().to_string();
            check_name(&state.db, "Channel name", &channel_name).await?;
            Some(channel_name)
        }
        None => None,
    };
    if let Some(channel_name) = &channel_name {
        let taken =
            sqlx::query("SELECT 1 FROM channels WHERE server = $1 AND name = $2 AND id != $3")
                .bind(&server)
                .bind(channel_name)
                .bind(id)
                .fetch_optional(&state.db)
                .await?
                .is_some();
        if taken {
            return Err(bad("Channel name is taken"));
        }
        sqlx::query("UPDATE channels SET name = $1 WHERE id = $2")
            .bind(channel_name)
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    if let Some(secs) = slowmode_seconds {
        sqlx::query("UPDATE channels SET slowmode_seconds = $1 WHERE id = $2")
            .bind(secs)
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

#[utoipa::path(delete, path = "/api/channels/{id}", params(("id" = i64, Path)), responses((status = 200, description = "Channel deleted", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/servers/{name}/kick", params(("name" = String, Path)), request_body = UsernameReq, responses((status = 200, description = "Member removed from the server and their roles dropped", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/servers/{name}/admins", params(("name" = String, Path)), request_body = UsernameReq, responses((status = 200, description = "Member promoted to admin with permissions reset", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(delete, path = "/api/servers/{name}/admins/{username}", params(("name" = String, Path), ("username" = String, Path)), responses((status = 200, description = "Admin status and permissions revoked", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/servers/{name}/transfer_admin", params(("name" = String, Path)), request_body = UsernameReq, responses((status = 200, description = "Admin granted to the target member and revoked from the caller", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(patch, path = "/api/servers/{name}/admins/{username}/perms", params(("name" = String, Path), ("username" = String, Path)), request_body = PermsReq, responses((status = 200, description = "Admin permissions updated", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/servers/{name}/roles", params(("name" = String, Path)), request_body = RoleReq, responses((status = 200, description = "The created role", body = Role)), security(("bearer" = [])))]
pub(crate) async fn create_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<RoleReq>,
) -> Result<Json<Role>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    let role_name = req.name.trim().to_string();
    check_name(&state.db, "Role name", &role_name).await?;
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

#[utoipa::path(patch, path = "/api/servers/{name}/roles/{id}", params(("name" = String, Path), ("id" = i64, Path)), request_body = RolePatch, responses((status = 200, description = "The updated role", body = Role)), security(("bearer" = [])))]
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
        check_name(&state.db, "Role name", &role_name).await?;
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

#[utoipa::path(delete, path = "/api/servers/{name}/roles/{id}", params(("name" = String, Path), ("id" = i64, Path)), responses((status = 200, description = "Role deleted and removed from channel permission rules", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/servers/{name}/roles/{id}/assign", params(("name" = String, Path), ("id" = i64, Path)), request_body = UsernameReq, responses((status = 200, description = "Role assigned to the member", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(delete, path = "/api/servers/{name}/roles/{id}/assign/{username}", params(("name" = String, Path), ("id" = i64, Path), ("username" = String, Path)), responses((status = 200, description = "Role removed from the member", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(get, path = "/api/channels/{id}/perms", params(("id" = i64, Path)), responses((status = 200, description = "Permission rules on the channel, ordered by subject", body = Vec<ChannelPerm>)), security(("bearer" = [])))]
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

#[utoipa::path(put, path = "/api/channels/{id}/perms", params(("id" = i64, Path)), request_body = ChannelPerm, responses((status = 200, description = "Permission rule created or replaced for the subject", body = OkResp)), security(("bearer" = [])))]
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

#[utoipa::path(delete, path = "/api/channels/{id}/perms/{subject}", params(("id" = i64, Path), ("subject" = String, Path)), responses((status = 200, description = "Permission rule removed for the subject", body = OkResp)), security(("bearer" = [])))]
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
    use crate::api::test_util::{add_member, done, mem_user, temp_state};

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

    fn rejected<T>(res: Result<T, ApiError>) -> bool {
        matches!(res, Err(ApiError(StatusCode::BAD_REQUEST, _)))
    }

    async fn make_server(state: &AppState, name: &str) -> Result<Json<ServerDetail>, ApiError> {
        create_server(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Json(CreateServerReq {
                name: name.to_string(),
                password: None,
            }),
        )
        .await
    }

    async fn rename(state: &AppState, server: &str, name: &str) -> Result<(), ApiError> {
        update_server(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path(server.to_string()),
            Json(ServerPatch {
                name: Some(name.to_string()),
                password: None,
            }),
        )
        .await
        .map(|_| ())
    }

    #[tokio::test]
    async fn server_name_rules() {
        let (state, path) = temp_state("server_names").await;
        assert!(rejected(make_server(&state, &"é".repeat(101)).await));
        assert!(rejected(make_server(&state, ".").await));
        assert!(rejected(make_server(&state, " .. ").await));
        let long = "é".repeat(100);
        let detail = make_server(&state, &long).await.expect("100 chars ok").0;
        assert_eq!(detail.display_name, long);
        let _ = make_server(&state, "dots...")
            .await
            .expect("dots inside ok");
        assert!(rejected(rename(&state, "dots...", "..").await));
        assert!(rejected(rename(&state, "dots...", &"x".repeat(101)).await));
        rename(&state, "dots...", "a.b").await.expect("rename ok");
        done(state, path).await;
    }

    #[tokio::test]
    async fn channel_and_role_limits() {
        let (state, path) = temp_state("channel_limits").await;
        let _ = make_server(&state, "lim").await.expect("create server");
        let alice = || Authed(mem_user("alice", false));
        let channel = |name: String, kind: ChannelKind| {
            let state = state.clone();
            async move {
                create_channel(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path("lim".to_string()),
                    Json(CreateChannelReq {
                        name,
                        kind: Some(kind),
                    }),
                )
                .await
            }
        };
        assert!(rejected(channel("c".repeat(101), ChannelKind::Text).await));
        let text = channel("😀".repeat(100), ChannelKind::Text)
            .await
            .expect("100 emoji ok")
            .0;
        let voice = channel("lounge".to_string(), ChannelKind::Voice)
            .await
            .expect("voice")
            .0;
        let slow = |id: i64, secs: i64| {
            let state = state.clone();
            async move {
                update_channel(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path(id),
                    Json(ChannelPatch {
                        name: None,
                        slowmode_seconds: Some(secs),
                    }),
                )
                .await
            }
        };
        assert!(rejected(slow(text.id, -1).await));
        assert!(rejected(slow(text.id, SLOWMODE_MAX + 1).await));
        assert_eq!(
            slow(text.id, SLOWMODE_MAX)
                .await
                .expect("max slowmode")
                .0
                .slowmode_seconds,
            SLOWMODE_MAX
        );
        assert!(rejected(slow(voice.id, 5).await));
        let _ = slow(voice.id, 0).await.expect("zero on voice ok");
        let renamed = update_channel(
            State(state.clone()),
            alice(),
            Path(text.id),
            Json(ChannelPatch {
                name: Some("x".repeat(101)),
                slowmode_seconds: None,
            }),
        )
        .await;
        assert!(rejected(renamed));
        let role = |name: String| {
            let state = state.clone();
            async move {
                create_role(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path("lim".to_string()),
                    Json(RoleReq {
                        name,
                        color: "#ffffff".to_string(),
                        perms: 0,
                    }),
                )
                .await
            }
        };
        assert!(rejected(role("r".repeat(101)).await));
        let made = role("r".repeat(100)).await.expect("100 char role").0;
        let patched = update_role(
            State(state.clone()),
            alice(),
            Path(("lim".to_string(), made.id)),
            Json(RolePatch {
                name: Some("r".repeat(101)),
                color: None,
                perms: None,
            }),
        )
        .await;
        assert!(rejected(patched));
        done(state, path).await;
    }

    async fn my_servers(state: &AppState, raw: &str) -> Vec<String> {
        list_my_servers(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            RawQuery(Some(raw.to_string()).filter(|r| !r.is_empty())),
        )
        .await
        .expect("my servers")
        .0
        .into_iter()
        .map(|s| s.name)
        .collect()
    }

    #[tokio::test]
    async fn my_servers_order_paging_and_batch() {
        let (state, path) = temp_state("my_servers").await;
        let db = &state.db;
        for (name, joined) in [
            ("s1", 3),
            ("s2", 1),
            ("s4", 2),
            ("s3", 2),
            ("s5", 5),
            ("foo, bar", 6),
            ("a&b=c+d", 7),
        ] {
            sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES($1, $1, NULL, 0)")
                .bind(name)
                .execute(db)
                .await
                .expect("insert server");
            add_member(db, name, "alice", i64::from(name == "s3"), 0, joined).await;
        }
        add_member(db, "rchat", "bob", 0, 0, 0).await;
        let all = vec!["s2", "s3", "s4", "s1", "s5", "foo, bar", "a&b=c+d"];
        assert_eq!(my_servers(&state, "").await, all);
        assert_eq!(my_servers(&state, "offset=1&limit=2").await, all[1..3]);
        assert_eq!(my_servers(&state, "offset=6&limit=2").await, all[6..]);
        assert!(my_servers(&state, "offset=7").await.is_empty());
        let named = my_servers(
            &state,
            "names=S5&names=s1&names=rchat&names=nope&names=s1&names=&names=%20s2",
        )
        .await;
        assert_eq!(named, vec!["s1", "s5"]);
        let named = my_servers(&state, "names=Foo%2C%20Bar&names=a%26b%3Dc%2Bd&names=foo").await;
        assert_eq!(named, vec!["foo, bar", "a&b=c+d"]);
        let many: Vec<String> = (0..150).map(|n| format!("names=x{n}")).collect();
        let capped = format!("{}&names=s1", many[..99].join("&"));
        assert_eq!(my_servers(&state, &capped).await, vec!["s1"]);
        let capped = format!("{}&names=s1", many.join("&"));
        assert!(my_servers(&state, &capped).await.is_empty());
        assert!(
            list_my_servers(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                RawQuery(Some("offset=x".to_string())),
            )
            .await
            .is_err()
        );
        let (first, more) = my_servers_page(db, "alice", 0, 4).await.expect("page");
        assert_eq!(first.len(), 4);
        assert!(more);
        assert!(first[1].is_admin && !first[0].is_admin);
        let (_, more) = my_servers_page(db, "alice", 0, 7).await.expect("page");
        assert!(!more);
        done(state, path).await;
    }

    #[tokio::test]
    async fn members_batch_refs_and_roles() {
        let (state, path) = temp_state("members_batch").await;
        let db = &state.db;
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, avatar_color, created_at) VALUES('alice', 'Alice A', '', 'text', 'color', '#abcdef', 0)")
            .execute(db)
            .await
            .expect("insert user");
        for name in ["alice", "bob", "carol"] {
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        let mut roles = Vec::new();
        for name in ["r1", "r2"] {
            let id: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', $1, '#ffffff', 0) RETURNING id")
                .bind(name)
                .fetch_one(db)
                .await
                .expect("role")
                .try_get(0)
                .expect("role id");
            roles.push(id);
        }
        for (user, role) in [("bob", roles[1]), ("bob", roles[0]), ("carol", roles[1])] {
            sqlx::query(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', $1, $2)",
            )
            .bind(user)
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
        }
        let members = list_members(
            State(state.clone()),
            MaybeAuthed(None),
            HeaderMap::new(),
            Path("rchat".to_string()),
            Query(MembersQuery {
                offset: None,
                limit: None,
            }),
        )
        .await
        .expect("members")
        .0;
        let rows: Vec<(String, String, Vec<i64>)> = members
            .into_iter()
            .map(|m| (m.user.username, m.user.display_name, m.role_ids))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("alice".to_string(), "Alice A".to_string(), vec![]),
                ("bob".to_string(), "bob".to_string(), roles.clone()),
                ("carol".to_string(), "carol".to_string(), vec![roles[1]]),
            ]
        );
        done(state, path).await;
    }
}
