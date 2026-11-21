use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;

use crate::api::ApiError;
use crate::limits::bucket::Policy;
use crate::limits::shared::Rate;
use crate::state::AppState;

/// What one network may only do so many times a day.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A new account (`SIGNUPS_PER_NETWORK_PER_DAY`).
    SignUp,
    /// A new server (`SERVERS_PER_NETWORK_PER_DAY`).
    Server,
}

const DAY: Duration = Duration::from_secs(86_400);

static SIGNUPS: LazyLock<Rate> = LazyLock::new(|| Rate::new("signups_per_network", 200_000));
static SERVERS: LazyLock<Rate> = LazyLock::new(|| Rate::new("servers_per_network", 200_000));

/// The network a sign-up or a new server counts against: the IPv4 address, or the IPv6 /48.
pub fn network(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) => IpAddr::V6((u128::from(v6) & !((1u128 << 80) - 1)).into()),
        v4 => v4,
    }
}

/// Counts one `kind` for the client's network, across copies when the instance has Redis.
/// Refused with 429 and `Retry-After` past the day's limit; nothing is counted without a limit
/// or a client address.
pub async fn take(state: &AppState, kind: Kind) -> Result<(), ApiError> {
    let (most, rate, text) = match kind {
        Kind::SignUp => (
            state.limits.signups_per_network_per_day,
            &*SIGNUPS,
            "Too many new accounts from your network. Try again later.",
        ),
        Kind::Server => (
            state.limits.servers_per_network_per_day,
            &*SERVERS,
            "Too many new servers from your network. Try again later.",
        ),
    };
    let Some(ip) = crate::api::budget::client() else {
        return Ok(());
    };
    if most == 0 {
        return Ok(());
    }
    let policy = Policy::Window {
        limit: most,
        window: DAY,
    };
    rate.take(state, &network(ip).to_string(), policy, 1.0)
        .await
        .map_err(|wait| {
            let secs = wait.as_secs_f64().ceil().max(1.0) as u64;
            ApiError::rate(text, Some(secs))
        })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::api::test_util::{done, temp_state};
    use crate::limits::Limits;

    #[test]
    fn a_network_is_an_ipv4_address_or_an_ipv6_48() {
        let ip = |s: &str| -> IpAddr { s.parse().expect("ip") };
        assert_eq!(network(ip("203.0.113.7")), ip("203.0.113.7"));
        assert_eq!(network(ip("::ffff:203.0.113.7")), ip("203.0.113.7"));
        assert_eq!(network(ip("2001:db8:1:2:3::9")), ip("2001:db8:1::"));
        assert_eq!(
            network(ip("2001:db8:1:ffff::1")),
            network(ip("2001:db8:1:2::1"))
        );
        assert_ne!(network(ip("2001:db8:2::1")), network(ip("2001:db8:1::1")));
    }

    #[tokio::test]
    async fn network_caps_count_each_kind_per_network() {
        let (state, path) = temp_state("network_caps").await;
        let state = state.with_limits(Arc::new(Limits {
            signups_per_network_per_day: 2,
            servers_per_network_per_day: 1,
            ..Limits::default()
        }));
        let at = |s: &'static str| s.parse::<IpAddr>().expect("ip");
        let sign_up = |ip: IpAddr| {
            let state = state.clone();
            crate::api::budget::as_client(ip, async move { take(&state, Kind::SignUp).await })
        };
        assert!(sign_up(at("2001:db8:7::1")).await.is_ok());
        assert!(sign_up(at("2001:db8:7:ffff::2")).await.is_ok());
        let ApiError(code, msg, reason) = sign_up(at("2001:db8:7:1::3")).await.unwrap_err();
        assert_eq!(code, axum::http::StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            msg,
            "Too many new accounts from your network. Try again later."
        );
        let reason = reason.expect("reason");
        assert_eq!(reason.kind, crate::api::ReasonKind::Rate);
        assert!(reason.retry_after.is_some_and(|s| s > 86_000), "{reason:?}");
        assert!(sign_up(at("2001:db8:8::1")).await.is_ok(), "another /48");
        assert!(sign_up(at("198.51.100.1")).await.is_ok());
        assert!(
            sign_up(at("198.51.100.2")).await.is_ok(),
            "IPv4 counts per address"
        );
        let server = |ip: IpAddr| {
            let state = state.clone();
            crate::api::budget::as_client(ip, async move { take(&state, Kind::Server).await })
        };
        assert!(
            server(at("2001:db8:7::1")).await.is_ok(),
            "kinds count apart"
        );
        assert!(server(at("2001:db8:7::9")).await.is_err());
        let off = state.clone().with_limits(Arc::new(Limits::default()));
        for _ in 0..5 {
            let state = off.clone();
            let ip = at("2001:db8:7::1");
            assert!(
                crate::api::budget::as_client(ip, async move { take(&state, Kind::SignUp).await })
                    .await
                    .is_ok(),
                "0 is no cap"
            );
        }
        done(state, path).await;
    }
}
