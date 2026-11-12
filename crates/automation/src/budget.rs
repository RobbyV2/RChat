//! Loop protection and caps: cause chains, the fan-out cap, buckets, merged punishments and
//! gathered cards. Times are in milliseconds.

use std::collections::{BTreeMap, BTreeSet, HashSet};

pub const MAX_DEPTH: usize = 3;
pub const JOBS_PER_EVENT: usize = 20;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Skip {
    Itself,
    Depth,
}

/// Whether automation `id` may fire on an event whose cause chain is `chain`.
pub fn may_fire(chain: &[i64], id: i64) -> Option<Skip> {
    if chain.contains(&id) {
        return Some(Skip::Itself);
    }
    if chain.len() >= MAX_DEPTH {
        return Some(Skip::Depth);
    }
    None
}

/// The chain an action of `id` gives the events it causes.
pub fn extend(chain: &[i64], id: i64) -> Vec<i64> {
    chain.iter().copied().chain([id]).collect()
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FanOut {
    pub run: Vec<i64>,
    pub skipped: Vec<i64>,
}

/// The automations one event may enqueue: those whose trigger and channel scope match, in id
/// order, at most `cap`. The rest are recorded as skipped.
pub fn fan_out(ids: &[i64], cap: usize, matches: impl Fn(i64) -> bool) -> FanOut {
    let mut run: Vec<i64> = ids.iter().copied().filter(|&id| matches(id)).collect();
    run.sort_unstable();
    let skipped = run.split_off(cap.min(run.len()));
    FanOut { run, skipped }
}

/// A token bucket of `per_minute` tokens, full at the start.
#[derive(Clone, Debug)]
pub struct Bucket {
    per_minute: f64,
    tokens: f64,
    at: i64,
}

impl Bucket {
    pub fn new(per_minute: u32, now: i64) -> Bucket {
        Bucket {
            per_minute: f64::from(per_minute),
            tokens: f64::from(per_minute),
            at: now,
        }
    }

    pub fn take(&mut self, now: i64) -> bool {
        let gained = (now - self.at) as f64 * self.per_minute / 60_000.0;
        self.tokens = self.per_minute.min(self.tokens + gained);
        self.at = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

pub fn automation_rate(server_per_minute: u32) -> u32 {
    (server_per_minute / 10).max(60)
}

/// An automation refused in each of 5 consecutive minutes pauses itself.
#[derive(Default, Debug)]
pub struct Pauser {
    minutes: BTreeSet<i64>,
}

impl Pauser {
    pub fn refused(&mut self, now: i64) -> bool {
        let m = now.div_euclid(60_000);
        self.minutes.insert(m);
        self.minutes.retain(|&old| old >= m - 4);
        (m - 4..=m).all(|k| self.minutes.contains(&k))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Guard,
    GuardPosting,
    Moderation,
    Posting,
}

const PUNISH: [&str; 6] = ["ban", "kick", "timeout", "hold", "quarantine", "block"];
const GATHER: [&str; 3] = ["log", "alert", "report"];
const POSTING: [&str; 9] = [
    "send_message",
    "reply",
    "react",
    "start_thread",
    "rename_channel",
    "post_panel",
    "repost",
    "sticky",
    "post_giveaway",
];

/// How an automation's jobs are metered: one that posts is bucketed and pauses after 5 refused
/// minutes, a guard that posts is bucketed but never pauses, a guard's verdict and its other
/// actions are never metered, and anything else merges per target and never pauses.
pub fn kind_of(guard: bool, actions: &[&str]) -> Kind {
    match (guard, actions.iter().any(|a| POSTING.contains(a))) {
        (true, true) => Kind::GuardPosting,
        (false, true) => Kind::Posting,
        (true, false) => Kind::Guard,
        (false, false) => Kind::Moderation,
    }
}

pub fn is_punishment(action: &str) -> bool {
    PUNISH.contains(&action)
}

pub fn is_gathered(action: &str) -> bool {
    GATHER.contains(&action)
}

/// The dedupe key that merges punishments per automation, target and minute.
pub fn merge_key(automation: i64, target: &str, now: i64) -> String {
    format!("{automation}:{target}:{}", now.div_euclid(60_000))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Admit {
    Run,
    Wait,
    Refuse,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Punish {
    Run,
    Merged,
}

/// One automation's bucket, pause state and the merge keys it has seen.
#[derive(Debug)]
pub struct Meter {
    id: i64,
    kind: Kind,
    bucket: Bucket,
    pauser: Pauser,
    keys: HashSet<String>,
    paused: bool,
}

impl Meter {
    pub fn new(id: i64, kind: Kind, per_minute: u32, now: i64) -> Meter {
        Meter {
            id,
            kind,
            bucket: Bucket::new(per_minute, now),
            pauser: Pauser::default(),
            keys: HashSet::new(),
            paused: false,
        }
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    pub fn paused(&self) -> bool {
        self.paused
    }

    /// A punishment for `target`: merged per minute, never refused.
    pub fn punish(&mut self, target: &str, now: i64) -> Punish {
        match self.keys.insert(merge_key(self.id, target, now)) {
            true => Punish::Run,
            false => Punish::Merged,
        }
    }

    /// A run of a posting automation, against its own bucket and the server's. A guard is
    /// refused past its bucket but never pauses.
    pub fn post(&mut self, server: &mut Bucket, now: i64) -> Admit {
        if self.paused {
            return Admit::Refuse;
        }
        if !self.bucket.take(now) {
            self.paused = match self.kind {
                Kind::GuardPosting => false,
                Kind::Guard | Kind::Moderation | Kind::Posting => self.pauser.refused(now),
            };
            return Admit::Refuse;
        }
        match server.take(now) {
            true => Admit::Run,
            false => Admit::Wait,
        }
    }
}

/// The server's bucket makes a job wait; the automation's refuses it.
pub fn admit(server: &mut Bucket, automation: &mut Bucket, now: i64) -> Admit {
    if !automation.take(now) {
        return Admit::Refuse;
    }
    match server.take(now) {
        true => Admit::Run,
        false => Admit::Wait,
    }
}

pub const CARD_ITEMS: usize = 10;
pub const RUN_IDS: usize = 500;

/// One gathered card: every log, alert or report entry of one automation for one target within a
/// minute, with the first items shown and the ids kept for the run history.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Card {
    pub automation: i64,
    pub target: String,
    pub minute: i64,
    pub count: u64,
    pub items: Vec<String>,
    pub ids: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Gathered {
    NewCard,
    Joined,
    Summarized,
}

/// Gathers entries into cards. Past `per_minute` cards for one automation in a minute, one
/// summary counts the rest. Nothing is dropped and nothing is refused.
#[derive(Debug)]
pub struct Gatherer {
    per_minute: u64,
    cards: BTreeMap<(i64, i64, String), Card>,
    per_auto: BTreeMap<(i64, i64), u64>,
    summaries: BTreeMap<(i64, i64), u64>,
}

impl Gatherer {
    pub fn new(per_minute: u64) -> Gatherer {
        Gatherer {
            per_minute,
            cards: BTreeMap::new(),
            per_auto: BTreeMap::new(),
            summaries: BTreeMap::new(),
        }
    }

    pub fn add(&mut self, automation: i64, target: &str, item: &str, now: i64) -> Gathered {
        let minute = now.div_euclid(60_000);
        if let Some(card) = self
            .cards
            .get_mut(&(automation, minute, target.to_string()))
        {
            card.count += 1;
            if card.items.len() < CARD_ITEMS {
                card.items.push(item.to_string());
            }
            if card.ids.len() < RUN_IDS {
                card.ids.push(item.to_string());
            }
            return Gathered::Joined;
        }
        let made = self.per_auto.entry((automation, minute)).or_default();
        if *made >= self.per_minute {
            *self.summaries.entry((automation, minute)).or_default() += 1;
            return Gathered::Summarized;
        }
        *made += 1;
        self.cards.insert(
            (automation, minute, target.to_string()),
            Card {
                automation,
                target: target.to_string(),
                minute,
                count: 1,
                items: vec![item.to_string()],
                ids: vec![item.to_string()],
            },
        );
        Gathered::NewCard
    }

    pub fn all(&self) -> Vec<&Card> {
        self.cards.values().collect()
    }

    /// The entries each summary card stands for, by automation and minute.
    pub fn summaries(&self) -> &BTreeMap<(i64, i64), u64> {
        &self.summaries
    }

    /// Every entry, in a card's count or in a summary.
    pub fn total(&self) -> u64 {
        self.cards.values().map(|c| c.count).sum::<u64>() + self.summaries.values().sum::<u64>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loop_of_two_automations_stops_at_depth_3_and_nothing_fires_on_itself() {
        let mut chain: Vec<i64> = Vec::new();
        let mut fired = Vec::new();
        for i in 0..10 {
            let id = if i % 2 == 0 { 1 } else { 2 };
            if may_fire(&chain, id).is_some() {
                break;
            }
            fired.push(id);
            chain = extend(&chain, id);
        }
        assert_eq!(fired, [1, 2]);
        assert_eq!(may_fire(&[1, 2], 1), Some(Skip::Itself));
        assert_eq!(may_fire(&[1, 2, 3], 4), Some(Skip::Depth));
        assert_eq!(may_fire(&[1, 2], 3), None);
    }

    #[test]
    fn a_bucket_refills_at_its_rate() {
        let mut b = Bucket::new(60, 0);
        for _ in 0..60 {
            assert!(b.take(0));
        }
        assert!(!b.take(0));
        assert!(b.take(1000));
        assert!(!b.take(1000));
    }

    #[test]
    fn per_automation_is_a_tenth_of_the_server_at_least_60() {
        assert_eq!(automation_rate(600), 60);
        assert_eq!(automation_rate(6000), 600);
        assert_eq!(automation_rate(10), 60);
    }

    #[test]
    fn the_server_bucket_makes_jobs_wait_and_the_automation_bucket_refuses() {
        let mut server = Bucket::new(1, 0);
        assert_eq!(admit(&mut server, &mut Bucket::new(60, 0), 0), Admit::Run);
        assert_eq!(admit(&mut server, &mut Bucket::new(60, 0), 0), Admit::Wait);
        let mut a = Bucket::new(1, 0);
        a.take(0);
        assert_eq!(admit(&mut Bucket::new(600, 0), &mut a, 0), Admit::Refuse);
    }

    #[test]
    fn refused_in_5_minutes_in_a_row_pauses() {
        let mut p = Pauser::default();
        assert!(!p.refused(0));
        assert!(!p.refused(60_000));
        assert!(!p.refused(120_000));
        assert!(!p.refused(180_000));
        assert!(p.refused(240_000));
        let mut q = Pauser::default();
        for t in [0, 60_000, 180_000, 240_000] {
            q.refused(t);
        }
        assert!(!q.refused(300_000));
    }

    #[test]
    fn honeypot_500_posts_in_a_minute_give_500_verdicts_one_ban_per_member_and_no_pause() {
        let kind = kind_of(true, &["block", "ban", "alert"]);
        assert_eq!(kind, Kind::Guard);
        let mut honeypot = Meter::new(7, kind, 60, 0);
        let mut verdicts = 0;
        let mut bans = 0;
        for i in 0..500 {
            verdicts += 1;
            let member = format!("raider{}", i % 150);
            if honeypot.punish(&member, i * 100) == Punish::Run {
                bans += 1;
            }
        }
        assert_eq!(verdicts, 500);
        assert_eq!(bans, 150);
        assert!(!honeypot.paused());
    }

    #[test]
    fn moderation_reactions_merge_per_target_and_never_pause() {
        let kind = kind_of(false, &["timeout", "alert"]);
        assert_eq!(kind, Kind::Moderation);
        let mut moderation = Meter::new(8, kind, 60, 0);
        assert_eq!(moderation.punish("bob", 0), Punish::Run);
        assert_eq!(moderation.punish("bob", 30_000), Punish::Merged);
        assert_eq!(moderation.punish("bob", 60_000), Punish::Run);
        assert_eq!(merge_key(8, "bob", 60_000), "8:bob:1");
    }

    #[test]
    fn a_posting_automation_pauses_after_5_refused_minutes() {
        let kind = kind_of(false, &["send_message"]);
        assert_eq!(kind, Kind::Posting);
        let mut welcome = Meter::new(9, kind, 1, 0);
        let mut server = Bucket::new(100_000, 0);
        let mut refused = 0;
        for minute in 0..5 {
            for k in 0..3 {
                if welcome.post(&mut server, minute * 60_000 + k) == Admit::Refuse {
                    refused += 1;
                }
            }
        }
        assert!(refused > 0);
        assert!(welcome.paused());
        assert_eq!(welcome.post(&mut server, 10 * 60_000), Admit::Refuse);
    }

    #[test]
    fn every_posting_action_is_bucketed() {
        for a in [
            "send_message",
            "reply",
            "react",
            "start_thread",
            "rename_channel",
            "post_panel",
            "repost",
            "sticky",
            "post_giveaway",
        ] {
            assert_eq!(kind_of(false, &[a]), Kind::Posting, "{a}");
        }
        assert_eq!(
            kind_of(false, &["log", "alert", "report"]),
            Kind::Moderation
        );
    }

    #[test]
    fn a_guard_that_posts_is_bucketed_but_a_raid_never_pauses_it() {
        assert_eq!(kind_of(true, &["block", "reply"]), Kind::GuardPosting);
        assert_eq!(kind_of(true, &["timeout", "reply"]), Kind::GuardPosting);
        assert_eq!(kind_of(true, &["send_message"]), Kind::GuardPosting);
        assert_eq!(
            kind_of(true, &["block", "ban", "log", "alert"]),
            Kind::Guard
        );
        assert_eq!(kind_of(true, &[]), Kind::Guard);
        let mut guard = Meter::new(10, kind_of(true, &["timeout", "reply"]), 60, 0);
        let mut server = Bucket::new(100_000, 0);
        let mut refused = 0;
        for minute in 0..10 {
            for i in 0..120 {
                if guard.post(&mut server, minute * 60_000 + i * 500) == Admit::Refuse {
                    refused += 1;
                }
            }
            assert!(!guard.paused(), "minute {minute}");
        }
        assert!(refused >= 500, "{refused}");
        assert_eq!(guard.post(&mut server, 11 * 60_000), Admit::Run);
        assert_eq!(guard.punish("bob", 11 * 60_000), Punish::Run);
    }

    #[test]
    fn one_event_creates_at_most_20_jobs_in_id_order() {
        let ids: Vec<i64> = (0..30).map(|i| 30 - i).collect();
        let out = fan_out(&ids, JOBS_PER_EVENT, |_| true);
        assert_eq!(out.run, (1..=20).collect::<Vec<i64>>());
        assert_eq!(out.skipped.len(), 10);
    }

    #[test]
    fn log_alert_and_report_are_gathered_not_merged() {
        for a in ["log", "alert", "report"] {
            assert!(is_gathered(a));
            assert!(!is_punishment(a));
        }
        for a in ["ban", "kick", "timeout", "hold", "quarantine"] {
            assert!(is_punishment(a));
            assert!(!is_gathered(a));
        }
    }

    #[test]
    fn a_spammers_20_deleted_messages_give_one_card_with_count_20_and_10_items() {
        let mut g = Gatherer::new(60);
        for i in 0..20 {
            let state = g.add(3, "spammer", &format!("msg{i}"), 1000 + i);
            assert_eq!(
                state,
                if i == 0 {
                    Gathered::NewCard
                } else {
                    Gathered::Joined
                }
            );
        }
        let cards = g.all();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].count, 20);
        assert_eq!(cards[0].items.len(), 10);
        assert_eq!(cards[0].ids.len(), 20);
        assert_eq!(cards[0].items[9], "msg9");
    }

    #[test]
    fn the_id_list_stops_at_500_and_the_count_goes_on() {
        let mut g = Gatherer::new(60);
        for i in 0..600 {
            g.add(3, "spammer", &format!("msg{i}"), 0);
        }
        let cards = g.all();
        assert_eq!(cards[0].count, 600);
        assert_eq!(cards[0].ids.len(), RUN_IDS);
        assert_eq!(g.total(), 600);
    }

    #[test]
    fn five_hundred_joiners_give_60_cards_and_one_summary_all_accounted_for() {
        let mut g = Gatherer::new(60);
        for i in 0..500 {
            g.add(4, &format!("joiner{i}"), &format!("join{i}"), 5000);
        }
        assert_eq!(g.all().len(), 60);
        assert_eq!(g.summaries().values().copied().collect::<Vec<u64>>(), [440]);
        assert_eq!(g.total(), 500);
        assert_eq!(g.add(4, "late", "join", 65_000), Gathered::NewCard);
    }

    #[test]
    fn the_fan_out_cap_applies_after_the_scope_filter() {
        let ids: Vec<i64> = (1..=25).collect();
        let out = fan_out(&ids, JOBS_PER_EVENT, |id| id == 25);
        assert_eq!(out.run, [25]);
        assert!(out.skipped.is_empty());
    }
}
