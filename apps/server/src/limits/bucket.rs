use std::borrow::Borrow;
use std::collections::VecDeque;
use std::hash::{BuildHasher, Hash, RandomState};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use hashbrown::HashTable;

/// How a bucket fills: `burst` at once, then `per_sec` more each second; or at most `limit`
/// in a fixed `window` that starts at its first use.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Policy {
    Tokens { burst: f64, per_sec: f64 },
    Window { limit: u32, window: Duration },
}

/// When a bucket was last stamped, and how much of it is used: tokens taken and not yet
/// refilled, or uses counted in the window that started at the stamp.
type Level = (Instant, f64);

impl Policy {
    /// `burst` at once, then one more every `every`.
    pub fn every(burst: f64, every: Duration) -> Policy {
        Policy::Tokens {
            burst,
            per_sec: 1.0 / every.as_secs_f64().max(f64::EPSILON),
        }
    }

    /// `burst` at once, then `per_minute` more each minute.
    pub fn per_minute(burst: u32, per_minute: u32) -> Policy {
        Policy::Tokens {
            burst: f64::from(burst),
            per_sec: f64::from(per_minute) / 60.0,
        }
    }

    /// What a bucket holds when nothing of it is used.
    #[inline(always)]
    pub fn full(self) -> f64 {
        match self {
            Policy::Tokens { burst, per_sec: _ } => burst,
            Policy::Window { limit, window: _ } => f64::from(limit),
        }
    }

    // The bucket stamped `at` with `used` taken, as it is at `now`: tokens refill from the stamp
    // (a stamp after `now` stays), and a window that is over or unused starts again at `now`.
    #[inline(always)]
    fn level(self, (at, used): Level, now: Instant) -> Level {
        let since = now.saturating_duration_since(at);
        match self {
            Policy::Tokens { burst: _, per_sec } => {
                (at.max(now), (used - since.as_secs_f64() * per_sec).max(0.0))
            }
            Policy::Window { limit: _, window } => match used <= 0.0 || since >= window {
                true => (now, 0.0),
                false => (at, used),
            },
        }
    }

    #[inline(always)]
    fn take(self, level: Level, cost: f64, now: Instant) -> (Level, bool) {
        let (at, used) = self.level(level, now);
        match used + cost <= self.full() {
            true => ((at, used + cost), true),
            false => ((at, used), false),
        }
    }

    // Takes `cost` without a check and returns what is left. A debt is kept down to one full
    // bucket.
    #[inline(always)]
    fn spend(self, level: Level, cost: f64, now: Instant) -> (Level, f64) {
        let (at, used) = self.level(level, now);
        let full = self.full();
        ((at, (used + cost).min(2.0 * full)), full - used - cost)
    }

    // How long from `now` until the bucket holds `cost`; `None` when it never will.
    fn wait(self, level: Level, cost: f64, now: Instant) -> Option<Duration> {
        let (at, used) = self.level(level, now);
        let over = used + cost - self.full();
        if over <= 0.0 {
            return Some(Duration::ZERO);
        }
        match self {
            Policy::Tokens { burst: _, per_sec } => Duration::try_from_secs_f64(over / per_sec)
                .ok()
                .and_then(|wait| wait.checked_add(at.saturating_duration_since(now))),
            Policy::Window { limit: _, window } => at
                .checked_add(window)
                .map(|end| end.saturating_duration_since(now)),
        }
    }
}

/// Entries with a time stamp. When the table is full, a new key takes the place of the entry
/// with the oldest stamp, one entry at a time.
pub(crate) struct Table<K, V> {
    max: usize,
    hasher: RandomState,
    map: HashTable<(K, Instant, V)>,
    order: VecDeque<(Instant, K)>,
}

impl<K: Hash + Eq + Clone, V> Table<K, V> {
    pub(crate) fn new(max: usize) -> Table<K, V> {
        Table::with_hasher(max, RandomState::new())
    }

    fn with_hasher(max: usize, hasher: RandomState) -> Table<K, V> {
        Table {
            max: max.max(1),
            hasher,
            map: HashTable::new(),
            order: VecDeque::new(),
        }
    }

    /// Keys the table holds from now on; past it, new keys make room as before.
    fn set_max(&mut self, max: usize) {
        self.max = max.max(1);
    }

    fn hash<Q: Hash + ?Sized>(&self, key: &Q) -> u64 {
        self.hasher.hash_one(key)
    }

    fn find<Q>(&self, hash: u64, key: &Q) -> Option<&(K, Instant, V)>
    where
        K: Borrow<Q>,
        Q: Eq + ?Sized,
    {
        self.map.find(hash, |(k, _, _)| k.borrow() == key)
    }

    fn find_mut<Q>(&mut self, hash: u64, key: &Q) -> Option<&mut (K, Instant, V)>
    where
        K: Borrow<Q>,
        Q: Eq + ?Sized,
    {
        self.map.find_mut(hash, |(k, _, _)| k.borrow() == key)
    }

    pub(crate) fn get<Q>(&self, key: &Q) -> Option<(Instant, &V)>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.get_hashed(self.hash(key), key)
    }

    fn get_hashed<Q>(&self, hash: u64, key: &Q) -> Option<(Instant, &V)>
    where
        K: Borrow<Q>,
        Q: Eq + ?Sized,
    {
        self.find(hash, key).map(|(_, at, v)| (*at, v))
    }

    /// The value of `key`, to change without a new stamp.
    pub(crate) fn get_mut<Q>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let hash = self.hash(key);
        self.find_mut(hash, key).map(|(_, _, v)| v)
    }

    /// Sets `key` to `value`, stamped `at`.
    pub(crate) fn put<Q>(&mut self, key: &Q, at: Instant, value: V)
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        let hash = self.hash(key);
        self.put_hashed(hash, key, at, value);
    }

    fn put_hashed<Q>(&mut self, hash: u64, key: &Q, at: Instant, value: V)
    where
        K: Borrow<Q>,
        Q: Eq + ToOwned<Owned = K> + ?Sized,
    {
        match self.find_mut(hash, key) {
            Some(entry) => {
                let moved = entry.1 != at;
                (entry.1, entry.2) = (at, value);
                if moved {
                    self.order.push_back((at, key.to_owned()));
                }
            }
            None => {
                while self.map.len() >= self.max {
                    let Some((stamp, old)) = self.order.pop_front() else {
                        break;
                    };
                    let old_hash = self.hash(&old);
                    if let Ok(entry) = self.map.find_entry(old_hash, |(k, _, _)| *k == old)
                        && entry.get().1 == stamp
                    {
                        entry.remove();
                    }
                }
                self.order.push_back((at, key.to_owned()));
                let hasher = &self.hasher;
                self.map
                    .insert_unique(hash, (key.to_owned(), at, value), |(k, _, _)| {
                        hasher.hash_one(k)
                    });
            }
        }
        self.compact();
    }

    /// Sets the entry of `key`, whose hash is `hash`, to what `f` makes of it (`None` for a new
    /// key), with one lookup.
    fn update<Q, T>(
        &mut self,
        hash: u64,
        key: &Q,
        f: impl FnOnce(Option<(Instant, V)>) -> ((Instant, V), T),
    ) -> T
    where
        K: Borrow<Q>,
        Q: Eq + ToOwned<Owned = K> + ?Sized,
        V: Copy,
    {
        let Some(entry) = self.find_mut(hash, key) else {
            let ((at, value), out) = f(None);
            self.put_hashed(hash, key, at, value);
            return out;
        };
        let ((at, value), out) = f(Some((entry.1, entry.2)));
        let moved = entry.1 != at;
        (entry.1, entry.2) = (at, value);
        if moved {
            self.order.push_back((at, key.to_owned()));
        }
        self.compact();
        out
    }

    fn compact(&mut self) {
        if self.order.len() > 2 * self.map.len() + 16 {
            let mut order: Vec<(Instant, K)> =
                self.map.iter().map(|(k, at, _)| (*at, k.clone())).collect();
            order.sort_by_key(|(at, _)| *at);
            self.order = order.into();
        }
    }

    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&K, (Instant, &V)) -> bool) {
        self.map.retain(|(k, at, v)| keep(k, (*at, v)));
    }

    pub(crate) fn len(&self) -> usize {
        self.map.len()
    }

    #[cfg(test)]
    pub(crate) fn queued(&self) -> usize {
        self.order.len()
    }
}

/// Keys a map holds per shard: one with room for fewer stays a single shard.
const SHARD_KEYS: usize = 1024;
/// The most shards a map is split into.
const SHARDS_MAX: usize = 64;

/// One bucket per key, at most `max_keys` of them. A map with room for many keys is split by
/// key hash into shards with a lock each, so uses of different keys rarely wait on each other;
/// each shard holds its share of `max_keys`. Past that, a new key takes the place of the one in
/// its shard used longest ago (for a window, the one whose window started first). A map with
/// room for fewer than `2 * SHARD_KEYS` keys is one shard, and that is the one key used longest
/// ago of all.
pub struct Keyed<K: Hash + Eq + Clone = String> {
    hasher: RandomState,
    shards: Box<[Shard<K>]>,
}

// Aligned so that two shards never share a cache line.
#[repr(align(128))]
struct Shard<K> {
    inner: Mutex<Buckets<K>>,
}

type Buckets<K> = (Policy, Table<K, f64>);

/// The buckets of a `Keyed` read under another policy than its own, for limits that come with
/// each request (`None`: the stored policy, read under the same lock as the buckets).
pub struct Under<'a, K: Hash + Eq + Clone> {
    keyed: &'a Keyed<K>,
    policy: Option<Policy>,
}

impl<K: Hash + Eq + Clone> Clone for Under<'_, K> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<K: Hash + Eq + Clone> Copy for Under<'_, K> {}

/// A use taken from a bucket. It goes back to the bucket on drop unless `spend` keeps it.
#[must_use]
pub struct Token<'a, K: Hash + Eq + Clone = String> {
    under: Under<'a, K>,
    key: K,
    cost: f64,
    at: Option<Instant>,
}

impl<K: Hash + Eq + Clone> Token<'_, K> {
    pub fn spend(mut self) {
        self.at = None;
    }
}

impl<K: Hash + Eq + Clone> Drop for Token<'_, K> {
    fn drop(&mut self) {
        if let Some(at) = self.at.take() {
            self.under.refund(&self.key, self.cost, at);
        }
    }
}

impl<K: Hash + Eq + Clone> Keyed<K> {
    pub fn new(policy: Policy, max_keys: usize) -> Self {
        let count = (max_keys / SHARD_KEYS).clamp(1, SHARDS_MAX);
        let count = 1 << count.ilog2();
        let hasher = RandomState::new();
        let shards = (0..count)
            .map(|n| {
                let room = max_keys / count + usize::from(n < max_keys % count);
                Shard {
                    inner: Mutex::new((policy, Table::with_hasher(room, hasher.clone()))),
                }
            })
            .collect();
        Keyed { hasher, shards }
    }

    // The shard of `key`, locked, and the key's hash. The shard is picked by bits of the hash
    // that its table leaves unused (it uses the low bits and the top seven).
    fn shard<Q>(&self, key: &Q) -> (MutexGuard<'_, Buckets<K>>, u64)
    where
        Q: Hash + ?Sized,
    {
        let hash = self.hasher.hash_one(key);
        let at = (hash >> 32) as usize & (self.shards.len() - 1);
        (locked(&self.shards[at].inner), hash)
    }

    fn each(&self) -> impl Iterator<Item = MutexGuard<'_, Buckets<K>>> {
        self.shards.iter().map(|shard| locked(&shard.inner))
    }

    /// The same buckets under `policy` in place of the stored one.
    pub fn under(&self, policy: Policy) -> Under<'_, K> {
        Under {
            keyed: self,
            policy: Some(policy),
        }
    }

    fn own(&self) -> Under<'_, K> {
        Under {
            keyed: self,
            policy: None,
        }
    }

    /// Takes `cost` from the key's bucket. False, and nothing taken, when it holds less.
    pub fn take<Q>(&self, key: &Q, cost: f64, now: Instant) -> bool
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        self.own().take(key, cost, now)
    }

    /// Like `take`, but returns the stamp the use counts under, for `refund`.
    pub fn reserve<Q>(&self, key: &Q, cost: f64, now: Instant) -> Option<Instant>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        self.own().reserve(key, cost, now)
    }

    /// Like `reserve`, but a refusal says how long to wait until the bucket holds `cost`.
    pub fn try_take<Q>(&self, key: &Q, cost: f64, now: Instant) -> Result<Instant, Duration>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        self.own().try_take(key, cost, now)
    }

    /// Gives back `cost` reserved under `at`. A window gives it back only while the window it
    /// was counted in runs; tokens come back whenever, up to a full bucket.
    pub fn refund<Q>(&self, key: &Q, cost: f64, at: Instant)
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.own().refund(key, cost, at);
    }

    /// Takes `cost` without a check and returns what is left, below zero when the key owes.
    pub fn spend<Q>(&self, key: &Q, cost: f64, now: Instant) -> f64
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        self.own().spend(key, cost, now)
    }

    /// What the key's bucket holds at `now`.
    pub fn remaining<Q>(&self, key: &Q, now: Instant) -> f64
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.own().remaining(key, now)
    }

    /// How long from `now` until the key's bucket holds `cost`: zero when it does already.
    pub fn wait<Q>(&self, key: &Q, cost: f64, now: Instant) -> Duration
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.own().wait(key, cost, now)
    }

    /// The stored policy.
    pub fn policy(&self) -> Policy {
        locked(&self.shards[0].inner).0
    }

    /// Applies to every key from its next use.
    pub fn set_policy(&self, policy: Policy) {
        for mut shard in self.each() {
            shard.0 = policy;
        }
    }

    /// Keeps at most `max_keys` keys from now on, shared out over the shards as at the start.
    pub fn set_max_keys(&self, max_keys: usize) {
        let count = self.shards.len();
        for (n, mut shard) in self.each().enumerate() {
            shard
                .1
                .set_max(max_keys / count + usize::from(n < max_keys % count));
        }
    }

    /// Drops the keys whose buckets are full again.
    pub fn prune(&self, now: Instant) {
        for mut shard in self.each() {
            let (policy, table) = &mut *shard;
            let policy = *policy;
            table.retain(|_, (at, &used)| policy.level((at, used), now).1 > 0.0);
        }
    }

    pub fn len(&self) -> usize {
        self.each().map(|shard| shard.1.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[cfg(test)]
    pub fn used<Q>(&self, key: &Q) -> Option<f64>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let (shard, hash) = self.shard(key);
        shard.1.get_hashed(hash, key).map(|(_, used)| *used)
    }

    /// Entries queued and keys held, per shard.
    #[cfg(test)]
    fn queued(&self) -> Vec<(usize, usize)> {
        self.each()
            .map(|shard| (shard.1.queued(), shard.1.len()))
            .collect()
    }

    #[cfg(test)]
    fn shard_count(&self) -> usize {
        self.shards.len()
    }
}

#[cfg(test)]
impl Keyed<String> {
    pub fn forget_prefix(&self, prefix: &str) {
        for mut shard in self.each() {
            shard.1.retain(|k, _| !k.starts_with(prefix));
        }
    }
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl<'a, K: Hash + Eq + Clone> Under<'a, K> {
    /// Like `try_take`, but the use goes back when the token is dropped unspent.
    pub fn hold(self, key: K, cost: f64, now: Instant) -> Result<Token<'a, K>, Duration> {
        let at = self.try_take(&key, cost, now)?;
        Ok(Token {
            under: self,
            key,
            cost,
            at: Some(at),
        })
    }

    fn with<Q, T>(&self, key: &Q, now: Instant, f: impl FnOnce(Policy, Level) -> (Level, T)) -> T
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        let (mut inner, hash) = self.keyed.shard(key);
        let (stored, table) = &mut *inner;
        let policy = self.policy.unwrap_or(*stored);
        table.update(hash, key, |level| f(policy, level.unwrap_or((now, 0.0))))
    }

    pub fn take<Q>(&self, key: &Q, cost: f64, now: Instant) -> bool
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        self.reserve(key, cost, now).is_some()
    }

    pub fn reserve<Q>(&self, key: &Q, cost: f64, now: Instant) -> Option<Instant>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        self.try_take(key, cost, now).ok()
    }

    pub fn try_take<Q>(&self, key: &Q, cost: f64, now: Instant) -> Result<Instant, Duration>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        self.with(key, now, |policy, level| {
            let (level, taken) = policy.take(level, cost, now);
            let answer = match taken {
                true => Ok(level.0),
                false => Err(policy.wait(level, cost, now).unwrap_or(Duration::MAX)),
            };
            (level, answer)
        })
    }

    pub fn refund<Q>(&self, key: &Q, cost: f64, at: Instant)
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let (mut inner, hash) = self.keyed.shard(key);
        let (stored, table) = &mut *inner;
        let policy = self.policy.unwrap_or(*stored);
        if let Some((_, stamp, used)) = table.find_mut(hash, key) {
            let current = match policy {
                Policy::Tokens {
                    burst: _,
                    per_sec: _,
                } => true,
                Policy::Window {
                    limit: _,
                    window: _,
                } => *stamp == at,
            };
            if current {
                *used = (*used - cost).max(0.0);
            }
        }
    }

    pub fn spend<Q>(&self, key: &Q, cost: f64, now: Instant) -> f64
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ToOwned<Owned = K> + ?Sized,
    {
        self.with(key, now, |policy, level| policy.spend(level, cost, now))
    }

    pub fn remaining<Q>(&self, key: &Q, now: Instant) -> f64
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let (inner, hash) = self.keyed.shard(key);
        let (stored, table) = &*inner;
        let policy = self.policy.unwrap_or(*stored);
        let used = table
            .get_hashed(hash, key)
            .map_or(0.0, |(at, &used)| policy.level((at, used), now).1);
        policy.full() - used
    }

    pub fn wait<Q>(&self, key: &Q, cost: f64, now: Instant) -> Duration
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let (inner, hash) = self.keyed.shard(key);
        let (stored, table) = &*inner;
        let level = table
            .get_hashed(hash, key)
            .map_or((now, 0.0), |(at, &used)| (at, used));
        self.policy
            .unwrap_or(*stored)
            .wait(level, cost, now)
            .unwrap_or(Duration::MAX)
    }
}

/// One bucket on its own, for per-connection use.
#[derive(Clone, Copy, Debug)]
pub struct Single {
    policy: Policy,
    level: Level,
}

impl Single {
    pub fn new(policy: Policy, now: Instant) -> Self {
        Single {
            policy,
            level: (now, 0.0),
        }
    }

    /// Takes `cost`. False, and nothing taken, when the bucket holds less.
    #[inline(always)]
    pub fn take(&mut self, cost: f64, now: Instant) -> bool {
        let taken;
        (self.level, taken) = self.policy.take(self.level, cost, now);
        taken
    }

    /// Takes `cost` without a check and returns what is left, below zero when it owes.
    #[inline(always)]
    pub fn spend(&mut self, cost: f64, now: Instant) -> f64 {
        let left;
        (self.level, left) = self.policy.spend(self.level, cost, now);
        left
    }

    /// What the bucket holds at `now`.
    pub fn remaining(&self, now: Instant) -> f64 {
        self.policy.full() - self.policy.level(self.level, now).1
    }

    /// When `cost` can be taken, at `now` or later.
    pub fn ready_at(&self, cost: f64, now: Instant) -> Option<Instant> {
        self.policy
            .wait(self.level, cost, now)
            .and_then(|wait| now.checked_add(wait))
    }

    #[cfg(test)]
    pub fn set_remaining(&mut self, left: f64, now: Instant) {
        self.level = (now, self.policy.full() - left);
    }
}

#[cfg(test)]
mod tests;
