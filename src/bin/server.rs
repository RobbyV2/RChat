use std::net::SocketAddr;

use axum::http::{HeaderName, Method, header};
use clap::Parser;
use rust_next::config::{AppConfig, CliOverrides, Roles};
use rust_next::server::build_router;
use rust_next::server::client_ip::ProxyTrust;
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

    let roles = config.roles;
    let db = rust_next::db::open(config.database_url.as_deref()).await?;
    let web_only = roles
        == Roles {
            web: true,
            ..Roles::NONE
        };
    let (hub, bus) = match config.redis_url.as_deref().map(str::trim) {
        Some(url) if !web_only => {
            let (hub, bus) =
                rust_next::bus::connect(url, &config.redis_prefix, config.redis_hub_maxlen, roles)
                    .await?;
            info!("Realtime bus: redis (prefix {})", config.redis_prefix);
            (hub, Some(bus))
        }
        Some(_) | None => (Hub::new(), None),
    };
    let state = AppState::new(db, hub, config.s3()?, bus);
    rust_next::ws::spawn_aftermath(&state);
    if let Some(bus) = &state.bus {
        bus.spawn_workers(&state);
    }
    let touches = state.db.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(e) = rust_next::db::flush_grant_touches(&touches).await {
                tracing::warn!("guest grant refresh failed: {e}");
            }
        }
    });
    if roles.jobs {
        let sweeper = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                let mine = match &sweeper.bus {
                    Some(bus) => {
                        bus.try_lock("media-sweep", std::time::Duration::from_secs(55))
                            .await
                    }
                    None => true,
                };
                if mine {
                    rust_next::api::media::sweep_expired(&sweeper).await;
                }
            }
        });
        let stale = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(600));
            loop {
                interval.tick().await;
                let mine = match &stale.bus {
                    Some(bus) => {
                        bus.try_lock("db-sweep", std::time::Duration::from_secs(590))
                            .await
                    }
                    None => true,
                };
                if mine {
                    match rust_next::api::admin::resume_purges(&stale).await {
                        Ok(0) => {}
                        Ok(n) => info!("resumed {n} interrupted deletions"),
                        Err(e) => tracing::warn!("resuming interrupted deletions failed: {e}"),
                    }
                    match rust_next::db::sweep_stale(&stale.db).await {
                        Ok(swept) if swept != rust_next::db::Swept::default() => {
                            info!("swept stale rows: {swept:?}")
                        }
                        Ok(_) => {}
                        Err(e) => tracing::warn!("stale row sweep failed: {e}"),
                    }
                }
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
                let mine = match &voice.bus {
                    Some(bus) => {
                        bus.try_lock("voice-sweep", std::time::Duration::from_millis(4_500))
                            .await
                    }
                    None => true,
                };
                if mine {
                    rust_next::ws::sweep_and_log(&voice, idle).await;
                }
            }
        });
    }

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
            HeaderName::from_static("x-guest-grant"),
            HeaderName::from_static("x-invite-password"),
        ])
        .expose_headers([HeaderName::from_static(rust_next::api::NEXT_CURSOR)])
        .allow_credentials(true);

    let proxy_url = config.proxy_url();
    let app = build_router(proxy_url.as_deref(), &config, state.clone()).layer(cors);

    let addr = config.addr();
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    let mode_label = match roles == Roles::ALL {
        true => "all (proxy to frontend)".to_string(),
        false => roles.names().join(","),
    };

    info!("Starting rust-next server [roles: {mode_label}]");
    info!("Listening on http://{addr}");

    if let Some(ref url) = proxy_url {
        info!("Proxying frontend requests to {url}");
    }

    info!(
        "Rate limiting: {} req/s, burst {}",
        config.rate_limit_per_second, config.rate_limit_burst
    );
    match &config.proxy_trust {
        ProxyTrust::Peer => {}
        ProxyTrust::Any => info!(
            "TRUST_PROXY: rate limits key on X-Forwarded-For / X-Real-IP / Forwarded from any peer"
        ),
        ProxyTrust::Listed(ranges) => info!(
            "TRUSTED_PROXIES: rate limits key on X-Forwarded-For / X-Real-IP / Forwarded from {} trusted range(s)",
            ranges.len()
        ),
    }

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    rust_next::ws::depart(&state).await;
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
