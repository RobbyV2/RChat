use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;

use crate::api::ApiError;

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Entries with a time stamp. When the table is full, a new key takes the place of the entry
/// with the oldest stamp, one entry at a time.
struct Table<V> {
    max: usize,
    map: HashMap<String, (Instant, V)>,
    order: VecDeque<(Instant, String)>,
}

impl<V> Table<V> {
    fn new(max: usize) -> Table<V> {
        Table {
            max: max.max(1),
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn entry(&mut self, key: &str, now: Instant, fresh: impl FnOnce() -> V) -> &mut (Instant, V) {
        if !self.map.contains_key(key) {
            while self.map.len() >= self.max {
                let Some((at, old)) = self.order.pop_front() else {
                    break;
                };
                if self.map.get(&old).is_some_and(|(stamp, _)| *stamp == at) {
                    self.map.remove(&old);
                }
            }
            self.order.push_back((now, key.to_string()));
        }
        self.map
            .entry(key.to_string())
            .or_insert_with(|| (now, fresh()))
    }

    fn restamp(&mut self, key: &str, at: Instant) {
        if let Some(entry) = self.map.get_mut(key) {
            entry.0 = at;
            self.order.push_back((at, key.to_string()));
        }
        if self.order.len() > 2 * self.max + 16 {
            let mut order: Vec<(Instant, String)> = self
                .map
                .iter()
                .map(|(k, (at, _))| (*at, k.clone()))
                .collect();
            order.sort();
            self.order = order.into();
        }
    }
}

/// A fixed-window counter per key, kept in memory. Each process has its own counters.
pub struct Budget {
    limit: u32,
    window: Duration,
    table: Mutex<Table<u32>>,
}

impl Budget {
    pub fn new(limit: u32, window: Duration, max_keys: usize) -> Budget {
        Budget {
            limit,
            window,
            table: Mutex::new(Table::new(max_keys)),
        }
    }

    fn with<T>(&self, key: &str, f: impl FnOnce(Instant, &mut u32) -> T) -> T {
        let now = Instant::now();
        let mut table = locked(&self.table);
        let start = table.entry(key, now, || 0).0;
        if now.duration_since(start) >= self.window {
            table.restamp(key, now);
            if let Some(entry) = table.map.get_mut(key) {
                entry.1 = 0;
            }
        }
        match table.map.get_mut(key) {
            Some((start, n)) => f(*start, n),
            None => f(now, &mut 0),
        }
    }

    #[cfg(test)]
    pub fn forget_prefix(&self, prefix: &str) {
        let mut table = locked(&self.table);
        let keys: Vec<String> = table
            .map
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect();
        for k in keys {
            if let Some(entry) = table.map.get_mut(&k) {
                entry.1 = 0;
            }
        }
    }

    /// Counts one use. False when the key already used its budget in this window.
    pub fn take(&self, key: &str) -> bool {
        self.reserve(key).is_some()
    }

    /// Like `take`, but returns the start of the window the use counts in, for `refund`.
    pub fn reserve(&self, key: &str) -> Option<Instant> {
        let limit = self.limit;
        self.with(key, |start, n| match *n < limit {
            true => {
                *n += 1;
                Some(start)
            }
            false => None,
        })
    }

    /// Gives back one use reserved in the window that started at `start`.
    pub fn refund(&self, key: &str, start: Instant) {
        let mut table = locked(&self.table);
        if let Some((at, n)) = table.map.get_mut(key)
            && *at == start
        {
            *n = n.saturating_sub(1);
        }
    }

    /// Whether the key used its budget in this window, without counting a use.
    pub fn spent(&self, key: &str) -> bool {
        let limit = self.limit;
        self.with(key, |_, n| *n >= limit)
    }

    /// Counts one use without a check.
    pub fn note(&self, key: &str) {
        self.with(key, |_, n| *n = n.saturating_add(1));
    }

    #[cfg(test)]
    pub fn used(&self, key: &str) -> Option<u32> {
        locked(&self.table).map.get(key).map(|(_, n)| *n)
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
    table: Mutex<Table<u32>>,
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
        let (last, fails) = *table.entry(key, now, || 0);
        let fails = match now.duration_since(last) >= self.cap {
            true => 0,
            false => fails,
        };
        if fails > 0 && now.duration_since(last) < self.wait(fails, hot) {
            return false;
        }
        table.restamp(key, now);
        if let Some(entry) = table.map.get_mut(key) {
            entry.1 = fails.saturating_add(1);
        }
        true
    }

    /// Marks a reserved attempt as failed now, so the wait counts from the end of the check.
    pub fn failed(&self, key: &str) {
        locked(&self.table).restamp(key, Instant::now());
    }

    /// Gives back one reserved attempt (it did not fail).
    pub fn refund(&self, key: &str) {
        let mut table = locked(&self.table);
        if let Some((_, fails)) = table.map.get_mut(key) {
            *fails = fails.saturating_sub(1);
        }
    }
}

/// Places held at once per key, for a shared queue: one key can not take all of it.
pub struct Slots {
    max: usize,
    held: Mutex<HashMap<String, usize>>,
}

/// One place in `Slots`; dropping it gives the place back.
pub struct Slot {
    slots: &'static Slots,
    key: String,
}

impl Slots {
    pub fn new(max: usize) -> Slots {
        Slots {
            max,
            held: Mutex::new(HashMap::new()),
        }
    }

    pub fn enter(&'static self, key: String) -> Option<Slot> {
        let mut held = locked(&self.held);
        let n = held.get(&key).copied().unwrap_or(0);
        match n < self.max {
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

    #[cfg(test)]
    pub fn held(&self, key: &str) -> u64 {
        locked(&self.held).get(key).copied().unwrap_or(0)
    }
}

impl Drop for Share {
    fn drop(&mut self) {
        let mut held = locked(&self.shares.held);
        if let Some(n) = held.get_mut(&self.key) {
            *n = n.saturating_sub(self.amount);
            if *n == 0 {
                held.remove(&self.key);
            }
        }
    }
}

pub const SLOW_DOWN: &str = "Too many attempts. Try again later";

pub fn slow_down() -> ApiError {
    ApiError(StatusCode::TOO_MANY_REQUESTS, SLOW_DOWN.to_string())
}

tokio::task_local! {
    static CLIENT: IpAddr;
}

/// The client address of the request being handled, when the API router set it.
pub fn client() -> Option<IpAddr> {
    CLIENT.try_with(|ip| *ip).ok()
}

#[cfg(test)]
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
    fn budgets_count_per_key_and_window() {
        let b = Budget::new(2, Duration::from_secs(60), 10);
        assert!(b.take("a"));
        assert!(b.take("a"));
        assert!(!b.take("a"));
        assert!(b.spent("a"));
        assert!(b.take("b"));
        assert!(!b.spent("b"));
        let short = Budget::new(1, Duration::from_millis(1), 10);
        assert!(short.take("a"));
        std::thread::sleep(Duration::from_millis(5));
        assert!(short.take("a"));
    }

    #[test]
    fn a_full_table_evicts_only_the_oldest_window() {
        let b = Budget::new(1, Duration::from_secs(60), 3);
        for key in ["a", "b", "c"] {
            assert!(b.take(key));
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(b.take("d"), "a new key gets a place");
        assert!(b.spent("b") && b.spent("c"), "younger counters are kept");
        assert!(!b.spent("a"), "only the oldest window made room");
        for n in 0..1000 {
            b.note(&format!("x{n}"));
        }
        assert!(locked(&b.table).order.len() <= 2 * 3 + 16 + 1);
    }

    #[test]
    fn reserved_uses_are_atomic_and_can_be_refunded() {
        let b = std::sync::Arc::new(Budget::new(5, Duration::from_secs(60), 10));
        let threads: Vec<_> = (0..32)
            .map(|_| {
                let b = b.clone();
                std::thread::spawn(move || b.reserve("k"))
            })
            .collect();
        let won: Vec<Instant> = threads
            .into_iter()
            .filter_map(|t| t.join().expect("thread"))
            .collect();
        assert_eq!(won.len(), 5, "no more than the limit under contention");
        assert!(b.reserve("k").is_none());
        b.refund("k", won[0]);
        assert!(b.reserve("k").is_some(), "a refund gives one use back");
        assert!(b.reserve("k").is_none());
    }

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
        static SLOTS: LazyLock<Slots> = LazyLock::new(|| Slots::new(2));
        let a = SLOTS.enter("a".to_string()).expect("first");
        let _b = SLOTS.enter("a".to_string()).expect("second");
        assert!(SLOTS.enter("a".to_string()).is_none(), "the key is full");
        assert!(SLOTS.enter("b".to_string()).is_some(), "other keys are not");
        drop(a);
        assert!(
            SLOTS.enter("a".to_string()).is_some(),
            "a dropped slot frees a place"
        );
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
