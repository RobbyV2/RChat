use std::convert::Infallible;
use std::net::IpAddr;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::time::Instant;

use axum::extract::Request;
use axum::http::HeaderValue;
use axum::response::{IntoResponse, Response};
use futures_util::future::{BoxFuture, Either, Ready, ready};
use tower_service::Service;

use crate::api::ApiError;
use crate::limits::bucket::{Keyed, Policy};
use crate::limits::shared::Shared;
use crate::server::client_ip::ClientIp;

/// Client addresses each HTTP bucket keeps; past it the address used longest ago makes room.
pub const ADDRESSES_MAX: usize = 100_000;

/// A token bucket per client address (an IPv6 /64 counts as one) in front of a group of routes.
#[derive(Clone)]
pub struct Limit {
    bucket: Arc<Keyed<IpAddr>>,
    key: ClientIp,
    shared: Option<(Shared, &'static str)>,
}

/// The layer that refuses a request when its client's bucket is empty.
#[derive(Clone)]
pub struct Layer {
    limit: Limit,
}

/// A service behind its layer.
#[derive(Clone)]
pub struct Limited<S> {
    inner: S,
    limit: Limit,
}

/// A bucket of `burst` requests at once, then `per_sec` more each second, per client address.
pub fn bucket(burst: u32, per_sec: u64) -> Arc<Keyed<IpAddr>> {
    let policy = Policy::Tokens {
        burst: f64::from(burst),
        per_sec: per_sec as f64,
    };
    Arc::new(Keyed::new(policy, ADDRESSES_MAX))
}

/// The bucket counts in this process.
pub fn layer(bucket: Arc<Keyed<IpAddr>>, key: ClientIp) -> Layer {
    let limit = Limit {
        bucket,
        key,
        shared: None,
    };
    Layer { limit }
}

/// The bucket counts in Redis as `name`, together with every copy on the same Redis and
/// prefix, when `shared` is given; in this process otherwise and while Redis does not answer.
pub fn shared_layer(
    bucket: Arc<Keyed<IpAddr>>,
    key: ClientIp,
    shared: Option<Shared>,
    name: &'static str,
) -> Layer {
    let limit = Limit {
        bucket,
        key,
        shared: shared.map(|shared| (shared, name)),
    };
    Layer { limit }
}

impl<S> tower_layer::Layer<S> for Layer {
    type Service = Limited<S>;

    fn layer(&self, inner: S) -> Limited<S> {
        Limited {
            inner,
            limit: self.limit.clone(),
        }
    }
}

type Answer = Result<Response, Infallible>;

impl<S> Service<Request> for Limited<S>
where
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response;
    type Error = Infallible;
    type Future = Either<Either<S::Future, Ready<Answer>>, BoxFuture<'static, Answer>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request) -> Self::Future {
        let now = |answer: Response| Either::Left(Either::Right(ready(Ok(answer))));
        let Some(ip) = self.limit.key.extract(&req) else {
            return now(
                ApiError::internal("no client address for the rate limiter").into_response()
            );
        };
        let Some((shared, name)) = self.limit.shared.clone() else {
            return match self.limit.bucket.try_take(&ip, 1.0, Instant::now()) {
                Ok(_) => Either::Left(Either::Left(self.inner.call(req))),
                Err(wait) => now(refused(wait)),
            };
        };
        let bucket = self.limit.bucket.clone();
        let ready_inner = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, ready_inner);
        Either::Right(Box::pin(async move {
            let key = format!("http:{name}:{ip}");
            let counted = shared.try_take(&key, bucket.policy(), 1.0).await;
            let answer =
                counted.unwrap_or_else(|| bucket.try_take(&ip, 1.0, Instant::now()).map(|_| ()));
            match answer {
                Ok(()) => inner.call(req).await,
                Err(wait) => Ok(refused(wait)),
            }
        }))
    }
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
    async fn strict_and_invite_buckets_are_configurable() {
        let (state, path) = temp_state("http_limit_settings").await;
        let state = state.with_limits(Arc::new(Limits {
            rate_limit_burst: 1000,
            rate_limit_per_second: 1000,
            rate_limit_strict_burst: 2,
            rate_limit_strict_per_second: 1,
            rate_limit_invite_burst: 3,
            rate_limit_invite_per_second: 1,
            ..Limits::default()
        }));
        let served = serve(&state).await;
        let client = reqwest::Client::new();
        let login = format!("{}/api/v1/auth/login", served.base);
        let (passed, refused) = until_refused(10, || client.post(&login).body("x")).await;
        assert_eq!(passed, 2, "the third login from one address is refused");
        says_its_wait(&refused.expect("refused"));
        let invite = format!("{}/api/v1/invites/nowhere", served.base);
        let (passed, refused) = until_refused(10, || client.get(&invite)).await;
        assert_eq!(passed, 3, "the invite bucket holds its own burst");
        says_its_wait(&refused.expect("refused"));
        served.server.abort();
        done(state, path).await;
    }

    /// The join route of `served`, `n` times from one client: how many passed.
    async fn joins(served: &Served, n: usize) -> usize {
        let client = reqwest::Client::new();
        let join = format!("{}/api/v1/servers/club/join", served.base);
        until_refused(n, || client.post(&join).body("{}")).await.0
    }

    fn invites(state: AppState, burst: u32) -> AppState {
        state.with_limits(Arc::new(Limits {
            rate_limit_burst: 1000,
            rate_limit_per_second: 1000,
            rate_limit_invite_burst: burst,
            rate_limit_invite_per_second: 1,
            ..Limits::default()
        }))
    }

    #[tokio::test]
    async fn without_redis_buckets_stay_local() {
        let (state, path) = temp_state("http_limit_local").await;
        let state = invites(state, 2);
        let (one, two) = (serve(&state).await, serve(&state).await);
        assert_eq!(joins(&one, 5).await, 2, "one copy holds its burst");
        assert_eq!(joins(&two, 5).await, 2, "another copy counts apart");
        one.server.abort();
        two.server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    #[ignore = "needs a Redis-protocol server at REDIS_URL"]
    async fn join_bucket_is_shared_across_copies() {
        let Some(url) = crate::config::test_env("REDIS_URL") else {
            return;
        };
        let (state, path) = temp_state("http_limit_shared").await;
        let state = invites(state, 3);
        let prefix = format!("rchat-test-{:08x}", rand::random::<u32>());
        let copy = |prefix: String| {
            let (url, state) = (url.clone(), state.clone());
            async move {
                let (hub, bus) = crate::bus::connect(
                    &url,
                    &prefix,
                    crate::bus::DEFAULT_HUB_MAXLEN,
                    Roles::ALL,
                    Arc::new(crate::crypt::frames::Frames::plain()),
                )
                .await
                .expect("redis");
                let copy = AppState::new(
                    state.db.clone(),
                    hub,
                    None,
                    Some(bus.clone()),
                    state.instance.clone(),
                )
                .with_limits(state.limits.clone());
                (serve(&copy).await, bus)
            }
        };
        let (one, one_bus) = copy(prefix.clone()).await;
        let (two, two_bus) = copy(prefix.clone()).await;
        let (apart, apart_bus) = copy(format!("{prefix}-apart")).await;
        assert_eq!(joins(&one, 2).await, 2);
        assert_eq!(joins(&two, 5).await, 1, "both copies spend one bucket");
        assert_eq!(joins(&one, 5).await, 0);
        assert_eq!(joins(&apart, 5).await, 3, "another prefix counts apart");
        for (served, bus) in [(one, one_bus), (two, two_bus), (apart, apart_bus)] {
            served.server.abort();
            bus.stop();
        }
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
