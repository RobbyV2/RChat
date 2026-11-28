use std::collections::HashMap;

use axum::extract::{Path, RawQuery, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::members::{Roster, SERVER_HIDDEN, refusal};
use crate::api::access::perms::{Perm, bit_name};
use crate::api::access::subjects::{Level, ProfileChoices, level_of, own_choice};
use crate::api::access::{Proof, resolve_server};
use crate::api::lookup::{self, LookupClass};
use crate::api::passwords::joined_via;
use crate::api::profiles::{Shown, shown_in};
use crate::api::servers::{lookup_text, role_ids_of};
use crate::api::timeouts::running_timeouts;
use crate::api::{
    ApiError, ApiErrorBody, Authed, Member, Paged, cursor_int, decode_cursor, encode_cursor,
    placeholders, user_from, user_refs,
};
use crate::db::{Db, is_sqlite};
use crate::state::AppState;

/// The most members a page holds.
pub const PAGE_MAX: i64 = 50;
/// The most roles one search names.
pub const ROLES_MAX: usize = 25;
/// The most member rows one request reads to fill a page.
const SCAN_MAX: usize = 2000;
/// Rows a request reads after its first chunk, at most, per query.
const CHUNK_MAX: usize = 500;

/// Any of these lets a member search the member list with filters.
pub const SEARCH_PERMS: i64 = Perm::Kick as i64
    | Perm::TimeoutMembers as i64
    | Perm::ManageRoles as i64
    | Perm::AssignRoles as i64
    | Perm::ManageProfiles as i64;

/// How a member search is ordered. Ties go by username, in the same direction.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemberSort {
    /// By username.
    #[default]
    Name,
    /// Newest members first.
    JoinedDesc,
    /// Oldest members first.
    JoinedAsc,
    /// Newest accounts first.
    CreatedDesc,
    /// Oldest accounts first.
    CreatedAsc,
}

impl MemberSort {
    const ALL: [MemberSort; 5] = [
        MemberSort::Name,
        MemberSort::JoinedDesc,
        MemberSort::JoinedAsc,
        MemberSort::CreatedDesc,
        MemberSort::CreatedAsc,
    ];

    fn wire(self) -> &'static str {
        match self {
            MemberSort::Name => "name",
            MemberSort::JoinedDesc => "joined_desc",
            MemberSort::JoinedAsc => "joined_asc",
            MemberSort::CreatedDesc => "created_desc",
            MemberSort::CreatedAsc => "created_asc",
        }
    }

    fn parse(raw: &str) -> Option<MemberSort> {
        MemberSort::ALL.into_iter().find(|s| s.wire() == raw)
    }

    /// The time column it orders by, and whether newest first. `None` orders by username.
    fn key(self) -> Option<(&'static str, bool)> {
        match self {
            MemberSort::Name => None,
            MemberSort::JoinedDesc => Some(("m.joined_at", true)),
            MemberSort::JoinedAsc => Some(("m.joined_at", false)),
            MemberSort::CreatedDesc => Some(("u.created_at", true)),
            MemberSort::CreatedAsc => Some(("u.created_at", false)),
        }
    }
}

/// A member search, read from its query. Every filter is optional and they all apply at once.
#[derive(Debug, Default, PartialEq, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct Search {
    /// Text the username, display name or server profile name (while the server shows them)
    /// contains, case-insensitive, 1 to 32 characters after trimming. Blank means any name.
    #[param(example = "al")]
    pub q: Option<String>,
    /// Role ids separated by commas, at most 25: members who have any of them.
    #[param(value_type = Option<String>, example = "3,7")]
    pub roles: Vec<i64>,
    /// Members who joined at or after this Unix time, in seconds.
    pub joined_after: Option<i64>,
    /// Members who joined before this Unix time, in seconds.
    pub joined_before: Option<i64>,
    /// Members whose account was made at or after this Unix time, in seconds.
    pub created_after: Option<i64>,
    /// Members whose account was made before this Unix time, in seconds.
    pub created_before: Option<i64>,
    /// Id of an extra server password: the members who joined with it. Needs the Manage
    /// invites permission.
    pub via: Option<i64>,
    /// The order, `name` by default.
    #[param(value_type = Option<MemberSort>)]
    pub sort: MemberSort,
    /// Page size, default and at most 50. Must be an integer.
    #[param(value_type = Option<i64>)]
    pub limit: i64,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header, for the same `sort`.
    pub cursor: Option<String>,
}

fn int(value: &str, field: &str, what: &str) -> Result<i64, ApiError> {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 0)
        .ok_or_else(|| ApiError::invalid(format!("{field}: expected {what}"), field))
}

impl Search {
    pub(crate) fn parse(raw: &str) -> Result<Search, ApiError> {
        let mut out = Search {
            limit: PAGE_MAX,
            ..Search::default()
        };
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            let time = |field: &str| int(&value, field, "a Unix time in seconds").map(Some);
            match key.as_ref() {
                "q" => {
                    out.q = match value.trim().is_empty() {
                        true => None,
                        false => Some(lookup_text(Some(&value), 1)?),
                    }
                }
                "roles" => {
                    for part in value.split(',').map(str::trim).filter(|p| !p.is_empty()) {
                        let id = int(part, "roles", "role ids separated by commas")?;
                        if !out.roles.contains(&id) {
                            out.roles.push(id);
                        }
                    }
                    if out.roles.len() > ROLES_MAX {
                        return Err(ApiError::invalid(
                            format!("roles: at most {ROLES_MAX} roles"),
                            "roles",
                        ));
                    }
                }
                "joined_after" => out.joined_after = time("joined_after")?,
                "joined_before" => out.joined_before = time("joined_before")?,
                "created_after" => out.created_after = time("created_after")?,
                "created_before" => out.created_before = time("created_before")?,
                "via" => out.via = Some(int(&value, "via", "a password id")?),
                "sort" => out.sort = MemberSort::parse(value.trim()).ok_or_else(|| {
                    ApiError::invalid(
                        "sort: expected name, joined_desc, joined_asc, created_desc or created_asc",
                        "sort",
                    )
                })?,
                "limit" => out.limit = int(&value, "limit", "an integer")?.clamp(1, PAGE_MAX),
                "cursor" if !value.trim().is_empty() => out.cursor = Some(value.to_string()),
                _ => {}
            }
        }
        Ok(out)
    }

    /// Where the page starts: after this time key (for a time sort) and username.
    /// Whether it filters or orders by account times.
    fn reads_ages(&self) -> bool {
        self.created_after.is_some()
            || self.created_before.is_some()
            || matches!(self.sort, MemberSort::CreatedDesc | MemberSort::CreatedAsc)
    }

    fn after(&self) -> Result<Option<(Option<i64>, String)>, ApiError> {
        let Some(raw) = &self.cursor else {
            return Ok(None);
        };
        let parts = decode_cursor(raw, 3)?;
        if parts[0] != self.sort.wire() {
            return Err(ApiError::invalid("Invalid cursor", "cursor"));
        }
        let key = match self.sort.key() {
            Some(_) => Some(cursor_int(&parts[1])?),
            None => None,
        };
        Ok(Some((key, parts[2].clone())))
    }
}

/// The `LIKE` pattern that keeps every row whose lowercase username, display name or server
/// profile name contains `q`, or `None` when it would keep every row. Only ASCII characters both
/// databases lowercase the same way are compared; the rest match anything and each row is checked
/// again in Rust.
fn q_pattern(q: &str) -> Option<String> {
    let mut p = String::from("%");
    let mut exact = false;
    for c in q.chars() {
        match c.is_ascii() && !c.is_ascii_uppercase() && c != 'i' && c != 'k' {
            true => {
                if matches!(c, '%' | '_' | '\\') {
                    p.push('\\');
                }
                p.push(c);
                exact = true;
            }
            false if p.ends_with('%') && !p.ends_with("\\%") => {}
            false => p.push('%'),
        }
    }
    if !p.ends_with('%') || p.ends_with("\\%") {
        p.push('%');
    }
    exact.then_some(p)
}

/// Whether the username, display name or shown server profile name contains `q`, each
/// lowercased: the rule the P2P filter runs too (`member_filters.ts`).
pub(crate) fn name_matches(
    q: &str,
    username: &str,
    display_name: &str,
    server_name: Option<&str>,
) -> bool {
    [Some(username), Some(display_name), server_name]
        .into_iter()
        .flatten()
        .any(|name| name.to_lowercase().contains(q))
}

enum Arg {
    Int(i64),
    Text(String),
}

/// Adds `a` to the arguments after the server's `$1` and answers its placeholder.
fn arg(args: &mut Vec<Arg>, a: Arg) -> String {
    args.push(a);
    format!("${}", args.len() + 1)
}

/// A member row a search found.
#[derive(Debug)]
struct Found {
    username: String,
    is_admin: i64,
    perms: i64,
    joined_at: i64,
    created_at: i64,
    display_name: String,
    // The account's own profile choice (`privacy.profile`).
    profile: Option<String>,
    // Their profile name in the server, while the server shows them.
    server_name: Option<String>,
}

impl Found {
    fn key(&self, sort: MemberSort) -> Option<i64> {
        match sort {
            MemberSort::Name => None,
            MemberSort::JoinedDesc | MemberSort::JoinedAsc => Some(self.joined_at),
            MemberSort::CreatedDesc | MemberSort::CreatedAsc => Some(self.created_at),
        }
    }

    fn cursor(&self, sort: MemberSort) -> String {
        let key = self.key(sort).map(|k| k.to_string()).unwrap_or_default();
        encode_cursor(&[sort.wire(), &key, &self.username])
    }
}

/// Up to `take` rows of `server` the search's SQL keeps, in its order, after `after`. Server
/// profile names are read only while `shown` shows them.
async fn chunk(
    db: &Db,
    server: &str,
    s: &Search,
    ages: &Ages<'_>,
    shown: Shown,
    after: Option<&(Option<i64>, String)>,
    take: usize,
) -> Result<Vec<Found>, ApiError> {
    let user = match is_sqlite(db) {
        true => "m.username",
        false => "(m.username COLLATE \"C\")",
    };
    let (named, profiles) = match shown.names() {
        true => (
            "mp.name",
            " LEFT JOIN member_profiles mp ON mp.server = m.server AND mp.username = m.username",
        ),
        false => ("CAST(NULL AS TEXT)", ""),
    };
    let mut sql = format!(
        "SELECT m.username, m.is_admin, m.perms, m.joined_at, u.created_at, u.display_name, p.profile, {named} FROM members m JOIN users u ON u.username = m.username LEFT JOIN privacy p ON p.username = m.username{profiles} WHERE m.server = $1"
    );
    let mut args: Vec<Arg> = Vec::new();
    let bounds = [
        ("m.joined_at >=", s.joined_after),
        ("m.joined_at <", s.joined_before),
        ("u.created_at >=", s.created_after),
        ("u.created_at <", s.created_before),
        ("m.joined_via =", s.via),
    ];
    for (test, value) in bounds {
        if let Some(v) = value {
            let at = arg(&mut args, Arg::Int(v));
            sql.push_str(&format!(" AND {test} {at}"));
        }
    }
    if s.reads_ages() && ages.settings.profile_choices != ProfileChoices::Site {
        let me = arg(&mut args, Arg::Text(ages.caller.to_string()));
        sql.push_str(&format!(
            " AND (COALESCE(p.profile, '') <> 'friends' OR m.username = {me})"
        ));
    }
    if !s.roles.is_empty() {
        let first = args.len() + 2;
        for id in &s.roles {
            args.push(Arg::Int(*id));
        }
        sql.push_str(&format!(
            " AND EXISTS(SELECT 1 FROM user_roles r WHERE r.server = m.server AND r.username = m.username AND r.role_id IN ({}))",
            placeholders(first, s.roles.len())
        ));
    }
    if let Some(p) = s.q.as_deref().and_then(q_pattern) {
        let at = arg(&mut args, Arg::Text(p));
        let server_name = match shown.names() {
            true => format!(" OR lower(mp.name) LIKE {at} ESCAPE '\\'"),
            false => String::new(),
        };
        sql.push_str(&format!(
            " AND (lower(m.username) LIKE {at} ESCAPE '\\' OR lower(u.display_name) LIKE {at} ESCAPE '\\'{server_name})"
        ));
    }
    let (cmp, order) = match s.sort.key() {
        None => (">", user.to_string()),
        Some((col, true)) => ("<", format!("{col} DESC, {user} DESC")),
        Some((col, false)) => (">", format!("{col}, {user}")),
    };
    match (after, s.sort.key()) {
        (None, _) => {}
        (Some((_, name)), None) => {
            let at = arg(&mut args, Arg::Text(name.clone()));
            sql.push_str(&format!(" AND {user} {cmp} {at}"));
        }
        (Some((key, name)), Some((col, _))) => {
            let k = arg(&mut args, Arg::Int(key.unwrap_or_default()));
            let n = arg(&mut args, Arg::Text(name.clone()));
            sql.push_str(&format!(" AND ({col}, {user}) {cmp} ({k}, {n})"));
        }
    }
    let limit = arg(&mut args, Arg::Int(take as i64));
    sql.push_str(&format!(" ORDER BY {order} LIMIT {limit}"));
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for a in args {
        query = match a {
            Arg::Int(v) => query.bind(v),
            Arg::Text(v) => query.bind(v),
        };
    }
    let mut out = Vec::new();
    for r in &query.fetch_all(db).await? {
        out.push(Found {
            username: r.try_get(0)?,
            is_admin: r.try_get(1)?,
            perms: r.try_get(2)?,
            joined_at: r.try_get(3)?,
            created_at: r.try_get(4)?,
            display_name: r.try_get(5)?,
            profile: r.try_get(6)?,
            server_name: r.try_get(7)?,
        });
    }
    Ok(out)
}

/// One page of the members of `server` the search keeps, and the cursor of the next. A page
/// holds fewer members than `limit`, or none, with a cursor when `SCAN_MAX` rows were read
/// before it was full.
async fn page(
    db: &Db,
    server: &str,
    s: &Search,
    ages: &Ages<'_>,
    shown: Shown,
) -> Result<(Vec<Found>, Option<String>), ApiError> {
    let limit = s.limit.clamp(1, PAGE_MAX) as usize;
    let want = limit + 1;
    let mut after = s.after()?;
    let mut out: Vec<Found> = Vec::with_capacity(want);
    let mut take = want;
    let mut read = 0;
    loop {
        let rows = chunk(db, server, s, ages, shown, after.as_ref(), take).await?;
        let exhausted = rows.len() < take;
        for row in rows {
            read += 1;
            after = Some((row.key(s.sort), row.username.clone()));
            let hit = s.q.as_deref().is_none_or(|q| {
                name_matches(
                    q,
                    &row.username,
                    &row.display_name,
                    row.server_name.as_deref(),
                )
            }) && (!s.reads_ages() || ages.shown(&row));
            if hit {
                out.push(row);
                if out.len() == want {
                    out.truncate(limit);
                    let next = out.last().map(|r| r.cursor(s.sort));
                    return Ok((out, next));
                }
            }
        }
        if exhausted {
            return Ok((out, None));
        }
        if read >= SCAN_MAX {
            let next = after.map(|(key, username)| {
                let key = key.map(|k| k.to_string()).unwrap_or_default();
                encode_cursor(&[s.sort.wire(), &key, &username])
            });
            return Ok((out, next));
        }
        take = (take * 4).min(CHUNK_MAX).min(SCAN_MAX - read);
    }
}

/// Whose account times a caller sees: those of accounts that show their profile to the members
/// of a server they share (every level but `friends`), and their own. A search that reads
/// account times leaves the others out in its SQL already, so no cursor names one.
struct Ages<'a> {
    settings: &'a crate::api::Settings,
    caller: &'a str,
}

impl Ages<'_> {
    fn shown(&self, row: &Found) -> bool {
        row.username == self.caller
            || level_of(self.settings, own_choice(row.profile.as_deref())) >= Level::Shared
    }
}

/// A member a search found: the member as member lists show them, with their join and
/// account times.
#[derive(Serialize, ToSchema)]
pub struct MemberHit {
    /// The member, flattened into this object.
    #[serde(flatten)]
    pub member: Member,
    /// When they joined the server.
    pub joined_at: i64,
    /// When their account was made; `null` for an account that shows its profile only to its
    /// friends.
    pub created_at: Option<i64>,
}

/// Search server members
///
/// Server members found by name (username, display name, or the server profile name they set
/// here while the server shows them), roles, join time, account age and the extra password they
/// joined with, in pages of `limit` (default and at most 50). Page with `cursor` from the
/// `X-Next-Cursor` response header. A page may hold fewer members than `limit`, even none,
/// while `X-Next-Cursor` is present: ask for the next one. Each member carries `joined_via`
/// for callers with the Manage invites permission and `timeout` for callers with the Timeout
/// members permission, as in `GET /api/v1/servers/{name}/members`.
///
/// Needs any of the Kick, Timeout members, Manage roles, Assign roles or Manage profiles
/// permissions (a timeout does not take it away); `via` needs Manage invites too. Accounts that
/// show their profile only to their friends answer `created_at: null` and are left out of the
/// `created_after`, `created_before`, `created_desc` and `created_asc` results. Each call takes one
/// of the caller's `member_search` lookups (`LOOKUP_MEMBER_SEARCH_PER_MINUTE`, 30 a minute by
/// default). General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/members/search",
    tag = "Members",
    params(("name" = String, Path, description = "Server name, case-insensitive"), Search),
    responses(
        (status = 200, description = "A page of members", body = Vec<MemberHit>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "A value that can't be read (reason `invalid`, `field` names it): `q` over 32 characters or with NUL, more than 25 `roles`, a time, id or `limit` that is not a whole number of 0 or more, an unknown `sort`; or `Invalid cursor`", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Missing permission`: none of the permissions above, or `via` without Manage invites. `You are banned from this server`", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller used up its `member_search` lookups. Or too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn search_members(
    State(state): State<AppState>,
    Authed(user): Authed,
    headers: HeaderMap,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Paged<MemberHit>, ApiError> {
    let search = Search::parse(raw.as_deref().unwrap_or(""))?;
    lookup::take(&state, LookupClass::MemberSearch, Some(&user))?;
    let db = &state.read();
    let access = resolve_server(
        db,
        &name,
        Some(&user),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    let perms = access.view_perms(db).await?;
    if perms & SEARCH_PERMS == 0 {
        return Err(ApiError::perm(
            "Missing permission",
            bit_name(SEARCH_PERMS as rchat_perms::Mask),
        ));
    }
    let invites = perms & Perm::ManageInvites as i64 != 0;
    if search.via.is_some() && !invites {
        return Err(ApiError::perm(
            "Missing permission",
            bit_name(SEARCH_PERMS as rchat_perms::Mask),
        ));
    }
    let settings = crate::api::Settings::cached(db).await;
    let list = match access.member_list(db, &settings).await? {
        Roster::Shown(list) => list,
        Roster::Hidden(why) => {
            return Err(refusal(why, access.lite())
                .unwrap_or_else(|| ApiError::perm(SERVER_HIDDEN, "ViewMembers")));
        }
    };
    let key = list.server().to_string();
    let ages = Ages {
        settings: &settings,
        caller: &user.username,
    };
    let shown = shown_in(db, &key).await?;
    let (rows, next) = page(db, &key, &search, &ages, shown).await?;
    let names: Vec<String> = rows.iter().map(|r| r.username.clone()).collect();
    let online = state.hub.online_among(&key, &names);
    let refs = user_refs(db, &names).await;
    let mut roles = role_ids_of(db, &key, &names).await?;
    let mut via = match invites {
        true => joined_via(db, &key, &names).await?,
        false => HashMap::new(),
    };
    let mut timeouts = match perms & Perm::TimeoutMembers as i64 != 0 {
        true => running_timeouts(db, &key, &names).await?,
        false => HashMap::new(),
    };
    let mut looks = crate::api::profiles::looks_of(db, &key, &names).await?;
    let creator = access.lite().creator.clone();
    let hits = rows
        .into_iter()
        .map(|row| {
            let shown = ages.shown(&row);
            (row, shown)
        })
        .map(
            |(
                Found {
                    username,
                    is_admin,
                    perms,
                    joined_at,
                    created_at,
                    display_name: _,
                    profile: _,
                    server_name: _,
                },
                shown,
            )| MemberHit {
                member: Member {
                    profile: looks.remove(&username),
                    timeout: timeouts.remove(&username),
                    online: online.contains(username.as_str()),
                    is_admin: is_admin != 0,
                    is_creator: creator.as_deref() == Some(username.as_str()),
                    perms,
                    role_ids: roles.remove(&username).unwrap_or_default(),
                    joined_via: via.remove(&username),
                    user: user_from(&refs, &username),
                },
                joined_at,
                created_at: shown.then_some(created_at),
            },
        )
        .collect();
    Ok(Paged(hits, next))
}

#[cfg(test)]
mod tests;
