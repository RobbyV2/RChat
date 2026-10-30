use std::net::SocketAddr;
use std::time::Duration;

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
    let instance = rust_next::instance::Instance::load(&db, &config.instance()).await?;
    info!("Instance: {} ({})", instance.name, instance.id);
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
    if !instance.pinned() {
        if bus.is_some() {
            tracing::warn!(
                "PUBLIC_URL is unset while replicas share a bus: set PUBLIC_URL so every replica names the same issuer and discovery URLs"
            );
        }
        if instance.allowed_hosts.is_empty() {
            info!(
                "PUBLIC_URL and ALLOWED_HOSTS are unset: /api/instance only names loopback hosts and reports localhost for any other Host"
            );
        }
    }
    let relay = match config.relay()? {
        Some(settings) => {
            let relay = rust_next::relay::Relay::start(&settings, &instance.relay_secret).await?;
            rust_next::relay::register(&relay);
            info!(
                "Relay: STUN{} on udp {}, relay ports {}-{}{}",
                match settings.turn {
                    true => " and TURN",
                    false => "",
                },
                relay.addr,
                settings.min_port,
                settings.max_port,
                match settings.allow_private {
                    true => " (RELAY_ALLOW_PRIVATE: private and loopback peers allowed)",
                    false => "",
                }
            );
            if config.redis_url.is_some() {
                tracing::warn!(
                    "Relay: REDIS_URL is set, so this may be one of several processes; allocation quotas and bandwidth caps are per relay process, so run the relay role in exactly one"
                );
            }
            let relay = std::sync::Arc::new(relay);
            rust_next::relay::follow_revocations(&relay, &hub, &db);
            Some(relay)
        }
        None => None,
    };
    hub.set_limits(config.ws_limits());
    let state = AppState::new(db, hub, config.s3()?, bus, instance);
    rust_next::ws::spawn_aftermath(&state);
    if let Some(bus) = &state.bus {
        bus.spawn_workers(&state);
    }
    let ticks = state.hub.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            ticks.tick();
        }
    });
    let touches = state.db.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
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
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                if holds(&sweeper, "media-sweep", Duration::from_secs(55)).await {
                    rust_next::api::media::sweep_expired(&sweeper).await;
                }
            }
        });
        let stale = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(600));
            loop {
                interval.tick().await;
                if holds(&stale, "db-sweep", Duration::from_secs(590)).await {
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
        let purges = state.clone();
        tokio::spawn(async move {
            let every = rust_next::api::admin::PURGE_SWEEP_SECS;
            let mut interval = tokio::time::interval(Duration::from_secs(every));
            loop {
                interval.tick().await;
                if holds(&purges, "purge-sweep", Duration::from_secs(every - 5)).await {
                    match rust_next::api::admin::resume_purges(&purges).await {
                        Ok(0) => {}
                        Ok(n) => info!("resumed {n} interrupted deletions"),
                        Err(e) => tracing::warn!("resuming interrupted deletions failed: {e}"),
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
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            let mut since = rust_next::db::now();
            let mut timeouts_since = since;
            loop {
                interval.tick().await;
                if holds(&voice, "voice-sweep", Duration::from_millis(4_500)).await {
                    rust_next::ws::sweep_and_log(&voice, idle).await;
                    let until = rust_next::db::now();
                    match rust_next::ws::announce_expired_passwords(&voice, since, until).await {
                        Ok(()) => since = until,
                        Err(e) => tracing::warn!("password expiry recheck failed: {e}"),
                    }
                    match rust_next::api::timeouts::announce_expired_timeouts(
                        &voice,
                        timeouts_since,
                        until,
                    )
                    .await
                    {
                        Ok(()) => timeouts_since = until,
                        Err(e) => tracing::warn!("timeout expiry announcement failed: {e}"),
                    }
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
    if let Some(relay) = relay {
        relay.close().await;
    }
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

/// Whether this instance runs the periodic `job` now: always without a bus, else while it
/// holds the job's lock for `hold`.
async fn holds(state: &AppState, job: &str, hold: Duration) -> bool {
    match &state.bus {
        Some(bus) => bus.try_lock(job, hold).await,
        None => true,
    }
}
