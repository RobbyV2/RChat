use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    extract::{OriginalUri, Request},
    http::{StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
};
use hyper::upgrade::OnUpgrade;
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioIo};

type ProxyClient = Client<HttpConnector, Body>;
use tower_governor::{GovernorLayer, governor::GovernorConfigBuilder};

use crate::config::AppConfig;
use crate::limits::Limits;
use crate::peerjs::Peers;
use crate::server::client_ip::ClientIp;
use crate::state::AppState;

fn limited(router: Router, key: ClientIp, limits: &Limits) -> Router {
    let governor_conf = GovernorConfigBuilder::default()
        .per_millisecond((1000 / limits.rate_limit_per_second.max(1)).max(1))
        .burst_size(limits.rate_limit_burst)
        .key_extractor(key)
        .finish()
        .expect("invalid rate limit config");
    router.layer(GovernorLayer::new(governor_conf))
}

/// The API versions this server serves, each under `/api/<version>`.
pub const VERSIONS: [&str; 1] = ["v1"];

/// The version `/api/...` without a version segment resolves to.
pub const LATEST: &str = "v1";

/// What answers the paths outside the API.
#[derive(Clone)]
pub enum Frontend {
    /// The Next server at this URL.
    Proxy(Arc<str>),
    /// This service. It never sees `/api` paths.
    Service(Router),
}

pub fn register_routes(
    frontend: Option<Frontend>,
    peers: Option<Peers>,
    config: &AppConfig,
    state: AppState,
) -> Router {
    let signaling = peers.map(|peers| {
        let key = ClientIp(config.proxy_trust.clone());
        limited(peers.routes(key.clone()), key, &state.limits)
    });
    let router = api_router(config, state);
    let router = match signaling {
        Some(signaling) => router.merge(signaling),
        None => router,
    };
    let router = match frontend {
        Some(Frontend::Proxy(url)) => {
            let client: ProxyClient = Client::builder(TokioExecutor::new()).build_http();
            router.fallback(move |OriginalUri(asked): OriginalUri, mut req: Request| {
                *req.uri_mut() = asked;
                let url = Arc::clone(&url);
                let client = client.clone();
                async move { proxy_to_frontend(url, client, req).await }
            })
        }
        Some(Frontend::Service(service)) => router.fallback_service(outside_api(service)),
        None => router,
    };
    resolve_versions(router)
}

/// `service` for the paths outside the API, as the client asked for them. API paths without a
/// route stay 404.
fn outside_api(service: Router) -> Router {
    Router::new()
        .fallback_service(service)
        .layer(axum::middleware::from_fn(
            |OriginalUri(asked): OriginalUri, mut req: Request, next: Next| async move {
                match api_rest(asked.path()) {
                    Some(_) => StatusCode::NOT_FOUND.into_response(),
                    None => {
                        *req.uri_mut() = asked;
                        next.run(req).await
                    }
                }
            },
        ))
}

/// What follows `/api` in `path`, when it is an API path.
fn api_rest(path: &str) -> Option<&str> {
    path.strip_prefix("/api")
        .filter(|rest| rest.is_empty() || rest.starts_with('/'))
}

pub(crate) fn api_router(config: &AppConfig, state: AppState) -> Router {
    let key = ClientIp(config.proxy_trust.clone());
    let api_routes = crate::api::routes(
        state.clone(),
        &config.roles,
        key.clone(),
        config.swagger_ui.as_deref(),
    )
    .with_state(state.clone());
    let api_routes = limited(api_routes, key.clone(), &state.limits);
    let well_known = match config.roles.api {
        true => limited(
            crate::api::instance::well_known_routes().with_state(state.clone()),
            key,
            &state.limits,
        ),
        false => Router::new(),
    };
    Router::new()
        .nest(
            "/api/v1",
            crate::api::health::routes()
                .with_state(state)
                .merge(api_routes),
        )
        .merge(well_known)
}

/// `router` behind the version rewrite, which runs before routing so every route, limiter and
/// role sees the resolved path.
pub(crate) fn resolve_versions(router: Router) -> Router {
    Router::new()
        .fallback_service(router)
        .layer(axum::middleware::map_request(|req: Request| async move {
            resolve_version(req)
        }))
}

fn resolve_version(mut req: Request) -> Request {
    let Some(path) = resolved(req.uri().path()) else {
        return req;
    };
    let path_query = match req.uri().query() {
        Some(query) => format!("{path}?{query}"),
        None => path,
    };
    let mut parts = req.uri().clone().into_parts();
    parts.path_and_query = path_query.parse().ok();
    if let Ok(uri) = Uri::from_parts(parts) {
        *req.uri_mut() = uri;
    }
    req
}

/// `path` under `/api/{LATEST}` when it is an `/api` path without a version.
fn resolved(path: &str) -> Option<String> {
    let rest = api_rest(path)?;
    let segment = rest.split('/').nth(1).unwrap_or("");
    match VERSIONS.contains(&segment) {
        true => None,
        false => Some(format!("/api/{LATEST}{rest}")),
    }
}

const DEV_HMR: [&str; 2] = ["/_next/hmr", "/_next/webpack-hmr"];
#[cfg(not(test))]
const UPGRADE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
#[cfg(test)]
const UPGRADE_WAIT: std::time::Duration = std::time::Duration::from_millis(200);
const DEV_ENDPOINTS: [&str; 9] = [
    "/__nextjs_attach-nodejs-inspector",
    "/__nextjs_devtools_config",
    "/__nextjs_disable_dev_indicator",
    "/__nextjs_launch-editor",
    "/__nextjs_original-stack-frame",
    "/__nextjs_original-stack-frames",
    "/__nextjs_restart_dev",
    "/__nextjs_server_status",
    "/__nextjs_source-map",
];

fn frontend_refusal(req: &Request) -> Option<Response> {
    let path = req.uri().path();
    let headers = req.headers();
    if headers.contains_key("next-action") {
        return Some(StatusCode::NOT_FOUND.into_response());
    }
    if headers.contains_key(hyper::header::UPGRADE) && !DEV_HMR.contains(&path) {
        return Some(StatusCode::NOT_FOUND.into_response());
    }
    match *req.method() {
        hyper::Method::GET | hyper::Method::HEAD => None,
        _ if DEV_ENDPOINTS.contains(&path) => None,
        _ => Some(
            (
                StatusCode::METHOD_NOT_ALLOWED,
                [(hyper::header::ALLOW, "GET, HEAD")],
            )
                .into_response(),
        ),
    }
}

async fn proxy_to_frontend(proxy_url: Arc<str>, client: ProxyClient, mut req: Request) -> Response {
    if let Some(refused) = frontend_refusal(&req) {
        return refused;
    }
    let path_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or(req.uri().path());

    let new_uri = format!("{proxy_url}{path_query}");
    match new_uri.parse() {
        Ok(uri) => *req.uri_mut() = uri,
        Err(e) => {
            tracing::error!("Failed to parse URI {new_uri}: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Invalid URI").into_response();
        }
    }

    if let Ok(proxy_uri) = proxy_url.parse::<hyper::Uri>()
        && let Some(host) = proxy_uri.host()
    {
        let host_val = match proxy_uri.port_u16() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        if let Ok(hv) = host_val.parse() {
            req.headers_mut().insert(hyper::header::HOST, hv);
        }
    }

    let client_upgrade = req.extensions_mut().remove::<OnUpgrade>();

    let sent = client.request(req);
    let answered = match client_upgrade {
        Some(_) => match tokio::time::timeout(UPGRADE_WAIT, sent).await {
            Ok(answered) => answered,
            Err(_) => return StatusCode::GATEWAY_TIMEOUT.into_response(),
        },
        None => sent.await,
    };

    match answered {
        Ok(mut response) => {
            if response.status() == StatusCode::SWITCHING_PROTOCOLS
                && let Some(client_upgrade) = client_upgrade
            {
                let backend_upgrade = hyper::upgrade::on(&mut response);
                tokio::spawn(async move {
                    match (client_upgrade.await, backend_upgrade.await) {
                        (Ok(client_io), Ok(backend_io)) => {
                            let mut client_io = TokioIo::new(client_io);
                            let mut backend_io = TokioIo::new(backend_io);
                            let _ = tokio::io::copy_bidirectional(&mut client_io, &mut backend_io)
                                .await;
                        }
                        (Err(e), _) | (_, Err(e)) => tracing::error!("Upgrade error: {e}"),
                    }
                });
            }
            response.into_response()
        }
        Err(e) => {
            tracing::error!("Proxy error: {e}");
            (StatusCode::BAD_GATEWAY, "Frontend server not available").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, path: &str, headers: &[(&str, &str)]) -> Request {
        let mut builder = Request::builder().method(method).uri(path);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        builder.body(Body::empty()).expect("request")
    }

    fn status(r: Request) -> Option<StatusCode> {
        frontend_refusal(&r).map(|res| res.status())
    }

    #[test]
    fn unversioned_api_paths_resolve_to_the_latest_version() {
        assert!(VERSIONS.contains(&LATEST));
        let latest = |rest: &str| Some(format!("/api/{LATEST}{rest}"));
        assert_eq!(resolved("/api/me"), latest("/me"));
        assert_eq!(resolved("/api"), latest(""));
        assert_eq!(resolved("/api/"), latest("/"));
        assert_eq!(resolved("/api/ws"), latest("/ws"));
        assert_eq!(
            resolved("/api/servers/v1/members"),
            latest("/servers/v1/members")
        );
        assert_eq!(resolved("/api/v1x/me"), latest("/v1x/me"));
        for version in VERSIONS {
            for kept in [
                format!("/api/{version}"),
                format!("/api/{version}/"),
                format!("/api/{version}/me"),
            ] {
                assert_eq!(resolved(&kept), None, "{kept}");
            }
        }
        for kept in ["/apis/me", "/", "/login", "/.well-known/rchat", "/s/api/me"] {
            assert_eq!(resolved(kept), None, "{kept}");
        }
        let resolve = |uri: &str| {
            resolve_version(
                Request::builder()
                    .uri(uri)
                    .body(Body::empty())
                    .expect("req"),
            )
            .uri()
            .to_string()
        };
        assert_eq!(
            resolve("/api/search?q=a%20b&x=1"),
            format!("/api/{LATEST}/search?q=a%20b&x=1")
        );
        assert_eq!(resolve("/api/v1/me?x=1"), "/api/v1/me?x=1");
        assert_eq!(resolve("/login?next=/api/me"), "/login?next=/api/me");
    }

    #[test]
    fn the_frontend_proxy_only_forwards_page_traffic() {
        assert_eq!(status(req("GET", "/", &[])), None);
        assert_eq!(status(req("HEAD", "/s/rchat/", &[("rsc", "1")])), None);
        for hmr in DEV_HMR {
            assert_eq!(status(req("GET", hmr, &[("upgrade", "websocket")])), None);
        }
        assert_eq!(
            status(req("POST", "/__nextjs_original-stack-frames", &[])),
            None
        );
        for probe in [
            req("POST", "/", &[("next-action", "x")]),
            req(
                "GET",
                "/",
                &[("next-action", "71039463937fee66205500a659a835c340716e9a")],
            ),
            req("GET", "/", &[("upgrade", "websocket")]),
            req("GET", "/x", &[("upgrade", "h2c")]),
        ] {
            assert_eq!(status(probe), Some(StatusCode::NOT_FOUND));
        }
        for sneaky in [
            "/__nextjs_x/../",
            "/__nextjs_source-map/../../",
            "/__nextjs_source%2Dmap",
            "/__nextjs_",
        ] {
            assert_eq!(
                status(req("POST", sneaky, &[])),
                Some(StatusCode::METHOD_NOT_ALLOWED)
            );
        }
        for method in ["POST", "PUT", "DELETE", "PATCH"] {
            assert_eq!(
                status(req(method, "/login", &[])),
                Some(StatusCode::METHOD_NOT_ALLOWED)
            );
        }
    }

    /// A frontend that answers every request with its request target.
    async fn echo_frontend() -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        let held = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0; 4096];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let target = head.split(' ').nth(1).unwrap_or("").to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{target}",
                    target.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        (url, held)
    }

    #[tokio::test]
    async fn the_frontend_sees_the_path_the_client_asked_for() {
        let (url, frontend) = echo_frontend().await;
        let (state, path) = crate::api::test_util::temp_state("frontend_path").await;
        let config = AppConfig {
            roles: crate::config::Roles {
                web: false,
                ..crate::config::Roles::ALL
            },
            ..AppConfig::defaults()
        };
        let app = register_routes(
            Some(Frontend::Proxy(Arc::from(url))),
            None,
            &config,
            state.clone(),
        );
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
        for target in ["/login?x=1", "/api/nope?x=1", "/api/v1/nope", "/api"] {
            let body = reqwest::get(format!("{base}{target}"))
                .await
                .expect("get")
                .text()
                .await
                .expect("body");
            assert_eq!(body, target);
        }
        server.abort();
        frontend.abort();
        crate::api::test_util::done(state, path).await;
    }

    async fn silent_frontend() -> (Arc<str>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let url: Arc<str> = Arc::from(format!("http://{}", listener.local_addr().expect("addr")));
        let held = tokio::spawn(async move {
            let mut open = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                open.push(socket);
            }
        });
        (url, held)
    }

    #[tokio::test]
    async fn a_stray_upgrade_does_not_hold_the_proxy_open() {
        let (url, held) = silent_frontend().await;
        let client: ProxyClient = Client::builder(TokioExecutor::new()).build_http();
        let mut upgrade = req(
            "GET",
            DEV_HMR[0],
            &[("upgrade", "websocket"), ("connection", "upgrade")],
        );
        let on = hyper::upgrade::on(&mut upgrade);
        upgrade.extensions_mut().insert(on);
        let res = tokio::time::timeout(
            UPGRADE_WAIT * 5,
            proxy_to_frontend(Arc::clone(&url), client.clone(), upgrade),
        )
        .await
        .expect("answered before the client gave up");
        assert_eq!(res.status(), StatusCode::GATEWAY_TIMEOUT);
        let page = proxy_to_frontend(url, client, req("GET", "/", &[]));
        assert!(
            tokio::time::timeout(UPGRADE_WAIT * 2, page).await.is_err(),
            "ordinary pages keep waiting for a slow frontend"
        );
        held.abort();
    }
}
