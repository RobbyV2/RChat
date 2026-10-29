use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use hyper::upgrade::OnUpgrade;
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioIo};

type ProxyClient = Client<HttpConnector, Body>;
use tower_governor::{GovernorLayer, governor::GovernorConfigBuilder};

use crate::config::AppConfig;
use crate::server::client_ip::ClientIp;
use crate::state::AppState;

fn limited(router: Router, key: ClientIp, config: &AppConfig) -> Router {
    let governor_conf = GovernorConfigBuilder::default()
        .per_millisecond((1000 / config.rate_limit_per_second.max(1)).max(1))
        .burst_size(config.rate_limit_burst)
        .key_extractor(key)
        .finish()
        .expect("invalid rate limit config");
    router.layer(GovernorLayer::new(governor_conf))
}

pub fn register_routes(proxy_url: Option<&str>, config: &AppConfig, state: AppState) -> Router {
    let key = ClientIp(config.proxy_trust.clone());
    let api_routes =
        crate::api::routes(state.clone(), &config.roles, key.clone()).with_state(state.clone());
    let api_routes = limited(api_routes, key.clone(), config);
    let well_known = match config.roles.api {
        true => limited(
            crate::api::instance::well_known_routes().with_state(state.clone()),
            key,
            config,
        ),
        false => Router::new(),
    };
    let router = Router::new()
        .nest(
            "/api",
            crate::api::health::routes()
                .with_state(state)
                .merge(api_routes),
        )
        .merge(well_known);

    match proxy_url {
        Some(url) => {
            let url: Arc<str> = Arc::from(url);
            let client: ProxyClient = Client::builder(TokioExecutor::new()).build_http();
            router.fallback(move |req| {
                let url = Arc::clone(&url);
                let client = client.clone();
                async move { proxy_to_frontend(url, client, req).await }
            })
        }
        None => router,
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
