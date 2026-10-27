use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::admin::{fuzzy_match, is_fuzzy, like_pattern};
use crate::api::auth::{hash_password, new_token, verify_password, verify_password_cached};
use crate::api::messages::recent_channel_messages;
use crate::api::{
    ApiError, ApiErrorBody, Authed, Channel, ChannelPerm, LIST_MAX, MaybeAuthed, Member, Message,
    NAME_MAX, OFFSET_MAX, Paged, ProfanityTarget, Role, RoleLimits, SLOWMODE_MAX, ServerDetail,
    ServerSummary, ServerSummaryLite, UserRef, check_len, check_profanity, cursor_int,
    decode_cursor, encode_cursor, grant_matches, header_grants, page_bounds, placeholders,
    require_guest_ok, require_server_view, unique_capped, user_from, user_ref, user_refs,
    valid_color,
};
use crate::db::{
    ALL_PERMS, ChannelKind, Db, Perm, PermRow, User, can_grant, can_moderate, effective_perms,
    fold_access, get_user, has_perm, is_banned, member_perms, now, perm_bits, perm_row,
    perm_subjects,
};
use crate::state::AppState;
use crate::ws::{Hub, WsEvent, evict_unviewable};

/// Request body for creating a channel.
#[derive(Deserialize, ToSchema)]
pub struct CreateChannelReq {
    /// Channel name. Surrounding whitespace is trimmed; must not be blank, at most 100
    /// characters, must pass the channel-name profanity filter and must not equal the name of
    /// another channel in the server (exact, case-sensitive comparison).
    #[schema(example = "general")]
    name: String,
    /// Channel kind, `text` or `voice`. Optional; omitted or `null` creates a text channel.
    kind: Option<ChannelKind>,
}

/// Request body for creating a server.
#[derive(Deserialize, ToSchema)]
pub struct CreateServerReq {
    /// Server name. Surrounding whitespace is trimmed and the result becomes the
    /// `display_name`; its lowercase form becomes the `name` used in URLs. Must not be blank,
    /// at most 100 characters, not `.` or `..`, must pass the server-name profanity filter and
    /// must not be taken by another server (case-insensitive).
    #[schema(example = "Club")]
    name: String,
    /// Optional join password. Surrounding whitespace is trimmed; omitted, `null` or blank
    /// creates a server without a password.
    password: Option<String>,
}

/// Optional request body for joining a server.
#[derive(Deserialize, ToSchema)]
pub struct JoinReq {
    /// The server password. Needed only when the server is password-protected and the caller
    /// is not already a member; ignored otherwise.
    password: Option<String>,
}

/// What happens to the other members when a server password is set, changed or cleared:
/// `keep` (default) keeps everyone; `remove` removes every other member whose server
/// permissions are a strict subset of the caller's, as if kicked.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PasswordMembers {
    #[default]
    Keep,
    Remove,
}

/// Request body for updating a server. Every field is optional; omitted fields are left
/// unchanged.
#[derive(Deserialize, ToSchema)]
pub struct ServerPatch {
    /// New server name, with the same rules as when creating a server (trimmed, 1-100
    /// characters, not `.` or `..`, profanity-filtered, not taken). Changes the lowercase `name`
    /// used in URLs as well as the `display_name`. Not allowed on the rchat server.
    name: Option<String>,
    /// New join password. Surrounding whitespace is trimmed; a blank value removes the
    /// password. Omit to leave the password as it is. Not allowed on the rchat server.
    password: Option<String>,
    /// What to do with the other members when `password` is present: `keep` (default) or
    /// `remove`. Ignored when `password` is omitted.
    #[serde(default)]
    members: PasswordMembers,
    /// When `password` is present, existing guest grants are revoked unless this is `true` and
    /// `members` is `keep`. Defaults to `false`.
    #[serde(default)]
    keep_guests: bool,
    /// Background color of the channel sidebar header as `#rrggbb` (stored lowercase). `null`
    /// resets it to the theme color; omit to leave it unchanged.
    #[serde(default, deserialize_with = "crate::api::auth::present")]
    #[schema(value_type = Option<String>, example = "#1e293b")]
    banner_color: Option<Option<String>>,
    /// Color of the server name in the channel sidebar header as `#rrggbb` (stored lowercase).
    /// `null` resets it to the theme color; omit to leave it unchanged.
    #[serde(default, deserialize_with = "crate::api::auth::present")]
    #[schema(value_type = Option<String>, example = "#f8fafc")]
    name_color: Option<Option<String>>,
}

/// The server after an update, plus how many members a password change removed.
#[derive(Serialize, ToSchema)]
pub struct ServerUpdated {
    /// The server as it is after the update (its fields appear at the top level).
    #[serde(flatten)]
    pub server: ServerSummaryLite,
    /// Number of members removed because `members` was `remove`; 0 otherwise.
    pub removed: i64,
    /// Number of members other than the caller who are still in the server.
    pub kept: i64,
}

/// Request body for updating a channel. Every field is optional; omitted fields are left
/// unchanged.
#[derive(Deserialize, ToSchema)]
pub struct ChannelPatch {
    /// New channel name: trimmed, not blank, at most 100 characters, profanity-filtered and
    /// not equal to the name of another channel in the server.
    name: Option<String>,
    /// Slow mode delay in seconds between messages from the same user, 0 (off) to 21600.
    /// Voice channels only accept 0.
    #[schema(example = 10)]
    slowmode_seconds: Option<i64>,
}

/// Request body naming a user.
#[derive(Deserialize, ToSchema)]
pub struct UsernameReq {
    /// Target username, case-insensitive.
    #[schema(example = "alice")]
    username: String,
}

/// Request body for setting a server admin's permissions.
#[derive(Deserialize, ToSchema)]
pub struct PermsReq {
    /// Permission bitmask: 1 Manage channels, 2 Delete messages, 4 Kick, 8 Delete server,
    /// 16 Manage admins. Bits outside 31 are dropped. For an admin, 0 means all permissions.
    #[schema(example = 7)]
    perms: i64,
}

/// Request body for creating a role.
#[derive(Deserialize, ToSchema)]
pub struct RoleReq {
    /// Role name: trimmed, not blank, at most 100 characters and profanity-filtered. Names do
    /// not have to be unique.
    #[schema(example = "Moderators")]
    name: String,
    /// Role color as `#rrggbb`, stored as sent.
    #[schema(example = "#22c55e")]
    color: String,
    /// Permission bitmask granted to members holding the role: 1 Manage channels, 2 Delete
    /// messages, 4 Kick, 8 Delete server, 16 Manage admins. Bits outside 31 are dropped. Roles
    /// only add permissions to members who are not admins; admins use their own admin
    /// permissions.
    #[schema(example = 6)]
    perms: i64,
}

/// Request body for updating a role. Every field is optional; omitted fields are left
/// unchanged.
#[derive(Deserialize, ToSchema)]
pub struct RolePatch {
    /// New role name: trimmed, not blank, at most 100 characters and profanity-filtered.
    name: Option<String>,
    /// New role color as `#rrggbb`, stored as sent.
    color: Option<String>,
    /// New permission bitmask (see `RoleReq.perms`). Bits outside 31 are dropped.
    perms: Option<i64>,
}

/// Request body for getting guest access to a password-protected server.
#[derive(Deserialize, ToSchema)]
pub struct GuestAccessReq {
    /// The server password.
    password: String,
}

/// A guest grant for a password-protected server.
#[derive(Serialize, ToSchema)]
pub struct GuestGrant {
    /// Opaque grant token. Guests send it in the `X-Guest-Grant` header (comma-separated with
    /// other grants) to view this server. It expires after `GUEST_GRANT_DAYS` days without use
    /// (an instance setting, 30 by default) and is revoked when the server password changes, unless
    /// the change kept guests.
    grant: String,
}

/// Whether a server exists, and whether it has a password.
#[derive(Serialize, ToSchema)]
pub struct ServerExists {
    /// `true` when joining the server needs a password.
    has_password: bool,
}

/// Query parameters for server search.
#[derive(Deserialize, IntoParams)]
pub struct ServerSearchQuery {
    /// Search text, trimmed and case-insensitive. Up to 8 characters it matches names that
    /// contain the characters in order (fuzzy); longer queries match as a substring of the
    /// name or display name. Omitted or blank returns an empty list.
    #[param(example = "club")]
    q: Option<String>,
}

/// A server returned by server search.
#[derive(Serialize, ToSchema)]
pub struct ServerMatch {
    /// Lowercase server name, used in URLs.
    #[schema(example = "club")]
    pub name: String,
    /// Server name in its original case.
    #[schema(example = "Club")]
    pub display_name: String,
    /// `true` when joining the server needs a password.
    pub has_password: bool,
}

/// Generic success response.
#[derive(Serialize, ToSchema)]
pub struct OkResp {
    /// Always `true`.
    #[schema(example = true)]
    ok: bool,
}

/// A user banned from a server.
#[derive(Serialize, ToSchema)]
pub struct ServerBan {
    /// The banned user (their fields appear at the top level).
    #[serde(flatten)]
    pub user: UserRef,
    /// When the ban was created, Unix seconds.
    pub banned_at: i64,
}

/// The viewer's relation to an invited server: `member` (already a member), `banned` (banned
/// from the server), `joinable` (may join now: no password, or the invite password or a guest
/// grant was accepted) or `password_required`. Guests never get `member` or `banned`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InviteStatus {
    Member,
    Banned,
    Joinable,
    PasswordRequired,
}

/// An invite card for a server.
#[derive(Serialize, ToSchema)]
pub struct Invite {
    /// The invited server.
    pub server: ServerSummaryLite,
    /// Number of members. `null` when the server has a password and the viewer is not a
    /// member and gave no valid invite password or guest grant.
    pub member_count: Option<i64>,
    /// Number of members online now. `null` in the same cases as `member_count`.
    pub online_count: Option<i64>,
    /// The viewer's relation to the server.
    pub status: InviteStatus,
    /// Name of the channel the preview comes from: the first text channel without any
    /// permission rules. `null` when the preview is locked or no such channel exists.
    pub preview_channel: Option<String>,
    /// The last 3 top-level messages of `preview_channel`. Empty when the viewer is banned,
    /// when the server has a password that the viewer has not unlocked (membership, invite
    /// password or guest grant), or when there is no preview channel.
    pub preview: Vec<Message>,
}

/// Paging query parameters.
#[derive(Deserialize, IntoParams)]
pub struct MembersQuery {
    /// Legacy offset paging: number of items to skip (negative counts as 0). Ignored when
    /// `cursor` is given.
    offset: Option<i64>,
    /// Page size, default 50, clamped to 1-50.
    limit: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header. Blank means the first
    /// page.
    cursor: Option<String>,
}

/// Query parameters for listing your servers.
#[derive(IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MyServersQuery {
    /// Legacy offset paging: number of servers to skip, clamped to 0-1000000. Ignored when
    /// `cursor` or `names` is given. Must be an integer.
    offset: Option<i64>,
    /// Page size, default 50, clamped to 1-100. Ignored with `names`. Must be an integer.
    limit: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header. Blank means the first
    /// page. Ignored with `names`.
    cursor: Option<String>,
    /// Only return these servers (case-insensitive names), repeated once per server, e.g.
    /// `names=a&names=b`. Duplicates and blanks are dropped and only the first 100 count.
    /// Servers you are not a member of are skipped. Disables paging.
    names: Option<Vec<String>>,
}

struct PagedList {
    offset: Option<i64>,
    limit: Option<i64>,
    cursor: Option<String>,
    list: Option<Vec<String>>,
}

fn paged_list(raw: &str, list_key: &str) -> Result<PagedList, ApiError> {
    let int = |v: &str| v.parse::<i64>().map_err(|_| bad("Invalid number"));
    let mut out = PagedList {
        offset: None,
        limit: None,
        cursor: None,
        list: None,
    };
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        match key.as_ref() {
            "offset" => out.offset = Some(int(&value)?),
            "limit" => out.limit = Some(int(&value)?),
            "cursor" if !value.trim().is_empty() => out.cursor = Some(value.into_owned()),
            k if k == list_key => out
                .list
                .get_or_insert_with(Vec::new)
                .push(value.into_owned()),
            _ => {}
        }
    }
    Ok(out)
}

impl MyServersQuery {
    fn parse(raw: &str) -> Result<MyServersQuery, ApiError> {
        let PagedList {
            offset,
            limit,
            cursor,
            list,
        } = paged_list(raw, "names")?;
        Ok(MyServersQuery {
            offset,
            limit,
            cursor,
            names: list,
        })
    }
}

/// Query parameters for listing server members.
#[derive(IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MemberListQuery {
    /// Legacy offset paging for the default (online-first) listing: number of members to skip,
    /// clamped to 0-1000000. Ignored when `cursor`, `usernames`, `q` or `admins` is given. Must
    /// be an integer.
    offset: Option<i64>,
    /// Page size, default 50, clamped to 1-50. Ignored with `usernames`. Must be an integer.
    limit: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header. Blank means the first
    /// page. A cursor only works with the same kind of listing (default, or `q`/`admins`)
    /// that produced it. Ignored with `usernames`.
    cursor: Option<String>,
    /// Only return these users (case-insensitive usernames), repeated once per user, e.g.
    /// `usernames=a&usernames=b`. Duplicates and blanks are dropped and only the first 100
    /// count. Non-members are skipped. Disables paging and takes precedence over `q` and
    /// `admins`.
    usernames: Option<Vec<String>>,
    /// Username prefix, trimmed and case-insensitive. Returns matching members alphabetically
    /// instead of online first.
    q: Option<String>,
    /// `1` or `true` returns only server admins, alphabetically; any other value is ignored.
    admins: Option<bool>,
}

impl MemberListQuery {
    fn parse(raw: &str) -> Result<MemberListQuery, ApiError> {
        let PagedList {
            offset,
            limit,
            cursor,
            list,
        } = paged_list(raw, "usernames")?;
        let mut q = None;
        let mut admins = None;
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "q" if !value.trim().is_empty() => q = Some(value.trim().to_lowercase()),
                "admins" => admins = Some(matches!(value.as_ref(), "1" | "true")),
                _ => {}
            }
        }
        Ok(MemberListQuery {
            offset,
            limit,
            cursor,
            usernames: list,
            q,
            admins,
        })
    }
}

fn prefix_end(prefix: &str) -> Option<String> {
    let mut chars: Vec<char> = prefix.chars().collect();
    while let Some(last) = chars.pop() {
        let next = (u32::from(last) + 1..=u32::from(char::MAX)).find_map(char::from_u32);
        if let Some(c) = next {
            chars.push(c);
            return Some(chars.into_iter().collect());
        }
    }
    None
}

async fn filtered_members(
    db: &Db,
    server: &str,
    q: Option<&str>,
    admins: bool,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> Result<(Vec<MemberRow>, Option<String>), ApiError> {
    let limit = limit.unwrap_or(50).clamp(1, 50);
    let after = match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            match parts[0].as_str() {
                "s" => Some(parts[1].clone()),
                _ => return Err(bad("Invalid cursor")),
            }
        }
        None => None,
    };
    let q = q.filter(|q| !q.is_empty());
    let col = match crate::db::is_sqlite(db) {
        true => "username",
        false => "(username COLLATE \"C\")",
    };
    let mut sql = String::from("SELECT username, is_admin, perms FROM members WHERE server = $1");
    let mut binds: Vec<String> = Vec::new();
    if admins {
        sql.push_str(" AND is_admin <> 0");
    }
    match (&after, q) {
        (Some(a), _) => {
            binds.push(a.clone());
            sql.push_str(&format!(" AND {col} > ${}", binds.len() + 1));
        }
        (None, Some(q)) => {
            binds.push(q.to_string());
            sql.push_str(&format!(" AND {col} >= ${}", binds.len() + 1));
        }
        (None, None) => {}
    }
    if let Some(end) = q.and_then(prefix_end) {
        binds.push(end);
        sql.push_str(&format!(" AND {col} < ${}", binds.len() + 1));
    }
    sql.push_str(&format!(" ORDER BY {col} LIMIT ${}", binds.len() + 2));
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for b in &binds {
        query = query.bind(b);
    }
    let mut rows = member_rows(&query.bind(limit + 1).fetch_all(db).await?)?;
    rows.retain(|(name, _, _)| q.is_none_or(|q| name.starts_with(q)));
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match (more, rows.last()) {
        (true, Some((name, _, _))) => Some(encode_cursor(&["s", name])),
        _ => None,
    };
    Ok((rows, next))
}

pub const CHANNEL_MAX: i64 = 500;
pub const ROLE_MAX: i64 = 250;
pub const CHANNEL_PERM_MAX: i64 = 500;

async fn count_rows(db: &Db, sql: &'static str, key: &str) -> Result<i64, ApiError> {
    Ok(sqlx::query(sql).bind(key).fetch_one(db).await?.try_get(0)?)
}

pub(crate) fn ok() -> Json<OkResp> {
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

async fn check_name(
    db: &Db,
    target: ProfanityTarget,
    what: &str,
    name: &str,
) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(bad("Name required"));
    }
    check_len(name, NAME_MAX, what)?;
    check_profanity(db, target, name).await
}

async fn check_server_name(db: &Db, name: &str) -> Result<(), ApiError> {
    check_name(db, ProfanityTarget::ServerNames, "Server name", name).await?;
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
        "SELECT name, display_name, creator, password_hash, banner_color, name_color FROM servers WHERE name = $1 AND COALESCE(password_hash, '') <> '!purging'",
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
            banner_color: r.try_get(4)?,
            name_color: r.try_get(5)?,
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

async fn require_grant(db: &Db, server: &str, actor: &User, perms: i64) -> Result<(), ApiError> {
    let mine = effective_perms(db, server, actor).await?;
    match can_grant(mine, actor.is_site_admin, perms) {
        true => Ok(()),
        false => Err(forbidden("You can't grant permissions you don't have")),
    }
}

fn announce_kick(hub: &Hub, server: &str, username: &str, banned: bool) {
    hub.broadcast(WsEvent::MemberKicked {
        server: server.to_string(),
        username: username.to_string(),
        banned,
    });
    hub.force_offline(server, username);
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

const MY_SERVERS: &str = "SELECT s.name, s.display_name, s.creator, m.is_admin, m.joined_at, s.banner_color, s.name_color FROM members m JOIN servers s ON s.name = m.server WHERE m.username = $1";

fn summary_rows(rows: &[sqlx::any::AnyRow]) -> Result<Vec<ServerSummary>, ApiError> {
    let mut servers = Vec::with_capacity(rows.len());
    for r in rows {
        servers.push(ServerSummary {
            name: r.try_get(0)?,
            display_name: r.try_get(1)?,
            creator: r.try_get(2)?,
            is_admin: r.try_get::<i64, _>(3)? != 0,
            banner_color: r.try_get(5)?,
            name_color: r.try_get(6)?,
        });
    }
    Ok(servers)
}

pub(crate) struct Page<T> {
    pub items: Vec<T>,
    pub more: bool,
    pub next: Option<String>,
}

pub(crate) async fn my_servers_page(
    db: &Db,
    username: &str,
    offset: i64,
    cursor: Option<&str>,
    limit: i64,
) -> Result<Page<ServerSummary>, ApiError> {
    let mut rows = match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            let sql = format!(
                "{MY_SERVERS} AND (m.joined_at, m.server) > ($2, $3) ORDER BY m.joined_at, m.server LIMIT $4"
            );
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(username)
                .bind(cursor_int(&parts[0])?)
                .bind(parts[1].clone())
                .bind(limit + 1)
                .fetch_all(db)
                .await?
        }
        None => {
            let sql = format!("{MY_SERVERS} ORDER BY m.joined_at, m.server LIMIT $2 OFFSET $3");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(username)
                .bind(limit + 1)
                .bind(offset)
                .fetch_all(db)
                .await?
        }
    };
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match (more, rows.last()) {
        (true, Some(r)) => Some(encode_cursor(&[
            &r.try_get::<i64, _>(4)?.to_string(),
            &r.try_get::<String, _>(0)?,
        ])),
        _ => None,
    };
    Ok(Page {
        items: summary_rows(&rows)?,
        more,
        next,
    })
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
        "{MY_SERVERS} AND m.server IN ({}) ORDER BY m.joined_at, m.server",
        placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(username);
    for name in names {
        query = query.bind(name);
    }
    summary_rows(&query.fetch_all(db).await?)
}

/// List your servers
///
/// Returns the servers the signed-in user is a member of, oldest membership first, as pages of
/// `limit` (default 50, max 100). Page with `cursor` from the `X-Next-Cursor` response header (or
/// the legacy `offset`). With `names` it returns just those servers instead, unpaged, skipping ones
/// you are not a member of. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/me/servers",
    tag = "Account",
    params(MyServersQuery),
    responses(
        (status = 200, description = "A page of the servers you joined, oldest membership first, or just the requested `names`", body = Vec<ServerSummary>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor, or a non-integer `offset` or `limit`", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_my_servers(
    State(state): State<AppState>,
    Authed(user): Authed,
    RawQuery(raw): RawQuery,
) -> Result<Paged<ServerSummary>, ApiError> {
    let MyServersQuery {
        offset,
        limit,
        cursor,
        names,
    } = MyServersQuery::parse(raw.as_deref().unwrap_or(""))?;
    let db = &state.read();
    match names {
        Some(names) => Ok(Paged(
            my_servers_by_names(
                db,
                &user.username,
                &unique_capped(names.iter().map(|n| n.to_lowercase())),
            )
            .await?,
            None,
        )),
        None => {
            let (offset, limit) = page_bounds(offset, limit);
            let Page {
                items,
                more: _,
                next,
            } = my_servers_page(db, &user.username, offset, cursor.as_deref(), limit).await?;
            Ok(Paged(items, next))
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

pub(crate) async fn visible_restricted(
    db: &Db,
    server: &str,
    viewer: Option<&User>,
    restricted: &[i64],
) -> Result<HashSet<i64>, ApiError> {
    let Some(user) = viewer else {
        return Ok(HashSet::new());
    };
    if restricted.is_empty() {
        return Ok(HashSet::new());
    }
    if crate::db::manages_channels(db, server, user).await? {
        return Ok(restricted.iter().copied().collect());
    }
    let subjects = crate::db::perm_subjects(db, Some(server), &user.username).await?;
    let sql = format!(
        "SELECT DISTINCT cp.channel_id FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id WHERE c.server = $1 AND cp.can_view != 0 AND cp.subject IN ({})",
        placeholders(2, subjects.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for subject in &subjects {
        query = query.bind(subject);
    }
    let mut visible = HashSet::new();
    for r in &query.fetch_all(db).await? {
        visible.insert(r.try_get::<i64, _>(0)?);
    }
    Ok(visible)
}

pub(crate) async fn member_count(db: &Db, server: &str) -> Result<i64, ApiError> {
    Ok(
        sqlx::query("SELECT member_count FROM servers WHERE name = $1")
            .bind(server)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get::<i64, _>(0))
            .transpose()?
            .unwrap_or(0),
    )
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
        banner_color,
        name_color,
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
    let visible = visible_restricted(db, &name, viewer, &restricted).await?;
    let mut channels = Vec::new();
    for r in &rows {
        let id: i64 = r.try_get(0)?;
        if restricted.contains(&id) && !visible.contains(&id) {
            continue;
        }
        channels.push(Channel {
            id,
            name: r.try_get(1)?,
            kind: ChannelKind::parse(&r.try_get::<String, _>(2)?)?,
            slowmode_seconds: r.try_get(3)?,
        });
    }
    let member_count = member_count(db, &name).await?;
    let online_count = hub.online_count(&name);
    Ok(ServerDetail {
        name: name.clone(),
        display_name,
        creator,
        has_password,
        banner_color,
        name_color,
        channels,
        roles: server_roles(db, &name).await?,
        role_limits: role_limits(db, &name, viewer).await?,
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

async fn online_members(
    db: &Db,
    server: &str,
    hub: &Hub,
    after: Option<&str>,
    mut skip: usize,
    want: usize,
) -> Result<(Vec<MemberRow>, usize), ApiError> {
    let mut out = Vec::new();
    let mut skipped = 0;
    let mut from = after.map(str::to_string);
    loop {
        let chunk = hub.online_after(server, from.as_deref(), LIST_MAX as usize);
        let Some(last) = chunk.last() else {
            return Ok((out, skipped));
        };
        from = Some(last.clone());
        for row in members_by_names(db, server, &chunk).await? {
            if skip > 0 {
                skip -= 1;
                skipped += 1;
                continue;
            }
            out.push(row);
            if out.len() == want {
                return Ok((out, skipped));
            }
        }
    }
}

const OFFLINE_CHUNK_MAX: usize = 5000;

async fn offline_members(
    db: &Db,
    server: &str,
    hub: &Hub,
    mut after: Option<String>,
    mut skip: usize,
    want: usize,
) -> Result<Vec<MemberRow>, ApiError> {
    let mut out = Vec::new();
    let mut chunk = (want + skip).clamp(64, OFFLINE_CHUNK_MAX) as i64;
    loop {
        let rows = match &after {
            Some(a) => sqlx::query(
                "SELECT username, is_admin, perms FROM members WHERE server = $1 AND username > $2 ORDER BY username LIMIT $3",
            )
            .bind(server)
            .bind(a)
            .bind(chunk),
            None => sqlx::query(
                "SELECT username, is_admin, perms FROM members WHERE server = $1 ORDER BY username LIMIT $2",
            )
            .bind(server)
            .bind(chunk),
        }
        .fetch_all(db)
        .await?;
        let rows = member_rows(&rows)?;
        let exhausted = (rows.len() as i64) < chunk;
        chunk = (chunk * 2).min(OFFLINE_CHUNK_MAX as i64);
        if let Some((last, _, _)) = rows.last() {
            after = Some(last.clone());
        }
        let names: Vec<String> = rows.iter().map(|(name, _, _)| name.clone()).collect();
        let online: HashSet<String> = hub
            .online_among(server, &names)
            .into_iter()
            .map(str::to_string)
            .collect();
        for row in rows {
            if online.contains(&row.0) {
                continue;
            }
            if skip > 0 {
                skip -= 1;
                continue;
            }
            out.push(row);
            if out.len() == want {
                return Ok(out);
            }
        }
        if exhausted {
            return Ok(out);
        }
    }
}

async fn members_page(
    db: &Db,
    server: &str,
    hub: &Hub,
    offset: Option<i64>,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> Result<(Vec<MemberRow>, Option<String>), ApiError> {
    let limit = limit.unwrap_or(50).clamp(1, 50) as usize;
    let want = limit + 1;
    let (from_online, after, skip) = match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            match parts[0].as_str() {
                "o" => (true, Some(parts[1].clone()), 0),
                "f" => (false, Some(parts[1].clone()), 0),
                _ => return Err(bad("Invalid cursor")),
            }
        }
        None => (
            true,
            None,
            offset.unwrap_or(0).clamp(0, OFFSET_MAX) as usize,
        ),
    };
    let mut rows: Vec<(bool, MemberRow)> = Vec::with_capacity(want);
    let mut skip = skip;
    let mut offline_after = after.clone();
    if from_online {
        let (got, skipped) = online_members(db, server, hub, after.as_deref(), skip, want).await?;
        skip -= skipped.min(skip);
        rows.extend(got.into_iter().map(|r| (true, r)));
        offline_after = None;
    }
    if rows.len() < want {
        let got = offline_members(db, server, hub, offline_after, skip, want - rows.len()).await?;
        rows.extend(got.into_iter().map(|r| (false, r)));
    }
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = match (more, rows.last()) {
        (true, Some((phase, (username, _, _)))) => Some(encode_cursor(&[
            match phase {
                true => "o",
                false => "f",
            },
            username,
        ])),
        _ => None,
    };
    Ok((rows.into_iter().map(|(_, r)| r).collect(), next))
}

/// List server members
///
/// Returns members as pages of `limit` (default and max 50): online members first, then offline
/// ones, each alphabetical by username. Page with `cursor` from the `X-Next-Cursor` response header
/// (or the legacy `offset`). With `q` (username prefix) and/or `admins=1` it returns matching
/// members alphabetically, paged by `cursor` only. With `usernames` it returns just those users
/// that are members, alphabetical and unpaged.
///
/// Signed-in users may call it, and guests when guest access is on. Banned users get 403. On a
/// password-protected server signed-in callers must be members and guests need a valid
/// `X-Guest-Grant`. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/servers/{name}/members",
    tag = "Members",
    params(("name" = String, Path, description = "Server name, case-insensitive"), MemberListQuery, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")),
    responses(
        (status = 200, description = "A page of members, or just the requested `usernames`", body = Vec<Member>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor (including a cursor from a different kind of listing), or a non-integer `offset` or `limit`", body = ApiErrorBody),
        (status = 401, description = "Guest access is disabled (no or unknown token), or a guest on a password-protected server sent only invalid or expired grants", body = ApiErrorBody),
        (status = 403, description = "You are banned from this server, or it is password-protected and you are not a member (signed in) or sent no guest grant (guest)", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn list_members(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Paged<Member>, ApiError> {
    let MemberListQuery {
        offset,
        limit,
        cursor,
        usernames,
        q,
        admins,
    } = MemberListQuery::parse(raw.as_deref().unwrap_or(""))?;
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    let lite = require_server(db, &key).await?;
    require_server_view(db, &headers, &lite, viewer.as_ref()).await?;
    let creator = lite.creator;
    let (rows, next) = match usernames {
        Some(names) => (
            members_by_names(
                db,
                &key,
                &unique_capped(names.iter().map(|n| n.to_lowercase())),
            )
            .await?,
            None,
        ),
        None if q.is_some() || admins == Some(true) => {
            filtered_members(
                db,
                &key,
                q.as_deref(),
                admins == Some(true),
                limit,
                cursor.as_deref(),
            )
            .await?
        }
        None => members_page(db, &key, &state.hub, offset, limit, cursor.as_deref()).await?,
    };
    let names: Vec<String> = rows.iter().map(|(name, _, _)| name.clone()).collect();
    let online = state.hub.online_among(&key, &names);
    let refs = user_refs(db, &names).await;
    let mut roles = role_ids_of(db, &key, &names).await?;
    let members = rows
        .into_iter()
        .map(|(username, is_admin, perms)| Member {
            online: online.contains(username.as_str()),
            is_admin: is_admin != 0,
            is_creator: creator.as_deref() == Some(username.as_str()),
            perms,
            role_ids: roles.remove(&username).unwrap_or_default(),
            user: user_from(&refs, &username),
        })
        .collect();
    Ok(Paged(members, next))
}

fn pair_cursor(raw: Option<&str>) -> Result<Option<(i64, String)>, ApiError> {
    match raw.filter(|c| !c.trim().is_empty()) {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            Ok(Some((cursor_int(&parts[0])?, parts[1].clone())))
        }
        None => Ok(None),
    }
}

fn pair_next(more: bool, last: Option<&(String, i64)>) -> Option<String> {
    match (more, last) {
        (true, Some((name, at))) => Some(encode_cursor(&[&at.to_string(), name])),
        _ => None,
    }
}

async fn recent_pairs(
    db: &Db,
    sql_first: &str,
    sql_after: &str,
    server: &str,
    after: Option<(i64, String)>,
    offset: i64,
    limit: i64,
) -> Result<(Vec<(String, i64)>, Option<String>), ApiError> {
    let rows = match after {
        Some((at, name)) => {
            sqlx::query(sqlx::AssertSqlSafe(sql_after.to_string()))
                .bind(server)
                .bind(at)
                .bind(name)
                .bind(limit + 1)
                .fetch_all(db)
                .await?
        }
        None => {
            sqlx::query(sqlx::AssertSqlSafe(sql_first.to_string()))
                .bind(server)
                .bind(limit + 1)
                .bind(offset)
                .fetch_all(db)
                .await?
        }
    };
    let mut pairs = Vec::with_capacity(rows.len());
    for r in &rows {
        pairs.push((r.try_get::<String, _>(0)?, r.try_get::<i64, _>(1)?));
    }
    let more = pairs.len() as i64 > limit;
    pairs.truncate(limit as usize);
    let next = pair_next(more, pairs.last());
    Ok((pairs, next))
}

/// List non-members who interacted
///
/// Returns users who sent a message or joined a voice channel in the server but are not members
/// now (for example former members), most recent interaction first, as pages of `limit` (default
/// and max 50). Page with `cursor` from the `X-Next-Cursor` response header (or the legacy
/// `offset`).
///
/// Signed-in users may call it, and guests when guest access is on. Banned users get 403. On a
/// password-protected server signed-in callers must be members and guests need a valid
/// `X-Guest-Grant`. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/servers/{name}/interacted",
    tag = "Members",
    params(("name" = String, Path, description = "Server name, case-insensitive"), MembersQuery, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")),
    responses(
        (status = 200, description = "A page of users who interacted with the server and are not members, most recent first", body = Vec<UserRef>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor (JSON), or a non-integer `offset` or `limit` (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Guest access is disabled (no or unknown token), or a guest on a password-protected server sent only invalid or expired grants", body = ApiErrorBody),
        (status = 403, description = "You are banned from this server, or it is password-protected and you are not a member (signed in) or sent no guest grant (guest)", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn list_interacted(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<MembersQuery>,
) -> Result<Paged<UserRef>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    let lite = require_server(db, &key).await?;
    require_server_view(db, &headers, &lite, viewer.as_ref()).await?;
    let MembersQuery {
        offset,
        limit,
        cursor,
    } = q;
    let (pairs, next) = recent_pairs(
        db,
        "SELECT i.username, i.last_at FROM interactions i WHERE i.server = $1 AND NOT EXISTS(SELECT 1 FROM members m WHERE m.server = i.server AND m.username = i.username) ORDER BY i.last_at DESC, i.username DESC LIMIT $2 OFFSET $3",
        "SELECT i.username, i.last_at FROM interactions i WHERE i.server = $1 AND (i.last_at, i.username) < ($2, $3) AND NOT EXISTS(SELECT 1 FROM members m WHERE m.server = i.server AND m.username = i.username) ORDER BY i.last_at DESC, i.username DESC LIMIT $4",
        &key,
        pair_cursor(cursor.as_deref())?,
        offset.unwrap_or(0).max(0),
        limit.unwrap_or(50).clamp(1, 50),
    )
    .await?;
    let names: Vec<String> = pairs.into_iter().map(|(name, _)| name).collect();
    let refs = user_refs(db, &names).await;
    Ok(Paged(
        names.iter().map(|n| user_from(&refs, n)).collect(),
        next,
    ))
}

/// Create a server
///
/// Creates a server owned by the caller: they become its creator and an admin with all
/// permissions, and it starts with one text channel named `general`. Requires a bearer token.
/// Emits `server_created` to the creator. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers",
    tag = "Servers",
    request_body = CreateServerReq,
    responses(
        (status = 200, description = "The created server, with the caller as admin and a default `general` text channel", body = ServerDetail),
        (status = 400, description = "Invalid name (blank, longer than 100 characters, `.` or `..`, or blocked by the profanity filter) or the name is taken. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 409, description = "That name belonged to a deleted server that is still being purged; try again later", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<CreateServerReq>,
) -> Result<Json<ServerDetail>, ApiError> {
    let display = req.name.trim().to_string();
    let key = display.to_lowercase();
    check_server_name(&state.db, &display).await?;
    name_free(&state.db, &key).await?;
    let password_hash = match req
        .password
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        Some(password) => Some(hash_password(password).await?),
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
            banner_color: None,
            name_color: None,
        },
    });
    Ok(Json(detail))
}

/// Get a server
///
/// Returns the server with its channels, roles and member and online counts. Channels that have
/// permission rules are only listed when a rule lets the viewer see them or the viewer has the
/// Manage channels permission; guests only see channels without rules. For callers with Manage
/// admins, `role_limits` lists the roles they can't edit, delete or assign.
///
/// Signed-in users may call it, and guests when guest access is on. Banned users get 403. On a
/// password-protected server signed-in callers must be members and guests need a valid
/// `X-Guest-Grant`. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/servers/{name}",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")),
    responses(
        (status = 200, description = "Server details: channels visible to the viewer, roles, and member and online counts", body = ServerDetail),
        (status = 401, description = "Guest access is disabled (no or unknown token), or a guest on a password-protected server sent only invalid or expired grants", body = ApiErrorBody),
        (status = 403, description = "You are banned from this server, or it is password-protected and you are not a member (signed in) or sent no guest grant (guest)", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn get_server(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<ServerDetail>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    let lite = require_server(db, &key).await?;
    require_server_view(db, &headers, &lite, viewer.as_ref()).await?;
    Ok(Json(
        server_detail(db, &state.hub, &key, viewer.as_ref()).await?,
    ))
}

/// Check that a server exists
///
/// Reports whether the server exists and needs a password. Does not check bans or membership.
/// Signed-in users may call it, and guests when guest access is on. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/servers/{name}/exists",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "The server exists; reports whether it is password-protected", body = ServerExists),
        (status = 401, description = "Guest access is disabled and no valid token was sent", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn server_exists(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    Path(name): Path<String>,
) -> Result<Json<ServerExists>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let ServerSummaryLite {
        name: _,
        display_name: _,
        creator: _,
        has_password,
        banner_color: _,
        name_color: _,
    } = require_server(db, &name.to_lowercase()).await?;
    Ok(Json(ServerExists { has_password }))
}

/// Search servers
///
/// Finds up to 10 servers, ordered by name, whose name or display name matches `q`. Queries of up
/// to 8 characters match fuzzily (the characters in order, not necessarily adjacent); longer ones
/// match as a substring. Password-protected servers are included and flagged. A blank `q` returns
/// an empty list. Signed-in users may call it, and guests when guest access is on. General
/// rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/server_search",
    tag = "Search",
    params(ServerSearchQuery),
    responses(
        (status = 200, description = "Up to 10 servers whose name or display name matches the query", body = Vec<ServerMatch>),
        (status = 401, description = "Guest access is disabled and no valid token was sent", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn search_servers(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    Query(sq): Query<ServerSearchQuery>,
) -> Result<Json<Vec<ServerMatch>>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let q = sq.q.as_deref().unwrap_or("").trim().to_lowercase();
    if q.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let fuzzy = is_fuzzy(&q);
    let rows = sqlx::query(
        "SELECT name, display_name, password_hash FROM servers WHERE (lower(name) LIKE $1 ESCAPE '\\' OR lower(display_name) LIKE $1 ESCAPE '\\') AND COALESCE(password_hash, '') <> '!purging' ORDER BY name LIMIT 50",
    )
    .bind(like_pattern(&q, fuzzy))
    .fetch_all(db)
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

/// Get guest access to a server
///
/// Checks the password of a password-protected server and returns a guest grant. Guests send the
/// grant in the `X-Guest-Grant` header to view the server without an account; it expires after
/// `GUEST_GRANT_DAYS` days without use (30 by default) and is revoked when the password changes
/// (unless the change kept guests). Anyone may call it, guests only when guest access is on.
/// Strict and general rate-limit buckets.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/guest_access",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = GuestAccessReq,
    responses(
        (status = 200, description = "Password accepted; returns a guest grant for viewing the server without an account", body = GuestGrant),
        (status = 400, description = "The server has no password. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Wrong password, or guest access is disabled and no valid token was sent", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the strict or the general bucket", content_type = "text/plain", body = String)
    ),
    security((), ("bearer" = []))
)]
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
    if !verify_password(&req.password, &hash).await {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Wrong password".to_string(),
        ));
    }
    let grant = new_token();
    sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, $2, $3, $3)")
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
        Some(hash) => verify_password_cached(&given, &hash).await,
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

/// Preview an invite
///
/// Returns an invite card for the server: the server, the viewer's `status`, member and online
/// counts and a short preview of recent messages. Counts are `null` and the preview is empty while
/// the server is locked: it has a password, the viewer is not a member, and neither a valid
/// `X-Invite-Password` nor (for guests) a valid `X-Guest-Grant` was sent. Banned viewers get counts
/// when unlocked but never a preview. The preview holds the last 3 top-level messages of the first
/// text channel without permission rules.
///
/// Signed-in users may call it, and guests when guest access is on. Invite and general rate-limit
/// buckets.
#[utoipa::path(
    get,
    path = "/api/invites/{name}",
    tag = "Invites",
    params(
        ("name" = String, Path, description = "Server name, case-insensitive"),
        ("X-Invite-Password" = Option<String>, Header, description = "Percent-encoded server password from the invite link; blank counts as absent"),
        ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests; a valid grant unlocks the card")
    ),
    responses(
        (status = 200, description = "Invite card for the server", body = Invite),
        (status = 401, description = "Guest access is disabled and no valid token was sent", body = ApiErrorBody),
        (status = 404, description = "Invalid invite: the server does not exist", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the invite or the general bucket", content_type = "text/plain", body = String)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn get_invite(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Invite>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let key = name.to_lowercase();
    let server = require_server(db, &key).await?;
    let member = match &viewer {
        Some(user) => is_member(db, &key, &user.username).await?,
        None => false,
    };
    let banned = match &viewer {
        Some(user) if !member => is_banned(db, &key, &user.username).await?,
        _ => false,
    };
    let open = !server.has_password
        || member
        || invite_unlocked(db, &headers, &key, viewer.as_ref()).await?;
    let unlocked = !banned && open;
    let status = match (member, banned, unlocked) {
        (true, _, _) => InviteStatus::Member,
        (false, true, _) => InviteStatus::Banned,
        (false, false, true) => InviteStatus::Joinable,
        (false, false, false) => InviteStatus::PasswordRequired,
    };
    let (preview_channel, preview) = match unlocked {
        true => invite_preview(db, &key).await?,
        false => (None, Vec::new()),
    };
    let (member_count, online_count) = match open {
        true => {
            let members = member_count(db, &key).await?;
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

/// Join a server
///
/// Adds the caller as a member (not an admin) and returns the server details. A password-protected
/// server needs `password` in the body unless the caller is already a member; the body may be
/// omitted otherwise (send no `Content-Type`). Joining a server you are already in succeeds
/// without changes. Requires a bearer token; banned users get 403. Emits `member_joined` to the
/// server and the joining user when a new membership was created. Join and general rate-limit
/// buckets.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/join",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body(content = Option<JoinReq>, description = "Optional; only needed for a password-protected server you are not a member of"),
    responses(
        (status = 200, description = "Joined, or already a member; returns the server details", body = ServerDetail),
        (status = 400, description = "Malformed JSON body (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token, or wrong or missing password", body = ApiErrorBody),
        (status = 403, description = "You are banned from this server", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the join or the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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
                (Some(hash), Some(password)) => verify_password(password, hash).await,
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

/// Leave a server
///
/// Removes the caller from the server and drops their role assignments. Anyone may leave,
/// including the creator and admins. Requires a bearer token. Emits `member_left` to the server
/// and the caller, and the caller goes offline in the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/leave",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "Left the server and dropped its roles", body = OkResp),
        (status = 400, description = "Not a member", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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

/// Update a server
///
/// Renames the server, sets, changes or clears its password, and changes its header colors; every
/// field is optional. Requires the Delete server permission; `members: remove` together with
/// `password` also requires Kick. The rchat server can't be renamed or given a password, but its
/// colors may change.
///
/// When `password` is present, `members: remove` removes every other member whose server
/// permissions are a strict subset of yours (their roles are dropped, as if kicked) and existing
/// guest grants are revoked unless `keep_guests` is true with `members: keep`. The response
/// carries `removed` and `kept` counts.
///
/// Emits `server_renamed` (with `old_name`) to the server when the name or display name changed,
/// otherwise `server_updated` with the new state (password flag and colors), and
/// `members_purged` to the server and the removed members. General rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/servers/{name}",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = ServerPatch,
    responses(
        (status = 200, description = "The updated server, with `removed`, the number of members removed, and `kept`, the number of other members who stayed", body = ServerUpdated),
        (status = 400, description = "Invalid server name (blank, longer than 100 characters, `.` or `..`, or blocked by the profanity filter), the name is taken, or an invalid banner or name color. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission, missing Kick for `members: remove`, or a rename or password change on the protected rchat server", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 409, description = "The new name belonged to a deleted server that is still being purged; try again later", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn update_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<ServerPatch>,
) -> Result<Json<ServerUpdated>, ApiError> {
    let key = name.to_lowercase();
    let ServerPatch {
        name,
        password,
        members,
        keep_guests,
        banner_color,
        name_color,
    } = req;
    if name.is_some() || password.is_some() {
        guard_rchat(&key)?;
    }
    let lite = require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::DeleteServer).await?;
    let banner_color = server_color(banner_color, "banner")?;
    let name_color = server_color(name_color, "name")?;
    let purge = password.is_some() && members == PasswordMembers::Remove;
    if purge {
        require_perm(&state.db, &key, &user, Perm::Kick).await?;
    }
    let mine = effective_perms(&state.db, &key, &user).await?;
    let (new_key, display) = match &name {
        Some(n) => {
            let display = n.trim().to_string();
            let new_key = display.to_lowercase();
            check_server_name(&state.db, &display).await?;
            if new_key != key {
                name_free(&state.db, &new_key).await?;
            }
            (new_key, display)
        }
        None => (key.clone(), lite.display_name.clone()),
    };
    let password_hash = match password.as_deref().map(str::trim) {
        Some("") => Some(None),
        Some(p) => Some(Some(hash_password(p).await?)),
        None => None,
    };
    let mut tx = state.db.begin().await?;
    rename_live(&mut tx, &key, &new_key, &display, password_hash.as_ref()).await?;
    set_colors(
        &mut tx,
        &new_key,
        banner_color.as_ref(),
        name_color.as_ref(),
    )
    .await?;
    let (removed, kept) = match purge {
        true => purge_members(&mut tx, &new_key, &user, mine).await?,
        false => (
            Vec::new(),
            other_members(&mut tx, &new_key, &user.username).await?,
        ),
    };
    if password_hash.is_some() && !(keep_guests && members == PasswordMembers::Keep) {
        sqlx::query("DELETE FROM guest_grants WHERE server = $1")
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let renamed = new_key != key || display != lite.display_name;
    let server = ServerSummaryLite {
        name: new_key,
        display_name: display,
        creator: lite.creator,
        has_password: match &password_hash {
            Some(hash) => hash.is_some(),
            None => lite.has_password,
        },
        banner_color: banner_color.unwrap_or(lite.banner_color),
        name_color: name_color.unwrap_or(lite.name_color),
    };
    state.hub.broadcast(match renamed {
        true => WsEvent::ServerRenamed {
            old_name: key,
            server: server.clone(),
        },
        false => WsEvent::ServerUpdated {
            server: server.clone(),
        },
    });
    crate::ws::announce_purge(&state.hub, &server.name, &removed);
    Ok(Json(ServerUpdated {
        server,
        removed: removed.len() as i64,
        kept,
    }))
}

fn server_color(
    color: Option<Option<String>>,
    what: &str,
) -> Result<Option<Option<String>>, ApiError> {
    match color {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(c)) if valid_color(&c) => Ok(Some(Some(c.to_lowercase()))),
        Some(Some(_)) => Err(bad(&format!("Invalid {what} color"))),
    }
}

async fn set_colors(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    key: &str,
    banner: Option<&Option<String>>,
    name: Option<&Option<String>>,
) -> Result<(), ApiError> {
    for (sql, color) in [
        (
            "UPDATE servers SET banner_color = $1 WHERE name = $2",
            banner,
        ),
        ("UPDATE servers SET name_color = $1 WHERE name = $2", name),
    ] {
        if let Some(color) = color {
            sqlx::query(sql)
                .bind(color)
                .bind(key)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

async fn rename_live(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    key: &str,
    new_key: &str,
    display: &str,
    password_hash: Option<&Option<String>>,
) -> Result<(), ApiError> {
    let renamed = sqlx::query(
        "UPDATE servers SET name = $1, display_name = $2 WHERE name = $3 AND COALESCE(password_hash, '') <> '!purging'",
    )
    .bind(new_key)
    .bind(display)
    .bind(key)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    if renamed == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Server not found".to_string(),
        ));
    }
    if let Some(hash) = password_hash {
        sqlx::query(
            "UPDATE servers SET password_hash = $1 WHERE name = $2 AND COALESCE(password_hash, '') <> '!purging'",
        )
        .bind(hash)
        .bind(new_key)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn name_free(db: &Db, key: &str) -> Result<(), ApiError> {
    let row = sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
        .bind(key)
        .fetch_optional(db)
        .await?;
    match row {
        None => Ok(()),
        Some(r) => match r.try_get::<Option<String>, _>(0)?.as_deref() {
            Some(crate::db::PURGING_HASH) => Err(ApiError(
                StatusCode::CONFLICT,
                "That name is not available yet".to_string(),
            )),
            _ => Err(bad("Server name is taken")),
        },
    }
}

async fn other_members(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    server: &str,
    username: &str,
) -> Result<i64, ApiError> {
    Ok(
        sqlx::query("SELECT COUNT(*) FROM members WHERE server = $1 AND username <> $2")
            .bind(server)
            .bind(username)
            .fetch_one(&mut **tx)
            .await?
            .try_get(0)?,
    )
}

async fn purge_members(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    server: &str,
    actor: &User,
    mine: i64,
) -> Result<(Vec<String>, i64), ApiError> {
    let rows = sqlx::query(
        "SELECT username, is_admin, perms FROM members WHERE server = $1 AND username <> $2",
    )
    .bind(server)
    .bind(&actor.username)
    .fetch_all(&mut **tx)
    .await?;
    let role_rows = sqlx::query(
        "SELECT ur.username, r.perms FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1",
    )
    .bind(server)
    .fetch_all(&mut **tx)
    .await?;
    let mut roles: HashMap<String, i64> = HashMap::new();
    for r in &role_rows {
        *roles.entry(r.try_get(0)?).or_default() |= r.try_get::<i64, _>(1)?;
    }
    let mut removed = Vec::new();
    let mut kept = 0;
    for r in &rows {
        let username: String = r.try_get(0)?;
        let theirs = perm_bits(
            r.try_get::<i64, _>(1)? != 0,
            r.try_get(2)?,
            roles.get(&username).copied().unwrap_or(0),
        );
        match can_moderate(mine, actor.is_site_admin, theirs) {
            true => removed.push(username),
            false => kept += 1,
        }
    }
    for chunk in removed.chunks(500) {
        for table in ["members", "user_roles"] {
            let sql = format!(
                "DELETE FROM {table} WHERE server = $1 AND username IN ({})",
                placeholders(2, chunk.len())
            );
            let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
            for name in chunk {
                query = query.bind(name);
            }
            query.execute(&mut **tx).await?;
        }
    }
    Ok((removed, kept))
}

/// Delete a server
///
/// Deletes the server. Members, bans, role assignments and guest grants go at once and the server
/// disappears from the API; its channels, messages and roles are purged in the background, and
/// until that finishes its name can't be reused (409 on create). Requires the Delete server
/// permission; the rchat server can't be deleted. Emits `server_deleted` to the server. General
/// rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/servers/{name}",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "Server deleted along with its channels, members, and roles", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission, or the server is the protected rchat server", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn delete_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    guard_rchat(&key)?;
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, &user, Perm::DeleteServer).await?;
    match crate::api::admin::remove_server(&state, &key).await? {
        true => Ok(ok()),
        false => Err(not_found("Server not found")),
    }
}

/// Create a channel
///
/// Adds a text or voice channel to the server, with slow mode off. A server can have at most 500
/// channels. Requires the Manage channels permission. Emits `channel_created` to the server.
/// General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/channels",
    tag = "Channels",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = CreateChannelReq,
    responses(
        (status = 200, description = "The created channel", body = Channel),
        (status = 400, description = "Invalid channel name (blank, longer than 100 characters or blocked by the profanity filter), the name is taken in this server, or the server already has 500 channels. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_channel(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<CreateChannelReq>,
) -> Result<Json<Channel>, ApiError> {
    let key = name.to_lowercase();
    let channel_name = req.name.trim().to_string();
    let kind = req.kind.unwrap_or(ChannelKind::Text);
    check_name(
        &state.db,
        ProfanityTarget::ChannelNames,
        "Channel name",
        &channel_name,
    )
    .await?;
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
    if count_rows(
        &state.db,
        "SELECT COUNT(*) FROM channels WHERE server = $1",
        &key,
    )
    .await?
        >= CHANNEL_MAX
    {
        return Err(bad(&format!(
            "A server can have at most {CHANNEL_MAX} channels"
        )));
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

/// Update a channel
///
/// Renames a channel and/or sets its slow mode; omitted fields are left unchanged. Slow mode is 0
/// to 21600 seconds and only text channels may have it. Requires the Manage channels permission
/// in the channel's server. Emits `channel_renamed` with the updated channel to the server when
/// the name changed, otherwise `channel_updated` (for example a slow-mode-only change). General
/// rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/channels/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Channel id")),
    request_body = ChannelPatch,
    responses(
        (status = 200, description = "The updated channel", body = Channel),
        (status = 400, description = "Slow mode out of range or set on a voice channel, an invalid channel name (blank, longer than 100 characters or blocked by the profanity filter), or the name is taken in this server. A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "Channel not found", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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
    let row = sqlx::query("SELECT server, kind, name FROM channels WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let (server, kind, old_name): (String, ChannelKind, String) = match &row {
        Some(r) => (
            r.try_get(0)?,
            ChannelKind::parse(&r.try_get::<String, _>(1)?)?,
            r.try_get(2)?,
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
            check_name(
                &state.db,
                ProfanityTarget::ChannelNames,
                "Channel name",
                &channel_name,
            )
            .await?;
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
    state.hub.broadcast(match channel.name == old_name {
        true => WsEvent::ChannelUpdated {
            server,
            channel: channel.clone(),
        },
        false => WsEvent::ChannelRenamed {
            server,
            channel: channel.clone(),
        },
    });
    Ok(Json(channel))
}

/// Delete a channel
///
/// Deletes a channel. A server always keeps at least one channel and at least one text channel.
/// Requires the Manage channels permission in the channel's server. Emits `channel_deleted` to the
/// server. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/channels/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Channel id")),
    responses(
        (status = 200, description = "Channel deleted", body = OkResp),
        (status = 400, description = "It is the server's only channel or only text channel. A non-integer `id` gives a plain-text 400", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "Channel not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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

/// Kick a member
///
/// Removes `username` from the server and drops their role assignments. Requires the Kick server
/// permission, and the target's server permissions must be a strict subset of yours (so you can't
/// kick yourself or someone with the same permissions). Kicked users may rejoin. Emits
/// `member_kicked` (with `banned: false`) to the server and the kicked user, who goes offline in
/// the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/kick",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = UsernameReq,
    responses(
        (status = 200, description = "Member removed from the server and their roles dropped", body = OkResp),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415 (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Kick permission, or the member's server permissions are not a strict subset of yours", body = ApiErrorBody),
        (status = 404, description = "Server not found, or the user is not a member", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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
            announce_kick(&state.hub, &key, &target, false);
            Ok(ok())
        }
    }
}

/// Ban a user
///
/// Bans `username` from the server: they are removed with their roles dropped, taken out of the
/// server's voice channels, and blocked from rejoining until unbanned. Works on non-members too,
/// and banning someone already banned succeeds without changes. Requires the Kick server
/// permission, and the target's server permissions must be a strict subset of yours. Emits
/// `member_kicked` (with `banned: true`) to the server and the user when they were a member,
/// otherwise `server_banned` to the user. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/bans",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = UsernameReq,
    responses(
        (status = 200, description = "User banned", body = OkResp),
        (status = 400, description = "You can't ban yourself. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Kick permission, or the user's server permissions are not a strict subset of yours", body = ApiErrorBody),
        (status = 404, description = "Server or user not found", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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
    match removed {
        0 => state.hub.broadcast(WsEvent::ServerBanned {
            server: key.clone(),
            username: target.clone(),
        }),
        _ => announce_kick(&state.hub, &key, &target, true),
    }
    for (cid, users) in state.hub.rooms_in(&key, None) {
        if users.contains(&target) {
            state.hub.evict_voice(&target, cid);
        }
    }
    Ok(ok())
}

/// Unban a user
///
/// Lifts a ban so the user may join again. Requires the Kick server permission. Emits no
/// WebSocket event. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/servers/{name}/bans/{username}",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Target username, case-insensitive")),
    responses(
        (status = 200, description = "Ban lifted; the user may join again", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Kick permission", body = ApiErrorBody),
        (status = 404, description = "Server not found, or the user is not banned", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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

/// List bans
///
/// Returns the users banned from the server, most recently banned first, as pages of `limit`
/// (default and max 50). Page with `cursor` from the `X-Next-Cursor` response header (or the
/// legacy `offset`). Requires the Kick server permission. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/servers/{name}/bans",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), MembersQuery),
    responses(
        (status = 200, description = "A page of banned users, most recently banned first", body = Vec<ServerBan>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor (JSON), or a non-integer `offset` or `limit` (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Kick permission", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_bans(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(q): Query<MembersQuery>,
) -> Result<Paged<ServerBan>, ApiError> {
    let key = name.to_lowercase();
    let db = &state.read();
    require_server(db, &key).await?;
    require_perm(db, &key, &user, Perm::Kick).await?;
    let MembersQuery {
        offset,
        limit,
        cursor,
    } = q;
    let (bans, next) = recent_pairs(
        db,
        "SELECT username, created_at FROM server_bans WHERE server = $1 ORDER BY created_at DESC, username DESC LIMIT $2 OFFSET $3",
        "SELECT username, created_at FROM server_bans WHERE server = $1 AND (created_at, username) < ($2, $3) ORDER BY created_at DESC, username DESC LIMIT $4",
        &key,
        pair_cursor(cursor.as_deref())?,
        offset.unwrap_or(0).max(0),
        limit.unwrap_or(50).clamp(1, 50),
    )
    .await?;
    let names: Vec<String> = bans.iter().map(|(name, _)| name.clone()).collect();
    let refs = user_refs(db, &names).await;
    Ok(Paged(
        bans.into_iter()
            .map(|(username, banned_at)| ServerBan {
                user: user_from(&refs, &username),
                banned_at,
            })
            .collect(),
        next,
    ))
}

async fn role_perms<'e, E>(ex: E, server: &str, username: &str) -> Result<i64, ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let rows = sqlx::query("SELECT r.perms FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username = $2")
        .bind(server)
        .bind(username)
        .fetch_all(ex)
        .await?;
    let mut acc = 0;
    for r in &rows {
        acc |= r.try_get::<i64, _>(0)?;
    }
    Ok(acc & ALL_PERMS)
}

const REVOKE_RAISES: &str = "They hold roles with permissions you don't have, so revoking their admin would give them those";

async fn set_admin(
    state: &AppState,
    actor: &User,
    server: &str,
    target: &str,
    is_admin: bool,
) -> Result<Json<OkResp>, ApiError> {
    require_server(&state.db, server).await?;
    require_perm(&state.db, server, actor, Perm::ManageAdmins).await?;
    if is_admin {
        require_grant(&state.db, server, actor, ALL_PERMS).await?;
    } else if !actor.is_site_admin {
        let row = sqlx::query(
            "SELECT perms FROM members WHERE server = $1 AND username = $2 AND is_admin <> 0",
        )
        .bind(server)
        .bind(target)
        .fetch_optional(&state.db)
        .await?;
        if let Some(r) = row {
            let old = perm_bits(true, r.try_get(0)?, 0);
            let roles = role_perms(&state.db, server, target).await?;
            let mine = effective_perms(&state.db, server, actor).await?;
            if roles & !old != 0 && !can_grant(mine, false, roles) {
                return Err(forbidden(REVOKE_RAISES));
            }
        }
    }
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

/// Make a member an admin
///
/// Marks `username` as a server admin and resets their admin permissions to 0, which means all
/// permissions. Works on any member, including current admins (whose permissions are reset) and
/// yourself. Requires the Manage admins server permission, and because the new admin gets every
/// permission, the caller must hold every permission too. Emits `admin_changed` to the server and
/// the user. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/admins",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = UsernameReq,
    responses(
        (status = 200, description = "Member promoted to admin with permissions reset to all", body = OkResp),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415 (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission, or you don't hold every permission (`You can't grant permissions you don't have`)", body = ApiErrorBody),
        (status = 404, description = "Server not found, or the user is not a member", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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

/// Revoke admin
///
/// Clears the admin flag and admin permissions of `username`; they keep the permissions of their
/// roles. Works on any member, including the creator, admins with more permissions than you and
/// members who are not admins. The one limit: an admin's roles count again once admin is
/// revoked, so if their roles have permissions their admin permissions lack, those role
/// permissions must be a subset of yours (otherwise revoking would raise them, or yourself, above
/// what you can grant). Requires the Manage admins server permission. Emits `admin_changed` to
/// the server and the user. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/servers/{name}/admins/{username}",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Target username, case-insensitive")),
    responses(
        (status = 200, description = "Admin status and permissions revoked", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission, or the admin's roles have permissions that neither their admin permissions nor yours include (`They hold roles with permissions you don't have, so revoking their admin would give them those`)", body = ApiErrorBody),
        (status = 404, description = "Server not found, or the user is not a member", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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

/// Transfer admin
///
/// Makes `username` an admin and clears the caller's admin flag and admin permissions, in one
/// transaction. Unlike granting admin, it does not reset the target's stored admin permission
/// mask (0, meaning all permissions, for members who are not admins), so an admin with
/// restricted permissions keeps them. The permissions the target ends up with must be a subset of
/// yours (equal is fine), and so must the permissions of your own roles, which count again once
/// you are no longer an admin. Requires the Manage admins server permission. Emits `admin_changed` for the target with
/// their stored mask and for the caller with 0, each to the server and that user. General
/// rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/transfer_admin",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = UsernameReq,
    responses(
        (status = 200, description = "Admin granted to the target member and revoked from the caller", body = OkResp),
        (status = 400, description = "Cannot transfer to yourself. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission; the target would get permissions you don't have (`You can't grant permissions you don't have`); or your own roles have permissions your admin permissions don't include, which you would gain by giving up admin", body = ApiErrorBody),
        (status = 404, description = "Server not found, or the user is not a member", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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
    let mine = effective_perms(&state.db, &key, &user).await?;
    let mut tx = state.db.begin().await?;
    let stored: i64 = match sqlx::query(
        "UPDATE members SET is_admin = 1 WHERE server = $1 AND username = $2 RETURNING perms",
    )
    .bind(&key)
    .bind(&target)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(r) => r.try_get(0)?,
        None => return Err(not_found("Not a member")),
    };
    if !can_grant(mine, user.is_site_admin, perm_bits(true, stored, 0)) {
        return Err(forbidden("You can't grant permissions you don't have"));
    }
    if !can_grant(
        mine,
        user.is_site_admin,
        role_perms(&mut *tx, &key, &user.username).await?,
    ) {
        return Err(forbidden(
            "You hold roles with permissions your admin permissions don't include, so giving up admin would give you those",
        ));
    }
    let revoked = sqlx::query(
        "UPDATE members SET is_admin = 0, perms = 0 WHERE server = $1 AND username = $2",
    )
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
        perms: stored,
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

/// Set an admin's permissions
///
/// Replaces the permission bitmask of the admin `username` (bits outside 31 are dropped; 0 means
/// all permissions). Taking permissions away works on any admin, like revoking admin. When the new
/// permissions add any the admin did not have, all of the new permissions must be ones you have
/// (equal is fine), so only callers holding every permission can set 0. Requires the Manage admins
/// server permission. Emits `admin_changed` to the server and the user. General rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/servers/{name}/admins/{username}/perms",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Target username, case-insensitive")),
    request_body = PermsReq,
    responses(
        (status = 200, description = "Admin permissions updated", body = OkResp),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415 (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission, or the change adds permissions and the new permissions include some you don't have (`You can't grant permissions you don't have`)", body = ApiErrorBody),
        (status = 404, description = "Server not found, or the user is not an admin of it", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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
    let perms = req.perms & ALL_PERMS;
    let mine = effective_perms(&state.db, &key, &user).await?;
    let mut tx = state.db.begin().await?;
    let stored: i64 = match sqlx::query(
        "SELECT perms FROM members WHERE server = $1 AND username = $2 AND is_admin != 0",
    )
    .bind(&key)
    .bind(&target)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(r) => r.try_get(0)?,
        None => return Err(not_found("Not an admin")),
    };
    let (old, new) = (perm_bits(true, stored, 0), perm_bits(true, perms, 0));
    if new & !old != 0 && !can_grant(mine, user.is_site_admin, new) {
        return Err(forbidden("You can't grant permissions you don't have"));
    }
    sqlx::query("UPDATE members SET perms = $1 WHERE server = $2 AND username = $3")
        .bind(perms)
        .bind(&key)
        .bind(&target)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::AdminChanged {
        server: key,
        username: target,
        is_admin: true,
        perms,
    });
    Ok(ok())
}

async fn require_role(db: &Db, server: &str, id: i64) -> Result<i64, ApiError> {
    match sqlx::query("SELECT perms FROM roles WHERE id = $1 AND server = $2")
        .bind(id)
        .bind(server)
        .fetch_optional(db)
        .await?
    {
        Some(r) => Ok(r.try_get(0)?),
        None => Err(not_found("Role not found")),
    }
}

async fn role_guard(state: &AppState, name: &str, user: &User) -> Result<String, ApiError> {
    let key = name.to_lowercase();
    require_server(&state.db, &key).await?;
    require_perm(&state.db, &key, user, Perm::ManageAdmins).await?;
    Ok(key)
}

fn held_above_sql(one: bool) -> String {
    let bits = [
        Perm::ManageChannels,
        Perm::DeleteMessages,
        Perm::Kick,
        Perm::DeleteServer,
        Perm::ManageAdmins,
    ]
    .map(|p| format!("MAX(r.perms & {})", p as i64))
    .join(" | ");
    let role = match one {
        true => " AND h.role_id = $4",
        false => "",
    };
    format!(
        "SELECT DISTINCT t.role_id FROM (SELECT h.role_id AS role_id, CASE WHEN m.is_admin <> 0 THEN CASE WHEN m.perms = 0 THEN {ALL_PERMS} ELSE m.perms & {ALL_PERMS} END ELSE {bits} END AS eff FROM user_roles h JOIN members m ON m.server = h.server AND m.username = h.username JOIN user_roles ur ON ur.server = h.server AND ur.username = h.username JOIN roles r ON r.id = ur.role_id WHERE h.server = $1 AND h.username <> $2{role} GROUP BY h.role_id, h.username, m.is_admin, m.perms) t WHERE (t.eff | $3) <> $3 OR t.eff = $3"
    )
}

async fn held_above(
    db: &Db,
    server: &str,
    actor: &User,
    mine: i64,
    role: Option<i64>,
) -> Result<HashSet<i64>, ApiError> {
    let mut out = HashSet::new();
    if actor.is_site_admin {
        return Ok(out);
    }
    let mut query = sqlx::query(sqlx::AssertSqlSafe(held_above_sql(role.is_some())))
        .bind(server)
        .bind(&actor.username)
        .bind(mine);
    if let Some(id) = role {
        query = query.bind(id);
    }
    for r in &query.fetch_all(db).await? {
        out.insert(r.try_get::<i64, _>(0)?);
    }
    Ok(out)
}

#[derive(Default)]
struct ChannelLimits {
    grants: HashSet<i64>,
    sole: HashSet<i64>,
}

async fn channel_limits(
    db: &Db,
    server: &str,
    actor: &User,
    mine: i64,
    role: Option<i64>,
) -> Result<ChannelLimits, ApiError> {
    let mut out = ChannelLimits::default();
    if actor.is_site_admin || mine & Perm::ManageChannels as i64 != 0 {
        return Ok(out);
    }
    let filter = match role {
        Some(_) => "cp.subject = $2",
        None => "cp.subject LIKE 'r:%'",
    };
    let sql = format!(
        "SELECT cp.channel_id, cp.subject, cp.can_view, cp.can_send, cp.can_read_history, (SELECT COUNT(*) FROM channel_perms o WHERE o.channel_id = cp.channel_id) FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id WHERE c.server = $1 AND {filter}"
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    if let Some(id) = role {
        query = query.bind(format!("r:{id}"));
    }
    let rules = query.fetch_all(db).await?;
    if rules.is_empty() {
        return Ok(out);
    }
    let subjects = perm_subjects(db, Some(server), &actor.username).await?;
    let sql = format!(
        "SELECT cp.channel_id, cp.subject, cp.can_view, cp.can_send, cp.can_read_history FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id WHERE c.server = $1 AND cp.subject IN ({})",
        placeholders(2, subjects.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for subject in &subjects {
        query = query.bind(subject);
    }
    let mut own: HashMap<i64, Vec<PermRow>> = HashMap::new();
    for r in &query.fetch_all(db).await? {
        own.entry(r.try_get(0)?).or_default().push(perm_row(r, 1)?);
    }
    for r in &rules {
        let channel: i64 = r.try_get(0)?;
        let rule = perm_row(r, 1)?;
        let Some(id) = rule
            .subject
            .strip_prefix("r:")
            .and_then(|id| id.parse::<i64>().ok())
        else {
            continue;
        };
        let have = fold_access(own.get(&channel).into_iter().flatten(), &subjects, false);
        if (rule.view && !have.view) || (rule.send && !have.send) || (rule.history && !have.history)
        {
            out.grants.insert(id);
        }
        if r.try_get::<i64, _>(5)? == 1 {
            out.sole.insert(id);
        }
    }
    Ok(out)
}

async fn role_limits(db: &Db, server: &str, viewer: Option<&User>) -> Result<RoleLimits, ApiError> {
    let Some(user) = viewer.filter(|u| !u.is_site_admin) else {
        return Ok(RoleLimits::default());
    };
    let mine = effective_perms(db, server, user).await?;
    if mine & Perm::ManageAdmins as i64 == 0 {
        return Ok(RoleLimits::default());
    }
    let sorted = |set: HashSet<i64>| {
        let mut ids: Vec<i64> = set.into_iter().collect();
        ids.sort_unstable();
        ids
    };
    let ChannelLimits { grants, sole } = channel_limits(db, server, user, mine, None).await?;
    Ok(RoleLimits {
        held_above: sorted(held_above(db, server, user, mine, None).await?),
        channel_grants: sorted(grants),
        sole_rules: sorted(sole),
    })
}

async fn require_role_change(
    db: &Db,
    server: &str,
    actor: &User,
    id: i64,
    role_perms: i64,
) -> Result<i64, ApiError> {
    let mine = effective_perms(db, server, actor).await?;
    if !can_grant(mine, actor.is_site_admin, role_perms) {
        return Err(forbidden(
            "You can't change a role that has permissions you don't have",
        ));
    }
    if !held_above(db, server, actor, mine, Some(id))
        .await?
        .is_empty()
    {
        return Err(forbidden(
            "You can't change a role held by a member you can't moderate",
        ));
    }
    Ok(mine)
}

fn check_color(color: &str) -> Result<(), ApiError> {
    match valid_color(color) {
        true => Ok(()),
        false => Err(bad("Invalid color")),
    }
}

/// Create a role
///
/// Adds a role to the server. A server can have at most 250 roles. The role's permissions must be
/// a subset of yours (equal is fine). Requires the Manage admins server permission. Emits
/// `roles_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/roles",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = RoleReq,
    responses(
        (status = 200, description = "The created role", body = Role),
        (status = 400, description = "Invalid role name (blank, longer than 100 characters or blocked by the profanity filter), an invalid color, or the server already has 250 roles. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission, or the role's permissions include some you don't have (`You can't grant permissions you don't have`)", body = ApiErrorBody),
        (status = 404, description = "Server not found", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<RoleReq>,
) -> Result<Json<Role>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    let role_name = req.name.trim().to_string();
    check_name(
        &state.db,
        ProfanityTarget::RoleNames,
        "Role name",
        &role_name,
    )
    .await?;
    check_color(&req.color)?;
    let perms = req.perms & ALL_PERMS;
    require_grant(&state.db, &key, &user, perms).await?;
    if count_rows(
        &state.db,
        "SELECT COUNT(*) FROM roles WHERE server = $1",
        &key,
    )
    .await?
        >= ROLE_MAX
    {
        return Err(bad(&format!("A server can have at most {ROLE_MAX} roles")));
    }
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

/// Update a role
///
/// Changes a role's name, color and/or permissions; omitted fields are left unchanged. Every field
/// is validated before anything is saved, and the changes are saved together, so a rejected
/// request changes nothing. Any edit, a rename or recolor included, needs the role's current
/// permissions to be a subset of yours, and every other member who holds the role must have
/// server permissions that are a strict subset of yours (the kick and ban rule; see
/// `role_limits.held_above` in the server detail). New permissions must be a subset of yours
/// (equal is fine). Requires the Manage admins server permission. Emits `roles_changed` to the
/// server and removes users from voice channels they can no longer view. General rate-limit
/// bucket.
#[utoipa::path(
    patch,
    path = "/api/servers/{name}/roles/{id}",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("id" = i64, Path, description = "Role id; the role must belong to this server")),
    request_body = RolePatch,
    responses(
        (status = 200, description = "The updated role", body = Role),
        (status = 400, description = "Invalid role name (blank, longer than 100 characters or blocked by the profanity filter) or color; nothing is saved. A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Nothing is saved. Missing the Manage admins permission; the role has permissions you don't have (`You can't change a role that has permissions you don't have`); another holder of the role does not have fewer permissions than you (`You can't change a role held by a member you can't moderate`); or the new permissions include some you don't have (`You can't grant permissions you don't have`)", body = ApiErrorBody),
        (status = 404, description = "Server or role not found", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn update_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
    Json(req): Json<RolePatch>,
) -> Result<Json<Role>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    let current = require_role(&state.db, &key, id).await?;
    require_role_change(&state.db, &key, &user, id, current).await?;
    let RolePatch { name, color, perms } = req;
    let role_name = match &name {
        Some(role_name) => {
            let role_name = role_name.trim().to_string();
            check_name(
                &state.db,
                ProfanityTarget::RoleNames,
                "Role name",
                &role_name,
            )
            .await?;
            Some(role_name)
        }
        None => None,
    };
    if let Some(color) = &color {
        check_color(color)?;
    }
    let perms = perms.map(|p| p & ALL_PERMS);
    if let Some(perms) = perms {
        require_grant(&state.db, &key, &user, perms).await?;
    }
    let mut tx = state.db.begin().await?;
    if let Some(role_name) = &role_name {
        sqlx::query("UPDATE roles SET name = $1 WHERE id = $2")
            .bind(role_name)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(color) = &color {
        sqlx::query("UPDATE roles SET color = $1 WHERE id = $2")
            .bind(color)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(perms) = perms {
        sqlx::query("UPDATE roles SET perms = $1 WHERE id = $2")
            .bind(perms)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
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

/// Delete a role
///
/// Deletes the role, unassigns it from everyone and removes the channel permission rules that
/// name it. The role's permissions must be a subset of yours, and every other member who holds it
/// must have server permissions that are a strict subset of yours (the kick and ban rule). If the
/// role is the only permission rule on a channel, removing that rule would open the channel to
/// everyone, so you also need Manage channels. Requires the Manage admins server permission.
/// Emits `roles_changed` to the server and removes users from voice channels they can no longer
/// view. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/servers/{name}/roles/{id}",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("id" = i64, Path, description = "Role id; the role must belong to this server")),
    responses(
        (status = 200, description = "Role deleted and removed from channel permission rules", body = OkResp),
        (status = 400, description = "Non-integer `id` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission; the role has permissions you don't have (`You can't change a role that has permissions you don't have`); another holder of the role does not have fewer permissions than you (`You can't change a role held by a member you can't moderate`); or the role is the only rule on a channel and you lack Manage channels", body = ApiErrorBody),
        (status = 404, description = "Server or role not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn delete_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<OkResp>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    let current = require_role(&state.db, &key, id).await?;
    let mine = require_role_change(&state.db, &key, &user, id, current).await?;
    if !channel_limits(&state.db, &key, &user, mine, Some(id))
        .await?
        .sole
        .is_empty()
    {
        return Err(forbidden(
            "This role is the only permission rule on a channel, so deleting it would open the channel to everyone. That needs Manage channels",
        ));
    }
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

/// Assign a role
///
/// Gives the role to the member `username`, who can be anyone in the server, including yourself;
/// assigning a role they already hold succeeds without changes. The role's permissions must be a
/// subset of yours (equal is fine). Without Manage channels, the channel permission rules that
/// name the role must not give anything you don't have in that channel (see
/// `role_limits.channel_grants` in the server detail). Requires the Manage admins server
/// permission. Emits `roles_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/roles/{id}/assign",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("id" = i64, Path, description = "Role id; the role must belong to this server")),
    request_body = UsernameReq,
    responses(
        (status = 200, description = "Role assigned to the member", body = OkResp),
        (status = 400, description = "A non-integer `id`, malformed JSON or a missing `Content-Type` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission, the role has permissions you don't have (`You can't grant permissions you don't have`), or its channel rules give access you don't have (`This role gives channel access you don't have`)", body = ApiErrorBody),
        (status = 404, description = "Server or role not found, or the user is not a member", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn assign_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    let role_perms = require_role(&state.db, &key, id).await?;
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
    require_grant(&state.db, &key, &user, role_perms).await?;
    let mine = effective_perms(&state.db, &key, &user).await?;
    if !channel_limits(&state.db, &key, &user, mine, Some(id))
        .await?
        .grants
        .is_empty()
    {
        return Err(forbidden("This role gives channel access you don't have"));
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

/// Unassign a role
///
/// Takes the role away from `username`. Any role can be taken away from yourself. When `username`
/// is someone else, their server permissions must be a strict subset of yours (the kick and ban
/// rule); the role's own permissions don't matter. Requires the Manage admins server permission.
/// Emits `roles_changed` to the server and removes users from voice channels they can no longer
/// view. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/servers/{name}/roles/{id}/assign/{username}",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("id" = i64, Path, description = "Role id; the role must belong to this server"), ("username" = String, Path, description = "Target username, case-insensitive")),
    responses(
        (status = 200, description = "Role removed from the member", body = OkResp),
        (status = 400, description = "Non-integer `id` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission, or the member does not have fewer permissions than you (`You can't moderate this member`)", body = ApiErrorBody),
        (status = 404, description = "Server or role not found, or the user does not hold the role", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn unassign_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id, target)): Path<(String, i64, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let key = role_guard(&state, &name, &user).await?;
    require_role(&state.db, &key, id).await?;
    let target = target.to_lowercase();
    if target != user.username {
        require_moderate(&state.db, &key, &user, &target).await?;
    }
    let removed =
        sqlx::query("DELETE FROM user_roles WHERE server = $1 AND username = $2 AND role_id = $3")
            .bind(&key)
            .bind(&target)
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
            require_role(db, server, id).await.map(|_| ())
        }
        Some((_, _)) | None => Err(bad("Invalid subject")),
    }
}

/// Paging query parameters for channel permission rules.
#[derive(Deserialize, IntoParams)]
pub struct ChannelPermsQuery {
    /// Page size, default 100, clamped to 1-100.
    limit: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header. Blank means the first
    /// page.
    cursor: Option<String>,
}

/// List channel permission rules
///
/// Returns the permission rules on a channel, ordered by subject, as pages of `limit` (default and
/// max 100). Page with `cursor` from the `X-Next-Cursor` response header. Requires the Manage
/// channels permission in the channel's server. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/channels/{id}/perms",
    tag = "Channels",
    params(("id" = i64, Path, description = "Channel id"), ChannelPermsQuery),
    responses(
        (status = 200, description = "A page of permission rules on the channel, ordered by subject", body = Vec<ChannelPerm>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor (JSON), or a non-integer `id` or `limit` (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "Channel not found", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_channel_perms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Query(q): Query<ChannelPermsQuery>,
) -> Result<Paged<ChannelPerm>, ApiError> {
    channel_perm_guard(&state, id, &user).await?;
    let ChannelPermsQuery { limit, cursor } = q;
    let limit = limit.unwrap_or(LIST_MAX).clamp(1, LIST_MAX);
    let after = match cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(raw) => decode_cursor(raw, 1)?.remove(0),
        None => String::new(),
    };
    let rows = sqlx::query(
        "SELECT subject, can_view, can_send, can_read_history FROM channel_perms WHERE channel_id = $1 AND subject > $2 ORDER BY subject LIMIT $3",
    )
    .bind(id)
    .bind(&after)
    .bind(limit + 1)
    .fetch_all(&state.read())
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
    let more = perms.len() as i64 > limit;
    perms.truncate(limit as usize);
    let next = match (more, perms.last()) {
        (true, Some(p)) => Some(encode_cursor(&[&p.subject])),
        _ => None,
    };
    Ok(Paged(perms, next))
}

/// Set a channel permission rule
///
/// Creates or replaces the rule for `subject` on the channel. The subject is `u:<username>` (any
/// existing user) or `r:<role id>` (a role of the channel's server), case-insensitive. A channel
/// can have at most 500 rules. Requires the Manage channels permission in the channel's server.
/// Emits `channel_perms_changed` to the server and removes users from the channel's voice room if
/// they can no longer view it. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/channels/{id}/perms",
    tag = "Channels",
    params(("id" = i64, Path, description = "Channel id")),
    request_body = ChannelPerm,
    responses(
        (status = 200, description = "Permission rule created or replaced for the subject", body = OkResp),
        (status = 400, description = "Invalid subject, or the channel already has 500 rules. A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "Channel not found, or the subject's user or role does not exist", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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
    let exists = sqlx::query("SELECT 1 FROM channel_perms WHERE channel_id = $1 AND subject = $2")
        .bind(id)
        .bind(&subject)
        .fetch_optional(&state.db)
        .await?
        .is_some();
    let rules: i64 = sqlx::query("SELECT COUNT(*) FROM channel_perms WHERE channel_id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?
        .try_get(0)?;
    if !exists && rules >= CHANNEL_PERM_MAX {
        return Err(bad(&format!(
            "A channel can have at most {CHANNEL_PERM_MAX} permission rules"
        )));
    }
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

/// Remove a channel permission rule
///
/// Deletes the rule for `subject` on the channel. Requires the Manage channels permission in the
/// channel's server. Emits `channel_perms_changed` to the server and removes users from the
/// channel's voice room if they can no longer view it. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/channels/{id}/perms/{subject}",
    tag = "Channels",
    params(
        ("id" = i64, Path, description = "Channel id"),
        ("subject" = String, Path, description = "Rule subject, `u:<username>` or `r:<role id>`, case-insensitive")
    ),
    responses(
        (status = 200, description = "Permission rule removed for the subject", body = OkResp),
        (status = 400, description = "Non-integer `id` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "Channel not found, or no rule for that subject", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
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
                members: PasswordMembers::Keep,
                keep_guests: false,
                banner_color: None,
                name_color: None,
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
    async fn purging_names_are_not_available_yet() {
        let (state, path) = temp_state("purging_names").await;
        let _ = make_server(&state, "gone").await.expect("gone");
        let _ = make_server(&state, "live").await.expect("live");
        sqlx::query("UPDATE servers SET password_hash = '!purging' WHERE name = 'gone'")
            .execute(&state.db)
            .await
            .expect("hide");
        let conflict = |res: Result<(), ApiError>| match res {
            Err(ApiError(StatusCode::CONFLICT, msg)) => msg == "That name is not available yet",
            _ => false,
        };
        assert!(conflict(make_server(&state, "Gone").await.map(|_| ())));
        assert!(conflict(rename(&state, "live", "GONE").await));
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_rename_racing_a_delete_leaves_the_hidden_server_alone() {
        let (state, path) = temp_state("rename_race").await;
        let _ = make_server(&state, "gone").await.expect("gone");
        let _ = make_server(&state, "live").await.expect("live");
        sqlx::query("UPDATE servers SET password_hash = '!purging' WHERE name = 'gone'")
            .execute(&state.db)
            .await
            .expect("hide");
        assert!(matches!(
            rename(&state, "gone", "fresh").await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
        let mut tx = state.db.begin().await.expect("tx");
        let raced = rename_live(&mut tx, "gone", "fresh", "Fresh", Some(&None)).await;
        assert!(matches!(raced, Err(ApiError(StatusCode::NOT_FOUND, _))));
        drop(tx);
        let row =
            sqlx::query("SELECT name, password_hash FROM servers WHERE name IN ('gone', 'fresh')")
                .fetch_all(&state.db)
                .await
                .expect("rows");
        assert_eq!(row.len(), 1);
        assert_eq!(row[0].try_get::<String, _>(0).expect("name"), "gone");
        assert_eq!(
            row[0]
                .try_get::<Option<String>, _>(1)
                .expect("hash")
                .as_deref(),
            Some("!purging")
        );
        let mut tx = state.db.begin().await.expect("tx");
        rename_live(&mut tx, "live", "lively", "Lively", None)
            .await
            .expect("live rename");
        tx.commit().await.expect("commit");
        assert!(
            server_lite(&state.db, "lively")
                .await
                .expect("lite")
                .is_some()
        );
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
        let first = my_servers_page(db, "alice", 0, None, 4)
            .await
            .expect("page");
        assert_eq!(first.items.len(), 4);
        assert!(first.more);
        assert!(first.items[1].is_admin && !first.items[0].is_admin);
        let rest = my_servers_page(db, "alice", 0, first.next.as_deref(), 4)
            .await
            .expect("page");
        let all = my_servers_page(db, "alice", 0, None, 7)
            .await
            .expect("page");
        assert!(!all.more && all.next.is_none());
        let names = |p: &[ServerSummary]| p.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        assert_eq!(
            [names(&first.items), names(&rest.items)].concat(),
            names(&all.items)
        );
        assert!(!rest.more);
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
                cursor: None,
            }),
        )
        .await
        .map(|Paged(list, _)| {
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
            match ev {
                WsEvent::MemberKicked {
                    server,
                    username,
                    banned,
                } => out.push((server, username, banned)),
                WsEvent::MembersPurged { server, usernames } => {
                    out.extend(usernames.into_iter().map(|u| (server.clone(), u, false)))
                }
                _ => {}
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
        let _ = state.hub.voice_join("bob", 7, "club", cid).await;
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
        let _ = state.hub.voice_join("erin", 9, "club", cid).await;
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
                members: PasswordMembers::Keep,
                keep_guests: false,
                banner_color: None,
                name_color: None,
            }),
        )
        .await
        .expect("set password");
    }

    async fn insert_grant(db: &Db, server: &str) -> String {
        let grant = new_token();
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, $2, 0, 4000000000)")
            .bind(&grant)
            .bind(server)
            .execute(db)
            .await
            .expect("insert grant");
        grant
    }

    #[tokio::test]
    async fn banned_users_cannot_read_an_open_server() {
        let (state, path) = temp_state("ban_hides").await;
        let db = &state.db;
        let _ = make_server(&state, "Club").await.expect("club");
        add_user(db, "carol", "Carol").await;
        add_user(db, "dave", "Dave").await;
        let mut rx = state.hub.subscribe();
        ban(&state, mem_user("alice", false), "club", "carol")
            .await
            .expect("ban carol");
        let mut notices = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::ServerBanned { server, username } => notices.push((server, username)),
                WsEvent::MemberKicked { .. } => panic!("carol was never a member"),
                _ => {}
            }
        }
        assert_eq!(notices, vec![("club".to_string(), "carol".to_string())]);
        let view = |who: &str| {
            get_server(
                State(state.clone()),
                MaybeAuthed(Some(mem_user(who, false))),
                HeaderMap::new(),
                Path("club".to_string()),
            )
        };
        assert!(matches!(
            view("carol").await,
            Err(ApiError(StatusCode::FORBIDDEN, m)) if m == "You are banned from this server"
        ));
        assert!(view("dave").await.is_ok());
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        let carol = mem_user("carol", false);
        let lite = require_server(db, "club").await.expect("lite");
        assert!(matches!(
            require_server_view(db, &HeaderMap::new(), &lite, Some(&carol)).await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert!(crate::db::channel_viewable(db, "club", cid, Some("dave")).await);
        done(state, path).await;
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

    async fn change_password(
        state: &AppState,
        actor: User,
        server: &str,
        name: Option<&str>,
        password: Option<&str>,
        members: PasswordMembers,
    ) -> Result<ServerUpdated, ApiError> {
        change_keeping(state, actor, server, name, password, members, false).await
    }

    async fn change_keeping(
        state: &AppState,
        actor: User,
        server: &str,
        name: Option<&str>,
        password: Option<&str>,
        members: PasswordMembers,
        keep_guests: bool,
    ) -> Result<ServerUpdated, ApiError> {
        update_server(
            State(state.clone()),
            Authed(actor),
            Path(server.to_string()),
            Json(ServerPatch {
                name: name.map(str::to_string),
                password: password.map(str::to_string),
                members,
                keep_guests,
                banner_color: None,
                name_color: None,
            }),
        )
        .await
        .map(|Json(updated)| updated)
    }

    async fn member_names(db: &Db, server: &str) -> Vec<String> {
        let rows = sqlx::query("SELECT username FROM members WHERE server = $1 ORDER BY username")
            .bind(server)
            .fetch_all(db)
            .await
            .expect("members");
        rows.iter()
            .map(|r| r.try_get(0).expect("username"))
            .collect()
    }

    async fn grant_valid(state: &AppState, server: &str, grant: &str) -> bool {
        invite_as(state, None, server, None, Some(grant))
            .await
            .expect("guest invite")
            .status
            == InviteStatus::Joinable
    }

    async fn join_with(state: &AppState, who: &str, server: &str, password: &str) {
        let _ = join_server(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path(server.to_string()),
            Some(Json(JoinReq {
                password: Some(password.to_string()),
            })),
        )
        .await
        .expect("join with password");
    }

    async fn give_role(db: &Db, server: &str, username: &str, perms: i64) {
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES($1, $2, '#ffffff', $3) RETURNING id")
            .bind(server)
            .bind(format!("r-{username}"))
            .bind(perms)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES($1, $2, $3)")
            .bind(server)
            .bind(username)
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
    }

    async fn patch_colors(
        state: &AppState,
        actor: User,
        server: &str,
        body: &str,
    ) -> Result<ServerUpdated, ApiError> {
        let patch: ServerPatch = serde_json::from_str(body).expect("patch json");
        update_server(
            State(state.clone()),
            Authed(actor),
            Path(server.to_string()),
            Json(patch),
        )
        .await
        .map(|Json(updated)| updated)
    }

    #[tokio::test]
    async fn server_colors_are_validated_gated_and_broadcast() {
        let (state, path) = temp_state("server_colors").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        add_user(db, "bob", "bob").await;
        join(&state, "bob", "club").await.expect("join");
        let alice = || mem_user("alice", false);
        let mut rx = state.hub.subscribe();
        let set = patch_colors(
            &state,
            alice(),
            "club",
            r##"{"banner_color":"#FF0066","name_color":"#ffffff"}"##,
        )
        .await
        .expect("set colors");
        assert_eq!(set.server.banner_color.as_deref(), Some("#ff0066"));
        assert_eq!(set.server.name_color.as_deref(), Some("#ffffff"));
        assert!(!set.server.has_password);
        let mut updated = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::ServerRenamed { old_name, server } => {
                    updated.push((Some(old_name), server.banner_color, server.name_color))
                }
                WsEvent::ServerUpdated { server } => {
                    updated.push((None, server.banner_color, server.name_color))
                }
                _ => {}
            }
        }
        assert_eq!(
            updated,
            [(
                None,
                Some("#ff0066".to_string()),
                Some("#ffffff".to_string())
            )]
        );
        let detail = server_detail(db, &state.hub, "club", None)
            .await
            .expect("detail");
        assert_eq!(detail.banner_color.as_deref(), Some("#ff0066"));
        assert_eq!(detail.name_color.as_deref(), Some("#ffffff"));
        let mine = my_servers_by_names(db, "bob", &["club".to_string()])
            .await
            .expect("mine");
        assert_eq!(mine[0].banner_color.as_deref(), Some("#ff0066"));
        let renamed = patch_colors(&state, alice(), "club", r#"{"name":"Club"}"#)
            .await
            .expect("rename keeps colors");
        assert_eq!(renamed.server.banner_color.as_deref(), Some("#ff0066"));
        assert_eq!(renamed.server.name_color.as_deref(), Some("#ffffff"));
        let cleared = patch_colors(&state, alice(), "club", r#"{"name_color":null}"#)
            .await
            .expect("clear name color");
        assert_eq!(cleared.server.banner_color.as_deref(), Some("#ff0066"));
        assert_eq!(cleared.server.name_color, None);
        let lite = require_server(db, "club").await.expect("lite");
        assert_eq!(
            (lite.banner_color.as_deref(), lite.name_color),
            (Some("#ff0066"), None)
        );
        for bad in [
            r#"{"banner_color":"red"}"#,
            r##"{"banner_color":"#12345"}"##,
            r##"{"name_color":"#12345g"}"##,
            r#"{"name_color":""}"#,
        ] {
            let err = patch_colors(&state, alice(), "club", bad)
                .await
                .err()
                .expect(bad);
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{bad}");
        }
        let err = patch_colors(
            &state,
            mem_user("bob", false),
            "club",
            r##"{"banner_color":"#000000"}"##,
        )
        .await
        .err()
        .expect("bob is not allowed");
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        let lite = require_server(db, "club").await.expect("lite");
        assert_eq!(lite.banner_color.as_deref(), Some("#ff0066"));
        let rchat = patch_colors(
            &state,
            mem_user("root", true),
            "rchat",
            r##"{"banner_color":"#000000"}"##,
        )
        .await
        .expect("site admin colors rchat");
        assert_eq!(rchat.server.banner_color.as_deref(), Some("#000000"));
        let err = patch_colors(
            &state,
            mem_user("root", true),
            "rchat",
            r##"{"name":"other","banner_color":"#111111"}"##,
        )
        .await
        .err()
        .expect("rchat rename stays protected");
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        let err = patch_colors(&state, alice(), "rchat", r##"{"banner_color":"#111111"}"##)
            .await
            .err()
            .expect("members can't color rchat");
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        let lite = require_server(db, "rchat").await.expect("rchat");
        assert_eq!(lite.banner_color.as_deref(), Some("#000000"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn password_change_keeps_or_removes_members() {
        let (state, path) = temp_state("pw_members").await;
        let db = &state.db;
        let cid = make_server(&state, "club").await.expect("club").0.channels[0].id;
        for name in ["bob", "carol", "dave", "erin"] {
            add_user(db, name, name).await;
            join(&state, name, "club").await.expect("join");
        }
        give_role(db, "club", "carol", Perm::Kick as i64).await;
        set_admin_row(db, "dave", 0).await;
        set_admin_row(db, "erin", Perm::Kick as i64 | Perm::DeleteMessages as i64).await;
        set_password(&state, "old").await;
        let grant = insert_grant(db, "club").await;
        let alice = || mem_user("alice", false);
        let mut rx = state.hub.subscribe();
        let kept = change_password(
            &state,
            alice(),
            "club",
            None,
            Some("new"),
            PasswordMembers::Keep,
        )
        .await
        .expect("keep everyone");
        assert!(kept.server.has_password);
        assert_eq!((kept.removed, kept.kept), (0, 4));
        assert_eq!(
            member_names(db, "club").await,
            ["alice", "bob", "carol", "dave", "erin"]
        );
        assert!(!grant_valid(&state, "club", &grant).await);
        let grant = insert_grant(db, "club").await;
        let _ = change_keeping(
            &state,
            alice(),
            "club",
            None,
            Some("new2"),
            PasswordMembers::Keep,
            true,
        )
        .await
        .expect("keep everyone and guests");
        assert!(grant_valid(&state, "club", &grant).await);
        let renamed = change_keeping(
            &state,
            alice(),
            "club",
            Some("Club"),
            None,
            PasswordMembers::Keep,
            false,
        )
        .await
        .expect("rename only");
        assert!(renamed.server.has_password);
        assert!(grant_valid(&state, "club", &grant).await);
        assert!(kicks(&mut rx).is_empty());
        let _ = state.hub.voice_join("bob", 7, "club", cid).await;
        state.hub.set_viewing("carol", 8, None, Some("club"));
        assert!(state.hub.is_online("club", "carol"));
        let removed = change_keeping(
            &state,
            alice(),
            "club",
            None,
            Some("newer"),
            PasswordMembers::Remove,
            true,
        )
        .await
        .expect("remove everyone");
        assert_eq!((removed.removed, removed.kept), (3, 1));
        assert_eq!(member_names(db, "club").await, ["alice", "dave"]);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM user_roles WHERE server = 'club'").await,
            0
        );
        assert!(!grant_valid(&state, "club", &grant).await);
        let mut got = kicks(&mut rx);
        got.sort();
        assert_eq!(
            got,
            ["bob", "carol", "erin"].map(|u| ("club".to_string(), u.to_string(), false))
        );
        assert!(state.hub.rooms_in("club", None).is_empty());
        assert!(!state.hub.is_online("club", "carol"));
        assert_eq!(count(db, "SELECT COUNT(*) FROM server_bans").await, 0);
        assert_eq!(
            status(join(&state, "bob", "club").await),
            Some(StatusCode::UNAUTHORIZED)
        );
        join_with(&state, "bob", "club", "newer").await;
        let cleared = change_password(
            &state,
            alice(),
            "club",
            None,
            Some(""),
            PasswordMembers::Remove,
        )
        .await
        .expect("clear and remove");
        assert!(!cleared.server.has_password);
        assert_eq!((cleared.removed, cleared.kept), (1, 1));
        join(&state, "bob", "club").await.expect("open again");
        let renamed = change_password(
            &state,
            alice(),
            "club",
            Some("Den"),
            None,
            PasswordMembers::Remove,
        )
        .await
        .expect("rename ignores members");
        assert_eq!((renamed.removed, renamed.kept), (0, 2));
        assert_eq!(member_names(db, "den").await, ["alice", "bob", "dave"]);
        let both = change_password(
            &state,
            alice(),
            "den",
            Some("Lair"),
            Some("x"),
            PasswordMembers::Remove,
        )
        .await
        .expect("rename and remove");
        assert_eq!(
            (both.server.name.as_str(), both.removed, both.kept),
            ("lair", 1, 1)
        );
        assert_eq!(member_names(db, "lair").await, ["alice", "dave"]);
        assert_eq!(
            kicks(&mut rx),
            [
                ("club".to_string(), "bob".to_string(), false),
                ("lair".to_string(), "bob".to_string(), false)
            ]
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn password_remove_needs_kick_and_follows_hierarchy() {
        let (state, path) = temp_state("pw_rules").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        let names = ["bob", "carol", "dave", "erin", "frank", "su", "root"];
        for name in names {
            add_user(db, name, name).await;
        }
        for name in &names[..6] {
            join(&state, name, "club").await.expect("join");
        }
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username IN ('su', 'root')")
            .execute(db)
            .await
            .expect("site admins");
        let manage = Perm::DeleteServer as i64;
        let manage_kick = manage | Perm::Kick as i64;
        set_admin_row(db, "bob", manage).await;
        set_admin_row(db, "carol", manage_kick).await;
        set_admin_row(db, "dave", manage_kick).await;
        give_role(db, "club", "erin", Perm::Kick as i64).await;
        set_admin_row(db, "frank", manage_kick | Perm::ManageAdmins as i64).await;
        let grant = insert_grant(db, "club").await;
        let everyone = ["alice", "bob", "carol", "dave", "erin", "frank", "su"];
        assert_eq!(
            status(
                change_password(
                    &state,
                    mem_user("bob", false),
                    "club",
                    None,
                    Some("pw"),
                    PasswordMembers::Remove
                )
                .await
            ),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(member_names(db, "club").await, everyone);
        assert!(!require_server(db, "club").await.expect("club").has_password);
        assert_eq!(
            status(
                change_password(
                    &state,
                    mem_user("erin", false),
                    "club",
                    None,
                    Some("pw"),
                    PasswordMembers::Keep
                )
                .await
            ),
            Some(StatusCode::FORBIDDEN)
        );
        let kept = change_password(
            &state,
            mem_user("bob", false),
            "club",
            None,
            Some("pw"),
            PasswordMembers::Keep,
        )
        .await
        .expect("delete-server admin keeps everyone");
        assert_eq!((kept.removed, kept.kept), (0, 6));
        assert!(!grant_valid(&state, "club", &grant).await);
        let grant = insert_grant(db, "club").await;
        let narrow = change_password(
            &state,
            mem_user("carol", false),
            "club",
            None,
            Some("pw2"),
            PasswordMembers::Remove,
        )
        .await
        .expect("narrow admin removes");
        assert_eq!((narrow.removed, narrow.kept), (3, 3));
        assert_eq!(
            member_names(db, "club").await,
            ["alice", "carol", "dave", "frank"]
        );
        assert!(!grant_valid(&state, "club", &grant).await);
        let full = change_password(
            &state,
            mem_user("alice", false),
            "club",
            None,
            Some("pw3"),
            PasswordMembers::Remove,
        )
        .await
        .expect("full admin removes");
        assert_eq!((full.removed, full.kept), (3, 0));
        assert_eq!(member_names(db, "club").await, ["alice"]);
        join_with(&state, "frank", "club", "pw3").await;
        set_admin_row(db, "frank", 0).await;
        let site = change_password(
            &state,
            mem_user("root", true),
            "club",
            None,
            Some("pw4"),
            PasswordMembers::Remove,
        )
        .await
        .expect("site admin removes everyone");
        assert_eq!((site.removed, site.kept), (2, 0));
        assert!(member_names(db, "club").await.is_empty());
        let grant = insert_grant(db, "club").await;
        assert!(grant_valid(&state, "club", &grant).await);
        let open = change_password(
            &state,
            mem_user("root", true),
            "club",
            None,
            Some(" "),
            PasswordMembers::Keep,
        )
        .await
        .expect("clear keeps members");
        assert!(!open.server.has_password);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM guest_grants WHERE server = 'club'"
            )
            .await,
            0
        );
        assert_eq!(
            status(
                change_password(
                    &state,
                    mem_user("root", true),
                    "rchat",
                    None,
                    Some("pw"),
                    PasswordMembers::Remove
                )
                .await
            ),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            status(
                change_password(
                    &state,
                    mem_user("root", true),
                    "rchat",
                    None,
                    Some("pw"),
                    PasswordMembers::Keep
                )
                .await
            ),
            Some(StatusCode::FORBIDDEN)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn member_cursor_walk_matches_offsets() {
        let (state, path) = temp_state("member_cursor").await;
        let db = &state.db;
        let mut names: Vec<String> = (0..130).map(|n| format!("m{n:03}")).collect();
        for name in &names {
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        let online: Vec<String> = names.iter().step_by(7).cloned().collect();
        for (conn, name) in online.iter().enumerate() {
            state
                .hub
                .set_viewing(name, conn as u64 + 1, None, Some("rchat"));
        }
        state.hub.set_viewing("stranger", 999, None, Some("rchat"));
        names.retain(|n| !online.contains(n));
        let expected: Vec<String> = [online.clone(), names].concat();
        let mut walked = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            let (rows, next) =
                members_page(db, "rchat", &state.hub, None, Some(50), cursor.as_deref())
                    .await
                    .expect("page");
            let offset_rows = members_page(
                db,
                "rchat",
                &state.hub,
                Some(walked.len() as i64),
                Some(50),
                None,
            )
            .await
            .expect("offset page")
            .0;
            assert_eq!(rows, offset_rows, "page {pages}");
            walked.extend(rows.into_iter().map(|(name, _, _)| name));
            pages += 1;
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(pages, 3);
        assert_eq!(walked, expected);
        let (small, next) = members_page(db, "rchat", &state.hub, None, Some(19), None)
            .await
            .expect("online only page");
        assert_eq!(small.len(), 19);
        let (rest, _) = members_page(db, "rchat", &state.hub, None, Some(5), next.as_deref())
            .await
            .expect("across phases");
        let rest: Vec<String> = rest.into_iter().map(|(n, _, _)| n).collect();
        assert_eq!(rest, expected[19..24]);
        assert!(rejected(
            members_page(db, "rchat", &state.hub, None, None, Some("zz"))
                .await
                .map(|_| ())
        ));
        let res = list_members(
            State(state.clone()),
            MaybeAuthed(None),
            HeaderMap::new(),
            Path("rchat".to_string()),
            RawQuery(Some("limit=50".to_string())),
        )
        .await
        .expect("handler");
        let res = axum::response::IntoResponse::into_response(res);
        assert!(res.headers().contains_key(crate::api::NEXT_CURSOR));
        done(state, path).await;
    }

    #[tokio::test]
    async fn member_search_pages_by_prefix_and_admins() {
        let (state, path) = temp_state("member_search").await;
        let db = &state.db;
        for n in 0..70 {
            add_member(
                db,
                "rchat",
                &format!("al{n:02}"),
                i64::from(n % 10 == 0),
                0,
                0,
            )
            .await;
        }
        for name in ["alpha", "bob", "alz", "am", "a\u{10ffff}x"] {
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        let fetch = |raw: String| {
            let state = state.clone();
            async move {
                let res = list_members(
                    State(state),
                    MaybeAuthed(None),
                    HeaderMap::new(),
                    Path("rchat".to_string()),
                    RawQuery(Some(raw)),
                )
                .await
                .expect("handler");
                let res = axum::response::IntoResponse::into_response(res);
                let next = res
                    .headers()
                    .get(crate::api::NEXT_CURSOR)
                    .map(|v| v.to_str().expect("ascii").to_string());
                let body = axum::body::to_bytes(res.into_body(), usize::MAX)
                    .await
                    .expect("body");
                let members: Vec<serde_json::Value> = serde_json::from_slice(&body).expect("json");
                let names: Vec<String> = members
                    .iter()
                    .map(|m| m["username"].as_str().expect("name").to_string())
                    .collect();
                (names, next)
            }
        };
        let mut walked = Vec::new();
        let mut cursor = String::new();
        loop {
            let (names, next) = fetch(format!("q=AL&cursor={cursor}")).await;
            walked.extend(names);
            match next {
                Some(next) => cursor = next,
                None => break,
            }
        }
        let mut expected: Vec<String> = (0..70).map(|n| format!("al{n:02}")).collect();
        expected.extend(["alpha".to_string(), "alz".to_string()]);
        assert_eq!(walked, expected);
        assert_eq!(
            fetch("q=b".to_string()).await,
            (vec!["bob".to_string()], None)
        );
        assert_eq!(fetch("q=zzz".to_string()).await, (Vec::new(), None));
        let (admins, next) = fetch("admins=1".to_string()).await;
        assert_eq!(
            admins,
            (0..7).map(|n| format!("al{}0", n)).collect::<Vec<_>>()
        );
        assert!(next.is_none());
        let (some, next) = fetch("admins=1&q=al3&limit=1".to_string()).await;
        assert_eq!(some, vec!["al30".to_string()]);
        assert!(next.is_none());
        assert_eq!(prefix_end("ab"), Some("ac".to_string()));
        assert_eq!(prefix_end("a\u{10ffff}"), Some("b".to_string()));
        assert_eq!(prefix_end("\u{10ffff}"), None);
        assert_eq!(prefix_end("\u{d7ff}"), Some("\u{e000}".to_string()));
        done(state, path).await;
    }

    #[tokio::test]
    async fn ban_and_interacted_cursors_walk_everything() {
        let (state, path) = temp_state("pair_cursor").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        for i in 0..23 {
            sqlx::query("INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('club', $1, 'alice', $2)")
                .bind(format!("b{i:02}"))
                .bind(1000 + i / 3)
                .execute(db)
                .await
                .expect("ban");
            sqlx::query(
                "INSERT INTO interactions(server, username, last_at) VALUES('club', $1, $2)",
            )
            .bind(format!("i{i:02}"))
            .bind(500 + i / 4)
            .execute(db)
            .await
            .expect("interaction");
        }
        add_member(db, "club", "i05", 0, 0, 0).await;
        let walk = |interacted: bool| {
            let state = state.clone();
            async move {
                let mut seen = Vec::new();
                let mut cursor: Option<String> = None;
                loop {
                    let q = MembersQuery {
                        offset: None,
                        limit: Some(5),
                        cursor: cursor.clone(),
                    };
                    let Paged(names, next) = match interacted {
                        true => {
                            let Paged(list, next) = list_interacted(
                                State(state.clone()),
                                MaybeAuthed(None),
                                HeaderMap::new(),
                                Path("club".to_string()),
                                Query(q),
                            )
                            .await
                            .expect("interacted");
                            Paged(list.into_iter().map(|u| u.username).collect(), next)
                        }
                        false => {
                            let Paged(list, next) = list_bans(
                                State(state.clone()),
                                Authed(mem_user("alice", false)),
                                Path("club".to_string()),
                                Query(q),
                            )
                            .await
                            .expect("bans");
                            Paged(
                                list.into_iter()
                                    .map(|b| b.user.username)
                                    .collect::<Vec<_>>(),
                                next,
                            )
                        }
                    };
                    seen.extend(names);
                    match next {
                        Some(next) => cursor = Some(next),
                        None => return seen,
                    }
                }
            }
        };
        let bans_seen = walk(false).await;
        let mut want: Vec<String> = (0..23).map(|i| format!("b{i:02}")).collect();
        want.sort_by(|a, b| b.cmp(a));
        assert_eq!(bans_seen, want);
        let seen = walk(true).await;
        let mut want: Vec<String> = (0..23)
            .filter(|i| *i != 5)
            .map(|i| format!("i{i:02}"))
            .collect();
        want.sort_by(|a, b| b.cmp(a));
        assert_eq!(seen, want);
        done(state, path).await;
    }

    #[tokio::test]
    async fn server_caps_and_counts() {
        let (state, path) = temp_state("server_caps").await;
        let db = &state.db;
        let _ = make_server(&state, "cap").await.expect("server");
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $1) INSERT INTO channels(server, name, created_at) SELECT 'cap', 'c' || i, 0 FROM n")
            .bind(CHANNEL_MAX - 1)
            .execute(db)
            .await
            .expect("fill channels");
        let made = create_channel(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("cap".to_string()),
            Json(CreateChannelReq {
                name: "extra".to_string(),
                kind: None,
            }),
        )
        .await;
        assert!(rejected(made));
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $1) INSERT INTO roles(server, name, color, perms) SELECT 'cap', 'r' || i, '#ffffff', 0 FROM n")
            .bind(ROLE_MAX)
            .execute(db)
            .await
            .expect("fill roles");
        let role = create_role(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("cap".to_string()),
            Json(RoleReq {
                name: "extra".to_string(),
                color: "#ffffff".to_string(),
                perms: 0,
            }),
        )
        .await;
        assert!(rejected(role));
        let detail = |state: AppState| async move {
            get_server(
                State(state),
                MaybeAuthed(None),
                HeaderMap::new(),
                Path("cap".to_string()),
            )
            .await
            .expect("detail")
            .0
            .member_count
        };
        assert_eq!(detail(state.clone()).await, 1);
        add_user(db, "bob", "Bob").await;
        join(&state, "bob", "cap").await.expect("join");
        assert_eq!(detail(state.clone()).await, 2);
        let _ = leave_server(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path("cap".to_string()),
        )
        .await
        .expect("leave");
        assert_eq!(detail(state.clone()).await, 1);
        let cid: i64 =
            sqlx::query("SELECT id FROM channels WHERE server = 'cap' AND name = 'general'")
                .fetch_one(db)
                .await
                .expect("general")
                .try_get(0)
                .expect("id");
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 230) INSERT INTO channel_perms(channel_id, subject) SELECT $1, 'u:p' || substr('000' || i, -3, 3) FROM n")
            .bind(cid)
            .execute(db)
            .await
            .expect("fill perms");
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let Paged(perms, next) = list_channel_perms(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path(cid),
                Query(ChannelPermsQuery {
                    limit: None,
                    cursor,
                }),
            )
            .await
            .expect("perms");
            assert!(perms.len() <= LIST_MAX as usize);
            seen.extend(perms.into_iter().map(|p| p.subject));
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        let want: Vec<String> = (1..=230).map(|i| format!("u:p{i:03}")).collect();
        assert_eq!(seen, want);
        done(state, path).await;
    }

    fn code<T>(res: Result<T, ApiError>) -> Result<(), (StatusCode, String)> {
        res.map(|_| ()).map_err(|ApiError(code, msg)| (code, msg))
    }

    async fn member_row(db: &Db, username: &str) -> (i64, i64) {
        let r = sqlx::query(
            "SELECT is_admin, perms FROM members WHERE server = 'club' AND username = $1",
        )
        .bind(username)
        .fetch_one(db)
        .await
        .expect("member row");
        (
            r.try_get(0).expect("is_admin"),
            r.try_get(1).expect("perms"),
        )
    }

    async fn role_row(db: &Db, id: i64) -> (String, String, i64) {
        let r = sqlx::query("SELECT name, color, perms FROM roles WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("role row");
        (
            r.try_get(0).expect("name"),
            r.try_get(1).expect("color"),
            r.try_get(2).expect("perms"),
        )
    }

    async fn holds(db: &Db, username: &str, role: i64) -> bool {
        sqlx::query(
            "SELECT 1 FROM user_roles WHERE server = 'club' AND username = $1 AND role_id = $2",
        )
        .bind(username)
        .bind(role)
        .fetch_optional(db)
        .await
        .expect("holds")
        .is_some()
    }

    async fn new_role(db: &Db, name: &str, perms: i64) -> i64 {
        sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('club', $1, '#ffffff', $2) RETURNING id")
            .bind(name)
            .bind(perms)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id")
    }

    async fn club_with(state: &AppState, names: &[&str]) {
        let db = &state.db;
        let _ = make_server(state, "club").await.expect("club");
        for name in names {
            add_user(db, name, name).await;
            join(state, name, "club").await.expect("join");
        }
        add_user(db, "root", "root").await;
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username = 'root'")
            .execute(db)
            .await
            .expect("site admin");
    }

    const MA: i64 = Perm::ManageAdmins as i64;
    const KICK: i64 = Perm::Kick as i64;

    async fn grant(
        state: &AppState,
        actor: User,
        target: &str,
    ) -> Result<(), (StatusCode, String)> {
        code(
            grant_admin(
                State(state.clone()),
                Authed(actor),
                Path("club".to_string()),
                Json(UsernameReq {
                    username: target.to_string(),
                }),
            )
            .await,
        )
    }

    async fn set_perms(
        state: &AppState,
        actor: User,
        target: &str,
        perms: i64,
    ) -> Result<(), (StatusCode, String)> {
        code(
            set_admin_perms(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), target.to_string())),
                Json(PermsReq { perms }),
            )
            .await,
        )
    }

    fn no_grant() -> Result<(), (StatusCode, String)> {
        Err((
            StatusCode::FORBIDDEN,
            "You can't grant permissions you don't have".to_string(),
        ))
    }

    #[tokio::test]
    async fn admin_grants_stay_within_the_actors_perms() {
        let (state, path) = temp_state("admin_escalation").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dave", "frank", "gina"]).await;
        set_admin_row(db, "bob", MA | KICK).await;
        set_admin_row(db, "dave", KICK).await;
        set_admin_row(db, "frank", 0).await;
        set_admin_row(db, "gina", 0).await;
        let bob = || mem_user("bob", false);
        assert_eq!(grant(&state, bob(), "carol").await, no_grant());
        assert_eq!(grant(&state, bob(), "bob").await, no_grant());
        assert_eq!(grant(&state, bob(), "dave").await, no_grant());
        assert_eq!(member_row(db, "carol").await, (0, 0));
        assert_eq!(member_row(db, "dave").await, (1, KICK));
        for perms in [0, ALL_PERMS, KICK | Perm::DeleteMessages as i64, MA | 8] {
            assert_eq!(
                set_perms(&state, bob(), "dave", perms)
                    .await
                    .map_err(|e| e.0),
                Err(StatusCode::FORBIDDEN),
                "{perms}"
            );
        }
        assert_eq!(set_perms(&state, bob(), "bob", 0).await, no_grant());
        assert_eq!(member_row(db, "dave").await, (1, KICK));
        assert_eq!(member_row(db, "bob").await, (1, MA | KICK));
        set_perms(&state, bob(), "dave", MA | KICK)
            .await
            .expect("equal is fine");
        set_perms(&state, bob(), "bob", MA)
            .await
            .expect("narrow yourself");
        assert_eq!(member_row(db, "bob").await, (1, MA));
        set_admin_row(db, "bob", MA | KICK).await;
        let delete = Perm::DeleteServer as i64;
        set_perms(&state, bob(), "gina", ALL_PERMS & !KICK)
            .await
            .expect("lowering a stronger admin is revoke-like");
        set_perms(&state, bob(), "gina", delete)
            .await
            .expect("lowering again");
        assert_eq!(member_row(db, "gina").await, (1, delete));
        for perms in [0, delete | KICK, delete | 1] {
            assert_eq!(set_perms(&state, bob(), "gina", perms).await, no_grant());
        }
        assert_eq!(member_row(db, "gina").await, (1, delete));
        set_perms(&state, bob(), "gina", KICK)
            .await
            .expect("a new mask within yours");
        assert_eq!(member_row(db, "gina").await, (1, KICK));
        code(
            revoke_admin(
                State(state.clone()),
                Authed(bob()),
                Path(("club".to_string(), "alice".to_string())),
            )
            .await,
        )
        .expect("revoking the creator stays allowed");
        assert_eq!(member_row(db, "alice").await, (0, 0));
        grant(&state, mem_user("frank", false), "carol")
            .await
            .expect("full admin grants");
        assert_eq!(member_row(db, "carol").await, (1, 0));
        grant(&state, mem_user("root", true), "alice")
            .await
            .expect("site admin grants");
        set_perms(&state, mem_user("root", true), "carol", 0)
            .await
            .expect("site admin sets");
        done(state, path).await;
    }

    async fn assign(
        state: &AppState,
        actor: User,
        role: i64,
        target: &str,
    ) -> Result<(), (StatusCode, String)> {
        code(
            assign_role(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), role)),
                Json(UsernameReq {
                    username: target.to_string(),
                }),
            )
            .await,
        )
    }

    async fn unassign(
        state: &AppState,
        actor: User,
        role: i64,
        target: &str,
    ) -> Result<(), (StatusCode, String)> {
        code(
            unassign_role(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), role, target.to_string())),
            )
            .await,
        )
    }

    #[tokio::test]
    async fn roles_stay_within_the_actors_perms() {
        let (state, path) = temp_state("role_escalation").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "erin"]).await;
        set_admin_row(db, "bob", MA | KICK).await;
        set_admin_row(db, "erin", MA | KICK).await;
        let bob = || mem_user("bob", false);
        let create = |perms: i64| {
            let state = state.clone();
            async move {
                create_role(
                    State(state),
                    Authed(mem_user("bob", false)),
                    Path("club".to_string()),
                    Json(RoleReq {
                        name: "made".to_string(),
                        color: "#123456".to_string(),
                        perms,
                    }),
                )
                .await
                .map(|Json(role)| role.id)
            }
        };
        assert_eq!(code(create(Perm::DeleteServer as i64).await), no_grant());
        assert_eq!(code(create(ALL_PERMS).await), no_grant());
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM roles WHERE server = 'club'").await,
            0
        );
        let made = create(MA | KICK).await.expect("equal perms create");
        let patch = |name: Option<&str>, perms: Option<i64>| {
            let state = state.clone();
            let name = name.map(str::to_string);
            async move {
                update_role(
                    State(state),
                    Authed(mem_user("bob", false)),
                    Path(("club".to_string(), made)),
                    Json(RolePatch {
                        name,
                        color: None,
                        perms,
                    }),
                )
                .await
            }
        };
        assert_eq!(
            code(patch(Some("renamed"), Some(ALL_PERMS)).await),
            no_grant()
        );
        assert_eq!(
            role_row(db, made).await,
            ("made".to_string(), "#123456".to_string(), MA | KICK)
        );
        let _ = patch(Some("renamed"), Some(KICK))
            .await
            .expect("narrower edit");
        assert_eq!(role_row(db, made).await.2, KICK);
        let high = new_role(db, "high", ALL_PERMS).await;
        let foreign = new_role(db, "foreign", Perm::DeleteServer as i64).await;
        let equal = new_role(db, "equal", MA | KICK).await;
        let low = new_role(db, "low", KICK).await;
        let plain = new_role(db, "plain", 0).await;
        for role in [high, foreign] {
            for target in ["carol", "bob", "erin"] {
                assert_eq!(assign(&state, bob(), role, target).await, no_grant());
                assert!(!holds(db, target, role).await);
            }
        }
        assign(&state, bob(), equal, "carol")
            .await
            .expect("equal role");
        assign(&state, bob(), low, "carol")
            .await
            .expect("lower role");
        assign(&state, bob(), plain, "bob")
            .await
            .expect("plain role on yourself");
        assign(&state, bob(), low, "erin")
            .await
            .expect("granting to a peer");
        assign(&state, bob(), low, "alice")
            .await
            .expect("granting to a stronger admin");
        let alice = || mem_user("alice", false);
        assign(&state, alice(), high, "carol")
            .await
            .expect("a full admin assigns an all-perms role");
        assign(&state, alice(), high, "alice")
            .await
            .expect("a full admin assigns it to themselves");
        let peer = Err((
            StatusCode::FORBIDDEN,
            "You can't moderate this member".to_string(),
        ));
        for (role, target) in [(low, "erin"), (high, "carol"), (low, "alice")] {
            assert_eq!(unassign(&state, bob(), role, target).await, peer);
            assert!(holds(db, target, role).await);
        }
        unassign(&state, bob(), plain, "bob")
            .await
            .expect("dropping your own role");
        let root = || mem_user("root", true);
        unassign(&state, root(), high, "carol")
            .await
            .expect("site admin bypasses");
        assign(&state, root(), foreign, "erin")
            .await
            .expect("site admin bypasses");
        unassign(&state, alice(), equal, "carol")
            .await
            .expect("alice unassigns");
        unassign(&state, bob(), low, "carol")
            .await
            .expect("a member you can moderate");
        assert!(!holds(db, "carol", low).await && !holds(db, "carol", equal).await);
        done(state, path).await;
    }

    async fn hold(db: &Db, username: &str, role: i64) {
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', $1, $2)")
            .bind(username)
            .bind(role)
            .execute(db)
            .await
            .expect("hold");
    }

    async fn edit(
        state: &AppState,
        actor: User,
        role: i64,
        name: Option<&str>,
        perms: Option<i64>,
    ) -> Result<(), (StatusCode, String)> {
        code(
            update_role(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), role)),
                Json(RolePatch {
                    name: name.map(str::to_string),
                    color: None,
                    perms,
                }),
            )
            .await,
        )
    }

    async fn drop_role(
        state: &AppState,
        actor: User,
        role: i64,
    ) -> Result<(), (StatusCode, String)> {
        code(
            delete_role(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), role)),
            )
            .await,
        )
    }

    async fn limits_of(state: &AppState, who: User) -> (Vec<i64>, Vec<i64>, Vec<i64>) {
        let RoleLimits {
            held_above,
            channel_grants,
            sole_rules,
        } = server_detail(&state.db, &state.hub, "club", Some(&who))
            .await
            .expect("detail")
            .role_limits;
        (held_above, channel_grants, sole_rules)
    }

    fn forbid(msg: &str) -> Result<(), (StatusCode, String)> {
        Err((StatusCode::FORBIDDEN, msg.to_string()))
    }

    #[tokio::test]
    async fn role_edits_and_deletes_need_every_holder_below_you() {
        let (state, path) = temp_state("role_holders").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dave", "erin", "fay", "gina"]).await;
        set_admin_row(db, "bob", MA | KICK).await;
        set_admin_row(db, "erin", MA | KICK).await;
        set_admin_row(db, "gina", 0).await;
        let (bob, alice, root) = (
            || mem_user("bob", false),
            || mem_user("alice", false),
            || mem_user("root", true),
        );
        let held = forbid("You can't change a role held by a member you can't moderate");
        let foreign_msg = forbid("You can't change a role that has permissions you don't have");
        let peer = new_role(db, "peer", KICK).await;
        hold(db, "carol", peer).await;
        hold(db, "erin", peer).await;
        let ma = new_role(db, "ma", MA).await;
        let kick = new_role(db, "kick", KICK).await;
        hold(db, "dave", ma).await;
        hold(db, "dave", kick).await;
        let full = new_role(db, "full", KICK).await;
        hold(db, "gina", full).await;
        let lower = new_role(db, "lower", KICK).await;
        hold(db, "fay", lower).await;
        hold(db, "bob", lower).await;
        let foreign = new_role(db, "foreign", Perm::DeleteServer as i64).await;
        assert_eq!(limits_of(&state, bob()).await.0, {
            let mut ids = vec![peer, ma, kick, full];
            ids.sort_unstable();
            ids
        });
        for role in [peer, ma, kick, full] {
            assert_eq!(edit(&state, bob(), role, None, Some(0)).await, held);
            assert_eq!(edit(&state, bob(), role, Some("x"), None).await, held);
            assert_eq!(drop_role(&state, bob(), role).await, held);
            assert_ne!(role_row(db, role).await.0, "x");
        }
        assert_eq!(role_row(db, peer).await.2, KICK);
        assert_eq!(
            edit(&state, bob(), foreign, Some("x"), None).await,
            foreign_msg
        );
        assert_eq!(drop_role(&state, bob(), foreign).await, foreign_msg);
        assert_eq!(role_row(db, foreign).await.0, "foreign");
        assert_eq!(
            edit(&state, bob(), lower, None, Some(MA | KICK | 1)).await,
            no_grant()
        );
        assert_eq!(role_row(db, lower).await.2, KICK);
        edit(&state, bob(), lower, Some("raised"), Some(MA))
            .await
            .expect("raise within your own perms");
        edit(&state, bob(), lower, Some("lowered"), Some(0))
            .await
            .expect("lower a role held by yourself and someone below you");
        assert_eq!(
            role_row(db, lower).await,
            ("lowered".to_string(), "#ffffff".to_string(), 0)
        );
        edit(&state, bob(), lower, None, Some(MA | KICK))
            .await
            .expect("raise to equal");
        assert_eq!(edit(&state, bob(), lower, None, Some(0)).await, held);
        assert_eq!(drop_role(&state, bob(), lower).await, held);
        edit(&state, alice(), lower, None, Some(KICK))
            .await
            .expect("alice lowers it");
        drop_role(&state, bob(), lower).await.expect("delete");
        assert_eq!(limits_of(&state, alice()).await.0, vec![full]);
        edit(&state, alice(), peer, Some("helpers"), Some(0))
            .await
            .expect("a full admin edits a role held by lesser members");
        edit(&state, alice(), ma, None, Some(ALL_PERMS))
            .await
            .expect("a full admin raises one");
        assert_eq!(drop_role(&state, alice(), full).await, held);
        assert_eq!(drop_role(&state, alice(), kick).await, held);
        drop_role(&state, alice(), peer)
            .await
            .expect("full admin deletes");
        assert_eq!(limits_of(&state, root()).await, (vec![], vec![], vec![]));
        edit(&state, root(), full, Some("root"), Some(ALL_PERMS))
            .await
            .expect("site admin bypasses");
        drop_role(&state, root(), full)
            .await
            .expect("site admin bypasses");
        drop_role(&state, root(), foreign)
            .await
            .expect("site admin bypasses");
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM roles WHERE server = 'club'").await,
            2
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn role_channel_rules_limit_assign_and_delete() {
        let (state, path) = temp_state("role_channels").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        set_admin_row(db, "bob", MA | KICK).await;
        let (bob, alice) = (|| mem_user("bob", false), || mem_user("alice", false));
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        let rule = |subject: String, view: i64, send: i64| async move {
            sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, $3, $4, 0)")
                .bind(cid)
                .bind(subject)
                .bind(view)
                .bind(send)
                .execute(db)
                .await
                .expect("rule");
        };
        let vip = new_role(db, "vip", 0).await;
        rule(format!("r:{vip}"), 1, 1).await;
        assert_eq!(
            limits_of(&state, bob()).await,
            (vec![], vec![vip], vec![vip])
        );
        assert_eq!(
            assign(&state, bob(), vip, "carol").await,
            forbid("This role gives channel access you don't have")
        );
        assert_eq!(
            assign(&state, bob(), vip, "bob").await,
            forbid("This role gives channel access you don't have")
        );
        assert!(!holds(db, "bob", vip).await);
        assert_eq!(
            drop_role(&state, bob(), vip).await.map_err(|e| e.0),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(limits_of(&state, alice()).await, (vec![], vec![], vec![]));
        assign(&state, alice(), vip, "carol")
            .await
            .expect("Manage channels assigns");
        rule("u:bob".to_string(), 1, 0).await;
        assert_eq!(limits_of(&state, bob()).await, (vec![], vec![vip], vec![]));
        assert_eq!(
            assign(&state, bob(), vip, "bob").await.map_err(|e| e.0),
            Err(StatusCode::FORBIDDEN)
        );
        sqlx::query("UPDATE channel_perms SET can_send = 1 WHERE subject = 'u:bob'")
            .execute(db)
            .await
            .expect("send");
        assert_eq!(limits_of(&state, bob()).await, (vec![], vec![], vec![]));
        assign(&state, bob(), vip, "bob")
            .await
            .expect("access you already have");
        drop_role(&state, bob(), vip)
            .await
            .expect("not the only rule any more");
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM channel_perms WHERE subject LIKE 'r:%'"
            )
            .await,
            0
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn revoking_admin_cannot_raise_anyone_above_you() {
        let (state, path) = temp_state("revoke_raise").await;
        let db = &state.db;
        club_with(&state, &["bob", "dave", "erin", "frank", "gina"]).await;
        for (who, perms) in [
            ("bob", MA | KICK),
            ("dave", KICK),
            ("erin", KICK),
            ("frank", KICK),
            ("gina", KICK),
        ] {
            set_admin_row(db, who, perms).await;
        }
        let owner = new_role(db, "owner", ALL_PERMS).await;
        let mods = new_role(db, "mods", MA | KICK).await;
        hold(db, "dave", owner).await;
        hold(db, "erin", mods).await;
        hold(db, "gina", owner).await;
        let revoke = |actor: User, target: &str| {
            let state = state.clone();
            let target = target.to_string();
            async move {
                code(
                    revoke_admin(
                        State(state),
                        Authed(actor),
                        Path(("club".to_string(), target)),
                    )
                    .await,
                )
            }
        };
        let raises = forbid(REVOKE_RAISES);
        let bob = || mem_user("bob", false);
        assert_eq!(revoke(bob(), "dave").await, raises);
        assert_eq!(member_row(db, "dave").await, (1, KICK));
        revoke(bob(), "erin").await.expect("roles within yours");
        revoke(bob(), "alice")
            .await
            .expect("revoking still works on anyone");
        revoke(mem_user("root", true), "gina")
            .await
            .expect("site admin bypasses");
        sqlx::query("UPDATE members SET is_admin = 1, perms = 0 WHERE server = 'club' AND username = 'alice'")
            .execute(db)
            .await
            .expect("restore alice");
        revoke(mem_user("alice", false), "dave")
            .await
            .expect("a full admin can");
        hold(db, "bob", owner).await;
        assert_eq!(revoke(bob(), "bob").await, raises);
        let transfer = code(
            transfer_admin(
                State(state.clone()),
                Authed(bob()),
                Path("club".to_string()),
                Json(UsernameReq {
                    username: "frank".to_string(),
                }),
            )
            .await,
        );
        assert_eq!(transfer.map_err(|e| e.0), Err(StatusCode::FORBIDDEN));
        assert_eq!(member_row(db, "bob").await, (1, MA | KICK));
        assert_eq!(member_row(db, "frank").await, (1, KICK));
        done(state, path).await;
    }

    #[tokio::test]
    async fn role_updates_validate_everything_first() {
        let (state, path) = temp_state("role_atomic").await;
        let db = &state.db;
        club_with(&state, &[]).await;
        let id = new_role(db, "mods", KICK).await;
        let patch = |name: &str, color: &str, perms: Option<i64>| {
            let state = state.clone();
            let (name, color) = (name.to_string(), color.to_string());
            async move {
                update_role(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path(("club".to_string(), id)),
                    Json(RolePatch {
                        name: Some(name),
                        color: Some(color),
                        perms,
                    }),
                )
                .await
            }
        };
        let before = ("mods".to_string(), "#ffffff".to_string(), KICK);
        let err = patch("helpers", "red", Some(MA)).await.err().map(|e| e.0);
        assert_eq!(err, Some(StatusCode::BAD_REQUEST));
        assert_eq!(role_row(db, id).await, before);
        let err = patch(" ", "#000000", Some(MA)).await.err().map(|e| e.0);
        assert_eq!(err, Some(StatusCode::BAD_REQUEST));
        assert_eq!(role_row(db, id).await, before);
        let Json(role) = patch("helpers", "#00ff00", Some(MA | 64))
            .await
            .expect("valid");
        assert_eq!(
            (role.name.as_str(), role.color.as_str(), role.perms),
            ("helpers", "#00ff00", MA)
        );
        assert_eq!(
            role_row(db, id).await,
            ("helpers".to_string(), "#00ff00".to_string(), MA)
        );
        done(state, path).await;
    }

    fn admin_events(
        rx: &mut tokio::sync::broadcast::Receiver<WsEvent>,
    ) -> Vec<(String, bool, i64)> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::AdminChanged {
                server: _,
                username,
                is_admin,
                perms,
            } = ev
            {
                out.push((username, is_admin, perms));
            }
        }
        out
    }

    #[tokio::test]
    async fn transfer_reports_stored_perms_and_cannot_escalate() {
        let (state, path) = temp_state("transfer_admin").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dave"]).await;
        set_admin_row(db, "bob", MA | KICK).await;
        set_admin_row(db, "dave", KICK).await;
        let transfer = |actor: &str, target: &str| {
            let state = state.clone();
            let (actor, target) = (actor.to_string(), target.to_string());
            async move {
                code(
                    transfer_admin(
                        State(state),
                        Authed(mem_user(&actor, false)),
                        Path("club".to_string()),
                        Json(UsernameReq { username: target }),
                    )
                    .await,
                )
            }
        };
        let mut rx = state.hub.subscribe();
        assert_eq!(transfer("bob", "carol").await, no_grant());
        assert_eq!(member_row(db, "carol").await, (0, 0));
        assert_eq!(member_row(db, "bob").await, (1, MA | KICK));
        transfer("bob", "dave")
            .await
            .expect("restricted admin target");
        assert_eq!(member_row(db, "dave").await, (1, KICK));
        assert_eq!(member_row(db, "bob").await, (0, 0));
        assert_eq!(
            admin_events(&mut rx),
            [
                ("dave".to_string(), true, KICK),
                ("bob".to_string(), false, 0)
            ]
        );
        transfer("alice", "carol").await.expect("full admin");
        assert_eq!(member_row(db, "carol").await, (1, 0));
        assert_eq!(
            admin_events(&mut rx),
            [
                ("carol".to_string(), true, 0),
                ("alice".to_string(), false, 0)
            ]
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn rename_events_only_for_real_renames() {
        let (state, path) = temp_state("rename_events").await;
        let db = &state.db;
        club_with(&state, &[]).await;
        let mut rx = state.hub.subscribe();
        let kinds = |rx: &mut tokio::sync::broadcast::Receiver<WsEvent>| {
            let mut out = Vec::new();
            while let Ok(ev) = rx.try_recv() {
                match ev {
                    WsEvent::ServerRenamed { old_name, server } => {
                        out.push(format!("server_renamed {old_name} {}", server.display_name))
                    }
                    WsEvent::ServerUpdated { server } => out.push(format!(
                        "server_updated {} {}",
                        server.display_name, server.has_password
                    )),
                    WsEvent::ChannelRenamed { server: _, channel } => {
                        out.push(format!("channel_renamed {}", channel.name))
                    }
                    WsEvent::ChannelUpdated { server: _, channel } => out.push(format!(
                        "channel_updated {} {}",
                        channel.name, channel.slowmode_seconds
                    )),
                    _ => {}
                }
            }
            out
        };
        let patch =
            |body: &'static str| patch_colors(&state, mem_user("alice", false), "club", body);
        patch(r#"{"password":"hunter22"}"#).await.expect("password");
        patch(r#"{"name":"club"}"#).await.expect("same name");
        patch(r##"{"banner_color":"#101010"}"##)
            .await
            .expect("color");
        patch(r#"{"name":"Club"}"#).await.expect("display rename");
        patch(r#"{"name":"Den"}"#).await.expect("rename");
        assert_eq!(
            kinds(&mut rx),
            [
                "server_updated club true",
                "server_updated club true",
                "server_updated club true",
                "server_renamed club Club",
                "server_renamed club Den",
            ]
        );
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'den'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        let channel = |name: Option<&str>, slowmode_seconds: Option<i64>| {
            let state = state.clone();
            let name = name.map(str::to_string);
            async move {
                update_channel(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path(cid),
                    Json(ChannelPatch {
                        name,
                        slowmode_seconds,
                    }),
                )
                .await
                .expect("channel patch")
            }
        };
        let current = channel(None, None).await.0.name;
        let _ = channel(None, Some(30)).await;
        let _ = channel(Some(&current), None).await;
        let _ = channel(Some("talk"), Some(0)).await;
        assert_eq!(
            kinds(&mut rx),
            [
                format!("channel_updated {current} 0"),
                format!("channel_updated {current} 30"),
                format!("channel_updated {current} 30"),
                "channel_renamed talk".to_string(),
            ]
        );
        done(state, path).await;
    }
}
