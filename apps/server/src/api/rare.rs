use std::sync::LazyLock;
use std::time::Duration;
use tokio::time::Instant;

use axum::http::StatusCode;

use crate::api::ApiError;
use crate::api::lookup;
use crate::db::User;
use crate::limits::Limits;
use crate::limits::bucket::{Keyed, Policy};
use crate::state::AppState;

/// A kind of request a person makes a few times a day at most. Each kind has its own count per
/// account, or per client address for a caller without one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rare {
    /// A new display name: the check whether it passes for another account's username.
    DisplayName,
    /// A new account.
    SignUp,
    /// A password change.
    Password,
    /// Setting or removing the backup phrase.
    Phrase,
    /// A recovery challenge, or a sign-in with the backup phrase.
    Recovery,
    /// A check whether a server name is free, or a server renamed.
    ServerName,
    /// A new server.
    NewServer,
    /// A deleted server.
    DeletedServer,
    /// A new server password: the permanent one or an extra one.
    ServerPassword,
    /// A new webhook, a new token or secret for one, or a test event.
    Webhook,
    /// A new config link.
    ConfigLink,
    /// An uploaded P2P backup version.
    P2pBackup,
    /// A stored P2P identity record.
    P2pIdentity,
    /// A P2P identity binding.
    P2pBinding,
}

impl Rare {
    pub const ALL: [Rare; 14] = [
        Rare::DisplayName,
        Rare::SignUp,
        Rare::Password,
        Rare::Phrase,
        Rare::Recovery,
        Rare::ServerName,
        Rare::NewServer,
        Rare::DeletedServer,
        Rare::ServerPassword,
        Rare::Webhook,
        Rare::ConfigLink,
        Rare::P2pBackup,
        Rare::P2pIdentity,
        Rare::P2pBinding,
    ];

    /// Its name in the counts.
    pub fn name(self) -> &'static str {
        match self {
            Rare::DisplayName => "display_name",
            Rare::SignUp => "sign_up",
            Rare::Password => "password",
            Rare::Phrase => "phrase",
            Rare::Recovery => "recovery",
            Rare::ServerName => "server_name",
            Rare::NewServer => "new_server",
            Rare::DeletedServer => "deleted_server",
            Rare::ServerPassword => "server_password",
            Rare::Webhook => "webhook",
            Rare::ConfigLink => "config_link",
            Rare::P2pBackup => "p2p_backup",
            Rare::P2pIdentity => "p2p_identity",
            Rare::P2pBinding => "p2p_binding",
        }
    }

    /// The operations that count as this kind, by method and path in the API document.
    pub fn routes(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Rare::DisplayName => &[
                ("patch", "/api/v1/me"),
                ("patch", "/api/v1/servers/{name}/profile"),
            ],
            Rare::SignUp => &[("post", "/api/v1/auth/register")],
            Rare::Password => &[("post", "/api/v1/me/password")],
            Rare::Phrase => &[
                ("put", "/api/v1/me/recovery"),
                ("delete", "/api/v1/me/recovery"),
            ],
            Rare::Recovery => &[
                ("post", "/api/v1/auth/recovery/challenge"),
                ("post", "/api/v1/auth/recovery"),
            ],
            Rare::ServerName => &[
                ("get", "/api/v1/servers/{name}/available"),
                ("patch", "/api/v1/servers/{name}"),
            ],
            Rare::NewServer => &[("post", "/api/v1/servers")],
            Rare::DeletedServer => &[("delete", "/api/v1/servers/{name}")],
            Rare::ServerPassword => &[
                ("post", "/api/v1/servers/{name}/passwords"),
                ("patch", "/api/v1/servers/{name}"),
                ("post", "/api/v1/servers/{name}/invite"),
            ],
            Rare::Webhook => &[
                ("post", "/api/v1/servers/{name}/webhooks"),
                ("post", "/api/v1/servers/{name}/webhooks/{id}/token"),
                ("post", "/api/v1/servers/{name}/outgoing_webhooks"),
                (
                    "post",
                    "/api/v1/servers/{name}/outgoing_webhooks/{id}/secret",
                ),
                ("post", "/api/v1/servers/{name}/outgoing_webhooks/{id}/test"),
            ],
            Rare::ConfigLink => &[("post", "/api/v1/config_shares")],
            Rare::P2pBackup => &[("put", "/api/v1/me/p2p_backup/{ik}")],
            Rare::P2pIdentity => &[("put", "/api/v1/me/p2p_identity/{ik}")],
            Rare::P2pBinding => &[("post", "/api/v1/identity/p2p_binding")],
        }
    }
}

/// The answer past a limit of the rare requests.
pub const TOO_OFTEN: &str = "You've done this too often. Try again later.";
const PER_HOUR: &str = "RARE_REQUESTS_PER_HOUR";
const PER_DAY: &str = "RARE_REQUESTS_PER_DAY";
const HOUR: Duration = Duration::from_secs(3600);
const DAY: Duration = Duration::from_secs(86_400);

/// Rare requests per caller and kind in an hour, under `RARE_REQUESTS_PER_HOUR`.
static HOURS: LazyLock<Keyed> =
    LazyLock::new(|| Keyed::new(per(HOUR, Limits::default().rare_requests_per_hour), 200_000));
/// Rare requests per caller and kind in a day, under `RARE_REQUESTS_PER_DAY`.
static DAYS: LazyLock<Keyed> =
    LazyLock::new(|| Keyed::new(per(DAY, Limits::default().rare_requests_per_day), 200_000));

fn per(window: Duration, limit: u32) -> Policy {
    Policy::Window { limit, window }
}

/// One rare request, counted while its handler runs. Dropped before `answered`, or answered
/// with a refusal by another limit or for capacity, it is given back.
#[must_use]
pub struct Held {
    key: String,
    hour: Option<Instant>,
    day: Option<Instant>,
}

impl Held {
    /// Keeps the request counted, unless `error` is a refusal by another limit or for capacity
    /// (423, 429, 503).
    pub fn answered(mut self, error: Option<&ApiError>) {
        if !matches!(
            error,
            Some(ApiError(
                StatusCode::LOCKED
                    | StatusCode::TOO_MANY_REQUESTS
                    | StatusCode::SERVICE_UNAVAILABLE,
                _,
                _
            ))
        ) {
            self.hour = None;
            self.day = None;
        }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(start) = self.hour.take() {
            HOURS.refund(&self.key, 1.0, start);
        }
        if let Some(start) = self.day.take() {
            DAYS.refund(&self.key, 1.0, start);
        }
    }
}

fn key(state: &AppState, kind: Rare, caller: Option<&User>) -> String {
    format!("{}\n{}", lookup::who(state, caller), kind.name())
}

/// Holds one request of `kind` against the caller's account, or against the client address
/// for a caller without one, whatever names the request carries. Past `RARE_REQUESTS_PER_DAY`
/// in a day or `RARE_REQUESTS_PER_HOUR` in an hour (0: no limit) it is refused. Requests in
/// flight hold their count, so together they can't go past the limits.
pub fn hold(state: &AppState, kind: Rare, caller: Option<&User>) -> Result<Held, ApiError> {
    let now = clock(state);
    let (per_hour, per_day) = (
        state.limits.rare_requests_per_hour,
        state.limits.rare_requests_per_day,
    );
    let mut held = Held {
        key: key(state, kind, caller),
        hour: None,
        day: None,
    };
    if per_day > 0 {
        match DAYS.under(per(DAY, per_day)).try_take(&held.key, 1.0, now) {
            Ok(start) => held.day = Some(start),
            Err(wait) => return Err(lookup::limited(PER_DAY, TOO_OFTEN, wait)),
        }
    }
    if per_hour > 0 {
        match HOURS
            .under(per(HOUR, per_hour))
            .try_take(&held.key, 1.0, now)
        {
            Ok(start) => held.hour = Some(start),
            Err(wait) => return Err(lookup::limited(PER_HOUR, TOO_OFTEN, wait)),
        }
    }
    Ok(held)
}

/// Counts one request of `kind`, like `hold`. Handlers take it before they check or read
/// anything that depends on a name in the request.
pub fn take(state: &AppState, kind: Rare, caller: Option<&User>) -> Result<(), ApiError> {
    hold(state, kind, caller).map(|held| held.answered(None))
}

/// Keeps the request `held` for `answer`, as `Held::answered` says.
pub fn counted<T>(held: Held, answer: Result<T, ApiError>) -> Result<T, ApiError> {
    held.answered(answer.as_ref().err());
    answer
}

/// Refuses a caller past a limit of `kind` like `take`, without counting a request. A request
/// that confirms with the password or the backup phrase runs it first and takes its count
/// once that passes, so wrong tries, paced per session, never use up the account's requests.
pub fn check(state: &AppState, kind: Rare, caller: Option<&User>) -> Result<(), ApiError> {
    let (key, now) = (key(state, kind, caller), clock(state));
    let (per_hour, per_day) = (
        state.limits.rare_requests_per_hour,
        state.limits.rare_requests_per_day,
    );
    for (limit, budget, policy) in [
        (PER_DAY, &DAYS, per(DAY, per_day)),
        (PER_HOUR, &HOURS, per(HOUR, per_hour)),
    ] {
        let wait = budget.under(policy).wait(&key, 1.0, now);
        if policy.full() > 0.0 && !wait.is_zero() {
            return Err(lookup::limited(limit, TOO_OFTEN, wait));
        }
    }
    Ok(())
}

#[cfg(not(test))]
fn clock(_: &AppState) -> Instant {
    Instant::now()
}

#[cfg(test)]
fn clock(state: &AppState) -> Instant {
    tests::clock(state)
}

#[cfg(test)]
pub(crate) mod tests;
