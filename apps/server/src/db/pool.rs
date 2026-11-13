use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use sqlx::AnyPool;
use sqlx::any::{AnyPoolOptions, install_default_drivers};

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

/// What `open_with` reads from the configuration: the limits, `PASSWORD_PEPPER` and the
/// controls the env sets and pins. `controls` is `Some` only for a server start, which brings
/// the stored controls in line with its env. `None` (the default, for tools that open the
/// database without the server's env) leaves the controls and their records as they are.
#[derive(Clone, Default)]
pub struct DbOptions {
    pub limits: Limits,
    pub pepper: Option<String>,
    pub controls: Option<ControlSeeds>,
}

impl std::fmt::Debug for DbOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbOptions")
            .field("limits", &self.limits)
            .field("controls", &self.controls)
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
    if is_sqlite && limits.database_index_build_mib != Limits::default().database_index_build_mib {
        tracing::warn!("DATABASE_INDEX_BUILD_MIB is ignored for sqlite");
    }
    let mut options = pool_options(
        writer_connections(is_sqlite, max),
        limits.database_acquire_timeout_secs,
    );
    if let Some(min) = limits.database_min_connections {
        options = options.min_connections(min);
    }
    let pragmas: &'static [&'static str] = match is_sqlite {
        true => &[
            "PRAGMA journal_mode=WAL",
            "PRAGMA foreign_keys=ON",
            "PRAGMA busy_timeout=5000",
            "PRAGMA synchronous=NORMAL",
            "PRAGMA mmap_size=268435456",
        ],
        false => &[],
    };
    let pool = with_pragmas(options, pragmas).connect(&url).await?;
    let mut tx = pool.begin().await?;
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
                let read = open_reader(&url, readers, limits.database_acquire_timeout_secs).await?;
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

fn pool_options(max: u32, acquire_timeout_secs: Option<u64>) -> AnyPoolOptions {
    let options = AnyPoolOptions::new().max_connections(max);
    match acquire_timeout_secs {
        Some(secs) => options.acquire_timeout(Duration::from_secs(secs)),
        None => options,
    }
}

fn with_pragmas(options: AnyPoolOptions, pragmas: &'static [&'static str]) -> AnyPoolOptions {
    options.after_connect(move |conn, _| {
        Box::pin(async move {
            for pragma in pragmas {
                sqlx::query(*pragma).execute(&mut *conn).await?;
            }
            Ok(())
        })
    })
}

async fn open_reader(url: &str, max: u32, acquire_timeout_secs: Option<u64>) -> anyhow::Result<Db> {
    let pragmas = &[
        "PRAGMA busy_timeout=5000",
        "PRAGMA query_only=ON",
        "PRAGMA mmap_size=268435456",
    ];
    Ok(
        with_pragmas(pool_options(max, acquire_timeout_secs), pragmas)
            .connect(url)
            .await?,
    )
}
