// Runs the server inside this process, on its own thread with its own runtime, so stopping it
// ends everything it started and leaves the app running.

use crate::server::assets::{self, Resolver};
use crate::server::backups::{self, Backup};
use crate::server::dirs::{self, MoveMode};
use crate::server::env::{self, Env};
use crate::server::logs::Logs;
use crate::server::ports;
use crate::settings::ServerSettings;
use crate::tray_menu;
use rust_next::config::AppConfig;
use rust_next::run::{self, Frontend, RunOptions, Running};
use serde::Serialize;
use std::net::SocketAddr;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

const CRASHED: &str = "The server stopped unexpectedly. See the logs.";
const POSTGRES_BACKUP: &str = "Back up your Postgres database yourself.";
const STOP_FIRST: &str = "Stop the server to change the folder.";
const HAS_DATA: &str = "That folder already has server data.";
const NO_DATA: &str = "That folder has no server data.";
const NOT_RUNNING: &str = "Start the server first.";
const SAME_SERVER: &str = "This address leads to your server.";
const OTHER_SERVER: &str = "That address leads to a different server.";
const THREAD: &str = "rchat-server";
// How long open requests get to finish when the server stops.
const SHUTDOWN: Duration = Duration::from_secs(10);
// How long closing the database and the relay may take after that.
const RELEASE: Duration = Duration::from_secs(20);
// How long the tasks the server leaves behind get to end.
const DRAIN: Duration = Duration::from_secs(2);
const WATCH: Duration = Duration::from_millis(500);
const PROBE: Duration = Duration::from_secs(8);

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Off,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub state: State,
    // Where this app's own client reaches the server, while it runs.
    pub url: Option<String>,
    pub listen: Option<String>,
    pub connections: u32,
    pub accounts: bool,
    pub schema: Option<i64>,
    pub postgres: bool,
    pub data_dir: String,
    // The SQLite database's size; None on Postgres.
    pub db_bytes: Option<u64>,
    pub backups: Vec<Backup>,
    pub error: Option<String>,
    // The saved settings differ from the ones the server runs with.
    pub needs_restart: bool,
    // When the running server started, in seconds since 1970.
    pub started: Option<u64>,
    // The port setup offers, while no server is set up.
    pub proposed_port: Option<u16>,
}

// What a running server was started with.
#[derive(PartialEq, Eq)]
struct Applied {
    env: Env,
    serve_web: bool,
}

impl Applied {
    // For settings that passed `env::validate`.
    fn of(settings: &ServerSettings, dir: &Path) -> Result<Self, String> {
        Ok(Applied {
            env: env::unchecked_env(settings, &dir.to_string_lossy())?,
            serve_web: settings.serve_web,
        })
    }
}

// What the server's thread reports while it runs.
#[derive(Default)]
struct Seen {
    connections: AtomicU32,
    accounts: AtomicBool,
}

struct Server {
    addr: SocketAddr,
    url: String,
    started: u64,
    applied: Applied,
    seen: Arc<Seen>,
    stop: oneshot::Sender<()>,
    thread: JoinHandle<()>,
}

struct Live {
    state: State,
    error: Option<String>,
    schema: Option<i64>,
    server: Option<Server>,
}

type Watcher = Box<dyn Fn() + Send + Sync>;

struct Inner {
    default_dir: PathBuf,
    web: Option<Resolver>,
    logs: Arc<Logs>,
    // Held by whatever starts, stops or copies, so one of them happens at a time.
    work: Mutex<()>,
    live: Mutex<Live>,
    watchers: Mutex<Vec<Watcher>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

// Runs `work` to its end on this thread.
fn wait<T>(work: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Can't start the work: {e}"))?
        .block_on(work)
}

impl Inner {
    fn changed(&self) {
        for watcher in lock(&self.watchers).iter() {
            watcher();
        }
    }

    fn set(&self, state: State, error: Option<String>) {
        {
            let mut live = lock(&self.live);
            live.state = state;
            live.error = error;
        }
        self.changed();
    }

    fn dir(&self, settings: &ServerSettings) -> PathBuf {
        dirs::resolve(settings, &self.default_dir)
    }
}

// The body of the server's thread: start, report, wait for the stop, shut down.
async fn serve(
    inner: &Inner,
    config: AppConfig,
    sqlite: Option<PathBuf>,
    frontend: Option<Frontend>,
    seen: &Seen,
    started: &mpsc::Sender<Result<SocketAddr, String>>,
    mut stop: oneshot::Receiver<()>,
) -> Result<(), String> {
    if let Some(dir) = &sqlite {
        let found = backups::before_start(dir, rust_next::db::SCHEMA_VERSION, now()).await;
        let stored =
            rust_next::db::stored_schema_version(Some(&env::sqlite_url(&dir.to_string_lossy())))
                .await
                .ok()
                .flatten();
        lock(&inner.live).schema = stored;
        if let backups::Found::Older { version, backup } = found? {
            tracing::info!(
                "Schema {version} database copied to backups/{backup} before the upgrade"
            );
        }
    }
    let running = run::start(config, RunOptions { frontend })
        .await
        .map_err(|e| format!("{e:#}"))?;
    lock(&inner.live).schema = Some(rust_next::db::SCHEMA_VERSION);
    watch(&running, seen).await;
    let _ = started.send(Ok(running.addr));
    let mut tick = tokio::time::interval(WATCH);
    loop {
        tokio::select! {
            _ = &mut stop => break,
            _ = tick.tick() => {
                if watch(&running, seen).await {
                    inner.changed();
                }
            }
        }
    }
    if tokio::time::timeout(SHUTDOWN + RELEASE, running.shutdown_within(SHUTDOWN))
        .await
        .is_err()
    {
        tracing::warn!(
            "The server's data was not closed after {:?}",
            SHUTDOWN + RELEASE
        );
    }
    Ok(())
}

// Reads what the status shows; true when it changed.
async fn watch(running: &Running, seen: &Seen) -> bool {
    let connections = u32::try_from(running.connections()).unwrap_or(u32::MAX);
    let before = seen.connections.swap(connections, Ordering::SeqCst);
    // Accounts are never all removed while the server runs, so one found is enough.
    let had = seen.accounts.load(Ordering::SeqCst);
    let has = had || running.has_accounts().await.unwrap_or(false);
    seen.accounts.store(has, Ordering::SeqCst);
    before != connections || had != has
}

fn workers() -> usize {
    std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .clamp(2, 4)
}

fn spawn(
    inner: Arc<Inner>,
    config: AppConfig,
    sqlite: Option<PathBuf>,
    frontend: Option<Frontend>,
    seen: Arc<Seen>,
    started: mpsc::Sender<Result<SocketAddr, String>>,
    stop: oneshot::Receiver<()>,
) -> std::io::Result<JoinHandle<()>> {
    std::thread::Builder::new()
        .name(THREAD.into())
        .spawn(move || {
            let ended = catch_unwind(AssertUnwindSafe(|| {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(workers())
                    .thread_name(THREAD)
                    .enable_all()
                    .build()
                    .map_err(|e| format!("Can't start the server: {e}"))?;
                let served = runtime.block_on(serve(
                    &inner, config, sqlite, frontend, &seen, &started, stop,
                ));
                runtime.shutdown_timeout(DRAIN);
                served
            }));
            match ended {
                Ok(Ok(())) => {}
                Ok(Err(text)) => {
                    let _ = started.send(Err(text));
                }
                // Whoever waits for the start hears it; a server that was running is
                // marked as failed here.
                Err(_) => {
                    if started.send(Err(CRASHED.into())).is_err() {
                        inner.crashed();
                    }
                }
            }
        })
}

impl Inner {
    fn crashed(&self) {
        {
            let mut live = lock(&self.live);
            if live.state != State::Running {
                return;
            }
            live.state = State::Failed;
            live.error = Some(CRASHED.into());
            live.server = None;
        }
        self.changed();
    }

    fn launch(self: &Arc<Self>, settings: &ServerSettings) -> Result<(), String> {
        env::validate(settings)?;
        let dir = self.dir(settings);
        dirs::open(&dir)?;
        let applied = Applied::of(settings, &dir)?;
        let config = AppConfig::from_map(
            applied
                .env
                .clone()
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>(),
        )
        .map_err(|e| format!("{e:#}"))?;
        if !ports::is_free(&env::listen_host(settings), settings.port) {
            return Err(ports::in_use(settings.port));
        }
        if let Err(e) = self.logs.to_dir(&dirs::logs_dir(&dir)) {
            eprintln!("server log: {e}");
        }
        let frontend = self
            .web
            .clone()
            .filter(|_| settings.serve_web)
            .map(|web| Frontend::Service(assets::router(web)));
        let sqlite = (!env::is_postgres(settings)).then(|| dir.clone());
        let seen = Arc::new(Seen::default());
        let (started, start) = mpsc::channel();
        let (stop, stopped) = oneshot::channel();
        let thread = spawn(
            self.clone(),
            config,
            sqlite,
            frontend,
            seen.clone(),
            started,
            stopped,
        )
        .map_err(|e| format!("Can't start the server: {e}"))?;
        match start.recv().unwrap_or_else(|_| Err(CRASHED.into())) {
            Ok(addr) => {
                let mut live = lock(&self.live);
                live.state = State::Running;
                live.error = None;
                live.server = Some(Server {
                    addr,
                    url: env::client_url(settings, addr),
                    started: now(),
                    applied,
                    seen,
                    stop,
                    thread,
                });
                Ok(())
            }
            Err(text) => {
                let _ = thread.join();
                Err(text)
            }
        }
    }

    fn start(self: &Arc<Self>, settings: &ServerSettings) {
        if lock(&self.live).server.is_some() {
            return;
        }
        self.set(State::Starting, None);
        match self.launch(settings) {
            Ok(()) => self.changed(),
            Err(text) => {
                self.logs.close_file();
                self.set(State::Failed, Some(text));
            }
        }
    }

    fn stop(&self) {
        let server = {
            let mut live = lock(&self.live);
            live.server.take().inspect(|_| live.state = State::Stopping)
        };
        if let Some(Server { stop, thread, .. }) = server {
            self.changed();
            let _ = stop.send(());
            let _ = thread.join();
        }
        self.logs.close_file();
        self.set(State::Off, None);
    }

    fn sqlite_dir(&self, settings: &ServerSettings) -> Result<PathBuf, String> {
        match env::is_postgres(settings) {
            true => Err(POSTGRES_BACKUP.into()),
            false => Ok(self.dir(settings)),
        }
    }
}

// The id an instance reports at `origin`, or None when the answer is no instance's.
async fn instance_id(client: &reqwest::Client, origin: &str) -> Result<Option<String>, ()> {
    let answer = client
        .get(format!("{origin}/api/instance"))
        .send()
        .await
        .map_err(|_| ())?;
    let body = answer.text().await.map_err(|_| ())?;
    let info: Option<serde_json::Value> = serde_json::from_str(&body).ok();
    Ok(info.and_then(|info| info.get("id")?.as_str().map(str::to_string)))
}

// Whether the instance at `theirs` is the one at `own`.
async fn same_instance(own: &str, theirs: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(PROBE)
        .build()
        .map_err(|e| format!("Can't test the address: {e}"))?;
    let host = theirs.split_once("://").map_or(theirs, |(_, host)| host);
    let unreachable = || format!("Can't reach {host}");
    let ours = instance_id(&client, own)
        .await
        .ok()
        .flatten()
        .ok_or(NOT_RUNNING)?;
    match instance_id(&client, theirs)
        .await
        .map_err(|()| unreachable())?
    {
        Some(id) if id == ours => Ok(SAME_SERVER.into()),
        Some(_) | None => Err(OTHER_SERVER.into()),
    }
}

fn needs_restart(server: Option<&Server>, saved: &ServerSettings, dir: &Path) -> bool {
    server.is_some_and(|s| Applied::of(saved, dir).map_or(true, |now| now != s.applied))
}

pub struct Supervisor {
    inner: Arc<Inner>,
}

impl Supervisor {
    // `default_dir` holds the data of a server whose settings name no folder. `web` is the
    // bundled web app, when there is one to serve.
    pub fn new(default_dir: PathBuf, web: Option<Resolver>, logs: Arc<Logs>) -> Self {
        Supervisor {
            inner: Arc::new(Inner {
                default_dir,
                web,
                logs,
                work: Mutex::new(()),
                live: Mutex::new(Live {
                    state: State::Off,
                    error: None,
                    schema: None,
                    server: None,
                }),
                watchers: Mutex::new(Vec::new()),
            }),
        }
    }

    // Called after every change of the status, from whichever thread made it.
    pub fn on_change(&self, watcher: impl Fn() + Send + Sync + 'static) {
        lock(&self.inner.watchers).push(Box::new(watcher));
    }

    pub fn status(&self, saved: &ServerSettings) -> Status {
        let dir = self.inner.dir(saved);
        let postgres = env::is_postgres(saved);
        let proposed_port = match saved.set_up {
            true => None,
            false => ports::propose(&env::listen_host(saved)),
        };
        let live = lock(&self.inner.live);
        let server = live.server.as_ref();
        Status {
            state: live.state,
            url: server.map(|s| s.url.clone()),
            listen: server.map(|s| s.addr.to_string()),
            connections: server.map_or(0, |s| s.seen.connections.load(Ordering::SeqCst)),
            accounts: server.is_some_and(|s| s.seen.accounts.load(Ordering::SeqCst)),
            schema: live.schema,
            postgres,
            data_dir: dir.display().to_string(),
            db_bytes: (!postgres).then(|| dirs::db_bytes(&dir)),
            backups: backups::list(&dir),
            error: live.error.clone(),
            needs_restart: needs_restart(server, saved, &dir),
            started: server.map(|s| s.started),
            proposed_port,
        }
    }

    // What the tray shows, without the status's look at the disk.
    pub fn tray(&self, saved: &ServerSettings) -> tray_menu::Server {
        let dir = self.inner.dir(saved);
        let live = lock(&self.inner.live);
        let server = live.server.as_ref();
        tray_menu::Server {
            state: match live.state {
                State::Off => tray_menu::ServerState::Off,
                State::Starting => tray_menu::ServerState::Starting,
                State::Running => tray_menu::ServerState::Running,
                State::Stopping => tray_menu::ServerState::Stopping,
                State::Failed => tray_menu::ServerState::Failed,
            },
            connections: server.map_or(0, |s| s.seen.connections.load(Ordering::SeqCst)),
            needs_restart: needs_restart(server, saved, &dir),
        }
    }

    pub fn running(&self) -> bool {
        lock(&self.inner.live).server.is_some()
    }

    // Returns once the server listens or has failed.
    pub fn start(&self, settings: &ServerSettings) -> Status {
        {
            let _work = lock(&self.inner.work);
            self.inner.start(settings);
        }
        self.status(settings)
    }

    // Returns once the server has ended and its database is closed.
    pub fn stop(&self, saved: &ServerSettings) -> Status {
        {
            let _work = lock(&self.inner.work);
            self.inner.stop();
        }
        self.status(saved)
    }

    pub fn restart(&self, settings: &ServerSettings) -> Status {
        {
            let _work = lock(&self.inner.work);
            self.inner.stop();
            self.inner.start(settings);
        }
        self.status(settings)
    }

    pub fn backup(&self, settings: &ServerSettings) -> Result<String, String> {
        let _work = lock(&self.inner.work);
        let dir = self.inner.sqlite_dir(settings)?;
        let name = wait(backups::backup_now(&dir, now()))?;
        self.inner.changed();
        Ok(name)
    }

    // Stops the server, swaps the database for the backup, and starts it again if it ran.
    pub fn restore(&self, settings: &ServerSettings, name: &str) -> Result<Status, String> {
        {
            let _work = lock(&self.inner.work);
            let dir = self.inner.sqlite_dir(settings)?;
            backups::listed(&dir, name)?;
            let ran = self.running();
            self.inner.stop();
            let restored = wait(backups::restore(&dir, name, now()));
            if ran {
                self.inner.start(settings);
            }
            restored?;
        }
        Ok(self.status(settings))
    }

    // Prepares `folder` as the data folder of a stopped server. The caller saves it.
    pub fn move_data(
        &self,
        settings: &ServerSettings,
        folder: &str,
        mode: MoveMode,
    ) -> Result<(), String> {
        let _work = lock(&self.inner.work);
        if self.running() {
            return Err(STOP_FIRST.into());
        }
        let folder = folder.trim();
        if folder.is_empty() {
            return Err("Pick a folder.".into());
        }
        dirs::validate(folder)?;
        let (from, to) = (self.inner.dir(settings), PathBuf::from(folder));
        if env::is_postgres(settings) || from == to {
            return dirs::open(&to);
        }
        match (mode, dirs::has_data(&to)) {
            (MoveMode::Use, false) => Err(NO_DATA.into()),
            (MoveMode::Use, true) => Ok(()),
            (MoveMode::Move | MoveMode::Empty, true) => Err(HAS_DATA.into()),
            (MoveMode::Empty, false) => dirs::open(&to),
            (MoveMode::Move, false) => {
                dirs::open(&to)?;
                match dirs::has_data(&from) {
                    true => wait(backups::copy_db(&dirs::db_path(&from), &dirs::db_path(&to))),
                    false => Ok(()),
                }
            }
        }
    }

    // Stops the server; with `delete_data`, deletes what it stored.
    pub fn remove(&self, settings: &ServerSettings, delete_data: bool) -> Result<(), String> {
        let _work = lock(&self.inner.work);
        self.inner.stop();
        lock(&self.inner.live).schema = None;
        match delete_data {
            true => dirs::delete_data(&self.inner.dir(settings))
                .map_err(|e| format!("Can't delete the data: {e}")),
            false => Ok(()),
        }
    }

    // Whether an HTTPS address leads to this server.
    pub fn test_address(&self, address: &str) -> Result<String, String> {
        let own = lock(&self.inner.live)
            .server
            .as_ref()
            .map(|s| env::own_origin(s.addr))
            .ok_or(NOT_RUNNING)?;
        let theirs = env::https_origin(address)?;
        wait(same_instance(&own, &theirs))
    }
}

// The server ends with the app.
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _work = lock(&self.inner.work);
        self.inner.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::assets::tests::{HOME, site};
    use crate::server::backups::tests::{run, value, wait};
    use crate::server::dirs::tests::temp;
    use crate::settings::{Access, AccessMode, ProxyHost};
    use std::fs;
    use std::net::TcpListener;
    use std::sync::LazyLock;
    use std::sync::atomic::AtomicUsize;

    // One server at a time: its upload limits and outbound rules are per process.
    static ONE: Mutex<()> = Mutex::new(());
    static LOGS: LazyLock<Arc<Logs>> = LazyLock::new(|| {
        let logs = Logs::new();
        assert!(logs.install(false));
        logs
    });

    fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    }

    struct Bench {
        _one: MutexGuard<'static, ()>,
        dir: PathBuf,
        settings: ServerSettings,
        supervisor: Supervisor,
    }

    impl Bench {
        fn new(name: &str) -> Self {
            let one = ONE.lock().unwrap_or_else(|e| e.into_inner());
            let dir = temp(name);
            let settings = ServerSettings {
                set_up: true,
                port: free_port(),
                data_dir: dir.join("the data").display().to_string(),
                ..ServerSettings::default()
            };
            let supervisor = Supervisor::new(dir.join("unused"), Some(site()), LOGS.clone());
            Bench {
                _one: one,
                dir,
                settings,
                supervisor,
            }
        }

        fn data(&self) -> PathBuf {
            PathBuf::from(&self.settings.data_dir)
        }

        fn origin(&self) -> String {
            format!("http://127.0.0.1:{}", self.settings.port)
        }

        fn start(&self) -> Status {
            let status = self.supervisor.start(&self.settings);
            assert_eq!(status.error, None);
            assert_eq!(status.state, State::Running);
            status
        }

        fn stop(&self) -> Status {
            self.supervisor.stop(&self.settings)
        }

        fn status(&self) -> Status {
            self.supervisor.status(&self.settings)
        }

        fn get(&self, path: &str) -> (u16, String) {
            wait(async {
                let res = reqwest::get(format!("{}{path}", self.origin()))
                    .await
                    .expect("answer");
                (res.status().as_u16(), res.text().await.expect("body"))
            })
        }

        fn register(&self, username: &str) {
            let body = serde_json::json!({
                "username": username,
                "password": "a long enough password",
                "avatar_kind": "identicon",
            });
            let status = wait(async {
                reqwest::Client::new()
                    .post(format!("{}/api/auth/register", self.origin()))
                    .header("content-type", "application/json")
                    .body(body.to_string())
                    .send()
                    .await
                    .expect("register")
                    .status()
            });
            assert_eq!(status.as_u16(), 200);
        }

        fn settled(&self, what: &str, check: impl Fn(&Status) -> bool) -> Status {
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                let status = self.status();
                if check(&status) {
                    return status;
                }
                assert!(std::time::Instant::now() < deadline, "{what}: {status:?}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    impl Drop for Bench {
        fn drop(&mut self) {
            self.supervisor.stop(&self.settings);
            LOGS.close_file();
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    const UP: &str = r#"{"ok":true}"#;

    #[test]
    fn a_server_in_a_folder_with_a_space_starts_stops_and_starts_again() {
        let bench = Bench::new("supervisor restart");
        assert!(bench.settings.data_dir.contains(' '));
        let off = bench.status();
        assert_eq!(off.state, State::Off);
        assert_eq!((off.url, off.listen), (None, None));
        assert!(!bench.supervisor.running());

        let changes = Arc::new(AtomicUsize::new(0));
        let seen = changes.clone();
        bench.supervisor.on_change(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        });

        for round in 0..2 {
            let before = changes.load(Ordering::SeqCst);
            let since = now();
            let status = bench.start();
            assert!(
                status.started.is_some_and(|at| at >= since && at <= now()),
                "{status:?}"
            );
            assert_eq!(status.proposed_port, None);
            assert_eq!(status.url, Some(bench.origin()));
            assert_eq!(
                status.listen,
                Some(format!("127.0.0.1:{}", bench.settings.port))
            );
            assert_eq!(status.schema, Some(rust_next::db::SCHEMA_VERSION));
            assert!(!status.postgres && !status.needs_restart);
            assert!(status.db_bytes.is_some_and(|bytes| bytes > 0));
            assert_eq!(status.data_dir, bench.settings.data_dir);
            assert!(bench.supervisor.running());
            assert!(bench.data().join("rchat.db").is_file());
            // Starting, then Running.
            assert!(
                changes.load(Ordering::SeqCst) >= before + 2,
                "round {round}"
            );
            assert_eq!(bench.get("/api/health"), (200, UP.to_string()));
            assert_eq!(bench.get("/"), (200, HOME.to_string()));
            assert_eq!(bench.get("/s/a/b/"), (200, HOME.to_string()));
            assert_eq!(bench.get("/x.png").0, 404);
            assert_eq!(bench.get("/api/nothing").0, 404);
            assert_ne!(bench.get("/api/nothing").1, HOME);

            let stopped = bench.stop();
            assert_eq!(stopped.state, State::Off);
            assert_eq!((stopped.url, stopped.listen), (None, None));
            assert_eq!(stopped.started, None);
            assert!(!bench.supervisor.running());
            drop(
                TcpListener::bind(("127.0.0.1", bench.settings.port))
                    .expect("the port is free again"),
            );
        }
        assert!(!bench.dir.join("unused").exists());
    }

    // Files of this process open under `dir`, where the system lists them.
    fn open_under(dir: &Path) -> usize {
        match cfg!(target_os = "linux") {
            true => fs::read_dir("/proc/self/fd")
                .into_iter()
                .flatten()
                .flatten()
                .filter(|fd| fs::read_link(fd.path()).is_ok_and(|to| to.starts_with(dir)))
                .count(),
            false => 0,
        }
    }

    #[test]
    fn a_stop_with_a_request_held_open_frees_the_database() {
        use std::io::Write;
        let bench = Bench::new("supervisor held");
        bench.start();
        let mut held =
            std::net::TcpStream::connect(("127.0.0.1", bench.settings.port)).expect("connect");
        held.write_all(
            b"POST /api/auth/register HTTP/1.1\r\nhost: here\r\ncontent-type: application/json\r\ncontent-length: 100000\r\n\r\n{",
        )
        .expect("send");
        std::thread::sleep(Duration::from_millis(500));
        let began = std::time::Instant::now();
        assert_eq!(bench.stop().state, State::Off);
        let took = began.elapsed();
        assert!(took < SHUTDOWN + Duration::from_secs(10), "{took:?}");
        assert_eq!(open_under(&bench.data()), 0);
        // Windows renames no folder with a file open in it.
        let aside = bench.dir.join("aside");
        fs::rename(bench.data(), &aside).expect("the folder is free");
        fs::rename(&aside, bench.data()).expect("back");
        drop(held);
    }

    #[test]
    fn the_log_gets_the_start_up_lines() {
        let bench = Bench::new("supervisor logs");
        let from = LOGS.after(0).next;
        bench.start();
        let listening = format!("Listening on {}", bench.origin());
        let page = LOGS.after(from);
        assert!(
            page.lines.iter().any(|l| l.text.ends_with(&listening)),
            "{page:?}"
        );
        bench.stop();
        let file = fs::read_to_string(bench.data().join("logs").join("server.log")).expect("log");
        assert!(file.contains(&listening), "{file}");
        assert!(file.contains("Server shutdown complete"), "{file}");
    }

    #[test]
    fn starting_twice_keeps_the_one_server() {
        let bench = Bench::new("supervisor twice");
        bench.start();
        assert_eq!(bench.start().state, State::Running);
        assert_eq!(bench.get("/api/health").0, 200);
        assert_eq!(bench.stop().state, State::Off);
        assert_eq!(bench.stop().state, State::Off);
    }

    #[test]
    fn a_taken_port_fails_with_the_port_named() {
        let bench = Bench::new("supervisor port");
        let taken = TcpListener::bind(("127.0.0.1", bench.settings.port)).expect("bind");
        let status = bench.supervisor.start(&bench.settings);
        assert_eq!(status.state, State::Failed);
        assert_eq!(
            status.error,
            Some(format!(
                "Port {} is in use. Pick another port.",
                bench.settings.port
            ))
        );
        assert_eq!(status.url, None);
        assert!(!bench.supervisor.running());
        assert!(!bench.data().join("rchat.db").exists());
        drop(taken);
        assert_eq!(bench.start().state, State::Running);
    }

    #[test]
    fn settings_the_server_refuses_fail_with_its_words() {
        let mut bench = Bench::new("supervisor config");
        bench.settings.extra = "SERVER_PORT=1".into();
        let status = bench.supervisor.start(&bench.settings);
        assert_eq!(status.state, State::Failed);
        assert_eq!(
            status.error.as_deref(),
            Some("Line 1: Set the port in the form above.")
        );
        bench.settings.extra = "RELAY_PORT=many".into();
        let status = bench.supervisor.start(&bench.settings);
        assert_eq!(status.state, State::Failed);
        let error = status.error.expect("error");
        assert!(
            error.is_ascii() && error.to_lowercase().contains("relay_port"),
            "{error}"
        );
        bench.settings.extra = String::new();
        assert_eq!(bench.start().state, State::Running);
        assert_eq!(bench.stop().error, None);
    }

    #[test]
    fn a_folder_that_cannot_be_made_fails_with_the_reason() {
        let mut bench = Bench::new("supervisor folder");
        let file = bench.dir.join("a file");
        fs::write(&file, "x").expect("file");
        bench.settings.data_dir = file.join("under").display().to_string();
        let status = bench.supervisor.start(&bench.settings);
        assert_eq!(status.state, State::Failed);
        let error = status.error.expect("error");
        assert_eq!(error, "The data folder is inside a file. Pick a folder.");
    }

    #[test]
    fn data_from_a_newer_build_is_refused_untouched() {
        let bench = Bench::new("supervisor newer");
        bench.start();
        bench.stop();
        let db = bench.data().join("rchat.db");
        wait(run(
            &db,
            "UPDATE settings SET value = '99999' WHERE key = 'schema_version'",
        ));
        let before = fs::read(&db).expect("read");
        let status = bench.supervisor.start(&bench.settings);
        assert_eq!(status.state, State::Failed);
        assert_eq!(
            status.error.as_deref(),
            Some(
                "This server's data was upgraded by a newer version of the app. Update the app to start it."
            )
        );
        assert_eq!(status.schema, Some(99999));
        assert_eq!(fs::read(&db).expect("read"), before);
        assert!(status.backups.is_empty());
        drop(TcpListener::bind(("127.0.0.1", bench.settings.port)).expect("nothing listens"));
    }

    #[test]
    fn an_older_database_is_backed_up_before_it_is_upgraded() {
        let bench = Bench::new("supervisor older");
        bench.start();
        bench.stop();
        let db = bench.data().join("rchat.db");
        let older = rust_next::db::SCHEMA_VERSION - 1;
        wait(run(
            &db,
            &format!("UPDATE settings SET value = '{older}' WHERE key = 'schema_version'"),
        ));
        let backups = bench.data().join("backups");
        fs::create_dir_all(&backups).expect("folder");
        let old = [1, 2, 3, 4].map(|n| format!("rchat-schema5-20200101-00000{n}.db"));
        for name in &old {
            fs::write(backups.join(name), "old").expect("file");
        }
        let status = bench.start();
        assert_eq!(status.schema, Some(rust_next::db::SCHEMA_VERSION));
        let names: Vec<&str> = status.backups.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names.len(), 3, "{names:?}");
        let made = names
            .iter()
            .find(|n| n.starts_with(&format!("rchat-schema{older}-")))
            .expect("the upgrade backup");
        assert!(names.contains(&old[3].as_str()) && names.contains(&old[2].as_str()));
        assert_eq!(
            wait(value(&backups.join(made), "schema_version")),
            Some(older.to_string())
        );
        bench.stop();
        assert_eq!(
            wait(value(&db, "schema_version")),
            Some(rust_next::db::SCHEMA_VERSION.to_string())
        );
    }

    #[test]
    fn the_first_account_shows_in_the_status() {
        let bench = Bench::new("supervisor accounts");
        assert!(!bench.start().accounts);
        bench.register("Alice");
        bench.settled("the account shows", |s| s.accounts);
        bench.stop();
        assert!(!bench.status().accounts);
        bench.start();
        bench.settled("the account is still there", |s| s.accounts);
    }

    #[test]
    fn a_restore_brings_the_backup_back_and_keeps_what_it_replaced() {
        let bench = Bench::new("supervisor restore");
        bench.start();
        let name = bench.supervisor.backup(&bench.settings).expect("backup");
        assert!(name.starts_with("rchat-2"), "{name}");
        bench.register("Alice");
        bench.settled("the account shows", |s| s.accounts);
        assert_eq!(
            bench
                .status()
                .backups
                .iter()
                .map(|b| b.name.as_str())
                .collect::<Vec<_>>(),
            [name.as_str()]
        );

        let status = bench
            .supervisor
            .restore(&bench.settings, &name)
            .expect("restore");
        assert_eq!(status.state, State::Running);
        assert_eq!(bench.get("/api/health").0, 200);
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!bench.status().accounts);
        // The name is free again: the account went with the restore.
        bench.register("Alice");
        let kept: Vec<String> = bench
            .status()
            .backups
            .into_iter()
            .map(|b| b.name)
            .filter(|n| n.starts_with("rchat-before-restore-"))
            .collect();
        assert_eq!(kept.len(), 1, "{kept:?}");
        bench.stop();
        use sqlx::{ConnectOptions, Connection, Row};
        let users: i64 = wait(async {
            let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(bench.data().join("backups").join(&kept[0]))
                .connect()
                .await
                .expect("open");
            let row = sqlx::query("SELECT COUNT(*) FROM users")
                .fetch_one(&mut conn)
                .await
                .expect("count");
            conn.close().await.expect("close");
            row.get(0)
        });
        assert_eq!(users, 1);

        assert_eq!(
            bench.supervisor.restore(&bench.settings, "../rchat.db"),
            Err("That backup is gone.".to_string())
        );
        assert_eq!(bench.status().state, State::Off);
    }

    #[test]
    fn a_stopped_server_restores_and_stays_stopped() {
        let bench = Bench::new("supervisor restore off");
        bench.start();
        bench.stop();
        let name = bench.supervisor.backup(&bench.settings).expect("backup");
        let status = bench
            .supervisor
            .restore(&bench.settings, &name)
            .expect("restore");
        assert_eq!(status.state, State::Off);
        assert_eq!(status.backups.len(), 2);
    }

    #[test]
    fn a_saved_change_asks_for_a_restart() {
        let bench = Bench::new("supervisor needs restart");
        let mut saved = bench.settings.clone();
        saved.name = "Renamed".into();
        assert!(!bench.supervisor.status(&saved).needs_restart);
        bench.start();
        assert!(!bench.status().needs_restart);
        assert!(bench.supervisor.status(&saved).needs_restart);
        let mut quiet = bench.settings.clone();
        quiet.run_on_open = false;
        quiet.confirm_quit = false;
        assert!(!bench.supervisor.status(&quiet).needs_restart);
        let mut web = bench.settings.clone();
        web.serve_web = false;
        assert!(bench.supervisor.status(&web).needs_restart);
        let restarted = bench.supervisor.restart(&web);
        assert_eq!(restarted.state, State::Running);
        assert!(!restarted.needs_restart);
        assert_eq!(bench.get("/").0, 404);
        assert_eq!(bench.get("/api/health").0, 200);
        bench.stop();
        assert!(!bench.supervisor.status(&saved).needs_restart);
    }

    #[test]
    fn the_tray_gets_the_state_and_whether_a_restart_is_due() {
        let bench = Bench::new("supervisor tray");
        assert_eq!(
            bench.supervisor.tray(&bench.settings),
            tray_menu::Server {
                state: tray_menu::ServerState::Off,
                connections: 0,
                needs_restart: false,
            }
        );
        bench.start();
        assert_eq!(
            bench.supervisor.tray(&bench.settings),
            tray_menu::Server {
                state: tray_menu::ServerState::Running,
                connections: 0,
                needs_restart: false,
            }
        );
        let mut saved = bench.settings.clone();
        saved.port += 1;
        assert_eq!(
            bench.supervisor.tray(&saved),
            tray_menu::Server {
                state: tray_menu::ServerState::Running,
                connections: 0,
                needs_restart: true,
            }
        );
        assert!(bench.supervisor.status(&saved).needs_restart);
    }

    #[test]
    fn setup_is_offered_a_free_port() {
        let bench = Bench::new("supervisor proposed port");
        let mut fresh = bench.settings.clone();
        fresh.set_up = false;
        let offered = bench.supervisor.status(&fresh).proposed_port;
        assert!(
            offered.is_some_and(|port| (3470..=3499).contains(&port)),
            "{offered:?}"
        );
        assert_eq!(bench.status().proposed_port, None);
    }

    #[test]
    fn an_unknown_backup_is_refused_before_the_server_stops() {
        let bench = Bench::new("supervisor restore unknown");
        bench.start();
        let changes = Arc::new(AtomicUsize::new(0));
        let seen = changes.clone();
        bench.supervisor.on_change(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(
            bench.supervisor.restore(&bench.settings, "nope.db"),
            Err("That backup is gone.".to_string())
        );
        assert_eq!(changes.load(Ordering::SeqCst), 0);
        assert_eq!(bench.status().state, State::Running);
    }

    // Other loopback addresses than 127.0.0.1 answer on Linux without any setup.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_listen_address_of_its_own_is_where_this_computer_reaches_the_server() {
        let mut bench = Bench::new("supervisor listen");
        bench.settings.listen = "127.0.0.2".into();
        let status = bench.start();
        let origin = format!("http://127.0.0.2:{}", bench.settings.port);
        assert_eq!(status.url.as_deref(), Some(origin.as_str()));
        let health = wait(async {
            reqwest::get(format!("{origin}/api/health"))
                .await
                .expect("answer")
                .text()
                .await
                .expect("body")
        });
        assert_eq!(health, UP);
        let closed = free_port();
        assert_eq!(
            bench
                .supervisor
                .test_address(&format!("https://127.0.0.1:{closed}")),
            Err(format!("Can't reach 127.0.0.1:{closed}"))
        );
    }

    #[test]
    fn postgres_has_no_file_to_measure_or_back_up() {
        let mut bench = Bench::new("supervisor postgres");
        bench.settings.database_url = "postgres://u:p@127.0.0.1:1/x".into();
        let status = bench.status();
        assert!(status.postgres);
        assert_eq!(status.db_bytes, None);
        assert_eq!(
            bench.supervisor.backup(&bench.settings),
            Err("Back up your Postgres database yourself.".to_string())
        );
        assert_eq!(
            bench.supervisor.restore(&bench.settings, "a.db"),
            Err("Back up your Postgres database yourself.".to_string())
        );
    }

    #[test]
    fn the_folder_changes_only_while_the_server_is_stopped() {
        let bench = Bench::new("supervisor move");
        let to = |name: &str| bench.dir.join(name).display().to_string();
        let moved = |folder: &str, mode| bench.supervisor.move_data(&bench.settings, folder, mode);
        bench.start();
        assert_eq!(
            moved(&to("new"), MoveMode::Move),
            Err("Stop the server to change the folder.".to_string())
        );
        assert!(!bench.dir.join("new").exists());
        bench.stop();
        wait(run(
            &bench.data().join("rchat.db"),
            "INSERT INTO settings(key, value) VALUES('marker', 'moved')",
        ));

        assert_eq!(
            moved("relative", MoveMode::Move),
            Err("The data folder must be a full path.".to_string())
        );
        assert_eq!(
            moved(&to("new"), MoveMode::Use),
            Err("That folder has no server data.".to_string())
        );
        assert_eq!(moved(&to("new"), MoveMode::Move), Ok(()));
        let copy = bench.dir.join("new").join("rchat.db");
        assert_eq!(wait(value(&copy, "marker")).as_deref(), Some("moved"));
        // The files in the folder it left stay.
        assert!(bench.data().join("rchat.db").is_file());
        for mode in [MoveMode::Move, MoveMode::Empty] {
            assert_eq!(
                moved(&to("new"), mode),
                Err("That folder already has server data.".to_string())
            );
        }
        assert_eq!(moved(&to("new"), MoveMode::Use), Ok(()));
        assert_eq!(moved(&to("empty"), MoveMode::Empty), Ok(()));
        assert!(bench.dir.join("empty").is_dir());
        assert!(!bench.dir.join("empty").join("rchat.db").exists());

        let mut there = bench.settings.clone();
        there.data_dir = to("new");
        assert_eq!(bench.supervisor.start(&there).state, State::Running);
        assert_eq!(bench.supervisor.stop(&there).state, State::Off);
        assert_eq!(wait(value(&copy, "marker")).as_deref(), Some("moved"));
    }

    #[test]
    fn moving_with_no_data_yet_just_makes_the_folder() {
        let bench = Bench::new("supervisor move fresh");
        let folder = bench.dir.join("fresh").display().to_string();
        assert_eq!(
            bench
                .supervisor
                .move_data(&bench.settings, &folder, MoveMode::Move),
            Ok(())
        );
        assert!(bench.dir.join("fresh").is_dir());
        assert!(!bench.dir.join("fresh").join("rchat.db").exists());
    }

    #[test]
    fn removing_stops_the_server_and_deletes_its_data_only_when_asked() {
        let bench = Bench::new("supervisor remove");
        bench.start();
        bench.supervisor.backup(&bench.settings).expect("backup");
        assert_eq!(bench.supervisor.remove(&bench.settings, false), Ok(()));
        assert_eq!(bench.status().state, State::Off);
        assert!(bench.data().join("rchat.db").is_file());
        bench.start();
        assert_eq!(bench.supervisor.remove(&bench.settings, true), Ok(()));
        assert_eq!(bench.status().state, State::Off);
        assert!(!bench.data().exists());
    }

    // Answers every request with `body` as JSON.
    fn fake_instance(body: &'static str) -> String {
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("addr"));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut asked = [0; 2048];
                let _ = stream.read(&mut asked);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        origin
    }

    #[test]
    fn an_address_is_tested_against_this_server() {
        let bench = Bench::new("supervisor address");
        assert_eq!(
            bench.supervisor.test_address("https://chat.example.com"),
            Err("Start the server first.".to_string())
        );
        bench.start();
        assert_eq!(
            bench.supervisor.test_address("http://chat.example.com"),
            Err("Enter an address like https://chat.example.com".to_string())
        );
        let probe = |theirs: &str| wait(same_instance(&bench.origin(), theirs));
        assert_eq!(
            probe(&bench.origin()),
            Ok("This address leads to your server.".to_string())
        );
        assert_eq!(
            probe(&fake_instance(r#"{"id":"another one"}"#)),
            Err("That address leads to a different server.".to_string())
        );
        assert_eq!(
            probe(&fake_instance("<html>a router's page</html>")),
            Err("That address leads to a different server.".to_string())
        );
        let closed = format!("http://127.0.0.1:{}", free_port());
        assert_eq!(
            probe(&closed),
            Err(format!(
                "Can't reach {}",
                closed.trim_start_matches("http://")
            ))
        );
    }

    #[test]
    fn https_access_serves_under_its_public_address() {
        let mut bench = Bench::new("supervisor https");
        bench.settings.access = Access {
            mode: AccessMode::Https,
            address: "https://chat.example.com".into(),
            proxy: ProxyHost::Local,
            proxy_device: String::new(),
        };
        let status = bench.supervisor.start(&bench.settings);
        assert_eq!(status.state, State::Running);
        assert_eq!(status.url.as_deref(), Some("https://chat.example.com"));
        assert_eq!(
            status.listen,
            Some(format!("127.0.0.1:{}", bench.settings.port))
        );
        let (code, instance) = bench.get("/api/instance");
        assert_eq!(code, 200);
        assert!(instance.contains("https://chat.example.com"), "{instance}");
    }
}
