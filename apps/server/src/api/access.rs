use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

use axum::http::{HeaderMap, StatusCode};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

use crate::api::audit::Actor;
use crate::api::auth::{Work, derive_key, dummy_hash, verify_in};
use crate::api::budget::{self, Backoff, Budget, slow_down};
use crate::api::{ApiError, ServerSummaryLite, header_grants};
use crate::db::{
    ChannelAccess, ChannelKind, Db, LIVE_AUTHOR, LIVE_DM, MediaKind, Perm, PermRow, Restrict, User,
    can_grant, can_moderate, fold_access, now, perm_row, perm_subjects, pool_key,
};

mod rules;

use rules::{
    channel_access, channel_viewable, channel_viewers, effective_perms, grants_open, is_banned,
    live_grant_servers, member_perms, view_rules, view_under,
};

pub const DENIED: &str = "Server not found or wrong password";
pub const PASSWORD_REQUIRED: &str = "Password required";
pub const NOT_FOUND: &str = "Not found";
pub const BANNED: &str = "You are banned from this server";
pub const TIMED_OUT: &str = "You are timed out in this server";

pub fn denied() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, DENIED.to_string())
}

pub fn password_required() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, PASSWORD_REQUIRED.to_string())
}

pub fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, NOT_FOUND.to_string())
}

/// The permissions a timed-out member keeps: only those that read.
pub const READ_PERMS: i64 = Perm::ViewAuditLog as i64;

pub fn timed_out_error() -> ApiError {
    forbidden(TIMED_OUT)
}

/// When the timeout of `username` in `server` ends (unix seconds), if they are timed out right
/// now. Expiry is time-based: a row whose `until` has passed counts as no timeout.
pub async fn timed_out(db: &Db, server: &str, username: &str) -> Result<Option<i64>, ApiError> {
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
    ApiError(StatusCode::FORBIDDEN, BANNED.to_string())
}

fn forbidden(msg: &str) -> ApiError {
    ApiError(StatusCode::FORBIDDEN, msg.to_string())
}

fn hidden(e: ApiError) -> ApiError {
    match e {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, _) => e,
        _ => not_found(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Public,
    Member,
    Password,
    Grant,
    Staff,
}

#[derive(Clone, Copy)]
enum Slot<'a> {
    Closed,
    Open(Option<&'a str>),
}

pub struct Proof<'a> {
    password: Slot<'a>,
    grants: Vec<String>,
}

impl<'a> Proof<'a> {
    pub fn none() -> Proof<'static> {
        Proof {
            password: Slot::Closed,
            grants: Vec::new(),
        }
    }

    pub fn grants(grants: Vec<String>) -> Proof<'static> {
        Proof {
            password: Slot::Closed,
            grants,
        }
    }

    pub fn headers(headers: &HeaderMap) -> Proof<'static> {
        Proof::grants(header_grants(headers))
    }

    pub fn password(password: Option<&'a str>) -> Proof<'a> {
        Proof {
            password: Slot::Open(password.map(str::trim).filter(|p| !p.is_empty())),
            grants: Vec::new(),
        }
    }

    pub fn and_grants(self, grants: Vec<String>) -> Proof<'a> {
        Proof { grants, ..self }
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
static PASSWORD_TRIES: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(30, Duration::from_secs(600), 100_000));

/// Password attempts per wider network (IPv4 /24, IPv6 /48) across all names. Attempts with the
/// right password are given back.
static NETWORK_TRIES: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(NETWORK_TRIES_MAX, Duration::from_secs(600), 100_000));

pub(crate) const NETWORK_TRIES_MAX: u32 = 150;

/// Failed attempts per client address and server name: 5 free, then a doubling wait up to an
/// hour. On a hot name (see `PASSWORD_FAILURES`) each address gets 3 an hour, never fewer, so
/// someone with the right password from another address still gets in.
static NAME_TRIES: LazyLock<Backoff> =
    LazyLock::new(|| Backoff::new(5, 3, Duration::from_secs(3600), 100_000));

/// Failed password attempts per server name, from all addresses. Past the limit the name is
/// hot. Names that do not exist count the same way, so nothing shows whether a server exists.
static PASSWORD_FAILURES: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(PASSWORD_FAILURES_MAX, Duration::from_secs(3600), 100_000));

pub(crate) const PASSWORD_FAILURES_MAX: u32 = 50;

fn budget_key(db: &Db, part: &str) -> String {
    format!("{}\n{part}", pool_key(db))
}

/// A password attempt with its budgets reserved before the password is checked. It counts as
/// failed unless `passed` or `refund` gives it back. Every refusal is the same 429 for every name.
struct Attempt {
    network: Option<(String, std::time::Instant)>,
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
                match NETWORK_TRIES.reserve(&key) {
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
        if ip.is_some() && !PASSWORD_TRIES.take(&budget_key(db, &address)) {
            attempt.give_back_network();
            return Err(slow_down());
        }
        let hot = PASSWORD_FAILURES.spent(&attempt.server);
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
            NETWORK_TRIES.refund(key, *at);
        }
    }

    /// The attempt did not fail (right password, or nothing was checked).
    fn refund(self) {
        self.give_back_network();
        NAME_TRIES.refund(&self.name);
    }

    fn failed(self) -> ApiError {
        NAME_TRIES.failed(&self.name);
        PASSWORD_FAILURES.note(&self.server);
        denied()
    }
}

fn attempt_failed(attempt: Option<Attempt>) -> ApiError {
    match attempt {
        Some(attempt) => attempt.failed(),
        None => denied(),
    }
}

async fn gate(db: &Db, name: &str, who: Who<'_>, proof: &Proof<'_>) -> Result<Gate, ApiError> {
    let key = name.to_lowercase();
    let mut attempt = match proof.password {
        Slot::Open(Some(_)) => Some(Attempt::start(db, &key)?),
        Slot::Open(None) | Slot::Closed => None,
    };
    let row = sqlx::query(
        "SELECT name, display_name, creator, password_hash, banner_color, name_color FROM servers WHERE name = $1 AND COALESCE(password_hash, '') <> '!purging'",
    )
    .bind(&key)
    .fetch_optional(db)
    .await?;
    let (member, banned, history) = match who.username {
        Some(u) => (
            exists(
                db,
                "SELECT 1 FROM members WHERE server = $1 AND username = $2",
                &key,
                u,
            )
            .await?,
            exists(
                db,
                "SELECT 1 FROM server_bans WHERE server = $1 AND username = $2",
                &key,
                u,
            )
            .await?,
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
        None => grants_open(db, &proof.grants, &key).await?,
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
            Slot::Open(None) => password_required(),
        });
    };
    let lite = ServerSummaryLite {
        name: row.try_get(0)?,
        display_name: row.try_get(1)?,
        creator: row.try_get(2)?,
        has_password: hash.is_some(),
        banner_color: row.try_get(4)?,
        name_color: row.try_get(5)?,
    };
    let mut ticket = None;
    let via = match (hash.is_some(), member) {
        (_, true) => Via::Member,
        (false, false) => Via::Public,
        (true, false) => match (granted, who.site_admin, proof.password, checked) {
            (true, _, _, _) => Via::Grant,
            (false, true, Slot::Closed, _) => Via::Staff,
            (false, _, Slot::Open(Some(_)), Some((true, _))) => Via::Password,
            (false, _, Slot::Open(Some(_)), Some((false, Some(t)))) => {
                ticket = Some(t);
                Via::Password
            }
            (false, _, Slot::Open(Some(_)), _) => return Err(attempt_failed(attempt.take())),
            (false, _, Slot::Open(None), _) if banned && history => return Err(self::banned()),
            (false, _, Slot::Open(None), _) => return Err(password_required()),
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

impl ServerAccess {
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

    pub fn require_member(&self) -> Result<(), ApiError> {
        match self.is_member() {
            true => Ok(()),
            false => Err(forbidden("Not a member")),
        }
    }

    /// The viewer's permissions for acting. A member who is timed out keeps only the read
    /// rights (`READ_PERMS`) until the timeout ends; site admins are never limited, so a
    /// timeout shows nothing about them.
    pub async fn perms(&self, db: &Db) -> Result<i64, ApiError> {
        let bits = self.view_perms(db).await?;
        match &self.user {
            Some(user)
                if !user.is_site_admin
                    && bits & !READ_PERMS != 0
                    && timed_out(db, self.name(), &user.username).await?.is_some() =>
            {
                Ok(bits & READ_PERMS)
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

    pub async fn has_perm(&self, db: &Db, perm: Perm) -> bool {
        self.perms(db).await.is_ok_and(|p| p & perm as i64 != 0)
    }

    pub async fn require_perm(&self, db: &Db, perm: Perm) -> Result<(), ApiError> {
        let bit = perm as i64;
        match (self.perms(db).await?, self.view_perms(db).await?) {
            (p, _) if p & bit != 0 => Ok(()),
            (_, v) if v & bit != 0 => Err(timed_out_error()),
            _ => Err(forbidden("Missing permission")),
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

    /// The viewer's rights in each channel of this server that has rules or restrictions;
    /// channels that are not listed are open to everyone who can open the server.
    pub async fn channel_rights(&self, db: &Db) -> Result<HashMap<i64, ChannelAccess>, ApiError> {
        let channels = sqlx::query(
            "SELECT c.id, c.restrict_view, c.restrict_send FROM channels c WHERE c.server = $1 AND (c.restrict_view <> 0 OR c.restrict_send <> 0 OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = c.id))",
        )
        .bind(self.name())
        .fetch_all(db)
        .await?;
        if channels.is_empty() {
            return Ok(HashMap::new());
        }
        let (manage, subjects) = match &self.user {
            Some(user) => (
                self.manages_channels(db).await?,
                perm_subjects(db, Some(self.name()), &user.username).await?,
            ),
            None => (false, Vec::new()),
        };
        let rules = match manage {
            true => HashMap::new(),
            false => {
                let rows = sqlx::query(
                    "SELECT cp.channel_id, cp.subject, cp.can_view, cp.can_send, cp.can_read_history FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id WHERE c.server = $1",
                )
                .bind(self.name())
                .fetch_all(db)
                .await?;
                rules_by_channel(&rows)?
            }
        };
        let mut out = HashMap::with_capacity(channels.len());
        for r in &channels {
            let id: i64 = r.try_get(0)?;
            let list = rules.get(&id).map(Vec::as_slice).unwrap_or_default();
            out.insert(
                id,
                fold_access(list, &subjects, manage, Restrict::read(r, 1)?),
            );
        }
        Ok(out)
    }

    pub async fn require_moderate(&self, db: &Db, target: &str) -> Result<(), ApiError> {
        let mine = self.perms(db).await?;
        let theirs = self.member_perms(db, target).await?;
        match can_moderate(mine, self.site_admin(), theirs) {
            true => Ok(()),
            false => Err(forbidden("You can't moderate this member")),
        }
    }

    pub async fn require_grant(&self, db: &Db, perms: i64) -> Result<(), ApiError> {
        let mine = self.perms(db).await?;
        match can_grant(mine, self.site_admin(), perms) {
            true => Ok(()),
            false => Err(forbidden("You can't grant permissions you don't have")),
        }
    }

    pub async fn channel(self, db: &Db, id: i64) -> Result<ResolvedChannel, ApiError> {
        let row = sqlx::query(
            "SELECT server, kind, name, slowmode_seconds FROM channels WHERE id = $1 AND server = $2",
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
        Ok(ResolvedChannel {
            id,
            kind: ChannelKind::parse(&row.try_get::<String, _>(1)?)?,
            name: row.try_get(2)?,
            slowmode: row.try_get(3)?,
            rights,
            server: self,
        })
    }
}

pub struct ResolvedChannel {
    server: ServerAccess,
    id: i64,
    kind: ChannelKind,
    name: String,
    slowmode: i64,
    rights: ChannelAccess,
}

pub async fn resolve_channel(
    db: &Db,
    id: i64,
    viewer: Option<&User>,
    proof: &Proof<'_>,
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
        .channel(db, id)
        .await
}

/// A channel as an incoming webhook that posts into it sees it: no viewer, and every right in
/// that one channel (a webhook can always send in its own channel and nowhere else). Unknown
/// channels and servers being deleted get `not_found`.
pub(crate) async fn webhook_channel(db: &Db, id: i64) -> Result<ResolvedChannel, ApiError> {
    let r = sqlx::query(
        "SELECT c.server, c.kind, c.name, c.slowmode_seconds, s.display_name, s.creator, s.password_hash, s.banner_color, s.name_color FROM channels c JOIN servers s ON s.name = c.server WHERE c.id = $1 AND COALESCE(s.password_hash, '') <> '!purging'",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(not_found)?;
    Ok(ResolvedChannel {
        server: ServerAccess {
            lite: ServerSummaryLite {
                name: r.try_get(0)?,
                display_name: r.try_get(4)?,
                creator: r.try_get(5)?,
                has_password: r.try_get::<Option<String>, _>(6)?.is_some(),
                banner_color: r.try_get(7)?,
                name_color: r.try_get(8)?,
            },
            via: Via::Public,
            user: None,
            ticket: None,
        },
        id,
        kind: ChannelKind::parse(&r.try_get::<String, _>(1)?)?,
        name: r.try_get(2)?,
        slowmode: r.try_get(3)?,
        rights: ChannelAccess::all(true),
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
    let server: String = sqlx::query("SELECT server FROM channel_categories WHERE id = $1")
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
    pub fn id(&self) -> i64 {
        self.id
    }

    pub fn server(&self) -> &ServerAccess {
        &self.server
    }

    pub fn kind(&self) -> ChannelKind {
        self.kind
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Whether not everyone in its server may see the channel: it requires roles to view or has
    /// any permission rule (its name stays inside that audience, e.g. in forward origins).
    pub async fn restricted(&self, db: &Db) -> Result<bool, ApiError> {
        Ok(sqlx::query(
            "SELECT 1 FROM channels c WHERE c.id = $1 AND (c.restrict_view <> 0 OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = c.id))",
        )
        .bind(self.id)
        .fetch_optional(db)
        .await?
        .is_some())
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
                Ok(_) | Err(ApiError(StatusCode::NOT_FOUND, _)) => return Ok(Vec::new()),
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

    /// The server permissions that membership alone gives (see `member_rights`).
    pub async fn member_bits(&self, db: &Db) -> Result<i64, ApiError> {
        match &self.server.user {
            Some(user) if user.is_site_admin => {
                Ok(member_perms(db, self.server.name(), &user.username).await?)
            }
            Some(_) | None => self.server.perms(db).await,
        }
    }

    /// Refuses a viewer who is timed out in this channel's server. Every write in a server
    /// channel (sending, replies, threads, forwards, edits, reactions, pins, typing, voice and
    /// polls) goes through this; reading never does.
    pub async fn timeout_gate(&self, db: &Db) -> Result<(), ApiError> {
        let Some(user) = &self.server.user else {
            return Ok(());
        };
        match timed_out(db, self.server.name(), &user.username).await? {
            Some(_) => Err(timed_out_error()),
            None => Ok(()),
        }
    }

    /// Whether the viewer may send here at all: a member with the send permission in a text
    /// channel who is not timed out. Slow mode is not checked.
    async fn send_rights(&self, db: &Db) -> Result<&User, ApiError> {
        let Some(user) = &self.server.user else {
            return Err(forbidden("Not a member"));
        };
        self.server.require_member()?;
        if self.kind == ChannelKind::Voice {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Voice channels cannot receive messages".to_string(),
            ));
        }
        if !self.member_rights(db).await?.send {
            return Err(forbidden("No permission to send in this channel"));
        }
        self.timeout_gate(db).await?;
        Ok(user)
    }

    pub async fn send_gate(&self, db: &Db) -> Result<(), ApiError> {
        let user = self.send_rights(db).await?;
        if self.slowmode <= 0 {
            return Ok(());
        }
        let exempt = self.member_bits(db).await?
            & (Perm::ManageChannels as i64 | Perm::DeleteMessages as i64)
            != 0;
        if exempt {
            return Ok(());
        }
        self.slowmode_for(db, &user.username).await
    }

    /// Slow mode for `author` without exemptions: the wait since their last message here.
    pub(crate) async fn slowmode_for(&self, db: &Db, author: &str) -> Result<(), ApiError> {
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
        match last {
            Some(t) if now() - t < self.slowmode => Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                format!("Slow mode: wait {}s", self.slowmode - (now() - t)),
            )),
            _ => Ok(()),
        }
    }
}

/// Reactions, pins and edits per user. Each of them sends an event to everyone in the scope.
static ACTIONS: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(ACTIONS_MAX, Duration::from_secs(10), 100_000));

pub(crate) const ACTIONS_MAX: u32 = 30;

fn pace(db: &Db, user: Option<&User>) -> Result<(), ApiError> {
    match user {
        Some(user) if !ACTIONS.take(&budget_key(db, &user.username)) => Err(slow_down()),
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
        return Err(forbidden("Not a member"));
    }
    channel.server.require_member()?;
    pace(db, channel.server.user.as_ref())
}

pub struct MsgScope {
    pub channel_id: Option<i64>,
    pub dm_id: Option<i64>,
    pub thread_root_id: Option<i64>,
    pub kind: String,
    pub author: String,
    pub media_id: Option<String>,
    pub media_filename: Option<String>,
    pub media_kind: MediaKind,
    pub server: Option<String>,
    pub dm_users: Option<Vec<String>>,
}

pub struct ResolvedMessage {
    scope: MsgScope,
    channel: Option<ResolvedChannel>,
    user: Option<User>,
}

async fn dm_pair(db: &Db, id: i64, live: bool) -> Result<Option<Vec<String>>, ApiError> {
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
        "SELECT m.channel_id, m.dm_id, m.thread_root_id, m.author, m.media_id, m.media_filename, m.media_kind, m.created_at, m.kind FROM messages m WHERE m.id = $1 AND {LIVE_AUTHOR}"
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
            kind: r.try_get(8)?,
            author: r.try_get(3)?,
            media_id: r.try_get(4)?,
            media_filename: r.try_get(5)?,
            media_kind: MediaKind::parse(&r.try_get::<String, _>(6)?)?,
            server: None,
            dm_users: None,
        },
        r.try_get(7)?,
    ))
}

pub async fn resolve_message(
    db: &Db,
    id: i64,
    viewer: Option<&User>,
    proof: &Proof<'_>,
) -> Result<ResolvedMessage, ApiError> {
    let (mut scope, created_at) = message_row(db, id).await?;
    let channel = match (scope.channel_id, scope.dm_id) {
        (Some(cid), _) => {
            let channel = resolve_channel(db, cid, viewer, proof).await?;
            if channel
                .read_since(db)
                .await?
                .is_some_and(|since| created_at < since)
            {
                return Err(not_found());
            }
            scope.server = Some(channel.server.name().to_string());
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

pub async fn staff_message(db: &Db, user: &User, id: i64) -> Result<MsgScope, ApiError> {
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
    Ok(scope)
}

impl ResolvedMessage {
    pub fn scope(&self) -> &MsgScope {
        &self.scope
    }

    pub fn into_scope(self) -> MsgScope {
        self.scope
    }

    pub fn channel(&self) -> Option<&ResolvedChannel> {
        self.channel.as_ref()
    }

    pub fn thread_channel(&self) -> Result<&ResolvedChannel, ApiError> {
        match (&self.channel, self.scope.thread_root_id) {
            (Some(channel), None) if matches!(self.scope.kind.as_str(), "user" | "poll") => {
                Ok(channel)
            }
            (_, _) => Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Threads only start on channel messages".to_string(),
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

    /// Adding or removing a reaction: in a channel like sending (a signed-in member with the
    /// channel's send permission), in a DM being a participant while both accounts are live and
    /// neither blocked the other.
    pub async fn react_gate(&self, db: &Db) -> Result<(), ApiError> {
        match (&self.channel, self.scope.dm_id) {
            (Some(channel), _) => {
                channel_actor(db, channel)?;
                if !channel.member_rights(db).await?.send {
                    return Err(forbidden("No permission to react in this channel"));
                }
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
                    return Err(forbidden("No permission to vote in this channel"));
                }
                channel.timeout_gate(db).await
            }
            (None, Some(did)) => self.dm_writer(db, did).await,
            (None, None) => Err(not_found()),
        }
    }

    /// Closing or reopening a poll: its author while they are still a member who may view and
    /// send in the channel (or a participant of a live DM where neither blocked the other), or
    /// in a channel a member with the Manage messages (`DeleteMessages`) permission. Nobody who is
    /// timed out in the channel's server. `Ok(true)` when a moderator acts on someone else's poll.
    pub async fn poll_manage_gate(&self, db: &Db) -> Result<bool, ApiError> {
        let refused = || forbidden("Only the author or a moderator can do this");
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
                match channel.member_bits(db).await? & Perm::DeleteMessages as i64 != 0 {
                    true => Ok(!self.own()),
                    false => Err(refused()),
                }
            }
            (None, Some(did)) if self.own() => self.dm_writer(db, did).await.map(|()| false),
            (None, Some(_)) => Err(refused()),
            (None, None) => Err(not_found()),
        }
    }

    /// Pinning or unpinning: in a channel a signed-in member with the Manage messages
    /// (`DeleteMessages`) permission, in a DM either participant while both accounts are live and
    /// neither blocked the other.
    pub async fn pin_gate(&self, db: &Db) -> Result<(), ApiError> {
        match (&self.channel, self.scope.dm_id) {
            (Some(channel), _) => {
                channel_actor(db, channel)?;
                channel.timeout_gate(db).await?;
                let manage = channel.member_bits(db).await? & Perm::DeleteMessages as i64 != 0;
                match (manage, channel.member_rights(db).await?.send) {
                    (true, true) => Ok(()),
                    (false, _) => Err(forbidden("No permission to manage messages")),
                    (true, false) => Err(forbidden("No permission to send in this channel")),
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
            return Err(forbidden("You can only edit your own messages"));
        }
        match (&self.channel, self.scope.dm_id) {
            (Some(channel), _) => {
                channel.server.require_member()?;
                pace(db, self.user.as_ref())?;
                if !channel.member_rights(db).await?.send {
                    return Err(forbidden("No permission to send in this channel"));
                }
                channel.timeout_gate(db).await
            }
            (None, Some(did)) => self.dm_writer(db, did).await,
            (None, None) => Err(not_found()),
        }
    }

    pub async fn require_can_delete(&self, db: &Db) -> Result<(), ApiError> {
        let own = self.own();
        let allowed = own
            || match &self.channel {
                Some(channel) => channel.server.has_perm(db, Perm::DeleteMessages).await,
                None => false,
            };
        match allowed {
            true => Ok(()),
            false => Err(forbidden("Not allowed")),
        }
    }
}

/// Restricted text-channel rights of `user` across the servers it is a member of (unread
/// counts): channels with rules or restrictions. Membership is the proof: rows of servers the
/// user has not joined never load.
pub(crate) async fn member_channel_rights(
    db: &Db,
    user: &User,
) -> Result<HashMap<i64, ChannelAccess>, ApiError> {
    let channels = sqlx::query(
        "SELECT c.id, c.server, c.restrict_view, c.restrict_send FROM channels c JOIN members mem ON mem.server = c.server AND mem.username = $1 WHERE c.kind = 'text' AND (c.restrict_view <> 0 OR c.restrict_send <> 0 OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = c.id))",
    )
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    if channels.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT cp.channel_id, cp.subject, cp.can_view, cp.can_send, cp.can_read_history FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id JOIN members mem ON mem.server = c.server AND mem.username = $1 WHERE c.kind = 'text'",
    )
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    let subjects = perm_subjects(db, None, &user.username).await?;
    let rules = rules_by_channel(&rows)?;
    let mut manages: HashMap<String, bool> = HashMap::new();
    let mut out = HashMap::with_capacity(channels.len());
    for r in &channels {
        let (id, server): (i64, String) = (r.try_get(0)?, r.try_get(1)?);
        let restrict = Restrict::read(r, 2)?;
        let manage = match manages.get(&server) {
            Some(m) => *m,
            None => {
                let m =
                    effective_perms(db, &server, user).await? & Perm::ManageChannels as i64 != 0;
                manages.insert(server, m);
                m
            }
        };
        let list = rules.get(&id).map(Vec::as_slice).unwrap_or_default();
        out.insert(id, fold_access(list, &subjects, manage, restrict));
    }
    Ok(out)
}

/// Servers a guest may search: the ones its live grants in `proof` open.
pub(crate) async fn granted_servers(db: &Db, proof: &Proof<'_>) -> sqlx::Result<Vec<String>> {
    live_grant_servers(db, &proof.grants).await
}

/// Servers where `user` manages channels (search sees their restricted channels).
pub(crate) async fn channel_manager_servers(db: &Db, user: &User) -> sqlx::Result<Vec<String>> {
    rules::channel_manager_servers(db, user).await
}

/// WS event filtering and voice eviction: can `username` (or a guest) see channel `cid` of
/// `server` right now. Never answers a client with target data.
pub(crate) async fn ws_channel_view(
    db: &Db,
    server: &str,
    cid: i64,
    username: Option<&str>,
) -> sqlx::Result<bool> {
    let user = match username {
        Some(name) => crate::db::get_user(db, name).await?,
        None => None,
    };
    Ok(channel_access(db, server, cid, user.as_ref()).await?.view)
}

/// The view rules of a channel (`restrict_view` and its overrides), taken before it is deleted
/// so `channel_deleted` and the `layout_changed` after it reach only those who could view it.
/// Routing only, never sent to a client.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ViewRules {
    pub restrict: Restrict,
    pub rules: Vec<PermRow>,
}

/// The current view rules of channel `cid`, for `ws_view_under` once it is gone.
pub(crate) async fn ws_view_rules(db: &Db, cid: i64) -> sqlx::Result<ViewRules> {
    view_rules(db, cid).await
}

/// WS event filtering for a deleted channel: could `username` (or a guest) view a channel of
/// `server` with these `rules`, under the same rule as `ws_channel_view`. Never answers a client.
pub(crate) async fn ws_view_under(
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
/// `ResolvedChannel::read_since`. `None` when they can't view it (or on any error),
/// `Some(None)` with read history, otherwise `Some(Some(joined_at))` (now for non-members).
/// Never answers a client with target data.
pub(crate) async fn ws_channel_read_since(
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
    if access.history {
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
    db: &Db,
    server: &str,
    cid: i64,
    username: Option<&str>,
) -> Option<Option<i64>> {
    match username {
        Some(name) => ws_channel_read_since(db, server, cid, name).await,
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

/// Same as `ws_channel_view`, with any error meaning "not viewable".
#[cfg(test)]
pub(crate) async fn ws_channel_viewable(
    db: &Db,
    server: &str,
    cid: i64,
    username: Option<&str>,
) -> bool {
    channel_viewable(db, server, cid, username, false).await
}

/// Voice: whether `username` can view the channel through membership alone. A site admin gets
/// no more than a plain member here, so nobody sees them in a voice channel hidden from them.
pub(crate) async fn ws_voice_viewable(db: &Db, server: &str, cid: i64, username: &str) -> bool {
    channel_viewable(db, server, cid, Some(username), true).await
}

/// `member_timeout` fan-out: whether `username` sees the timeouts of `server` (the Timeout
/// members permission, or a site admin). A timeout takes the permission away, as in `perms`.
/// Never sent to anyone else.
pub(crate) async fn ws_sees_timeouts(
    db: &Db,
    server: &str,
    username: &str,
    site_admin: bool,
) -> sqlx::Result<bool> {
    if site_admin {
        return Ok(true);
    }
    if member_perms(db, server, username).await? & Perm::TimeoutMembers as i64 == 0 {
        return Ok(false);
    }
    let row = sqlx::query(
        "SELECT 1 FROM member_timeouts WHERE server = $1 AND username = $2 AND until > $3",
    )
    .bind(server)
    .bind(username)
    .bind(now())
    .fetch_optional(db)
    .await?;
    Ok(row.is_none())
}

/// WS ban fan-out and `look`: whether `username` is banned from `server`. Only used to drop
/// events or skip a subscription, never sent to anyone else.
pub(crate) async fn ws_banned(db: &Db, server: &str, username: &str) -> sqlx::Result<bool> {
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

pub(crate) async fn ws_typing_place(db: &Db, username: &str, scope: &str) -> Option<TypingPlace> {
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
            let resolved = root.thread_channel().ok()?;
            resolved.send_rights(db).await.ok()?;
            Some(channel(resolved))
        }
        "d" => {
            let users = resolve_dm(db, id, &user).await.ok()?;
            crate::api::blocks::check_dm_write(db, username, &users)
                .await
                .ok()?;
            Some(TypingPlace {
                server: None,
                channel_id: None,
                dm_id: Some(id),
                dm_users: Some(users),
                display_name,
            })
        }
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
        Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e)) => Err(sqlx::Error::Protocol(e)),
        Err(_) => Ok(false),
    }
}

pub(crate) async fn ws_server_open(
    db: &Db,
    name: &str,
    username: Option<&str>,
    site_admin: bool,
    grant: Option<&str>,
) -> sqlx::Result<bool> {
    let proof = Proof::grants(grant.map(str::to_string).into_iter().collect());
    let who = Who {
        username,
        site_admin,
    };
    ws_result(gate(db, name, who, &proof).await.map(|g| !g.banned))
}

/// When the guest grant `grant` on `server` ends because the extra password it came through
/// expires (None: no such expiry). Realtime subscriptions recheck at this time.
pub(crate) async fn ws_grant_deadline(
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
    db: &Db,
    username: &str,
    id: i64,
) -> Result<ResolvedChannel, String> {
    let user = crate::db::get_user(db, username)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Channel not found".to_string())?;
    match resolve_channel(db, id, Some(&user), &Proof::none()).await {
        Ok(channel) => Ok(channel),
        Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e)) => Err(e),
        Err(_) => Err("Channel not found".to_string()),
    }
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

    const HANDLERS: [(&str, &str); 19] = [
        ("servers.rs", include_str!("servers.rs")),
        ("passwords.rs", include_str!("passwords.rs")),
        ("messages.rs", include_str!("messages.rs")),
        ("media.rs", include_str!("media.rs")),
        ("embeds.rs", include_str!("embeds.rs")),
        ("users.rs", include_str!("users.rs")),
        ("dms.rs", include_str!("dms.rs")),
        ("admin.rs", include_str!("admin.rs")),
        ("auth.rs", include_str!("auth.rs")),
        ("mod.rs", include_str!("mod.rs")),
        ("ws.rs", include_str!("../ws.rs")),
        ("hub.rs", include_str!("../hub.rs")),
        ("fanout.rs", include_str!("../fanout.rs")),
        ("db.rs", include_str!("../db.rs")),
        ("pings.rs", include_str!("pings.rs")),
        ("reactions.rs", include_str!("reactions.rs")),
        ("pins.rs", include_str!("pins.rs")),
        ("system_messages.rs", include_str!("system_messages.rs")),
        ("timeouts.rs", include_str!("timeouts.rs")),
    ];

    fn calls(code: &str, token: &str) -> bool {
        code.match_indices(token).any(|(at, _)| {
            !code[..at]
                .chars()
                .next_back()
                .is_some_and(|c| c == '.' || c == '_' || c.is_alphanumeric())
        })
    }

    #[test]
    fn the_gate_lint_sees_free_calls_only() {
        assert!(calls("let b = is_banned(db, s, u)", "is_banned("));
        assert!(calls("crate::db::grant_live(db, g, s)", "grant_live("));
        assert!(!calls("access.has_perm(db, p)", "has_perm(db"));
        assert!(!calls("ws_banned(db, s, u)", "is_banned("));
        assert!(!calls(
            "ws_channel_viewable(db, s, c, u)",
            "channel_viewable("
        ));
    }

    #[test]
    fn handlers_only_reach_servers_through_the_gate() {
        let banned = [
            "effective_perms(",
            "member_perms(db",
            "has_perm(db",
            "channel_access(",
            "channel_viewable(",
            "manages_channels(db",
            "is_banned(",
            "grant_live(",
            "live_grant_servers(",
            "server_lite(",
            "require_server(",
            "require_server_view(",
            "message_scope(",
        ];
        for (file, source) in HANDLERS {
            let code = [
                "#[cfg(test)]\nmod tests",
                "#[cfg(test)]\npub(crate) mod tests",
            ]
            .iter()
            .fold(source, |code, marker| {
                code.split(marker).next().expect("code")
            });
            for token in banned {
                assert!(!calls(code, token), "{file} calls {token}");
            }
        }
    }

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
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
            sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, is_site_admin, created_at) VALUES($1, $1, 'x', 'text', 'identicon', $2, 0)")
                .bind(name)
                .bind(admin)
                .execute(db)
                .await
                .expect("user");
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
        let app = routes(state.clone(), &Roles::ALL, ClientIp(trusted)).with_state(state.clone());
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
                    (true, _, _) => *status == 200 && body.contains(r#""member":null"#),
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
        let code = |r: Result<ServerAccess, ApiError>| r.err().map(|ApiError(c, m)| (c, m));
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
            Err(ApiError(StatusCode::UNAUTHORIZED, _))
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
                let res = res.err().map(|ApiError(c, m)| (c, m));
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
        exec(db, &format!("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, is_site_admin, created_at) VALUES('{name}', '{name}', 'x', 'text', 'identicon', 0, 0)")).await;
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
                let err = res.err().map(|ApiError(c, m)| (c, m));
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
            .map(|ApiError(c, m)| (c, m));
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
    async fn password_admin_rules() {
        let (state, path) = temp_state("access_password_admin").await;
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
        let err = |m: &str| (400, format!(r#"{{"error":"{m}"}}"#));
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
                    Err(ApiError(status, body)) => (status.as_u16(), body),
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
                PASSWORD_FAILURES.note(&budget_key(db, name));
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
            PASSWORD_TRIES.take(&budget_key(db, &budget::group(v6).to_string()));
        }
        assert_eq!(attempt(ip("2001:db8::2"), "third", "wrong").await, denied);
        assert_eq!(
            attempt(ip("2001:db8::3"), "fourth", "wrong").await,
            refused,
            "the /64 shares one budget"
        );
        let network = budget_key(db, &budget::wide(ip("100.64.7.1")).to_string());
        for _ in 1..NETWORK_TRIES_MAX {
            NETWORK_TRIES.take(&network);
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
                    .map_err(|ApiError(status, _)| status.as_u16())
            })
        };
        let in_network = |n: u16| {
            std::net::IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 0x77, n, 0, 0, 0, 1))
        };
        let network = budget_key(db, &budget::wide(in_network(0)).to_string());
        for _ in 0..NETWORK_TRIES_MAX {
            NETWORK_TRIES.take(&network);
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
            PASSWORD_TRIES.take(&address);
        }
        let wide = budget_key(db, &budget::wide(spent).to_string());
        NETWORK_TRIES.take(&wide);
        assert_eq!(attempt(spent).await, Err(429));
        assert_eq!(
            NETWORK_TRIES.used(&wide),
            Some(1),
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
                    .map_err(|ApiError(status, _)| status.as_u16())
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
            "pinning needs Manage messages as a member"
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
        add_member(db, "rchat", "carl", 1, Perm::DeleteMessages as i64, 0).await;
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
