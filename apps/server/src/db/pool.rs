use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use sqlx::any::{AnyPoolOptions, install_default_drivers};
use sqlx::{AnyConnection, AnyPool, Row};

use super::migrate::{ConfigChange, ConfigStart, init_schema};
use super::schema::{probe_fts, set_fts, sqlite_search_index};
use super::secrets::{PEPPERS, pepper_with};
use crate::api::controls::{Control, ControlSeeds};
use crate::limits::Limits;

pub type Db = AnyPool;

const SCHEMA_LOCK: i64 = 0x7263_6861_7400;

static READERS: LazyLock<Mutex<HashMap<String, Db>>> = LazyLock::new(Default::default);

static CONFIG_STARTS: LazyLock<Mutex<HashMap<String, ConfigStart>>> =
    LazyLock::new(Default::default);

static LIMITS: LazyLock<Mutex<HashMap<String, Limits>>> = LazyLock::new(Default::default);

/// The databases whose bookkeeping writes wait for the disk (`DATABASE_LIGHT_COMMITS=sync`).
static SYNC_LIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// How bookkeeping writes commit on Postgres (`DATABASE_LIGHT_COMMITS`): `Async` returns
/// before the commit reaches the disk, so a crash can lose the last fraction of a second of
/// them; `Sync` waits like every other write. SQLite ignores it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LightCommits {
    #[default]
    Async,
    Sync,
}

impl LightCommits {
    /// The value of `DATABASE_LIGHT_COMMITS`: `async` when unset or blank.
    pub fn parse(raw: Option<&str>) -> anyhow::Result<LightCommits> {
        let raw = raw.map(str::trim).filter(|v| !v.is_empty());
        match raw.map(str::to_ascii_lowercase).as_deref() {
            None | Some("async") => Ok(LightCommits::Async),
            Some("sync") => Ok(LightCommits::Sync),
            Some(_) => anyhow::bail!(
                "DATABASE_LIGHT_COMMITS: expected async or sync, got {}",
                raw.unwrap_or_default()
            ),
        }
    }
}

/// Marks the transaction `tx` of `db` as bookkeeping that is worth nothing after a crash (a
/// read mark, a last-used time, a login attempt count): on Postgres its commit does not wait
/// for the disk, unless `DATABASE_LIGHT_COMMITS=sync`. Never for messages, moderation,
/// accounts, settings or anything audited.
pub async fn light(db: &Db, tx: &mut AnyConnection) -> sqlx::Result<()> {
    let sync = SYNC_LIGHT
        .lock()
        .is_ok_and(|sync| sync.contains(&pool_key(db)));
    if is_sqlite(db) || sync {
        return Ok(());
    }
    sqlx::query("SET LOCAL synchronous_commit = off")
        .execute(&mut *tx)
        .await
        .map(|_| ())
}

/// What `open_with` reads from the configuration: the limits, `PASSWORD_PEPPER` and the
/// controls the env sets and pins. `controls` is `Some` only for a server start, which brings
/// the stored controls in line with its env. `None` (the default, for tools that open the
/// database without the server's env) leaves the controls and their records as they are.
#[derive(Clone, Default)]
pub struct DbOptions {
    pub limits: Limits,
    pub pepper: Option<String>,
    pub controls: Option<ControlSeeds>,
    pub light_commits: LightCommits,
    /// This process only serves the web app (`RCHAT_ROLES=web`), so one connection is enough.
    pub web_only: bool,
}

impl std::fmt::Debug for DbOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbOptions")
            .field("limits", &self.limits)
            .field("controls", &self.controls)
            .field("light_commits", &self.light_commits)
            .field("web_only", &self.web_only)
            .finish_non_exhaustive()
    }
}

/// What the `open_with` of `db` did to the stored controls. Answers it once.
pub fn take_config_start(db: &Db) -> ConfigStart {
    CONFIG_STARTS
        .lock()
        .ok()
        .and_then(|mut starts| starts.remove(&pool_key(db)))
        .unwrap_or_default()
}

/// The limits `db` was opened with: the server config's for a server start.
pub fn opened_limits(db: &Db) -> Limits {
    LIMITS
        .lock()
        .ok()
        .and_then(|limits| limits.get(&pool_key(db)).cloned())
        .unwrap_or_default()
}

pub fn reader(db: &Db) -> Db {
    READERS
        .lock()
        .ok()
        .and_then(|readers| readers.get(&pool_key(db)).cloned())
        .unwrap_or_else(|| db.clone())
}

pub async fn close(db: &Db) {
    if let Ok(mut peppers) = PEPPERS.lock() {
        peppers.remove(&pool_key(db));
    }
    take_config_start(db);
    if let Ok(mut limits) = LIMITS.lock() {
        limits.remove(&pool_key(db));
    }
    if let Ok(mut sync) = SYNC_LIGHT.lock() {
        sync.remove(&pool_key(db));
    }
    let read = READERS
        .lock()
        .ok()
        .and_then(|mut readers| readers.remove(&pool_key(db)));
    if let Some(read) = read {
        read.close().await;
    }
    db.close().await;
}

pub(crate) fn pool_key(db: &Db) -> String {
    db.connect_options().database_url.to_string()
}

pub fn is_sqlite(db: &Db) -> bool {
    db.connect_options()
        .database_url
        .scheme()
        .starts_with("sqlite")
}

/// A temp database path no other test in any process uses at the same time: the process id,
/// the test's name and a counter.
#[cfg(test)]
pub(crate) fn temp_db_path(tag: &str) -> std::path::PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let test: String = std::thread::current()
        .name()
        .unwrap_or("test")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    std::env::temp_dir().join(format!("rchat_{tag}_{}_{test}_{n}.db", std::process::id()))
}

/// The URL `DATABASE_URL` stands for: itself when it is a URL, else a SQLite file at that path.
fn connect_url(database_url: Option<&str>) -> String {
    match database_url {
        Some(u)
            if u.starts_with("postgres://")
                || u.starts_with("postgresql://")
                || u.starts_with("sqlite:") =>
        {
            u.to_string()
        }
        Some(path) => format!("sqlite://{path}?mode=rwc"),
        None => "sqlite://rchat.db?mode=rwc".to_string(),
    }
}

/// The schema version stored in the database `DATABASE_URL` names, without changing it: `None`
/// when there is no database yet (no SQLite file, or no tables), 0 for one from before versions
/// were stored. A missing SQLite file is not created.
pub async fn stored_schema_version(database_url: Option<&str>) -> anyhow::Result<Option<i64>> {
    use sqlx::Connection;
    install_default_drivers();
    let url = connect_url(database_url);
    let (url, tables) = match url.starts_with("sqlite:") {
        true => {
            let file = url.parse::<sqlx::sqlite::SqliteConnectOptions>()?;
            if !file.get_filename().is_file() {
                return Ok(None);
            }
            let (base, query) = url.split_once('?').unwrap_or((&url, ""));
            let query: Vec<&str> = query
                .split('&')
                .filter(|pair| !pair.is_empty() && !pair.starts_with("mode="))
                .chain(["mode=ro"])
                .collect();
            (
                format!("{base}?{}", query.join("&")),
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
            )
        }
        false => (
            url,
            "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'settings'",
        ),
    };
    let mut conn = sqlx::AnyConnection::connect(&url).await?;
    let version = match sqlx::query(tables).fetch_optional(&mut conn).await? {
        Some(_) => Some(super::migrate::schema_version(&mut conn).await?),
        None => None,
    };
    conn.close().await?;
    Ok(version)
}

/// Whether any account exists. The first one registered manages the instance.
pub async fn has_accounts(db: &Db) -> sqlx::Result<bool> {
    Ok(sqlx::query("SELECT 1 FROM users LIMIT 1")
        .fetch_optional(db)
        .await?
        .is_some())
}

/// Opens the database for a tool: the schema is brought up to date, and the controls and what
/// the server config recorded about them stay untouched.
pub async fn open(database_url: Option<&str>) -> anyhow::Result<Db> {
    open_with(database_url, &DbOptions::default()).await
}

/// Opens the database the way a server with no control in its env starts.
#[cfg(test)]
pub(crate) async fn open_started(database_url: Option<&str>) -> anyhow::Result<Db> {
    let opts = DbOptions {
        controls: Some(ControlSeeds::default()),
        ..DbOptions::default()
    };
    open_with(database_url, &opts).await
}

pub async fn open_with(database_url: Option<&str>, opts: &DbOptions) -> anyhow::Result<Db> {
    let DbOptions {
        limits,
        pepper,
        controls,
        light_commits,
        web_only,
    } = opts;
    install_default_drivers();
    let url = connect_url(database_url);
    let is_sqlite = url.starts_with("sqlite:");
    let max = limits.database_max_connections;
    if is_sqlite && max.is_some_and(|n| n != 1) {
        tracing::warn!(
            "DATABASE_MAX_CONNECTIONS is ignored for sqlite: it has a single writer; use DATABASE_READ_CONNECTIONS for reads"
        );
    }
    let postgres_only: Vec<&str> = [
        (
            "DATABASE_INDEX_BUILD_MIB",
            limits.database_index_build_mib != Limits::default().database_index_build_mib,
        ),
        (
            "DATABASE_LIGHT_COMMITS",
            *light_commits != LightCommits::default(),
        ),
        (
            "DATABASE_STATEMENT_TIMEOUT_SECS",
            limits.database_statement_timeout_secs
                != Limits::default().database_statement_timeout_secs,
        ),
    ]
    .into_iter()
    .filter(|(_, set)| *set)
    .map(|(name, _)| name)
    .collect();
    if is_sqlite && !postgres_only.is_empty() {
        tracing::warn!("{} ignored for sqlite", postgres_only.join(", "));
    }
    let writers = match web_only {
        true => 1,
        false => writer_connections(is_sqlite, max),
    };
    let mut options = pool_options(writers, limits.acquire_timeout_secs());
    if let Some(min) = limits.database_min_connections {
        options = options.min_connections(min.min(writers));
    }
    let session: Vec<String> = match is_sqlite {
        true => [
            "PRAGMA journal_mode=WAL",
            "PRAGMA foreign_keys=ON",
            "PRAGMA busy_timeout=5000",
            "PRAGMA synchronous=NORMAL",
            "PRAGMA mmap_size=268435456",
        ]
        .map(str::to_string)
        .to_vec(),
        false => match limits.database_statement_timeout_secs {
            0 => Vec::new(),
            secs => vec![format!("SET statement_timeout = '{secs}s'")],
        },
    };
    let pool = on_connect(options, session).connect(&url).await?;
    if let Ok(mut sync) = SYNC_LIGHT.lock() {
        match light_commits {
            LightCommits::Sync => sync.insert(pool_key(&pool)),
            LightCommits::Async => sync.remove(&pool_key(&pool)),
        };
    }
    let mut tx = pool.begin().await?;
    no_statement_limit(&mut tx).await?;
    if !is_sqlite {
        sqlx::query("SELECT COUNT(*) FROM pg_advisory_xact_lock($1)")
            .bind(SCHEMA_LOCK)
            .execute(&mut *tx)
            .await?;
    }
    let started = init_schema(&mut tx, is_sqlite, controls.as_ref()).await?;
    tx.commit().await?;
    for ConfigChange {
        key,
        from,
        to,
        flips,
    } in &started.changes
    {
        let Some(control) = Control::find(key) else {
            continue;
        };
        let env = control.env;
        tracing::info!(
            "server config: {env} changed {key} from {} to {}",
            control.shown(from),
            control.shown(to)
        );
        if *flips {
            tracing::warn!(
                "{env} had another value at a start in the last 10 minutes. Copies started with different values change {key} at each start"
            );
        }
    }
    for key in &started.forgotten {
        let env = Control::find(key).map_or(*key, |c| c.env);
        tracing::warn!(
            "{env} is not set at this start, and a start in the last 10 minutes set it. Start every copy with the same settings"
        );
    }
    if let Ok(mut map) = CONFIG_STARTS.lock() {
        map.insert(pool_key(&pool), started);
    }
    if let Ok(mut map) = LIMITS.lock() {
        map.insert(pool_key(&pool), limits.clone());
    }
    match is_sqlite {
        true => {
            if let Err(e) = sqlite_search_index(&pool).await {
                tracing::warn!("FTS5 trigram unavailable, search falls back to LIKE: {e}");
            }
            set_fts(&pool, probe_fts(&pool).await);
            let in_memory = url.contains(":memory:") || url.contains("mode=memory");
            let readers = match in_memory {
                true => 0,
                false => limits.database_read_connections.unwrap_or_else(|| {
                    std::thread::available_parallelism()
                        .map(|n| n.get() as u32)
                        .unwrap_or(4)
                        .clamp(2, 8)
                }),
            };
            if readers > 0 {
                let read = open_reader(&url, readers, limits.acquire_timeout_secs()).await?;
                if let Ok(mut map) = READERS.lock() {
                    map.insert(pool_key(&pool), read);
                }
            }
        }
        false => set_fts(&pool, false),
    }
    pepper_with(&pool, pepper.as_deref()).await?;
    Ok(pool)
}

pub fn writer_connections(is_sqlite: bool, configured: Option<u32>) -> u32 {
    match (is_sqlite, configured) {
        (true, _) => 1,
        (false, Some(n)) => n,
        (false, None) => 8,
    }
}

fn pool_options(max: u32, acquire_timeout_secs: u64) -> AnyPoolOptions {
    AnyPoolOptions::new()
        .max_connections(max)
        .acquire_timeout(Duration::from_secs(acquire_timeout_secs))
}

/// `options` with `session` run on every new connection.
fn on_connect(options: AnyPoolOptions, session: Vec<String>) -> AnyPoolOptions {
    let session = std::sync::Arc::new(session);
    options.after_connect(move |conn, _| {
        let session = std::sync::Arc::clone(&session);
        Box::pin(async move {
            for stmt in session.iter() {
                sqlx::query(sqlx::AssertSqlSafe(stmt.clone()))
                    .execute(&mut *conn)
                    .await?;
            }
            Ok(())
        })
    })
}

async fn open_reader(url: &str, max: u32, acquire_timeout_secs: u64) -> anyhow::Result<Db> {
    let session = [
        "PRAGMA busy_timeout=5000",
        "PRAGMA query_only=ON",
        "PRAGMA mmap_size=268435456",
    ]
    .map(str::to_string)
    .to_vec();
    Ok(on_connect(pool_options(max, acquire_timeout_secs), session)
        .connect(url)
        .await?)
}

/// Lifts `DATABASE_STATEMENT_TIMEOUT_SECS` for the transaction `tx`: the schema init, purges,
/// sweeps and bulk delete batches may run longer than a request. Does nothing on SQLite.
pub async fn no_statement_limit(tx: &mut AnyConnection) -> sqlx::Result<()> {
    if tx.backend_name() == "PostgreSQL" {
        sqlx::query("SET LOCAL statement_timeout = 0")
            .execute(&mut *tx)
            .await?;
    }
    Ok(())
}

/// What the Postgres connection limit leaves for more copies of this process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConnectionBudget {
    /// This process's pool size.
    pub pool: u32,
    /// `max_connections` without `superuser_reserved_connections`.
    pub allowed: i64,
    /// Client connections open now, this process's included.
    pub used: i64,
}

impl ConnectionBudget {
    /// How many more copies with the same pool fit once this one and every open connection of
    /// the others are counted in full.
    pub fn room(&self) -> i64 {
        let ConnectionBudget {
            pool,
            allowed,
            used,
        } = *self;
        let pool = i64::from(pool.max(1));
        ((allowed - (used - 1).max(0) - pool) / pool).max(0)
    }

    /// Under two more copies fit: worth a warning.
    pub fn tight(&self) -> bool {
        self.room() < 2
    }

    pub fn message(&self) -> String {
        let ConnectionBudget {
            pool,
            allowed,
            used,
        } = *self;
        format!(
            "A pool of {pool} database connections leaves room for {} more copies like this one ({used} of {allowed} Postgres connections in use)",
            self.room()
        )
    }
}

/// The connection budget of the Postgres behind `db`, `None` on SQLite.
pub async fn connection_budget(db: &Db) -> sqlx::Result<Option<ConnectionBudget>> {
    if is_sqlite(db) {
        return Ok(None);
    }
    let row = sqlx::query("SELECT CAST(current_setting('max_connections') AS BIGINT) - CAST(current_setting('superuser_reserved_connections') AS BIGINT), (SELECT COUNT(*) FROM pg_stat_activity WHERE backend_type = 'client backend')")
        .fetch_one(db)
        .await?;
    Ok(Some(ConnectionBudget {
        pool: db.options().get_max_connections(),
        allowed: row.try_get(0)?,
        used: row.try_get(1)?,
    }))
}

#[cfg(test)]
mod tests;
