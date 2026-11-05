use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use super::now;
use super::pool::{Db, pool_key};
use super::sweep::guest_grant_ttl;

const TOUCH_EVERY: Duration = Duration::from_secs(60);
const TOUCH_MAX: usize = 100_000;

type Touched = HashMap<(String, String, String), Instant>;

static TOUCHED: LazyLock<Mutex<Touched>> = LazyLock::new(Default::default);

fn recently_touched(db: &Db, server: &str, username: &str) -> bool {
    let key = (pool_key(db), server.to_string(), username.to_string());
    let Ok(mut map) = TOUCHED.lock() else {
        return false;
    };
    if map.get(&key).is_some_and(|at| at.elapsed() < TOUCH_EVERY) {
        return true;
    }
    if map.len() >= TOUCH_MAX {
        map.retain(|_, at| at.elapsed() < TOUCH_EVERY);
        if map.len() >= TOUCH_MAX {
            map.clear();
        }
    }
    map.insert(key, Instant::now());
    false
}

pub async fn touch_interaction(db: &Db, server: &str, username: &str) -> sqlx::Result<()> {
    if recently_touched(db, server, username) {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO interactions(server, username, last_at) VALUES($1, $2, $3) ON CONFLICT(server, username) DO UPDATE SET last_at = excluded.last_at",
    )
    .bind(server)
    .bind(username)
    .bind(now())
    .execute(db)
    .await
    .map(|_| ())
}

pub const GRANT_TOUCH_SECS: i64 = 86400;

static GRANT_TOUCHES: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(Default::default);

pub const GRANT_TOUCHES_MAX: usize = 10_000;

#[cfg(test)]
pub(crate) fn grant_touch_queued(db: &Db, grant: &str) -> bool {
    GRANT_TOUCHES
        .lock()
        .ok()
        .and_then(|touches| touches.get(&pool_key(db)).map(|set| set.contains(grant)))
        .unwrap_or(false)
}

pub fn queue_grant_touches(db: &Db, grants: impl IntoIterator<Item = String>) {
    if let Ok(mut touches) = GRANT_TOUCHES.lock() {
        let queued = touches.entry(pool_key(db)).or_default();
        for grant in grants {
            if queued.len() >= GRANT_TOUCHES_MAX {
                break;
            }
            queued.insert(grant);
        }
    }
}

pub async fn flush_grant_touches(db: &Db) -> sqlx::Result<u64> {
    let grants: Vec<String> = GRANT_TOUCHES
        .lock()
        .ok()
        .and_then(|mut touches| touches.remove(&pool_key(db)))
        .map(|set| set.into_iter().collect())
        .unwrap_or_default();
    let t = now();
    let cutoff = t - guest_grant_ttl(db);
    let mut total = 0;
    for (i, chunk) in grants.chunks(100).enumerate() {
        let sql = format!(
            "UPDATE guest_grants SET last_used_at = $1 WHERE last_used_at <= $2 AND (last_used_at >= $3 OR (last_used_at = 0 AND created_at >= $3)) AND \"grant\" IN ({})",
            (0..chunk.len())
                .map(|i| format!("${}", i + 4))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(t)
            .bind(t - GRANT_TOUCH_SECS)
            .bind(cutoff);
        for grant in chunk {
            query = query.bind(grant);
        }
        match query.execute(db).await {
            Ok(done) => total += done.rows_affected(),
            Err(e) => {
                queue_grant_touches(db, grants.chunks(100).skip(i).flatten().cloned());
                return Err(e);
            }
        }
    }
    Ok(total)
}
