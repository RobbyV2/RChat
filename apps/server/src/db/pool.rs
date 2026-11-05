use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use sqlx::AnyPool;
use sqlx::any::{AnyPoolOptions, install_default_drivers};

use super::migrate::init_schema;
use super::schema::{postgres_search_index, probe_fts, set_fts, sqlite_search_index};
use super::secrets::{PEPPERS, pepper};

pub type Db = AnyPool;

const SCHEMA_LOCK: i64 = 0x7263_6861_7400;

static READERS: LazyLock<Mutex<HashMap<String, Db>>> = LazyLock::new(Default::default);

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

pub(super) fn env_num<T: std::str::FromStr>(key: &str) -> Option<T> {
    std::env::var(key).ok().and_then(|v| v.trim().parse().ok())
}

pub async fn open(database_url: Option<&str>) -> anyhow::Result<Db> {
    install_default_drivers();
    let url = match database_url {
        Some(u)
            if u.starts_with("postgres://")
                || u.starts_with("postgresql://")
                || u.starts_with("sqlite:") =>
        {
            u.to_string()
        }
        Some(path) => format!("sqlite://{path}?mode=rwc"),
        None => "sqlite://rchat.db?mode=rwc".to_string(),
    };
    let is_sqlite = url.starts_with("sqlite:");
    let max = env_num::<u32>("DATABASE_MAX_CONNECTIONS");
    if is_sqlite && max.is_some_and(|n| n != 1) {
        tracing::warn!(
            "DATABASE_MAX_CONNECTIONS is ignored for sqlite: it has a single writer; use DATABASE_READ_CONNECTIONS for reads"
        );
    }
    let mut options = pool_options(writer_connections(is_sqlite, max));
    if let Some(min) = env_num("DATABASE_MIN_CONNECTIONS") {
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
    init_schema(&mut tx, is_sqlite).await?;
    if !is_sqlite {
        postgres_search_index(&mut tx).await;
    }
    tx.commit().await?;
    match is_sqlite {
        true => {
            if let Err(e) = sqlite_search_index(&pool).await {
                tracing::warn!("FTS5 trigram unavailable, search falls back to LIKE: {e}");
            }
            set_fts(&pool, probe_fts(&pool).await);
            let in_memory = url.contains(":memory:") || url.contains("mode=memory");
            let readers = match in_memory {
                true => 0,
                false => env_num("DATABASE_READ_CONNECTIONS").unwrap_or_else(|| {
                    std::thread::available_parallelism()
                        .map(|n| n.get() as u32)
                        .unwrap_or(4)
                        .clamp(2, 8)
                }),
            };
            if readers > 0 {
                let read = open_reader(&url, readers).await?;
                if let Ok(mut map) = READERS.lock() {
                    map.insert(pool_key(&pool), read);
                }
            }
        }
        false => set_fts(&pool, false),
    }
    pepper(&pool).await?;
    Ok(pool)
}

pub fn writer_connections(is_sqlite: bool, configured: Option<u32>) -> u32 {
    match (is_sqlite, configured) {
        (true, _) => 1,
        (false, Some(n)) => n,
        (false, None) => 8,
    }
}

fn pool_options(max: u32) -> AnyPoolOptions {
    let options = AnyPoolOptions::new().max_connections(max);
    match env_num("DATABASE_ACQUIRE_TIMEOUT_SECS") {
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

async fn open_reader(url: &str, max: u32) -> anyhow::Result<Db> {
    let pragmas = &[
        "PRAGMA busy_timeout=5000",
        "PRAGMA query_only=ON",
        "PRAGMA mmap_size=268435456",
    ];
    Ok(with_pragmas(pool_options(max), pragmas)
        .connect(url)
        .await?)
}
