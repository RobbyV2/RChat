use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::HeaderValue;
use axum::middleware::{FromFnLayer, Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use futures_util::future::BoxFuture;

use crate::api::ApiError;
use crate::limits::bucket::{Keyed, Policy};
use crate::server::client_ip::ClientIp;

/// Client addresses each HTTP bucket keeps; past it the address used longest ago makes room.
pub const ADDRESSES_MAX: usize = 100_000;

/// A token bucket per client address (an IPv6 /64 counts as one) in front of a group of routes.
#[derive(Clone)]
pub struct Limit {
    bucket: Arc<Keyed<IpAddr>>,
    key: ClientIp,
}

type Check = fn(State<Limit>, Request, Next) -> BoxFuture<'static, Response>;

/// The layer that refuses a request when its client's bucket is empty.
pub type Layer = FromFnLayer<Check, Limit, (State<Limit>, Request)>;

/// A bucket of `burst` requests at once, then `per_sec` more each second, per client address.
pub fn bucket(burst: u32, per_sec: u64) -> Arc<Keyed<IpAddr>> {
    let policy = Policy::Tokens {
        burst: f64::from(burst),
        per_sec: per_sec as f64,
    };
    Arc::new(Keyed::new(policy, ADDRESSES_MAX))
}

pub fn layer(bucket: Arc<Keyed<IpAddr>>, key: ClientIp) -> Layer {
    from_fn_with_state(Limit { bucket, key }, check as Check)
}

fn check(State(limit): State<Limit>, req: Request, next: Next) -> BoxFuture<'static, Response> {
    Box::pin(async move {
        let Some(ip) = limit.key.extract(&req) else {
            return ApiError::internal("no client address for the rate limiter").into_response();
        };
        match limit.bucket.try_take(&ip, 1.0, Instant::now()) {
            Ok(_) => next.run(req).await,
            Err(wait) => refused(wait),
        }
    })
}

/// The 429 past a bucket: the wait in whole seconds, rounded up and at least one, in the text,
/// in `Retry-After` and in `x-ratelimit-after`.
pub fn refused(wait: Duration) -> Response {
    let secs = wait.as_secs_f64().ceil().max(1.0) as u64;
    let error = ApiError::rate(format!("Too Many Requests! Wait for {secs}s"), Some(secs));
    let mut res = error.into_response();
    res.headers_mut()
        .insert("x-ratelimit-after", HeaderValue::from(secs));
    res
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::http::StatusCode;

    use crate::api::test_util::{done, temp_state};
    use crate::config::{AppConfig, Roles};
    use crate::limits::Limits;
    use crate::server::route_builder::register_routes;
    use crate::state::AppState;

    struct Served {
        base: String,
        server: tokio::task::JoinHandle<()>,
    }

    async fn serve(state: &AppState) -> Served {
        let config = AppConfig {
            roles: Roles {
                web: false,
                ..Roles::ALL
            },
            ..AppConfig::defaults()
        };
        let app = register_routes(None, None, &config, state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        Served { base, server }
    }

    struct Answer {
        status: StatusCode,
        retry_after: Option<String>,
        ratelimit_after: Option<String>,
        body: String,
    }

    async fn answer(res: reqwest::Response) -> Answer {
        let header = |name: &str| {
            res.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let (retry_after, ratelimit_after) = (header("retry-after"), header("x-ratelimit-after"));
        Answer {
            status: StatusCode::from_u16(res.status().as_u16()).expect("status"),
            retry_after,
            ratelimit_after,
            body: res.text().await.expect("body"),
        }
    }

    /// Requests from one client until the first refusal, at most `most`: how many passed, and
    /// the refusal.
    async fn until_refused(
        most: usize,
        send: impl Fn() -> reqwest::RequestBuilder,
    ) -> (usize, Option<Answer>) {
        for passed in 0..most {
            let res = answer(send().send().await.expect("send")).await;
            if res.status == StatusCode::TOO_MANY_REQUESTS {
                return (passed, Some(res));
            }
        }
        (most, None)
    }

    fn limited(state: AppState, burst: u32, per_second: u64) -> AppState {
        state.with_limits(Arc::new(Limits {
            rate_limit_burst: burst,
            rate_limit_per_second: per_second,
            ..Limits::default()
        }))
    }

    fn says_its_wait(refused: &Answer) {
        assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
        let secs = refused.retry_after.clone().expect("retry-after");
        assert!(secs.parse::<u64>().is_ok(), "{secs}");
        assert_eq!(refused.ratelimit_after.as_deref(), Some(secs.as_str()));
        assert!(
            refused
                .body
                .contains(&format!("Too Many Requests! Wait for {secs}s")),
            "{}",
            refused.body
        );
    }

    #[tokio::test]
    async fn each_bucket_refuses_past_its_burst_with_its_wait() {
        let (state, path) = temp_state("http_limit_answers").await;
        let state = limited(state, 2, 1);
        let served = serve(&state).await;
        let client = reqwest::Client::new();
        let instance = format!("{}/api/v1/instance", served.base);
        let (passed, refused) = until_refused(10, || client.get(&instance)).await;
        assert_eq!(passed, 2, "the general bucket holds its burst");
        says_its_wait(&refused.expect("the general bucket refuses past its burst"));
        served.server.abort();
        let state = limited(state, 1000, 1000);
        let served = serve(&state).await;
        let login = format!("{}/api/v1/auth/login", served.base);
        let (passed, refused) = until_refused(60, || client.post(&login).body("x")).await;
        assert_eq!(passed, 30, "the strict bucket holds 30");
        says_its_wait(&refused.expect("the strict bucket refuses past 30"));
        served.server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn refusals_say_how_long_to_wait_rounded_up_with_the_rate_reason() {
        let (state, path) = temp_state("http_limit_reason").await;
        let state = limited(state, 1, 1);
        let served = serve(&state).await;
        let client = reqwest::Client::new();
        let instance = format!("{}/api/v1/instance", served.base);
        let (passed, refused) = until_refused(5, || client.get(&instance)).await;
        assert_eq!(passed, 1);
        let refused = refused.expect("refused");
        says_its_wait(&refused);
        assert_eq!(
            refused.retry_after.as_deref(),
            Some("1"),
            "a wait under a second is rounded up, never to 0"
        );
        let body: serde_json::Value = serde_json::from_str(&refused.body).expect("JSON");
        assert_eq!(
            body,
            serde_json::json!({
                "error": "Too Many Requests! Wait for 1s",
                "reason": {"kind": "rate", "retry_after": 1}
            })
        );
        served.server.abort();
        done(state, path).await;
    }
}
