use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use redis::aio::ConnectionManager;

use crate::db::pool_key;
use crate::limits::bucket::{Keyed, Policy};
use crate::state::AppState;
use crate::ws::LogGate;

/// Takes `ARGV[4]` from the bucket at `KEYS[1]` by the Redis server's clock. `ARGV[1]` is the
/// kind (`t` tokens, `w` window), `ARGV[2]` the full bucket and `ARGV[3]` the refill per
/// millisecond or the window in milliseconds. It answers 0 when the cost is taken, else the
/// milliseconds until it can be. A key lives until its bucket is full again.
const TAKE: &str = "
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local kind, full, pace, cost = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local held = redis.call('HMGET', KEYS[1], 'at', 'used')
local at, used = tonumber(held[1]) or now, tonumber(held[2]) or 0
if kind == 't' then
  if now > at then
    used = math.max(0, used - (now - at) * pace)
    at = now
  end
  if used + cost > full then
    return math.max(1, math.ceil((used + cost - full) / pace))
  end
  used = used + cost
  redis.call('HSET', KEYS[1], 'at', at, 'used', tostring(used))
  redis.call('PEXPIRE', KEYS[1], math.ceil(used / pace) + 1000)
  return 0
end
if used <= 0 or now - at >= pace then
  at, used = now, 0
end
if used + cost > full then
  return math.max(1, at + pace - now)
end
used = used + cost
redis.call('HSET', KEYS[1], 'at', at, 'used', tostring(used))
redis.call('PEXPIREAT', KEYS[1], at + pace + 1000)
return 0
";

/// How long limits count in this process after Redis did not answer, before Redis is asked
/// again.
const SKIP_AFTER_MISS: Duration = Duration::from_secs(5);

/// Buckets in Redis, counted together by every copy that uses the same Redis and prefix.
#[derive(Clone)]
pub struct Shared {
    conn: ConnectionManager,
    prefix: Arc<str>,
    skip_until: Arc<Mutex<Option<Instant>>>,
}

impl Shared {
    pub fn new(conn: ConnectionManager, prefix: &str) -> Shared {
        Shared {
            conn,
            prefix: Arc::from(prefix),
            skip_until: Arc::default(),
        }
    }

    fn skip_until(&self) -> std::sync::MutexGuard<'_, Option<Instant>> {
        self.skip_until.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Takes `cost` from the bucket `key` under `policy`. `Err` inside is the wait until it
    /// holds `cost`.
    pub async fn take(
        &self,
        key: &str,
        policy: Policy,
        cost: f64,
    ) -> redis::RedisResult<Result<(), Duration>> {
        let (kind, full, pace) = match policy {
            Policy::Tokens { burst, per_sec } => ("t", burst, per_sec / 1000.0),
            Policy::Window { limit, window } => ("w", f64::from(limit), window.as_millis() as f64),
        };
        let mut conn = self.conn.clone();
        let wait: i64 = redis::cmd("EVAL")
            .arg(TAKE)
            .arg(1)
            .arg(format!("{}:rate:{key}", self.prefix))
            .arg(kind)
            .arg(full)
            .arg(pace)
            .arg(cost)
            .query_async(&mut conn)
            .await?;
        Ok(match wait {
            ..=0 => Ok(()),
            ms => Err(Duration::from_millis(ms as u64)),
        })
    }

    /// Like `take`, but `None` when Redis does not answer: the caller then counts in this
    /// process. After a miss, Redis is not asked for `SKIP_AFTER_MISS`, so requests don't wait
    /// on a Redis that is down. The miss is logged, at most once a minute.
    pub async fn try_take(
        &self,
        key: &str,
        policy: Policy,
        cost: f64,
    ) -> Option<Result<(), Duration>> {
        if self
            .skip_until()
            .is_some_and(|until| Instant::now() < until)
        {
            return None;
        }
        match self.take(key, policy, cost).await {
            Ok(answer) => Some(answer),
            Err(e) => {
                *self.skip_until() = Some(Instant::now() + SKIP_AFTER_MISS);
                if FELL_BACK.admit(tokio::time::Instant::now()) {
                    tracing::warn!("a limit counted in this process: Redis did not answer: {e}");
                }
                None
            }
        }
    }
}

static FELL_BACK: LogGate = LogGate::new(Duration::from_secs(60), |n| {
    tracing::warn!("{n} more limits counted in this process while Redis did not answer")
});

/// A limit with one bucket per key, counted in Redis across copies when the instance has one,
/// and in this process otherwise or while Redis does not answer.
pub struct Rate {
    name: &'static str,
    local: Keyed,
}

impl Rate {
    /// A limit named `name` in Redis, whose policy comes with each use.
    pub fn new(name: &'static str, max_keys: usize) -> Rate {
        let none = Policy::Tokens {
            burst: 0.0,
            per_sec: 0.0,
        };
        Rate {
            name,
            local: Keyed::new(none, max_keys),
        }
    }

    /// Takes `cost` from `key`'s bucket under `policy`. `Err` is the wait until it holds `cost`.
    pub async fn take(
        &self,
        state: &AppState,
        key: &str,
        policy: Policy,
        cost: f64,
    ) -> Result<(), Duration> {
        let shared = state.bus.as_ref().map(crate::bus::Bus::shared);
        self.take_in(&pool_key(&state.db), shared.as_ref(), key, policy, cost)
            .await
    }

    async fn take_in(
        &self,
        pool: &str,
        shared: Option<&Shared>,
        key: &str,
        policy: Policy,
        cost: f64,
    ) -> Result<(), Duration> {
        if let Some(shared) = shared
            && let Some(answer) = shared
                .try_take(&format!("{}:{key}", self.name), policy, cost)
                .await
        {
            return answer;
        }
        self.local
            .under(policy)
            .try_take(&format!("{pool}\n{key}"), cost, Instant::now())
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(burst: f64, per_sec: f64) -> Policy {
        Policy::Tokens { burst, per_sec }
    }

    async fn manager(url: &str) -> ConnectionManager {
        let config = redis::aio::ConnectionManagerConfig::new()
            .set_connection_timeout(Some(Duration::from_secs(2)))
            .set_response_timeout(Some(Duration::from_secs(2)))
            .set_number_of_retries(0);
        redis::Client::open(url)
            .expect("url")
            .get_connection_manager_lazy(config)
            .expect("manager")
    }

    #[tokio::test]
    async fn redis_down_falls_back_to_local() {
        let down = Shared::new(manager("redis://127.0.0.1:1").await, "rchat-test");
        assert!(down.take("k", tokens(2.0, 0.001), 1.0).await.is_err());
        let rate = Rate::new("test", 10);
        let take = || rate.take_in("pool", Some(&down), "alice", tokens(2.0, 0.001), 1.0);
        assert_eq!(take().await, Ok(()));
        assert_eq!(take().await, Ok(()));
        assert!(
            take().await.is_err(),
            "this process counts while Redis is down"
        );
        assert_eq!(
            rate.take_in("pool", None, "bob", tokens(2.0, 0.001), 1.0)
                .await,
            Ok(()),
            "without Redis the same buckets count"
        );
    }

    #[tokio::test]
    async fn a_redis_that_does_not_answer_is_skipped_for_a_while() {
        let silent = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = silent.local_addr().expect("addr");
        let held = tokio::spawn(async move {
            let mut open = Vec::new();
            while let Ok((socket, _)) = silent.accept().await {
                open.push(socket);
            }
        });
        let config = redis::aio::ConnectionManagerConfig::new()
            .set_connection_timeout(Some(Duration::from_millis(300)))
            .set_response_timeout(Some(Duration::from_millis(300)))
            .set_number_of_retries(0);
        let conn = redis::Client::open(format!("redis://{addr}"))
            .expect("url")
            .get_connection_manager_lazy(config)
            .expect("manager");
        let shared = Shared::new(conn, "rchat-test");
        let policy = tokens(2.0, 1.0);
        let first = Instant::now();
        assert_eq!(shared.try_take("k", policy, 1.0).await, None);
        assert!(
            first.elapsed() >= Duration::from_millis(250),
            "the first take waits for Redis: {:?}",
            first.elapsed()
        );
        for copy in [shared.clone(), shared] {
            let next = Instant::now();
            assert_eq!(copy.try_take("k", policy, 1.0).await, None);
            assert!(
                next.elapsed() < Duration::from_millis(100),
                "later takes count in this process at once: {:?}",
                next.elapsed()
            );
        }
        held.abort();
    }

    #[tokio::test]
    #[ignore = "needs a Redis-protocol server at REDIS_URL"]
    async fn shared_rate_counts_across_copies() {
        let Ok(url) = std::env::var("REDIS_URL") else {
            return;
        };
        let prefix = format!("rchat-test-{:08x}", rand::random::<u32>());
        let a = Shared::new(manager(&url).await, &prefix);
        let b = Shared::new(manager(&url).await, &prefix);
        let other = Shared::new(manager(&url).await, &format!("{prefix}-other"));
        let burst = tokens(3.0, 0.01);
        assert_eq!(a.take("k", burst, 1.0).await.expect("redis"), Ok(()));
        assert_eq!(b.take("k", burst, 1.0).await.expect("redis"), Ok(()));
        assert_eq!(a.take("k", burst, 1.0).await.expect("redis"), Ok(()));
        let wait = b
            .take("k", burst, 1.0)
            .await
            .expect("redis")
            .expect_err("spent");
        assert!(
            wait > Duration::ZERO && wait <= Duration::from_secs(100),
            "{wait:?}"
        );
        assert_eq!(
            other.take("k", burst, 1.0).await.expect("redis"),
            Ok(()),
            "another prefix counts apart"
        );
        let quick = tokens(1.0, 5.0);
        assert_eq!(a.take("q", quick, 1.0).await.expect("redis"), Ok(()));
        assert!(b.take("q", quick, 1.0).await.expect("redis").is_err());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            b.take("q", quick, 1.0).await.expect("redis"),
            Ok(()),
            "a token came back"
        );
        let window = Policy::Window {
            limit: 2,
            window: Duration::from_secs(60),
        };
        assert_eq!(a.take("w", window, 1.0).await.expect("redis"), Ok(()));
        assert_eq!(b.take("w", window, 1.0).await.expect("redis"), Ok(()));
        let wait = a
            .take("w", window, 1.0)
            .await
            .expect("redis")
            .expect_err("full");
        assert!(wait > Duration::from_secs(58), "{wait:?}");
        let rate = Rate::new("test", 10);
        let pool_a = rate.take_in("pool-a", Some(&a), "carol", burst, 1.0);
        assert_eq!(pool_a.await, Ok(()));
        for _ in 0..2 {
            assert_eq!(
                rate.take_in("pool-b", Some(&b), "carol", burst, 1.0).await,
                Ok(())
            );
        }
        assert!(
            rate.take_in("pool-b", Some(&b), "carol", burst, 1.0)
                .await
                .is_err(),
            "copies on other databases' pools still count one account together"
        );
    }
}
