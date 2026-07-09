use std::net::SocketAddr;

use axum::http::{HeaderName, Method, header};
use clap::Parser;
use rust_next::config::{AppConfig, AppMode, CliOverrides};
use rust_next::server::build_router;
use rust_next::state::AppState;
use rust_next::ws::Hub;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::from_filename(".env.local");
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = CliOverrides::parse();
    let config = AppConfig::load(&cli)?;

    let db = rust_next::db::open(config.database_url.as_deref()).await?;
    let state = AppState {
        db,
        hub: Hub::new(),
        s3: config.s3()?,
    };
    let sweeper = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            rust_next::api::media::sweep_expired(&sweeper).await;
        }
    });
    let voice = state.clone();
    let idle: i64 = std::env::var("VOICE_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            rust_next::ws::sweep_and_log(&voice, idle).await;
        }
    });

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            header::UPGRADE,
            header::CONNECTION,
            HeaderName::from_static("sec-websocket-key"),
            HeaderName::from_static("sec-websocket-version"),
            HeaderName::from_static("sec-websocket-protocol"),
        ])
        .allow_credentials(true);

    let proxy_url = config.proxy_url();
    let app = build_router(proxy_url.as_deref(), &config, state).layer(cors);

    let addr = config.addr();
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    let mode_label = match config.app_mode {
        AppMode::Full => "full (proxy to frontend)",
        AppMode::ApiOnly => "api-only",
    };

    info!("Starting rust-next server [mode: {mode_label}]");
    info!("Listening on http://{addr}");

    if let Some(ref url) = proxy_url {
        info!("Proxying frontend requests to {url}");
    }

    info!(
        "Rate limiting: {} req/s, burst {}",
        config.rate_limit_per_second, config.rate_limit_burst
    );

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    info!("Server shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => info!("Received Ctrl+C, shutting down..."),
        _ = terminate => info!("Received SIGTERM, shutting down..."),
    }
}
