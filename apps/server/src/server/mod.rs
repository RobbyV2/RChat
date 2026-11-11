use std::time::Duration;

use axum::Router;
use axum::http::{HeaderName, Method};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::api::{CORS_REQUEST_HEADERS, CORS_RESPONSE_HEADERS};
use crate::config::AppConfig;
use crate::peerjs::Peers;
use crate::state::AppState;

pub mod client_ip;
pub mod route_builder;

const CORS_MAX_AGE: Duration = Duration::from_secs(600);

pub use route_builder::Frontend;

pub fn build_router(
    frontend: Option<Frontend>,
    peers: Option<Peers>,
    config: &AppConfig,
    state: AppState,
) -> Router {
    route_builder::register_routes(frontend, peers, config, state)
}

pub fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
            Method::OPTIONS,
        ])
        .allow_headers(CORS_REQUEST_HEADERS.map(HeaderName::from_static))
        .expose_headers(CORS_RESPONSE_HEADERS.map(HeaderName::from_static))
        .max_age(CORS_MAX_AGE)
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use axum::http::StatusCode;

    use super::*;
    use crate::api::test_util::{done, temp_state};
    use crate::config::Roles;
    use crate::server::client_ip::{ClientIp, ProxyTrust};

    const APP: &str = "https://ui.example.org";

    async fn serve(state: AppState) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app = crate::api::routes(state.clone(), &Roles::ALL, ClientIp(trusted), None)
            .with_state(state)
            .layer(cors_layer());
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
        (addr, server)
    }

    fn header<'a>(res: &'a reqwest::Response, name: &str) -> Option<&'a str> {
        res.headers().get(name).and_then(|v| v.to_str().ok())
    }

    fn listed(res: &reqwest::Response, name: &str) -> Vec<String> {
        header(res, name)
            .unwrap_or_default()
            .split(',')
            .map(|h| h.trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect()
    }

    #[tokio::test]
    async fn another_app_may_call_the_api_with_a_token_and_no_cookies() {
        let (state, path) = temp_state("cors_preflight").await;
        let (addr, server) = serve(state.clone()).await;
        let res = reqwest::Client::new()
            .request(Method::OPTIONS, format!("http://{addr}/me"))
            .header("Origin", APP)
            .header("Access-Control-Request-Method", "GET")
            .header(
                "Access-Control-Request-Headers",
                "authorization, content-type, x-guest-grant, x-trust-token, x-trust-client",
            )
            .send()
            .await
            .expect("preflight");
        server.abort();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(header(&res, "access-control-allow-origin"), Some(APP));
        assert_eq!(header(&res, "access-control-allow-credentials"), None);
        assert_eq!(header(&res, "access-control-max-age"), Some("600"));
        let allowed = listed(&res, "access-control-allow-headers");
        for asked in [
            "authorization",
            "content-type",
            "x-guest-grant",
            "x-trust-token",
            "x-trust-client",
        ] {
            assert!(allowed.contains(&asked.to_string()), "{allowed:?}");
        }
        assert_eq!(allowed.len(), CORS_REQUEST_HEADERS.len(), "{allowed:?}");
        let methods = listed(&res, "access-control-allow-methods");
        for method in ["get", "post", "put", "delete", "patch"] {
            assert!(methods.contains(&method.to_string()), "{methods:?}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn another_app_can_read_how_long_to_wait_after_a_429() {
        let (state, path) = temp_state("cors_retry").await;
        let (addr, server) = serve(state.clone()).await;
        let client = reqwest::Client::new();
        let mut limited = None;
        for _ in 0..40 {
            let res = client
                .post(format!("http://{addr}/servers/rchat/join"))
                .header("Origin", APP)
                .header("X-Forwarded-For", "203.0.113.7")
                .send()
                .await
                .expect("request");
            if res.status() == StatusCode::TOO_MANY_REQUESTS {
                limited = Some(res);
                break;
            }
        }
        server.abort();
        let res = limited.expect("a 429");
        assert!(header(&res, "retry-after").is_some());
        assert_eq!(header(&res, "access-control-allow-origin"), Some(APP));
        assert_eq!(header(&res, "access-control-allow-credentials"), None);
        assert!(header(&res, "date").is_some());
        let exposed = listed(&res, "access-control-expose-headers");
        assert_eq!(
            exposed,
            [
                "x-next-cursor",
                "retry-after",
                "x-trust-required",
                "x-trust-remaining",
                "x-trust-renew",
                "date"
            ],
            "{exposed:?}"
        );
        assert_eq!(exposed, crate::api::CORS_RESPONSE_HEADERS);
        done(state, path).await;
    }

    #[tokio::test]
    async fn requests_from_the_instance_itself_are_unchanged() {
        let (state, path) = temp_state("cors_same_origin").await;
        let (addr, server) = serve(state.clone()).await;
        let client = reqwest::Client::new();
        let plain = client
            .get(format!("http://{addr}/settings"))
            .send()
            .await
            .expect("request");
        let own = format!("http://{addr}");
        let named = client
            .get(format!("http://{addr}/settings"))
            .header("Origin", &own)
            .send()
            .await
            .expect("request");
        let anonymous = client
            .get(format!("http://{addr}/me"))
            .send()
            .await
            .expect("request");
        server.abort();
        assert_eq!(plain.status(), StatusCode::OK);
        assert_eq!(header(&plain, "access-control-allow-origin"), None);
        assert_eq!(header(&plain, "access-control-allow-credentials"), None);
        assert_eq!(named.status(), StatusCode::OK);
        assert_eq!(
            header(&named, "access-control-allow-origin"),
            Some(own.as_str())
        );
        assert_eq!(header(&named, "access-control-allow-credentials"), None);
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        let plain: serde_json::Value =
            serde_json::from_str(&plain.text().await.expect("body")).expect("json");
        let named: serde_json::Value =
            serde_json::from_str(&named.text().await.expect("body")).expect("json");
        assert_eq!(plain, named);
        assert!(plain.get("registration").is_some(), "{plain}");
        done(state, path).await;
    }
}
