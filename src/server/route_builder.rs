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

async fn proxy_to_frontend(proxy_url: Arc<str>, client: ProxyClient, mut req: Request) -> Response {
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

    match client.request(req).await {
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
