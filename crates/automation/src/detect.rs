//! Detector windows. The clock is injected: every call takes the time, in unix seconds.

use crate::keywords::normalize;
use crate::model::Per;
use crate::safety::{AuditEntry, trips};
use std::collections::{HashMap, VecDeque};

/// The longest window a rate or duplicates condition may ask for.
pub const WINDOW_MAX: i64 = 3600;
pub const SENDS_KEPT: usize = 20;
pub const TEXTS_KEPT: usize = 10;
pub const JOINS_KEPT: usize = 500;

/// Times as 16-bit second offsets from a base, oldest first.
#[derive(Clone, Copy, Debug)]
struct Offsets<const N: usize> {
    base: i64,
    offsets: [u16; N],
    len: u8,
}

impl<const N: usize> Default for Offsets<N> {
    fn default() -> Offsets<N> {
        Offsets {
            base: 0,
            offsets: [0; N],
            len: 0,
        }
    }
}

impl<const N: usize> Offsets<N> {
    fn times(&self) -> impl Iterator<Item = i64> + '_ {
        self.offsets[..usize::from(self.len)]
            .iter()
            .map(|o| self.base + i64::from(*o))
    }

    /// Makes room for a time and answers the index it goes to and how many of the oldest were
    /// dropped. A time before the newest one counts as the newest, so the times stay in order.
    fn place(&mut self, now: i64) -> (usize, usize) {
        let now = self.times().last().map_or(now, |newest| newest.max(now));
        let mut dropped = 0;
        if self.len == 0 {
            self.base = now;
        }
        if now - self.base > i64::from(u16::MAX) {
            let base = now - WINDOW_MAX;
            let kept: Vec<i64> = self.times().filter(|t| *t >= base).collect();
            dropped = usize::from(self.len) - kept.len();
            for (slot, t) in self.offsets.iter_mut().zip(&kept) {
                *slot = (t - base) as u16;
            }
            self.len = kept.len() as u8;
            self.base = base;
        }
        if usize::from(self.len) == N {
            self.offsets.copy_within(1.., 0);
            self.len -= 1;
            dropped += 1;
        }
        let at = usize::from(self.len);
        self.offsets[at] = (now - self.base) as u16;
        self.len += 1;
        (at, dropped)
    }
}

/// One member's last sends in a server or a channel, for `rate`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sends {
    times: Offsets<SENDS_KEPT>,
}

impl Sends {
    pub fn push(&mut self, now: i64) {
        self.times.place(now);
    }

    pub fn len(&self) -> usize {
        usize::from(self.times.len)
    }

    pub fn is_empty(&self) -> bool {
        self.times.len == 0
    }

    /// The sends in the last `seconds` seconds, `now` included.
    pub fn count(&self, now: i64, seconds: u32) -> usize {
        self.times
            .times()
            .filter(|t| *t <= now && now - t < i64::from(seconds))
            .count()
    }

    pub fn over(&self, now: i64, count: u32, seconds: u32) -> bool {
        self.count(now, seconds) > count as usize
    }

    /// Records a send and tells whether the member has now sent more than `count` in `seconds`.
    pub fn rate(&mut self, now: i64, count: u32, seconds: u32) -> bool {
        self.push(now);
        self.over(now, count, seconds)
    }
}

/// FNV-1a over the normalized text: 32 bits, never the text itself.
pub fn text_hash(normalized: &str) -> u32 {
    normalized.bytes().fold(0x811c_9dc5, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
    })
}

/// One member's last text hashes in a server, for `duplicates`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Texts {
    times: Offsets<TEXTS_KEPT>,
    hashes: [u32; TEXTS_KEPT],
}

impl Texts {
    pub fn len(&self) -> usize {
        usize::from(self.times.len)
    }

    pub fn is_empty(&self) -> bool {
        self.times.len == 0
    }

    /// Records a message and tells whether the same normalized text has now been sent more than
    /// `count` times in `seconds`.
    pub fn duplicates(&mut self, now: i64, text: &str, count: u32, seconds: u32) -> bool {
        let hash = text_hash(&normalize(text));
        let before = self.len();
        let (at, dropped) = self.times.place(now);
        self.hashes.copy_within(dropped..before, 0);
        self.hashes[at] = hash;
        let same = self
            .times
            .times()
            .zip(self.hashes)
            .filter(|(t, h)| *h == hash && *t <= now && now - t < i64::from(seconds))
            .count();
        same > count as usize
    }
}

/// A server's last joins, for `join_rate`.
#[derive(Clone, Debug, Default)]
pub struct Joins {
    times: VecDeque<i64>,
}

impl Joins {
    pub fn push(&mut self, now: i64) {
        if self.times.len() == JOINS_KEPT {
            self.times.pop_front();
        }
        self.times.push_back(now);
    }

    pub fn len(&self) -> usize {
        self.times.len()
    }

    pub fn is_empty(&self) -> bool {
        self.times.is_empty()
    }

    pub fn count(&self, now: i64, seconds: u32) -> usize {
        self.times
            .iter()
            .filter(|t| **t <= now && now - **t < i64::from(seconds))
            .count()
    }

    /// Records a join and tells whether there are now more than `joins` in `seconds`.
    pub fn rate(&mut self, now: i64, joins: u32, seconds: u32) -> bool {
        self.push(now);
        self.count(now, seconds) > joins as usize
    }
}

/// The key a cooldown runs under.
pub fn cooldown_key(automation: i64, per: Per, member: &str, channel: i64) -> String {
    match per {
        Per::Member => format!("{automation}:m:{member}"),
        Per::Channel => format!("{automation}:c:{channel}"),
        Per::Server => format!("{automation}:s"),
    }
}

/// When each cooldown key last ran.
#[derive(Clone, Debug, Default)]
pub struct Cooldowns {
    last: HashMap<String, i64>,
}

impl Cooldowns {
    pub fn ready(&self, key: &str, now: i64, seconds: u32) -> bool {
        self.last
            .get(key)
            .is_none_or(|last| now - last >= i64::from(seconds))
    }

    pub fn ran(&mut self, key: &str, now: i64) {
        self.last.insert(key.to_string(), now);
    }

    /// Runs the key when it is ready.
    pub fn take(&mut self, key: &str, now: i64, seconds: u32) -> bool {
        let ready = self.ready(key, now, seconds);
        if ready {
            self.ran(key, now);
        }
        ready
    }

    pub fn forget_before(&mut self, t: i64) {
        self.last.retain(|_, last| *last >= t);
    }

    pub fn len(&self) -> usize {
        self.last.len()
    }

    pub fn is_empty(&self) -> bool {
        self.last.is_empty()
    }
}

/// Whether `actor` did more than `count` counted staff actions in the last `minutes`.
pub fn staff_action_rate(
    entries: &[AuditEntry],
    actor: &str,
    raid_until: Option<i64>,
    count: u32,
    minutes: u32,
    now: i64,
) -> bool {
    trips(
        entries,
        actor,
        raid_until,
        count as usize,
        i64::from(minutes) * 60,
        now,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Per;

    #[test]
    fn a_rate_window_counts_sends_inside_its_edges() {
        let mut w = Sends::default();
        for t in [100, 101, 102, 103, 104] {
            w.push(t);
        }
        assert_eq!(w.count(104, 5), 5);
        assert!(!w.over(104, 5, 5));
        w.push(104);
        assert!(w.over(104, 5, 5));
        assert_eq!(w.count(105, 5), 5);
        assert!(!w.over(105, 5, 5));
        assert_eq!(w.count(109, 5), 0);
        assert_eq!(w.count(104, 1), 2);
        assert_eq!(w.count(104, 0), 0);
    }

    #[test]
    fn rate_records_and_answers_in_one_step() {
        let mut w = Sends::default();
        let hits: Vec<bool> = [1000, 1000, 1001, 1001, 1002, 1002, 1007]
            .into_iter()
            .map(|t| w.rate(t, 5, 5))
            .collect();
        assert_eq!(hits, [false, false, false, false, false, true, false]);
        let mut steady = Sends::default();
        assert!((0..30).all(|i| !steady.rate(2000 + i, 5, 5)));
    }

    #[test]
    fn a_rate_window_keeps_the_last_20_sends_as_16_bit_offsets() {
        let mut w = Sends::default();
        for t in 0..50 {
            w.push(1_700_000_000 + t);
        }
        assert_eq!(w.len(), SENDS_KEPT);
        assert_eq!(w.count(1_700_000_049, 3600), 20);
        assert!(std::mem::size_of::<Sends>() <= 56);
        assert!(std::mem::size_of::<Texts>() <= 80);
        w.push(1_700_000_049 + 70_000);
        assert_eq!(w.count(1_700_000_049 + 70_000, 3600), 1);
        w.push(1_700_000_049 + 70_010);
        assert_eq!(w.count(1_700_000_049 + 70_010, 3600), 2);
        w.push(1_700_000_000);
        assert_eq!(w.count(1_700_000_049 + 70_010, 3600), 3);
        assert_eq!(w.count(1_700_000_049 + 70_010, 1), 2);
    }

    #[test]
    fn duplicates_compare_the_normalized_text() {
        let mut w = Texts::default();
        assert!(!w.duplicates(100, "Free Nitro!", 2, 30));
        assert!(!w.duplicates(101, "free  nitro!", 2, 30));
        assert!(w.duplicates(102, "ＦＲＥＥ nitro!", 2, 30));
        assert!(!w.duplicates(103, "something else", 2, 30));
        assert!(!w.duplicates(140, "free nitro!", 2, 30));
        assert_eq!(text_hash("free nitro!"), text_hash("free nitro!"));
        assert_ne!(text_hash("free nitro!"), text_hash("free nitro?"));
        assert_eq!(text_hash(""), 0x811c_9dc5);
    }

    #[test]
    fn duplicates_keep_the_last_10_hashes() {
        let mut w = Texts::default();
        w.duplicates(100, "first", 9, 3600);
        for i in 0..10 {
            w.duplicates(101 + i, &format!("other {i}"), 9, 3600);
        }
        assert_eq!(w.len(), TEXTS_KEPT);
        assert!(!w.duplicates(120, "first", 1, 3600));
        assert!(w.duplicates(121, "first", 1, 3600));
    }

    #[test]
    fn join_rate_counts_joins_in_the_window() {
        let mut j = Joins::default();
        for t in 0..10 {
            assert!(!j.rate(1000 + t, 10, 30));
        }
        assert!(j.rate(1010, 10, 30));
        assert!(!j.rate(1041, 10, 30));
        for t in 0..600 {
            j.push(2000 + t / 100);
        }
        assert_eq!(j.len(), JOINS_KEPT);
        assert_eq!(j.count(2005, 30), 500);
    }

    #[test]
    fn cooldowns_run_per_member_channel_and_server() {
        let mut c = Cooldowns::default();
        let member = cooldown_key(7, Per::Member, "bob", 4);
        let other = cooldown_key(7, Per::Member, "carol", 4);
        let channel = cooldown_key(7, Per::Channel, "bob", 4);
        let server = cooldown_key(7, Per::Server, "bob", 4);
        assert_eq!(member, "7:m:bob");
        assert_eq!(channel, "7:c:4");
        assert_eq!(server, "7:s");
        assert_eq!(cooldown_key(7, Per::Channel, "carol", 4), channel);
        assert!(c.ready(&member, 100, 60));
        c.ran(&member, 100);
        assert!(!c.ready(&member, 159, 60));
        assert!(c.ready(&member, 160, 60));
        assert!(c.ready(&other, 101, 60));
        assert!(c.take(&channel, 100, 60));
        assert!(!c.take(&channel, 130, 60));
        assert!(c.take(&channel, 160, 60));
        assert!(!c.take(&channel, 219, 60));
        assert!(c.take(&server, 100, 60));
        c.forget_before(150);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn the_staff_action_rate_counts_what_staff_safety_counts() {
        use crate::safety::{AuditEntry, StaffAction};
        let entry = |actor: &str, at: i64| AuditEntry {
            actor: actor.into(),
            action: StaffAction::Ban,
            automation_id: None,
            target_joined_at: Some(0),
            at,
        };
        let now = 200_000;
        let entries: Vec<AuditEntry> = (0..6).map(|i| entry("alice", now - 10 * i)).collect();
        assert!(staff_action_rate(&entries, "alice", None, 5, 2, now));
        assert!(!staff_action_rate(&entries, "alice", None, 6, 2, now));
        assert!(!staff_action_rate(&entries, "bob", None, 5, 2, now));
        assert!(!staff_action_rate(&entries, "alice", Some(now), 5, 2, now));
        let old: Vec<AuditEntry> = (0..6).map(|_| entry("alice", now - 121)).collect();
        assert!(!staff_action_rate(&old, "alice", None, 5, 2, now));
    }
}
