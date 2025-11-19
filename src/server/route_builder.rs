use axum::{
    Router,
    extract::{DefaultBodyLimit, Request},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use std::sync::Arc;

use crate::api::AppState;
use crate::database;
use crate::utils::jwt::JwtService;

async fn proxy_to_nextjs(mut req: Request) -> Response {
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    let proxy_url =
        std::env::var("SERVER_PROXY_URL").unwrap_or_else(|_| format!("http://127.0.0.1:{}", port));

    let proxy_uri = match proxy_url.parse::<hyper::Uri>() {
        Ok(uri) => uri,
        Err(e) => {
            tracing::error!("Invalid proxy URL {}: {}", proxy_url, e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Invalid proxy configuration",
            )
                .into_response();
        }
    };

    let path = req.uri().path();
    let path_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or(path);

    let new_uri = format!("{}{}", proxy_url, path_query);
    match new_uri.parse() {
        Ok(uri) => *req.uri_mut() = uri,
        Err(e) => {
            tracing::error!("Failed to parse URI {}: {}", new_uri, e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Invalid URI").into_response();
        }
    }

    if let Some(host) = proxy_uri.host() {
        let host_value = if let Some(port) = proxy_uri.port_u16() {
            format!("{}:{}", host, port)
        } else {
            host.to_string()
        };
        if let Ok(header_value) = host_value.parse() {
            req.headers_mut().insert(hyper::header::HOST, header_value);
        }
    }

    let client = Client::builder(TokioExecutor::new()).build_http();

    match client.request(req).await {
        Ok(response) => response.into_response(),
        Err(e) => {
            tracing::error!("Proxy error: {}", e);
            (StatusCode::BAD_GATEWAY, "Server not available").into_response()
        }
    }
}

pub async fn register_routes() -> Router {
    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://rchat.db?mode=rwc".to_string());

    let db = database::create_pool(&database_url)
        .await
        .expect("Failed to create database pool");

    tracing::info!("Database connected and migrations applied");

    let jwt_service = Arc::new(JwtService::from_env().expect("Failed to initialize JWT service"));
    let ws_manager = Arc::new(crate::websocket::connection::ConnectionManager::new());

    let (server_name, channel_id) = crate::services::default_server::ensure_default_server(&db)
        .await
        .expect("Failed to create default server");

    tracing::info!(
        "Default server initialized: {}, channel: {}",
        server_name,
        channel_id
    );

    crate::tasks::cleanup::start_cleanup_task(db.clone());
    tracing::info!("File cleanup task started");

    crate::services::server::sync_server_counts(&db)
        .await
        .expect("Failed to sync server counts");

    let state = Arc::new(AppState {
        db,
        jwt_service,
        ws_manager,
    });

    let api_routes = crate::api::routes(state);

    Router::new()
        .nest("/api", api_routes)
        .layer(DefaultBodyLimit::max(40 * 1024 * 1024))
        .fallback(proxy_to_nextjs)
}
