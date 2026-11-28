use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::time::Instant;

use axum::http::{HeaderMap, StatusCode};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

use crate::api::audit::Actor;
use crate::api::auth::{Work, derive_key, dummy_hash, verify_in};
use crate::api::budget::{self, Backoff, slow_down};
use crate::api::join_modes::{join_mode_of, legacy_mode};
use crate::api::policy::ServerJoining;
use crate::api::profiles::ProfilesMode;
use crate::api::{ApiError, Channel, ServerSummaryLite, header_grants, staff_audit};
use crate::db::{ChannelKind, Db, LIVE_AUTHOR, LIVE_DM, MediaKind, User, now, pool_key};
use crate::limits::Limits;
use crate::limits::bucket::{Keyed, Policy};
use crate::ws::UserScope;

#[cfg(test)]
mod bit_gates_tests;
pub mod members;
#[cfg(test)]
mod members_tests;
pub mod overwrite_sql;
#[cfg(test)]
mod overwrite_tests;
pub mod perms;
pub mod ranks;
mod rules;
pub mod subjects;
#[cfg(test)]
pub(crate) mod subjects_walk;

use overwrite_sql::{denied_to_some_sql, everyone_stage_sql, overwrite_sql, private_sql};
use perms::{
    ChannelAccess, Perm, PermRow, Restrict, Standing, VISITOR_CAPS, bit_name, can_grant,
    channel_mask, everyone_mask, held, perm_columns, perm_row,
};
use rchat_perms::hier::{self, Rank, Tier};
use rchat_perms::{Mask, masks};
use rules::{
    channel_access, channel_access_of, channel_viewable, channel_viewers, effective_perms,
    grants_open, is_banned, live_grant_servers, member_masks, member_perms, server_everyone,
    standing, view_rules, view_under,
};
pub use subjects::{
    Caller, Level, Seen, SeenUser, UserView, candidates, level_of, resolve_user, seen_among,
    view_user,
};

pub const DENIED: &str = "Server not found or wrong password";
pub const PASSWORD_REQUIRED: &str = "Password required";
pub const NOT_FOUND: &str = "Not found";
pub const BANNED: &str = "You are banned from this server";
pub const TIMED_OUT: &str = "You are timed out in this server";

pub fn denied() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, DENIED.to_string(), None)
}

pub fn password_required() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        PASSWORD_REQUIRED.to_string(),
        None,
    )
}

pub fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, NOT_FOUND.to_string(), None)
}

/// What a timed-out member keeps of their server permissions.
pub const TIMED_OUT_KEEP: i64 = masks::TIMED_OUT_KEEP as i64;

/// Who `user` acts as on `target` inside a server: on themselves a site admin has only their
/// plain membership, never instance powers, so whatever they do to themselves (lifting their
/// own timeout, granting themselves admin or roles, setting channel rules for themselves) works
/// and is logged exactly as for any member, and shows nothing about them.
pub fn acting_on(user: &User, target: &str) -> User {
    User {
        is_site_admin: user.is_site_admin && user.username != target,
        ..user.clone()
    }
}

/// A member's right to change their own profile in a server. Only
/// `ServerAccess::change_profile` makes one.
pub struct ProfileRight {
    server: String,
    username: String,
}

impl ProfileRight {
    pub fn server(&self) -> &str {
        &self.server
    }

    pub fn username(&self) -> &str {
        &self.username
    }
}

pub fn timed_out_error() -> ApiError {
    ApiError::locked_by(TIMED_OUT, "timeout", None)
}

/// When the timeout of `username` in `server` ends (unix seconds), if they are timed out right
/// now. Expiry is time-based: a row whose `until` has passed counts as no timeout.
pub async fn timed_out<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    server: &str,
    username: &str,
) -> Result<Option<i64>, ApiError> {
    Ok(sqlx::query(
        "SELECT until FROM member_timeouts WHERE server = $1 AND username = $2 AND until > $3",
    )
    .bind(server)
    .bind(username)
    .bind(now())
    .fetch_optional(db)
    .await?
    .map(|r| r.try_get(0))
    .transpose()?)
}

fn banned() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, BANNED.to_string(), None)
}

fn hidden(e: ApiError) -> ApiError {
    match e.failed() {
        true => e,
        false => not_found(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    /// Anyone may read the server by its name.
    Public,
    Member,
    Password,
    Grant,
    Staff,
    /// An account at the join step of a server anyone may join by its name but only members
    /// read: it may join, and sees nothing of the server before it has.
    Joinable,
    Managed,
}

#[derive(Clone, Copy)]
enum Slot<'a> {
    Closed,
    Open(Option<&'a str>),
}

/// What a request shows to get into a server: a password, and guest grants that live as long as
/// the `GUEST_GRANT_DAYS` of the state that checks them.
pub struct Proof<'a> {
    managed: bool,
    password: Slot<'a>,
    grants: Vec<String>,
    grant_ttl: i64,
}

impl<'a> Proof<'a> {
    pub fn none() -> Proof<'static> {
        Proof {
            managed: false,
            password: Slot::Closed,
            grants: Vec::new(),
            grant_ttl: 0,
        }
    }

    pub(crate) fn managed(_: &crate::sso::groups::GroupJoin) -> Proof<'static> {
        Proof {
            managed: true,
            ..Self::none()
        }
    }

    pub fn grants(grants: Vec<String>, limits: &Limits) -> Proof<'static> {
        Proof::none().and_grants(grants, limits)
    }

    pub fn headers(headers: &HeaderMap, limits: &Limits) -> Proof<'static> {
        Proof::grants(header_grants(headers), limits)
    }

    /// Recheck this request's grant under the server write lock.
    pub(crate) async fn grants_server(
        &self,
        db: &Db,
        tx: &mut sqlx::AnyConnection,
        server: &str,
    ) -> sqlx::Result<bool> {
        rules::grants_open_on(tx, db, &self.grants, server, self.grant_ttl).await
    }

    pub fn password(password: Option<&'a str>) -> Proof<'a> {
        Proof {
            password: Slot::Open(password.map(str::trim).filter(|p| !p.is_empty())),
            ..Proof::none()
        }
    }

    pub fn and_grants(self, grants: Vec<String>, limits: &Limits) -> Proof<'a> {
        Proof {
            grants,
            grant_ttl: limits.guest_grant_ttl(),
            ..self
        }
    }
}

#[cfg(test)]
thread_local! {
    static VERIFIES: std::cell::Cell<(u64, u64)> = const { std::cell::Cell::new((0, 0)) };
}

#[cfg(test)]
pub(crate) fn verify_counts() -> (u64, u64) {
    VERIFIES.with(|c| c.get())
}

async fn check_password(given: &str, hash: Option<&str>) -> Result<bool, ApiError> {
    #[cfg(test)]
    VERIFIES.with(|c| {
        let (real, dummy) = c.get();
        c.set(match hash {
            Some(_) => (real + 1, dummy),
            None => (real, dummy + 1),
        });
    });
    match hash {
        Some(hash) => verify_in(Work::Server, given, hash).await,
        None => {
            verify_in(Work::Server, given, dummy_hash().await).await?;
            Ok(false)
        }
    }
}

/// Lookup key of a server password: argon2id of the password, salted with the first 16 bytes
/// of HMAC-SHA256 under the instance pepper of the lowercase server name, hex-encoded. A
/// matching row is the proof of the password. Works the same for names that do not exist.
pub async fn password_lookup(db: &Db, server: &str, password: &str) -> Result<String, ApiError> {
    let pepper = crate::db::pepper(db).await?;
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&pepper)
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?;
    mac.update(server.to_lowercase().as_bytes());
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&mac.finalize().into_bytes()[..16]);
    derive_key(password, salt).await
}

/// The instance-wide key of an invite code: HMAC-SHA256 of the code under the instance pepper,
/// hex-encoded. It only finds the server; the code then proves itself as that server's extra
/// password.
pub async fn code_lookup(db: &Db, code: &str) -> Result<String, ApiError> {
    let pepper = crate::db::pepper(db).await?;
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&pepper)
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?;
    mac.update(b"invite code\n");
    mac.update(code.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// The name invite code lookups count their attempts under, which no server has (server names
/// can't hold NUL). It never reaches the database.
const CODE_ATTEMPTS: &str = "\0code";

/// The server an invite code opens, as `viewer` sees it with the code as its password: the
/// gate checks it like any password, attempt budgets included. An unknown code, and one that is
/// revoked, expired or used up, get the uniform `not_found` after the same password work, and
/// count as a wrong password of the caller's address and network. Past the attempt budgets,
/// working and unknown codes get the same 429.
pub async fn resolve_code(
    db: &Db,
    code: &str,
    viewer: Option<&User>,
    grants: Vec<String>,
    limits: &Limits,
) -> Result<InviteView, ApiError> {
    let code = crate::api::passwords::clean_code(code);
    let found = match &code {
        Some(code) => sqlx::query("SELECT server, id, expires_at, max_uses, uses, revoked_at FROM server_passwords WHERE code_lookup = $1")
            .bind(code_lookup(db, code).await?)
            .fetch_optional(db)
            .await?
            .map(|r| -> sqlx::Result<(String, Extra)> {
                Ok((
                    r.try_get(0)?,
                    Extra {
                        id: r.try_get(1)?,
                        expires_at: r.try_get(2)?,
                        max_uses: r.try_get(3)?,
                        uses: r.try_get(4)?,
                        revoked: r.try_get::<Option<i64>, _>(5)?.is_some(),
                    },
                ))
            })
            .transpose()?
            .filter(|(_, extra)| extra.ticket(now()).is_some()),
        None => None,
    };
    match (code, found) {
        (Some(code), Some((server, _))) => {
            let proof = Proof::password(Some(&code)).and_grants(grants, limits);
            resolve_invite(db, &server, viewer, &proof)
                .await
                .map_err(|e| match e.0 {
                    StatusCode::TOO_MANY_REQUESTS => e,
                    _ => hidden(e),
                })
        }
        (code, _) => {
            let attempt = Attempt::start(db, CODE_ATTEMPTS)?;
            let given = code.unwrap_or_default();
            let work = tokio::join!(
                check_password(&given, None),
                password_lookup(db, CODE_ATTEMPTS, &given),
            );
            match work {
                (Err(e), _) | (Ok(_), Err(e)) => {
                    attempt.refund();
                    Err(e)
                }
                (Ok(_), Ok(_)) => {
                    attempt.failed();
                    Err(not_found())
                }
            }
        }
    }
}

struct Extra {
    id: i64,
    expires_at: Option<i64>,
    max_uses: Option<i64>,
    uses: i64,
    revoked: bool,
}

impl Extra {
    fn ticket(&self, t: i64) -> Option<Ticket> {
        let Extra {
            id,
            expires_at,
            max_uses,
            uses,
            revoked,
        } = *self;
        let live =
            !revoked && expires_at.is_none_or(|at| at > t) && max_uses.is_none_or(|max| uses < max);
        live.then_some(Ticket {
            id,
            expires_at,
            uses_left: max_uses.map(|max| max - uses),
        })
    }
}

async fn extra_password(db: &Db, key: &str, lookup: &str) -> sqlx::Result<Option<Extra>> {
    let row = sqlx::query(
        "SELECT id, expires_at, max_uses, uses, revoked_at FROM server_passwords WHERE server = $1 AND lookup = $2",
    )
    .bind(key)
    .bind(lookup)
    .fetch_optional(db)
    .await?;
    match row {
        Some(r) => Ok(Some(Extra {
            id: r.try_get(0)?,
            expires_at: r.try_get(1)?,
            max_uses: r.try_get(2)?,
            uses: r.try_get(3)?,
            revoked: r.try_get::<Option<i64>, _>(4)?.is_some(),
        })),
        None => Ok(None),
    }
}

fn real_hash(hash: Option<&str>) -> Option<&str> {
    hash.filter(|h| !h.starts_with('!'))
}

/// The extra password (temporary or ticket) that opened a server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket {
    id: i64,
    pub expires_at: Option<i64>,
    pub uses_left: Option<i64>,
}

/// Every attempt that carries a password runs exactly two argon2 operations, at the same time:
/// the permanent password verify (or the dummy hash) and the lookup key derivation. The extra
/// password is the row with that key. Nothing depends on whether the server exists, is public,
/// or how many passwords it has.
async fn check_passwords(
    db: &Db,
    key: &str,
    given: &str,
    permanent: Option<&str>,
) -> Result<(bool, Option<Ticket>), ApiError> {
    let (permanent_ok, lookup) = tokio::join!(
        check_password(given, real_hash(permanent)),
        password_lookup(db, key, given),
    );
    let (permanent_ok, lookup) = (permanent_ok?, lookup?);
    let extra = extra_password(db, key, &lookup).await?;
    let ticket = extra.and_then(|extra| extra.ticket(now()));
    Ok((permanent_ok, ticket))
}

#[derive(Clone, Copy)]
struct Who<'a> {
    username: Option<&'a str>,
    site_admin: bool,
}

impl<'a> Who<'a> {
    fn of(user: Option<&'a User>) -> Who<'a> {
        Who {
            username: user.map(|u| u.username.as_str()),
            site_admin: user.is_some_and(|u| u.is_site_admin),
        }
    }
}

struct Gate {
    lite: ServerSummaryLite,
    via: Via,
    banned: bool,
    ticket: Option<Ticket>,
}

async fn exists(db: &Db, sql: &'static str, server: &str, username: &str) -> sqlx::Result<bool> {
    Ok(sqlx::query(sql)
        .bind(server)
        .bind(username)
        .fetch_optional(db)
        .await?
        .is_some())
}

/// Password attempts per client address (an IPv6 /64 counts as one address), across joins,
/// invites and guest access.
static PASSWORD_TRIES: LazyLock<Keyed> = LazyLock::new(|| {
    Keyed::new(
        Policy::Window {
            limit: 30,
            window: Duration::from_secs(600),
        },
        100_000,
    )
});

/// Password attempts per wider network (IPv4 /24, IPv6 /48) across all names. Attempts with the
/// right password are given back.
static NETWORK_TRIES: LazyLock<Keyed> = LazyLock::new(|| {
    Keyed::new(
        Policy::Window {
            limit: NETWORK_TRIES_MAX,
            window: Duration::from_secs(600),
        },
        100_000,
    )
});

pub(crate) const NETWORK_TRIES_MAX: u32 = 150;

/// Failed attempts per client address and server name: 5 free, then a doubling wait up to an
/// hour. On a hot name (see `PASSWORD_FAILURES`) each address gets 3 an hour, never fewer, so
/// someone with the right password from another address still gets in.
static NAME_TRIES: LazyLock<Backoff> =
    LazyLock::new(|| Backoff::new(5, 3, Duration::from_secs(3600), 100_000));

/// Failed password attempts per server name, from all addresses. Past the limit the name is
/// hot. Names that do not exist count the same way, so nothing shows whether a server exists.
static PASSWORD_FAILURES: LazyLock<Keyed> = LazyLock::new(|| {
    Keyed::new(
        Policy::Window {
            limit: PASSWORD_FAILURES_MAX,
            window: Duration::from_secs(3600),
        },
        100_000,
    )
});

pub(crate) const PASSWORD_FAILURES_MAX: u32 = 50;

fn budget_key(db: &Db, part: &str) -> String {
    format!("{}\n{part}", pool_key(db))
}

/// A password attempt with its budgets reserved before the password is checked. It counts as
/// failed unless `passed` or `refund` gives it back. Every refusal is the same 429 for every name.
struct Attempt {
    network: Option<(String, Instant)>,
    name: String,
    server: String,
}

impl Attempt {
    fn start(db: &Db, server: &str) -> Result<Attempt, ApiError> {
        let ip = budget::client();
        let address = match ip {
            Some(ip) => budget::group(ip).to_string(),
            None => "-".to_string(),
        };
        let network = match ip {
            Some(ip) => {
                let key = budget_key(db, &budget::wide(ip).to_string());
                match NETWORK_TRIES.reserve(&key, 1.0, Instant::now()) {
                    Some(at) => Some((key, at)),
                    None => return Err(slow_down()),
                }
            }
            None => None,
        };
        let attempt = Attempt {
            network,
            name: budget_key(db, &format!("{address}\n{server}")),
            server: budget_key(db, server),
        };
        if ip.is_some() && !PASSWORD_TRIES.take(&budget_key(db, &address), 1.0, Instant::now()) {
            attempt.give_back_network();
            return Err(slow_down());
        }
        let hot = PASSWORD_FAILURES.remaining(&attempt.server, Instant::now()) < 1.0;
        match NAME_TRIES.reserve(&attempt.name, hot) {
            true => Ok(attempt),
            false => {
                attempt.give_back_network();
                Err(slow_down())
            }
        }
    }

    fn give_back_network(&self) {
        if let Some((key, at)) = &self.network {
            NETWORK_TRIES.refund(key, 1.0, *at);
        }
    }

    /// The attempt did not fail (right password, or nothing was checked).
    fn refund(self) {
        self.give_back_network();
        NAME_TRIES.refund(&self.name);
    }

    fn failed(self) -> ApiError {
        NAME_TRIES.failed(&self.name);
        PASSWORD_FAILURES.spend(&self.server, 1.0, Instant::now());
        denied()
    }
}

fn attempt_failed(attempt: Option<Attempt>) -> ApiError {
    match attempt {
        Some(attempt) => attempt.failed(),
        None => denied(),
    }
}

/// How the instance opens servers to people who aren't members: its joining rule, and whether
/// it lets servers be readable by them at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Reading {
    joining: ServerJoining,
    public: bool,
}

impl Reading {
    pub(crate) async fn now(db: &Db) -> Reading {
        let allowed = crate::api::policy::effective(db, None).await;
        Reading {
            joining: allowed.server_joining(),
            public: allowed.public_reading(),
        }
    }

    /// Whether a name alone lets an account join the server: it has no password and the
    /// instance lets everyone join.
    fn joins_by_name(self, has_password: bool) -> bool {
        !has_password && self.joining == ServerJoining::Everyone
    }

    /// Whether people who aren't members may read `server` by its name: its own option, or,
    /// while that follows the instance, whether a name alone joins it. Never while the instance
    /// has public reading off.
    pub(crate) fn reads(self, server: &ServerSummaryLite) -> bool {
        self.public
            && server
                .public_read
                .unwrap_or(self.joins_by_name(server.has_password))
    }

    /// The SQL condition on a `servers` row `s` that anyone may read it by name: the rule of
    /// `servers_sql`, for a join.
    pub(crate) fn readable_sql(self) -> &'static str {
        match (self.public, self.joining) {
            (false, _) => "1 = 0",
            (true, ServerJoining::Everyone) => {
                "(s.public_read = 1 OR (s.public_read IS NULL AND s.password_hash IS NULL)) AND COALESCE(s.password_hash, '') <> '!purging'"
            }
            (true, ServerJoining::Invites | ServerJoining::Nobody) => {
                "s.public_read = 1 AND COALESCE(s.password_hash, '') <> '!purging'"
            }
        }
    }

    /// SQL for the keys of the servers that anyone may read by name.
    pub(crate) fn servers_sql(self) -> &'static str {
        match (self.public, self.joining) {
            (false, _) => "SELECT name FROM servers WHERE 1 = 0",
            (true, ServerJoining::Everyone) => {
                "SELECT name FROM servers WHERE (public_read = 1 OR (public_read IS NULL AND password_hash IS NULL)) AND COALESCE(password_hash, '') <> '!purging'"
            }
            (true, ServerJoining::Invites | ServerJoining::Nobody) => {
                "SELECT name FROM servers WHERE public_read = 1 AND COALESCE(password_hash, '') <> '!purging'"
            }
        }
    }
}

/// The servers of `keys`, in that order, that people who aren't members may read by name right
/// now. A server that only members read, a missing one and one being purged are left out.
pub(crate) async fn readable_by_name(db: &Db, keys: &[String]) -> sqlx::Result<Vec<String>> {
    let reading = Reading::now(db).await;
    let mut readable = Vec::new();
    for key in keys {
        if server_lite_now(db, key)
            .await?
            .is_some_and(|lite| reading.reads(&lite))
        {
            readable.push(key.clone());
        }
    }
    Ok(readable)
}

/// A server's `public_read` column at `idx` of `row`: on, off, or not set.
pub(crate) fn public_read(row: &AnyRow, idx: usize) -> sqlx::Result<Option<bool>> {
    Ok(row.try_get::<Option<i64>, _>(idx)?.map(|on| on != 0))
}

/// The `servers` columns that `lite_row` reads, in its order.
pub(crate) const LITE_COLUMNS: &str = "name, display_name, creator, password_hash, banner_color, name_color, public_read, guest_voice_opt_in, members_visible, guest_chat_opt_in, join_mode, listed, profiles_mode, description, icon_kind, seal, seal_forced, hide_members, icon_image";

/// The summary of a server from the columns of `LITE_COLUMNS` in `row`, starting at `at`. A
/// server whose join mode the row doesn't say (a server without a permanent password from
/// before join modes) is an invite server while it has a live extra password.
pub(crate) async fn lite_row(db: &Db, row: &AnyRow, at: usize) -> sqlx::Result<ServerSummaryLite> {
    let name: String = row.try_get(at)?;
    let hash: Option<String> = row.try_get(at + 3)?;
    let stored: Option<String> = row.try_get(at + 10)?;
    let join_mode = match join_mode_of(stored.as_deref(), hash.as_deref()) {
        Some(mode) => mode,
        None => legacy_mode(has_live_extra(db, &name).await?),
    };
    Ok(ServerSummaryLite {
        name,
        display_name: row.try_get(at + 1)?,
        creator: row.try_get(at + 2)?,
        has_password: hash.is_some(),
        banner_color: row.try_get(at + 4)?,
        name_color: row.try_get(at + 5)?,
        public_read: public_read(row, at + 6)?,
        guest_voice: row.try_get::<i64, _>(at + 7)? != 0,
        guest_chat: row.try_get::<i64, _>(at + 9)? != 0,
        members_visible: row.try_get::<i64, _>(at + 8)? != 0,
        join_mode,
        listed: row.try_get::<i64, _>(at + 11)? != 0,
        profiles_mode: ProfilesMode::parse(&row.try_get::<String, _>(at + 12)?),
        description: row.try_get(at + 13)?,
        icon_kind: crate::api::server_about::IconKind::stored(
            row.try_get::<Option<String>, _>(at + 14)?.as_deref(),
        ),
        seal: crate::api::seal::server_view(db, row.try_get(at + 15)?, row.try_get(at + 16)?).await,
        hide_members: row.try_get::<i64, _>(at + 17)? != 0,
        icon_image: row.try_get(at + 18)?,
    })
}

/// Whether `server` has an extra password that lets someone new in now.
pub(crate) async fn has_live_extra<'e, E>(ex: E, server: &str) -> sqlx::Result<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    Ok(sqlx::query(
        "SELECT 1 FROM server_passwords WHERE server = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) AND (max_uses IS NULL OR uses < max_uses) LIMIT 1",
    )
    .bind(server)
    .bind(now())
    .fetch_optional(ex)
    .await?
    .is_some())
}

async fn gate(db: &Db, name: &str, who: Who<'_>, proof: &Proof<'_>) -> Result<Gate, ApiError> {
    let key = name.to_lowercase();
    let reading = Reading::now(db).await;
    // What someone who shows no password gets where one could let them in: asked for it, or,
    // while nobody may join, the uniform denial.
    let ask = || match reading.joining {
        ServerJoining::Everyone | ServerJoining::Invites => password_required(),
        ServerJoining::Nobody => denied(),
    };
    let mut attempt = match proof.password {
        Slot::Open(Some(_)) => Some(Attempt::start(db, &key)?),
        Slot::Open(None) | Slot::Closed => None,
    };
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {LITE_COLUMNS} FROM servers WHERE name = $1 AND COALESCE(password_hash, '') <> '!purging'"
    )))
    .bind(&key)
    .fetch_optional(db)
    .await?;
    let (member, banned, history) = match who.username {
        Some(u) => (
            is_member(db, &key, u).await?,
            crate::api::bans::banned(db, &key, u).await?,
            exists(
                db,
                "SELECT 1 FROM interactions WHERE server = $1 AND username = $2",
                &key,
                u,
            )
            .await?,
        ),
        None => (false, false, false),
    };
    let granted = match who.username {
        None => grants_open(db, &proof.grants, &key, proof.grant_ttl).await?,
        Some(_) => false,
    };
    let hash: Option<String> = match &row {
        Some(row) => row.try_get(3)?,
        None => None,
    };
    let checked = match proof.password {
        Slot::Open(Some(given)) => match check_passwords(db, &key, given, hash.as_deref()).await {
            Ok(checked) => Some(checked),
            Err(e) => {
                if let Some(attempt) = attempt.take() {
                    attempt.refund();
                }
                return Err(e);
            }
        },
        Slot::Open(None) | Slot::Closed => None,
    };
    let Some(row) = row else {
        return Err(match proof.password {
            Slot::Open(Some(_)) => attempt_failed(attempt.take()),
            Slot::Closed => denied(),
            Slot::Open(None) => ask(),
        });
    };
    let lite = lite_row(db, &row, 0).await?;
    let mut ticket = None;
    let readable = reading.reads(&lite);
    // What lets someone in who is no member and shows nothing: a server anyone may read by its
    // name, or, at the join step, one anyone may join by its name. Reading never joins, and
    // joining by name never reads.
    let open = match (proof.password, reading.joins_by_name(lite.has_password)) {
        (Slot::Closed, _) | (Slot::Open(_), true) if readable => Some(Via::Public),
        (Slot::Open(_), true) if who.username.is_some() => Some(Via::Joinable),
        (Slot::Closed | Slot::Open(_), _) => None,
    };
    let via = match (member, open) {
        (true, _) => Via::Member,
        (false, _) if proof.managed && who.username.is_some() => Via::Managed,
        (false, Some(via)) => via,
        (false, None) => match (granted, who.site_admin, proof.password, checked) {
            (true, _, _, _) => Via::Grant,
            (false, true, Slot::Closed, _) => Via::Staff,
            (false, _, Slot::Open(Some(_)), Some((true, _))) => Via::Password,
            (false, _, Slot::Open(Some(_)), Some((false, Some(t)))) => {
                ticket = Some(t);
                Via::Password
            }
            (false, _, Slot::Open(Some(_)), _) => return Err(attempt_failed(attempt.take())),
            (false, _, Slot::Open(None), _) if banned && history => return Err(self::banned()),
            (false, _, Slot::Open(None), _) => return Err(ask()),
            (false, _, Slot::Closed, _) if banned && history => return Err(self::banned()),
            (false, _, Slot::Closed, _) => return Err(denied()),
        },
    };
    if let Some(attempt) = attempt.take() {
        attempt.refund();
    }
    Ok(Gate {
        lite,
        via,
        banned,
        ticket,
    })
}

pub struct ServerAccess {
    lite: ServerSummaryLite,
    via: Via,
    user: Option<User>,
    ticket: Option<Ticket>,
}

pub async fn resolve_server(
    db: &Db,
    name: &str,
    viewer: Option<&User>,
    proof: &Proof<'_>,
) -> Result<ServerAccess, ApiError> {
    match resolve_invite(db, name, viewer, proof).await? {
        InviteView::Banned(_) => Err(banned()),
        InviteView::Open(access) => Ok(*access),
    }
}

/// Resolves a server for someone getting in by themselves: an account joining it, or a guest
/// asking for guest access. `joining` is the instance's rule for that. Under `Invites` a name
/// alone opens nothing (the gate's rule, for reading too), so every name without a working
/// password or ticket gets the answers of a password-protected server. Under `Nobody` every
/// name gets the uniform denial, and nothing is looked up.
pub async fn resolve_join(
    db: &Db,
    name: &str,
    viewer: Option<&User>,
    password: Option<&str>,
    joining: ServerJoining,
) -> Result<ServerAccess, ApiError> {
    let proof = Proof::password(password);
    match joining {
        ServerJoining::Everyone | ServerJoining::Invites => {
            resolve_server(db, name, viewer, &proof).await
        }
        ServerJoining::Nobody => Err(crate::api::policy::refused(
            &rchat_settings::items::SERVER_JOINING,
            denied(),
        )),
    }
}

pub enum InviteView {
    Banned(ServerSummaryLite),
    Open(Box<ServerAccess>),
}

pub async fn resolve_invite(
    db: &Db,
    name: &str,
    viewer: Option<&User>,
    proof: &Proof<'_>,
) -> Result<InviteView, ApiError> {
    let Gate {
        lite,
        via,
        banned,
        ticket,
    } = gate(db, name, Who::of(viewer), proof).await?;
    if let (Via::Staff, Some(admin)) = (via, viewer) {
        staff_audit::view_server(db, admin, &lite.name).await?;
    }
    match banned {
        true => Ok(InviteView::Banned(lite)),
        false => Ok(InviteView::Open(Box::new(ServerAccess {
            lite,
            via,
            user: viewer.cloned(),
            ticket,
        }))),
    }
}

/// The server `name` as `viewer` reads it without joining: only while people who aren't
/// members may read it by its name. `None` otherwise, also for a name that doesn't exist.
pub async fn resolve_reading(
    db: &Db,
    name: &str,
    viewer: Option<&User>,
) -> Result<Option<InviteView>, ApiError> {
    let Gate {
        lite,
        via,
        banned,
        ticket,
    } = match gate(db, name, Who::of(viewer), &Proof::none()).await {
        Ok(gate) => gate,
        Err(e) if e.failed() => return Err(e),
        Err(_) => return Ok(None),
    };
    match (via, banned) {
        (Via::Public, true) => Ok(Some(InviteView::Banned(lite))),
        (Via::Public, false) => Ok(Some(InviteView::Open(Box::new(ServerAccess {
            lite,
            via,
            user: viewer.cloned(),
            ticket,
        })))),
        (
            Via::Member | Via::Password | Via::Grant | Via::Staff | Via::Joinable | Via::Managed,
            _,
        ) => Ok(None),
    }
}

impl ServerAccess {
    /// Whether `username` is a member of this server, read on `ex`.
    pub(crate) async fn member_in<'e, E>(&self, ex: E, username: &str) -> sqlx::Result<bool>
    where
        E: sqlx::Executor<'e, Database = sqlx::Any>,
    {
        is_member(ex, self.name(), username).await
    }

    /// The admin flag and stored permission bits of `username` in this server, read on `ex`.
    pub(crate) async fn role_in<'e, E>(
        &self,
        ex: E,
        username: &str,
    ) -> sqlx::Result<Option<(bool, i64)>>
    where
        E: sqlx::Executor<'e, Database = sqlx::Any>,
    {
        member_role(ex, self.name(), username).await
    }

    pub fn name(&self) -> &str {
        &self.lite.name
    }

    pub fn lite(&self) -> &ServerSummaryLite {
        &self.lite
    }

    pub fn via(&self) -> Via {
        self.via
    }

    pub fn is_member(&self) -> bool {
        self.via == Via::Member
    }

    /// The extra password that opened the server, when one did (not the permanent password).
    pub fn ticket(&self) -> Option<Ticket> {
        self.ticket
    }

    /// Id of the extra password that opened the server, for `members.joined_via` and
    /// `guest_grants.password_id`.
    pub fn password_id(&self) -> Option<i64> {
        self.ticket.map(|t| t.id)
    }

    /// Consumes one use of the extra password that opened the server, atomically. Zero rows
    /// (revoked, expired or used up since the check) answer the uniform denial.
    pub async fn spend_ticket(&self, conn: &mut AnyConnection) -> Result<(), ApiError> {
        let Some(ticket) = self.ticket else {
            return Ok(());
        };
        let spent = sqlx::query(
            "UPDATE server_passwords SET uses = uses + 1, used_up_at = CASE WHEN max_uses IS NOT NULL AND uses + 1 >= max_uses THEN $2 ELSE used_up_at END WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) AND (max_uses IS NULL OR uses < max_uses)",
        )
        .bind(ticket.id)
        .bind(now())
        .execute(&mut *conn)
        .await?
        .rows_affected();
        match spent {
            0 => Err(denied()),
            _ => Ok(()),
        }
    }

    /// Whether the server has a permanent password (for managers of the access settings).
    pub async fn has_permanent_password(&self, db: &Db) -> Result<bool, ApiError> {
        Ok(real_hash(self.permanent_hash(db).await?.as_deref()).is_some())
    }

    /// Whether `password` is the permanent password (extra passwords must differ from it).
    pub async fn is_permanent_password(&self, db: &Db, password: &str) -> Result<bool, ApiError> {
        match real_hash(self.permanent_hash(db).await?.as_deref()) {
            Some(hash) => verify_in(Work::Server, password, hash).await,
            None => Ok(false),
        }
    }

    /// Whether `password` is a live extra password of the server (the permanent password must
    /// differ from them).
    pub async fn is_live_extra_password(&self, db: &Db, password: &str) -> Result<bool, ApiError> {
        let lookup = password_lookup(db, self.name(), password).await?;
        Ok(extra_password(db, self.name(), &lookup)
            .await?
            .and_then(|extra| extra.ticket(now()))
            .is_some())
    }

    async fn permanent_hash(&self, db: &Db) -> Result<Option<String>, ApiError> {
        Ok(
            sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
                .bind(self.name())
                .fetch_optional(db)
                .await?
                .map(|r| r.try_get(0))
                .transpose()?
                .flatten(),
        )
    }

    pub fn viewer(&self) -> Option<&User> {
        self.user.as_ref()
    }

    /// Whether `username` (lowercase) is a member of this server. Only answer a viewer who
    /// may know who is in it: never one the gate let in to join (`Via::Joinable`), and only
    /// one the server lists its members to (`subjects::lists_members`).
    pub async fn has_member(&self, db: &Db, username: &str) -> Result<bool, ApiError> {
        Ok(is_member(db, self.name(), username).await?)
    }

    pub fn require_member(&self) -> Result<(), ApiError> {
        match self.is_member() {
            true => Ok(()),
            false => Err(ApiError::perm("Not a member", "member")),
        }
    }

    /// The viewer's right to change their own profile in this server: a member who is not timed
    /// out and holds Change server profile, from everyone or one of their roles.
    pub async fn change_profile(&self, db: &Db) -> Result<ProfileRight, ApiError> {
        let (Some(user), true) = (&self.user, self.is_member()) else {
            return Err(ApiError::perm("Not a member", "member"));
        };
        if timed_out(db, self.name(), &user.username).await?.is_some() {
            return Err(timed_out_error());
        }
        let who = self.standing(db).await?.who;
        let everyone = self.everyone(db).await?;
        let bits = rchat_perms::eval::server_bits(&who, everyone, &rchat_perms::rules::HOSTED);
        match bits & held::CHANGE_PROFILE {
            0 => Err(ApiError::perm("Missing permission", "ChangeProfile")),
            _ => Ok(ProfileRight {
                server: self.name().to_string(),
                username: user.username.clone(),
            }),
        }
    }

    /// The viewer's permissions for acting. A member who is timed out keeps only the read
    /// rights (`TIMED_OUT_KEEP`) until the timeout ends. That holds for a site admin who is a
    /// member too: acting normally while timed out would show what they are. Only a site
    /// admin reaching the server as staff (not a member, so never timed out here) is not
    /// limited.
    pub async fn perms(&self, db: &Db) -> Result<i64, ApiError> {
        let bits = self.view_perms(db).await?;
        match &self.user {
            Some(user)
                if self.via != Via::Staff
                    && bits & !TIMED_OUT_KEEP != 0
                    && timed_out(db, self.name(), &user.username).await?.is_some() =>
            {
                Ok(bits & TIMED_OUT_KEEP)
            }
            Some(_) | None => Ok(bits),
        }
    }

    /// The viewer's permissions for seeing things, which a timeout does not take away.
    pub async fn view_perms(&self, db: &Db) -> Result<i64, ApiError> {
        match &self.user {
            Some(user) => Ok(effective_perms(db, self.name(), user).await?),
            None => Ok(0),
        }
    }

    pub async fn member_perms(&self, db: &Db, username: &str) -> Result<i64, ApiError> {
        Ok(member_perms(db, self.name(), username).await?)
    }

    pub async fn member_perms_in(
        &self,
        conn: &mut AnyConnection,
        username: &str,
    ) -> Result<Option<i64>, ApiError> {
        Ok(rules::member_perms_in(conn, self.name(), username).await?)
    }

    pub async fn role_authority_in(
        &self,
        conn: &mut sqlx::AnyConnection,
        perm: Perm,
    ) -> Result<(i64, i64), ApiError> {
        let user = self
            .viewer()
            .ok_or_else(|| ApiError::perm("Missing permission", perm.name()))?;
        if self.via != Via::Staff
            && timed_out(&mut *conn, self.name(), &user.username)
                .await?
                .is_some()
        {
            return Err(timed_out_error());
        }
        let own = self
            .member_perms_in(conn, &user.username)
            .await?
            .unwrap_or(0);
        let mine = if user.is_site_admin {
            perms::ALL_PERMS
        } else {
            own
        };
        if mine & perm as i64 == 0 {
            return Err(ApiError::perm("Missing permission", perm.name()));
        }
        Ok((mine, own))
    }

    pub async fn has_perm(&self, db: &Db, perm: Perm) -> bool {
        self.perms(db).await.is_ok_and(|p| p & perm as i64 != 0)
    }

    /// Whether the viewer may see what `perm` shows, which a timeout does not take away.
    pub async fn can_view(&self, db: &Db, perm: Perm) -> bool {
        self.view_perms(db)
            .await
            .is_ok_and(|p| p & perm as i64 != 0)
    }

    pub async fn require_perm(&self, db: &Db, perm: Perm) -> Result<(), ApiError> {
        let bit = perm as i64;
        match (self.perms(db).await?, self.view_perms(db).await?) {
            (p, _) if p & bit != 0 => Ok(()),
            (_, v) if v & bit != 0 => Err(timed_out_error()),
            _ => Err(ApiError::perm("Missing permission", perm.name())),
        }
    }

    pub async fn manages_channels(&self, db: &Db) -> Result<bool, ApiError> {
        Ok(self.view_perms(db).await? & Perm::ManageChannels as i64 != 0)
    }

    pub fn site_admin(&self) -> bool {
        self.user.as_ref().is_some_and(|u| u.is_site_admin)
    }

    /// Who an action needing `perm` is logged as: the viewer, or the unnamed instance staff
    /// when a site admin acts without being a member who holds `perm` themselves.
    pub async fn audit_actor(&self, db: &Db, perm: Perm) -> Result<Actor, ApiError> {
        let Some(user) = &self.user else {
            return Ok(Actor::Staff);
        };
        let staff = self.via == Via::Staff
            || (user.is_site_admin
                && self.member_perms(db, &user.username).await? & perm as i64 == 0);
        Ok(Actor::of(user, staff))
    }

    /// Who an action on a channel's messages is logged as: the viewer, or the unnamed instance
    /// staff when a site admin acts as staff or the action `bypassed` what their membership
    /// allows in that channel.
    pub fn channel_actor(&self, bypassed: bool) -> Actor {
        match &self.user {
            Some(user) => Actor::of(user, self.via == Via::Staff || bypassed),
            None => Actor::Staff,
        }
    }

    /// This access as the viewer's plain membership without instance powers: `Some` only for a
    /// site admin who isn't already acting as staff.
    pub fn as_member(&self) -> Option<ServerAccess> {
        match &self.user {
            Some(user) if user.is_site_admin && self.via != Via::Staff => Some(ServerAccess {
                lite: self.lite.clone(),
                via: self.via,
                user: Some(User {
                    is_site_admin: false,
                    ..user.clone()
                }),
                ticket: self.ticket,
            }),
            _ => None,
        }
    }

    /// Whether `check`, which passed for the viewer, fails for their plain membership, so the
    /// action only succeeds through instance powers and must be logged as the unnamed staff.
    pub async fn bypassed<F, Fut>(&self, check: F) -> bool
    where
        F: FnOnce(ServerAccess) -> Fut,
        Fut: std::future::Future<Output = Result<(), ApiError>>,
    {
        match self.as_member() {
            Some(member) => check(member).await.is_err(),
            None => false,
        }
    }

    /// The viewer's permissions as a plain member: `Some` only for a site admin who isn't
    /// already acting as staff.
    pub async fn member_own_perms(&self, db: &Db) -> Result<Option<i64>, ApiError> {
        match self.as_member() {
            Some(member) => Ok(Some(member.perms(db).await?)),
            None => Ok(None),
        }
    }

    /// What a visitor may hold in this server right now: viewing and reading, and for a guest
    /// the sending and voice the site and the server have both turned on for guests.
    pub(crate) async fn visitor_caps(&self, db: &Db) -> Result<Mask, ApiError> {
        let (guest_chat, guest_voice) = (self.lite.guest_chat, self.lite.guest_voice);
        if self.user.is_some() || !(guest_chat || guest_voice) {
            return Ok(masks::READ_LINK);
        }
        let on: HashSet<String> = sqlx::query("SELECT key FROM settings WHERE key IN ('guests_enabled', 'guest_chat_enabled', 'guest_voice_enabled') AND value = '1'")
            .fetch_all(db)
            .await?
            .iter()
            .filter_map(|r| r.try_get(0).ok())
            .collect();
        let cap = |opted_in: bool, control: &str, bits: Mask| match opted_in
            && on.contains("guests_enabled")
            && on.contains(control)
        {
            true => bits,
            false => 0,
        };
        Ok(masks::READ_LINK
            | cap(guest_chat, "guest_chat_enabled", masks::GUEST_CHAT)
            | cap(guest_voice, "guest_voice_enabled", masks::GUEST_VOICE))
    }

    /// Who the viewer is in this server for channel permissions.
    pub(crate) async fn standing(&self, db: &Db) -> Result<Standing, ApiError> {
        Ok(standing(db, self.name(), self.user.as_ref(), VISITOR_CAPS).await?)
    }

    /// The @everyone mask of this server.
    pub(crate) async fn everyone(&self, db: &Db) -> Result<Mask, ApiError> {
        Ok(server_everyone(db, self.name()).await?)
    }

    /// The viewer's rights in each channel of this server.
    pub async fn channel_rights(&self, db: &Db) -> Result<HashMap<i64, ChannelAccess>, ApiError> {
        let channels = sqlx::query(
            "SELECT c.id, c.restrict_view, c.restrict_send, c.kind FROM channels c WHERE c.server = $1",
        )
        .bind(self.name())
        .fetch_all(db)
        .await?;
        if channels.is_empty() {
            return Ok(HashMap::new());
        }
        let standing = self.standing(db).await?;
        let everyone = self.everyone(db).await?;
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT cp.channel_id, {} FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id WHERE c.server = $1",
            perm_columns("cp")
        )))
        .bind(self.name())
        .fetch_all(db)
        .await?;
        let rules = rules_by_channel(&rows)?;
        let mut out = HashMap::with_capacity(channels.len());
        for r in &channels {
            let id: i64 = r.try_get(0)?;
            let list = rules.get(&id).map(Vec::as_slice).unwrap_or_default();
            let voice = r.try_get::<String, _>(3)? == "voice";
            let mask = channel_mask(
                list,
                &standing,
                everyone,
                Restrict::read(r, 1)?,
                voice,
                false,
            );
            out.insert(id, ChannelAccess::of(mask));
        }
        Ok(out)
    }

    /// For one statement that reads this server's messages for a viewer who doesn't manage
    /// channels: the text channels they view under the rule of `channel_rights`, as `id`,
    /// `whole` (1 where they read the whole history) and `since` (from when they read the
    /// others: their join, or now for someone who isn't a member). That statement reads the
    /// channels, their rules, the viewer's roles and their join itself, so a channel or rule
    /// that changes meanwhile can't fall between two reads. `$1` is the server's name; the
    /// binds of `TextReading::bind` start at `$next`.
    pub fn text_reading(&self, next: usize) -> TextReading {
        let now = now();
        match &self.user {
            None => TextReading {
                sql: format!(
                    "SELECT c.id, CASE WHEN {} THEN 1 ELSE 0 END AS whole, ${next} AS since FROM channels c WHERE c.server = $1 AND c.kind = 'text' AND {}",
                    overwrite_sql(masks::HISTORY, None),
                    overwrite_sql(masks::VIEW, None)
                ),
                viewer: None,
                now,
            },
            Some(user) => {
                let (name, at) = (next, next + 1);
                let viewer = format!("${name}");
                TextReading {
                    sql: format!(
                        "SELECT c.id, CASE WHEN {} THEN 1 ELSE 0 END AS whole, COALESCE((SELECT mm.joined_at FROM members mm WHERE mm.server = $1 AND mm.username = ${name}), ${at}) AS since FROM channels c WHERE c.server = $1 AND c.kind = 'text' AND {}",
                        overwrite_sql(masks::HISTORY, Some(&viewer)),
                        overwrite_sql(masks::VIEW, Some(&viewer))
                    ),
                    viewer: Some(user.username.clone()),
                    now,
                }
            }
        }
    }

    /// Whether the order of this server's roles is unconfirmed (see `ranks::guard_in`).
    pub(crate) async fn order_guard(&self, db: &Db) -> Result<bool, ApiError> {
        Ok(ranks::guard_in(db, self.name()).await?)
    }

    /// The viewer's rank: staff for a site admin, else their own as a member.
    pub(crate) async fn rank(&self, db: &Db) -> Result<Rank<'static>, ApiError> {
        match &self.user {
            Some(user) if user.is_site_admin => Ok(Rank::of(Tier::Staff)),
            Some(user) => self.member_rank(db, &user.username).await,
            None => Ok(Rank::of(Tier::Outside)),
        }
    }

    /// The rank of `username` as a member of this server.
    pub(crate) async fn member_rank(
        &self,
        db: &Db,
        username: &str,
    ) -> Result<Rank<'static>, ApiError> {
        let mut conn = db.acquire().await?;
        Ok(ranks::rank_in(&mut conn, self.name(), username).await?)
    }

    /// The viewer as the hierarchy reads them: their rank and the permissions they act with.
    pub(crate) async fn actor(&self, db: &Db) -> Result<hier::Actor<'static>, ApiError> {
        Ok(hier::Actor {
            rank: self.rank(db).await?,
            bits: self.perms(db).await? as Mask,
        })
    }

    /// `username` as the hierarchy reads them.
    pub(crate) async fn member_actor(
        &self,
        db: &Db,
        username: &str,
    ) -> Result<hier::Actor<'static>, ApiError> {
        Ok(hier::Actor {
            rank: self.member_rank(db, username).await?,
            bits: self.member_perms(db, username).await? as Mask,
        })
    }

    /// Whether the viewer ranks above `username`, which is what acting on them needs once the
    /// role order is confirmed. Until then their permissions must be a strict subset of the
    /// viewer's.
    pub(crate) async fn moderates(&self, db: &Db, username: &str) -> Result<bool, ApiError> {
        Ok(hier::may_moderate(
            &self.actor(db).await?,
            &self.member_actor(db, username).await?,
            0,
            self.order_guard(db).await?,
        ))
    }

    /// Whether the viewer ranks above `username`, whatever the order guard says.
    pub(crate) async fn outranks(&self, db: &Db, username: &str) -> Result<bool, ApiError> {
        Ok(hier::outranks(
            &self.rank(db).await?,
            &self.member_rank(db, username).await?,
        ))
    }

    pub async fn require_moderate(&self, db: &Db, target: &str) -> Result<(), ApiError> {
        match self.moderates(db, target).await? {
            true => Ok(()),
            false => Err(ApiError::perm("You can't moderate this member", "rank")),
        }
    }

    /// The viewer's server bits, with the ones everyone holds.
    pub(crate) async fn server_bits(&self, db: &Db) -> Result<Mask, ApiError> {
        let everyone = self.everyone(db).await?;
        let standing = self.standing(db).await?;
        Ok(rchat_perms::eval::server_bits(
            &standing.who,
            everyone,
            &rchat_perms::rules::HOSTED,
        ))
    }

    pub async fn require_grant(&self, db: &Db, perms: i64) -> Result<(), ApiError> {
        let mine = self.perms(db).await?;
        let base = (perms & perms::EVERYONE_BITS) as Mask;
        let held = base == 0 || self.site_admin() || base & !self.server_bits(db).await? == 0;
        match held && can_grant(mine, self.site_admin(), perms) {
            true => Ok(()),
            false => Err(ApiError::perm(
                "You can't grant permissions you don't have",
                "rank",
            )),
        }
    }

    pub async fn channel(self, db: &Db, id: i64) -> Result<ResolvedChannel, ApiError> {
        self.channel_for(db, id, StaffUse::Open).await
    }

    /// `channel`, for what a site admin does in a channel only instance powers open to them.
    pub async fn channel_for(
        self,
        db: &Db,
        id: i64,
        used: StaffUse,
    ) -> Result<ResolvedChannel, ApiError> {
        if self.via == Via::Joinable {
            return Err(not_found());
        }
        let row = sqlx::query(
            "SELECT server, kind, name, slowmode_seconds, sensitive, text_only FROM channels WHERE id = $1 AND server = $2",
        )
        .bind(id)
        .bind(self.name())
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?;
        let rights = channel_access(db, self.name(), id, self.user.as_ref()).await?;
        if !rights.view {
            return Err(not_found());
        }
        let (staff, rights) = match &self.user {
            Some(user) if user.is_site_admin => {
                match admin_reach(db, self.name(), id, user, used).await? {
                    AdminReach::Own => (self.via == Via::Staff, rights),
                    AdminReach::OwnHistory => (
                        self.via == Via::Staff,
                        ChannelAccess {
                            history: false,
                            mask: rights.mask & !(masks::HISTORY as i64),
                            ..rights
                        },
                    ),
                    AdminReach::Staff => (true, rights),
                    AdminReach::Shut => return Err(staff_audit::confirm_first(id)),
                }
            }
            Some(_) | None => (false, rights),
        };
        Ok(ResolvedChannel {
            staff,
            id,
            kind: ChannelKind::parse(&row.try_get::<String, _>(1)?)?,
            name: row.try_get(2)?,
            slowmode: row.try_get(3)?,
            sensitive: row.try_get::<i64, _>(4)? != 0,
            text_only: row.try_get::<i64, _>(5)? != 0,
            rights,
            server: self,
        })
    }
}

/// The query of `ServerAccess::text_reading` and its binds.
pub struct TextReading {
    pub sql: String,
    viewer: Option<String>,
    now: i64,
}

impl TextReading {
    /// `query` with the binds of `sql` after the ones it has.
    pub fn bind<'q>(
        &self,
        query: sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments>,
    ) -> sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments> {
        let TextReading {
            sql: _,
            viewer,
            now,
        } = self;
        let query = match viewer {
            Some(name) => query.bind(name.clone()),
            None => query,
        };
        query.bind(*now)
    }
}

pub struct ResolvedChannel {
    server: ServerAccess,
    /// A site admin views it with instance powers: as no member of its server, or past
    /// channel rules that hide it from their own membership.
    staff: bool,
    id: i64,
    kind: ChannelKind,
    name: String,
    slowmode: i64,
    text_only: bool,
    sensitive: bool,
    rights: ChannelAccess,
}

/// What a site admin does in a channel, or in its history, that only instance powers open to
/// them (`staff_gap`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StaffUse {
    /// Reads it or acts in it: only within `CHANNEL_OPEN_SECS` of a confirmation. Until then a
    /// channel their membership views without read history reads as it does for members.
    Open,
    /// Deletes messages without showing them, for a ban's purge or a running bulk delete job:
    /// no confirmation. The server's audit log names the staff as the deleter.
    Delete,
}

/// What only instance powers show the site admin `admin` in channel `id` of `server`, beyond
/// what their own membership (or none) shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StaffGap {
    /// Nothing.
    None,
    /// The messages from before their join: their membership views it without read history.
    History,
    /// The channel: their membership does not view it.
    View,
}

async fn staff_gap(db: &Db, server: &str, id: i64, admin: &User) -> sqlx::Result<StaffGap> {
    let plain = User {
        is_site_admin: false,
        ..admin.clone()
    };
    let ChannelAccess {
        view,
        send: _,
        history,
        mask: _,
    } = channel_access(db, server, id, Some(&plain)).await?;
    Ok(match (view, history) {
        (false, _) => StaffGap::View,
        (true, false) => StaffGap::History,
        (true, true) => StaffGap::None,
    })
}

/// How a site admin reaches a channel for `used`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdminReach {
    /// Through their membership, or as staff of a server they are no member of, where
    /// instance powers add nothing inside the channel.
    Own,
    /// Through their membership without the read history only instance powers add, while the
    /// channel is not open to them as staff.
    OwnHistory,
    /// With everything instance powers give.
    Staff,
    /// Not before a confirmation: only instance powers show the channel.
    Shut,
}

/// How the site admin `admin` reaches channel `id` of `server` for `used`: what only instance
/// powers show takes a confirmation (`staff_audit::channel_open`), except for deletes.
async fn admin_reach(
    db: &Db,
    server: &str,
    id: i64,
    admin: &User,
    used: StaffUse,
) -> Result<AdminReach, ApiError> {
    let gap = staff_gap(db, server, id, admin).await?;
    let open = match (gap, used) {
        (StaffGap::None, _) => return Ok(AdminReach::Own),
        (StaffGap::History | StaffGap::View, StaffUse::Delete) => true,
        (StaffGap::History | StaffGap::View, StaffUse::Open) => {
            staff_audit::channel_open(db, &admin.username, server, id).await?
        }
    };
    Ok(match (gap, open) {
        (_, true) => AdminReach::Staff,
        (StaffGap::History, false) => AdminReach::OwnHistory,
        (StaffGap::View | StaffGap::None, false) => AdminReach::Shut,
    })
}

/// The server of channel `id` for a site admin who confirms opening it, and whether only
/// instance powers open the channel or its history. Unknown channels and servers the admin
/// can't open get `not_found`.
pub(crate) async fn staff_channel_server(
    db: &Db,
    admin: &User,
    id: i64,
) -> Result<(String, bool), ApiError> {
    let server: String = sqlx::query("SELECT server FROM channels WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?
        .try_get(0)?;
    let access = resolve_server(db, &server, Some(admin), &Proof::none())
        .await
        .map_err(hidden)?;
    let needed = staff_gap(db, access.name(), id, admin).await? != StaffGap::None;
    Ok((access.name().to_string(), needed))
}

pub async fn resolve_channel(
    db: &Db,
    id: i64,
    viewer: Option<&User>,
    proof: &Proof<'_>,
) -> Result<ResolvedChannel, ApiError> {
    resolve_channel_for(db, id, viewer, proof, StaffUse::Open).await
}

/// `resolve_channel`, for what a site admin does in a channel only instance powers open.
pub async fn resolve_channel_for(
    db: &Db,
    id: i64,
    viewer: Option<&User>,
    proof: &Proof<'_>,
    used: StaffUse,
) -> Result<ResolvedChannel, ApiError> {
    let server: String = sqlx::query("SELECT server FROM channels WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?
        .try_get(0)?;
    resolve_server(db, &server, viewer, proof)
        .await
        .map_err(hidden)?
        .channel_for(db, id, used)
        .await
}

/// A channel as an incoming webhook that posts into it sees it: no viewer, and reading, sending,
/// files and embeds in that one channel (a webhook can always send in its own channel and
/// nowhere else). Unknown channels and servers being deleted get `not_found`.
pub(crate) async fn webhook_channel(db: &Db, id: i64) -> Result<ResolvedChannel, ApiError> {
    configured_channel(db, id, ChannelAccess::of(masks::WEBHOOK)).await
}

/// A read key delegates history in this single channel and never delegates membership.
pub(crate) async fn read_link_channel(
    db: &Db,
    id: i64,
    viewer: Option<&User>,
) -> Result<ResolvedChannel, ApiError> {
    let mut channel = configured_channel(db, id, ChannelAccess::of(masks::READ_LINK)).await?;
    if channel.kind() != ChannelKind::Text {
        return Err(not_found());
    }
    if let Some(u) = viewer
        && is_banned(db, channel.server().name(), &u.username).await?
    {
        return Err(not_found());
    }
    channel.server.lite.members_visible = false;
    Ok(channel)
}

async fn configured_channel(
    db: &Db,
    id: i64,
    rights: ChannelAccess,
) -> Result<ResolvedChannel, ApiError> {
    let r = sqlx::query(
        "SELECT c.kind, c.name, c.slowmode_seconds, c.sensitive, s.name, s.display_name, s.creator, s.password_hash, s.banner_color, s.name_color, s.public_read, s.guest_voice_opt_in, s.members_visible, s.guest_chat_opt_in, s.join_mode, s.listed, s.profiles_mode, s.description, s.icon_kind, s.seal, s.seal_forced, s.hide_members, s.icon_image, c.text_only FROM channels c JOIN servers s ON s.name = c.server WHERE c.id = $1 AND COALESCE(s.password_hash, '') <> '!purging'",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(not_found)?;
    Ok(ResolvedChannel {
        server: ServerAccess {
            lite: lite_row(db, &r, 4).await?,
            via: Via::Public,
            user: None,
            ticket: None,
        },
        staff: false,
        id,
        kind: ChannelKind::parse(&r.try_get::<String, _>(0)?)?,
        name: r.try_get(1)?,
        slowmode: r.try_get(2)?,
        sensitive: r.try_get::<i64, _>(3)? != 0,
        text_only: r.try_get::<i64, _>(23)? != 0,
        rights,
    })
}

/// The server permissions membership gives `username` (admin mask or roles), ignoring site
/// admin powers and timeouts; 0 for non-members.
pub(crate) async fn plain_member_perms(db: &Db, server: &str, username: &str) -> sqlx::Result<i64> {
    member_perms(db, server, username).await
}

/// A channel category with its server, for someone who manages channels there. Unknown ids,
/// servers the viewer can't open and viewers without Manage channels get the same 404.
pub async fn resolve_category(db: &Db, id: i64, viewer: &User) -> Result<ServerAccess, ApiError> {
    channel_list_part(
        db,
        "SELECT server FROM channel_categories WHERE id = $1",
        id,
        viewer,
    )
    .await
}

/// A channel separator with its server, for someone who manages channels there. Unknown ids,
/// servers the viewer can't open and viewers without Manage channels get the same 404.
pub async fn resolve_separator(db: &Db, id: i64, viewer: &User) -> Result<ServerAccess, ApiError> {
    channel_list_part(
        db,
        "SELECT server FROM channel_separators WHERE id = $1",
        id,
        viewer,
    )
    .await
}

/// The server of the part of a channel list `server_of` finds by `id`, for someone who manages
/// channels there; every denial is the same 404.
async fn channel_list_part(
    db: &Db,
    server_of: &'static str,
    id: i64,
    viewer: &User,
) -> Result<ServerAccess, ApiError> {
    let server: String = sqlx::query(server_of)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?
        .try_get(0)?;
    let access = resolve_server(db, &server, Some(viewer), &Proof::none())
        .await
        .map_err(hidden)?;
    match access.manages_channels(db).await? {
        true if access.perms(db).await? & Perm::ManageChannels as i64 != 0 => Ok(access),
        true => Err(timed_out_error()),
        false => Err(not_found()),
    }
}

impl ResolvedChannel {
    /// The view rules of this channel as stored now.
    pub(crate) async fn view_rules(&self, db: &Db) -> sqlx::Result<ViewRules> {
        view_rules(db, self.id()).await
    }

    pub fn id(&self) -> i64 {
        self.id
    }

    /// Whether a site admin views this channel with instance powers.
    pub fn staff_view(&self) -> bool {
        self.staff
    }

    pub fn server(&self) -> &ServerAccess {
        &self.server
    }

    pub fn kind(&self) -> ChannelKind {
        self.kind
    }

    pub(crate) fn allow_payload(&self, rich: bool) -> Result<(), ApiError> {
        if self.text_only && rich {
            return Err(ApiError::off_server(
                StatusCode::BAD_REQUEST,
                "This channel only accepts text",
                "text_only",
            ));
        }
        Ok(())
    }

    pub fn sensitive(&self) -> bool {
        self.sensitive
    }

    pub(crate) fn viewing_revision(&self) -> String {
        format!("{}.{}", self.id, u8::from(self.sensitive))
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Whether not everyone in its server may see the channel: everyone lacks View in it, or a
    /// rule denies View to a role or a member (its name stays inside that audience, e.g. in
    /// forward origins).
    pub async fn restricted(&self, db: &Db) -> Result<bool, ApiError> {
        Ok(sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT 1 FROM channels c WHERE c.id = $1 AND {}",
            private_sql()
        )))
        .bind(self.id)
        .fetch_optional(db)
        .await?
        .is_some())
    }

    /// Whether the viewer reads the `join` and `leave` messages of this channel: they say who
    /// is in its server, so they follow its member list.
    pub fn shows_membership_notices(&self) -> bool {
        subjects::lists_members(&self.server)
    }

    pub async fn read_since(&self, db: &Db) -> Result<Option<i64>, ApiError> {
        if self.rights.history {
            return Ok(None);
        }
        let Some(user) = &self.server.user else {
            return Ok(Some(now()));
        };
        let row = sqlx::query("SELECT joined_at FROM members WHERE server = $1 AND username = $2")
            .bind(self.server.name())
            .bind(&user.username)
            .fetch_optional(db)
            .await?;
        match &row {
            Some(r) => Ok(Some(r.try_get(0)?)),
            None => Ok(Some(now())),
        }
    }

    /// Which of `usernames` (lowercase) may be pinged in this channel: members of its server
    /// whose account is not being deleted and who can view the channel right now, in the given
    /// order. With `root` (a thread root in this channel), only those who can also read the root
    /// under the `read_since` rule of `resolve_message`, so a thread ping can be cleared by
    /// reading the thread. Batched (a fixed number of queries for any number of names). For
    /// pings only; never send the result to the caller, so it cannot probe who can see a channel.
    pub async fn viewers_among(
        &self,
        db: &Db,
        usernames: &[String],
        root: Option<i64>,
    ) -> Result<Vec<String>, ApiError> {
        let readable = match root {
            Some(id) => match message_row(db, id).await {
                Ok((scope, created_at)) if scope.channel_id == Some(self.id) => Some(created_at),
                Ok(_) | Err(ApiError(StatusCode::NOT_FOUND, _, _)) => return Ok(Vec::new()),
                Err(e) => return Err(e),
            },
            None => None,
        };
        Ok(channel_viewers(db, self.server.name(), self.id, usernames, readable).await?)
    }

    /// The channel rights that membership alone gives. A site admin acting inside a server
    /// gets no more than these, so nothing they do there shows that they are a site admin.
    pub async fn member_rights(&self, db: &Db) -> Result<ChannelAccess, ApiError> {
        match &self.server.user {
            Some(user) if user.is_site_admin => {
                let plain = User {
                    is_site_admin: false,
                    ..user.clone()
                };
                Ok(channel_access(db, self.server.name(), self.id, Some(&plain)).await?)
            }
            Some(_) | None => Ok(self.rights),
        }
    }

    /// What the viewer holds in this channel.
    pub fn rights(&self) -> ChannelAccess {
        self.rights
    }

    /// Refuses a viewer who is timed out in this channel's server. Every write in a server
    /// channel (sending, replies, threads, forwards, edits, reactions, pins, typing, voice and
    /// polls) goes through this; reading never does. Site admins are not exempt, so a timeout
    /// never shows who is one.
    pub async fn timeout_gate(&self, db: &Db) -> Result<(), ApiError> {
        let Some(user) = &self.server.user else {
            return Ok(());
        };
        match timed_out(db, self.server.name(), &user.username).await? {
            Some(_) => Err(timed_out_error()),
            None => Ok(()),
        }
    }

    /// Effective guest participation in this channel, using the site's current controls: a
    /// guest who holds Send in a text channel, or Connect and Speak in a voice channel.
    pub(crate) async fn guest_participation(&self, db: &Db) -> Result<bool, ApiError> {
        let (opted_in, control, need) = match self.kind {
            ChannelKind::Text => (
                self.server.lite.guest_chat,
                "guest_chat_enabled",
                masks::GUEST_CHAT,
            ),
            ChannelKind::Voice => (
                self.server.lite.guest_voice,
                "guest_voice_enabled",
                masks::GUEST_VOICE,
            ),
        };
        if self.server.user.is_some() || !opted_in || self.rights.mask as Mask & need != need {
            return Ok(false);
        }
        Ok(sqlx::query("SELECT 1 FROM settings WHERE key = $1 AND value = '1' AND EXISTS (SELECT 1 FROM settings WHERE key = 'guests_enabled' AND value = '1')")
            .bind(control).fetch_optional(db).await?.is_some())
    }

    /// Whether the viewer may send here at all: a member with the send permission in a text
    /// channel who is not timed out. Slow mode is not checked.
    async fn send_rights(&self, db: &Db) -> Result<&User, ApiError> {
        let Some(user) = &self.server.user else {
            return Err(ApiError::perm("Not a member", "member"));
        };
        self.server.require_member()?;
        if self.kind == ChannelKind::Voice {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Voice channels cannot receive messages".to_string(),
                None,
            ));
        }
        if !self.member_rights(db).await?.send {
            return Err(ApiError::perm(
                "No permission to send in this channel",
                "SendMessages",
            ));
        }
        self.timeout_gate(db).await?;
        Ok(user)
    }

    pub(crate) async fn can_send_text(&self, db: &Db) -> Result<bool, ApiError> {
        Ok(super::allowed(self.send_rights(db).await)?.is_some())
    }

    /// Whether the viewer may schedule a message here for later: `send_gate` without slow mode,
    /// which applies when the message is sent.
    pub(crate) async fn schedule_gate(&self, db: &Db) -> Result<(), ApiError> {
        self.send_rights(db).await.map(|_| ())
    }

    pub async fn send_gate(&self, db: &Db) -> Result<(), ApiError> {
        let user = self.send_rights(db).await?;
        if self.slowmode <= 0 {
            return Ok(());
        }
        if self.member_rights(db).await?.holds(held::BYPASS_SLOWMODE) {
            return Ok(());
        }
        self.slowmode_for(db, &user.username).await
    }

    /// Refuses a viewer who does not hold `bits` here through membership alone.
    pub(crate) async fn require_held(
        &self,
        db: &Db,
        bits: Mask,
        refusal: &str,
    ) -> Result<(), ApiError> {
        match self.member_rights(db).await?.holds(bits) {
            true => Ok(()),
            false => Err(ApiError::perm(refusal, bit_name(bits))),
        }
    }

    /// Whether the viewer may delete what other members posted here: Manage messages in this
    /// channel, which a timeout takes away. A site admin reaching the server as staff
    /// holds it.
    pub(crate) async fn moderates_messages(&self, db: &Db) -> Result<bool, ApiError> {
        if !self.rights.holds(held::DELETE) {
            return Ok(false);
        }
        match &self.server.user {
            Some(user) if self.server.via != Via::Staff => {
                Ok(timed_out(db, self.server.name(), &user.username)
                    .await?
                    .is_none())
            }
            Some(_) | None => Ok(true),
        }
    }

    /// Slow mode for `author` without exemptions: the wait since their last message here.
    pub(crate) async fn slowmode_for<'e>(
        &self,
        db: impl sqlx::Executor<'e, Database = sqlx::Any>,
        author: &str,
    ) -> Result<(), ApiError> {
        if self.slowmode <= 0 {
            return Ok(());
        }
        let last: Option<i64> = sqlx::query(
            "SELECT created_at FROM messages WHERE channel_id = $1 AND author = $2 AND kind IN ('user', 'poll') ORDER BY id DESC LIMIT 1",
        )
        .bind(self.id)
        .bind(author)
        .fetch_optional(db)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?;
        match last.map(|t| self.slowmode - (now() - t)) {
            Some(wait) if wait > 0 => Err(ApiError::rate(
                format!("Slow mode: wait {wait}s"),
                Some(wait.unsigned_abs()),
            )),
            _ => Ok(()),
        }
    }
}

/// Reactions, pins and edits per user. Each of them sends an event to everyone in the scope.
static ACTIONS: LazyLock<Keyed> = LazyLock::new(|| {
    Keyed::new(
        Policy::Window {
            limit: ACTIONS_MAX,
            window: Duration::from_secs(10),
        },
        100_000,
    )
});

pub(crate) const ACTIONS_MAX: u32 = 30;

fn pace(db: &Db, user: Option<&User>) -> Result<(), ApiError> {
    match user {
        Some(user) if !ACTIONS.take(&budget_key(db, &user.username), 1.0, Instant::now()) => {
            Err(slow_down())
        }
        Some(_) | None => Ok(()),
    }
}

/// Channel rules from rows of `channel_id` followed by a `perm_row`.
fn rules_by_channel(rows: &[AnyRow]) -> sqlx::Result<HashMap<i64, Vec<PermRow>>> {
    let mut rules: HashMap<i64, Vec<PermRow>> = HashMap::new();
    for r in rows {
        rules
            .entry(r.try_get(0)?)
            .or_default()
            .push(perm_row(r, 1)?);
    }
    Ok(rules)
}

/// A signed-in member of the channel's server, paced.
fn channel_actor(db: &Db, channel: &ResolvedChannel) -> Result<(), ApiError> {
    if channel.server.user.is_none() {
        return Err(ApiError::perm("Not a member", "member"));
    }
    channel.server.require_member()?;
    pace(db, channel.server.user.as_ref())
}

/// Whether a message of `kind` says that its author joined or left the server.
pub(crate) fn is_membership_notice(kind: &str) -> bool {
    matches!(kind, "join" | "leave")
}

pub struct MsgScope {
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    thread_root_id: Option<i64>,
    kind: String,
    author: String,
    media_id: Option<String>,
    media_kind: MediaKind,
    server: Option<String>,
    dm_users: Option<Vec<String>>,
}

impl MsgScope {
    pub fn channel_id(&self) -> Option<i64> {
        self.channel_id
    }

    pub fn dm_id(&self) -> Option<i64> {
        self.dm_id
    }

    pub fn thread_root_id(&self) -> Option<i64> {
        self.thread_root_id
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn author(&self) -> &str {
        &self.author
    }

    pub fn media_id(&self) -> Option<&str> {
        self.media_id.as_deref()
    }

    pub fn media_kind(&self) -> MediaKind {
        self.media_kind
    }

    pub fn server(&self) -> Option<&str> {
        self.server.as_deref()
    }

    pub fn dm_users(&self) -> Option<&[String]> {
        self.dm_users.as_deref()
    }
}

/// A message as a site admin reaches it through instance powers, for the staff tools only.
pub struct StaffMessage {
    scope: MsgScope,
}

impl StaffMessage {
    pub fn scope(&self) -> &MsgScope {
        &self.scope
    }
}

pub struct ResolvedMessage {
    scope: MsgScope,
    channel: Option<ResolvedChannel>,
    user: Option<User>,
}

/// Where a thread lives: a channel, or a DM and its two participants.
pub enum ThreadHome<'a> {
    Channel(&'a ResolvedChannel),
    Dm { id: i64, users: &'a [String] },
}

fn not_root() -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        "Threads only start on top-level messages".to_string(),
        None,
    )
}

async fn dm_pair(db: &Db, id: i64, live: bool) -> sqlx::Result<Option<Vec<String>>> {
    let sql = match live {
        true => format!("SELECT user_a, user_b FROM dms WHERE id = $1 AND {LIVE_DM}"),
        false => "SELECT user_a, user_b FROM dms WHERE id = $1".to_string(),
    };
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?;
    match row {
        Some(r) => Ok(Some(vec![r.try_get(0)?, r.try_get(1)?])),
        None => Ok(None),
    }
}

pub async fn resolve_dm(db: &Db, id: i64, user: &User) -> Result<Vec<String>, ApiError> {
    match dm_pair(db, id, true).await? {
        Some(users) if users.contains(&user.username) => Ok(users),
        _ => Err(not_found()),
    }
}

async fn message_row(db: &Db, id: i64) -> Result<(MsgScope, i64), ApiError> {
    let sql = format!(
        "SELECT m.channel_id, m.dm_id, m.thread_root_id, m.author, m.media_id, m.media_kind, m.created_at, m.kind FROM messages m WHERE m.id = $1 AND {LIVE_AUTHOR}"
    );
    let r = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?;
    Ok((
        MsgScope {
            channel_id: r.try_get(0)?,
            dm_id: r.try_get(1)?,
            thread_root_id: r.try_get(2)?,
            kind: r.try_get(7)?,
            author: r.try_get(3)?,
            media_id: r.try_get(4)?,
            media_kind: MediaKind::parse(&r.try_get::<String, _>(5)?)?,
            server: None,
            dm_users: None,
        },
        r.try_get(6)?,
    ))
}

impl ResolvedChannel {
    pub(crate) async fn message_scope(&self, db: &Db, id: i64) -> Result<MsgScope, ApiError> {
        let (mut scope, created_at) = message_row(db, id).await?;
        self.check_message(db, &mut scope, created_at).await?;
        Ok(scope)
    }

    async fn check_message(
        &self,
        db: &Db,
        scope: &mut MsgScope,
        created_at: i64,
    ) -> Result<(), ApiError> {
        if scope.channel_id != Some(self.id()) {
            return Err(not_found());
        }
        if let Some(since) = self.read_since(db).await? {
            if created_at < since {
                return Err(not_found());
            }
            if let Some(root) = scope.thread_root_id {
                let root_at: Option<i64> =
                    sqlx::query("SELECT created_at FROM messages WHERE id = $1")
                        .bind(root)
                        .fetch_optional(db)
                        .await?
                        .map(|r| r.try_get(0))
                        .transpose()?;
                if root_at.is_some_and(|at| at < since) {
                    return Err(not_found());
                }
            }
        }
        if is_membership_notice(&scope.kind) && !self.shows_membership_notices() {
            return Err(not_found());
        }
        scope.server = Some(self.server.name().to_string());
        Ok(())
    }
}

pub async fn resolve_message(
    db: &Db,
    id: i64,
    viewer: Option<&User>,
    proof: &Proof<'_>,
) -> Result<ResolvedMessage, ApiError> {
    resolve_message_for(db, id, viewer, proof, StaffUse::Open).await
}

/// `resolve_message`, for what a site admin does in a channel only instance powers open.
pub async fn resolve_message_for(
    db: &Db,
    id: i64,
    viewer: Option<&User>,
    proof: &Proof<'_>,
    used: StaffUse,
) -> Result<ResolvedMessage, ApiError> {
    let (mut scope, created_at) = message_row(db, id).await?;
    let channel = match (scope.channel_id, scope.dm_id) {
        (Some(cid), _) => {
            let channel = resolve_channel_for(db, cid, viewer, proof, used).await?;
            channel.check_message(db, &mut scope, created_at).await?;
            Some(channel)
        }
        (None, Some(did)) => {
            let users = dm_pair(db, did, false).await?.ok_or_else(not_found)?;
            if !viewer.is_some_and(|u| users.contains(&u.username)) {
                return Err(not_found());
            }
            scope.dm_users = Some(users);
            None
        }
        (None, None) if viewer.is_some_and(|u| u.username == scope.author) => None,
        (None, None) => return Err(not_found()),
    };
    Ok(ResolvedMessage {
        scope,
        channel,
        user: viewer.cloned(),
    })
}

pub async fn staff_message(db: &Db, user: &User, id: i64) -> Result<StaffMessage, ApiError> {
    if !user.is_site_admin {
        return Err(not_found());
    }
    let (mut scope, _) = message_row(db, id).await?;
    match (scope.channel_id, scope.dm_id) {
        (Some(cid), _) => {
            scope.server = sqlx::query("SELECT server FROM channels WHERE id = $1")
                .bind(cid)
                .fetch_optional(db)
                .await?
                .map(|r| r.try_get(0))
                .transpose()?;
        }
        (None, Some(did)) => scope.dm_users = dm_pair(db, did, false).await?,
        (None, None) => {}
    }
    Ok(StaffMessage { scope })
}

impl ResolvedMessage {
    pub fn scope(&self) -> &MsgScope {
        &self.scope
    }

    pub fn channel(&self) -> Option<&ResolvedChannel> {
        self.channel.as_ref()
    }

    /// A thread root of a channel: a top-level `user` or `poll` message there.
    pub fn thread_channel(&self) -> Result<&ResolvedChannel, ApiError> {
        match self.thread_home()? {
            ThreadHome::Channel(channel) => Ok(channel),
            ThreadHome::Dm { id: _, users: _ } => Err(not_root()),
        }
    }

    /// Where a thread rooted at this message lives: a top-level `user` or `poll` message of a
    /// channel or of a DM (with its two participants).
    pub fn thread_home(&self) -> Result<ThreadHome<'_>, ApiError> {
        if self.scope.thread_root_id.is_some()
            || !matches!(self.scope.kind.as_str(), "user" | "poll")
        {
            return Err(not_root());
        }
        match (&self.channel, self.scope.dm_id, &self.scope.dm_users) {
            (Some(channel), _, _) => Ok(ThreadHome::Channel(channel)),
            (None, Some(id), Some(users)) => Ok(ThreadHome::Dm { id, users }),
            (None, _, _) => Err(not_root()),
        }
    }

    /// Replying in the thread of this message (`id`), after its channel's `send_gate`: the first
    /// reply also needs the channel's Start threads permission.
    pub async fn thread_start_gate(&self, db: &Db, id: i64) -> Result<(), ApiError> {
        let channel = self.thread_channel()?;
        if channel.member_rights(db).await?.holds(held::THREADS) {
            return Ok(());
        }
        let started = sqlx::query("SELECT 1 FROM messages WHERE thread_root_id = $1 LIMIT 1")
            .bind(id)
            .fetch_optional(db)
            .await?
            .is_some();
        match started {
            true => Ok(()),
            false => Err(ApiError::perm(
                "No permission to start threads in this channel",
                "StartThreads",
            )),
        }
    }

    fn own(&self) -> bool {
        self.user
            .as_ref()
            .is_some_and(|u| u.username == self.scope.author)
    }

    /// Writing into the live DM `did` (reactions, pins, edits): a participant that neither
    /// blocked the other nor was blocked by them, paced.
    async fn dm_writer(&self, db: &Db, did: i64) -> Result<(), ApiError> {
        match (dm_pair(db, did, true).await?, &self.user) {
            (Some(users), Some(user)) if users.contains(&user.username) => {
                crate::api::blocks::check_dm_write(db, &user.username, &users).await?;
                pace(db, Some(user))
            }
            (_, _) => Err(not_found()),
        }
    }

    /// Adding a reaction: in a channel a signed-in member with its Add reactions permission, in
    /// a DM being a participant while both accounts are live and neither blocked the other.
    pub async fn react_gate(&self, db: &Db) -> Result<(), ApiError> {
        match (&self.channel, self.scope.dm_id) {
            (Some(channel), _) => {
                channel_actor(db, channel)?;
                channel
                    .require_held(db, held::REACT, "No permission to react in this channel")
                    .await?;
                channel.timeout_gate(db).await
            }
            (None, Some(did)) => self.dm_writer(db, did).await,
            (None, None) => Err(not_found()),
        }
    }

    /// Voting in a poll or adding an option: like reacting (a signed-in member with the
    /// channel's send permission who is not timed out, or a participant of a live DM where
    /// neither blocked the other).
    pub async fn vote_gate(&self, db: &Db) -> Result<(), ApiError> {
        match (&self.channel, self.scope.dm_id) {
            (Some(channel), _) => {
                channel_actor(db, channel)?;
                if !channel.member_rights(db).await?.send {
                    return Err(ApiError::perm(
                        "No permission to vote in this channel",
                        "SendMessages",
                    ));
                }
                channel.timeout_gate(db).await
            }
            (None, Some(did)) => self.dm_writer(db, did).await,
            (None, None) => Err(not_found()),
        }
    }

    /// Closing or reopening a poll: its author while they are still a member who may view and
    /// send in the channel (or a participant of a live DM where neither blocked the other), or
    /// in a channel a member with the Manage messages (`DeleteMessages`) permission there. Nobody
    /// who is timed out in the channel's server. `Ok(true)` when a moderator acts on someone
    /// else's poll.
    pub async fn poll_manage_gate(&self, db: &Db) -> Result<bool, ApiError> {
        let refused = || ApiError::perm("Only the author or a moderator can do this", "author");
        match (&self.channel, self.scope.dm_id) {
            (Some(channel), _) => {
                channel_actor(db, channel)?;
                channel.timeout_gate(db).await?;
                if self.own() {
                    let rights = channel.member_rights(db).await?;
                    if rights.view && rights.send {
                        return Ok(false);
                    }
                }
                match channel.member_rights(db).await?.holds(held::DELETE) {
                    true => Ok(!self.own()),
                    false => Err(refused()),
                }
            }
            (None, Some(did)) if self.own() => self.dm_writer(db, did).await.map(|()| false),
            (None, Some(_)) => Err(refused()),
            (None, None) => Err(not_found()),
        }
    }

    /// Pinning or unpinning: in a channel a signed-in member with its Pin messages and Send
    /// messages permissions, in a DM either participant while both accounts are live and neither
    /// blocked the other.
    pub async fn pin_gate(&self, db: &Db) -> Result<(), ApiError> {
        match (&self.channel, self.scope.dm_id) {
            (Some(channel), _) => {
                channel_actor(db, channel)?;
                channel.timeout_gate(db).await?;
                let rights = channel.member_rights(db).await?;
                match (rights.holds(held::PIN), rights.send) {
                    (true, true) => Ok(()),
                    (false, _) => Err(ApiError::perm(
                        "No permission to pin messages in this channel",
                        "PinMessages",
                    )),
                    (true, false) => Err(ApiError::perm(
                        "No permission to send in this channel",
                        "SendMessages",
                    )),
                }
            }
            (None, Some(did)) => self.dm_writer(db, did).await,
            (None, None) => Err(not_found()),
        }
    }

    /// Editing: only the author, and only while they could still send there (a member with the
    /// channel's send permission, or a participant of a live DM where neither blocked the other).
    /// Slow mode does not apply.
    pub async fn edit_gate(&self, db: &Db) -> Result<(), ApiError> {
        if !self.own() {
            return Err(ApiError::perm(
                "You can only edit your own messages",
                "author",
            ));
        }
        match (&self.channel, self.scope.dm_id) {
            (Some(channel), _) => {
                channel.server.require_member()?;
                pace(db, self.user.as_ref())?;
                if !channel.member_rights(db).await?.send {
                    return Err(ApiError::perm(
                        "No permission to send in this channel",
                        "SendMessages",
                    ));
                }
                channel.timeout_gate(db).await
            }
            (None, Some(did)) => self.dm_writer(db, did).await,
            (None, None) => Err(not_found()),
        }
    }

    /// Your own message, or one in a channel where you hold Manage messages whose author you
    /// rank above.
    pub async fn require_can_delete(&self, db: &Db) -> Result<(), ApiError> {
        let own = self.own();
        let allowed = own
            || match &self.channel {
                Some(channel) => {
                    channel.moderates_messages(db).await?
                        && channel.server.outranks(db, &self.scope.author).await?
                }
                None => false,
            };
        match allowed {
            true => Ok(()),
            false => Err(ApiError::perm("Not allowed", "author")),
        }
    }
}

/// Whether `actor` may delete `author`'s messages in channel `channel_id`: the channel through
/// the gate for `actor` (a site admin deletes there without confirming, `StaffUse::Delete`),
/// then the rule of `ResolvedMessage::require_can_delete` for a message of `author` there.
/// `None` for a channel `actor` can't see.
pub(crate) async fn may_delete_in(
    db: &Db,
    actor: &User,
    channel_id: i64,
    author: &str,
) -> Result<Option<bool>, ApiError> {
    let resolved = resolve_channel_for(
        db,
        channel_id,
        Some(actor),
        &Proof::none(),
        StaffUse::Delete,
    )
    .await;
    let channel = match resolved {
        Ok(channel) => channel,
        Err(e) if e.failed() => return Err(e),
        Err(_) => return Ok(None),
    };
    let message = ResolvedMessage {
        scope: MsgScope {
            channel_id: Some(channel_id),
            dm_id: None,
            thread_root_id: None,
            kind: "user".to_string(),
            author: author.to_string(),
            media_id: None,
            media_kind: MediaKind::Server,
            server: Some(channel.server().name().to_string()),
            dm_users: None,
        },
        channel: Some(channel),
        user: Some(actor.clone()),
    };
    match message.require_can_delete(db).await {
        Ok(()) => Ok(Some(true)),
        Err(e) if e.failed() => Err(e),
        Err(_) => Ok(Some(false)),
    }
}

/// The text-channel rights of `user` across the servers it is a member of (unread counts, the
/// inbox), for the channels where they are not simply the rights of everyone: channels with rules
/// or restrictions, and every channel of a server whose @everyone lacks View, Send or Read
/// history. Membership is the proof: rows of servers the user has not joined never load. A site
/// admin counts as a plain member, except in the channels they have open as staff
/// (`staff_audit::open_channels`), which give them every right.
pub(crate) async fn member_channel_rights(
    db: &Db,
    user: &User,
) -> Result<HashMap<i64, ChannelAccess>, ApiError> {
    let open = (masks::VIEW | masks::SEND | masks::HISTORY) as i64;
    let channels = sqlx::query(
        "SELECT c.id, c.server, c.restrict_view, c.restrict_send, s.everyone_perms FROM channels c JOIN members mem ON mem.server = c.server AND mem.username = $1 JOIN servers s ON s.name = c.server WHERE c.kind = 'text' AND (c.restrict_view <> 0 OR c.restrict_send <> 0 OR (s.everyone_perms IS NOT NULL AND (s.everyone_perms & $2) <> $2) OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = c.id))",
    )
    .bind(&user.username)
    .bind(open)
    .fetch_all(db)
    .await?;
    if channels.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT cp.channel_id, {} FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id JOIN members mem ON mem.server = c.server AND mem.username = $1 WHERE c.kind = 'text'",
        perm_columns("cp")
    )))
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    let rules = rules_by_channel(&rows)?;
    let member = User {
        is_site_admin: false,
        ..user.clone()
    };
    let opened = match user.is_site_admin {
        true => staff_audit::open_channels(db, &user.username).await?,
        false => Vec::new(),
    };
    let staff = Standing {
        who: rchat_perms::eval::Who::Staff,
        subjects: vec![format!("u:{}", user.username)],
    };
    let mut standings: HashMap<String, Standing> = HashMap::new();
    let mut out = HashMap::with_capacity(channels.len());
    for r in &channels {
        let (id, server): (i64, String) = (r.try_get(0)?, r.try_get(1)?);
        let restrict = Restrict::read(r, 2)?;
        let everyone = everyone_mask(r.try_get(4)?);
        if !standings.contains_key(&server) {
            let found = standing(db, &server, Some(&member), VISITOR_CAPS).await?;
            standings.insert(server.clone(), found);
        }
        let list = rules.get(&id).map(Vec::as_slice).unwrap_or_default();
        let viewer = match opened.contains(&id) {
            true => &staff,
            false => &standings[&server],
        };
        let mask = channel_mask(list, viewer, everyone, restrict, false, false);
        out.insert(id, ChannelAccess::of(mask));
    }
    Ok(out)
}

/// Servers a guest may search: the ones its live grants in `proof` open.
pub(crate) async fn granted_servers(db: &Db, proof: &Proof<'_>) -> sqlx::Result<Vec<String>> {
    live_grant_servers(db, &proof.grants, proof.grant_ttl).await
}

/// Servers where `user` manages channels (search sees their restricted channels).
pub(crate) async fn channel_manager_servers(db: &Db, user: &User) -> sqlx::Result<Vec<String>> {
    rules::channel_manager_servers(db, user).await
}

/// WS event filtering and voice eviction: can `username` (or a guest) see channel `cid` of
/// `server` right now, and until when that answer holds. A site admin sees a channel only
/// instance powers open while they have it open (`staff_audit::open_until`): that answer ends
/// when the channel closes, and a closed one holds until they confirm again
/// (`WsEvent::StaffViewOpened`); when that can't be read, it is closed until the next event.
/// Every other answer holds (`None`) until the channel's rules or the viewer's memberships
/// change. Never answers a client with target data.
pub(crate) async fn ws_channel_seen(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    cid: i64,
    username: Option<&str>,
) -> sqlx::Result<(bool, Option<i64>)> {
    let user = match username {
        Some(name) => crate::db::get_user(db, name).await?,
        None => None,
    };
    let view = channel_access(db, server, cid, user.as_ref()).await?.view;
    match user {
        Some(admin)
            if view
                && admin.is_site_admin
                && staff_gap(db, server, cid, &admin).await? == StaffGap::View =>
        {
            match staff_audit::open_until(db, &admin.username, server, cid).await {
                Ok(Some(until)) => Ok((true, Some(until))),
                Ok(None) => Ok((false, None)),
                Err(_) => Ok((false, Some(now()))),
            }
        }
        Some(_) | None => Ok((view, None)),
    }
}

/// The view rules of a channel (`restrict_view` and its overrides), taken before it is deleted
/// so `channel_deleted` and the `layout_changed` after it reach only those who could view it.
/// Routing only, never sent to a client.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ViewRules {
    pub restrict: Restrict,
    pub rules: Vec<PermRow>,
    /// The @everyone mask of the channel's server; a node that does not send it means the
    /// default.
    #[serde(default)]
    pub everyone: Option<i64>,
}

/// The current view rules of channel `cid`, for `ws_view_under` once it is gone.
#[cfg(test)]
pub(crate) async fn ws_view_rules(
    _: &crate::ws::Layer,
    db: &Db,
    cid: i64,
) -> sqlx::Result<ViewRules> {
    view_rules(db, cid).await
}

/// WS event filtering for a deleted channel: could `username` (or a guest) view a channel of
/// `server` with these `rules`, under the same rule as `ws_channel_seen`. Never answers a client.
pub(crate) async fn ws_view_under(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    rules: &ViewRules,
    username: Option<&str>,
) -> sqlx::Result<bool> {
    let user = match username {
        Some(name) => crate::db::get_user(db, name).await?,
        None => None,
    };
    view_under(db, server, rules, user.as_ref()).await
}

/// `layout_changed` filtering: whether `username` manages channels in `server`, so it sees
/// categories without a channel it can view. Guests never do. Never answers a client.
pub(crate) async fn ws_manages_channels(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    username: Option<&str>,
) -> sqlx::Result<bool> {
    let user = match username {
        Some(name) => crate::db::get_user(db, name).await?,
        None => None,
    };
    match user {
        Some(user) => {
            Ok(effective_perms(db, server, &user).await? & Perm::ManageChannels as i64 != 0)
        }
        None => Ok(false),
    }
}

/// `p2p_who`: from when `username` may read channel `cid` of `server`, under the same rule as
/// `ResolvedChannel::read_since`, also for a site admin: what only instance powers show them
/// stays shut (the channel) or reads as for members (its history) while it is not open to
/// them as staff. `None` when they can't view it (or on any error), `Some(None)` with read
/// history, otherwise `Some(Some(joined_at))` (now for non-members). Never answers a client
/// with target data.
pub(crate) async fn ws_channel_read_since(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    cid: i64,
    username: &str,
) -> Option<Option<i64>> {
    let user = crate::db::get_user(db, username).await.ok()??;
    let access = channel_access(db, server, cid, Some(&user)).await.ok()?;
    if !access.view {
        return None;
    }
    let history = match user.is_site_admin {
        true => match admin_reach(db, server, cid, &user, StaffUse::Open)
            .await
            .ok()?
        {
            AdminReach::Own | AdminReach::Staff => access.history,
            AdminReach::OwnHistory => false,
            AdminReach::Shut => return None,
        },
        false => access.history,
    };
    if history {
        return Some(None);
    }
    let row = sqlx::query("SELECT joined_at FROM members WHERE server = $1 AND username = $2")
        .bind(server)
        .bind(username)
        .fetch_optional(db)
        .await
        .ok()?;
    match row {
        Some(r) => Some(Some(r.try_get(0).ok()?)),
        None => Some(Some(now())),
    }
}

/// Poll updates: from when `username` (or a guest) may read channel `cid` of `server`, under
/// the rule of `ResolvedChannel::read_since`. `None` when they can't view it (or on any
/// error), `Some(None)` with read history. Never answers a client with target data.
pub(crate) async fn ws_read_floor(
    layer: &crate::ws::Layer,
    db: &Db,
    server: &str,
    cid: i64,
    username: Option<&str>,
) -> Option<Option<i64>> {
    match username {
        Some(name) => ws_channel_read_since(layer, db, server, cid, name).await,
        None => {
            let access = channel_access(db, server, cid, None).await.ok()?;
            match (access.view, access.history) {
                (false, _) => None,
                (true, true) => Some(None),
                (true, false) => Some(Some(now())),
            }
        }
    }
}

/// Live thread events: when the thread of a channel message started. With `root`, `id` is the
/// thread root: `Some(Some(created_at))`. Otherwise `id` is any message: `Some(None)` outside any
/// thread, `Some(Some(created_at of its root))` for a reply. `None` once the message or its root
/// is gone. Never answers a client with target data.
pub(crate) async fn ws_thread_start(
    _: &crate::ws::Layer,
    db: &Db,
    id: i64,
    root: bool,
) -> sqlx::Result<Option<Option<i64>>> {
    if root {
        return Ok(sqlx::query("SELECT created_at FROM messages WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get::<i64, _>(0))
            .transpose()?
            .map(Some));
    }
    let row = sqlx::query("SELECT m.thread_root_id, rt.created_at FROM messages m LEFT JOIN messages rt ON rt.id = m.thread_root_id WHERE m.id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    let Some(r) = row else {
        return Ok(None);
    };
    Ok(
        match (
            r.try_get::<Option<i64>, _>(0)?,
            r.try_get::<Option<i64>, _>(1)?,
        ) {
            (None, _) => Some(None),
            (Some(_), Some(at)) => Some(Some(at)),
            (Some(_), None) => None,
        },
    )
}

/// Whether `username` (or a guest) can view the channel, with any error meaning "not viewable".
#[cfg(test)]
pub(crate) async fn ws_channel_viewable(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    cid: i64,
    username: Option<&str>,
) -> bool {
    channel_viewable(db, server, cid, username, false).await
}

/// Voice: whether `username` may be in the voice channel through membership alone: an account
/// that holds View and Connect there, or a guest who holds Connect and Speak. A site admin gets
/// no more than a plain member here, so nobody sees them in a voice channel hidden from them.
pub(crate) async fn ws_voice_viewable(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    cid: i64,
    username: &str,
) -> bool {
    match channel_access_of(db, server, cid, Some(username), true).await {
        Ok((access, true)) => access.holds(masks::VIEW | held::CONNECT),
        Ok((access, false)) => access.holds(masks::VIEW | masks::GUEST_VOICE),
        Err(_) => false,
    }
}

/// Voice: what `username` holds in the channel through membership alone. Nothing on an error.
pub(crate) async fn ws_voice_rights(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    cid: i64,
    username: &str,
) -> ChannelAccess {
    match channel_access_of(db, server, cid, Some(username), true).await {
        Ok((access, _)) => access,
        Err(_) => ChannelAccess::of(0),
    }
}

/// Voice: which of `users` in the voice channel are muted for everyone there: those who are
/// timed out in `server` or hold no Speak in the channel.
pub(crate) async fn ws_voice_silenced(
    layer: &crate::ws::Layer,
    db: &Db,
    server: &str,
    cid: i64,
    users: &[String],
) -> Result<HashSet<String>, ApiError> {
    let timed_out = crate::api::timeouts::running_timeouts(db, server, users).await?;
    let masks = member_masks(db, server, cid, users).await?;
    let mut silenced = HashSet::new();
    for name in users {
        let speaks = match masks.get(name) {
            Some(mask) => mask & held::SPEAK != 0,
            None => ws_voice_rights(layer, db, server, cid, name)
                .await
                .holds(held::SPEAK),
        };
        if !speaks || timed_out.contains_key(name) {
            silenced.insert(name.clone());
        }
    }
    Ok(silenced)
}

/// `member_timeout` fan-out: whether `username` sees the timeouts of `server` (the Timeout
/// members permission, or a site admin). A timeout keeps this read-only view (`view_perms`).
/// Never sent to anyone else.
pub(crate) async fn ws_sees_timeouts(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    username: &str,
    site_admin: bool,
) -> sqlx::Result<bool> {
    if site_admin {
        return Ok(true);
    }
    Ok(member_perms(db, server, username).await? & Perm::TimeoutMembers as i64 != 0)
}

/// What a caller wants with reports: to read them, to handle them, or to read them with the
/// instance's powers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportMode {
    Read,
    Write,
    Staff,
}

/// The reports a viewer may see: those to the moderators of `server`, or without one those to
/// the instance.
#[derive(Clone, Debug)]
pub struct ReportScope {
    pub server: Option<String>,
    pub viewer: String,
    /// The channels of the server the viewer can't view.
    pub closed: Vec<i64>,
    /// The viewer sees every channel, also private ones that are gone.
    pub all_channels: bool,
    /// A site admin reading with the instance's powers.
    pub staff: bool,
}

impl ReportScope {
    pub fn kind(&self) -> crate::api::reports::ReportKind {
        match self.server {
            Some(_) => crate::api::reports::ReportKind::Server,
            None => crate::api::reports::ReportKind::Instance,
        }
    }
}

/// The reports `user` may read or handle.
///
/// With a server: its reports, for a member who holds Manage reports themselves. Reading keeps
/// working during a timeout; handling does not (403). A site admin who holds the permission as
/// a member reads and handles the reports as that member, in the channels the membership
/// shows. A site admin who doesn't (not a member, or a member without the permission) may
/// read with the instance's powers (`staff`: every channel) and never handle. `Staff` reads
/// that way whatever the membership, for the site admin only: everyone else gets
/// `not_found()`. Everyone else who is not a member gets `denied()`, a member without the
/// permission 403.
///
/// Without a server: the reports to the instance, for the site admin; everyone else gets
/// `not_found()`.
pub async fn report_scope(
    db: &Db,
    user: &User,
    server: Option<&str>,
    mode: ReportMode,
) -> Result<ReportScope, ApiError> {
    let Some(name) = server else {
        return match user.is_site_admin {
            true => Ok(ReportScope {
                server: None,
                viewer: user.username.clone(),
                closed: Vec::new(),
                all_channels: true,
                staff: false,
            }),
            false => Err(not_found()),
        };
    };
    let access = resolve_server(db, name, Some(user), &Proof::none()).await?;
    let member = access.is_member();
    let holds =
        member && access.member_perms(db, &user.username).await? & Perm::ManageReports as i64 != 0;
    let staff = access.site_admin() && (mode == ReportMode::Staff || !holds);
    match (mode, staff, member) {
        (ReportMode::Read | ReportMode::Staff, true, _) => {}
        (ReportMode::Staff, false, _) => return Err(not_found()),
        (ReportMode::Read, false, true) => {
            if !holds {
                return Err(ApiError::perm(
                    "Missing permission",
                    Perm::ManageReports.name(),
                ));
            }
        }
        (ReportMode::Write, _, true) => match access.as_member() {
            Some(own) => own.require_perm(db, Perm::ManageReports).await?,
            None => access.require_perm(db, Perm::ManageReports).await?,
        },
        (ReportMode::Read | ReportMode::Write, _, false) => return Err(denied()),
    }
    let view = match (staff, access.as_member()) {
        (false, Some(own)) => own,
        (true, Some(_)) | (_, None) => access,
    };
    let all_channels = staff || view.manages_channels(db).await?;
    let closed = match all_channels {
        true => Vec::new(),
        false => view
            .channel_rights(db)
            .await?
            .into_iter()
            .filter(|(_, rights)| !rights.view)
            .map(|(id, _)| id)
            .collect(),
    };
    if staff {
        staff_audit::report_view(db, &user.username, view.name()).await?;
    }
    Ok(ReportScope {
        server: Some(view.name().to_string()),
        viewer: user.username.clone(),
        closed,
        all_channels,
        staff,
    })
}

impl ReportScope {
    /// Who an action in this scope is logged as in the server's audit log: the viewer, or the
    /// unnamed instance staff.
    pub fn actor(&self) -> Actor {
        match self.staff {
            true => Actor::Staff,
            false => Actor::User(self.viewer.clone()),
        }
    }

    /// Whether `username` (lowercase) can be given a report of this scope to handle: for a
    /// server a member who holds Manage reports themselves and can view `channel`, the channel
    /// of the reported message (its id and whether it was private); otherwise only the viewer.
    pub async fn handler(
        &self,
        db: &Db,
        username: &str,
        channel: Option<(i64, bool)>,
    ) -> Result<bool, ApiError> {
        match &self.server {
            Some(server) => Ok(sees_reports_now(db, server, username, channel).await?),
            None => Ok(username == self.viewer),
        }
    }

    /// Whether `username` (lowercase) is a member of the scope's server or, for the reports to
    /// the instance, an account.
    pub async fn has_member(&self, db: &Db, username: &str) -> Result<bool, ApiError> {
        match &self.server {
            Some(server) => Ok(is_member(db, server, username).await?),
            None => Ok(crate::db::get_user(db, username).await?.is_some()),
        }
    }
}

/// The servers where `user` holds Manage reports through their own membership (an admin's
/// permissions or a role), by name. Being a site admin adds none.
pub(crate) async fn report_servers(db: &Db, user: &User) -> sqlx::Result<Vec<String>> {
    let bit = Perm::ManageReports as i64;
    let rows = sqlx::query("SELECT server FROM members WHERE username = $1 AND is_admin <> 0 AND (perms = 0 OR (perms & $2) <> 0) UNION SELECT ur.server FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN members m ON m.server = ur.server AND m.username = ur.username WHERE ur.username = $1 AND m.is_admin = 0 AND (r.perms & $2) <> 0 ORDER BY 1")
        .bind(&user.username)
        .bind(bit)
        .fetch_all(db)
        .await?;
    rows.iter().map(|r| r.try_get(0)).collect()
}

/// `reports_changed` fan-out: whether `username` handles the reports of `server`, which takes
/// their own Manage reports permission as a member, and may see a report from `channel` (its
/// id and whether it was private), as the report list decides it: a channel they can view, or
/// one that is gone and was open to everyone, unless they manage channels. Being a site admin
/// gives nothing here: the event would show who they are. Never answers a client.
pub(crate) async fn ws_sees_reports(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    username: &str,
    channel: Option<(i64, bool)>,
) -> sqlx::Result<bool> {
    sees_reports_now(db, server, username, channel).await
}

async fn sees_reports_now(
    db: &Db,
    server: &str,
    username: &str,
    channel: Option<(i64, bool)>,
) -> sqlx::Result<bool> {
    let perms = member_perms(db, server, username).await?;
    if perms & Perm::ManageReports as i64 == 0 {
        return Ok(false);
    }
    let Some((channel, private)) = channel else {
        return Ok(true);
    };
    if perms & Perm::ManageChannels as i64 != 0 {
        return Ok(true);
    }
    let exists = sqlx::query("SELECT 1 FROM channels WHERE id = $1 AND server = $2")
        .bind(channel)
        .bind(server)
        .fetch_optional(db)
        .await?
        .is_some();
    Ok(match exists {
        true => channel_viewable(db, server, channel, Some(username), true).await,
        false => !private,
    })
}

/// WS ban fan-out and `look`: whether `username` is banned from `server`. Only used to drop
/// events or skip a subscription, never sent to anyone else.
pub(crate) async fn ws_banned(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    username: &str,
) -> sqlx::Result<bool> {
    is_banned(db, server, username).await
}

/// Where a typing indicator goes: a channel or thread (server and channel) or a DM (its two
/// participants).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TypingPlace {
    pub server: Option<String>,
    pub channel_id: Option<i64>,
    pub dm_id: Option<i64>,
    pub dm_users: Option<Vec<String>>,
    pub display_name: String,
}

/// `typing`: where `username` may show as typing in `scope` (`c{channel}`, `t{root}` or
/// `d{dm}`), which is wherever they could send a message now (slow mode aside). `None` for
/// anything else, including errors. Never answers a client.
pub(crate) fn typing_scope(scope: &str) -> Option<(&str, i64)> {
    let (kind, id) = scope.split_at_checked(1)?;
    let id: i64 = id.parse().ok().filter(|id| *id > 0)?;
    Some((kind, id))
}

pub(crate) async fn ws_typing_place(
    _: &crate::ws::Layer,
    db: &Db,
    username: &str,
    scope: &str,
) -> Option<TypingPlace> {
    let (kind, id) = typing_scope(scope)?;
    let user = crate::db::get_user(db, username).await.ok()??;
    let display_name = user.display_name.clone();
    let channel = |channel: &ResolvedChannel| TypingPlace {
        server: Some(channel.server.name().to_string()),
        channel_id: Some(channel.id),
        dm_id: None,
        dm_users: None,
        display_name: display_name.clone(),
    };
    let dm = async |id: i64| {
        let users = resolve_dm(db, id, &user).await.ok()?;
        crate::api::blocks::check_dm_write(db, username, &users)
            .await
            .ok()?;
        Some(TypingPlace {
            server: None,
            channel_id: None,
            dm_id: Some(id),
            dm_users: Some(users),
            display_name: display_name.clone(),
        })
    };
    match kind {
        "c" => {
            let resolved = resolve_channel(db, id, Some(&user), &Proof::none())
                .await
                .ok()?;
            resolved.send_rights(db).await.ok()?;
            Some(channel(&resolved))
        }
        "t" => {
            let root = resolve_message(db, id, Some(&user), &Proof::none())
                .await
                .ok()?;
            match root.thread_home().ok()? {
                ThreadHome::Channel(resolved) => {
                    resolved.send_rights(db).await.ok()?;
                    Some(channel(resolved))
                }
                ThreadHome::Dm { id, users: _ } => dm(id).await,
            }
        }
        "d" => dm(id).await,
        _ => None,
    }
}

#[cfg(test)]
pub(crate) async fn reference_channel_access(
    db: &Db,
    server: &str,
    cid: i64,
    user: Option<&User>,
) -> sqlx::Result<ChannelAccess> {
    channel_access(db, server, cid, user).await
}

fn ws_result(res: Result<bool, ApiError>) -> sqlx::Result<bool> {
    match res {
        Ok(open) => Ok(open),
        Err(e) if e.failed() => Err(sqlx::Error::Protocol(e.1)),
        Err(_) => Ok(false),
    }
}

pub(crate) async fn ws_server_open(
    _: &crate::ws::Layer,
    db: &Db,
    name: &str,
    username: Option<&str>,
    site_admin: bool,
    proof: &Proof<'_>,
) -> sqlx::Result<bool> {
    let who = Who {
        username,
        site_admin,
    };
    ws_result(gate(db, name, who, proof).await.map(|g| !g.banned))
}

/// When the guest grant `grant` on `server` ends because the extra password it came through
/// expires (None: no such expiry). Realtime subscriptions recheck at this time.
pub(crate) async fn ws_grant_deadline(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
    grant: &str,
) -> sqlx::Result<Option<i64>> {
    Ok(sqlx::query(
        "SELECT p.expires_at FROM guest_grants g JOIN server_passwords p ON p.id = g.password_id WHERE g.\"grant\" = $1 AND g.server = $2",
    )
    .bind(crate::db::secret_key(grant))
    .bind(server)
    .fetch_optional(db)
    .await?
    .map(|r| r.try_get::<Option<i64>, _>(0))
    .transpose()?
    .flatten())
}

/// Servers with an extra password that expired in `(since, until]`, so realtime connections
/// let in through them can recheck even when nothing else happens on the server.
pub(crate) async fn servers_with_expired_passwords(
    db: &Db,
    since: i64,
    until: i64,
) -> sqlx::Result<Vec<String>> {
    sqlx::query(
        "SELECT DISTINCT server FROM server_passwords WHERE revoked_at IS NULL AND expires_at > $1 AND expires_at <= $2",
    )
    .bind(since)
    .bind(until)
    .fetch_all(db)
    .await?
    .iter()
    .map(|r| r.try_get(0))
    .collect()
}

pub(crate) async fn ws_voice_channel(
    _: &crate::ws::Layer,
    db: &Db,
    username: &str,
    id: i64,
) -> Result<ResolvedChannel, ApiError> {
    let gone = || ApiError(StatusCode::NOT_FOUND, "Channel not found".to_string(), None);
    let user = crate::db::get_user(db, username).await?.ok_or_else(gone)?;
    match resolve_channel(db, id, Some(&user), &Proof::none()).await {
        Ok(channel) => Ok(channel),
        Err(e) if e.failed() => Err(e),
        Err(_) => Err(gone()),
    }
}

/// The voice channel `id` as a guest holding `grant` (if any) sees it.
pub(crate) async fn ws_guest_voice_channel(
    _: &crate::ws::Layer,
    db: &Db,
    id: i64,
    grant: Option<&str>,
    limits: &Limits,
) -> Result<ResolvedChannel, ApiError> {
    let proof = Proof::grants(grant.map(str::to_string).into_iter().collect(), limits);
    match resolve_channel(db, id, None, &proof).await {
        Ok(channel) => Ok(channel),
        Err(e) if e.failed() => Err(e),
        Err(_) => Err(ApiError(
            StatusCode::NOT_FOUND,
            "Channel not found".to_string(),
            None,
        )),
    }
}

/// Realtime gates and reposts: whether `username` is a member of `server`. Never answers a
/// client.
pub(crate) async fn ws_is_member<'e, E>(
    _: &crate::ws::Layer,
    ex: E,
    server: &str,
    username: &str,
) -> sqlx::Result<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    is_member(ex, server, username).await
}

/// Realtime reposts: the admin flag and stored permission bits of `username` in `server`.
/// Never answers a client.
pub(crate) async fn ws_member_role<'e, E>(
    _: &crate::ws::Layer,
    ex: E,
    server: &str,
    username: &str,
) -> sqlx::Result<Option<(bool, i64)>>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    member_role(ex, server, username).await
}

/// Whether `username` is a member of `server`. Never answers a client.
async fn is_member<'e, E>(ex: E, server: &str, username: &str) -> sqlx::Result<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    Ok(
        sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(username)
            .fetch_optional(ex)
            .await?
            .is_some(),
    )
}

/// The admin flag and stored permission bits of `username` in `server`, `None` for a
/// non-member. Never answers a client.
async fn member_role<'e, E>(
    ex: E,
    server: &str,
    username: &str,
) -> sqlx::Result<Option<(bool, i64)>>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row =
        sqlx::query("SELECT is_admin, perms FROM members WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(username)
            .fetch_optional(ex)
            .await?;
    match row {
        Some(r) => Ok(Some((r.try_get::<i64, _>(0)? != 0, r.try_get(1)?))),
        None => Ok(None),
    }
}

/// Realtime gates and reposts: the server and current row of channel `id`. Never answers a
/// client.
pub(crate) async fn ws_channel_now(
    _: &crate::ws::Layer,
    db: &Db,
    id: i64,
) -> sqlx::Result<Option<(String, Channel)>> {
    let row =
        sqlx::query("SELECT server, name, kind, slowmode_seconds, restrict_view, restrict_send, topic, category_id, position, sensitive, text_only, perm_sync FROM channels WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    match row {
        Some(r) => Ok(Some((
            r.try_get(0)?,
            Channel {
                id,
                name: r.try_get(1)?,
                kind: ChannelKind::parse(&r.try_get::<String, _>(2)?)?,
                slowmode_seconds: r.try_get(3)?,
                restrict_view: r.try_get::<i64, _>(4)? != 0,
                restrict_send: r.try_get::<i64, _>(5)? != 0,
                topic: r.try_get(6)?,
                category_id: r.try_get(7)?,
                position: r.try_get(8)?,
                sensitive: r.try_get::<i64, _>(9)? != 0,
                text_only: r.try_get::<i64, _>(10)? != 0,
                perm_sync: r.try_get::<i64, _>(11)? != 0,
                my_perms: None,
            },
        ))),
        None => Ok(None),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ChannelPolicy {
    pub server: String,
    pub public_view: bool,
    pub limits_history: bool,
}

/// Channel rules shared by every connection: whether everyone in the server may view it,
/// and whether someone who views it can lack read history.
pub(crate) async fn ws_channel_policy(
    _: &crate::ws::Layer,
    db: &Db,
    cid: i64,
) -> sqlx::Result<Option<ChannelPolicy>> {
    channel_policy_now(db, cid).await
}

async fn channel_policy_now(db: &Db, cid: i64) -> sqlx::Result<Option<ChannelPolicy>> {
    let sql = format!(
        "SELECT c.server, CASE WHEN {} THEN 0 ELSE 1 END, CASE WHEN NOT {} OR {} THEN 1 ELSE 0 END FROM channels c WHERE c.id = $1",
        private_sql(),
        everyone_stage_sql(masks::HISTORY),
        denied_to_some_sql(masks::HISTORY),
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(cid)
        .fetch_optional(db)
        .await?
        .map(|r| {
            Ok(ChannelPolicy {
                server: r.try_get(0)?,
                public_view: r.try_get::<i64, _>(1)? != 0,
                limits_history: r.try_get::<i64, _>(2)? != 0,
            })
        })
        .transpose()
}

/// Whether someone who views channel `cid` can lack read history there.
pub(crate) async fn limits_history(db: &Db, cid: i64) -> sqlx::Result<bool> {
    Ok(channel_policy_now(db, cid)
        .await?
        .is_some_and(|policy| policy.limits_history))
}

/// Realtime subscription checks: `None` when `server` doesn't exist, otherwise its password
/// hash. Never answers a client.
pub(crate) async fn ws_server_password_hash(
    _: &crate::ws::Layer,
    db: &Db,
    server: &str,
) -> sqlx::Result<Option<Option<String>>> {
    Ok(
        sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
            .bind(server)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get(0).unwrap_or(None)),
    )
}

/// Event rewrites: the summary of server `name`, `None` when it doesn't exist or is being purged.
/// Never answers a client.
pub(crate) async fn ws_server_lite(
    _: &crate::ws::Layer,
    db: &Db,
    name: &str,
) -> sqlx::Result<Option<ServerSummaryLite>> {
    server_lite_now(db, name).await
}

/// The summary of server `name`, `None` when it doesn't exist or is being purged.
async fn server_lite_now(db: &Db, name: &str) -> sqlx::Result<Option<ServerSummaryLite>> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {LITE_COLUMNS} FROM servers WHERE name = $1 AND COALESCE(password_hash, '') <> '!purging'"
    )))
    .bind(name)
    .fetch_optional(db)
    .await?;
    match row {
        Some(r) => Ok(Some(lite_row(db, &r, 0).await?)),
        None => Ok(None),
    }
}

/// The servers `user` is a member of. Never answers a client.
pub(crate) async fn ws_member_servers(
    _: &crate::ws::Layer,
    db: &Db,
    user: &str,
) -> sqlx::Result<HashSet<String>> {
    Ok(
        sqlx::query("SELECT server FROM members WHERE username = $1")
            .bind(user)
            .fetch_all(db)
            .await?
            .iter()
            .filter_map(|r| r.try_get(0).ok())
            .collect(),
    )
}

/// Which of `servers` keep their members to themselves (`members_visible` off). Never answers a
/// client.
pub(crate) async fn ws_closed_servers(
    _: &crate::ws::Layer,
    db: &Db,
    servers: &[&str],
) -> sqlx::Result<HashSet<String>> {
    if servers.is_empty() {
        return Ok(HashSet::new());
    }
    let sql = format!(
        "SELECT name FROM servers WHERE members_visible = 0 AND name IN ({})",
        crate::api::placeholders(1, servers.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for server in servers {
        query = query.bind(*server);
    }
    Ok(query
        .fetch_all(db)
        .await?
        .iter()
        .filter_map(|r| r.try_get(0).ok())
        .collect())
}

/// Whether `user` appears offline, and the version of that setting (`users.presence_seq`).
/// Never answers a client.
pub(crate) async fn presence_mode(db: &Db, user: &str) -> sqlx::Result<Option<(bool, i64)>> {
    sqlx::query("SELECT appear_offline, presence_seq FROM users WHERE username = $1")
        .bind(user)
        .fetch_optional(db)
        .await?
        .map(|row| Ok((row.try_get::<i64, _>(0)? != 0, row.try_get::<i64, _>(1)?)))
        .transpose()
}

/// `p2p_who` and `p2p_peer`: whether `hoster` appears offline, `None` for no such account.
/// Never answers a client.
pub(crate) async fn ws_appear_offline(
    _: &crate::ws::Layer,
    db: &Db,
    hoster: &str,
) -> sqlx::Result<Option<bool>> {
    sqlx::query("SELECT appear_offline FROM users WHERE username = $1")
        .bind(hoster)
        .fetch_optional(db)
        .await?
        .map(|row| row.try_get::<i64, _>(0).map(|v| v != 0))
        .transpose()
}

/// `p2p_who`: whether `a` and `b` have a DM. Never answers a client.
pub(crate) async fn ws_dm_between(
    _: &crate::ws::Layer,
    db: &Db,
    a: &str,
    b: &str,
) -> sqlx::Result<bool> {
    Ok(sqlx::query(
        "SELECT 1 FROM dms WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(db)
    .await?
    .is_some())
}

/// Calls: the two people of DM `dm_id`, `None` where `resolve_dm` answers 404 to `user`.
/// Never answers a client.
pub(crate) async fn ws_dm_users(
    _: &crate::ws::Layer,
    db: &Db,
    dm_id: i64,
    user: &str,
) -> sqlx::Result<Option<(String, String)>> {
    Ok(match dm_pair(db, dm_id, true).await?.as_deref() {
        Some([a, b]) if a == user || b == user => Some((a.clone(), b.clone())),
        _ => None,
    })
}

/// `p2p_peer`: the live P2P attachment of message `message_id`, with columns media_id,
/// channel_id, server, user_a, user_b, created_at, media_hoster and media_expires_at. The
/// caller checks who may read it. Never answers a client.
pub(crate) async fn ws_p2p_message(
    _: &crate::ws::Layer,
    db: &Db,
    message_id: i64,
) -> sqlx::Result<Option<AnyRow>> {
    sqlx::query(
        "SELECT m.media_id, m.channel_id, c.server, d.user_a, d.user_b, m.created_at, m.media_hoster, m.media_expires_at FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id WHERE m.id = $1 AND m.media_kind = 'p2p' AND m.media_removed = 0",
    )
    .bind(message_id)
    .fetch_optional(db)
    .await
}

/// `p2p_peer` for the site admin `admin`: whether the gate shows them message `id`, after the
/// `staff.media` entry for its P2P attachment `file` when only instance powers do (and the
/// `staff.view_server` entry for a server they are no member of). What only instance powers
/// show stays shut until a confirmation. Any refusal or failure is `false`. Never answers a
/// client with target data.
pub(crate) async fn ws_staff_file(
    _: &crate::ws::Layer,
    db: &Db,
    admin: &str,
    id: i64,
    file: &str,
) -> bool {
    let Ok(Some(user)) = crate::db::get_user(db, admin).await else {
        return false;
    };
    let Ok(message) = resolve_message(db, id, Some(&user), &Proof::none()).await else {
        return false;
    };
    match message.channel().filter(|c| c.staff_view()) {
        Some(channel) => {
            staff_audit::media(db, &user, channel.server().name(), channel.id(), id, file)
                .await
                .is_ok()
        }
        None => true,
    }
}

/// `p2p_who`: the messages holding P2P attachments `ids` of `hoster`, with columns media_id,
/// channel_id, server, user_a, user_b and created_at. The caller checks who may read them.
/// Never answers a client.
pub(crate) async fn ws_hosted_messages(
    _: &crate::ws::Layer,
    db: &Db,
    hoster: &str,
    ids: &[String],
) -> sqlx::Result<Vec<AnyRow>> {
    let sql = format!(
        "SELECT m.media_id, m.channel_id, c.server, d.user_a, d.user_b, m.created_at FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id WHERE m.media_kind = 'p2p' AND m.media_removed = 0 AND m.media_hoster = $1 AND m.media_id IN ({})",
        (2..ids.len() + 2)
            .map(|n| format!("${n}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(hoster);
    for id in ids {
        query = query.bind(id);
    }
    query.fetch_all(db).await
}

/// `p2p_hosting`: which of `ids` are live P2P attachments hosted by `user`: not removed, not
/// expired. `None` when the database can't say, so nothing is dropped by mistake. Never answers
/// a client.
pub(crate) async fn ws_live_hosted(
    _: &crate::ws::Layer,
    db: &Db,
    user: &str,
    ids: &[String],
) -> Option<Vec<String>> {
    if ids.is_empty() {
        return Some(Vec::new());
    }
    let sql = format!(
        "SELECT DISTINCT media_id FROM messages WHERE media_kind = 'p2p' AND media_removed = 0 AND media_hoster = $1 AND (media_expires_at IS NULL OR media_expires_at > $2) AND media_id IN ({})",
        crate::api::placeholders(3, ids.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(user)
        .bind(crate::db::now());
    for id in ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(db).await.ok()?;
    Some(
        rows.iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .collect(),
    )
}

pub const USER_SCOPE_SERVERS: i64 = 500;
pub const USER_SCOPE_DMS: i64 = 250;
pub const USER_SCOPE_SMALL: i64 = 1000;

/// Who hears about `user` (`user_updated`, P2P availability): their latest servers, small ones
/// whole and big ones only to their viewers, their DM partners, and themselves. Never answers a
/// client.
pub async fn user_scope(db: &Db, user: &str) -> UserScope {
    let mut scope = UserScope::default();
    if let Ok(rows) = sqlx::query(
        "SELECT m.server, s.member_count FROM members m JOIN servers s ON s.name = m.server WHERE m.username = $1 ORDER BY m.joined_at DESC LIMIT $2",
    )
    .bind(user)
    .bind(USER_SCOPE_SERVERS)
    .fetch_all(db)
    .await
    {
        for r in &rows {
            let (Ok(server), Ok(count)) = (r.try_get::<String, _>(0), r.try_get::<i64, _>(1)) else {
                continue;
            };
            match count <= USER_SCOPE_SMALL {
                true => scope.servers.push(server),
                false => scope.views.push(server),
            }
        }
    }
    for sql in [
        "SELECT user_b FROM dms WHERE user_a = $1 ORDER BY last_message_id DESC LIMIT $2",
        "SELECT user_a FROM dms WHERE user_b = $1 ORDER BY last_message_id DESC LIMIT $2",
    ] {
        if let Ok(rows) = sqlx::query(sql)
            .bind(user)
            .bind(USER_SCOPE_DMS)
            .fetch_all(db)
            .await
        {
            scope.users.extend(
                rows.iter()
                    .filter_map(|r| r.try_get::<String, _>(0).ok())
                    .filter(|u| u != user),
            );
        }
    }
    scope.users.push(user.to_string());
    scope.users.sort();
    scope.users.dedup();
    scope
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;
    use crate::api::auth::{derive_runs, hash_password, verify_runs};
    use crate::api::passwords::EXPIRY_MAX;
    use crate::api::routes;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::config::Roles;
    use crate::server::client_ip::{ClientIp, ProxyTrust};
    use crate::state::AppState;

    fn argon2_runs() -> (u64, u64) {
        (verify_runs(), derive_runs())
    }

    fn diff(after: (u64, u64), before: (u64, u64)) -> (u64, u64) {
        (after.0 - before.0, after.1 - before.1)
    }

    #[tokio::test]
    async fn membership_is_read_on_the_callers_connection() {
        let (state, path) = temp_state("member_in").await;
        let db = &state.db;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at, public_read) VALUES('club', 'Club', 'alice', 0, 1)").await;
        for name in ["alice", "bob", "zed"] {
            user(db, name).await;
        }
        add_member(db, "club", "alice", 1, 0, 0).await;
        add_member(db, "club", "bob", 0, 6, 10).await;
        let alice = mem_user("alice", false);
        let access = resolve_server(db, "club", Some(&alice), &Proof::none())
            .await
            .expect("member access");
        assert!(access.member_in(db, "bob").await.unwrap());
        assert!(!access.member_in(db, "zed").await.unwrap());
        assert_eq!(access.role_in(db, "alice").await.unwrap(), Some((true, 0)));
        assert_eq!(access.role_in(db, "bob").await.unwrap(), Some((false, 6)));
        assert_eq!(access.role_in(db, "zed").await.unwrap(), None);
        let mut tx = db.begin().await.unwrap();
        sqlx::query("DELETE FROM members WHERE server = 'club' AND username = 'bob'")
            .execute(&mut *tx)
            .await
            .unwrap();
        assert!(!access.member_in(&mut *tx, "bob").await.unwrap());
        assert_eq!(access.role_in(&mut *tx, "bob").await.unwrap(), None);
        tx.rollback().await.unwrap();
        assert!(access.member_in(db, "bob").await.unwrap());
        done(state, path).await;
    }

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    #[tokio::test]
    async fn the_text_reading_matches_channel_rights() {
        let (state, path) = temp_state("text_reading").await;
        text_reading_matches(&state).await;
        done(state, path).await;
        if let Some((state, temp)) = crate::api::test_util::pg_state("text_reading").await {
            text_reading_matches(&state).await;
            crate::api::test_util::pg_done(state, temp).await;
        }
    }

    /// Channels with each kind of rule, read by a member with a role, a member without one, a
    /// signed-in outsider and a guest.
    async fn text_reading_matches(state: &AppState) {
        let db = &state.db;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at, public_read) VALUES('club', 'Club', 'alice', 0, 1)").await;
        for name in ["alice", "bob", "carol", "zed"] {
            user(db, name).await;
        }
        add_member(db, "club", "alice", 1, 0, 0).await;
        add_member(db, "club", "bob", 0, 0, 40).await;
        add_member(db, "club", "carol", 0, 0, 50).await;
        let role = id_of(db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'r', '#ffffff', 0) RETURNING id").await;
        exec(
            db,
            &format!(
                "INSERT INTO user_roles(server, username, role_id) VALUES('club', 'bob', {role})"
            ),
        )
        .await;
        type Rule = (&'static str, i64, i64);
        let channels: [(&str, &str, i64, i64, &[Rule]); 12] = [
            ("open", "text", 0, 0, &[]),
            ("send_only", "text", 0, 1, &[]),
            ("locked", "text", 1, 0, &[]),
            ("role_view", "text", 1, 0, &[("role", 1, 1)]),
            ("role_recent", "text", 0, 0, &[("role", 1, 0)]),
            ("bob_recent", "text", 1, 0, &[("u:bob", 1, 0)]),
            ("bob_denied", "text", 0, 0, &[("u:bob", 0, 0)]),
            ("carol_denied", "text", 0, 0, &[("u:carol", 0, 0)]),
            ("mixed", "text", 0, 0, &[("u:bob", 1, 0), ("role", 0, 1)]),
            ("zed_recent", "text", 1, 0, &[("u:zed", 1, 0)]),
            ("history_only", "text", 1, 0, &[("role", 0, 1)]),
            ("talk", "voice", 0, 0, &[]),
        ];
        let mut text = Vec::new();
        for (name, kind, view, send, rules) in channels {
            let id = id_of(db, &format!("INSERT INTO channels(server, name, kind, created_at, restrict_view, restrict_send) VALUES('club', '{name}', '{kind}', 0, {view}, {send}) RETURNING id")).await;
            if kind == "text" {
                text.push(id);
            }
            for (subject, can_view, history) in rules {
                let subject = match *subject {
                    "role" => format!("r:{role}"),
                    other => other.to_string(),
                };
                exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({id}, '{subject}', {can_view}, 1, {history})")).await;
            }
        }
        let readers = [
            (Some(mem_user("bob", false)), Some(40)),
            (Some(mem_user("carol", false)), Some(50)),
            (Some(mem_user("zed", false)), None),
            (None, None),
        ];
        for (reader, joined) in readers {
            let access = resolve_server(db, "club", reader.as_ref(), &Proof::none())
                .await
                .expect("club");
            let rights = access.channel_rights(db).await.unwrap();
            let mut want: Vec<(i64, bool)> = text
                .iter()
                .filter_map(|id| match rights.get(id) {
                    Some(r) if r.view => Some((*id, r.history)),
                    Some(_) => None,
                    None => Some((*id, true)),
                })
                .collect();
            want.sort();
            let start = now();
            let reading = access.text_reading(2);
            let sql = format!(
                "SELECT t.id, CAST(t.whole AS BIGINT), t.since FROM ({}) t ORDER BY t.id",
                reading.sql
            );
            let rows = reading
                .bind(sqlx::query(sqlx::AssertSqlSafe(sql)).bind("club"))
                .fetch_all(db)
                .await
                .unwrap();
            let mut got = Vec::new();
            for r in &rows {
                got.push((
                    r.try_get::<i64, _>(0).unwrap(),
                    r.try_get::<i64, _>(1).unwrap() != 0,
                ));
                let since: i64 = r.try_get(2).unwrap();
                match joined {
                    Some(at) => assert_eq!(since, at),
                    None => assert!(since >= start && since <= now()),
                }
            }
            let who = reader.as_ref().map(|u| u.username.clone());
            assert_eq!(got, want, "{who:?}");
            assert!(!got.is_empty(), "{who:?}");
        }
    }

    async fn id_of(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("id")
    }

    struct Fixture {
        vault_channel: i64,
        vault_message: i64,
        hidden_channel: i64,
        hidden_message: i64,
    }

    async fn fixture(state: &AppState) -> Fixture {
        let db = &state.db;
        for (name, admin) in [("alice", 0), ("bob", 0), ("root", 1)] {
            crate::db::NewUser::plain(name)
                .hash("x")
                .admin(admin == 1)
                .add(db)
                .await;
            sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, 0)")
                .bind(crate::db::secret_key(name))
                .bind(name)
                .execute(db)
                .await
                .expect("token");
        }
        let hash = hash_password("pw").await.expect("hash");
        sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', $1, 0)")
            .bind(hash)
            .execute(db)
            .await
            .expect("vault");
        add_member(db, "vault", "alice", 1, 0, 0).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        add_member(db, "rchat", "bob", 0, 0, 0).await;
        let vault_channel = id_of(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('vault', 'general', 0) RETURNING id",
        )
        .await;
        let vault_message = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({vault_channel}, 'alice', 'secret', 1) RETURNING id")).await;
        let hidden_channel = id_of(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'staff', 0) RETURNING id",
        )
        .await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden_channel}, 'u:alice', 1, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        let hidden_message = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({hidden_channel}, 'alice', 'hush', 1) RETURNING id")).await;
        exec(
            db,
            "INSERT INTO roles(server, name, color, perms) VALUES('vault', 'r', '#ffffff', 0)",
        )
        .await;
        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('closed', 'Closed', 'alice', '!none', 0)").await;
        add_member(db, "closed", "alice", 1, 0, 0).await;
        exec(
            db,
            "INSERT INTO roles(server, name, color, perms) VALUES('closed', 'r', '#ffffff', 0)",
        )
        .await;
        extra(db, "closed", "gone-pw", Some(1), None, 0, None).await;
        extra(db, "vault", "expired-pw", Some(now() - 1), None, 0, None).await;
        extra(db, "vault", "revoked-pw", None, None, 0, Some(1)).await;
        extra(db, "vault", "used-pw", None, Some(2), 2, None).await;
        Fixture {
            vault_channel,
            vault_message,
            hidden_channel,
            hidden_message,
        }
    }

    pub(crate) async fn extra(
        db: &Db,
        server: &str,
        secret: &str,
        expires_at: Option<i64>,
        max_uses: Option<i64>,
        uses: i64,
        revoked_at: Option<i64>,
    ) -> i64 {
        let hash = hash_password(secret).await.expect("hash");
        let lookup = password_lookup(db, server, secret).await.expect("lookup");
        sqlx::query("INSERT INTO server_passwords(server, label, hash, lookup, created_by, created_at, expires_at, max_uses, uses, revoked_at) VALUES($1, $2, $3, $4, 'alice', 0, $5, $6, $7, $8) RETURNING id")
            .bind(server)
            .bind(secret)
            .bind(hash)
            .bind(lookup)
            .bind(expires_at)
            .bind(max_uses)
            .bind(uses)
            .bind(revoked_at)
            .fetch_one(db)
            .await
            .expect("extra password")
            .try_get(0)
            .expect("id")
    }

    struct Client {
        addr: SocketAddr,
        http: reqwest::Client,
        n: std::cell::Cell<u32>,
    }

    type Reply = (u16, Vec<(String, String)>, Vec<u8>);

    impl Client {
        async fn call(
            &self,
            method: &str,
            path: &str,
            token: Option<&str>,
            body: Option<&str>,
            headers: &[(&str, &str)],
        ) -> Reply {
            let n = self.n.get() + 1;
            self.n.set(n);
            let url = format!("http://{}/{}", self.addr, path.trim_start_matches('/'));
            let mut req = self
                .http
                .request(method.parse().expect("method"), url)
                .header("X-Forwarded-For", format!("10.9.{}.{}", n / 250, n % 250));
            if let Some(token) = token {
                req = req.bearer_auth(token);
            }
            if let Some(body) = body {
                req = req
                    .header("content-type", "application/json")
                    .body(body.to_string());
            }
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            let res = req.send().await.expect("request");
            let status = res.status().as_u16();
            let mut headers: Vec<(String, String)> = res
                .headers()
                .iter()
                .filter(|(k, _)| *k != axum::http::header::DATE)
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        String::from_utf8_lossy(v.as_bytes()).into_owned(),
                    )
                })
                .collect();
            headers.sort();
            (status, headers, res.bytes().await.expect("body").to_vec())
        }
    }

    async fn serve(state: &AppState) -> (Client, tokio::task::JoinHandle<()>) {
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app =
            routes(state.clone(), &Roles::ALL, ClientIp(trusted), None).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        let client = Client {
            addr,
            http: reqwest::Client::new(),
            n: std::cell::Cell::new(0),
        };
        (client, server)
    }

    type Route = (
        &'static str,
        &'static str,
        Option<&'static str>,
        &'static [(&'static str, &'static str)],
    );

    const SERVER_ROUTES: &[Route] = &[
        ("GET", "/servers/{s}", None, &[]),
        ("PATCH", "/servers/{s}", Some("{}"), &[]),
        ("DELETE", "/servers/{s}", None, &[]),
        ("GET", "/servers/{s}/members", None, &[]),
        ("GET", "/servers/{s}/members?q=a", None, &[]),
        ("GET", "/servers/{s}/interacted", None, &[]),
        ("POST", "/servers/{s}/leave", None, &[]),
        (
            "POST",
            "/servers/{s}/channels",
            Some(r#"{"name":"x"}"#),
            &[],
        ),
        (
            "POST",
            "/servers/{s}/kick",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        ("GET", "/servers/{s}/bans", None, &[]),
        (
            "POST",
            "/servers/{s}/bans",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        ("DELETE", "/servers/{s}/bans/alice", None, &[]),
        (
            "POST",
            "/servers/{s}/admins",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        ("DELETE", "/servers/{s}/admins/alice", None, &[]),
        (
            "POST",
            "/servers/{s}/transfer_admin",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        (
            "PATCH",
            "/servers/{s}/admins/alice/perms",
            Some(r#"{"perms":1}"#),
            &[],
        ),
        (
            "POST",
            "/servers/{s}/roles",
            Some(r##"{"name":"r","color":"#ffffff","perms":0}"##),
            &[],
        ),
        ("PATCH", "/servers/{s}/roles/1", Some("{}"), &[]),
        ("DELETE", "/servers/{s}/roles/1", None, &[]),
        (
            "POST",
            "/servers/{s}/roles/1/assign",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        ("DELETE", "/servers/{s}/roles/1/assign/alice", None, &[]),
        ("POST", "/servers/{s}/join", None, &[]),
        ("POST", "/servers/{s}/join", Some("{}"), &[]),
        (
            "POST",
            "/servers/{s}/join",
            Some(r#"{"password":"wrong"}"#),
            &[],
        ),
        ("POST", "/servers/{s}/guest_access", Some("{}"), &[]),
        (
            "POST",
            "/servers/{s}/guest_access",
            Some(r#"{"password":"wrong"}"#),
            &[],
        ),
        ("GET", "/invites/{s}", None, &[]),
        (
            "GET",
            "/invites/{s}",
            None,
            &[("x-invite-password", "wrong")],
        ),
        ("GET", "/invites/{s}", None, &[("x-guest-grant", "bogus")]),
        (
            "POST",
            "/servers/{s}/join",
            Some(r#"{"password":"expired-pw"}"#),
            &[],
        ),
        (
            "POST",
            "/servers/{s}/join",
            Some(r#"{"password":"revoked-pw"}"#),
            &[],
        ),
        (
            "POST",
            "/servers/{s}/join",
            Some(r#"{"password":"used-pw"}"#),
            &[],
        ),
        (
            "POST",
            "/servers/{s}/guest_access",
            Some(r#"{"password":"used-pw"}"#),
            &[],
        ),
        (
            "POST",
            "/servers/{s}/guest_access",
            Some(r#"{"password":"expired-pw"}"#),
            &[],
        ),
        (
            "GET",
            "/invites/{s}",
            None,
            &[("x-invite-password", "revoked-pw")],
        ),
        (
            "GET",
            "/invites/{s}",
            None,
            &[("x-invite-password", "expired-pw")],
        ),
        (
            "POST",
            "/servers/{s}/join",
            Some(r#"{"password":"gone-pw"}"#),
            &[],
        ),
        ("GET", "/servers/{s}/passwords", None, &[]),
        (
            "POST",
            "/servers/{s}/passwords",
            Some(r#"{"label":"x"}"#),
            &[],
        ),
        ("DELETE", "/servers/{s}/passwords/1", None, &[]),
        ("GET", "/users/alice/profile?server={s}", None, &[]),
    ];

    const ID_ROUTES: &[(&str, &str, Option<&str>)] = &[
        ("PATCH", "/channels/{c}", Some("{}")),
        ("DELETE", "/channels/{c}", None),
        ("GET", "/channels/{c}/perms", None),
        (
            "PUT",
            "/channels/{c}/perms",
            Some(r#"{"subject":"u:bob","can_view":true,"can_send":true,"can_read_history":true}"#),
        ),
        ("DELETE", "/channels/{c}/perms/u:alice", None),
        ("GET", "/channels/{c}/messages", None),
        ("GET", "/channels/{c}/threads", None),
        (
            "POST",
            "/channels/{c}/messages",
            Some(r#"{"content":"hi"}"#),
        ),
        ("POST", "/read", Some(r#"{"scope":"c{c}","last_read":1}"#)),
        ("DELETE", "/messages/{m}", None),
        ("DELETE", "/messages/{m}/media", None),
        ("DELETE", "/messages/{m}/embeds/0", None),
        ("GET", "/messages/{m}/thread", None),
        ("POST", "/messages/{m}/thread", Some(r#"{"content":"hi"}"#)),
    ];

    #[tokio::test]
    async fn protected_and_missing_targets_answer_identically() {
        let (state, path) = temp_state("access_uniform").await;
        let f = fixture(&state).await;
        let (client, server) = serve(&state).await;
        let viewers: [Option<&str>; 2] = [Some("bob"), None];
        for &(method, route, body, headers) in SERVER_ROUTES {
            for token in viewers {
                let mut replies = Vec::new();
                for name in ["vault", "ghost", "VAULT", "closed"] {
                    let path = route.replace("{s}", name);
                    replies.push(client.call(method, &path, token, body, headers).await);
                }
                for (i, reply) in replies.iter().enumerate().skip(1) {
                    assert_eq!(&replies[0], reply, "{method} {route} as {token:?} ({i})");
                }
                assert!(replies[0].1.iter().any(|(k, _)| k == "content-type"));
                let (status, _, body) = &replies[0];
                let body = String::from_utf8_lossy(body);
                let want = match (route.starts_with("/users/"), token, body.as_ref()) {
                    (true, Some(_), _) => *status == 200 && body.contains(r#""member":null"#),
                    (true, None, r#"{"error":"Not found"}"#) => *status == 404,
                    (true, None, _) => false,
                    (false, Some(_), r#"{"error":"Server not found or wrong password"}"#) => {
                        *status == 404
                    }
                    (false, _, r#"{"error":"Password required"}"#) => *status == 401,
                    (false, None, r#"{"error":"Unauthorized"}"#) => *status == 401,
                    (false, None, r#"{"error":"Server not found or wrong password"}"#) => {
                        *status == 404
                    }
                    (_, _, _) => false,
                };
                assert!(want, "{method} {route} as {token:?}: {status} {body}");
            }
        }
        let targets = [
            (f.vault_channel, f.vault_message),
            (999_999, 999_998),
            (f.hidden_channel, f.hidden_message),
        ];
        for &(method, route, body) in ID_ROUTES {
            for token in viewers {
                let mut replies = Vec::new();
                for (c, m) in targets {
                    let path = route
                        .replace("{c}", &c.to_string())
                        .replace("{m}", &m.to_string());
                    let body = body.map(|b| b.replace("{c}", &c.to_string()));
                    replies.push(
                        client
                            .call(method, &path, token, body.as_deref(), &[])
                            .await,
                    );
                }
                assert_eq!(replies[0], replies[1], "{method} {route} as {token:?}");
                assert_eq!(replies[0], replies[2], "{method} {route} as {token:?}");
                if token.is_some() {
                    assert_eq!(replies[0].0, 404, "{method} {route}");
                    assert_eq!(
                        replies[0].2, br#"{"error":"Not found"}"#,
                        "{method} {route}"
                    );
                }
            }
        }
        let media = [
            ("a".repeat(32), Some(f.vault_message)),
            ("b".repeat(32), Some(f.hidden_message)),
            ("c".repeat(32), None),
        ];
        for (id, message) in &media {
            sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES($1, 'a.txt', 'text/plain', 1, $2, 'alice', $3)")
                .bind(id)
                .bind(vec![1u8])
                .bind(now())
                .execute(&state.db)
                .await
                .expect("media");
            if let Some(m) = message {
                exec(&state.db, &format!("UPDATE messages SET media_id = '{id}', media_filename = 'a.txt' WHERE id = {m}")).await;
            }
        }
        for token in viewers {
            let unknown = client
                .call(
                    "GET",
                    &format!("/media/{}", "d".repeat(32)),
                    token,
                    None,
                    &[],
                )
                .await;
            assert_eq!(unknown.0, 404, "{token:?}");
            assert_eq!(unknown.2, br#"{"error":"Media not found"}"#);
            for (id, _) in &media {
                let reply = client
                    .call("GET", &format!("/media/{id}"), token, None, &[])
                    .await;
                assert_eq!(reply, unknown, "media {id} as {token:?}");
            }
        }
        let alice = client
            .call(
                "GET",
                &format!("/media/{}", "a".repeat(32)),
                Some("alice"),
                None,
                &[],
            )
            .await;
        assert_eq!(alice.0, 200);
        server.abort();
        done(state, path).await;
    }

    /// The reason in an error body, if it has one.
    fn reason_of(reply: &Reply) -> Option<serde_json::Value> {
        let json: serde_json::Value = serde_json::from_slice(&reply.2).ok()?;
        json.get("reason").cloned()
    }

    /// Whether `reply` is an answer of the access gate to someone it does not let in.
    fn denial(reply: &Reply) -> bool {
        let gate: [&[u8]; 3] = [
            NO_ENTRY,
            br#"{"error":"Password required"}"#,
            br#"{"error":"Not found"}"#,
        ];
        gate.contains(&reply.2.as_slice())
    }

    #[tokio::test]
    async fn access_denials_carry_no_reason() {
        let (state, path) = temp_state("access_no_reason").await;
        let f = fixture(&state).await;
        let category = id_of(
            &state.db,
            "INSERT INTO channel_categories(server, name, position, created_at) VALUES('vault', 'Cat', 0, 0) RETURNING id",
        )
        .await;
        let separator = id_of(
            &state.db,
            "INSERT INTO channel_separators(server, label, position, created_at) VALUES('vault', 'Line', 0, 0) RETURNING id",
        )
        .await;
        let (client, server) = serve(&state).await;
        let viewers: [Option<&str>; 2] = [Some("bob"), None];
        const GUARDED: [&str; 7] = [
            "/servers/{name}",
            "/invites/{name}",
            "/channels/{id}",
            "/categories/{id}",
            "/separators/{id}",
            "/messages/{id}",
            "/polls/{id}",
        ];
        let routes: Vec<(String, String)> = crate::api::openapi::tests::registered_routes()
            .into_iter()
            .filter_map(|(m, p)| Some((m, p.strip_prefix("/api/v1")?.to_string())))
            .filter(|(_, p)| GUARDED.iter().any(|g| p.starts_with(g)))
            .collect();
        assert!(routes.len() > 60, "{} guarded routes", routes.len());
        let (mut asked, mut denied) = (0, 0);
        for (method, route) in &routes {
            let targets: Vec<String> = match route.split('/').nth(1) {
                Some("servers" | "invites") => vec!["vault".into(), "ghost".into()],
                Some("channels") => vec![f.vault_channel.to_string(), f.hidden_channel.to_string()],
                Some("categories") => vec![category.to_string(), "999999".into()],
                Some("separators") => vec![separator.to_string(), "999999".into()],
                Some("messages" | "polls") => {
                    vec![f.vault_message.to_string(), f.hidden_message.to_string()]
                }
                other => panic!("{other:?} is not guarded"),
            };
            for target in targets {
                let filled = route
                    .replacen("{name}", &target, 1)
                    .replacen("{id}", &target, 1)
                    .replace("{id}", "1")
                    .replace("{username}", "alice")
                    .replace("{emoji}", "%F0%9F%91%8D")
                    .replace("{ord}", "0")
                    .replace("{subject}", "u:alice")
                    .replace("{guest}", "@guest:00000000000000aa");
                assert!(!filled.contains('{'), "{route}: an unfilled part");
                // The mention lookup checks its search text before it asks the gate.
                let filled = match filled.ends_with("/mentions") {
                    true => format!("{filled}?q=al"),
                    false => filled,
                };
                let body = matches!(method.as_str(), "post" | "put" | "patch").then_some("{}");
                for token in viewers {
                    let reply = client
                        .call(&method.to_uppercase(), &filled, token, body, &[])
                        .await;
                    asked += 1;
                    denied += usize::from(denial(&reply));
                    assert!(
                        (400..500).contains(&reply.0) || filled.ends_with("/available"),
                        "{method} {filled} as {token:?}: {}",
                        reply.0
                    );
                    assert_eq!(
                        reason_of(&reply),
                        None,
                        "{method} {filled} as {token:?}: {}",
                        String::from_utf8_lossy(&reply.2)
                    );
                }
            }
        }
        assert!(
            denied > 100,
            "{denied} of {asked} were answered by the gate"
        );
        for &(method, route, body, headers) in SERVER_ROUTES {
            for token in viewers {
                for name in ["vault", "ghost", "closed"] {
                    let path = route.replace("{s}", name);
                    let reply = client.call(method, &path, token, body, headers).await;
                    assert_eq!(reason_of(&reply), None, "{method} {path} as {token:?}");
                }
            }
        }
        for &(method, route, body) in ID_ROUTES {
            for token in viewers {
                for (c, m) in [
                    (f.vault_channel, f.vault_message),
                    (f.hidden_channel, f.hidden_message),
                    (999_999, 999_998),
                ] {
                    let path = route
                        .replace("{c}", &c.to_string())
                        .replace("{m}", &m.to_string());
                    let body = body.map(|b| b.replace("{c}", &c.to_string()));
                    let reply = client
                        .call(method, &path, token, body.as_deref(), &[])
                        .await;
                    assert_eq!(reason_of(&reply), None, "{method} {path} as {token:?}");
                }
            }
        }
        set_control(&state.db, "server_joining", "nobody").await;
        let off = client
            .call("POST", "/servers/vault/join", Some("bob"), None, &[])
            .await;
        assert_eq!(
            reason_of(&off),
            Some(serde_json::json!({"kind": "off_site", "control": "server_joining"})),
            "a switch that refuses every name says so"
        );
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_password_step_is_driven_by_the_api() {
        let (state, path) = temp_state("access_password").await;
        fixture(&state).await;
        let (client, server) = serve(&state).await;
        let bob = Some("bob");
        let required = (401, br#"{"error":"Password required"}"#.to_vec());
        let denied = (
            404,
            br#"{"error":"Server not found or wrong password"}"#.to_vec(),
        );
        let short = |(status, _, body): Reply| (status, body);
        for name in ["vault", "ghost"] {
            let join = format!("/servers/{name}/join");
            assert_eq!(
                short(client.call("POST", &join, bob, None, &[]).await),
                required
            );
            let wrong = client
                .call("POST", &join, bob, Some(r#"{"password":"nope"}"#), &[])
                .await;
            assert_eq!(short(wrong), denied);
            let invite = format!("/invites/{name}");
            assert_eq!(
                short(client.call("GET", &invite, bob, None, &[]).await),
                required
            );
            let guest = format!("/servers/{name}/guest_access");
            assert_eq!(
                short(client.call("POST", &guest, None, Some("{}"), &[]).await),
                required
            );
        }
        let open = client
            .call(
                "POST",
                "/servers/rchat/join",
                bob,
                Some(r#"{"password":"ignored"}"#),
                &[],
            )
            .await;
        assert_eq!(open.0, 200);
        let public = client
            .call("POST", "/servers/rchat/guest_access", None, Some("{}"), &[])
            .await;
        assert_eq!(short(public), (200, br#"{"grant":null}"#.to_vec()));
        let card = client
            .call(
                "GET",
                "/invites/vault",
                bob,
                None,
                &[("x-invite-password", "pw")],
            )
            .await;
        assert_eq!(card.0, 200);
        let card: serde_json::Value = serde_json::from_slice(&card.2).expect("card");
        assert_eq!(card["status"], "joinable");
        assert_eq!(card["server"]["display_name"], "Vault");
        let grant = client
            .call(
                "POST",
                "/servers/vault/guest_access",
                None,
                Some(r#"{"password":"pw"}"#),
                &[],
            )
            .await;
        assert_eq!(grant.0, 200);
        let grant: serde_json::Value = serde_json::from_slice(&grant.2).expect("grant");
        let grant = grant["grant"].as_str().expect("grant").to_string();
        let viewed = client
            .call(
                "GET",
                "/servers/vault",
                None,
                None,
                &[("x-guest-grant", &grant)],
            )
            .await;
        assert_eq!(viewed.0, 200);
        let joined = client
            .call(
                "POST",
                "/servers/vault/join",
                bob,
                Some(r#"{"password":"pw"}"#),
                &[],
            )
            .await;
        assert_eq!(joined.0, 200);
        let again = client
            .call("POST", "/servers/vault/join", bob, None, &[])
            .await;
        assert_eq!(again.0, 200, "members join without the password");
        let viewed = client.call("GET", "/servers/vault", bob, None, &[]).await;
        assert_eq!(viewed.0, 200);
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn bans_show_only_after_access_is_proven() {
        let (state, path) = temp_state("access_bans").await;
        fixture(&state).await;
        let db = &state.db;
        exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('vault', 'bob', 'alice', 0)").await;
        let bob = mem_user("bob", false);
        let code = |r: Result<ServerAccess, ApiError>| r.err().map(|ApiError(c, m, _)| (c, m));
        let none = resolve_server(db, "vault", Some(&bob), &Proof::none()).await;
        assert_eq!(
            code(none),
            Some((StatusCode::NOT_FOUND, DENIED.to_string()))
        );
        let asked = resolve_server(db, "vault", Some(&bob), &Proof::password(None)).await;
        assert_eq!(
            code(asked),
            Some((StatusCode::UNAUTHORIZED, PASSWORD_REQUIRED.to_string()))
        );
        let proven = resolve_server(db, "vault", Some(&bob), &Proof::password(Some("pw"))).await;
        assert_eq!(
            code(proven),
            Some((StatusCode::FORBIDDEN, BANNED.to_string()))
        );
        exec(
            db,
            "INSERT INTO interactions(server, username, last_at) VALUES('vault', 'bob', 1)",
        )
        .await;
        let history = resolve_server(db, "vault", Some(&bob), &Proof::none()).await;
        assert_eq!(
            code(history),
            Some((StatusCode::FORBIDDEN, BANNED.to_string()))
        );
        exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('rchat', 'bob', 'alice', 0)").await;
        let public = resolve_server(db, "rchat", Some(&bob), &Proof::none()).await;
        assert_eq!(
            code(public),
            Some((StatusCode::FORBIDDEN, BANNED.to_string()))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn passwords_are_hashed_for_missing_servers_too() {
        let (state, path) = temp_state("access_timing").await;
        fixture(&state).await;
        let db = &state.db;
        let bob = mem_user("bob", false);
        let before = verify_counts();
        let derived = derive_runs();
        let _ = resolve_server(db, "ghost", Some(&bob), &Proof::password(Some("x"))).await;
        assert_eq!(verify_counts(), (before.0, before.1 + 1));
        assert_eq!(derive_runs(), derived + 1);
        let _ = resolve_server(db, "vault", Some(&bob), &Proof::password(Some("x"))).await;
        assert_eq!(verify_counts(), (before.0 + 1, before.1 + 1));
        assert_eq!(derive_runs(), derived + 2);
        for name in ["ghost", "vault"] {
            let _ = resolve_server(db, name, Some(&bob), &Proof::password(None)).await;
            let _ = resolve_server(db, name, Some(&bob), &Proof::none()).await;
        }
        assert_eq!(verify_counts(), (before.0 + 1, before.1 + 1));
        assert_eq!(derive_runs(), derived + 2);
        let root = mem_user("root", true);
        let staff = resolve_server(db, "vault", Some(&root), &Proof::none()).await;
        assert_eq!(staff.map(|a| a.via()).ok(), Some(Via::Staff));
        let staff_join = resolve_server(db, "vault", Some(&root), &Proof::password(None)).await;
        assert!(matches!(
            staff_join,
            Err(ApiError(StatusCode::UNAUTHORIZED, _, _))
        ));
        done(state, path).await;
    }

    #[tokio::test]
    async fn banned_viewers_never_get_a_channel() {
        let (state, path) = temp_state("access_banned_handle").await;
        let fx = fixture(&state).await;
        let db = &state.db;
        let general = id_of(
            db,
            "SELECT id FROM channels WHERE server = 'rchat' AND name = 'general'",
        )
        .await;
        exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('rchat', 'bob', 'alice', 0)").await;
        exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('vault', 'bob', 'alice', 0)").await;
        let bob = mem_user("bob", false);
        let err = |e: ApiError| (e.0, e.1);
        let not_found = (StatusCode::NOT_FOUND, NOT_FOUND.to_string());
        for (name, proof) in [
            ("rchat", Proof::none()),
            ("vault", Proof::password(Some("pw"))),
        ] {
            let view = resolve_invite(db, name, Some(&bob), &proof).await;
            assert!(matches!(view, Ok(InviteView::Banned(ref lite)) if lite.name == name));
            let server = resolve_server(db, name, Some(&bob), &proof).await;
            assert_eq!(
                server.err().map(err),
                Some((StatusCode::FORBIDDEN, BANNED.to_string()))
            );
        }
        for cid in [general, fx.vault_channel] {
            let channel = resolve_channel(db, cid, Some(&bob), &Proof::none()).await;
            assert_eq!(channel.err().map(err), Some(not_found.clone()));
        }
        let message = resolve_message(db, fx.vault_message, Some(&bob), &Proof::none()).await;
        assert_eq!(message.err().map(err), Some(not_found));
        done(state, path).await;
    }

    #[tokio::test]
    async fn repeated_passwords_never_skip_the_verify() {
        let (state, path) = temp_state("access_verify_runs").await;
        fixture(&state).await;
        let db = &state.db;
        let bob = mem_user("bob", false);
        let attempt = |name: &'static str| {
            let bob = &bob;
            async move {
                let before = argon2_runs();
                let res = resolve_server(db, name, Some(bob), &Proof::password(Some("p"))).await;
                let res = res.err().map(|ApiError(c, m, _)| (c, m));
                (res, diff(argon2_runs(), before))
            }
        };
        let first = attempt("ghost").await;
        let missing = attempt("ghost2").await;
        let protected = attempt("vault").await;
        let again = attempt("ghost").await;
        let vault_again = attempt("vault").await;
        let denied = Some((StatusCode::NOT_FOUND, DENIED.to_string()));
        for (res, runs) in [first, missing, protected, again, vault_again] {
            assert_eq!((res, runs), (denied.clone(), (1, 1)));
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn available_and_search_hide_protected_servers() {
        let (state, path) = temp_state("access_search").await;
        fixture(&state).await;
        let (client, server) = serve(&state).await;
        let bob = Some("bob");
        let available = |name: &'static str| {
            let client = &client;
            async move {
                let r = client
                    .call("GET", &format!("/servers/{name}/available"), bob, None, &[])
                    .await;
                (r.0, String::from_utf8(r.2).expect("utf8"))
            }
        };
        assert_eq!(
            available("ghost").await,
            (200, r#"{"available":true}"#.to_string())
        );
        assert_eq!(
            available("vault").await,
            (200, r#"{"available":false}"#.to_string())
        );
        assert_eq!(
            available("VAULT").await,
            (200, r#"{"available":false}"#.to_string())
        );
        assert_eq!(
            available("rchat").await,
            (200, r#"{"available":false}"#.to_string())
        );
        let long = format!("/servers/{}/available", "a".repeat(101));
        assert_eq!(client.call("GET", &long, bob, None, &[]).await.0, 400);
        let anon = client
            .call("GET", "/servers/ghost/available", None, None, &[])
            .await;
        assert_eq!(anon.0, 401);
        let gone = client
            .call("GET", "/servers/ghost/exists", bob, None, &[])
            .await;
        assert_ne!(gone.0, 200);
        let names = |r: Reply| -> Vec<String> {
            let v: serde_json::Value = serde_json::from_slice(&r.2).expect("json");
            v.as_array()
                .expect("list")
                .iter()
                .map(|m| m["name"].as_str().expect("name").to_string())
                .collect()
        };
        let search = "/server_search?q=vault";
        assert!(names(client.call("GET", search, bob, None, &[]).await).is_empty());
        assert!(names(client.call("GET", search, None, None, &[]).await).is_empty());
        assert!(names(client.call("GET", search, Some("root"), None, &[]).await).is_empty());
        assert_eq!(
            names(client.call("GET", search, Some("alice"), None, &[]).await),
            ["vault"]
        );
        assert_eq!(
            names(
                client
                    .call("GET", "/server_search?q=rchat", bob, None, &[])
                    .await
            ),
            ["rchat"]
        );
        server.abort();
        done(state, path).await;
    }

    async fn user(db: &Db, name: &str) {
        crate::db::NewUser::plain(name).hash("x").add(db).await;
        exec(
            db,
            &format!(
                "INSERT INTO tokens(token, username, created_at) VALUES('{}', '{name}', 0)",
                crate::db::secret_key(name)
            ),
        )
        .await;
    }

    async fn scalar(db: &Db, sql: &str) -> Option<i64> {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("value")
    }

    fn json(reply: &Reply) -> serde_json::Value {
        serde_json::from_slice(&reply.2).expect("json")
    }

    #[tokio::test]
    async fn lookups_are_argon2_with_a_per_server_salt() {
        let (state, path) = temp_state("access_lookup_kdf").await;
        let db = &state.db;
        let derived = derive_runs();
        let vault = password_lookup(db, "vault", "secret")
            .await
            .expect("lookup");
        assert_eq!(derive_runs(), derived + 1);
        assert_eq!(vault.len(), 64);
        assert!(vault.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            password_lookup(db, "VAULT", "secret")
                .await
                .expect("lookup"),
            vault
        );
        assert_ne!(
            password_lookup(db, "ghost", "secret")
                .await
                .expect("lookup"),
            vault
        );
        assert_ne!(
            password_lookup(db, "vault", "secret2")
                .await
                .expect("lookup"),
            vault
        );
        let pepper = crate::db::pepper(db).await.expect("pepper");
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&pepper).expect("mac");
        mac.update(b"vault\0secret");
        assert_ne!(hex::encode(mac.finalize().into_bytes()), vault);
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&pepper).expect("mac");
        mac.update(b"vault");
        let salt: [u8; 16] = mac.finalize().into_bytes()[..16].try_into().expect("salt");
        let mut out = [0u8; 32];
        argon2::Argon2::default()
            .hash_password_into(b"secret", &salt, &mut out)
            .expect("argon2");
        assert_eq!(hex::encode(out), vault);
        done(state, path).await;
    }

    #[tokio::test]
    async fn every_password_attempt_runs_two_argon2_operations() {
        let (state, path) = temp_state("access_two_verifies").await;
        fixture(&state).await;
        let db = &state.db;
        extra(db, "vault", "live-pw", None, None, 0, None).await;
        let bob = mem_user("bob", false);
        let alice = mem_user("alice", false);
        let cases: [(&str, &User, &str, bool); 12] = [
            ("ghost", &bob, "x", false),
            ("vault", &bob, "x", false),
            ("vault", &bob, "pw", true),
            ("vault", &bob, "live-pw", true),
            ("vault", &bob, "expired-pw", false),
            ("vault", &bob, "revoked-pw", false),
            ("vault", &bob, "used-pw", false),
            ("closed", &bob, "x", false),
            ("closed", &bob, "gone-pw", false),
            ("rchat", &bob, "x", true),
            ("vault", &alice, "x", true),
            ("VAULT", &bob, "live-pw", true),
        ];
        for (name, who, given, opens) in cases {
            let before = argon2_runs();
            let res = resolve_server(db, name, Some(who), &Proof::password(Some(given))).await;
            assert_eq!(diff(argon2_runs(), before), (1, 1), "{name} {given}");
            assert_eq!(res.is_ok(), opens, "{name} {given}");
            if !opens {
                let err = res.err().map(|ApiError(c, m, _)| (c, m));
                assert_eq!(err, Some((StatusCode::NOT_FOUND, DENIED.to_string())));
            }
        }
        let ticket = resolve_server(db, "vault", Some(&bob), &Proof::password(Some("live-pw")))
            .await
            .expect("ticket");
        assert_eq!(ticket.via(), Via::Password);
        assert!(ticket.password_id().is_some());
        let permanent = resolve_server(db, "vault", Some(&bob), &Proof::password(Some("pw")))
            .await
            .expect("permanent");
        assert_eq!(permanent.password_id(), None);
        let before = argon2_runs();
        for proof in [Proof::password(None), Proof::none()] {
            let _ = resolve_server(db, "closed", Some(&bob), &proof).await;
            let _ = resolve_server(db, "ghost", Some(&bob), &proof).await;
        }
        assert_eq!(argon2_runs(), before, "no password, no argon2");
        done(state, path).await;
    }

    /// What the admin page does to a control, as every process sees it once its cache is gone.
    async fn set_control(db: &Db, key: &str, value: &str) {
        exec(db, &format!("INSERT INTO settings(key, value) VALUES('{key}', '{value}') ON CONFLICT(key) DO UPDATE SET value = excluded.value")).await;
        crate::api::Settings::forget(db);
    }

    /// The ids of the fixture's channel and message in `vault`.
    async fn fixture_ids(db: &Db) -> Fixture {
        let vault_channel = id_of(db, "SELECT id FROM channels WHERE server = 'vault'").await;
        let hidden_channel = id_of(db, "SELECT id FROM channels WHERE name = 'staff'").await;
        Fixture {
            vault_channel,
            vault_message: id_of(
                db,
                &format!("SELECT id FROM messages WHERE channel_id = {vault_channel}"),
            )
            .await,
            hidden_channel,
            hidden_message: id_of(
                db,
                &format!("SELECT id FROM messages WHERE channel_id = {hidden_channel}"),
            )
            .await,
        }
    }

    /// The fixture plus `open`, a server without a password that alice made and bob is in, and
    /// the accounts carol, dave and erin.
    async fn joining_fixture(state: &AppState) {
        fixture(state).await;
        let db = &state.db;
        for name in ["carol", "dave", "erin"] {
            user(db, name).await;
        }
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('open', 'Open', 'alice', 0)").await;
        exec(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('open', 'general', 0)",
        )
        .await;
        add_member(db, "open", "alice", 1, 0, 0).await;
        add_member(db, "open", "bob", 0, 0, 0).await;
    }

    const NEEDS_PASSWORD: &[u8] = br#"{"error":"Password required"}"#;
    const NO_ENTRY: &[u8] = br#"{"error":"Server not found or wrong password"}"#;
    /// The answer to every self-service join while the instance lets nobody join.
    const JOINING_OFF: &[u8] = br#"{"error":"Server not found or wrong password","reason":{"kind":"off_site","control":"server_joining"}}"#;

    fn answer(reply: &Reply) -> (u16, &[u8]) {
        (reply.0, reply.2.as_slice())
    }

    #[tokio::test]
    async fn invites_only_refuses_a_join_by_name_and_takes_a_password_or_a_ticket() {
        let (state, path) = temp_state("joining_invites").await;
        joining_fixture(&state).await;
        let db = &state.db;
        extra(db, "vault", "ticket-pw", None, Some(1), 0, None).await;
        let (client, server) = serve(&state).await;
        let join = async |who: &str, name: &str, body: Option<&str>| {
            client
                .call(
                    "POST",
                    &format!("/servers/{name}/join"),
                    Some(who),
                    body,
                    &[],
                )
                .await
        };
        let members = async |server: &str, who: &str| {
            scalar(
                db,
                &format!(
                    "SELECT COUNT(*) FROM members WHERE server = '{server}' AND username = '{who}'"
                ),
            )
            .await
        };
        assert_eq!(join("erin", "open", None).await.0, 200, "everyone: by name");
        exec(
            db,
            "DELETE FROM members WHERE server = 'open' AND username = 'erin'",
        )
        .await;

        set_control(db, "server_joining", "invites").await;
        let guess = Some(r#"{"password":"a guess"}"#);
        for who in ["carol", "root"] {
            for name in ["open", "vault", "closed", "nope"] {
                let by_name = join(who, name, None).await;
                assert_eq!(
                    answer(&by_name),
                    (401, NEEDS_PASSWORD),
                    "{who} joins {name} by name"
                );
                let wrong = join(who, name, guess).await;
                assert_eq!(
                    answer(&wrong),
                    (404, NO_ENTRY),
                    "{who} joins {name} with a guess"
                );
            }
        }
        assert_eq!(members("open", "carol").await, Some(0));
        assert_eq!(members("open", "root").await, Some(0));

        assert_eq!(
            join("carol", "vault", Some(r#"{"password":"pw"}"#)).await.0,
            200
        );
        let ticket = Some(r#"{"password":"ticket-pw"}"#);
        assert_eq!(join("dave", "vault", ticket).await.0, 200, "a ticket");
        assert_eq!(
            answer(&join("erin", "vault", ticket).await),
            (404, NO_ENTRY),
            "it had one use"
        );
        assert_eq!(members("vault", "carol").await, Some(1));
        assert_eq!(members("vault", "dave").await, Some(1));

        assert_eq!(join("bob", "open", None).await.0, 200, "a member stays one");
        assert_eq!(
            client
                .call("GET", "/servers/open", Some("bob"), None, &[])
                .await
                .0,
            200
        );
        assert_eq!(
            client
                .call("POST", "/servers/open/leave", Some("bob"), None, &[])
                .await
                .0,
            200,
            "leaving works"
        );
        assert_eq!(
            answer(&join("bob", "open", None).await),
            (401, NEEDS_PASSWORD)
        );

        let guest = async |name: &str, body: &str| {
            client
                .call(
                    "POST",
                    &format!("/servers/{name}/guest_access"),
                    None,
                    Some(body),
                    &[],
                )
                .await
        };
        for name in ["open", "vault", "nope"] {
            assert_eq!(
                answer(&guest(name, "{}").await),
                (401, NEEDS_PASSWORD),
                "a guest, {name} by name"
            );
        }
        assert_eq!(
            answer(&guest("open", r#"{"password":"a guess"}"#).await),
            (404, NO_ENTRY)
        );
        let granted = guest("vault", r#"{"password":"pw"}"#).await;
        assert_eq!(granted.0, 200);
        assert!(
            json(&granted)["grant"].is_string(),
            "a guest with the password"
        );

        set_control(db, "server_joining", "everyone").await;
        assert_eq!(join("carol", "open", None).await.0, 200, "back on");
        assert_eq!(
            json(&guest("open", "{}").await)["grant"],
            serde_json::Value::Null
        );
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn under_invites_every_name_costs_the_same_work() {
        let (state, path) = temp_state("joining_invites_work").await;
        joining_fixture(&state).await;
        let db = &state.db;
        set_control(db, "server_joining", "invites").await;
        let carol = mem_user("carol", false);
        let code = |r: Result<ServerAccess, ApiError>| r.err().map(|ApiError(c, m, _)| (c, m));
        let names = ["open", "vault", "closed", "nope"];
        for round in 0..10 {
            for name in names {
                let before = argon2_runs();
                let by_name =
                    resolve_join(db, name, Some(&carol), None, ServerJoining::Invites).await;
                assert_eq!(
                    diff(argon2_runs(), before),
                    (0, 0),
                    "{name}, round {round}: no password is checked"
                );
                assert_eq!(
                    code(by_name),
                    Some((StatusCode::UNAUTHORIZED, PASSWORD_REQUIRED.to_string())),
                    "{name}"
                );
            }
        }
        for name in names {
            let before = argon2_runs();
            let guess = resolve_join(
                db,
                name,
                Some(&carol),
                Some("a guess"),
                ServerJoining::Invites,
            )
            .await;
            assert_eq!(
                diff(argon2_runs(), before),
                (1, 1),
                "{name}: a guess costs the same two checks"
            );
            assert_eq!(
                code(guess),
                Some((StatusCode::NOT_FOUND, DENIED.to_string())),
                "{name}"
            );
        }
        let joined = resolve_join(
            db,
            "vault",
            Some(&carol),
            Some("pw"),
            ServerJoining::Invites,
        )
        .await
        .expect("forty answers by name spent no budget");
        assert_eq!(joined.via(), Via::Password);
        done(state, path).await;
    }

    #[tokio::test]
    async fn nobody_refuses_every_self_service_join_and_leaves_members_alone() {
        let (state, path) = temp_state("joining_nobody").await;
        joining_fixture(&state).await;
        let db = &state.db;
        extra(db, "vault", "ticket-pw", None, None, 0, None).await;
        set_control(db, "server_joining", "nobody").await;
        let (client, server) = serve(&state).await;
        let before = scalar(db, "SELECT COUNT(*) FROM members").await;
        let bodies = [
            None,
            Some(r#"{"password":"pw"}"#),
            Some(r#"{"password":"ticket-pw"}"#),
            Some(r#"{"password":"a guess"}"#),
        ];
        for who in ["carol", "root", "bob"] {
            for name in ["open", "vault", "closed", "rchat", "nope"] {
                for body in bodies {
                    let refused = client
                        .call(
                            "POST",
                            &format!("/servers/{name}/join"),
                            Some(who),
                            body,
                            &[],
                        )
                        .await;
                    assert_eq!(
                        answer(&refused),
                        (404, JOINING_OFF),
                        "{who} joins {name} with {body:?}"
                    );
                }
            }
        }
        for name in ["open", "vault", "nope"] {
            for body in ["{}", r#"{"password":"pw"}"#] {
                let refused = client
                    .call(
                        "POST",
                        &format!("/servers/{name}/guest_access"),
                        None,
                        Some(body),
                        &[],
                    )
                    .await;
                assert_eq!(
                    answer(&refused),
                    (404, JOINING_OFF),
                    "a guest asks for {name} with {body}"
                );
            }
        }
        assert_eq!(scalar(db, "SELECT COUNT(*) FROM members").await, before);
        assert_eq!(
            scalar(db, "SELECT COUNT(*) FROM guest_grants").await,
            Some(0)
        );
        assert_eq!(
            scalar(
                db,
                "SELECT uses FROM server_passwords WHERE label = 'ticket-pw'"
            )
            .await,
            Some(0),
            "nothing was spent"
        );

        assert_eq!(
            client
                .call("GET", "/servers/open", Some("bob"), None, &[])
                .await
                .0,
            200,
            "members stay"
        );
        assert_eq!(
            client
                .call("GET", "/servers/vault", Some("alice"), None, &[])
                .await
                .0,
            200
        );
        let sent = client
            .call(
                "POST",
                &format!(
                    "/channels/{}/messages",
                    scalar(db, "SELECT id FROM channels WHERE server = 'open'")
                        .await
                        .expect("channel")
                ),
                Some("bob"),
                Some(r#"{"content":"still here"}"#),
                &[],
            )
            .await;
        assert_eq!(sent.0, 200, "and keep talking");
        assert_eq!(
            client
                .call("POST", "/servers/open/leave", Some("bob"), None, &[])
                .await
                .0,
            200,
            "leaving works"
        );

        let registered = client
            .call(
                "POST",
                "/auth/register",
                None,
                Some(r#"{"username":"frank","password":"pw-frank-1","avatar_kind":"identicon"}"#),
                &[],
            )
            .await;
        assert_eq!(registered.0, 200);
        assert_eq!(
            scalar(
                db,
                "SELECT COUNT(*) FROM members WHERE server = 'rchat' AND username = 'frank'"
            )
            .await,
            Some(1),
            "new accounts still land in the default server"
        );
        let made = client
            .call(
                "POST",
                "/admin/servers",
                Some("root"),
                Some(r#"{"name":"Staffroom","owner":"carol"}"#),
                &[],
            )
            .await;
        assert_eq!(made.0, 200, "the operator still puts people in servers");
        assert_eq!(
            scalar(
                db,
                "SELECT COUNT(*) FROM members WHERE server = 'staffroom' AND username = 'carol'"
            )
            .await,
            Some(1)
        );
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_joining_switch_also_covers_reading() {
        let (state, path) = temp_state("joining_reading").await;
        joining_fixture(&state).await;
        let f = fixture_ids(&state.db).await;
        let db = &state.db;
        let open_channel = scalar(db, "SELECT id FROM channels WHERE server = 'open'")
            .await
            .expect("channel");
        let open_message = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({open_channel}, 'alice', 'hello there', 1) RETURNING id")).await;
        let (client, server) = serve(&state).await;
        let viewers: [Option<&str>; 2] = [Some("carol"), None];
        let get = async |path: &str, who: Option<&str>, headers: &[(&str, &str)]| {
            client.call("GET", path, who, None, headers).await
        };
        let grant = json(
            &client
                .call(
                    "POST",
                    "/servers/vault/guest_access",
                    None,
                    Some(r#"{"password":"pw"}"#),
                    &[],
                )
                .await,
        )["grant"]
            .as_str()
            .expect("a grant")
            .to_string();
        let members = scalar(db, "SELECT COUNT(*) FROM members").await;

        for who in viewers {
            assert_eq!(get("/servers/open", who, &[]).await.0, 200, "{who:?}");
            let messages = get(&format!("/channels/{open_channel}/messages"), who, &[]).await;
            assert_eq!(messages.0, 200, "{who:?}");
            assert_eq!(json(&messages)[0]["content"], "hello there");
            let card = get("/invites/open", who, &[]).await;
            assert_eq!(json(&card)["status"], "joinable", "{who:?}");
            let found = get("/server_search?q=ope", who, &[]).await;
            assert_eq!(json(&found)[0]["name"], "open", "{who:?}");
            assert!(
                ws_server_open(
                    crate::ws::Layer::for_tests(),
                    db,
                    "open",
                    who,
                    false,
                    &Proof::none()
                )
                .await
                .expect("gate"),
                "{who:?} follows it live"
            );
        }
        let hits = get("/search?q=hello&servers=open", None, &[]).await;
        assert_eq!(json(&hits).as_array().map(Vec::len), Some(1));

        for mode in ["invites", "nobody"] {
            set_control(db, "server_joining", mode).await;
            for &(method, route, body, headers) in SERVER_ROUTES {
                for token in viewers {
                    let mut replies = Vec::new();
                    for name in ["open", "vault", "ghost", "closed"] {
                        let path = route.replace("{s}", name);
                        replies.push(client.call(method, &path, token, body, headers).await);
                    }
                    for (i, reply) in replies.iter().enumerate().skip(1) {
                        assert_eq!(
                            &replies[0], reply,
                            "{mode}: {method} {route} as {token:?} ({i})"
                        );
                    }
                    assert!(
                        !(200..300).contains(&replies[0].0) || route.starts_with("/users/"),
                        "{mode}: {method} {route} as {token:?}: {}",
                        replies[0].0
                    );
                }
            }
            for &(method, route, body) in ID_ROUTES {
                for token in viewers {
                    let mut replies = Vec::new();
                    for (c, m) in [
                        (open_channel, open_message),
                        (f.vault_channel, f.vault_message),
                        (999_999, 999_998),
                    ] {
                        let path = route
                            .replace("{c}", &c.to_string())
                            .replace("{m}", &m.to_string());
                        let body = body.map(|b| b.replace("{c}", &c.to_string()));
                        replies.push(
                            client
                                .call(method, &path, token, body.as_deref(), &[])
                                .await,
                        );
                    }
                    assert_eq!(
                        replies[0], replies[1],
                        "{mode}: {method} {route} as {token:?}"
                    );
                    assert_eq!(
                        replies[0], replies[2],
                        "{mode}: {method} {route} as {token:?}"
                    );
                }
            }
            let asked: (u16, &[u8]) = match mode {
                "invites" => (401, NEEDS_PASSWORD),
                _ => (404, NO_ENTRY),
            };
            for who in viewers {
                for name in ["open", "vault", "ghost"] {
                    assert_eq!(
                        answer(&get(&format!("/servers/{name}"), who, &[]).await),
                        (404, NO_ENTRY),
                        "{mode}: {who:?} opens {name}"
                    );
                    assert_eq!(
                        answer(&get(&format!("/invites/{name}"), who, &[]).await),
                        asked,
                        "{mode}: {who:?} previews {name}"
                    );
                    assert_eq!(
                        answer(
                            &get(
                                &format!("/invites/{name}"),
                                who,
                                &[("x-invite-password", "a guess")]
                            )
                            .await
                        ),
                        (404, NO_ENTRY),
                        "{mode}: {who:?} guesses a password for {name}"
                    );
                }
                assert_eq!(
                    answer(&get(&format!("/channels/{open_channel}/messages"), who, &[]).await),
                    (404, br#"{"error":"Not found"}"#.as_slice()),
                    "{mode}: {who:?}"
                );
                let found = get("/server_search?q=ope", who, &[]).await;
                assert_eq!(answer(&found), (200, b"[]".as_slice()), "{mode}: {who:?}");
                assert!(
                    !ws_server_open(
                        crate::ws::Layer::for_tests(),
                        db,
                        "open",
                        who,
                        false,
                        &Proof::none()
                    )
                    .await
                    .expect("gate"),
                    "{mode}: {who:?} can't follow it live"
                );
                let card = get("/invites/vault", who, &[("x-invite-password", "pw")]).await;
                assert_eq!(
                    (card.0, json(&card)["status"].as_str()),
                    (200, Some("joinable")),
                    "{mode}: {who:?} with the password of a protected server reads its card"
                );
            }
            let hits = get("/search?q=hello&servers=open", None, &[]).await;
            assert_eq!(
                json(&hits).as_array().map(Vec::len),
                Some(0),
                "{mode}: a guest's search"
            );
            let granted = get("/servers/vault", None, &[("x-guest-grant", &grant)]).await;
            assert_eq!(
                granted.0, 200,
                "{mode}: a guest grant still opens its server"
            );
            for path in [
                "/servers/open".to_string(),
                "/servers/open/members".to_string(),
                format!("/channels/{open_channel}/messages"),
                "/invites/open".to_string(),
            ] {
                assert_eq!(
                    get(&path, Some("bob"), &[]).await.0,
                    200,
                    "{mode}: a member reads {path}"
                );
            }
            let found = get("/server_search?q=ope", Some("bob"), &[]).await;
            assert_eq!(json(&found)[0]["name"], "open", "{mode}: a member finds it");
            assert!(
                ws_server_open(
                    crate::ws::Layer::for_tests(),
                    db,
                    "open",
                    Some("bob"),
                    false,
                    &Proof::none()
                )
                .await
                .expect("gate")
            );
            assert_eq!(
                get("/servers/open", Some("root"), &[]).await.0,
                200,
                "{mode}: the staff view is unchanged"
            );
            assert_eq!(
                answer(&get("/servers/open/members", Some("root"), &[]).await).0,
                200
            );
        }

        set_control(db, "server_joining", "everyone").await;
        for who in viewers {
            assert_eq!(
                get("/servers/open", who, &[]).await.0,
                200,
                "{who:?}: public again"
            );
        }
        assert_eq!(scalar(db, "SELECT COUNT(*) FROM members").await, members);
        assert_eq!(
            scalar(
                db,
                "SELECT COUNT(*) FROM servers WHERE name = 'open' AND password_hash IS NULL"
            )
            .await,
            Some(1),
            "the server's own settings never changed"
        );
        server.abort();
        done(state, path).await;
    }

    /// Sets a server's public reading option the way its owner's PATCH stores it.
    async fn set_reading(db: &Db, server: &str, option: Option<bool>) {
        let value = match option {
            None => "NULL",
            Some(true) => "1",
            Some(false) => "0",
        };
        exec(
            db,
            &format!("UPDATE servers SET public_read = {value} WHERE name = '{server}'"),
        )
        .await;
    }

    #[tokio::test]
    async fn the_public_reading_option_decides_who_reads() {
        let (state, path) = temp_state("public_reading").await;
        let state = state.with_limits(std::sync::Arc::new(Limits {
            lookup_list_per_minute: 10_000,
            lookup_search_per_minute: 1_000,
            ..Limits::default()
        }));
        joining_fixture(&state).await;
        let f = fixture_ids(&state.db).await;
        let db = &state.db;
        let open_channel = scalar(db, "SELECT id FROM channels WHERE server = 'open'")
            .await
            .expect("channel");
        let open_message = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({open_channel}, 'alice', 'hello there', 1) RETURNING id")).await;
        exec(
            db,
            &format!(
                "UPDATE messages SET content = 'hello there' WHERE id = {}",
                f.vault_message
            ),
        )
        .await;
        let (client, server) = serve(&state).await;
        let get =
            async |path: &str, who: Option<&str>| client.call("GET", path, who, None, &[]).await;
        let said = |reply: &Reply| {
            json(reply)
                .as_array()
                .is_some_and(|all| all.iter().any(|m| m["content"] == "hello there"))
        };
        let servers = [
            ("open", false, open_channel, open_message, "ope", "bob"),
            (
                "vault",
                true,
                f.vault_channel,
                f.vault_message,
                "vau",
                "alice",
            ),
        ];
        for joining in ["everyone", "invites", "nobody"] {
            set_control(db, "server_joining", joining).await;
            for site in [true, false] {
                set_control(db, "public_reading", if site { "1" } else { "0" }).await;
                for option in [None, Some(true), Some(false)] {
                    for (name, has_password, channel, _, q, member) in servers {
                        set_reading(db, name, option).await;
                        let by_name = !has_password && joining == "everyone";
                        let readable = site && option.unwrap_or(by_name);
                        let at = format!("{joining}, site {site}, option {option:?}, {name}");
                        for who in [Some("carol"), None] {
                            let detail = get(&format!("/servers/{name}"), who).await;
                            let messages = get(&format!("/channels/{channel}/messages"), who).await;
                            let members = get(&format!("/servers/{name}/members"), who).await;
                            let found = get(&format!("/server_search?q={q}"), who).await;
                            match readable {
                                true => {
                                    assert_eq!(detail.0, 200, "{at}: {who:?} opens it");
                                    assert_eq!(
                                        json(&detail)["public_read"],
                                        serde_json::json!(option),
                                        "{at}"
                                    );
                                    assert!(said(&messages), "{at}: {who:?} reads it");
                                    assert_eq!(members.0, 200, "{at}: {who:?}");
                                    assert_eq!(json(&found)[0]["name"], name, "{at}: {who:?}");
                                }
                                false => {
                                    let ghost = get("/servers/ghost", who).await;
                                    assert_eq!(detail, ghost, "{at}: {who:?} can't tell it exists");
                                    assert_eq!(answer(&detail), (404, NO_ENTRY), "{at}");
                                    let nowhere = get("/channels/999999/messages", who).await;
                                    assert_eq!(messages, nowhere, "{at}: {who:?}");
                                    assert_eq!(
                                        members,
                                        get("/servers/ghost/members", who).await,
                                        "{at}: {who:?}"
                                    );
                                    assert_eq!(answer(&found), (200, b"[]".as_slice()), "{at}");
                                }
                            }
                            assert_eq!(
                                ws_server_open(
                                    crate::ws::Layer::for_tests(),
                                    db,
                                    name,
                                    who,
                                    false,
                                    &Proof::none()
                                )
                                .await
                                .expect("gate"),
                                readable,
                                "{at}: {who:?} follows it live"
                            );
                            let posted = client
                                .call(
                                    "POST",
                                    &format!("/channels/{channel}/messages"),
                                    who,
                                    Some(r#"{"content":"let me in"}"#),
                                    &[],
                                )
                                .await;
                            assert!(
                                (400..500).contains(&posted.0),
                                "{at}: {who:?} never posts ({})",
                                posted.0
                            );
                            let hits = get(&format!("/search?q=hello&servers={name}"), None).await;
                            assert_eq!(
                                json(&hits).as_array().map(Vec::len),
                                Some(usize::from(readable)),
                                "{at}: a guest's message search"
                            );
                        }
                        let asked: (u16, &[u8]) = match joining {
                            "nobody" => (404, NO_ENTRY),
                            _ => (401, NEEDS_PASSWORD),
                        };
                        let card = get(&format!("/invites/{name}"), Some("carol")).await;
                        let guest_card = get(&format!("/invites/{name}"), None).await;
                        match (by_name, readable) {
                            (true, true) => {
                                for card in [&card, &guest_card] {
                                    assert_eq!(json(card)["status"], "joinable", "{at}");
                                    assert_eq!(
                                        json(card)["preview"].as_array().map(Vec::len),
                                        Some(1),
                                        "{at}: the card shows what anyone can read"
                                    );
                                }
                            }
                            (true, false) => {
                                assert_eq!(json(&card)["status"], "joinable", "{at}");
                                assert_eq!(
                                    (
                                        json(&card)["preview"].as_array().map(Vec::len),
                                        json(&card)["preview_channel"].is_null()
                                    ),
                                    (Some(0), true),
                                    "{at}: an account may join by name and sees nothing before"
                                );
                                assert_eq!(answer(&guest_card), asked, "{at}: a guest can't join");
                            }
                            (false, true) => {
                                for card in [&card, &guest_card] {
                                    assert_eq!(
                                        json(card)["status"],
                                        "readable",
                                        "{at}: reading opens the card, not joining"
                                    );
                                    assert_eq!(
                                        json(card)["preview"].as_array().map(Vec::len),
                                        Some(1),
                                        "{at}"
                                    );
                                }
                            }
                            (false, false) => {
                                assert_eq!(answer(&card), asked, "{at}: reading is not joining");
                                assert_eq!(answer(&guest_card), asked, "{at}");
                            }
                        }
                        let guest_access = client
                            .call(
                                "POST",
                                &format!("/servers/{name}/guest_access"),
                                None,
                                Some("{}"),
                                &[],
                            )
                            .await;
                        match (readable, joining) {
                            (true, _) => assert_eq!(
                                answer(&guest_access),
                                (200, br#"{"grant":null}"#.as_slice()),
                                "{at}: a guest reads without a grant"
                            ),
                            (false, "nobody") => {
                                assert_eq!(answer(&guest_access), (404, JOINING_OFF), "{at}")
                            }
                            (false, _) => assert_eq!(
                                answer(&guest_access),
                                (401, NEEDS_PASSWORD),
                                "{at}: asked like a password server"
                            ),
                        }
                        let join = client
                            .call(
                                "POST",
                                &format!("/servers/{name}/join"),
                                Some("dave"),
                                None,
                                &[],
                            )
                            .await;
                        match (by_name, joining) {
                            (true, _) => {
                                assert_eq!(join.0, 200, "{at}: a name still joins it");
                                let left = client
                                    .call(
                                        "POST",
                                        &format!("/servers/{name}/leave"),
                                        Some("dave"),
                                        None,
                                        &[],
                                    )
                                    .await;
                                assert_eq!(left.0, 200, "{at}");
                            }
                            (false, "nobody") => {
                                assert_eq!(answer(&join), (404, JOINING_OFF), "{at}")
                            }
                            (false, _) => assert_eq!(answer(&join), (401, NEEDS_PASSWORD), "{at}"),
                        }
                        for who in [member, "root"] {
                            assert_eq!(
                                get(&format!("/servers/{name}"), Some(who)).await.0,
                                200,
                                "{at}: {who} always opens it"
                            );
                        }
                    }
                }
            }
        }
        set_control(db, "server_joining", "invites").await;
        set_control(db, "public_reading", "0").await;
        for name in ["open", "vault"] {
            set_reading(db, name, Some(true)).await;
        }
        for &(method, route, body, headers) in SERVER_ROUTES {
            for token in [Some("carol"), None] {
                let mut replies = Vec::new();
                for name in ["open", "vault", "ghost"] {
                    let path = route.replace("{s}", name);
                    replies.push(client.call(method, &path, token, body, headers).await);
                }
                assert_eq!(replies[0], replies[2], "{method} {route} as {token:?}");
                assert_eq!(replies[1], replies[2], "{method} {route} as {token:?}");
            }
        }
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn owners_set_who_can_read_their_server() {
        let (state, path) = temp_state("public_read_patch").await;
        joining_fixture(&state).await;
        let db = &state.db;
        let (client, server) = serve(&state).await;
        let patch = async |who: &str, name: &str, body: &str| {
            client
                .call(
                    "PATCH",
                    &format!("/servers/{name}"),
                    Some(who),
                    Some(body),
                    &[],
                )
                .await
        };
        let stored = async |name: &str| {
            scalar(
                db,
                &format!("SELECT public_read FROM servers WHERE name = '{name}'"),
            )
            .await
        };
        let mut rx = state.hub.subscribe();
        for (body, option) in [
            (r#"{"public_read":true}"#, Some(true)),
            (r#"{}"#, Some(true)),
            (r##"{"banner_color":"#111111"}"##, Some(true)),
            (r#"{"public_read":false}"#, Some(false)),
            (r#"{"public_read":null}"#, None),
        ] {
            let reply = patch("alice", "open", body).await;
            assert_eq!(reply.0, 200, "{body}");
            assert_eq!(
                json(&reply)["public_read"],
                serde_json::json!(option),
                "{body}"
            );
            assert_eq!(stored("open").await, option.map(i64::from), "{body}");
            let detail = client
                .call("GET", "/servers/open", Some("alice"), None, &[])
                .await;
            assert_eq!(
                json(&detail)["public_read"],
                serde_json::json!(option),
                "{body}"
            );
            let mut heard = None;
            while let Ok(ev) = rx.try_recv() {
                if let crate::ws::WsEvent::ServerUpdated { server } = ev {
                    heard = Some(server.public_read);
                }
            }
            assert_eq!(heard, Some(option), "{body}: members hear it");
        }
        let on = patch("alice", "vault", r#"{"public_read":true}"#).await;
        assert_eq!(
            (on.0, json(&on)["has_password"].clone()),
            (200, serde_json::json!(true)),
            "a password server may be readable too, and keeps its password"
        );
        assert_eq!(
            patch("root", "rchat", r#"{"public_read":false}"#).await.0,
            200,
            "the built-in server too"
        );
        let words: Vec<String> = sqlx::query(
            "SELECT details FROM audit_log WHERE server = 'open' AND details LIKE '%public_read%' ORDER BY id",
        )
        .fetch_all(db)
        .await
        .expect("audit")
        .iter()
        .map(|r| r.try_get::<String, _>(0).expect("details"))
        .collect();
        assert_eq!(
            words.len(),
            3,
            "each change is in the server's audit log: {words:?}"
        );
        assert!(
            words[0].contains("default") && words[0].contains("on"),
            "{words:?}"
        );

        assert_eq!(
            answer(&patch("bob", "open", r#"{"public_read":true}"#).await),
            (
                403,
                br#"{"error":"Missing permission","reason":{"kind":"perm","control":"ManageServer"}}"#.as_slice()
            ),
            "a member without the access permission"
        );
        assert_eq!(
            answer(&patch("carol", "closed", r#"{"public_read":true}"#).await),
            (404, NO_ENTRY),
            "someone who can't open the server"
        );
        assert_eq!(
            patch("alice", "open", r#"{"public_read":"yes"}"#).await.0,
            422
        );
        assert_eq!(stored("open").await, None);

        set_control(db, "public_reading", "0").await;
        let refused = patch("alice", "open", r#"{"public_read":true}"#).await;
        assert_eq!(
            answer(&refused),
            (
                403,
                br#"{"error":"Public reading is turned off on this site","reason":{"kind":"off_site","control":"public_reading"}}"#
                    .as_slice()
            )
        );
        assert_eq!(stored("open").await, None, "nothing was stored");
        for (body, option) in [
            (r#"{"public_read":false}"#, Some(0)),
            (r#"{"public_read":null}"#, None),
        ] {
            assert_eq!(patch("alice", "open", body).await.0, 200, "{body}");
            assert_eq!(
                stored("open").await,
                option,
                "{body}: off and default still work"
            );
        }
        assert_eq!(
            stored("vault").await,
            Some(1),
            "turning the site's switch off changes no server's own option"
        );
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn server_search_answers_404_when_off() {
        let (state, path) = temp_state("search_switch").await;
        joining_fixture(&state).await;
        let db = &state.db;
        let (client, server) = serve(&state).await;
        let search = async |who: Option<&str>, q: &str| {
            client
                .call("GET", &format!("/server_search?q={q}"), who, None, &[])
                .await
        };
        for who in [Some("carol"), None] {
            let found = search(who, "ope").await;
            assert_eq!(found.0, 200);
            assert_eq!(json(&found)[0]["name"], "open", "{who:?}");
        }
        set_control(db, "server_search", "0").await;
        for who in [Some("carol"), Some("bob"), Some("root"), None] {
            for q in ["ope", "", "vault", "zzz"] {
                assert_eq!(
                    answer(&search(who, q).await),
                    (
                        404,
                        br#"{"error":"Not found","reason":{"kind":"off_site","control":"server_search"}}"#
                            .as_slice()
                    ),
                    "{who:?} searches {q}"
                );
            }
        }
        assert_eq!(
            client
                .call("GET", "/servers/open", Some("carol"), None, &[])
                .await
                .0,
            200,
            "servers stay reachable by name"
        );
        assert_eq!(
            client
                .call("POST", "/servers/open/join", Some("carol"), None, &[])
                .await
                .0,
            200
        );
        set_control(db, "server_search", "1").await;
        assert_eq!(search(Some("carol"), "ope").await.0, 200);
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_one_use_ticket_admits_exactly_one() {
        let (state, path) = temp_state("access_ticket_race").await;
        fixture(&state).await;
        let db = &state.db;
        user(db, "carol").await;
        user(db, "dave").await;
        let id = extra(db, "vault", "one-pw", None, Some(1), 0, None).await;
        let carol = mem_user("carol", false);
        let dave = mem_user("dave", false);
        let proof = Proof::password(Some("one-pw"));
        let a = resolve_server(db, "vault", Some(&carol), &proof)
            .await
            .expect("a");
        let b = resolve_server(db, "vault", Some(&dave), &proof)
            .await
            .expect("b");
        let mut ta = db.begin().await.expect("tx");
        assert!(a.spend_ticket(&mut ta).await.is_ok());
        ta.commit().await.expect("commit");
        let mut tb = db.begin().await.expect("tx");
        let lost = b
            .spend_ticket(&mut tb)
            .await
            .err()
            .map(|ApiError(c, m, _)| (c, m));
        assert_eq!(lost, Some((StatusCode::NOT_FOUND, DENIED.to_string())));
        drop(tb);
        exec(
            db,
            &format!("UPDATE server_passwords SET uses = 0, used_up_at = NULL WHERE id = {id}"),
        )
        .await;
        let (client, server) = serve(&state).await;
        let body = Some(r#"{"password":"one-pw"}"#);
        let (x, y) = tokio::join!(
            client.call("POST", "/servers/vault/join", Some("carol"), body, &[]),
            client.call("POST", "/servers/vault/join", Some("dave"), body, &[]),
        );
        let mut statuses = [x.0, y.0];
        statuses.sort();
        assert_eq!(statuses, [200, 404]);
        let loser = if x.0 == 404 { &x } else { &y };
        assert_eq!(
            loser.2,
            br#"{"error":"Server not found or wrong password"}"#
        );
        assert_eq!(
            scalar(
                db,
                &format!("SELECT uses FROM server_passwords WHERE id = {id}")
            )
            .await,
            Some(1)
        );
        assert!(
            scalar(
                db,
                &format!("SELECT used_up_at FROM server_passwords WHERE id = {id}")
            )
            .await
            .is_some()
        );
        assert_eq!(
            scalar(db, "SELECT COUNT(*) FROM members WHERE server = 'vault' AND username IN ('carol', 'dave')").await,
            Some(1)
        );
        assert_eq!(
            scalar(
                db,
                &format!(
                    "SELECT COUNT(*) FROM members WHERE server = 'vault' AND joined_via = {id}"
                )
            )
            .await,
            Some(1)
        );
        let late = client
            .call("POST", "/servers/vault/join", Some("bob"), body, &[])
            .await;
        let ghost = client
            .call("POST", "/servers/ghost/join", Some("bob"), body, &[])
            .await;
        assert_eq!(late, ghost, "a used-up ticket looks like a missing server");
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn invites_show_ticket_limits_only_after_proof_and_never_spend() {
        let (state, path) = temp_state("access_invite_ticket").await;
        fixture(&state).await;
        let db = &state.db;
        let at = now() + 3 * 3600;
        let id = extra(db, "vault", "temp-pw", Some(at), Some(2), 0, None).await;
        let (client, server) = serve(&state).await;
        for _ in 0..3 {
            let card = client
                .call(
                    "GET",
                    "/invites/vault",
                    Some("bob"),
                    None,
                    &[("x-invite-password", "temp-pw")],
                )
                .await;
            assert_eq!(card.0, 200);
            let card = json(&card);
            assert_eq!(card["password_expires_at"], at);
            assert_eq!(card["password_uses_left"], 2);
            assert_eq!(card["status"], "joinable");
        }
        assert_eq!(
            scalar(
                db,
                &format!("SELECT uses FROM server_passwords WHERE id = {id}")
            )
            .await,
            Some(0),
            "previews never use the ticket"
        );
        let locked = client
            .call("GET", "/invites/vault", Some("bob"), None, &[])
            .await;
        assert_eq!(locked.2, br#"{"error":"Password required"}"#);
        let permanent = client
            .call(
                "GET",
                "/invites/vault",
                Some("bob"),
                None,
                &[("x-invite-password", "pw")],
            )
            .await;
        let permanent = json(&permanent);
        assert!(permanent["password_expires_at"].is_null());
        assert!(permanent["password_uses_left"].is_null());
        let member = json(
            &client
                .call("GET", "/invites/vault", Some("alice"), None, &[])
                .await,
        );
        assert_eq!(member["status"], "member");
        assert!(member["password_expires_at"].is_null());
        let grant = client
            .call(
                "POST",
                "/servers/vault/guest_access",
                None,
                Some(r#"{"password":"temp-pw"}"#),
                &[],
            )
            .await;
        assert_eq!(grant.0, 200);
        let joined = client
            .call(
                "POST",
                "/servers/vault/join",
                Some("bob"),
                Some(r#"{"password":"temp-pw"}"#),
                &[],
            )
            .await;
        assert_eq!(joined.0, 200);
        assert_eq!(
            scalar(
                db,
                &format!("SELECT uses FROM server_passwords WHERE id = {id}")
            )
            .await,
            Some(2),
            "the grant and the join each used one"
        );
        let used = client
            .call(
                "GET",
                "/invites/vault",
                Some("root"),
                None,
                &[("x-invite-password", "temp-pw")],
            )
            .await;
        let ghost = client
            .call(
                "GET",
                "/invites/ghost",
                Some("root"),
                None,
                &[("x-invite-password", "temp-pw")],
            )
            .await;
        assert_eq!(used, ghost);
        exec(
            db,
            &format!(
                "UPDATE server_passwords SET max_uses = NULL, expires_at = {} WHERE id = {id}",
                now() - 1
            ),
        )
        .await;
        let expired = client
            .call(
                "GET",
                "/invites/vault",
                Some("root"),
                None,
                &[("x-invite-password", "temp-pw")],
            )
            .await;
        assert_eq!(expired, ghost);
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn guest_grants_end_with_their_password() {
        let (state, path) = temp_state("access_grant_end").await;
        fixture(&state).await;
        let db = &state.db;
        user(db, "carol").await;
        let (client, server) = serve(&state).await;
        let created = client
            .call(
                "POST",
                "/servers/vault/passwords",
                Some("alice"),
                Some(r#"{"label":"Friends","expires_in":3600}"#),
                &[],
            )
            .await;
        assert_eq!(created.0, 200, "{}", String::from_utf8_lossy(&created.2));
        let created = json(&created);
        let id = created["id"].as_i64().expect("id");
        let secret = created["password"].as_str().expect("password").to_string();
        assert_eq!(secret.split('-').count(), 4);
        assert!(secret.chars().all(|c| c == '-' || c.is_ascii_lowercase()));
        let body = format!(r#"{{"password":"{secret}"}}"#);
        let grant_of = |r: Reply| json(&r)["grant"].as_str().expect("grant").to_string();
        let a = grant_of(
            client
                .call(
                    "POST",
                    "/servers/vault/guest_access",
                    None,
                    Some(&body),
                    &[],
                )
                .await,
        );
        let b = grant_of(
            client
                .call(
                    "POST",
                    "/servers/vault/guest_access",
                    None,
                    Some(&body),
                    &[],
                )
                .await,
        );
        let permanent = grant_of(
            client
                .call(
                    "POST",
                    "/servers/vault/guest_access",
                    None,
                    Some(r#"{"password":"pw"}"#),
                    &[],
                )
                .await,
        );
        let joined = client
            .call(
                "POST",
                "/servers/vault/join",
                Some("carol"),
                Some(&body),
                &[],
            )
            .await;
        assert_eq!(joined.0, 200);
        let view = |grant: String| {
            let client = &client;
            async move {
                client
                    .call(
                        "GET",
                        "/servers/vault",
                        None,
                        None,
                        &[("x-guest-grant", &grant)],
                    )
                    .await
                    .0
            }
        };
        assert_eq!(view(a.clone()).await, 200);
        assert_eq!(view(b.clone()).await, 200);
        exec(
            db,
            &format!(
                "UPDATE server_passwords SET expires_at = {} WHERE id = {id}",
                now() - 1
            ),
        )
        .await;
        assert_eq!(view(b.clone()).await, 404, "expiry ends the grant");
        exec(
            db,
            &format!("UPDATE server_passwords SET expires_at = NULL WHERE id = {id}"),
        )
        .await;
        assert_eq!(view(a.clone()).await, 200);
        let revoked = client
            .call(
                "DELETE",
                &format!("/servers/vault/passwords/{id}"),
                Some("alice"),
                None,
                &[],
            )
            .await;
        assert_eq!(revoked.0, 200);
        assert_eq!(view(a).await, 404, "revoking ends the grant");
        assert_eq!(view(permanent).await, 200);
        let carol = client
            .call("GET", "/servers/vault", Some("carol"), None, &[])
            .await;
        assert_eq!(carol.0, 200, "members who joined with it stay");
        let list = json(
            &client
                .call("GET", "/servers/vault/passwords", Some("alice"), None, &[])
                .await,
        );
        let row = list["passwords"]
            .as_array()
            .expect("list")
            .iter()
            .find(|p| p["id"] == id)
            .expect("still listed")
            .clone();
        assert_eq!(row["status"], "revoked");
        assert_eq!(row["uses"], 3);
        assert_eq!(row["label"], "Friends");
        let raw = String::from_utf8_lossy(
            &client
                .call("GET", "/servers/vault/passwords", Some("alice"), None, &[])
                .await
                .2,
        )
        .into_owned();
        assert!(!raw.contains("argon2") && !raw.contains("lookup") && !raw.contains(&secret));
        let members = json(
            &client
                .call("GET", "/servers/vault/members", Some("alice"), None, &[])
                .await,
        );
        let carol = members
            .as_array()
            .expect("members")
            .iter()
            .find(|m| m["username"] == "carol")
            .expect("carol")
            .clone();
        assert_eq!(carol["joined_via"]["label"], "Friends");
        let as_carol = json(
            &client
                .call("GET", "/servers/vault/members", Some("carol"), None, &[])
                .await,
        );
        assert!(
            as_carol
                .as_array()
                .expect("members")
                .iter()
                .all(|m| m.get("joined_via").is_none())
        );
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn guests_spend_limited_passwords_like_everyone() {
        let (state, path) = temp_state("access_guest_tickets").await;
        fixture(&state).await;
        let db = &state.db;
        for name in ["carol", "dave"] {
            user(db, name).await;
        }
        let (client, server) = serve(&state).await;
        let created = json(
            &client
                .call(
                    "POST",
                    "/servers/vault/passwords",
                    Some("alice"),
                    Some(r#"{"label":"Two","max_uses":2}"#),
                    &[],
                )
                .await,
        );
        let id = created["id"].as_i64().expect("id");
        let body = format!(
            r#"{{"password":"{}"}}"#,
            created["password"].as_str().expect("password")
        );
        let ask = |viewer: Option<&'static str>, route: &'static str| {
            let (client, body) = (&client, body.clone());
            async move { client.call("POST", route, viewer, Some(&body), &[]).await }
        };
        let first = ask(None, "/servers/vault/guest_access").await;
        assert_eq!(first.0, 200, "{}", String::from_utf8_lossy(&first.2));
        let first = json(&first)["grant"].as_str().expect("grant").to_string();
        let uses = format!("SELECT uses FROM server_passwords WHERE id = {id}");
        assert_eq!(scalar(db, &uses).await, Some(1), "a guest's use counts");
        let joined = ask(Some("carol"), "/servers/vault/join").await;
        assert_eq!(joined.0, 200, "a member's use counts the same way");
        assert_eq!(scalar(db, &uses).await, Some(2));
        let refused = ask(None, "/servers/vault/guest_access").await;
        assert_eq!(refused.0, 404, "used up, it lets no new guest in");
        assert_eq!(
            refused.2,
            ask(Some("dave"), "/servers/vault/join").await.2,
            "nor anyone else, with the same answer"
        );
        assert_eq!(scalar(db, &uses).await, Some(2));
        let view = |grant: String| {
            let client = &client;
            async move {
                client
                    .call(
                        "GET",
                        "/servers/vault",
                        None,
                        None,
                        &[("x-guest-grant", &grant)],
                    )
                    .await
                    .0
            }
        };
        assert_eq!(
            view(first.clone()).await,
            200,
            "the guest who got in keeps reading"
        );
        exec(
            db,
            &format!(
                "UPDATE server_passwords SET expires_at = {} WHERE id = {id}",
                now() - 1
            ),
        )
        .await;
        assert_eq!(view(first).await, 404, "until the password ends");
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn password_admin_rules() {
        let (state, path) = temp_state("access_password_admin").await;
        let state = crate::api::rare::tests::unlimited(state);
        fixture(&state).await;
        let db = &state.db;
        let (client, server) = serve(&state).await;
        let create = |who: &'static str, server: &'static str, body: String| {
            let client = &client;
            async move {
                let r = client
                    .call(
                        "POST",
                        &format!("/servers/{server}/passwords"),
                        Some(who),
                        Some(&body),
                        &[],
                    )
                    .await;
                (r.0, String::from_utf8_lossy(&r.2).into_owned())
            }
        };
        let err = |m: &str| {
            let reason = match m {
                "Use at least 8 characters, or leave it blank for a generated one" => {
                    r#"{"kind":"invalid","field":"password"}"#
                }
                "Uses must be between 1 and 10000" => r#"{"kind":"invalid","field":"max_uses"}"#,
                m if m.starts_with("The expiry") || m.starts_with("Use either") => {
                    r#"{"kind":"invalid","field":"expires_in"}"#
                }
                "A server can have at most 50 active passwords" => {
                    r#"{"kind":"limit","control":"server_passwords"}"#
                }
                _ => r#"{"kind":"conflict"}"#,
            };
            (400, format!(r#"{{"error":"{m}","reason":{reason}}}"#))
        };
        assert_eq!(create("bob", "rchat", "{}".into()).await.0, 403);
        exec(db, "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('vault', 'bob', 0, 0, 0)").await;
        assert_eq!(create("bob", "vault", "{}".into()).await.0, 403);
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('open', 'Open', 'alice', 0)").await;
        add_member(db, "open", "alice", 1, 0, 0).await;
        assert_eq!(
            create("alice", "open", "{}".into()).await,
            err("Make the server password protected first")
        );
        assert_eq!(
            create("alice", "vault", r#"{"password":"pw"}"#.into()).await,
            err("Use at least 8 characters, or leave it blank for a generated one")
        );
        assert_eq!(
            create("alice", "vault", r#"{"password":"expired-pw"}"#.into()).await,
            err("That password was already used here. Pick another one")
        );
        assert_eq!(
            create("alice", "vault", r#"{"expires_in":30}"#.into()).await,
            err("The expiry must be at least a minute away")
        );
        assert_eq!(
            create(
                "alice",
                "vault",
                format!(r#"{{"expires_at":{}}}"#, now() + EXPIRY_MAX + 3600)
            )
            .await,
            err("The expiry can be at most a year away")
        );
        assert_eq!(
            create(
                "alice",
                "vault",
                r#"{"expires_in":60,"expires_at":99999999999}"#.into()
            )
            .await,
            err("Use either expires_in or expires_at")
        );
        for uses in [0, 10_001] {
            assert_eq!(
                create("alice", "vault", format!(r#"{{"max_uses":{uses}}}"#)).await,
                err("Uses must be between 1 and 10000")
            );
        }
        assert_eq!(
            create(
                "alice",
                "vault",
                format!(r#"{{"expires_at":{}}}"#, i64::MIN)
            )
            .await,
            err("The expiry must be at least a minute away")
        );
        let patch = |body: &'static str| {
            let client = &client;
            async move {
                let r = client
                    .call("PATCH", "/servers/vault", Some("alice"), Some(body), &[])
                    .await;
                (r.0, String::from_utf8_lossy(&r.2).into_owned())
            }
        };
        let clash = err("That password is already in use for this server");
        let live = extra(db, "vault", "live-password", None, None, 0, None).await;
        assert_eq!(patch(r#"{"password":"live-password"}"#).await, clash);
        assert_eq!(patch(r#"{"password":"  live-password "}"#).await, clash);
        let dead = patch(r#"{"password":"expired-pw"}"#).await;
        assert_eq!(dead.0, 200, "{}", dead.1);
        assert_eq!(
            patch(r#"{"password":"short"}"#).await,
            err("Use at least 8 characters, or leave it blank for a generated one")
        );
        let back = patch(r#"{"password":"pw-permanent"}"#).await;
        assert_eq!(back.0, 200, "{}", back.1);
        assert_eq!(
            create("alice", "vault", r#"{"password":"pw-permanent"}"#.into()).await,
            err("That password is already in use")
        );
        exec(
            db,
            &format!("DELETE FROM server_passwords WHERE id = {live}"),
        )
        .await;
        let (status, body) = create(
            "alice",
            "vault",
            r#"{"label":"  Ticket  ","password":"  my ticket ","max_uses":1,"expires_in":1800}"#
                .into(),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let made: serde_json::Value = serde_json::from_str(&body).expect("json");
        assert_eq!(made["label"], "Ticket");
        assert_eq!(made["password"], "my ticket");
        assert_eq!(made["status"], "live");
        assert_eq!(made["max_uses"], 1);
        assert_eq!(made["uses"], 0);
        let opens = resolve_server(
            db,
            "vault",
            Some(&mem_user("root", true)),
            &Proof::password(Some("my ticket")),
        )
        .await;
        assert!(opens.is_ok());
        for _ in 1..crate::api::passwords::ACTIVE_MAX {
            assert_eq!(create("alice", "vault", "{}".into()).await.0, 200);
        }
        assert_eq!(
            create("alice", "vault", "{}".into()).await,
            err("A server can have at most 50 active passwords")
        );
        let list = json(
            &client
                .call("GET", "/servers/vault/passwords", Some("alice"), None, &[])
                .await,
        );
        assert_eq!(list["protected"], true);
        assert_eq!(list["permanent"], true);
        assert_eq!(list["closed"], false);
        let rows = list["passwords"].as_array().expect("rows");
        assert_eq!(rows.iter().filter(|p| p["status"] == "live").count(), 50);
        let statuses: Vec<&str> = rows.iter().filter_map(|p| p["status"].as_str()).collect();
        let first_dead = statuses
            .iter()
            .position(|s| *s != "live")
            .expect("dead rows");
        assert!(
            statuses[first_dead..].iter().all(|s| *s != "live"),
            "live first"
        );
        for s in ["expired", "revoked", "used_up"] {
            assert!(statuses.contains(&s), "{s}");
        }
        let closed = json(
            &client
                .call("GET", "/servers/closed/passwords", Some("alice"), None, &[])
                .await,
        );
        assert_eq!(
            (
                closed["protected"].clone(),
                closed["permanent"].clone(),
                closed["closed"].clone()
            ),
            (true.into(), false.into(), true.into())
        );
        let missing = client
            .call(
                "DELETE",
                "/servers/vault/passwords/999999",
                Some("alice"),
                None,
                &[],
            )
            .await;
        assert_eq!(
            (missing.0, missing.2),
            (404, br#"{"error":"Password not found"}"#.to_vec())
        );
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn going_public_or_renaming_revokes_extra_passwords() {
        let (state, path) = temp_state("access_password_switch").await;
        fixture(&state).await;
        let db = &state.db;
        let id = extra(db, "vault", "live-pw", None, None, 0, None).await;
        let (client, server) = serve(&state).await;
        let patch = |name: &'static str, body: &'static str| {
            let client = &client;
            async move {
                client
                    .call(
                        "PATCH",
                        &format!("/servers/{name}"),
                        Some("alice"),
                        Some(body),
                        &[],
                    )
                    .await
                    .0
            }
        };
        assert_eq!(
            patch("vault", r#"{"password":"","protected":true}"#).await,
            200
        );
        let list = json(
            &client
                .call("GET", "/servers/vault/passwords", Some("alice"), None, &[])
                .await,
        );
        assert_eq!(
            (
                list["protected"].clone(),
                list["permanent"].clone(),
                list["closed"].clone()
            ),
            (true.into(), false.into(), false.into())
        );
        let bob = mem_user("bob", false);
        assert!(
            resolve_server(db, "vault", Some(&bob), &Proof::password(Some("pw")))
                .await
                .is_err()
        );
        assert!(
            resolve_server(db, "vault", Some(&bob), &Proof::password(Some("live-pw")))
                .await
                .is_ok()
        );
        assert_eq!(patch("vault", r#"{"name":"Vault"}"#).await, 200);
        assert!(
            resolve_server(db, "vault", Some(&bob), &Proof::password(Some("live-pw")))
                .await
                .is_ok(),
            "a case change keeps them"
        );
        assert_eq!(patch("vault", r#"{"name":"Safe"}"#).await, 200);
        assert_eq!(
            scalar(db, &format!("SELECT COUNT(*) FROM server_passwords WHERE id = {id} AND server = 'safe' AND revoked_at IS NOT NULL")).await,
            Some(1)
        );
        let list = json(
            &client
                .call("GET", "/servers/safe/passwords", Some("alice"), None, &[])
                .await,
        );
        assert_eq!(list["closed"], true);
        let other = extra(db, "safe", "new-pw", None, None, 0, None).await;
        assert_eq!(patch("safe", r#"{"protected":false}"#).await, 200);
        assert_eq!(
            scalar(db, &format!("SELECT COUNT(*) FROM server_passwords WHERE id = {other} AND revoked_at IS NOT NULL")).await,
            Some(1)
        );
        let opened = resolve_server(db, "safe", Some(&bob), &Proof::none())
            .await
            .expect("public");
        assert_eq!(opened.via(), Via::Public);
        assert_eq!(patch("safe", r#"{"protected":true}"#).await, 200);
        let list = json(
            &client
                .call("GET", "/servers/safe/passwords", Some("alice"), None, &[])
                .await,
        );
        assert_eq!(list["closed"], true, "revoked passwords never come back");
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn password_attempts_have_address_and_server_budgets() {
        let (state, path) = temp_state("access_budgets").await;
        fixture(&state).await;
        let db = &state.db;
        let ip = |s: &str| -> std::net::IpAddr { s.parse().expect("ip") };
        let attempt = |from: std::net::IpAddr, name: &'static str, password: &'static str| {
            budget::as_client(from, async move {
                match resolve_server(db, name, None, &Proof::password(Some(password))).await {
                    Ok(_) => (200, String::new()),
                    Err(ApiError(status, body, _)) => (status.as_u16(), body),
                }
            })
        };
        let denied = (404, DENIED.to_string());
        let refused = (429, budget::SLOW_DOWN.to_string());
        let ok = (200, String::new());
        let attacker = ip("203.0.113.5");
        let mut seen = Vec::new();
        for name in ["vault", "ghost"] {
            let mut replies = Vec::new();
            for _ in 0..7 {
                replies.push(attempt(attacker, name, "wrong").await);
            }
            replies.push(attempt(attacker, name, "pw").await);
            assert_eq!(
                replies[..5],
                vec![denied.clone(); 5],
                "{name}: 5 free tries"
            );
            assert_eq!(
                replies[5..],
                vec![refused.clone(); 3],
                "{name}: then a wait, also for the right password, so a refusal tells nothing"
            );
            seen.push(replies);
        }
        assert_eq!(
            seen[0], seen[1],
            "a missing name answers like a protected one"
        );
        assert_eq!(
            attempt(ip("198.51.100.9"), "vault", "pw").await,
            ok,
            "an attacker's wait does not block another address"
        );
        for name in ["vault", "ghost"] {
            for _ in 0..PASSWORD_FAILURES_MAX {
                PASSWORD_FAILURES.spend(&budget_key(db, name), 1.0, Instant::now());
            }
        }
        assert_eq!(
            attempt(ip("198.51.100.10"), "vault", "pw").await,
            ok,
            "a hot name still lets a new address in on the first try"
        );
        let mut hot = Vec::new();
        for name in ["vault", "ghost"] {
            let from = ip("198.51.100.11");
            let mut replies = Vec::new();
            for _ in 0..4 {
                replies.push(attempt(from, name, "wrong").await);
            }
            assert_eq!(
                replies[..3],
                vec![denied.clone(); 3],
                "{name}: hot names allow 3"
            );
            assert_eq!(replies[3], refused, "{name}");
            hot.push(replies);
        }
        assert_eq!(
            hot[0], hot[1],
            "hot missing and protected names answer alike"
        );
        assert_eq!(
            attempt(ip("198.51.100.12"), "VAULT", "wrong").await,
            attempt(ip("198.51.100.13"), "Ghost", "wrong").await
        );
        let busy = ip("192.0.2.200");
        for n in 0..30 {
            let name: &'static str = Box::leak(format!("name{n}").into_boxed_str());
            assert_eq!(attempt(busy, name, "wrong").await, denied);
        }
        assert_eq!(
            attempt(busy, "other", "wrong").await,
            refused,
            "30 tries per address across names"
        );
        let members = resolve_server(db, "vault", Some(&mem_user("alice", false)), &Proof::none())
            .await
            .map(|a| a.via());
        assert_eq!(
            members.ok(),
            Some(Via::Member),
            "members never send a password"
        );
        let v6 = ip("2001:db8::1");
        for _ in 1..30 {
            PASSWORD_TRIES.take(
                &budget_key(db, &budget::group(v6).to_string()),
                1.0,
                Instant::now(),
            );
        }
        assert_eq!(attempt(ip("2001:db8::2"), "third", "wrong").await, denied);
        assert_eq!(
            attempt(ip("2001:db8::3"), "fourth", "wrong").await,
            refused,
            "the /64 shares one budget"
        );
        let network = budget_key(db, &budget::wide(ip("100.64.7.1")).to_string());
        for _ in 1..NETWORK_TRIES_MAX {
            NETWORK_TRIES.take(&network, 1.0, Instant::now());
        }
        assert_eq!(attempt(ip("100.64.7.2"), "vault", "pw").await, ok);
        assert_eq!(
            attempt(ip("100.64.7.3"), "vault", "pw").await,
            ok,
            "the right password gives the network try back"
        );
        assert_eq!(attempt(ip("100.64.7.4"), "fifth", "wrong").await, denied);
        assert_eq!(
            attempt(ip("100.64.7.5"), "sixth", "wrong").await,
            refused,
            "a /24 shares one budget across its addresses"
        );
        assert_eq!(
            attempt(ip("100.64.8.5"), "sixth", "wrong").await,
            denied,
            "other networks are not affected"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_refused_network_does_not_touch_address_budgets() {
        let (state, path) = temp_state("access_network_first").await;
        fixture(&state).await;
        let db = &state.db;
        let attempt = |from: std::net::IpAddr| {
            budget::as_client(from, async move {
                resolve_server(db, "vault", None, &Proof::password(Some("wrong")))
                    .await
                    .map(|_| ())
                    .map_err(|ApiError(status, _, _)| status.as_u16())
            })
        };
        let in_network = |n: u16| {
            std::net::IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 0x77, n, 0, 0, 0, 1))
        };
        let network = budget_key(db, &budget::wide(in_network(0)).to_string());
        for _ in 0..NETWORK_TRIES_MAX {
            NETWORK_TRIES.take(&network, 1.0, Instant::now());
        }
        for n in 0..20 {
            assert_eq!(attempt(in_network(n)).await, Err(429));
            let address = budget_key(db, &budget::group(in_network(n)).to_string());
            assert_eq!(
                PASSWORD_TRIES.used(&address),
                None,
                "no address entry for a refused network"
            );
        }
        let spent =
            std::net::IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 0x78, 1, 0, 0, 0, 1));
        let address = budget_key(db, &budget::group(spent).to_string());
        for _ in 0..30 {
            PASSWORD_TRIES.take(&address, 1.0, Instant::now());
        }
        let wide = budget_key(db, &budget::wide(spent).to_string());
        NETWORK_TRIES.take(&wide, 1.0, Instant::now());
        assert_eq!(attempt(spent).await, Err(429));
        assert_eq!(
            NETWORK_TRIES.used(&wide),
            Some(1.0),
            "a refused address gives the network try back"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn password_budgets_are_reserved_before_the_check() {
        let (state, path) = temp_state("access_budget_race").await;
        fixture(&state).await;
        let db = &state.db;
        let from: std::net::IpAddr = "203.0.113.77".parse().expect("ip");
        let attempt = |name: &'static str| {
            budget::as_client(from, async move {
                resolve_server(db, name, None, &Proof::password(Some("wrong")))
                    .await
                    .map(|_| ())
                    .map_err(|ApiError(status, _, _)| status.as_u16())
            })
        };
        let before = argon2_runs();
        assert_eq!(attempt("ghost").await, Err(404));
        let (verify, derive) = diff(argon2_runs(), before);
        let before = argon2_runs();
        let results = futures_util::future::join_all((0..20).map(|_| attempt("vault"))).await;
        let after = diff(argon2_runs(), before);
        let denied = results.iter().filter(|r| **r == Err(404)).count();
        let refused = results.iter().filter(|r| **r == Err(429)).count();
        assert_eq!(
            (denied, refused),
            (5, 15),
            "concurrent attempts can not pass the check together"
        );
        assert_eq!(
            after,
            (5 * verify, 5 * derive),
            "refused attempts run no argon2"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn site_admins_inside_a_server_act_as_members() {
        let (state, path) = temp_state("access_staff_traces").await;
        let f = fixture(&state).await;
        let db = &state.db;
        let (client, server) = serve(&state).await;
        let made = client
            .call(
                "POST",
                "/servers/vault/passwords",
                Some("root"),
                Some("{}"),
                &[],
            )
            .await;
        assert_eq!(made.0, 200);
        assert_eq!(json(&made)["created_by"], serde_json::Value::Null);
        let made = client
            .call(
                "POST",
                "/servers/vault/passwords",
                Some("alice"),
                Some("{}"),
                &[],
            )
            .await;
        assert_eq!(json(&made)["created_by"], "alice");
        add_member(db, "rchat", "root", 0, 0, 0).await;
        let root = mem_user("root", true);
        let announce = id_of(db, "INSERT INTO channels(server, name, created_at, restrict_send, slowmode_seconds) VALUES('rchat', 'news', 0, 1, 0) RETURNING id").await;
        let channel = resolve_channel(db, announce, Some(&root), &Proof::none())
            .await
            .expect("site admins still see it");
        assert_eq!(
            channel.send_gate(db).await.map_err(|e| e.0.as_u16()),
            Err(403),
            "no send right from the site admin flag"
        );
        let slow = id_of(db, "INSERT INTO channels(server, name, created_at, slowmode_seconds) VALUES('rchat', 'slow', 0, 600) RETURNING id").await;
        exec(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({slow}, 'root', 'hi', {})", now())).await;
        let channel = resolve_channel(db, slow, Some(&root), &Proof::none())
            .await
            .expect("slow");
        assert_eq!(
            channel.send_gate(db).await.map_err(|e| e.0.as_u16()),
            Err(429),
            "slow mode applies"
        );
        let general: i64 = id_of(
            db,
            "SELECT id FROM channels WHERE server = 'rchat' AND name = 'general'",
        )
        .await;
        let msg = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({general}, 'alice', 'pin me', 1) RETURNING id")).await;
        let resolved = resolve_message(db, msg, Some(&root), &Proof::none())
            .await
            .expect("message");
        assert_eq!(
            resolved.pin_gate(db).await.map_err(|e| e.0.as_u16()),
            Err(403),
            "pinning needs Pin messages as a member"
        );
        let _ = f;
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn pins_need_the_send_right_and_actions_are_paced() {
        let (state, path) = temp_state("access_pin_send").await;
        fixture(&state).await;
        let db = &state.db;
        add_member(db, "rchat", "carl", 1, Perm::PinMessages as i64, 0).await;
        let carl = mem_user("carl", false);
        let news = id_of(db, "INSERT INTO channels(server, name, created_at, restrict_send) VALUES('rchat', 'news', 0, 1) RETURNING id").await;
        let msg = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({news}, 'alice', 'x', 1) RETURNING id")).await;
        let resolved = resolve_message(db, msg, Some(&carl), &Proof::none())
            .await
            .expect("message");
        assert_eq!(
            resolved.pin_gate(db).await.map_err(|e| e.1),
            Err("No permission to send in this channel".to_string())
        );
        let general: i64 = id_of(
            db,
            "SELECT id FROM channels WHERE server = 'rchat' AND name = 'general'",
        )
        .await;
        let msg = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({general}, 'alice', 'y', 1) RETURNING id")).await;
        let resolved = resolve_message(db, msg, Some(&carl), &Proof::none())
            .await
            .expect("message");
        for _ in 1..ACTIONS_MAX {
            resolved.react_gate(db).await.expect("within the pace");
        }
        assert_eq!(
            resolved.react_gate(db).await.map_err(|e| e.0.as_u16()),
            Err(429)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_password_caps_hold_under_concurrency() {
        let (state, path) = temp_state("access_password_caps").await;
        fixture(&state).await;
        let db = &state.db;
        let live_now = scalar(db, "SELECT COUNT(*) FROM server_passwords WHERE server = 'vault' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > 4000000000) AND (max_uses IS NULL OR uses < max_uses)").await.unwrap_or(0);
        let free = 5;
        for n in 0..(crate::api::passwords::ACTIVE_MAX - live_now - free) {
            exec(db, &format!("INSERT INTO server_passwords(server, hash, lookup, created_at) VALUES('vault', '!lookup', 'fake{n}', 0)")).await;
        }
        let create = || {
            let state = state.clone();
            async move {
                crate::api::passwords::create_password(
                    axum::extract::State(state),
                    crate::api::Authed(mem_user("alice", false)),
                    axum::extract::Path("vault".to_string()),
                    axum::Json(serde_json::from_str("{}").expect("body")),
                )
                .await
                .map(|axum::Json(made)| made)
            }
        };
        let results = futures_util::future::join_all((0..10).map(|_| create())).await;
        let made: Vec<_> = results.into_iter().filter_map(Result::ok).collect();
        assert_eq!(
            made.len(),
            free as usize,
            "the 50 cap is checked inside the insert"
        );
        assert_eq!(
            scalar(
                db,
                &format!(
                    "SELECT COUNT(*) FROM server_passwords WHERE id = {} AND hash = '{}'",
                    made[0].info.id,
                    crate::db::NO_EXTRA_HASH
                )
            )
            .await,
            Some(1),
            "no second verifier is stored"
        );
        exec(
            db,
            "UPDATE server_passwords SET revoked_at = 1 WHERE server = 'vault'",
        )
        .await;
        let stored = scalar(
            db,
            "SELECT COUNT(*) FROM server_passwords WHERE server = 'vault'",
        )
        .await
        .unwrap_or(0);
        for n in stored..crate::api::passwords::ROWS_MAX {
            exec(db, &format!("INSERT INTO server_passwords(server, hash, lookup, created_at, revoked_at) VALUES('vault', '!lookup', 'dead{n}', 0, 1)")).await;
        }
        assert_eq!(
            create().await.map(|_| ()).map_err(|e| e.1),
            Err(
                "Too many old passwords. They are removed 30 days after they stop working"
                    .to_string()
            )
        );
        done(state, path).await;
    }
}
