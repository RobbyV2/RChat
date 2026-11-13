use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinHandle};
use tracing::info;

use crate::api::Settings;
use crate::api::features::Feature;
use crate::config::{AppConfig, Roles};
use crate::peerjs::Peers;
use crate::relay::Relay;
pub use crate::server::Frontend;
use crate::server::client_ip::ProxyTrust;
use crate::server::{build_router, cors_layer};
use crate::state::AppState;
use crate::ws::Hub;

/// What a start may replace.
#[derive(Default)]
pub struct RunOptions {
    /// What answers the paths outside the API. `None`: the Next server when this process has
    /// the `web` role, else nothing.
    pub frontend: Option<Frontend>,
}

/// What a start holds until it stops.
#[derive(Default)]
struct Held {
    db: Option<crate::db::Db>,
    bus: Option<crate::bus::Bus>,
    relay: Option<Arc<Relay>>,
    peers: Option<Peers>,
    tasks: Vec<AbortHandle>,
    /// Seconds an unused guest grant lives, for the last write of queued grant uses.
    grant_ttl: i64,
}

impl Held {
    fn spawn(&mut self, job: impl Future<Output = ()> + Send + 'static) {
        self.tasks.push(tokio::spawn(job).abort_handle());
    }

    fn hold(&mut self, tasks: impl IntoIterator<Item = JoinHandle<()>>) {
        self.tasks
            .extend(tasks.into_iter().map(|task| task.abort_handle()));
    }

    async fn release(self) {
        let Held {
            db,
            bus,
            relay,
            peers,
            tasks,
            grant_ttl,
        } = self;
        for task in tasks {
            task.abort();
        }
        if let Some(peers) = peers {
            peers.close();
        }
        if let Some(bus) = bus {
            bus.stop();
        }
        if let Some(relay) = relay {
            crate::relay::unregister(&relay);
            relay.close().await;
        }
        if let Some(db) = db {
            if let Err(e) = crate::db::flush_grant_touches(&db, grant_ttl).await {
                tracing::warn!("guest grant refresh failed: {e}");
            }
            crate::db::forget(&db);
            crate::api::Settings::forget(&db);
            crate::api::policy::Policy::forget(&db);
            crate::api::polls::forget(&db);
            crate::api::bulk_delete::forget(&db);
            crate::db::close(&db).await;
        }
    }
}

/// A started server. It runs until `shutdown`.
pub struct Running {
    /// The address it listens on, with the real port when the configured one was 0.
    pub addr: SocketAddr,
    state: AppState,
    held: Held,
    stop: watch::Sender<bool>,
    serving: JoinHandle<std::io::Result<()>>,
}

impl Running {
    /// Realtime connections open on this server.
    pub fn connections(&self) -> usize {
        self.state.hub.connections()
    }

    /// Whether any account exists. The first one registered manages the instance.
    pub async fn has_accounts(&self) -> anyhow::Result<bool> {
        Ok(crate::db::has_accounts(&self.state.db).await?)
    }

    /// Stops taking requests, lets the open ones finish, then closes the relay and the
    /// database. Tasks of open realtime connections end with the runtime.
    pub async fn shutdown(self) {
        let Running {
            addr: _,
            state,
            held,
            stop,
            serving,
        } = self;
        let _ = stop.send(true);
        match serving.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::error!("Server error: {e}"),
            Err(e) => tracing::error!("Server task failed: {e}"),
        }
        crate::ws::depart(&state).await;
        held.release().await;
        info!("Server shutdown complete");
    }
}

/// Starts the server `config` describes on the current runtime and returns once it listens.
/// A failed start leaves nothing running.
pub async fn start(config: AppConfig, opts: RunOptions) -> anyhow::Result<Running> {
    let mut held = Held::default();
    match boot(&config, opts, &mut held).await {
        Ok((addr, state, stop, serving)) => Ok(Running {
            addr,
            state,
            held,
            stop,
            serving,
        }),
        Err(e) => {
            held.release().await;
            Err(e)
        }
    }
}

type Booted = (
    SocketAddr,
    AppState,
    watch::Sender<bool>,
    JoinHandle<std::io::Result<()>>,
);

async fn boot(config: &AppConfig, opts: RunOptions, held: &mut Held) -> anyhow::Result<Booted> {
    let RunOptions { frontend } = opts;
    if let Some(warning) = config.limits.upload_buffer_warning() {
        tracing::warn!("{warning}");
    }

    let roles = config.roles;
    let db = crate::db::open_with(config.database_url.as_deref(), &config.db_options()).await?;
    held.db = Some(db.clone());
    let (indexes, limits) = (db.clone(), config.limits.clone());
    held.spawn(async move {
        match crate::db::build_online(&indexes, &limits).await {
            Ok(built) => {
                if !built.built.is_empty() || !built.dropped.is_empty() {
                    info!(
                        "Online indexes: built {:?}, dropped {:?}",
                        built.built, built.dropped
                    );
                }
            }
            Err(e) => tracing::warn!("online index builds failed: {e}"),
        }
    });
    held.grant_ttl = config.limits.guest_grant_ttl();
    let instance = crate::instance::Instance::load(&db, &config.instance()).await?;
    info!("Instance: {} ({})", instance.name, instance.id);
    let web_only = roles
        == Roles {
            web: true,
            ..Roles::NONE
        };
    let (hub, bus) = match config.redis_url.as_deref().map(str::trim) {
        Some(url) if !web_only => {
            let (hub, bus) = crate::bus::connect(
                url,
                &config.redis_prefix,
                config.limits.redis_hub_maxlen,
                roles,
            )
            .await?;
            info!("Realtime bus: redis (prefix {})", config.redis_prefix);
            held.bus = Some(bus.clone());
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
    if let Some(settings) = config.relay()? {
        let relay = Arc::new(Relay::start(&settings, &instance.relay_secret).await?);
        held.relay = Some(Arc::clone(&relay));
        crate::relay::register(&relay);
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
        held.hold([crate::relay::follow_revocations(&relay, &hub, &db)]);
    }
    let state = AppState::new(db, hub, config.s3()?, bus, instance)
        .with_limits(Arc::new(config.limits.clone()));
    crate::api::webhooks::configure(config.outbound()?);
    crate::api::media::configure(config.upload_limits());
    held.hold(crate::api::webhooks::spawn(&state, roles.jobs));
    held.hold(crate::ws::spawn_aftermath(&state));
    held.hold([crate::api::Settings::follow(&state)]);
    if let Some(bus) = &state.bus {
        bus.spawn_workers(&state);
    }
    crate::api::controls::config_applied(&state).await;
    let ticks = state.hub.clone();
    held.spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            ticks.tick();
        }
    });
    let touches = state.clone();
    held.spawn(async move {
        let ttl = touches.limits.guest_grant_ttl();
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(e) = crate::db::flush_grant_touches(&touches.db, ttl).await {
                tracing::warn!("guest grant refresh failed: {e}");
            }
        }
    });
    if roles.jobs {
        spawn_jobs(&state, held);
    }

    let frontend = frontend.or_else(|| config.proxy_url().map(Frontend::Proxy));
    let proxy_url = match &frontend {
        Some(Frontend::Proxy(url)) => Some(Arc::clone(url)),
        Some(Frontend::Service(_)) | None => None,
    };
    let peers = config.peerjs().map(Peers::new);
    if let Some(warning) = config.peerjs_warning() {
        tracing::warn!("{warning}");
    }
    if let Some(peers) = &peers {
        held.peers = Some(peers.clone());
        held.spawn(peers.clone().expire());
        let changes = state.hub.settings_changes();
        peers.set_on(p2p_serves(Settings::cached(&state.db).await));
        held.spawn(follow_p2p(peers.clone(), state.clone(), changes));
    }
    let signaling = peers.is_some();
    let app = build_router(frontend, peers, config, state.clone()).layer(cors_layer());

    let listener = tokio::net::TcpListener::bind(&config.addr()).await?;
    let addr = listener.local_addr()?;

    let mode_label = match roles == Roles::ALL {
        true => "all (proxy to frontend)".to_string(),
        false => roles.names().join(","),
    };

    info!("Starting rust-next server [roles: {mode_label}]");
    info!("Listening on http://{addr}");

    if let Some(url) = proxy_url {
        info!("Proxying frontend requests to {url}");
    }
    if signaling {
        info!("PeerJS signaling at http://{addr}/peerjs");
    }

    info!(
        "Rate limiting: {} req/s, burst {}",
        config.limits.rate_limit_per_second, config.limits.rate_limit_burst
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

    let (stop, mut stopped) = watch::channel(false);
    let serving = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = stopped.wait_for(|stop| *stop).await;
        })
        .await
    });
    Ok((addr, state, stop, serving))
}

fn spawn_jobs(state: &AppState, held: &mut Held) {
    let sweeper = state.clone();
    held.spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if holds(&sweeper, "media-sweep", Duration::from_secs(55)).await {
                crate::api::media::sweep_expired(&sweeper).await;
            }
        }
    });
    let stale = state.clone();
    held.spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(600));
        loop {
            interval.tick().await;
            if holds(&stale, "db-sweep", Duration::from_secs(590)).await {
                match crate::db::sweep_stale(&stale.db, &stale.limits).await {
                    Ok(swept) if swept != crate::db::Swept::default() => {
                        info!("swept stale rows: {swept:?}")
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("stale row sweep failed: {e}"),
                }
            }
        }
    });
    let purges = state.clone();
    held.spawn(async move {
        let every = crate::api::admin::PURGE_SWEEP_SECS;
        let mut interval = tokio::time::interval(Duration::from_secs(every));
        loop {
            interval.tick().await;
            if holds(&purges, "purge-sweep", Duration::from_secs(every - 5)).await {
                match crate::api::admin::resume_purges(&purges).await {
                    Ok(0) => {}
                    Ok(n) => info!("resumed {n} interrupted deletions"),
                    Err(e) => tracing::warn!("resuming interrupted deletions failed: {e}"),
                }
            }
        }
    });
    let voice = state.clone();
    let idle = voice.limits.voice_idle_secs;
    held.spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        let mut since = crate::db::now();
        let mut timeouts_since = since;
        loop {
            interval.tick().await;
            if holds(&voice, "voice-sweep", Duration::from_millis(4_500)).await {
                crate::ws::sweep_and_log(&voice, idle).await;
                if let Err(e) = crate::api::polls::close_due(&voice).await {
                    tracing::warn!("closing due polls failed: {e}");
                }
                match crate::api::bulk_delete::resume_jobs(&voice).await {
                    Ok(0) => {}
                    Ok(n) => info!("resumed {n} interrupted bulk deletions"),
                    Err(e) => tracing::warn!("resuming bulk deletions failed: {e}"),
                }
                let until = crate::db::now();
                match crate::ws::announce_expired_passwords(&voice, since, until).await {
                    Ok(()) => since = until,
                    Err(e) => tracing::warn!("password expiry recheck failed: {e}"),
                }
                match crate::api::timeouts::announce_expired_timeouts(&voice, timeouts_since, until)
                    .await
                {
                    Ok(()) => timeouts_since = until,
                    Err(e) => tracing::warn!("timeout expiry announcement failed: {e}"),
                }
            }
        }
    });
}

/// The built-in PeerJS signaling serves while P2P or P2P attachments are on.
fn p2p_serves(settings: Settings) -> bool {
    settings.on(Feature::P2p) || settings.p2p_attachments
}

/// Keeps the built-in PeerJS signaling in step with the instance's switches, closing its
/// connections when both are off. A change is read again from the database, because the
/// cached settings may still be the earlier ones.
async fn follow_p2p(peers: Peers, state: AppState, mut changes: watch::Receiver<u64>) {
    while changes.changed().await.is_ok() {
        peers.set_on(p2p_serves(Settings::load(&state.db).await));
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

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashMap;
    use std::path::Path;

    use axum::Router;
    use axum::http::{StatusCode, Uri};
    use axum::routing::get;
    use sqlx::Row;

    use super::*;

    /// Held by tests that start a server: the upload limits, the outbound rules and the relay
    /// status are per process.
    pub(crate) static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    pub(crate) fn config(db: &Path, port: u16, more: &[(&str, &str)]) -> AppConfig {
        let mut env: HashMap<String, String> = [
            ("APP_MODE", "api-only".to_string()),
            ("SERVER_PORT", port.to_string()),
            ("DATABASE_URL", db.display().to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        env.extend(more.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        AppConfig::from_map(env).expect("config")
    }

    pub(crate) fn wipe(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    async fn fetch(addr: SocketAddr, path: &str) -> (StatusCode, String) {
        let res = reqwest::Client::new()
            .get(format!("http://{addr}{path}"))
            .send()
            .await
            .expect("answer");
        (res.status(), res.text().await.expect("body"))
    }

    async fn settled(what: &str, check: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while !check() {
            assert!(tokio::time::Instant::now() < deadline, "{what}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    const UP: &str = r#"{"ok":true}"#;

    /// Leaves files past their time for the next start to sweep: one past the instance's
    /// default, one past its server's own expiry, and one that never expires.
    async fn expired(db: &crate::db::Db) {
        for (id, uploaded_at, ttl) in [
            ("default", 1, None),
            ("own", crate::db::now() - 120, Some(60)),
            ("kept", 1, Some(0)),
        ] {
            sqlx::query("INSERT INTO media(id, filename, mime, size, uploaded_at, ttl) VALUES($1, 'f', 'text/plain', 1, $2, $3) ON CONFLICT(id) DO NOTHING")
                .bind(id)
                .bind(uploaded_at)
                .bind(ttl)
                .execute(db)
                .await
                .expect("file");
        }
    }

    #[tokio::test]
    async fn a_server_starts_stops_and_starts_again_in_one_process() {
        let _one = ONE.lock().await;
        let path = crate::db::temp_db_path("run_restart");
        let other = crate::db::temp_db_path("run_taken");
        wipe(&path);
        wipe(&other);
        let tasks = || {
            tokio::runtime::Handle::current()
                .metrics()
                .num_alive_tasks()
        };
        settled("the other tasks of this test ended", || tasks() == 0).await;

        let first = start(config(&path, 0, &[]), RunOptions::default())
            .await
            .expect("start");
        let addr = first.addr;
        assert!(addr.ip().is_loopback());
        assert_ne!(addr.port(), 0);
        for path in ["/api/health", "/api/v1/health"] {
            assert_eq!(fetch(addr, path).await, (StatusCode::OK, UP.to_string()));
        }
        assert_eq!(fetch(addr, "/").await.0, StatusCode::NOT_FOUND);
        assert_eq!(first.connections(), 0);
        assert!(tasks() > 0);
        let db = first.state.db.clone();

        // Under load the other database can time out before the port is tried: try again then.
        let mut refused = String::new();
        for _ in 0..5 {
            let taken = start(config(&other, addr.port(), &[]), RunOptions::default()).await;
            refused = taken.err().expect("the port is taken").to_string();
            if !refused.contains("pool timed out") {
                break;
            }
        }
        assert!(refused.to_lowercase().contains("in use"), "{refused}");
        assert_eq!(fetch(addr, "/api/health").await.0, StatusCode::OK);

        expired(&db).await;
        first.shutdown().await;
        assert!(db.is_closed());
        assert!(
            reqwest::get(format!("http://{addr}/api/health"))
                .await
                .is_err()
        );
        drop(std::net::TcpListener::bind(addr).expect("the port is free again"));
        settled("every task the server started ended", || tasks() == 0).await;

        for _ in 0..2 {
            let again = start(config(&path, addr.port(), &[]), RunOptions::default())
                .await
                .expect("start again");
            assert_eq!(again.addr, addr);
            assert_eq!(fetch(addr, "/api/health").await.0, StatusCode::OK);
            let db = again.state.db.clone();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            loop {
                let left: Vec<String> = sqlx::query("SELECT id FROM media ORDER BY id")
                    .fetch_all(&db)
                    .await
                    .expect("files")
                    .iter()
                    .map(|row| row.try_get(0).expect("id"))
                    .collect();
                if left == ["kept"] {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "a started server sweeps expired files: {left:?}"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            expired(&db).await;
            again.shutdown().await;
            settled("every task the server started ended", || tasks() == 0).await;
        }
        wipe(&path);
        wipe(&other);
    }

    fn free_udp_port() -> u16 {
        let relayed = crate::relay::DEFAULT_MIN_PORT..=crate::relay::DEFAULT_MAX_PORT;
        loop {
            let socket = std::net::UdpSocket::bind("0.0.0.0:0").expect("udp");
            let port = socket.local_addr().expect("addr").port();
            if !relayed.contains(&port) {
                return port;
            }
        }
    }

    #[tokio::test]
    async fn a_second_start_uses_its_own_settings() {
        let _one = ONE.lock().await;
        let path = crate::db::temp_db_path("run_settings");
        wipe(&path);
        let mib = 1024 * 1024;
        let own_hosts = || crate::api::webhooks::previews_policy().own_hosts;
        let relay_port = free_udp_port();

        let first = start(
            config(
                &path,
                0,
                &[
                    ("UPLOAD_BUDGET_MIB", "4096"),
                    ("PUBLIC_URL", "https://one.example"),
                    ("RELAY_ENABLED", "true"),
                    ("RELAY_TURN", "false"),
                    ("RELAY_PORT", &relay_port.to_string()),
                ],
            ),
            RunOptions::default(),
        )
        .await
        .expect("start");
        assert_eq!(crate::api::media::budget(), 4096 * mib);
        assert_eq!(own_hosts(), ["one.example"]);
        let relay = crate::relay::status().expect("the relay runs");
        assert_eq!(relay.port, relay_port);

        let old = first.state.db.clone();
        let grant = crate::db::secret_key("a guest grant");
        for sql in [
            "UPDATE settings SET value = '0' WHERE key = 'guests_enabled'",
            "UPDATE settings SET value = 'alice' WHERE key = 'server_creators'",
            "INSERT INTO guest_grants(\"grant\", server, created_at) VALUES($1, 'rchat', $2)",
        ] {
            sqlx::query(sql)
                .bind(&grant)
                .bind(crate::db::now())
                .execute(&old)
                .await
                .expect(sql);
        }
        let cached = crate::api::Settings::load(&old).await;
        assert!(!cached.guests_enabled && cached.asset_uploads);
        let creators = crate::api::policy::Policy::load(&old).await;
        assert_eq!(creators.server_creators.len(), 1);
        crate::db::queue_grant_touches(&old, [grant.clone()]);
        crate::db::touch_interaction(&old, "rchat", "alice")
            .await
            .expect("touch");
        first.shutdown().await;
        assert!(
            !crate::api::Settings::load(&old).await.asset_uploads,
            "the settings of a stopped server are forgotten, not served as the last known ones"
        );
        let creators = crate::api::policy::Policy::load(&old).await;
        assert!(creators.server_creators.is_empty(), "and so are its lists");
        assert!(!crate::db::grant_touch_queued(&old, &grant));
        let stopped = crate::db::open(path.to_str()).await.expect("open the file");
        let used: i64 = sqlx::query("SELECT last_used_at FROM guest_grants WHERE \"grant\" = $1")
            .bind(&grant)
            .fetch_one(&stopped)
            .await
            .expect("grant")
            .try_get(0)
            .expect("last_used_at");
        assert!(used > 0, "the queued grant use was written before the stop");
        crate::db::close(&stopped).await;
        // Another database takes the place of the old one at the same address, as a restore does.
        wipe(&path);
        assert!(crate::relay::status().is_none());
        drop(std::net::UdpSocket::bind(("0.0.0.0", relay_port)).expect("the relay port is free"));

        let second = start(
            config(
                &path,
                0,
                &[
                    ("UPLOAD_BUDGET_MIB", "8192"),
                    ("PUBLIC_URL", "https://two.example"),
                ],
            ),
            RunOptions::default(),
        )
        .await
        .expect("start again");
        assert_eq!(crate::api::media::budget(), 8192 * mib);
        assert_eq!(own_hosts(), ["two.example"]);
        assert!(crate::relay::status().is_none());
        let new = second.state.db.clone();
        assert_eq!(crate::db::pool_key(&old), crate::db::pool_key(&new));
        assert!(
            crate::api::Settings::cached(&new).await.guests_enabled,
            "the new database's settings, not the old one's"
        );
        crate::db::touch_interaction(&new, "rchat", "alice")
            .await
            .expect("touch");
        let touched: i64 = sqlx::query("SELECT COUNT(*) FROM interactions")
            .fetch_one(&new)
            .await
            .expect("interactions")
            .try_get(0)
            .expect("count");
        assert_eq!(touched, 1, "the new database gets its own interaction");
        second.shutdown().await;

        crate::api::media::configure(crate::api::media::UploadLimits::default());
        crate::api::webhooks::configure(crate::api::webhooks::Outbound::default());
        wipe(&path);
    }

    #[tokio::test]
    async fn a_frontend_service_answers_outside_the_api() {
        let _one = ONE.lock().await;
        let path = crate::db::temp_db_path("run_frontend");
        wipe(&path);
        let web = Router::new()
            .route("/", get(|| async { "web app" }))
            .fallback(|uri: Uri| async move { (StatusCode::NOT_FOUND, format!("no page {uri}")) });
        let running = start(
            config(&path, 0, &[]),
            RunOptions {
                frontend: Some(Frontend::Service(web)),
            },
        )
        .await
        .expect("start");
        let addr = running.addr;
        assert_eq!(
            fetch(addr, "/").await,
            (StatusCode::OK, "web app".to_string())
        );
        for page in ["/login", "/s/rchat/?x=1", "/apis/me", "/peerjs/id"] {
            assert_eq!(
                fetch(addr, page).await,
                (StatusCode::NOT_FOUND, format!("no page {page}"))
            );
        }
        for path in ["/api/health", "/api/v1/health"] {
            assert_eq!(fetch(addr, path).await, (StatusCode::OK, UP.to_string()));
        }
        assert_eq!(fetch(addr, "/api/me").await.0, StatusCode::UNAUTHORIZED);
        for unrouted in ["/api", "/api/", "/api/nope", "/api/v1/nope", "/api/v1"] {
            assert_eq!(
                fetch(addr, unrouted).await,
                (StatusCode::NOT_FOUND, String::new()),
                "{unrouted}"
            );
        }
        let posted = reqwest::Client::new()
            .post(format!("http://{addr}/login"))
            .send()
            .await
            .expect("post");
        assert_eq!(posted.text().await.expect("body"), "no page /login");
        running.shutdown().await;
        wipe(&path);
    }

    async fn advertised(addr: SocketAddr) -> String {
        let (status, body) = fetch(addr, "/api/instance").await;
        assert_eq!(status, StatusCode::OK);
        let doc: serde_json::Value = serde_json::from_str(&body).expect("json");
        doc["peerjs_url"].as_str().expect("peerjs_url").to_string()
    }

    fn hello(addr: SocketAddr, id: &str) -> String {
        format!("ws://{addr}/peerjs/peerjs?key=peerjs&id={id}&token=t&version=1.5.5")
    }

    type Signaling = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// A PeerJS client that registered `id` on the server's own port.
    async fn signaling(addr: SocketAddr, id: &str) -> Signaling {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message;
        let (mut peer, _) = tokio_tungstenite::connect_async(hello(addr, id))
            .await
            .expect("signaling");
        let opened = peer.next().await.expect("a frame").expect("frame");
        assert_eq!(opened, Message::text(r#"{"type":"OPEN"}"#));
        peer
    }

    #[tokio::test]
    async fn a_default_server_answers_peerjs_on_its_own_port() {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::{Error, Message};
        let _one = ONE.lock().await;
        let path = crate::db::temp_db_path("run_peerjs");
        wipe(&path);
        let plain = start(config(&path, 0, &[]), RunOptions::default())
            .await
            .expect("start");
        let addr = plain.addr;
        assert_eq!(advertised(addr).await, format!("http://{addr}/peerjs"));
        let (status, about) = fetch(addr, "/peerjs").await;
        assert_eq!(status, StatusCode::OK);
        assert!(about.contains("PeerJS Server"), "{about}");
        let (status, id) = fetch(addr, "/peerjs/peerjs/id").await;
        assert_eq!((status, id.len()), (StatusCode::OK, 32));
        let mut peer = signaling(addr, &id).await;
        let _second = signaling(addr, "b").await;
        assert_eq!(fetch(addr, "/api/health").await.0, StatusCode::OK);
        plain.shutdown().await;
        let closed = tokio::time::timeout(Duration::from_secs(30), peer.next())
            .await
            .expect("the signaling socket closes with the server");
        assert!(
            matches!(closed, Some(Ok(Message::Close(_)) | Err(_)) | None),
            "{closed:?}"
        );

        let web = Router::new().fallback(|uri: Uri| async move { format!("page {uri}") });
        let capped = start(
            config(&path, 0, &[("PEERJS_PEERS_PER_IP", "1")]),
            RunOptions {
                frontend: Some(Frontend::Service(web)),
            },
        )
        .await
        .expect("start");
        let addr = capped.addr;
        assert_eq!(advertised(addr).await, format!("http://{addr}/peerjs"));
        assert_eq!(
            fetch(addr, "/peerjs/other").await,
            (StatusCode::OK, "page /peerjs/other".to_string())
        );
        let _peer = signaling(addr, "a").await;
        match tokio_tungstenite::connect_async(hello(addr, "b")).await {
            Err(Error::Http(res)) => assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS),
            other => panic!("PEERJS_PEERS_PER_IP was not applied: {:?}", other.is_ok()),
        }
        capped.shutdown().await;
        wipe(&path);
    }

    #[tokio::test]
    async fn an_instance_with_its_own_peerjs_server_keeps_it() {
        use tokio_tungstenite::tungstenite::Error;
        let _one = ONE.lock().await;
        let path = crate::db::temp_db_path("run_peerjs_own");
        wipe(&path);

        // An instance from before the built-in signaling that had PEERJS_PORT set.
        let ported = start(
            config(&path, 0, &[("PEERJS_PORT", "9100")]),
            RunOptions::default(),
        )
        .await
        .expect("start");
        assert_eq!(
            advertised(ported.addr).await,
            "http://127.0.0.1:9100/peerjs"
        );
        let _also = signaling(ported.addr, "a").await;
        ported.shutdown().await;

        // One whose web build was given its own PeerJS port, and nothing else.
        let baked = start(
            config(&path, 0, &[("NEXT_PUBLIC_PEERJS_PORT", "9443")]),
            RunOptions::default(),
        )
        .await
        .expect("start");
        assert_eq!(advertised(baked.addr).await, "http://127.0.0.1:9443/peerjs");
        baked.shutdown().await;

        let elsewhere = start(
            config(
                &path,
                0,
                &[("PUBLIC_PEERJS_URL", "https://peer.example/peerjs")],
            ),
            RunOptions::default(),
        )
        .await
        .expect("start");
        assert_eq!(
            advertised(elsewhere.addr).await,
            "https://peer.example/peerjs"
        );
        elsewhere.shutdown().await;

        for (more, port) in [
            (vec![("PEERJS_BUILTIN", "false")], None),
            (
                vec![("PEERJS_BUILTIN", "off"), ("PEERJS_PORT", "9100")],
                Some(9100),
            ),
        ] {
            let off = start(config(&path, 0, &more), RunOptions::default())
                .await
                .expect("start");
            let addr = off.addr;
            for route in ["/peerjs", "/peerjs/peerjs/id"] {
                assert_eq!(fetch(addr, route).await.0, StatusCode::NOT_FOUND);
            }
            match tokio_tungstenite::connect_async(hello(addr, "a")).await {
                Err(Error::Http(res)) => assert_eq!(res.status(), StatusCode::NOT_FOUND),
                other => panic!("signaling answered while off: {:?}", other.is_ok()),
            }
            let expected = match port {
                Some(port) => format!("http://127.0.0.1:{port}/peerjs"),
                None => format!("http://{addr}/peerjs"),
            };
            assert_eq!(advertised(addr).await, expected);
            off.shutdown().await;
        }
        crate::api::webhooks::configure(crate::api::webhooks::Outbound::default());
        wipe(&path);
    }

    /// A frontend that answers every request with its request target.
    async fn echo_frontend() -> (String, JoinHandle<()>) {
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
    async fn the_web_role_still_proxies_to_the_frontend() {
        let _one = ONE.lock().await;
        let path = crate::db::temp_db_path("run_proxy");
        wipe(&path);
        let (url, frontend) = echo_frontend().await;
        let running = start(
            config(
                &path,
                0,
                &[("APP_MODE", "full"), ("SERVER_PROXY_URL", &url)],
            ),
            RunOptions::default(),
        )
        .await
        .expect("start");
        let addr = running.addr;
        for target in ["/login?x=1", "/api/nope?x=1"] {
            assert_eq!(
                fetch(addr, target).await,
                (StatusCode::OK, target.to_string())
            );
        }
        assert_eq!(
            fetch(addr, "/api/health").await,
            (StatusCode::OK, UP.to_string())
        );
        running.shutdown().await;
        frontend.abort();
        wipe(&path);
    }

    #[tokio::test]
    async fn accounts_show_once_someone_registers() {
        let _one = ONE.lock().await;
        let path = crate::db::temp_db_path("run_accounts");
        wipe(&path);
        let running = start(config(&path, 0, &[]), RunOptions::default())
            .await
            .expect("start");
        assert!(!running.has_accounts().await.expect("none yet"));
        let res = reqwest::Client::new()
            .post(format!("http://{}/api/auth/register", running.addr))
            .header("content-type", "application/json")
            .body(
                serde_json::json!({
                    "username": "Alice",
                    "password": "a long enough password",
                    "avatar_kind": "identicon",
                })
                .to_string(),
            )
            .send()
            .await
            .expect("register");
        assert_eq!(res.status(), StatusCode::OK);
        assert!(running.has_accounts().await.expect("one"));
        running.shutdown().await;
        wipe(&path);
    }

    #[tokio::test]
    async fn signaling_follows_the_p2p_switches() {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::{Error, Message};
        const OFF: &str = "P2P is turned off on this instance";
        let _one = ONE.lock().await;
        let path = crate::db::temp_db_path("run_peerjs_switch");
        wipe(&path);
        let on = [("PEERJS_BUILTIN", "on")];
        let running = start(config(&path, 0, &on), RunOptions::default())
            .await
            .expect("start");
        let addr = running.addr;
        let http = reqwest::Client::new();
        let registered = http
            .post(format!("http://{addr}/api/auth/register"))
            .header("content-type", "application/json")
            .body(r#"{"username":"Root","password":"a long enough password","avatar_kind":"identicon"}"#)
            .send()
            .await
            .expect("register");
        assert_eq!(registered.status(), StatusCode::OK);
        let account: serde_json::Value =
            serde_json::from_str(&registered.text().await.expect("body")).expect("json");
        let token = account["token"].as_str().expect("token").to_string();
        let switch = |body: &'static str| {
            let (http, token) = (http.clone(), token.clone());
            async move {
                let res = http
                    .patch(format!("http://{addr}/api/admin/settings"))
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(body)
                    .send()
                    .await
                    .expect("patch");
                assert_eq!(res.status(), StatusCode::OK, "{body}");
            }
        };
        let dial = |id: &'static str| async move {
            let url = format!("ws://{addr}/peerjs/peerjs?key=peerjs&id={id}&token=t");
            tokio_tungstenite::connect_async(url)
                .await
                .map(|(peer, _)| peer)
        };
        type Peer = tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >;
        let closed = |mut peer: Peer| async move {
            loop {
                let frame = tokio::time::timeout(Duration::from_secs(30), peer.next())
                    .await
                    .expect("the signaling socket closes");
                match frame {
                    Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
        };

        let first = dial("a").await.expect("signaling");
        switch(r#"{"p2p":false}"#).await;
        let second = dial("b")
            .await
            .expect("P2P attachments still need the signaling");
        switch(r#"{"p2p_attachments":false}"#).await;
        closed(first).await;
        closed(second).await;
        match dial("c").await {
            Err(Error::Http(res)) => assert_eq!(res.status(), StatusCode::NOT_FOUND),
            other => panic!("signaling answered while P2P is off: {:?}", other.is_ok()),
        }
        for route in ["/peerjs", "/peerjs/peerjs/id"] {
            assert_eq!(
                fetch(addr, route).await,
                (StatusCode::NOT_FOUND, OFF.to_string())
            );
        }
        assert_eq!(fetch(addr, "/api/health").await.0, StatusCode::OK);

        // A server that starts while both are off refuses from its first moment on.
        running.shutdown().await;
        let again = start(config(&path, 0, &on), RunOptions::default())
            .await
            .expect("start again");
        let addr = again.addr;
        assert_eq!(
            fetch(addr, "/peerjs").await,
            (StatusCode::NOT_FOUND, OFF.to_string()),
            "off from the start"
        );
        let http = reqwest::Client::new();
        let res = http
            .patch(format!("http://{addr}/api/admin/settings"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(r#"{"p2p":true}"#)
            .send()
            .await
            .expect("patch");
        assert_eq!(res.status(), StatusCode::OK);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while fetch(addr, "/peerjs").await.0 != StatusCode::OK {
            assert!(tokio::time::Instant::now() < deadline, "on again");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let url = format!("ws://{addr}/peerjs/peerjs?key=peerjs&id=a&token=t");
        let (mut peer, _) = tokio_tungstenite::connect_async(url)
            .await
            .expect("signaling again");
        let opened = peer.next().await.expect("a frame").expect("frame");
        assert_eq!(opened, Message::text(r#"{"type":"OPEN"}"#));
        again.shutdown().await;
        wipe(&path);

        // The server config sets the same switches: off there is off from the start.
        let set = [
            ("PEERJS_BUILTIN", "on"),
            ("FEATURE_P2P", "off"),
            ("P2P_ATTACHMENTS", "off"),
        ];
        let configured = start(config(&path, 0, &set), RunOptions::default())
            .await
            .expect("start with the switches off");
        assert_eq!(
            fetch(configured.addr, "/peerjs").await,
            (StatusCode::NOT_FOUND, OFF.to_string())
        );
        configured.shutdown().await;
        let kept = [
            ("PEERJS_BUILTIN", "on"),
            ("FEATURE_P2P", "off"),
            ("P2P_ATTACHMENTS", "on"),
        ];
        let half = start(config(&path, 0, &kept), RunOptions::default())
            .await
            .expect("start with one switch on");
        assert_eq!(fetch(half.addr, "/peerjs").await.0, StatusCode::OK);
        half.shutdown().await;
        wipe(&path);
    }
}
