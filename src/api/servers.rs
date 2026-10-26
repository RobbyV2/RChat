use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::admin::{fuzzy_match, is_fuzzy, like_pattern};
use crate::api::auth::{hash_password, new_token, verify_password};
use crate::api::messages::recent_channel_messages;
use crate::api::{
    ApiError, Authed, Channel, ChannelPerm, MaybeAuthed, Member, Message, NAME_MAX, Role,
    SLOWMODE_MAX, ServerDetail, ServerSummary, ServerSummaryLite, UserRef, check_len,
    check_profanity, grant_matches, header_grants, page_bounds, placeholders, require_guest_ok,
    require_server_view, unique_capped, user_from, user_ref, user_refs, valid_color,
};
use crate::db::{
    ALL_PERMS, ChannelKind, Db, Perm, User, can_moderate, channel_access, effective_perms,
    get_user, has_perm, is_banned, member_perms, now,
};
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

#[derive(Serialize, ToSchema)]
pub struct ServerBan {
    #[serde(flatten)]
    pub user: UserRef,
    pub banned_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InviteStatus {
    Member,
    Banned,
    Joinable,
    PasswordRequired,
}

#[derive(Serialize, ToSchema)]
pub struct Invite {
    pub server: ServerSummaryLite,
    pub member_count: Option<i64>,
    pub online_count: Option<i64>,
    pub status: InviteStatus,
    pub preview_channel: Option<String>,
    pub preview: Vec<Message>,
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

type PagedList = (Option<i64>, Option<i64>, Option<Vec<String>>);

fn paged_list(raw: &str, list_key: &str) -> Result<PagedList, ApiError> {
    let int = |v: &str| v.parse::<i64>().map_err(|_| bad("Invalid number"));
    let mut offset = None;
    let mut limit = None;
    let mut list: Option<Vec<String>> = None;
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        match key.as_ref() {
            "offset" => offset = Some(int(&value)?),
            "limit" => limit = Some(int(&value)?),
            k if k == list_key => list.get_or_insert_with(Vec::new).push(value.into_owned()),
            _ => {}
        }
    }
    Ok((offset, limit, list))
}

impl MyServersQuery {
    fn parse(raw: &str) -> Result<MyServersQuery, ApiError> {
        let (offset, limit, names) = paged_list(raw, "names")?;
        Ok(MyServersQuery {
            offset,
            limit,
            names,
        })
    }
}

#[derive(IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MemberListQuery {
    offset: Option<i64>,
    limit: Option<i64>,
    usernames: Option<Vec<String>>,
}

impl MemberListQuery {
    fn parse(raw: &str) -> Result<MemberListQuery, ApiError> {
        let (offset, limit, usernames) = paged_list(raw, "usernames")?;
        Ok(MemberListQuery {
            offset,
            limit,
            usernames,
        })
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

async fn require_moderate(
    db: &Db,
    server: &str,
    actor: &User,
    target: &str,
) -> Result<(), ApiError> {
    let mine = effective_perms(db, server, actor).await?;
    let theirs = member_perms(db, server, target).await?;
    match can_moderate(mine, actor.is_site_admin, theirs) {
        true => Ok(()),
        false => Err(forbidden("You can't moderate this member")),
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

type MemberRow = (String, i64, i64);

fn member_rows(rows: &[sqlx::any::AnyRow]) -> Result<Vec<MemberRow>, ApiError> {
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push((r.try_get(0)?, r.try_get(1)?, r.try_get(2)?));
    }
    Ok(out)
}

async fn members_by_names(
    db: &Db,
    server: &str,
    names: &[String],
) -> Result<Vec<MemberRow>, ApiError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT username, is_admin, perms FROM members WHERE server = $1 AND username IN ({}) ORDER BY username",
        placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for name in names {
        query = query.bind(name);
    }
    member_rows(&query.fetch_all(db).await?)
}

async fn members_page(
    db: &Db,
    server: &str,
    online: &HashSet<String>,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<MemberRow>, ApiError> {
    let offset = offset.unwrap_or(0).max(0) as usize;
    let limit = limit.unwrap_or(50).clamp(1, 50) as usize;
    let rows = sqlx::query(
        "SELECT username, is_admin, perms FROM members WHERE server = $1 ORDER BY username",
    )
    .bind(server)
    .fetch_all(db)
    .await?;
    let (mut on, mut off): (Vec<MemberRow>, Vec<MemberRow>) = member_rows(&rows)?
        .into_iter()
        .partition(|(username, _, _)| online.contains(username));
    on.append(&mut off);
    Ok(on.into_iter().skip(offset).take(limit).collect())
}

#[utoipa::path(get, path = "/api/servers/{name}/members", params(("name" = String, Path), MemberListQuery), responses((status = 200, description = "A page (`offset`, `limit` default and max 50) of members, online first and then alphabetical. With `usernames` (repeated once per user, e.g. `usernames=a&usernames=b`, max 100) returns just those users that are members, alphabetical, skipping the rest", body = Vec<Member>)), security((), ("bearer" = [])))]
pub(crate) async fn list_members(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<Member>>, ApiError> {
    let MemberListQuery {
        offset,
        limit,
        usernames,
    } = MemberListQuery::parse(raw.as_deref().unwrap_or(""))?;
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    let lite = require_server(&state.db, &key).await?;
    require_server_view(&state.db, &headers, &lite, viewer.as_ref()).await?;
    let creator = lite.creator;
    let online = state.hub.online_set(&key);
    let rows = match usernames {
        Some(names) => {
            members_by_names(
                &state.db,
                &key,
                &unique_capped(names.iter().map(|n| n.to_lowercase())),
            )
            .await?
        }
        None => members_page(&state.db, &key, &online, offset, limit).await?,
    };
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

const INVITE_PREVIEW: i64 = 3;

async fn is_member(db: &Db, server: &str, username: &str) -> Result<bool, ApiError> {
    Ok(
        sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(username)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
}

fn invite_password(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("x-invite-password")?.to_str().ok()?;
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    match decoded.trim() {
        "" => None,
        password => Some(password.to_string()),
    }
}

async fn invite_unlocked(
    db: &Db,
    headers: &HeaderMap,
    server: &str,
    viewer: Option<&User>,
) -> Result<bool, ApiError> {
    if viewer.is_none() {
        for grant in header_grants(headers) {
            if grant_matches(db, &grant, server).await? {
                return Ok(true);
            }
        }
    }
    let given = match invite_password(headers) {
        Some(password) => password,
        None => return Ok(false),
    };
    let hash: Option<String> = sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
        .bind(server)
        .fetch_one(db)
        .await?
        .try_get(0)?;
    Ok(match hash {
        Some(hash) => verify_password(&given, &hash),
        None => false,
    })
}

async fn invite_preview(db: &Db, server: &str) -> Result<(Option<String>, Vec<Message>), ApiError> {
    let row = sqlx::query(
        "SELECT c.id, c.name FROM channels c WHERE c.server = $1 AND c.kind = 'text' AND NOT EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = c.id) ORDER BY c.id LIMIT 1",
    )
    .bind(server)
    .fetch_optional(db)
    .await?;
    match row {
        Some(r) => Ok((
            Some(r.try_get(1)?),
            recent_channel_messages(db, r.try_get(0)?, INVITE_PREVIEW).await?,
        )),
        None => Ok((None, Vec::new())),
    }
}

#[utoipa::path(get, path = "/api/invites/{name}", params(("name" = String, Path), ("X-Invite-Password" = Option<String>, Header, description = "Percent-encoded server password from the invite link")), responses((status = 200, description = "Invite card for the server: member and online counts (null unless the server has no password, the viewer is a member, or the password header or a guest grant is valid), the viewer's status (`member`, `banned`, `joinable` or `password_required`; guests never get `member` or `banned`) and the last few top-level messages of the first text channel anyone may view. The preview is empty for banned viewers, and otherwise unless the server has no password, the viewer is a member, or the password header (or a guest grant) is valid", body = Invite), (status = 404, description = "Invalid invite: the server does not exist")), security((), ("bearer" = [])))]
pub(crate) async fn get_invite(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Invite>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    let server = require_server(&state.db, &key).await?;
    let member = match &viewer {
        Some(user) => is_member(&state.db, &key, &user.username).await?,
        None => false,
    };
    let banned = match &viewer {
        Some(user) if !member => is_banned(&state.db, &key, &user.username).await?,
        _ => false,
    };
    let open = !server.has_password
        || member
        || invite_unlocked(&state.db, &headers, &key, viewer.as_ref()).await?;
    let unlocked = !banned && open;
    let status = match (member, banned, unlocked) {
        (true, _, _) => InviteStatus::Member,
        (false, true, _) => InviteStatus::Banned,
        (false, false, true) => InviteStatus::Joinable,
        (false, false, false) => InviteStatus::PasswordRequired,
    };
    let (preview_channel, preview) = match unlocked {
        true => invite_preview(&state.db, &key).await?,
        false => (None, Vec::new()),
    };
    let (member_count, online_count) = match open {
        true => {
            let members: i64 = sqlx::query("SELECT COUNT(*) FROM members WHERE server = $1")
                .bind(&key)
                .fetch_one(&state.db)
                .await?
                .try_get(0)?;
            (Some(members), Some(state.hub.online_count(&key)))
        }
        false => (None, None),
    };
    Ok(Json(Invite {
        online_count,
        server,
        member_count,
        status,
        preview_channel,
        preview,
    }))
}

async fn insert_member(db: &Db, server: &str, username: &str) -> Result<bool, ApiError> {
    let inserted = sqlx::query(
        "INSERT INTO members(server, username, is_admin, joined_at) SELECT $1, $2, 0, $3 WHERE NOT EXISTS(SELECT 1 FROM server_bans WHERE server = $1 AND username = $2) ON CONFLICT(server, username) DO NOTHING",
    )
    .bind(server)
    .bind(username)
    .bind(now())
    .execute(db)
    .await?
    .rows_affected();
    if inserted > 0 {
        return Ok(true);
    }
    let member = sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
        .bind(server)
        .bind(username)
        .fetch_optional(db)
        .await?
        .is_some();
    match !member && is_banned(db, server, username).await? {
        true => Err(forbidden("You are banned from this server")),
        false => Ok(false),
    }
}

#[utoipa::path(post, path = "/api/servers/{name}/join", params(("name" = String, Path)), request_body = JoinReq, responses((status = 200, description = "Joined, or already a member; returns the server details", body = ServerDetail), (status = 401, description = "Wrong password"), (status = 403, description = "You are banned from this server")), security(("bearer" = [])))]
pub(crate) async fn join_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    body: Option<Json<JoinReq>>,
) -> Result<Json<ServerDetail>, ApiError> {
    let key = name.to_lowercase();
    let lite = require_server(&state.db, &key).await?;
    if is_banned(&state.db, &key, &user.username).await? {
        return Err(forbidden("You are banned from this server"));
    }
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
    let inserted = insert_member(&state.db, &key, &user.username).await?;
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
    if inserted {
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

#[utoipa::path(post, path = "/api/servers/{name}/kick", params(("name" = String, Path)), request_body = UsernameReq, responses((status = 200, description = "Member removed from the server and their roles dropped", body = OkResp), (status = 403, description = "Missing permission, or the member's server permissions are not a strict subset of yours")), security(("bearer" = [])))]
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
    require_moderate(&state.db, &key, &user, &target).await?;
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
                banned: false,
            });
            state.hub.force_offline(&key, &target);
            Ok(ok())
        }
    }
}

#[utoipa::path(post, path = "/api/servers/{name}/bans", params(("name" = String, Path)), request_body = UsernameReq, responses((status = 200, description = "User banned: removed from the server with their roles dropped and voice ended, and blocked from rejoining until unbanned. Works on non-members too. Requires the Kick permission", body = OkResp), (status = 400, description = "You can't ban yourself"), (status = 403, description = "Missing permission, or the user's server permissions are not a strict subset of yours")), security(("bearer" = [])))]
pub(crate) async fn ban_member(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    let target = req.username.to_lowercase();
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::Kick).await?;
    if target == user.username {
        return Err(bad("You can't ban yourself"));
    }
    if get_user(&state.db, &target).await?.is_none() {
        return Err(not_found("User not found"));
    }
    require_moderate(&state.db, &key, &user, &target).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES($1, $2, $3, $4) ON CONFLICT(server, username) DO NOTHING",
    )
    .bind(&key)
    .bind(&target)
    .bind(&user.username)
    .bind(now())
    .execute(&mut *tx)
    .await?;
    let removed = sqlx::query("DELETE FROM members WHERE server = $1 AND username = $2")
        .bind(&key)
        .bind(&target)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    sqlx::query("DELETE FROM user_roles WHERE server = $1 AND username = $2")
        .bind(&key)
        .bind(&target)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if removed > 0 {
        state.hub.broadcast(WsEvent::MemberKicked {
            server: key.clone(),
            username: target.clone(),
            banned: true,
        });
        state.hub.force_offline(&key, &target);
    }
    for (cid, users) in state.hub.rooms_in(&key, None) {
        if users.contains(&target) {
            state.hub.evict_voice(&target, cid);
        }
    }
    Ok(ok())
}

#[utoipa::path(delete, path = "/api/servers/{name}/bans/{username}", params(("name" = String, Path), ("username" = String, Path)), responses((status = 200, description = "Ban lifted; the user may join again. Requires the Kick permission", body = OkResp)), security(("bearer" = [])))]
pub(crate) async fn unban_member(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, target)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::Kick).await?;
    let removed = sqlx::query("DELETE FROM server_bans WHERE server = $1 AND username = $2")
        .bind(&key)
        .bind(target.to_lowercase())
        .execute(&state.db)
        .await?
        .rows_affected();
    match removed {
        0 => Err(not_found("Not banned")),
        _ => Ok(ok()),
    }
}

#[utoipa::path(get, path = "/api/servers/{name}/bans", params(("name" = String, Path), MembersQuery), responses((status = 200, description = "Up to 50 banned users, most recently banned first. Requires the Kick permission", body = Vec<ServerBan>)), security(("bearer" = [])))]
pub(crate) async fn list_bans(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(q): Query<MembersQuery>,
) -> Result<Json<Vec<ServerBan>>, ApiError> {
    let key = name.to_lowercase();
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::Kick).await?;
    let MembersQuery { offset, limit } = q;
    let rows = sqlx::query(
        "SELECT username, created_at FROM server_bans WHERE server = $1 ORDER BY created_at DESC, username LIMIT $2 OFFSET $3",
    )
    .bind(&key)
    .bind(limit.unwrap_or(50).clamp(1, 50))
    .bind(offset.unwrap_or(0).max(0))
    .fetch_all(&state.db)
    .await?;
    let mut bans = Vec::with_capacity(rows.len());
    for r in &rows {
        bans.push((r.try_get::<String, _>(0)?, r.try_get::<i64, _>(1)?));
    }
    let names: Vec<String> = bans.iter().map(|(name, _)| name.clone()).collect();
    let refs = user_refs(&state.db, &names).await;
    Ok(Json(
        bans.into_iter()
            .map(|(username, banned_at)| ServerBan {
                user: user_from(&refs, &username),
                banned_at,
            })
            .collect(),
    ))
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

    async fn add_user(db: &Db, username: &str, display_name: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $2, '', 'text', 'identicon', 0)")
            .bind(username)
            .bind(display_name)
            .execute(db)
            .await
            .expect("insert user");
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_one(db)
            .await
            .expect("count query")
            .try_get(0)
            .expect("count value")
    }

    async fn join(state: &AppState, who: &str, server: &str) -> Result<(), ApiError> {
        join_server(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path(server.to_string()),
            None,
        )
        .await
        .map(|_| ())
    }

    async fn ban(
        state: &AppState,
        actor: User,
        server: &str,
        target: &str,
    ) -> Result<(), ApiError> {
        ban_member(
            State(state.clone()),
            Authed(actor),
            Path(server.to_string()),
            Json(UsernameReq {
                username: target.to_string(),
            }),
        )
        .await
        .map(|_| ())
    }

    async fn unban(
        state: &AppState,
        actor: User,
        server: &str,
        target: &str,
    ) -> Result<(), ApiError> {
        unban_member(
            State(state.clone()),
            Authed(actor),
            Path((server.to_string(), target.to_string())),
        )
        .await
        .map(|_| ())
    }

    async fn bans(
        state: &AppState,
        actor: User,
        server: &str,
        offset: Option<i64>,
    ) -> Result<Vec<(String, String, i64)>, ApiError> {
        list_bans(
            State(state.clone()),
            Authed(actor),
            Path(server.to_string()),
            Query(MembersQuery {
                offset,
                limit: None,
            }),
        )
        .await
        .map(|Json(list)| {
            list.into_iter()
                .map(|b| (b.user.username, b.user.display_name, b.banned_at))
                .collect()
        })
    }

    fn status<T>(res: Result<T, ApiError>) -> Option<StatusCode> {
        res.err().map(|ApiError(code, _)| code)
    }

    fn kicks(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<(String, String, bool)> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::MemberKicked {
                server,
                username,
                banned,
            } = ev
            {
                out.push((server, username, banned));
            }
        }
        out
    }

    #[tokio::test]
    async fn ban_removes_membership_and_blocks_rejoin() {
        let (state, path) = temp_state("ban_rejoin").await;
        let db = &state.db;
        let cid = make_server(&state, "club").await.expect("club").0.channels[0].id;
        add_user(db, "bob", "Bob").await;
        join(&state, "bob", "club").await.expect("bob joins");
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('club', 'r', '#ffffff', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', 'bob', $1)")
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
        let _ = state.hub.voice_join("bob", 7, "club", cid);
        let mut rx = state.hub.subscribe();
        ban(&state, mem_user("alice", false), "Club", "Bob")
            .await
            .expect("ban bob");
        let bob_rows = |table: &str| {
            format!("SELECT COUNT(*) FROM {table} WHERE server = 'club' AND username = 'bob'")
        };
        assert_eq!(count(db, &bob_rows("members")).await, 0);
        assert_eq!(count(db, &bob_rows("user_roles")).await, 0);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM server_bans WHERE server = 'club' AND username = 'bob' AND banned_by = 'alice'").await,
            1
        );
        assert_eq!(
            kicks(&mut rx),
            vec![("club".to_string(), "bob".to_string(), true)]
        );
        assert!(state.hub.rooms_in("club", None).is_empty());
        match join(&state, "bob", "club").await {
            Err(ApiError(StatusCode::FORBIDDEN, msg)) => {
                assert_eq!(msg, "You are banned from this server")
            }
            _ => panic!("expected banned join rejection"),
        }
        assert_eq!(count(db, &bob_rows("members")).await, 0);
        ban(&state, mem_user("alice", false), "club", "bob")
            .await
            .expect("re-ban is a no-op");
        assert_eq!(count(db, &bob_rows("server_bans")).await, 1);
        assert!(kicks(&mut rx).is_empty());
        unban(&state, mem_user("alice", false), "club", "BOB")
            .await
            .expect("unban");
        assert_eq!(
            status(unban(&state, mem_user("alice", false), "club", "bob").await),
            Some(StatusCode::NOT_FOUND)
        );
        join(&state, "bob", "club").await.expect("bob rejoins");
        assert_eq!(count(db, &bob_rows("members")).await, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn ban_permissions_and_targets() {
        let (state, path) = temp_state("ban_perms").await;
        let db = &state.db;
        let cid = make_server(&state, "club").await.expect("club").0.channels[0].id;
        for name in ["bob", "carol", "dave", "erin"] {
            add_user(db, name, name).await;
        }
        for name in ["bob", "carol", "dave"] {
            join(&state, name, "club").await.expect("join");
        }
        let plain = || mem_user("carol", false);
        assert_eq!(
            status(ban(&state, plain(), "club", "bob").await),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            status(bans(&state, plain(), "club", None).await),
            Some(StatusCode::FORBIDDEN)
        );
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('club', 'mod', '#ffffff', $1) RETURNING id")
            .bind(Perm::Kick as i64)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', 'dave', $1)")
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
        let moderator = || mem_user("dave", false);
        ban(&state, moderator(), "club", "bob")
            .await
            .expect("kick-perm role can ban");
        assert_eq!(
            status(unban(&state, plain(), "club", "bob").await),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            status(ban(&state, moderator(), "club", "ghost").await),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            status(ban(&state, moderator(), "nowhere", "bob").await),
            Some(StatusCode::NOT_FOUND)
        );
        let _ = state.hub.voice_join("erin", 9, "club", cid);
        let mut rx = state.hub.subscribe();
        ban(&state, moderator(), "club", "erin")
            .await
            .expect("non-member ban");
        assert!(kicks(&mut rx).is_empty());
        assert!(state.hub.rooms_in("club", None).is_empty());
        assert_eq!(
            status(join(&state, "erin", "club").await),
            Some(StatusCode::FORBIDDEN)
        );
        let _ = kick_member(
            State(state.clone()),
            Authed(moderator()),
            Path("club".to_string()),
            Json(UsernameReq {
                username: "carol".to_string(),
            }),
        )
        .await
        .expect("kick");
        assert_eq!(
            kicks(&mut rx),
            vec![("club".to_string(), "carol".to_string(), false)]
        );
        join(&state, "carol", "club")
            .await
            .expect("kicked may rejoin");
        let root = || mem_user("root", true);
        let listed: Vec<String> = bans(&state, root(), "club", None)
            .await
            .expect("site admin lists")
            .into_iter()
            .map(|(name, _, _)| name)
            .collect();
        assert_eq!(listed.len(), 2);
        assert!(listed.contains(&"bob".to_string()) && listed.contains(&"erin".to_string()));
        unban(&state, root(), "club", "erin")
            .await
            .expect("site admin unbans");
        join(&state, "erin", "club").await.expect("erin joins");
        done(state, path).await;
    }

    async fn moderate(
        state: &AppState,
        actor: User,
        target: &str,
        banning: bool,
    ) -> Result<String, (StatusCode, String)> {
        let path = Path("club".to_string());
        let body = Json(UsernameReq {
            username: target.to_string(),
        });
        let res = match banning {
            true => ban_member(State(state.clone()), Authed(actor), path, body).await,
            false => kick_member(State(state.clone()), Authed(actor), path, body).await,
        };
        res.map(|Json(ok)| serde_json::to_string(&ok).expect("json"))
            .map_err(|ApiError(code, msg)| (code, msg))
    }

    async fn set_admin_row(db: &Db, username: &str, perms: i64) {
        sqlx::query(
            "UPDATE members SET is_admin = 1, perms = $1 WHERE server = 'club' AND username = $2",
        )
        .bind(perms)
        .bind(username)
        .execute(db)
        .await
        .expect("make admin");
    }

    #[tokio::test]
    async fn moderation_needs_strictly_more_perms() {
        let (state, path) = temp_state("mod_rule").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        let names = [
            "alice", "bob", "carol", "dave", "erin", "frank", "gina", "root", "su",
        ];
        for name in names {
            add_user(db, name, name).await;
        }
        for name in &names[1..8] {
            join(&state, name, "club").await.expect("join");
        }
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username IN ('root', 'su')")
            .execute(db)
            .await
            .expect("site admins");
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('club', 'mod', '#ffffff', $1) RETURNING id")
            .bind(Perm::Kick as i64)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        for name in ["carol", "dave", "root"] {
            sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', $1, $2)")
                .bind(name)
                .bind(role)
                .execute(db)
                .await
                .expect("assign");
        }
        let narrow = Perm::Kick as i64 | Perm::DeleteMessages as i64;
        set_admin_row(db, "erin", narrow).await;
        set_admin_row(db, "gina", Perm::DeleteMessages as i64).await;
        set_admin_row(db, "frank", 0).await;
        let carol = || mem_user("carol", false);
        let alice = || mem_user("alice", false);
        let denied = Err((
            StatusCode::FORBIDDEN,
            "You can't moderate this member".to_string(),
        ));
        for banning in [false, true] {
            for target in ["alice", "frank", "erin", "dave", "root"] {
                assert_eq!(
                    moderate(&state, carol(), target, banning).await,
                    denied,
                    "carol vs {target} banning {banning}"
                );
            }
        }
        sqlx::query("DELETE FROM user_roles WHERE server = 'club' AND username = 'root'")
            .execute(db)
            .await
            .expect("drop root role");
        let plain = moderate(&state, carol(), "bob", false)
            .await
            .expect("kick plain");
        assert_eq!(
            moderate(&state, carol(), "root", false).await,
            Ok(plain.clone())
        );
        join(&state, "bob", "club").await.expect("bob rejoins");
        join(&state, "root", "club").await.expect("root rejoins");
        let banned = moderate(&state, carol(), "bob", true)
            .await
            .expect("ban plain");
        assert_eq!(moderate(&state, carol(), "root", true).await, Ok(banned));
        assert_eq!(
            status(join(&state, "root", "club").await),
            Some(StatusCode::FORBIDDEN)
        );
        moderate(&state, alice(), "erin", false)
            .await
            .expect("full admin kicks narrower admin");
        moderate(&state, alice(), "gina", true)
            .await
            .expect("full admin bans narrower admin");
        assert_eq!(moderate(&state, alice(), "frank", false).await, denied);
        set_admin_row(db, "alice", Perm::Kick as i64).await;
        moderate(&state, mem_user("frank", false), "alice", false)
            .await
            .expect("creator has no protection");
        let su = || mem_user("su", true);
        moderate(&state, su(), "frank", false)
            .await
            .expect("site admin kicks full admin");
        moderate(&state, su(), "dave", true)
            .await
            .expect("site admin bans peer");
        let own = Err((
            StatusCode::BAD_REQUEST,
            "You can't ban yourself".to_string(),
        ));
        assert_eq!(moderate(&state, carol(), "Carol", true).await, own);
        assert_eq!(moderate(&state, su(), "su", true).await, own);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM server_bans WHERE username IN ('carol', 'su')"
            )
            .await,
            0
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn join_rejects_a_ban_that_lands_before_insert() {
        let (state, path) = temp_state("join_race").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        sqlx::query("INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('club', 'bob', 'alice', 0)")
            .execute(db)
            .await
            .expect("ban after check");
        match insert_member(db, "club", "bob").await {
            Err(ApiError(StatusCode::FORBIDDEN, msg)) => {
                assert_eq!(msg, "You are banned from this server")
            }
            _ => panic!("expected banned insert rejection"),
        }
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM members WHERE server = 'club' AND username = 'bob'"
            )
            .await,
            0
        );
        assert!(
            !insert_member(db, "club", "alice")
                .await
                .expect("already a member")
        );
        assert!(
            insert_member(db, "club", "carol")
                .await
                .expect("new member")
        );
        assert!(
            !insert_member(db, "club", "carol")
                .await
                .expect("repeat join")
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn ban_list_pages_newest_first() {
        let (state, path) = temp_state("ban_pages").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        add_user(db, "u54", "Fifty Four").await;
        for i in 0..55 {
            sqlx::query("INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('club', $1, 'alice', $2)")
                .bind(format!("u{i:02}"))
                .bind(1000 + i)
                .execute(db)
                .await
                .expect("insert ban");
        }
        let alice = || mem_user("alice", false);
        let first = bans(&state, alice(), "club", None).await.expect("page 1");
        assert_eq!(first.len(), 50);
        assert_eq!(
            first[0],
            ("u54".to_string(), "Fifty Four".to_string(), 1054)
        );
        assert_eq!(first[1], ("u53".to_string(), "u53".to_string(), 1053));
        assert_eq!(first[49].0, "u05");
        let rest: Vec<String> = bans(&state, alice(), "club", Some(50))
            .await
            .expect("page 2")
            .into_iter()
            .map(|(name, _, _)| name)
            .collect();
        assert_eq!(rest, vec!["u04", "u03", "u02", "u01", "u00"]);
        assert!(
            bans(&state, alice(), "club", Some(55))
                .await
                .expect("past end")
                .is_empty()
        );
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
        let fetch = |raw: &str| {
            let state = state.clone();
            let raw = raw.to_string();
            async move {
                list_members(
                    State(state),
                    MaybeAuthed(None),
                    HeaderMap::new(),
                    Path("rchat".to_string()),
                    RawQuery(Some(raw)),
                )
                .await
                .map(|members| {
                    members
                        .0
                        .into_iter()
                        .map(|m| (m.user.username, m.user.display_name, m.role_ids))
                        .collect::<Vec<(String, String, Vec<i64>)>>()
                })
            }
        };
        let all = vec![
            ("alice".to_string(), "Alice A".to_string(), vec![]),
            ("bob".to_string(), "bob".to_string(), roles.clone()),
            ("carol".to_string(), "carol".to_string(), vec![roles[1]]),
        ];
        assert_eq!(fetch("").await.expect("members"), all);
        assert_eq!(fetch("offset=1&limit=1").await.expect("page"), all[1..2]);
        let picked = fetch("usernames=CAROL&usernames=nobody&usernames=alice&usernames=carol")
            .await
            .expect("by name");
        assert_eq!(picked, vec![all[0].clone(), all[2].clone()]);
        assert!(fetch("usernames=").await.expect("empty name").is_empty());
        let many: Vec<String> = (0..150).map(|n| format!("usernames=x{n}")).collect();
        let capped = fetch(&format!("{}&usernames=bob", many[..99].join("&")))
            .await
            .expect("under cap");
        assert_eq!(capped, vec![all[1].clone()]);
        let over = fetch(&format!("{}&usernames=bob", many.join("&")))
            .await
            .expect("over cap");
        assert!(over.is_empty());
        assert!(rejected(fetch("offset=x").await));
        sqlx::query("UPDATE servers SET password_hash = 'x' WHERE name = 'rchat'")
            .execute(db)
            .await
            .expect("lock server");
        assert!(matches!(
            fetch("usernames=bob").await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        done(state, path).await;
    }

    async fn invite_as(
        state: &AppState,
        viewer: Option<User>,
        server: &str,
        password: Option<&str>,
        grant: Option<&str>,
    ) -> Result<Invite, ApiError> {
        let mut headers = HeaderMap::new();
        if let Some(password) = password {
            let encoded =
                percent_encoding::utf8_percent_encode(password, percent_encoding::NON_ALPHANUMERIC)
                    .to_string();
            headers.insert(
                "x-invite-password",
                encoded.parse().expect("password header"),
            );
        }
        if let Some(grant) = grant {
            headers.insert("x-guest-grant", grant.parse().expect("grant header"));
        }
        get_invite(
            State(state.clone()),
            MaybeAuthed(viewer),
            headers,
            Path(server.to_string()),
        )
        .await
        .map(|Json(invite)| invite)
    }

    async fn status_of(
        state: &AppState,
        viewer: Option<User>,
        password: Option<&str>,
    ) -> InviteStatus {
        invite_as(state, viewer, "club", password, None)
            .await
            .expect("invite")
            .status
    }

    async fn set_password(state: &AppState, password: &str) {
        let _ = update_server(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            Json(ServerPatch {
                name: None,
                password: Some(password.to_string()),
            }),
        )
        .await
        .expect("set password");
    }

    async fn insert_grant(db: &Db, server: &str) -> String {
        let grant = new_token();
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at) VALUES($1, $2, 0)")
            .bind(&grant)
            .bind(server)
            .execute(db)
            .await
            .expect("insert grant");
        grant
    }

    #[tokio::test]
    async fn invite_statuses() {
        let (state, path) = temp_state("invite_status").await;
        let db = &state.db;
        let _ = make_server(&state, "Club").await.expect("club");
        add_user(db, "bob", "Bob").await;
        add_user(db, "carol", "Carol").await;
        join(&state, "bob", "club").await.expect("bob joins");
        ban(&state, mem_user("alice", false), "club", "carol")
            .await
            .expect("ban carol");
        let user = |name: &str| Some(mem_user(name, false));
        let open = invite_as(&state, user("dave"), "CLUB", None, None)
            .await
            .expect("open invite");
        assert_eq!(open.server.display_name, "Club");
        assert_eq!(open.server.name, "club");
        assert!(!open.server.has_password);
        assert_eq!(open.member_count, Some(2));
        assert_eq!(open.status, InviteStatus::Joinable);
        assert_eq!(open.preview_channel.as_deref(), Some("general"));
        assert_eq!(
            status_of(&state, user("alice"), None).await,
            InviteStatus::Member
        );
        assert_eq!(
            status_of(&state, user("bob"), None).await,
            InviteStatus::Member
        );
        assert_eq!(
            status_of(&state, user("carol"), None).await,
            InviteStatus::Banned
        );
        assert_eq!(status_of(&state, None, None).await, InviteStatus::Joinable);
        assert_eq!(
            status_of(&state, Some(mem_user("root", true)), None).await,
            InviteStatus::Joinable
        );
        set_password(&state, "pässwörd #1").await;
        assert_eq!(
            status_of(&state, user("dave"), None).await,
            InviteStatus::PasswordRequired
        );
        assert_eq!(
            status_of(&state, user("dave"), Some("wrong")).await,
            InviteStatus::PasswordRequired
        );
        assert_eq!(
            status_of(&state, user("dave"), Some("pässwörd #1")).await,
            InviteStatus::Joinable
        );
        assert_eq!(
            status_of(&state, Some(mem_user("root", true)), None).await,
            InviteStatus::PasswordRequired
        );
        assert_eq!(
            status_of(&state, user("bob"), None).await,
            InviteStatus::Member
        );
        assert_eq!(
            status_of(&state, user("carol"), Some("pässwörd #1")).await,
            InviteStatus::Banned
        );
        assert_eq!(
            status_of(&state, None, None).await,
            InviteStatus::PasswordRequired
        );
        assert_eq!(
            status_of(&state, None, Some("pässwörd #1")).await,
            InviteStatus::Joinable
        );
        let grant = insert_grant(db, "club").await;
        let guest = invite_as(&state, None, "club", None, Some(&format!("bogus, {grant}")))
            .await
            .expect("guest invite");
        assert_eq!(guest.status, InviteStatus::Joinable);
        let ignored = invite_as(&state, user("dave"), "club", None, Some(&grant))
            .await
            .expect("grants are for guests");
        assert_eq!(ignored.status, InviteStatus::PasswordRequired);
        assert_eq!(
            status(invite_as(&state, user("dave"), "nowhere", None, None).await),
            Some(StatusCode::NOT_FOUND)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn invite_counts_hidden_when_locked() {
        let (state, path) = temp_state("invite_counts").await;
        let db = &state.db;
        let _ = make_server(&state, "Club").await.expect("club");
        add_user(db, "bob", "Bob").await;
        join(&state, "bob", "club").await.expect("bob joins");
        let user = |name: &str| Some(mem_user(name, false));
        let counts = |invite: &Invite| (invite.member_count, invite.online_count);
        let open = invite_as(&state, user("dave"), "club", None, None)
            .await
            .expect("open");
        assert_eq!(counts(&open), (Some(2), Some(0)));
        set_password(&state, "secret").await;
        let grant = insert_grant(db, "club").await;
        type Case<'a> = (Option<User>, Option<&'a str>, Option<&'a str>, bool);
        let cases: Vec<Case> = vec![
            (user("dave"), None, None, false),
            (user("dave"), Some("nope"), None, false),
            (user("dave"), Some("secret"), None, true),
            (user("bob"), None, None, true),
            (Some(mem_user("root", true)), None, None, false),
            (None, None, None, false),
            (None, None, Some("bogus"), false),
            (None, None, Some(&grant), true),
            (None, Some("secret"), None, true),
        ];
        for (n, (viewer, password, grant, shown)) in cases.into_iter().enumerate() {
            let invite = invite_as(&state, viewer, "club", password, grant)
                .await
                .expect("invite");
            assert_eq!(invite.server.display_name, "Club", "case {n}");
            let want = match shown {
                true => (Some(2), Some(0)),
                false => (None, None),
            };
            assert_eq!(counts(&invite), want, "case {n}");
        }
        done(state, path).await;
    }

    async fn post(db: &Db, channel: i64, content: &str, root: Option<i64>) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES($1, $2, 'alice', $3, 0) RETURNING id")
            .bind(channel)
            .bind(root)
            .bind(content)
            .fetch_one(db)
            .await
            .expect("insert message")
            .try_get(0)
            .expect("message id")
    }

    fn contents(invite: &Invite) -> Vec<&str> {
        invite.preview.iter().map(|m| m.content.as_str()).collect()
    }

    #[tokio::test]
    async fn invite_preview_gating() {
        let (state, path) = temp_state("invite_preview").await;
        let db = &state.db;
        let general = make_server(&state, "club").await.expect("club").0.channels[0].id;
        set_password(&state, "secret").await;
        for n in 1..=5 {
            post(db, general, &format!("m{n}"), None).await;
        }
        let last = post(db, general, "m6", None).await;
        post(db, general, "reply", Some(last)).await;
        let dave = || Some(mem_user("dave", false));
        let locked = invite_as(&state, dave(), "club", None, None)
            .await
            .expect("locked");
        assert!(locked.preview.is_empty());
        assert_eq!(locked.preview_channel, None);
        let wrong = invite_as(&state, dave(), "club", Some("nope"), None)
            .await
            .expect("wrong password");
        assert!(wrong.preview.is_empty());
        let unlocked = invite_as(&state, dave(), "club", Some("secret"), None)
            .await
            .expect("unlocked");
        assert_eq!(unlocked.preview_channel.as_deref(), Some("general"));
        assert_eq!(contents(&unlocked), vec!["m4", "m5", "m6"]);
        assert_eq!(unlocked.preview[2].author.username, "alice");
        let grant = insert_grant(db, "club").await;
        let guest = invite_as(&state, None, "club", None, Some(&grant))
            .await
            .expect("guest");
        assert_eq!(contents(&guest), vec!["m4", "m5", "m6"]);
        let member = invite_as(&state, Some(mem_user("alice", false)), "club", None, None)
            .await
            .expect("member");
        assert_eq!(contents(&member), vec!["m4", "m5", "m6"]);
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 1)")
            .bind(general)
            .execute(db)
            .await
            .expect("make general private");
        sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'lounge', 'voice', 0)")
            .execute(db)
            .await
            .expect("voice channel");
        let lobby: i64 = sqlx::query(
            "INSERT INTO channels(server, name, created_at) VALUES('club', 'lobby', 0) RETURNING id",
        )
        .fetch_one(db)
        .await
        .expect("lobby")
        .try_get(0)
        .expect("lobby id");
        post(db, lobby, "hello lobby", None).await;
        let public = invite_as(&state, dave(), "club", Some("secret"), None)
            .await
            .expect("public channel");
        assert_eq!(public.preview_channel.as_deref(), Some("lobby"));
        assert_eq!(contents(&public), vec!["hello lobby"]);
        let alice_view = invite_as(&state, Some(mem_user("alice", false)), "club", None, None)
            .await
            .expect("alice sees the outsider preview");
        assert_eq!(alice_view.preview_channel.as_deref(), Some("lobby"));
        add_user(db, "carol", "Carol").await;
        ban(&state, mem_user("alice", false), "club", "carol")
            .await
            .expect("ban carol");
        for password in [Some("secret"), None] {
            let banned = invite_as(
                &state,
                Some(mem_user("carol", false)),
                "club",
                password,
                None,
            )
            .await
            .expect("banned");
            assert_eq!(banned.status, InviteStatus::Banned);
            assert_eq!(banned.preview_channel, None);
            assert!(banned.preview.is_empty());
        }
        set_password(&state, "").await;
        let banned = invite_as(&state, Some(mem_user("carol", false)), "club", None, None)
            .await
            .expect("banned from an open server");
        assert_eq!(banned.status, InviteStatus::Banned);
        assert!(banned.preview.is_empty());
        let open = invite_as(&state, dave(), "club", None, None)
            .await
            .expect("open server");
        assert_eq!(contents(&open), vec!["hello lobby"]);
        set_password(&state, "secret").await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 1)")
            .bind(lobby)
            .execute(db)
            .await
            .expect("make lobby private");
        let hidden = invite_as(&state, dave(), "club", Some("secret"), None)
            .await
            .expect("no public channel");
        assert_eq!(hidden.status, InviteStatus::Joinable);
        assert_eq!(hidden.preview_channel, None);
        assert!(hidden.preview.is_empty());
        done(state, path).await;
    }
}
