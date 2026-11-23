use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::join_all;
use sqlx::Row;
use tokio::time::Instant;

use super::{Db, SCHEMA_VERSION};
use crate::api::ApiError;
use crate::limits::Limits;

#[derive(Clone, Copy, Default)]
struct Sample {
    checked: Option<Instant>,
    healthy: bool,
    lag_ms: Option<i64>,
}

impl Sample {
    fn available(self) -> bool {
        self.healthy
            && self
                .checked
                .is_some_and(|at| at.elapsed() < Duration::from_secs(3))
    }
}

struct Replica {
    pool: Db,
    host: String,
    sample: Mutex<Sample>,
}

#[derive(serde::Serialize)]
pub(crate) struct ReplicaStatus {
    host: String,
    healthy: bool,
    lag_ms: Option<i64>,
}

#[derive(Default)]
pub(crate) struct Replicas {
    entries: Vec<Replica>,
    next: Mutex<usize>,
}

impl Replicas {
    pub(crate) fn open(urls: &[url::Url], limits: &Limits) -> anyhow::Result<Self> {
        let mut entries = Vec::with_capacity(urls.len());
        for url in urls {
            let pool = super::pool::replica_pool(url, limits)?;
            entries.push(Replica {
                pool,
                host: format!(
                    "{}:{}{}",
                    url.host_str().unwrap_or_default(),
                    url.port().unwrap_or(5432),
                    url.path()
                ),
                sample: Mutex::default(),
            });
        }
        Ok(Self {
            entries,
            next: Mutex::new(0),
        })
    }

    pub(crate) async fn monitor(self: Arc<Self>, instance_id: String, max_lag: u64) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            join_all(self.entries.iter().map(|entry| async {
                let result = tokio::time::timeout(
                    Duration::from_secs(1),
                    probe(&entry.pool, &instance_id, max_lag),
                )
                .await;
                let sample = result.ok().and_then(Result::ok).unwrap_or_default();
                let mut last = entry.sample.lock().unwrap();
                if !sample.healthy && (last.checked.is_none() || last.healthy) {
                    tracing::warn!(host = %entry.host, lag_ms = sample.lag_ms, "read replica unavailable");
                }
                *last = Sample {
                    checked: Some(Instant::now()),
                    ..sample
                };
            }))
            .await;
        }
    }

    pub(crate) fn status(&self) -> Vec<ReplicaStatus> {
        self.entries
            .iter()
            .map(|r| {
                let sample = *r.sample.lock().unwrap();
                ReplicaStatus {
                    host: r.host.clone(),
                    healthy: sample.available(),
                    lag_ms: sample.lag_ms,
                }
            })
            .collect()
    }

    fn choose(&self) -> Option<&Replica> {
        let n = self.entries.len();
        if n == 0 {
            return None;
        }
        let mut next = self.next.lock().unwrap();
        let selected = (0..n)
            .map(|offset| (*next + offset) % n)
            .find(|&index| self.entries[index].sample.lock().unwrap().available())?;
        *next = (selected + 1) % n;
        Some(&self.entries[selected])
    }

    pub(crate) async fn read<'a, T, F>(
        &'a self,
        current: &'a Db,
        operation: impl Fn(&'a Db) -> F,
    ) -> Result<T, ApiError>
    where
        F: Future<Output = Result<T, ApiError>>,
    {
        if let Some(replica) = self.choose() {
            // The query can include visibility, author deletion and history predicates. A recent
            // health sample alone does not guarantee that a committed change has reached it.
            let wal = sqlx::query_scalar::<_, String>("SELECT pg_current_wal_insert_lsn()::text")
                .fetch_one(current)
                .await;
            let Ok(wal) = wal else {
                return operation(current).await;
            };
            let replayed = sqlx::query_scalar::<_, i64>("SELECT CASE WHEN pg_is_in_recovery() AND pg_last_wal_replay_lsn() >= $1::text::pg_lsn THEN 1 ELSE 0 END::bigint")
                .bind(wal).fetch_one(&replica.pool).await;
            match replayed {
                Ok(1) => match operation(&replica.pool).await {
                    Err(e) if e.failed() => replica.sample.lock().unwrap().healthy = false,
                    answer => return answer,
                },
                Ok(_) => {}
                Err(_) => replica.sample.lock().unwrap().healthy = false,
            }
        }
        operation(current).await
    }
}

async fn probe(pool: &Db, instance: &str, max_lag: u64) -> sqlx::Result<Sample> {
    let row = sqlx::query(
        "SELECT CASE WHEN pg_is_in_recovery()
        AND (SELECT value FROM settings WHERE key='instance_id') = $1
        AND (SELECT value FROM settings WHERE key='schema_version') = $2 THEN 1 ELSE 0 END::bigint,
        CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
        ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()) * 1000 END::bigint",
    )
    .bind(instance)
    .bind(SCHEMA_VERSION.to_string())
    .fetch_one(pool)
    .await?;
    let lag_ms: Option<i64> = row.try_get(1)?;
    Ok(Sample {
        checked: Some(Instant::now()),
        lag_ms,
        healthy: row.try_get::<i64, _>(0)? == 1
            && lag_ms.is_some_and(|lag| (0..=max_lag as i64).contains(&lag)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn replica_urls_require_postgres_and_are_bounded() {
        for value in ["sqlite:///tmp/db", "", "postgres://one/db,"] {
            assert!(
                AppConfig::from_map(&[
                    ("DATABASE_URL", "postgres://primary/db"),
                    ("DATABASE_REPLICA_URLS", value)
                ])
                .unwrap_err()
                .to_string()
                .contains("DATABASE_REPLICA_URLS")
            );
        }
        assert!(AppConfig::from_map(&[("DATABASE_REPLICA_URLS", "postgres://one/db")]).is_err());
        let many = ["postgres://one/db"; 17].join(",");
        assert!(
            AppConfig::from_map(&[
                ("DATABASE_URL", "postgres://primary/db"),
                ("DATABASE_REPLICA_URLS", many.as_str())
            ])
            .is_err()
        );
    }

    #[tokio::test]
    async fn physical_replica_routes_reads_and_retries_failed_queries_on_the_primary() {
        let Ok(replica) = std::env::var("TEST_POSTGRES_REPLICA_URL") else {
            return;
        };
        let (state, temp) = crate::api::test_util::pg_state("replica_route")
            .await
            .expect("test primary");
        let mut url = url::Url::parse(&replica).expect("test standby address");
        url.set_path(url::Url::parse(&temp.url).unwrap().path());
        let replicas = Replicas::open(&[url], &Limits::default()).unwrap();
        let entry = &replicas.entries[0];
        let instance = &state.instance.id;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Ok(sample) = probe(&entry.pool, instance, 2000).await
                    && sample.available()
                {
                    *entry.sample.lock().unwrap() = sample;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("standby replay");
        assert!(
            !probe(&entry.pool, "different-instance", 2000)
                .await
                .unwrap()
                .healthy
        );
        let recovery = async |db: &Db| {
            Ok(sqlx::query_scalar::<_, bool>("SELECT pg_is_in_recovery()")
                .fetch_one(db)
                .await?)
        };
        // Background WAL can temporarily put an otherwise healthy standby behind the fence.
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                *entry.sample.lock().unwrap() = probe(&entry.pool, instance, 2000).await.unwrap();
                if replicas.read(&state.db, recovery).await.unwrap() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("read from the standby");
        let attempts = AtomicUsize::new(0);
        let read = async |db: &Db| {
            attempts.fetch_add(1, Ordering::Relaxed);
            let value: i64 = sqlx::query_scalar(
                "SELECT 1::bigint / CASE WHEN pg_is_in_recovery() THEN 0 ELSE 1 END",
            )
            .fetch_one(db)
            .await?;
            Ok(value)
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                attempts.store(0, Ordering::Relaxed);
                *entry.sample.lock().unwrap() = probe(&entry.pool, instance, 2000).await.unwrap();
                assert_eq!(replicas.read(&state.db, read).await.unwrap(), 1);
                if attempts.load(Ordering::Relaxed) == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("failed replica query retried once");
        assert!(replicas.choose().is_none());
        entry.pool.close().await;
        *entry.sample.lock().unwrap() = Sample {
            checked: Some(Instant::now()),
            healthy: true,
            lag_ms: Some(0),
        };
        assert!(!replicas.read(&state.db, recovery).await.unwrap());
        assert!(replicas.choose().is_none());
        crate::api::test_util::pg_done(state, temp).await;
    }

    #[tokio::test]
    async fn healthy_replicas_rotate_and_stale_samples_expire() {
        sqlx::any::install_default_drivers();
        let urls = [
            "postgres://someone:secret@one/db?sslmode=disable",
            "postgres://off/db",
            "postgres://two/db",
        ]
        .map(|s| url::Url::parse(s).unwrap());
        let set = Replicas::open(&urls, &Limits::default()).unwrap();
        assert!(set.choose().is_none());
        for r in &set.entries {
            *r.sample.lock().unwrap() = Sample {
                checked: Some(Instant::now()),
                healthy: true,
                lag_ms: Some(0),
            };
        }
        set.entries[1].sample.lock().unwrap().healthy = false;
        for _ in 0..3 {
            assert_eq!(set.choose().unwrap().host, "one:5432/db");
            assert_eq!(set.choose().unwrap().host, "two:5432/db");
        }
        set.entries[0].sample.lock().unwrap().checked =
            Instant::now().checked_sub(Duration::from_secs(4));
        assert_eq!(set.choose().unwrap().host, "two:5432/db");
    }
}
