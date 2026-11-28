use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tokio::time::Instant;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use tokio::sync::Notify;

use crate::api::ApiError;
use crate::limits::bucket::Table;

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Failed attempts per key with a growing wait. The first `free` failures cost nothing; after
/// that each one doubles the wait (2 s, 4 s, ...) up to `cap`. A hot key (`reserve(.., true)`)
/// gets only `hot_free` failures and then waits `cap`. A key with no attempt for `cap` starts
/// over. Each process has its own entries.
pub struct Backoff {
    free: u32,
    hot_free: u32,
    cap: Duration,
    table: Mutex<Table<String, u32>>,
}

impl Backoff {
    pub fn new(free: u32, hot_free: u32, cap: Duration, max_keys: usize) -> Backoff {
        Backoff {
            free,
            hot_free: hot_free.max(1),
            cap,
            table: Mutex::new(Table::new(max_keys)),
        }
    }

    fn wait(&self, fails: u32, hot: bool) -> Duration {
        match (hot, fails) {
            (true, n) if n < self.hot_free => Duration::ZERO,
            (true, _) => self.cap,
            (false, n) if n < self.free => Duration::ZERO,
            (false, n) => Duration::from_secs(1u64 << (n - self.free + 1).min(30)).min(self.cap),
        }
    }

    /// Reserves one attempt, counted as failed until `refund`. False while the key has to wait.
    pub fn reserve(&self, key: &str, hot: bool) -> bool {
        let now = Instant::now();
        let mut table = locked(&self.table);
        let (last, fails) = table.get(key).map_or((now, 0), |(at, &fails)| (at, fails));
        let fails = match now.duration_since(last) >= self.cap {
            true => 0,
            false => fails,
        };
        if fails > 0 && now.duration_since(last) < self.wait(fails, hot) {
            return false;
        }
        table.put(key, now, fails.saturating_add(1));
        true
    }

    /// Marks a reserved attempt as failed now, so the wait counts from the end of the check.
    pub fn failed(&self, key: &str) {
        let mut table = locked(&self.table);
        if let Some((_, &fails)) = table.get(key) {
            table.put(key, Instant::now(), fails);
        }
    }

    /// Gives back one reserved attempt (it did not fail).
    pub fn refund(&self, key: &str) {
        if let Some(fails) = locked(&self.table).get_mut(key) {
            *fails = fails.saturating_sub(1);
        }
    }
}

/// Places held at once per key, for a shared queue: one key can not take all of it.
#[derive(Default)]
pub struct Slots {
    held: Mutex<HashMap<String, usize>>,
}

/// One place in `Slots`; dropping it gives the place back.
pub struct Slot {
    slots: &'static Slots,
    key: String,
}

impl Slots {
    /// One more place for `key`, unless it holds `max` already.
    pub fn enter(&'static self, key: String, max: usize) -> Option<Slot> {
        let mut held = locked(&self.held);
        let n = held.get(&key).copied().unwrap_or(0);
        match n < max {
            true => {
                held.insert(key.clone(), n + 1);
                Some(Slot { slots: self, key })
            }
            false => None,
        }
    }
}

impl Slot {
    pub fn key(&self) -> &str {
        &self.key
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut held = locked(&self.slots.held);
        if let Some(n) = held.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                held.remove(&self.key);
            }
        }
    }
}

/// Amounts held at once per key, each key up to its own most.
#[derive(Default)]
pub struct Shares {
    held: Mutex<HashMap<String, u64>>,
    given_back: Notify,
}

/// An amount held in `Shares`; dropping it gives the amount back.
pub struct Share {
    shares: &'static Shares,
    key: String,
    amount: u64,
}

impl Shares {
    /// Holds `amount` more for `key`, unless that takes it past `most`.
    pub fn take(&'static self, key: &str, amount: u64, most: u64) -> Option<Share> {
        let mut held = locked(&self.held);
        let n = held.get(key).copied().unwrap_or(0);
        match n.saturating_add(amount) <= most {
            true => {
                held.insert(key.to_string(), n + amount);
                Some(Share {
                    shares: self,
                    key: key.to_string(),
                    amount,
                })
            }
            false => None,
        }
    }

    /// Like `take`, but when the amount is not free it waits for holders to give amounts back,
    /// until `deadline` or until `keep` is false. A free amount is taken whatever `keep` says;
    /// `keep` is checked while the amount is not free, again on every `wake`.
    pub async fn take_by(
        &'static self,
        key: &str,
        amount: u64,
        most: u64,
        deadline: tokio::time::Instant,
        keep: impl Fn() -> bool,
    ) -> Option<Share> {
        loop {
            let given_back = self.given_back.notified();
            let mut given_back = std::pin::pin!(given_back);
            given_back.as_mut().enable();
            if let Some(share) = self.take(key, amount, most) {
                return Some(share);
            }
            if !keep() {
                return None;
            }
            if tokio::time::timeout_at(deadline, given_back).await.is_err() {
                return None;
            }
        }
    }

    /// Makes every `take_by` that waits check again.
    pub fn wake(&self) {
        self.given_back.notify_waiters();
    }

    #[cfg(test)]
    pub fn held(&self, key: &str) -> u64 {
        locked(&self.held).get(key).copied().unwrap_or(0)
    }
}

impl Drop for Share {
    fn drop(&mut self) {
        {
            let mut held = locked(&self.shares.held);
            if let Some(n) = held.get_mut(&self.key) {
                *n = n.saturating_sub(self.amount);
                if *n == 0 {
                    held.remove(&self.key);
                }
            }
        }
        self.shares.wake();
    }
}

pub const SLOW_DOWN: &str = "Too many attempts. Try again later";

pub fn slow_down() -> ApiError {
    ApiError::rate(SLOW_DOWN, None)
}

tokio::task_local! {
    static CLIENT: IpAddr;
}

/// The client address of the request being handled, when the API router set it.
pub fn client() -> Option<IpAddr> {
    CLIENT.try_with(|ip| *ip).ok()
}

/// Runs `f` as work for the client at `ip`.
pub async fn as_client<F: std::future::Future>(ip: IpAddr, f: F) -> F::Output {
    CLIENT.scope(ip, f).await
}

pub async fn with_client(ip: IpAddr, req: Request, next: Next) -> Response {
    CLIENT.scope(ip, next.run(req)).await
}

/// IPv6 clients usually hold a full /64, so budgets and rate limits key on the /64.
pub fn group(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) => {
            let bits = u128::from(v6) & !((1u128 << 64) - 1);
            IpAddr::V6(bits.into())
        }
        v4 => v4,
    }
}

/// The wider network around a client: the IPv4 /24 or the IPv6 /48. Budgets on it stop one
/// network from spreading attempts over many addresses.
pub fn wide(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) => {
            let bits = u128::from(v6) & !((1u128 << 80) - 1);
            IpAddr::V6(bits.into())
        }
        IpAddr::V4(v4) => {
            let bits = u32::from(v4) & !0xff;
            IpAddr::V4(bits.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use super::*;

    #[test]
    fn backoff_grows_and_hot_keys_get_fewer_tries() {
        let b = Backoff::new(5, 3, Duration::from_secs(3600), 10);
        for _ in 0..5 {
            assert!(b.reserve("ip\nvault", false));
        }
        assert!(
            !b.reserve("ip\nvault", false),
            "past the free tries it waits"
        );
        b.refund("ip\nvault");
        assert!(b.reserve("ip\nvault", false), "a refund gives the try back");
        for _ in 0..3 {
            assert!(b.reserve("other\nvault", true));
        }
        assert!(!b.reserve("other\nvault", true), "hot names allow 3");
        assert!(
            b.reserve("fresh\nvault", true),
            "but never zero for a new address"
        );
        assert_eq!(b.wait(5, false), Duration::from_secs(2));
        assert_eq!(b.wait(6, false), Duration::from_secs(4));
        assert_eq!(b.wait(40, false), Duration::from_secs(3600));
        assert_eq!(b.wait(3, true), Duration::from_secs(3600));
        let quick = Backoff::new(1, 1, Duration::from_millis(5), 10);
        assert!(quick.reserve("k", false));
        assert!(!quick.reserve("k", false));
        std::thread::sleep(Duration::from_millis(10));
        assert!(quick.reserve("k", false), "an idle key starts over");
    }

    #[test]
    fn backoff_reserves_are_atomic() {
        let b = std::sync::Arc::new(Backoff::new(5, 3, Duration::from_secs(3600), 10));
        let threads: Vec<_> = (0..32)
            .map(|_| {
                let b = b.clone();
                std::thread::spawn(move || b.reserve("k", false))
            })
            .collect();
        let won = threads
            .into_iter()
            .map(|t| t.join().expect("thread"))
            .filter(|ok| *ok)
            .count();
        assert_eq!(won, 5);
    }

    #[test]
    fn slots_cap_each_key() {
        static SLOTS: LazyLock<Slots> = LazyLock::new(Slots::default);
        let a = SLOTS.enter("a".to_string(), 2).expect("first");
        let _b = SLOTS.enter("a".to_string(), 2).expect("second");
        assert!(SLOTS.enter("a".to_string(), 2).is_none(), "the key is full");
        assert!(
            SLOTS.enter("a".to_string(), 3).is_some(),
            "a larger most has room"
        );
        assert!(
            SLOTS.enter("b".to_string(), 2).is_some(),
            "other keys are not"
        );
        drop(a);
        assert!(
            SLOTS.enter("a".to_string(), 2).is_some(),
            "a dropped slot frees a place"
        );
    }

    #[tokio::test]
    async fn shares_wait_until_an_amount_comes_back() {
        static SHARES: LazyLock<Shares> = LazyLock::new(Shares::default);
        let after = |ms: u64| tokio::time::Instant::now() + Duration::from_millis(ms);
        let brief = Duration::from_millis(100);
        let all = SHARES.take("a", 2, 2).expect("free");
        assert!(
            SHARES
                .take_by("a", 1, 2, after(50), || true)
                .await
                .is_none(),
            "it gives up at the deadline"
        );
        let mut waits = Box::pin(SHARES.take_by("a", 1, 2, after(60_000), || true));
        assert!(tokio::time::timeout(brief, waits.as_mut()).await.is_err());
        assert!(
            SHARES
                .take_by("b", 1, 2, after(60_000), || true)
                .await
                .is_some(),
            "other keys are not held back"
        );
        drop(all);
        let one = waits.await.expect("an amount given back ends the wait");
        assert_eq!(SHARES.held("a"), 1);
        let rest = SHARES
            .take_by("a", 1, 2, after(60_000), || false)
            .await
            .expect("a free amount is taken whatever `keep` says");
        let keep = std::sync::atomic::AtomicBool::new(true);
        let mut waits = Box::pin(SHARES.take_by("a", 1, 2, after(60_000), || {
            keep.load(std::sync::atomic::Ordering::Relaxed)
        }));
        assert!(tokio::time::timeout(brief, waits.as_mut()).await.is_err());
        keep.store(false, std::sync::atomic::Ordering::Relaxed);
        SHARES.wake();
        let stopped = tokio::time::timeout(brief, waits).await;
        assert!(
            matches!(stopped, Ok(None)),
            "a wake makes it check `keep` again"
        );
        drop((one, rest));
        assert_eq!(SHARES.held("a"), 0);
    }

    #[test]
    fn wide_groups_are_24_and_48() {
        let ip = |s: &str| -> IpAddr { s.parse().expect("ip") };
        assert_eq!(wide(ip("192.0.2.7")), ip("192.0.2.0"));
        assert_eq!(wide(ip("::ffff:192.0.2.7")), ip("192.0.2.0"));
        assert_eq!(wide(ip("2001:db8:1:2::1")), wide(ip("2001:db8:1:ffff::1")));
        assert_ne!(wide(ip("2001:db8:1::1")), wide(ip("2001:db8:2::1")));
    }

    #[test]
    fn ipv6_groups_by_64() {
        let a: IpAddr = "2001:db8:1:2:3:4:5:6".parse().expect("ip");
        let b: IpAddr = "2001:db8:1:2:ffff::1".parse().expect("ip");
        assert_eq!(group(a), group(b));
        let v4: IpAddr = "192.0.2.7".parse().expect("ip");
        assert_eq!(group(v4), v4);
        let mapped: IpAddr = "::ffff:192.0.2.7".parse().expect("ip");
        assert_eq!(group(mapped), v4);
    }
}
