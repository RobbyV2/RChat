use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::{
    Proof, Reading, ServerAccess, granted_servers, is_member, not_found, resolve_server,
};
use crate::api::blocks::prefix_pattern;
use crate::api::friends::ProfilePolicy;
use crate::api::instance::verify_binding;
use crate::api::servers::prefix_end;
use crate::api::{
    ApiError, Settings, UserRef, allowed, placeholders, unique_capped, user_from, user_refs,
};
use crate::db::{Db, User, is_sqlite};
use crate::state::AppState;

/// Who may see an account's profile, least open first: `friends` (only an account's own
/// choice), `shared` (people who share a server, a direct conversation the account wrote in or
/// a friendship with it), `public_servers` (also everyone, for an account in a server anyone
/// can read) and `everyone`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Friends,
    Shared,
    PublicServers,
    Everyone,
}

impl Level {
    pub const KEY: &str = "profile_visibility";
    pub const ENV: &str = "PROFILE_VISIBILITY";
    /// The levels an instance may choose.
    pub const WORDS: [&str; 3] = ["everyone", "public_servers", "shared"];

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Friends => "friends",
            Level::Shared => "shared",
            Level::PublicServers => "public_servers",
            Level::Everyone => "everyone",
        }
    }

    /// The instance level `value` names.
    pub fn parse(value: &str) -> Option<Level> {
        match value {
            "everyone" => Some(Level::Everyone),
            "public_servers" => Some(Level::PublicServers),
            "shared" => Some(Level::Shared),
            _ => None,
        }
    }
}

/// What accounts may choose for themselves (`profile_choices`): `any` of the three choices,
/// only a `narrower` one than the instance's level (a wider one acts as no choice), or nothing
/// (`site`: every account follows the instance's level, and stored choices are kept).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProfileChoices {
    Any,
    Narrower,
    Site,
}

impl ProfileChoices {
    pub const KEY: &str = "profile_choices";
    pub const ENV: &str = "PROFILE_CHOICES";
    pub const WORDS: [&str; 3] = ["any", "narrower", "site"];

    pub fn as_str(self) -> &'static str {
        match self {
            ProfileChoices::Any => "any",
            ProfileChoices::Narrower => "narrower",
            ProfileChoices::Site => "site",
        }
    }

    pub fn parse(value: &str) -> Option<ProfileChoices> {
        match value {
            "any" => Some(ProfileChoices::Any),
            "narrower" => Some(ProfileChoices::Narrower),
            "site" => Some(ProfileChoices::Site),
            _ => None,
        }
    }
}

/// The relationship that lets a caller see an account. It stays in the server: no answer says
/// which one was found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Seen {
    /// The caller's own account.
    Myself,
    /// The account shows itself to everyone.
    Everyone,
    Friend,
    /// The account sent the caller a friend request that is pending.
    Incoming,
    /// A direct conversation the account wrote in.
    Dm,
    /// A server both are members of (one of them).
    Common(String),
    /// The server the caller named and can open, or for a guest a server one of its grants
    /// opens, where the account is a member.
    Context(String),
    /// The account is a member of a server anyone can read.
    Public,
    /// A P2P binding of the account that the caller presents.
    Badge,
}

impl Seen {
    /// Whether it shows an account whose effective level is `level`.
    fn counts(&self, level: Level) -> bool {
        let least = match self {
            Seen::Myself | Seen::Friend | Seen::Incoming => Level::Friends,
            Seen::Dm | Seen::Common(_) | Seen::Context(_) | Seen::Badge => Level::Shared,
            Seen::Public => Level::PublicServers,
            Seen::Everyone => Level::Everyone,
        };
        level >= least
    }
}

/// Who asks about an account, and what they show for it.
pub struct Caller<'a> {
    /// `None` for a guest or a caller without a token.
    pub user: Option<&'a User>,
    /// Guest grants and passwords, as for `resolve_server`.
    pub proof: &'a Proof<'a>,
    /// A server the caller names as context.
    pub server: Option<&'a str>,
    /// A P2P binding JWT of the account (`X-Subject-Binding`).
    pub badge: Option<&'a str>,
}

/// An account a caller may see.
pub struct SeenUser {
    pub user: User,
    pub seen: Seen,
    /// The caller's access to the server it named, when the account is a member there.
    pub member: Option<ServerAccess>,
}

/// The level that applies to an account: the instance's level without a choice of its own,
/// and otherwise as the instance's `profile_choices` allows: the choice (`any`), the lower of
/// the two (`narrower`), or the instance's level (`site`).
pub fn level_of(settings: &Settings, own: Option<ProfilePolicy>) -> Level {
    let site = settings.profile_visibility;
    let own = match own {
        None | Some(ProfilePolicy::Default) => return site,
        Some(ProfilePolicy::Friends) => Level::Friends,
        Some(ProfilePolicy::Shared) => Level::Shared,
        Some(ProfilePolicy::Everyone) => Level::Everyone,
    };
    match settings.profile_choices {
        ProfileChoices::Any => own,
        ProfileChoices::Narrower => site.min(own),
        ProfileChoices::Site => site,
    }
}

/// The level of an account for each instance level, `profile_choices` and own choice: a row
/// per instance level (`everyone`, `public_servers`, `shared`), a column per choice (none,
/// `friends`, `shared`, `everyone`), E, P, S and F for the levels.
#[cfg(test)]
pub(crate) fn wanted_level(site: Level, choices: ProfileChoices, own: Option<&str>) -> Level {
    let rows = match choices {
        ProfileChoices::Any => ["EFSE", "PFSE", "SFSE"],
        ProfileChoices::Narrower => ["EFSE", "PFSP", "SFSS"],
        ProfileChoices::Site => ["EEEE", "PPPP", "SSSS"],
    };
    let row = match site {
        Level::Everyone => rows[0],
        Level::PublicServers => rows[1],
        Level::Shared | Level::Friends => rows[2],
    };
    let column = match own {
        None => 0,
        Some("friends") => 1,
        Some("shared") => 2,
        Some("everyone") => 3,
        Some(other) => panic!("no choice {other}"),
    };
    match row.as_bytes()[column] {
        b'E' => Level::Everyone,
        b'P' => Level::PublicServers,
        b'S' => Level::Shared,
        _ => Level::Friends,
    }
}

/// The instance levels and every `profile_choices` value, as stored.
#[cfg(test)]
pub(crate) const SITE_LEVELS: [(&str, Level); 3] = [
    ("everyone", Level::Everyone),
    ("public_servers", Level::PublicServers),
    ("shared", Level::Shared),
];
#[cfg(test)]
pub(crate) const ALL_CHOICES: [(&str, ProfileChoices); 3] = [
    ("any", ProfileChoices::Any),
    ("narrower", ProfileChoices::Narrower),
    ("site", ProfileChoices::Site),
];
/// Every choice an account can store: none, and the three.
#[cfg(test)]
pub(crate) const OWN_CHOICES: [Option<&str>; 4] =
    [None, Some("friends"), Some("shared"), Some("everyone")];

#[cfg(test)]
thread_local! {
    static CHECKS: std::cell::RefCell<Vec<&'static str>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// The checks `resolve_user` ran on this thread since the last call, in order.
#[cfg(test)]
pub(crate) fn checks_run() -> Vec<&'static str> {
    CHECKS.with(|checks| checks.take())
}

fn ran(_check: &'static str) {
    #[cfg(test)]
    CHECKS.with(|checks| checks.borrow_mut().push(_check));
}

const ACCOUNT_SQL: &str = "SELECT u.*, p.profile AS profile_choice FROM users u LEFT JOIN privacy p ON p.username = u.username WHERE u.username = $1 AND u.password_hash <> '!purging'";
const FRIEND_SQL: &str = "SELECT 1 FROM friends WHERE username = $1 AND friend = $2";
const INCOMING_SQL: &str = "SELECT 1 FROM friend_requests WHERE sender = $1 AND recipient = $2";
const DM_SQL: &str = "SELECT 1 FROM dms d WHERE d.user_a = $1 AND d.user_b = $2 AND EXISTS(SELECT 1 FROM messages m WHERE m.dm_id = d.id AND m.author = $3)";
const COMMON_SQL: &str = "SELECT a.server FROM members a JOIN members b ON b.server = a.server AND b.username = $2 WHERE a.username = $1 LIMIT 1";

/// Whether `$1` is a member of a server anyone may read by its name, as the gate decides it,
/// that shows its members to people outside it.
fn public_sql(reading: Reading) -> String {
    format!(
        "SELECT 1 FROM members m JOIN servers s ON s.name = m.server WHERE m.username = $1 AND {} AND s.members_visible <> 0 LIMIT 1",
        reading.readable_sql()
    )
}

/// Whether a server the caller opened proves a relationship with its members: always for one
/// of its members, and for anyone else only while it shows its members to people outside it.
fn shows_members(access: &ServerAccess) -> bool {
    access.is_member() || access.lite().members_visible
}

/// Whether a server the caller opened lists its members and their membership to the caller: to
/// its members and the site admin always, and to anyone else only while it shows its members to
/// people outside it.
pub fn lists_members(access: &ServerAccess) -> bool {
    shows_members(access) || access.site_admin()
}

fn own_choice(stored: Option<&str>) -> Option<ProfilePolicy> {
    match stored {
        Some("shared") => Some(ProfilePolicy::Shared),
        Some("friends") => Some(ProfilePolicy::Friends),
        Some("everyone") => Some(ProfilePolicy::Everyone),
        _ => None,
    }
}

async fn holds(
    db: &Db,
    check: &'static str,
    sql: &'static str,
    binds: &[&str],
) -> Result<bool, ApiError> {
    ran(check);
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    Ok(query.fetch_optional(db).await?.is_some())
}

/// What a caller may learn about a name: the account, the relationship that shows its profile,
/// and its membership in the named server. The checks that run depend only on the caller and
/// the instance, never on the name: a name without an account and an account the caller may
/// not see cost the same.
struct Found {
    user: Option<User>,
    seen: Option<Seen>,
    member: Option<ServerAccess>,
}

async fn find(state: &AppState, caller: &Caller<'_>, username: &str) -> Result<Found, ApiError> {
    let db = &state.read();
    let name = username.to_lowercase();
    let settings = Settings::cached(&state.db).await;
    ran("account");
    let row = sqlx::query(ACCOUNT_SQL)
        .bind(&name)
        .fetch_optional(db)
        .await?;
    let (user, own) = match &row {
        Some(row) => (
            Some(User::from_row(row)?),
            own_choice(
                row.try_get::<Option<String>, _>("profile_choice")?
                    .as_deref(),
            ),
        ),
        None => (None, None),
    };
    let level = level_of(&settings, own);
    let me = caller.user.map(|u| u.username.as_str());
    let mut seen = match (&user, me == Some(name.as_str()), level) {
        (Some(_), true, _) => Some(Seen::Myself),
        (Some(_), false, Level::Everyone) => Some(Seen::Everyone),
        (_, _, _) => None,
    };
    if let Some(me) = me {
        let (a, b) = match me <= name.as_str() {
            true => (me, name.as_str()),
            false => (name.as_str(), me),
        };
        let steps: [(&'static str, &'static str, Vec<&str>, Seen); 3] = [
            ("friend", FRIEND_SQL, vec![me, &name], Seen::Friend),
            ("incoming", INCOMING_SQL, vec![&name, me], Seen::Incoming),
            ("dm", DM_SQL, vec![a, b, &name], Seen::Dm),
        ];
        for (check, sql, binds, found) in steps {
            if seen.is_none() && holds(db, check, sql, &binds).await? && found.counts(level) {
                seen = Some(found);
            }
        }
        if seen.is_none() {
            ran("common");
            let server: Option<String> = sqlx::query(COMMON_SQL)
                .bind(me)
                .bind(&name)
                .fetch_optional(db)
                .await?
                .map(|r| r.try_get(0))
                .transpose()?;
            seen = server.map(Seen::Common).filter(|found| found.counts(level));
        }
    }
    let mut member = None;
    match caller.server {
        Some(server) => {
            ran("context");
            let access = allowed(resolve_server(db, server, caller.user, caller.proof).await)?;
            if let Some(access) = access {
                ran("member");
                if is_member(db, access.name(), &name).await? {
                    let found = Seen::Context(access.name().to_string());
                    if seen.is_none() && found.counts(level) && shows_members(&access) {
                        seen = Some(found);
                    }
                    member = Some(access).filter(lists_members);
                }
            }
        }
        None if caller.user.is_none() && seen.is_none() => {
            let servers = granted_servers(db, caller.proof).await?;
            if !servers.is_empty() {
                ran("grants");
                let sql = format!(
                    "SELECT m.server FROM members m JOIN servers s ON s.name = m.server WHERE m.username = $1 AND m.server IN ({}) AND s.members_visible <> 0 ORDER BY m.server LIMIT 1",
                    placeholders(2, servers.len())
                );
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(&name);
                for server in &servers {
                    query = query.bind(server);
                }
                let server: Option<String> = query
                    .fetch_optional(db)
                    .await?
                    .map(|r| r.try_get(0))
                    .transpose()?;
                seen = server
                    .map(Seen::Context)
                    .filter(|found| found.counts(level));
            }
        }
        None => {}
    }
    if seen.is_none() && settings.profile_visibility >= Level::PublicServers {
        ran("public");
        let sql = public_sql(Reading::now(&state.db).await);
        let public = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(&name)
            .fetch_optional(db)
            .await?
            .is_some();
        if public && Seen::Public.counts(level) {
            seen = Some(Seen::Public);
        }
    }
    if seen.is_none()
        && let Some(badge) = caller.badge
    {
        ran("badge");
        let theirs =
            verify_binding(state, badge).is_some_and(|(account, _)| account.to_lowercase() == name);
        if theirs && Seen::Badge.counts(level) {
            seen = Some(Seen::Badge);
        }
    }
    Ok(match user {
        Some(user) => Found {
            user: Some(user),
            seen,
            member,
        },
        None => Found {
            user: None,
            seen: None,
            member: None,
        },
    })
}

/// What `caller` may see of the account `username`: its profile when a relationship shows it
/// (`seen`), and its membership in the server the caller named and can open (`member`), which
/// shows whatever the account's level. `not_found()` when neither, as for a name without an
/// account.
pub struct UserView {
    pub user: User,
    pub seen: Option<Seen>,
    pub member: Option<ServerAccess>,
}

pub async fn view_user(
    state: &AppState,
    caller: &Caller<'_>,
    username: &str,
) -> Result<UserView, ApiError> {
    let Found { user, seen, member } = find(state, caller, username).await?;
    match user {
        Some(user) if seen.is_some() || member.is_some() => Ok(UserView { user, seen, member }),
        Some(_) | None => Err(not_found()),
    }
}

/// The account `username` when `caller` proves a relationship that shows it: itself, the
/// account's level `everyone`, a friendship, a pending request from the account, a direct
/// conversation the account wrote in, a common server, a server the caller names and can open
/// where the account is a member (for a guest also a server its grants open), a server anyone
/// can read, or a P2P binding of the account. A server that keeps its members to itself
/// (`members_visible` off) proves nothing to people outside it. The first that holds and counts at the account's
/// level is the answer. Everything else is `not_found()`, the same for a name without an
/// account, after the same checks. Nothing is kept between calls.
pub async fn resolve_user(
    state: &AppState,
    caller: &Caller<'_>,
    username: &str,
) -> Result<SeenUser, ApiError> {
    let Found { user, seen, member } = find(state, caller, username).await?;
    match (user, seen) {
        (Some(user), Some(seen)) => Ok(SeenUser { user, seen, member }),
        (_, _) => Err(not_found()),
    }
}

/// The rows `sql` finds: a name and, where the check has one, a server. `{in}` in `sql` stands
/// for the placeholders of `names`, which follow those of `first`.
async fn among(
    db: &Db,
    sql: &str,
    first: &[&str],
    names: &[&String],
) -> Result<Vec<(String, String)>, ApiError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = sql.replace("{in}", &placeholders(first.len() + 1, names.len()));
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for bind in first {
        query = query.bind(*bind);
    }
    for name in names {
        query = query.bind(name.as_str());
    }
    let rows = query.fetch_all(db).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push((row.try_get(0)?, row.try_get(1)?));
    }
    Ok(out)
}

/// The relationship that shows each of `names` (at most 100, in lowercase in the answer) to
/// `caller`: for every name the answer `resolve_user` gives, with one query per kind of
/// relationship. Names the caller may not see, or that have no account, are left out.
pub async fn seen_among(
    state: &AppState,
    caller: &Caller<'_>,
    names: &[String],
) -> Result<HashMap<String, Seen>, ApiError> {
    let db = &state.read();
    let names = unique_capped(names.iter().map(|n| n.to_lowercase()));
    let all: Vec<&String> = names.iter().collect();
    let settings = Settings::cached(&state.db).await;
    let mut levels: HashMap<String, Level> = HashMap::with_capacity(names.len());
    for (name, choice) in among(
        db,
        "SELECT u.username, COALESCE(p.profile, '') FROM users u LEFT JOIN privacy p ON p.username = u.username WHERE u.username IN ({in}) AND u.password_hash <> '!purging'",
        &[],
        &all,
    )
    .await?
    {
        levels.insert(name, level_of(&settings, own_choice(Some(choice.as_str()))));
    }
    let me = caller.user.map(|u| u.username.as_str());
    let mut seen: HashMap<String, Seen> = HashMap::new();
    for (name, level) in &levels {
        match (me == Some(name.as_str()), level) {
            (true, _) => seen.insert(name.clone(), Seen::Myself),
            (false, Level::Everyone) => seen.insert(name.clone(), Seen::Everyone),
            (false, _) => None,
        };
    }
    let note = |seen: &mut HashMap<String, Seen>, name: String, found: Seen| {
        let counts = levels.get(&name).is_some_and(|level| found.counts(*level));
        if counts && !seen.contains_key(&name) {
            seen.insert(name, found);
        }
    };
    let rest = |seen: &HashMap<String, Seen>| -> Vec<&String> {
        names.iter().filter(|n| !seen.contains_key(*n)).collect()
    };
    if let Some(me) = me {
        for (name, _) in among(
            db,
            "SELECT friend, '' FROM friends WHERE username = $1 AND friend IN ({in})",
            &[me],
            &rest(&seen),
        )
        .await?
        {
            note(&mut seen, name, Seen::Friend);
        }
        for (name, _) in among(
            db,
            "SELECT sender, '' FROM friend_requests WHERE recipient = $1 AND sender IN ({in})",
            &[me],
            &rest(&seen),
        )
        .await?
        {
            note(&mut seen, name, Seen::Incoming);
        }
        for (name, _) in among(
            db,
            "SELECT d.user_b, '' FROM dms d WHERE d.user_a = $1 AND d.user_b IN ({in}) AND EXISTS(SELECT 1 FROM messages m WHERE m.dm_id = d.id AND m.author = d.user_b) UNION SELECT d.user_a, '' FROM dms d WHERE d.user_b = $1 AND d.user_a IN ({in}) AND EXISTS(SELECT 1 FROM messages m WHERE m.dm_id = d.id AND m.author = d.user_a)",
            &[me],
            &rest(&seen),
        )
        .await?
        {
            note(&mut seen, name, Seen::Dm);
        }
        for (name, server) in among(
            db,
            "SELECT b.username, MIN(b.server) FROM members a JOIN members b ON b.server = a.server WHERE a.username = $1 AND b.username IN ({in}) GROUP BY b.username",
            &[me],
            &rest(&seen),
        )
        .await?
        {
            note(&mut seen, name, Seen::Common(server));
        }
    }
    match caller.server {
        Some(server) => {
            let access = allowed(resolve_server(db, server, caller.user, caller.proof).await)?;
            if let Some(access) = access.filter(shows_members) {
                for (name, _) in among(
                    db,
                    "SELECT username, '' FROM members WHERE server = $1 AND username IN ({in})",
                    &[access.name()],
                    &rest(&seen),
                )
                .await?
                {
                    note(&mut seen, name, Seen::Context(access.name().to_string()));
                }
            }
        }
        None if caller.user.is_none() => {
            let servers = granted_servers(db, caller.proof).await?;
            if !servers.is_empty() {
                let first: Vec<&str> = servers.iter().map(String::as_str).collect();
                let sql = format!(
                    "SELECT m.username, MIN(m.server) FROM members m JOIN servers s ON s.name = m.server WHERE m.server IN ({}) AND s.members_visible <> 0 AND m.username IN ({{in}}) GROUP BY m.username",
                    placeholders(1, servers.len())
                );
                for (name, server) in among(db, &sql, &first, &rest(&seen)).await? {
                    note(&mut seen, name, Seen::Context(server));
                }
            }
        }
        None => {}
    }
    if settings.profile_visibility >= Level::PublicServers {
        let sql = format!(
            "SELECT DISTINCT m.username, '' FROM members m JOIN servers s ON s.name = m.server WHERE m.username IN ({{in}}) AND {} AND s.members_visible <> 0",
            Reading::now(&state.db).await.readable_sql()
        );
        for (name, _) in among(db, &sql, &[], &rest(&seen)).await? {
            note(&mut seen, name, Seen::Public);
        }
    }
    if let Some((account, _)) = caller.badge.and_then(|badge| verify_binding(state, badge)) {
        note(&mut seen, account.to_lowercase(), Seen::Badge);
    }
    Ok(seen)
}

/// The most accounts `candidates` returns.
pub const CANDIDATES_MAX: usize = 10;
/// Rows each source of `candidates` reads.
const SOURCE_ROWS: i64 = 20;

/// The query for accounts whose display name starts with a text, by `idx_users_display_lower`.
fn display_sql(sqlite: bool) -> String {
    let col = match sqlite {
        true => "lower(display_name)",
        false => "(lower(display_name) COLLATE \"C\")",
    };
    format!(
        "SELECT username FROM users WHERE {col} >= $1 AND {col} < $2 AND password_hash <> '!purging' ORDER BY {col} LIMIT {SOURCE_ROWS}"
    )
}

async fn names_of(db: &Db, sql: &str, binds: &[&str]) -> Result<Vec<String>, ApiError> {
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()));
    for bind in binds {
        query = query.bind(*bind);
    }
    let rows = query.fetch_all(db).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(row.try_get(0)?);
    }
    Ok(out)
}

/// The user picker's search: up to `limit` (at most 10) accounts whose username or display
/// name starts with `q`, only ones `caller` may see. Members of the server the caller names
/// come first, then friends and people who sent a request, people the caller has a direct
/// conversation with, members of the caller's other servers, then everyone else; by username
/// within each. A named server the caller can't open is the gate's denial, and one that keeps
/// its members from the caller adds none of them and puts none first.
pub async fn candidates(
    state: &AppState,
    caller: &Caller<'_>,
    q: &str,
    limit: usize,
) -> Result<Vec<UserRef>, ApiError> {
    let db = &state.read();
    let q = q.trim().to_lowercase();
    let limit = limit.clamp(1, CANDIDATES_MAX);
    let context = match caller.server {
        Some(server) => Some(resolve_server(db, server, caller.user, caller.proof).await?),
        None => None,
    };
    let Some(end) = prefix_end(&q).filter(|_| !q.is_empty()) else {
        return Ok(Vec::new());
    };
    let sqlite = is_sqlite(db);
    let col = |column: &str| match sqlite {
        true => column.to_string(),
        false => format!("({column} COLLATE \"C\")"),
    };
    let (range, pattern) = ([q.as_str(), end.as_str()], prefix_pattern(&q));
    let like =
        "(lower(u.username) LIKE $2 ESCAPE '\\' OR lower(u.display_name) LIKE $2 ESCAPE '\\')";
    let mut sources: Vec<Vec<String>> = Vec::new();
    match context.as_ref().filter(|access| shows_members(access)) {
        Some(access) => {
            let (name, display) = (col("m.username"), col("lower(u.display_name)"));
            let by_name = format!(
                "SELECT m.username FROM members m WHERE m.server = $1 AND {name} >= $2 AND {name} < $3 ORDER BY {name} LIMIT {SOURCE_ROWS}"
            );
            let by_display = format!(
                "SELECT m.username FROM users u JOIN members m ON m.username = u.username AND m.server = $1 WHERE {display} >= $2 AND {display} < $3 ORDER BY {display}, m.username LIMIT {SOURCE_ROWS}"
            );
            let binds = [access.name(), q.as_str(), end.as_str()];
            let mut found = names_of(db, &by_name, &binds).await?;
            found.extend(names_of(db, &by_display, &binds).await?);
            sources.push(found);
        }
        None => sources.push(Vec::new()),
    }
    match caller.user.map(|u| u.username.as_str()) {
        Some(me) => {
            let related = format!(
                "SELECT f.friend FROM friends f JOIN users u ON u.username = f.friend WHERE f.username = $1 AND {like} UNION SELECT r.sender FROM friend_requests r JOIN users u ON u.username = r.sender WHERE r.recipient = $1 AND {like} ORDER BY 1 LIMIT {SOURCE_ROWS}"
            );
            let partners = format!(
                "SELECT d.user_b FROM dms d JOIN users u ON u.username = d.user_b WHERE d.user_a = $1 AND {like} UNION SELECT d.user_a FROM dms d JOIN users u ON u.username = d.user_a WHERE d.user_b = $1 AND {like} ORDER BY 1 LIMIT {SOURCE_ROWS}"
            );
            let name = col("b.username");
            let shared = format!(
                "SELECT DISTINCT b.username FROM members a JOIN members b ON b.server = a.server WHERE a.username = $1 AND {name} >= $2 AND {name} < $3 LIMIT {SOURCE_ROWS}"
            );
            sources.push(names_of(db, &related, &[me, &pattern]).await?);
            sources.push(names_of(db, &partners, &[me, &pattern]).await?);
            sources.push(names_of(db, &shared, &[me, q.as_str(), end.as_str()]).await?);
        }
        None => sources.extend([Vec::new(), Vec::new(), Vec::new()]),
    }
    let by_username = match sqlite {
        true => format!(
            "SELECT username FROM users WHERE username >= $1 AND username < $2 AND password_hash <> '!purging' ORDER BY username LIMIT {SOURCE_ROWS}"
        ),
        false => format!(
            "SELECT username FROM users WHERE lower(username) LIKE $1 ESCAPE '\\' AND password_hash <> '!purging' ORDER BY username LIMIT {SOURCE_ROWS}"
        ),
    };
    let mut anyone = match sqlite {
        true => names_of(db, &by_username, &range).await?,
        false => names_of(db, &by_username, &[&pattern]).await?,
    };
    anyone.extend(names_of(db, &display_sql(sqlite), &range).await?);
    sources.push(anyone);
    let mut rank: HashMap<String, usize> = HashMap::new();
    for (at, source) in sources.iter().enumerate() {
        for name in source {
            rank.entry(name.clone()).or_insert(at);
        }
    }
    let names = unique_capped(sources.into_iter().flatten());
    let seen = seen_among(state, caller, &names).await?;
    let open: Vec<&String> = names
        .iter()
        .filter(|name| matches!(seen.get(*name), Some(Seen::Public | Seen::Everyone)))
        .collect();
    let shared: Vec<String> = match caller.user {
        Some(me) => among(
            db,
            "SELECT DISTINCT b.username, '' FROM members a JOIN members b ON b.server = a.server WHERE a.username = $1 AND b.username IN ({in})",
            &[me.username.as_str()],
            &open,
        )
        .await?
        .into_iter()
        .map(|(name, _)| name)
        .collect(),
        None => Vec::new(),
    };
    let mut shown: Vec<(usize, String)> = names
        .into_iter()
        .filter_map(|name| {
            let by_proof = match seen.get(&name)? {
                Seen::Myself | Seen::Friend | Seen::Incoming => 1,
                Seen::Dm => 2,
                Seen::Common(_) | Seen::Context(_) | Seen::Badge => 3,
                Seen::Public | Seen::Everyone if shared.contains(&name) => 3,
                Seen::Public | Seen::Everyone => 4,
            };
            let by_source = rank.get(&name).copied().unwrap_or(4);
            Some((by_source.min(by_proof), name))
        })
        .collect();
    shown.sort();
    shown.truncate(limit);
    let names: Vec<String> = shown.iter().map(|(_, name)| name.clone()).collect();
    let refs = user_refs(db, &names).await;
    Ok(shown
        .iter()
        .map(|(_, name)| user_from(&refs, name))
        .collect())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use axum::http::StatusCode;

    use super::*;
    use crate::api::access::NOT_FOUND;
    use crate::api::instance::verify_binding;
    use crate::api::test_util::test_grant;
    use crate::api::test_util::{add_member, done, mem_user, pg_done, pg_state, temp_state};
    use crate::db::{NewUser, now};
    use crate::identity::{BINDING_AUD, BINDING_TTL_SECS, BindingClaims, InstanceKey, Keyring};

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    async fn add_user(db: &Db, name: &str, display: &str) {
        NewUser::plain(name).shown(display).at(1).add(db).await;
    }

    async fn add_server(db: &Db, name: &str, password: bool) {
        sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES($1, $1, NULL, $2, 0)")
            .bind(name)
            .bind(password.then_some("hash"))
            .execute(db)
            .await
            .expect("server");
    }

    async fn add_grant(db: &Db, grant: &str, server: &str, used: i64) {
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, $2, 1, $3)")
            .bind(crate::db::secret_key(&test_grant(grant)))
            .bind(server)
            .bind(used)
            .execute(db)
            .await
            .expect("grant");
    }

    async fn befriend(db: &Db, a: &str, b: &str) {
        for (x, y) in [(a, b), (b, a)] {
            sqlx::query("INSERT INTO friends(username, friend, created_at) VALUES($1, $2, 1)")
                .bind(x)
                .bind(y)
                .execute(db)
                .await
                .expect("friends");
        }
    }

    async fn request(db: &Db, sender: &str, recipient: &str) {
        sqlx::query("INSERT INTO friend_requests(sender, recipient, created_at) VALUES($1, $2, 1)")
            .bind(sender)
            .bind(recipient)
            .execute(db)
            .await
            .expect("request");
    }

    async fn open_dm(db: &Db, a: &str, b: &str) -> i64 {
        let (a, b) = match a <= b {
            true => (a, b),
            false => (b, a),
        };
        sqlx::query("INSERT INTO dms(user_a, user_b) VALUES($1, $2) RETURNING id")
            .bind(a)
            .bind(b)
            .fetch_one(db)
            .await
            .expect("dm")
            .try_get(0)
            .expect("dm id")
    }

    async fn write(db: &Db, dm: i64, author: &str) {
        sqlx::query(
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, $2, 'hi', 1)",
        )
        .bind(dm)
        .bind(author)
        .execute(db)
        .await
        .expect("message");
    }

    async fn set_level(db: &Db, level: &str) {
        sqlx::query("UPDATE settings SET value = $1 WHERE key = 'profile_visibility'")
            .bind(level)
            .execute(db)
            .await
            .expect("level");
        Settings::forget(db);
    }

    async fn set_choices(db: &Db, choices: &str) {
        sqlx::query("UPDATE settings SET value = $1 WHERE key = 'profile_choices'")
            .bind(choices)
            .execute(db)
            .await
            .expect("choices");
        Settings::forget(db);
    }

    async fn choose(db: &Db, user: &str, choice: Option<&str>) {
        sqlx::query("INSERT INTO privacy(username, profile) VALUES($1, $2) ON CONFLICT(username) DO UPDATE SET profile = excluded.profile")
            .bind(user)
            .bind(choice)
            .execute(db)
            .await
            .expect("choice");
    }

    fn binding(keys: &Keyring, name: &str, aud: &str, iat: i64, ttl: i64) -> String {
        keys.sign(&BindingClaims {
            iss: "http://localhost".to_string(),
            sub: format!("{name}@localhost"),
            aud: aud.to_string(),
            ik: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo".to_string(),
            iat,
            exp: iat + ttl,
            head: None,
        })
        .expect("sign")
    }

    fn badge_for(state: &AppState, name: &str) -> String {
        binding(
            &state.instance.keys,
            name,
            BINDING_AUD,
            now(),
            BINDING_TTL_SECS,
        )
    }

    /// Who asks, and what they show.
    #[derive(Clone, Copy, Debug)]
    struct Ask<'a> {
        who: Option<&'a str>,
        admin: bool,
        grant: Option<&'a str>,
        server: Option<&'a str>,
        badge: Option<&'a str>,
    }

    const NOBODY: Ask<'static> = Ask {
        who: None,
        admin: false,
        grant: None,
        server: None,
        badge: None,
    };

    fn by(who: &str) -> Ask<'_> {
        Ask {
            who: Some(who),
            ..NOBODY
        }
    }

    async fn look(state: &AppState, ask: Ask<'_>, name: &str) -> Result<SeenUser, ApiError> {
        let user = ask.who.map(|who| mem_user(who, ask.admin));
        let grants: Vec<String> = ask.grant.iter().map(|g| test_grant(g)).collect();
        let proof = Proof::grants(grants, &state.limits);
        let caller = Caller {
            user: user.as_ref(),
            proof: &proof,
            server: ask.server,
            badge: ask.badge,
        };
        resolve_user(state, &caller, name).await
    }

    async fn seen(state: &AppState, ask: Ask<'_>, name: &str) -> Option<Seen> {
        match look(state, ask, name).await {
            Ok(found) => {
                assert_eq!(found.user.username, name.to_lowercase());
                Some(found.seen)
            }
            Err(ApiError(code, text, reason)) => {
                assert_eq!(
                    (code, text.as_str(), reason),
                    (StatusCode::NOT_FOUND, NOT_FOUND, None),
                    "{ask:?} {name}"
                );
                None
            }
        }
    }

    /// The least open level at which a relationship shows an account.
    #[derive(Clone, Debug)]
    enum Want {
        Always(Seen),
        From(Level, Seen),
        OnlyEveryone,
        Never,
    }

    impl Want {
        fn at(&self, level: Level) -> Option<Seen> {
            match (self, level) {
                (Want::Always(Seen::Myself), _) => Some(Seen::Myself),
                (Want::Never, _) => None,
                (_, Level::Everyone) => Some(Seen::Everyone),
                (Want::Always(seen), _) => Some(seen.clone()),
                (Want::From(least, seen), level) if level >= *least => Some(seen.clone()),
                (Want::From(_, _) | Want::OnlyEveryone, _) => None,
            }
        }
    }

    /// alice has one relationship with each of friend, asker, writer and mate; she sent a request
    /// to sent and wrote alone in a DM with opened. pubber is in the public server plaza, local
    /// in the password server hush, and loner and badger in none. carol knows nobody, root is the
    /// site admin, and the grant `g-hush` opens hush.
    async fn world(db: &Db) {
        for name in [
            "alice", "carol", "root", "friend", "asker", "sent", "writer", "opened", "mate",
            "pubber", "local", "loner", "badger",
        ] {
            add_user(db, name, name).await;
        }
        exec(
            db,
            "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
        )
        .await;
        add_server(db, "plaza", false).await;
        add_server(db, "hush", true).await;
        add_server(db, "club", true).await;
        add_member(db, "club", "alice", 0, 0, 1).await;
        add_member(db, "club", "mate", 0, 0, 1).await;
        add_member(db, "plaza", "pubber", 0, 0, 1).await;
        add_member(db, "hush", "local", 0, 0, 1).await;
        befriend(db, "alice", "friend").await;
        request(db, "asker", "alice").await;
        request(db, "alice", "sent").await;
        let dm = open_dm(db, "alice", "writer").await;
        write(db, dm, "alice").await;
        write(db, dm, "writer").await;
        let dm = open_dm(db, "opened", "alice").await;
        write(db, dm, "alice").await;
        add_grant(db, "g-hush", "hush", now()).await;
    }

    #[tokio::test]
    async fn proofs_by_level() {
        let (state, path) = temp_state("subject_proofs").await;
        let db = &state.db;
        world(db).await;
        let badge = badge_for(&state, "badger");
        let alice = by("alice");
        let carol = by("carol");
        let root = Ask {
            admin: true,
            ..by("root")
        };
        let guest = Ask {
            grant: Some("g-hush"),
            ..NOBODY
        };
        let at = |ask: Ask<'static>, server: &'static str| Ask {
            server: Some(server),
            ..ask
        };
        let common = || Seen::Common("club".to_string());
        let context = |server: &str| Seen::Context(server.to_string());
        let shared = |seen: Seen| Want::From(Level::Shared, seen);
        let cases: Vec<(&str, Ask<'_>, &str, Want)> = vec![
            ("yourself", alice, "alice", Want::Always(Seen::Myself)),
            (
                "yourself, as written",
                alice,
                "Alice",
                Want::Always(Seen::Myself),
            ),
            ("a friend", alice, "friend", Want::Always(Seen::Friend)),
            (
                "a request to you",
                alice,
                "asker",
                Want::Always(Seen::Incoming),
            ),
            ("a DM they wrote in", alice, "writer", shared(Seen::Dm)),
            ("a common server", alice, "mate", shared(common())),
            (
                "a common server, named",
                at(alice, "club"),
                "mate",
                shared(common()),
            ),
            (
                "a public server, named",
                at(alice, "Plaza"),
                "pubber",
                shared(context("plaza")),
            ),
            (
                "a public server",
                alice,
                "pubber",
                Want::From(Level::PublicServers, Seen::Public),
            ),
            (
                "a password server you can't open",
                at(alice, "hush"),
                "local",
                Want::OnlyEveryone,
            ),
            (
                "their badge",
                Ask {
                    badge: Some(&badge),
                    ..alice
                },
                "badger",
                shared(Seen::Badge),
            ),
            (
                "someone else's badge",
                Ask {
                    badge: Some(&badge),
                    ..alice
                },
                "loner",
                Want::OnlyEveryone,
            ),
            ("nothing", alice, "loner", Want::OnlyEveryone),
            ("a request you sent", alice, "sent", Want::OnlyEveryone),
            (
                "a DM only you wrote in",
                alice,
                "opened",
                Want::OnlyEveryone,
            ),
            (
                "the site admin as a subject",
                alice,
                "root",
                Want::OnlyEveryone,
            ),
            ("no account", alice, "ghost", Want::Never),
            (
                "another account's friend",
                carol,
                "friend",
                Want::OnlyEveryone,
            ),
            (
                "another account's server",
                carol,
                "mate",
                Want::OnlyEveryone,
            ),
            (
                "a server you are not in, named",
                at(carol, "club"),
                "mate",
                Want::OnlyEveryone,
            ),
            (
                "signed in, a public server named",
                at(carol, "plaza"),
                "pubber",
                shared(context("plaza")),
            ),
            (
                "signed in, a public server",
                carol,
                "pubber",
                Want::From(Level::PublicServers, Seen::Public),
            ),
            (
                "a guest's grant, the server named",
                at(guest, "hush"),
                "local",
                shared(context("hush")),
            ),
            ("a guest's grant", guest, "local", shared(context("hush"))),
            (
                "a guest's grant for another server",
                guest,
                "mate",
                Want::OnlyEveryone,
            ),
            (
                "a guest with a grant, a public server named",
                at(guest, "plaza"),
                "pubber",
                shared(context("plaza")),
            ),
            (
                "a guest and a friend of alice",
                guest,
                "friend",
                Want::OnlyEveryone,
            ),
            (
                "no grant, a password server named",
                at(NOBODY, "hush"),
                "local",
                Want::OnlyEveryone,
            ),
            (
                "no grant, a public server named",
                at(NOBODY, "plaza"),
                "pubber",
                shared(context("plaza")),
            ),
            (
                "no grant, a public server",
                NOBODY,
                "pubber",
                Want::From(Level::PublicServers, Seen::Public),
            ),
            (
                "no token, their badge",
                Ask {
                    badge: Some(&badge),
                    ..NOBODY
                },
                "badger",
                shared(Seen::Badge),
            ),
            ("no token, nothing", NOBODY, "loner", Want::OnlyEveryone),
            ("no token, no account", NOBODY, "ghost", Want::Never),
            ("the site admin", root, "local", Want::OnlyEveryone),
            (
                "the site admin, the server named",
                at(root, "hush"),
                "local",
                shared(context("hush")),
            ),
            (
                "the site admin, a server they are not in",
                at(root, "hush"),
                "loner",
                Want::OnlyEveryone,
            ),
        ];
        let subjects = [
            "alice", "friend", "asker", "sent", "writer", "opened", "mate", "pubber", "local",
            "loner", "badger", "root",
        ];
        for (word, instance) in SITE_LEVELS {
            set_level(db, word).await;
            for (allowed, choices) in ALL_CHOICES {
                set_choices(db, allowed).await;
                for choice in OWN_CHOICES {
                    for subject in subjects {
                        choose(db, subject, choice).await;
                    }
                    let level = wanted_level(instance, choices, choice);
                    for (what, ask, name, want) in &cases {
                        assert_eq!(
                            seen(&state, *ask, name).await,
                            want.at(level),
                            "{what}: instance {word}, {allowed}, choice {choice:?}"
                        );
                    }
                }
            }
        }
        done(state, path).await;
    }

    #[test]
    fn the_effective_level_follows_the_choices() {
        for (_, site) in SITE_LEVELS {
            for (_, choices) in ALL_CHOICES {
                let settings = Settings {
                    profile_visibility: site,
                    profile_choices: choices,
                    ..Settings::DENY
                };
                for choice in OWN_CHOICES {
                    let want = wanted_level(site, choices, choice);
                    assert_eq!(
                        level_of(&settings, own_choice(choice)),
                        want,
                        "{site:?} {choices:?} {choice:?}"
                    );
                    if choice.is_none() {
                        assert_eq!(
                            level_of(&settings, Some(ProfilePolicy::Default)),
                            want,
                            "{site:?} {choices:?} default"
                        );
                    }
                }
            }
        }
        let wider = Settings {
            profile_visibility: Level::Shared,
            profile_choices: ProfileChoices::Any,
            ..Settings::DENY
        };
        assert_eq!(
            level_of(&wider, Some(ProfilePolicy::Everyone)),
            Level::Everyone,
            "a choice may be wider than the instance's level"
        );
    }

    #[tokio::test]
    async fn a_dm_counts_only_when_the_subject_wrote() {
        let (state, path) = temp_state("subject_dm").await;
        let db = &state.db;
        for name in ["alice", "zed"] {
            add_user(db, name, name).await;
        }
        assert_eq!(seen(&state, by("alice"), "zed").await, None);
        let dm = open_dm(db, "alice", "zed").await;
        assert_eq!(seen(&state, by("alice"), "zed").await, None, "an empty DM");
        write(db, dm, "alice").await;
        assert_eq!(
            seen(&state, by("alice"), "zed").await,
            None,
            "alice opened it and wrote alone"
        );
        assert_eq!(
            seen(&state, by("zed"), "alice").await,
            Some(Seen::Dm),
            "zed sees who wrote to them"
        );
        write(db, dm, "zed").await;
        assert_eq!(seen(&state, by("alice"), "zed").await, Some(Seen::Dm));
        exec(db, "DELETE FROM messages WHERE author = 'zed'").await;
        assert_eq!(
            seen(&state, by("alice"), "zed").await,
            None,
            "nothing is kept between requests"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_sent_request_does_not_count() {
        let (state, path) = temp_state("subject_sent").await;
        let db = &state.db;
        for name in ["alice", "zed"] {
            add_user(db, name, name).await;
        }
        request(db, "alice", "zed").await;
        assert_eq!(seen(&state, by("alice"), "zed").await, None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn an_incoming_request_does() {
        let (state, path) = temp_state("subject_incoming").await;
        let db = &state.db;
        for name in ["alice", "zed"] {
            add_user(db, name, name).await;
        }
        request(db, "zed", "alice").await;
        assert_eq!(seen(&state, by("alice"), "zed").await, Some(Seen::Incoming));
        choose(db, "zed", Some("friends")).await;
        assert_eq!(
            seen(&state, by("alice"), "zed").await,
            Some(Seen::Incoming),
            "also for an account that shows itself to friends only"
        );
        exec(db, "DELETE FROM friend_requests").await;
        assert_eq!(seen(&state, by("alice"), "zed").await, None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn guests_prove_with_grants() {
        let (state, path) = temp_state("subject_grants").await;
        let db = &state.db;
        for name in ["zed", "pat", "out"] {
            add_user(db, name, name).await;
        }
        add_server(db, "hush", true).await;
        add_server(db, "plaza", false).await;
        add_server(db, "other", true).await;
        add_member(db, "hush", "zed", 0, 0, 1).await;
        add_member(db, "plaza", "pat", 0, 0, 1).await;
        add_member(db, "other", "out", 0, 0, 1).await;
        add_grant(db, "live", "hush", now()).await;
        add_grant(db, "old", "hush", 1).await;
        let with = |grant: &'static str, server: Option<&'static str>| Ask {
            grant: Some(grant),
            server,
            ..NOBODY
        };
        let hush = || Some(Seen::Context("hush".to_string()));
        assert_eq!(
            seen(&state, with("live", Some("hush")), "zed").await,
            hush()
        );
        assert_eq!(seen(&state, with("live", None), "zed").await, hush());
        assert_eq!(
            seen(&state, with("live", Some("HUSH")), "zed").await,
            hush()
        );
        assert_eq!(seen(&state, with("old", Some("hush")), "zed").await, None);
        assert_eq!(seen(&state, with("old", None), "zed").await, None);
        assert_eq!(seen(&state, with("unknown", None), "zed").await, None);
        assert_eq!(seen(&state, NOBODY, "zed").await, None);
        assert_eq!(
            seen(&state, with("live", None), "out").await,
            None,
            "a grant shows only its server's members"
        );
        assert_eq!(
            seen(&state, with("live", Some("other")), "out").await,
            None,
            "a grant for another server"
        );
        assert_eq!(
            seen(&state, with("live", Some("plaza")), "zed").await,
            None,
            "the named server is the one that counts"
        );
        let named = Ask {
            server: Some("plaza"),
            ..NOBODY
        };
        let plaza = || Some(Seen::Context("plaza".to_string()));
        assert_eq!(seen(&state, named, "pat").await, plaza());
        assert_eq!(seen(&state, NOBODY, "pat").await, None, "not named");
        choose(db, "pat", Some("shared")).await;
        assert_eq!(seen(&state, named, "pat").await, plaza());
        choose(db, "pat", Some("friends")).await;
        assert_eq!(
            seen(&state, named, "pat").await,
            None,
            "a public server named counts at shared and up"
        );
        choose(db, "zed", Some("friends")).await;
        assert_eq!(seen(&state, with("live", Some("hush")), "zed").await, None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn badges_prove_one_subject() {
        let (state, path) = temp_state("subject_badges").await;
        let db = &state.db;
        for name in ["alice", "zed", "yan"] {
            add_user(db, name, name).await;
        }
        let keys = &state.instance.keys;
        let good = badge_for(&state, "zed");
        assert_eq!(
            verify_binding(&state, &good),
            Some(("zed".to_string(), "localhost".to_string()))
        );
        let shows = |badge: String| Ask {
            badge: Some(Box::leak(badge.into_boxed_str())),
            ..by("alice")
        };
        assert_eq!(
            seen(&state, shows(good.clone()), "zed").await,
            Some(Seen::Badge)
        );
        assert_eq!(
            seen(&state, shows(good.clone()), "ZED").await,
            Some(Seen::Badge)
        );
        assert_eq!(
            seen(&state, shows(good.clone()), "yan").await,
            None,
            "a badge shows its own account only"
        );
        assert_eq!(
            seen(
                &state,
                Ask {
                    who: None,
                    ..shows(good.clone())
                },
                "zed"
            )
            .await,
            Some(Seen::Badge),
            "without a token too"
        );
        assert_eq!(seen(&state, by("alice"), "zed").await, None, "no badge");
        let t = now();
        let other = Keyring::new(vec![
            InstanceKey::from_seed(&crate::identity::new_seed()).expect("key"),
        ])
        .expect("keyring");
        let mut cut = good.clone();
        cut.pop();
        for (what, bad) in [
            (
                "expired",
                binding(
                    keys,
                    "zed",
                    BINDING_AUD,
                    t - BINDING_TTL_SECS - 1,
                    BINDING_TTL_SECS,
                ),
            ),
            (
                "signed by another key",
                binding(&other, "zed", BINDING_AUD, t, BINDING_TTL_SECS),
            ),
            (
                "for another audience",
                binding(keys, "zed", "rchat", t, BINDING_TTL_SECS),
            ),
            (
                "longer lived than a binding",
                binding(keys, "zed", BINDING_AUD, t, BINDING_TTL_SECS + 1),
            ),
            ("cut short", cut),
            ("not a token", "zed".to_string()),
            ("empty", String::new()),
        ] {
            assert_eq!(verify_binding(&state, &bad), None, "{what}");
            assert_eq!(seen(&state, shows(bad), "zed").await, None, "{what}");
        }
        choose(db, "zed", Some("friends")).await;
        assert_eq!(
            seen(&state, shows(good), "zed").await,
            None,
            "a badge counts at shared and up"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_named_server_gives_the_membership() {
        let (state, path) = temp_state("subject_member").await;
        let db = &state.db;
        for name in ["alice", "zed", "pal"] {
            add_user(db, name, name).await;
        }
        add_server(db, "plaza", false).await;
        add_server(db, "hush", true).await;
        add_member(db, "plaza", "zed", 0, 0, 1).await;
        add_member(db, "hush", "zed", 0, 0, 1).await;
        befriend(db, "alice", "pal").await;
        befriend(db, "alice", "zed").await;
        let named = |server: &'static str| Ask {
            server: Some(server),
            ..by("alice")
        };
        let found = look(&state, named("plaza"), "zed").await.expect("zed");
        assert_eq!(found.seen, Seen::Friend, "the first proof that holds");
        assert_eq!(
            found.member.as_ref().map(|access| access.name()),
            Some("plaza")
        );
        let found = look(&state, by("alice"), "zed").await.expect("zed");
        assert!(found.member.is_none(), "no server was named");
        let found = look(&state, named("hush"), "zed").await.expect("zed");
        assert!(found.member.is_none(), "alice can't open hush");
        let found = look(&state, named("plaza"), "pal").await.expect("pal");
        assert!(found.member.is_none(), "pal is not a member there");
        let found = look(&state, named("nowhere"), "zed").await.expect("zed");
        assert!(found.member.is_none());
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_public_server_is_one_the_gate_opens_by_name() {
        use crate::api::access::Via;
        let (state, path) = temp_state("subject_public").await;
        let db = &state.db;
        set_level(db, "public_servers").await;
        let servers = [
            ("plaza", None, None, "pat"),
            ("hush", Some("hash"), None, "hal"),
            ("going", Some("!purging"), None, "gil"),
            ("vault", Some("hash"), Some(1), "val"),
            ("shut", None, Some(0), "sid"),
        ];
        for (server, password, public_read, member) in servers {
            sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, public_read, created_at) VALUES($1, $1, NULL, $2, $3, 0)")
                .bind(server)
                .bind(password)
                .bind(public_read)
                .execute(db)
                .await
                .expect("server");
            add_user(db, member, member).await;
            add_member(db, server, member, 0, 0, 1).await;
        }
        let names: Vec<String> = servers.iter().map(|s| s.3.to_string()).collect();
        let proof = Proof::none();
        let nobody = Caller {
            user: None,
            proof: &proof,
            server: None,
            badge: None,
        };
        for (reading, joining, readable) in [
            ("1", "everyone", vec!["plaza", "vault"]),
            ("1", "invites", vec!["vault"]),
            ("1", "nobody", vec!["vault"]),
            ("0", "everyone", vec![]),
        ] {
            for (key, value) in [("public_reading", reading), ("server_joining", joining)] {
                sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                    .bind(key)
                    .bind(value)
                    .execute(db)
                    .await
                    .expect("control");
            }
            Settings::forget(db);
            let batch = seen_among(&state, &nobody, &names).await.expect("batch");
            for (server, _, _, member) in servers {
                let by_name = resolve_server(db, server, None, &Proof::none())
                    .await
                    .is_ok_and(|access| access.via() == Via::Public);
                let at = format!("{server} with public reading {reading}, joining {joining}");
                assert_eq!(by_name, readable.contains(&server), "{at}");
                assert_eq!(
                    seen(&state, NOBODY, member).await == Some(Seen::Public),
                    by_name,
                    "{at}"
                );
                assert_eq!(batch.get(member) == Some(&Seen::Public), by_name, "{at}");
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn misses_are_uniform() {
        let (state, path) = temp_state("subject_misses").await;
        let db = &state.db;
        world(db).await;
        choose(db, "mate", Some("friends")).await;
        choose(db, "pubber", Some("friends")).await;
        let badge = badge_for(&state, "badger");
        let miss = |ask: Ask<'static>, name: &'static str| {
            let state = state.clone();
            async move {
                checks_run();
                let ApiError(code, text, reason) = look(&state, ask, name)
                    .await
                    .err()
                    .unwrap_or_else(|| panic!("{name} is hidden from {ask:?}"));
                (code, text, reason, checks_run())
            }
        };
        let badge: &'static str = Box::leak(badge.into_boxed_str());
        let alice = by("alice");
        let asks = [
            alice,
            Ask {
                server: Some("plaza"),
                ..alice
            },
            Ask {
                server: Some("hush"),
                ..alice
            },
            Ask {
                server: Some("nowhere"),
                ..alice
            },
            Ask {
                badge: Some(badge),
                ..alice
            },
            NOBODY,
            Ask {
                grant: Some("g-hush"),
                ..NOBODY
            },
            Ask {
                grant: Some("g-hush"),
                server: Some("hush"),
                ..NOBODY
            },
            Ask {
                server: Some("plaza"),
                ..NOBODY
            },
            Ask {
                admin: true,
                server: Some("hush"),
                ..by("root")
            },
        ];
        for word in ["shared", "public_servers", "everyone"] {
            set_level(db, word).await;
            for ask in asks {
                let unknown = miss(ask, "ghost").await;
                assert_eq!(unknown.0, StatusCode::NOT_FOUND);
                assert_eq!(unknown.1, NOT_FOUND);
                assert_eq!(unknown.2, None, "a miss has no reason");
                assert!(!unknown.3.is_empty(), "the checks ran: {ask:?}");
                for hidden in ["mate", "pubber"] {
                    assert_eq!(
                        miss(ask, hidden).await,
                        unknown,
                        "{hidden} from {ask:?} at {word}"
                    );
                }
                if word == "shared" && ask.badge.is_none() {
                    for hidden in ["loner", "sent", "opened", "badger"] {
                        assert_eq!(
                            miss(ask, hidden).await,
                            unknown,
                            "{hidden} from {ask:?} at {word}"
                        );
                    }
                }
            }
        }
        set_level(db, "shared").await;
        let (_, _, _, signed_in) = miss(alice, "ghost").await;
        assert_eq!(signed_in, ["account", "friend", "incoming", "dm", "common"]);
        let (_, _, _, guest) = miss(NOBODY, "ghost").await;
        assert_eq!(guest, ["account"]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn seen_among_matches_resolve_user() {
        let (state, path) = temp_state("subject_batch").await;
        let db = &state.db;
        world(db).await;
        let mut names: Vec<String> = [
            "alice", "friend", "asker", "sent", "writer", "opened", "mate", "pubber", "local",
            "loner", "badger", "root", "carol", "ghost", "Friend",
        ]
        .iter()
        .map(|n| n.to_string())
        .collect();
        for n in 0..85 {
            let name = format!("extra{n:02}");
            add_user(db, &name, &name).await;
            match n % 5 {
                0 => add_member(db, "club", &name, 0, 0, 1).await,
                1 => add_member(db, "plaza", &name, 0, 0, 1).await,
                2 => befriend(db, "alice", &name).await,
                3 => choose(db, &name, Some("friends")).await,
                _ => choose(db, &name, Some("everyone")).await,
            }
            if n % 7 == 0 {
                choose(db, &name, Some("shared")).await;
            }
            names.push(name);
        }
        assert_eq!(names.len(), 100);
        let badge: &'static str = Box::leak(badge_for(&state, "badger").into_boxed_str());
        let alice = by("alice");
        let asks = [
            alice,
            Ask {
                server: Some("plaza"),
                ..alice
            },
            Ask {
                server: Some("hush"),
                ..alice
            },
            Ask {
                badge: Some(badge),
                ..alice
            },
            by("carol"),
            NOBODY,
            Ask {
                grant: Some("g-hush"),
                ..NOBODY
            },
            Ask {
                grant: Some("g-hush"),
                server: Some("plaza"),
                ..NOBODY
            },
            Ask {
                admin: true,
                server: Some("hush"),
                ..by("root")
            },
        ];
        for word in ["shared", "public_servers", "everyone"] {
            set_level(db, word).await;
            for (allowed, _) in ALL_CHOICES {
                set_choices(db, allowed).await;
                for ask in asks {
                    let user = ask.who.map(|who| mem_user(who, ask.admin));
                    let grants: Vec<String> = ask.grant.iter().map(|g| test_grant(g)).collect();
                    let proof = Proof::grants(grants, &state.limits);
                    let caller = Caller {
                        user: user.as_ref(),
                        proof: &proof,
                        server: ask.server,
                        badge: ask.badge,
                    };
                    let batch = seen_among(&state, &caller, &names).await.expect("batch");
                    let mut shown = std::collections::HashSet::new();
                    for name in &names {
                        let single = seen(&state, ask, name).await;
                        assert_eq!(
                            batch.get(&name.to_lowercase()),
                            single.as_ref(),
                            "{name} from {ask:?} at {word}, {allowed}"
                        );
                        if single.is_some() {
                            shown.insert(name.to_lowercase());
                        }
                    }
                    assert_eq!(
                        batch.len(),
                        shown.len(),
                        "nobody else: {ask:?} at {word}, {allowed}"
                    );
                }
            }
        }
        let proof = Proof::none();
        let caller = Caller {
            user: None,
            proof: &proof,
            server: None,
            badge: None,
        };
        let many: Vec<String> = (0..150).map(|n| format!("extra{n:02}")).collect();
        set_level(db, "everyone").await;
        let capped = seen_among(&state, &caller, &many).await.expect("batch");
        assert!(capped.len() <= 100, "at most 100 names are looked at");
        assert!(
            seen_among(&state, &caller, &[])
                .await
                .expect("empty")
                .is_empty()
        );
        done(state, path).await;
    }

    async fn heavy(db: &Db) {
        for name in ["alice", "zed"] {
            add_user(db, name, name).await;
        }
        for (prefix, member) in [("a", "alice"), ("z", "zed")] {
            let servers = format!(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO servers(name, display_name, creator, password_hash, created_at) SELECT '{prefix}' || i, 'S', NULL, 'hash', 0 FROM n"
            );
            exec(db, &servers).await;
            let members = format!(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO members(server, username, is_admin, perms, joined_at) SELECT '{prefix}' || i, '{member}', 0, 0, 1 FROM n"
            );
            exec(db, &members).await;
        }
    }

    /// 100 lookups of an account that shares none of the caller's 1,000 servers: the common
    /// server check reads all of them. The fastest of three rounds counts, and the bounds sit
    /// well above what a loaded machine measured (5.7 ms on SQLite, 7.3 ms on Postgres). The
    /// target is under 5 ms on SQLite.
    async fn hundred_checks(state: &AppState) -> Duration {
        let mut best = Duration::MAX;
        for _ in 0..3 {
            let started = Instant::now();
            for _ in 0..100 {
                assert_eq!(seen(state, by("alice"), "zed").await, None);
            }
            best = best.min(started.elapsed());
        }
        best
    }

    #[tokio::test]
    async fn common_server_check_is_fast() {
        const EACH: Duration = Duration::from_millis(25);
        const EACH_ON_POSTGRES: Duration = Duration::from_millis(60);
        let (state, path) = temp_state("subject_heavy").await;
        heavy(&state.db).await;
        let took = hundred_checks(&state).await;
        eprintln!("common server check, sqlite: {:?} each", took / 100);
        assert!(took < EACH * 100, "sqlite: {took:?} for 100 checks");
        add_member(&state.db, "a1000", "zed", 0, 0, 1).await;
        assert_eq!(
            seen(&state, by("alice"), "zed").await,
            Some(Seen::Common("a1000".to_string()))
        );
        done(state, path).await;
        if let Some((state, temp)) = pg_state("subject_heavy").await {
            heavy(&state.db).await;
            exec(&state.db, "ANALYZE members").await;
            let took = hundred_checks(&state).await;
            eprintln!("common server check, postgres: {:?} each", took / 100);
            assert!(
                took < EACH_ON_POSTGRES * 100,
                "postgres: {took:?} for 100 checks"
            );
            pg_done(state, temp).await;
        }
    }

    async fn found(state: &AppState, ask: Ask<'_>, q: &str, limit: usize) -> Vec<String> {
        let user = ask.who.map(|who| mem_user(who, ask.admin));
        let grants: Vec<String> = ask.grant.iter().map(|g| test_grant(g)).collect();
        let proof = Proof::grants(grants, &state.limits);
        let caller = Caller {
            user: user.as_ref(),
            proof: &proof,
            server: ask.server,
            badge: ask.badge,
        };
        candidates(state, &caller, q, limit)
            .await
            .expect("candidates")
            .into_iter()
            .map(|user| user.username)
            .collect()
    }

    async fn batch(state: &AppState, ask: Ask<'_>, names: &[&str]) -> HashMap<String, Seen> {
        let user = ask.who.map(|who| mem_user(who, ask.admin));
        let grants: Vec<String> = ask.grant.iter().map(|g| test_grant(g)).collect();
        let proof = Proof::grants(grants, &state.limits);
        let caller = Caller {
            user: user.as_ref(),
            proof: &proof,
            server: ask.server,
            badge: ask.badge,
        };
        let names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        seen_among(state, &caller, &names).await.expect("batch")
    }

    /// zed is in the public server town and the password server vault; alice is in town too,
    /// carol in nothing; the grant `g-vault` opens vault and root is the site admin.
    #[tokio::test]
    async fn member_privacy_keeps_members_to_their_server() {
        let (state, path) = temp_state("subject_member_privacy").await;
        let db = &state.db;
        for name in ["alice", "carol", "root", "zed"] {
            add_user(db, name, name).await;
        }
        exec(
            db,
            "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
        )
        .await;
        add_server(db, "town", false).await;
        add_server(db, "vault", true).await;
        for (server, name) in [("town", "alice"), ("town", "zed"), ("vault", "zed")] {
            add_member(db, server, name, 0, 0, 1).await;
        }
        add_grant(db, "g-vault", "vault", now()).await;
        let alice = by("alice");
        let carol = by("carol");
        let at = |ask: Ask<'static>, server: &'static str| Ask {
            server: Some(server),
            ..ask
        };
        let guest = Ask {
            grant: Some("g-vault"),
            ..NOBODY
        };
        let root = Ask {
            admin: true,
            ..by("root")
        };
        let common = Seen::Common("town".to_string());
        let context = |server: &str| Some(Seen::Context(server.to_string()));
        // (what, ask, the server it goes through, the level, shown while on)
        let cases: Vec<(&str, Ask<'_>, &str, &str, Option<Seen>)> = vec![
            (
                "a member of town",
                alice,
                "town",
                "shared",
                Some(common.clone()),
            ),
            (
                "a member of town, town named",
                at(alice, "town"),
                "town",
                "shared",
                Some(common.clone()),
            ),
            (
                "signed in, town named",
                at(carol, "town"),
                "town",
                "shared",
                context("town"),
            ),
            (
                "signed in, public servers",
                carol,
                "town",
                "public_servers",
                Some(Seen::Public),
            ),
            (
                "a guest, town named",
                at(NOBODY, "town"),
                "town",
                "shared",
                context("town"),
            ),
            (
                "a guest's grant",
                guest,
                "vault",
                "shared",
                context("vault"),
            ),
            (
                "a guest's grant, vault named",
                at(guest, "vault"),
                "vault",
                "shared",
                context("vault"),
            ),
            (
                "the site admin, vault named",
                at(root, "vault"),
                "vault",
                "shared",
                context("vault"),
            ),
        ];
        for (what, ask, through, level, on) in &cases {
            set_level(db, level).await;
            for visible in [1, 0] {
                for server in ["town", "vault"] {
                    sqlx::query("UPDATE servers SET members_visible = $1 WHERE name = $2")
                        .bind(match server == *through {
                            true => visible,
                            false => 0,
                        })
                        .bind(server)
                        .execute(db)
                        .await
                        .expect("option");
                }
                let members = Some(Seen::Common("town".to_string()));
                let want = match (visible, on) {
                    (1, _) => on.clone(),
                    (_, seen) if *seen == members => seen.clone(),
                    (_, _) => None,
                };
                assert_eq!(
                    seen(&state, *ask, "zed").await,
                    want,
                    "{what}, {through} shows members: {visible}"
                );
                assert_eq!(
                    batch(&state, *ask, &["zed"]).await.get("zed"),
                    want.as_ref(),
                    "{what}, batch, {through} shows members: {visible}"
                );
                let searched = found(&state, *ask, "ze", 10).await;
                assert_eq!(
                    searched.contains(&"zed".to_string()),
                    want.is_some(),
                    "{what}, search, {through} shows members: {visible}"
                );
                choose(db, "zed", Some("everyone")).await;
                assert_eq!(
                    seen(&state, *ask, "zed").await,
                    Some(Seen::Everyone),
                    "{what}: zed's own everyone still applies"
                );
                choose(db, "zed", None).await;
            }
        }
        exec(db, "UPDATE servers SET members_visible = 0").await;
        set_level(db, "shared").await;
        let user = mem_user("carol", false);
        let proof = Proof::none();
        let caller = Caller {
            user: Some(&user),
            proof: &proof,
            server: Some("town"),
            badge: None,
        };
        assert!(
            view_user(&state, &caller, "zed").await.is_err(),
            "nor the membership, as town lists its members only to them"
        );
        let root = mem_user("root", true);
        let staff = Caller {
            user: Some(&root),
            ..caller
        };
        let view = view_user(&state, &staff, "zed")
            .await
            .expect("the site admin sees the membership, as in the member list");
        assert_eq!(view.seen, None, "but no profile");
        assert!(view.member.is_some());
        done(state, path).await;
    }

    #[tokio::test]
    async fn candidates_are_people_the_caller_may_see() {
        let (state, path) = temp_state("subject_candidates").await;
        let db = &state.db;
        for (name, display) in [
            ("alice", "Alice"),
            ("zara", "Zara"),
            ("zeb", "Zeb"),
            ("zed", "Zed"),
            ("zoe", "Zoe"),
            ("zip", "Zip"),
            ("zulu", "Zulu"),
            ("zack", "Zack"),
            ("bob", "Zorro"),
            ("yan", "zen master"),
        ] {
            add_user(db, name, display).await;
        }
        add_server(db, "club", true).await;
        add_server(db, "den", true).await;
        add_server(db, "plaza", false).await;
        add_member(db, "club", "alice", 0, 0, 1).await;
        add_member(db, "den", "alice", 0, 0, 1).await;
        add_member(db, "club", "zara", 0, 0, 1).await;
        add_member(db, "den", "zeb", 0, 0, 1).await;
        add_member(db, "den", "bob", 0, 0, 1).await;
        add_member(db, "plaza", "zip", 0, 0, 1).await;
        befriend(db, "alice", "zed").await;
        let dm = open_dm(db, "alice", "zoe").await;
        write(db, dm, "zoe").await;
        request(db, "zulu", "alice").await;
        let alice = by("alice");
        let in_den = Ask {
            server: Some("den"),
            ..alice
        };
        set_level(db, "shared").await;
        assert_eq!(
            found(&state, alice, "z", 10).await,
            ["zed", "zulu", "zoe", "bob", "zara", "zeb"],
            "friends and requests, DM partners, then shared servers; never zack, zip or yan"
        );
        assert_eq!(
            found(&state, in_den, "z", 10).await,
            ["bob", "zeb", "zed", "zulu", "zoe", "zara"],
            "the named server's members first"
        );
        assert_eq!(found(&state, alice, "ZE", 10).await, ["zed", "zeb"]);
        assert_eq!(found(&state, alice, "zo", 10).await, ["zoe", "bob"]);
        assert_eq!(found(&state, alice, "zorro", 10).await, ["bob"]);
        assert_eq!(found(&state, alice, "zack", 10).await, Vec::<String>::new());
        assert_eq!(found(&state, alice, "zip", 10).await, Vec::<String>::new());
        assert_eq!(found(&state, alice, "z", 2).await, ["zed", "zulu"]);
        assert_eq!(found(&state, alice, "z", 50).await.len(), 6, "at most 10");
        assert_eq!(found(&state, alice, "al", 10).await, ["alice"], "yourself");
        assert_eq!(found(&state, alice, "%", 10).await, Vec::<String>::new());
        assert_eq!(found(&state, alice, "_", 10).await, Vec::<String>::new());
        choose(db, "zara", Some("friends")).await;
        assert_eq!(
            found(&state, alice, "za", 10).await,
            Vec::<String>::new(),
            "a hidden member is left out"
        );
        choose(db, "zara", None).await;
        set_level(db, "public_servers").await;
        assert_eq!(
            found(&state, alice, "z", 10).await,
            ["zed", "zulu", "zoe", "bob", "zara", "zeb", "zip"]
        );
        set_level(db, "everyone").await;
        assert_eq!(
            found(&state, alice, "z", 10).await,
            [
                "zed", "zulu", "zoe", "bob", "zara", "zeb", "yan", "zack", "zip"
            ],
            "the same order (bob, found by his display name, still by the shared server), then everyone else by name"
        );
        set_level(db, "shared").await;
        let guest = Ask {
            server: Some("plaza"),
            ..NOBODY
        };
        assert_eq!(found(&state, guest, "z", 10).await, ["zip"]);
        assert_eq!(found(&state, NOBODY, "z", 10).await, Vec::<String>::new());
        let hidden_server = Ask {
            server: Some("club"),
            ..NOBODY
        };
        let proof = Proof::none();
        let caller = Caller {
            user: None,
            proof: &proof,
            server: hidden_server.server,
            badge: None,
        };
        let ApiError(code, text, reason) = candidates(&state, &caller, "z", 10)
            .await
            .expect_err("a server the caller can't open");
        assert_eq!(
            (code, text.as_str(), reason),
            (StatusCode::NOT_FOUND, crate::api::access::DENIED, None)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_dm_proof_and_the_name_search_use_their_indexes() {
        let (state, path) = temp_state("subject_indexes").await;
        let db = &state.db;
        let plan = |sql: String, binds: Vec<&'static str>| async move {
            let mut query = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")));
            for bind in binds {
                query = query.bind(bind);
            }
            query
                .fetch_all(db)
                .await
                .expect("plan")
                .iter()
                .map(|r| r.try_get::<String, _>(3).expect("detail"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let dm = plan(DM_SQL.to_string(), vec!["alice", "zed", "zed"]).await;
        assert!(dm.contains("idx_messages_dm_author"), "{dm}");
        let common = plan(COMMON_SQL.to_string(), vec!["alice", "zed"]).await;
        assert!(common.contains("idx_members_user_joined"), "{common}");
        let public = plan(public_sql(Reading::now(db).await), vec!["zed"]).await;
        assert!(public.contains("idx_members_user_joined"), "{public}");
        let names = plan(display_sql(true), vec!["z", "zz"]).await;
        assert!(names.contains("idx_users_display_lower"), "{names}");
        done(state, path).await;
    }
}
