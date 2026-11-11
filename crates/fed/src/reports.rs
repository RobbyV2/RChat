use std::collections::{BTreeMap, BTreeSet, HashMap};

use prost::Message;

use crate::limits::ranges::{NOTE_MAX, REPORT_IDS_MAX};
use crate::pb::{ForwardRequest, ReportKind, ReportReason};

pub const SUBJECT_DAY: usize = 100;
pub const SUBJECT_DOMAIN_DAY: usize = 50;
pub const SUBJECT_HOST_DAY: usize = 20;
pub const PER_HOST_UNCHECKED: usize = 5;
const DAY: i64 = 86_400;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldMessage {
    pub id: String,
    pub author: String,
    pub order: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForwardChoice {
    pub subject: String,
    pub reason: ReportReason,
    pub reported: Vec<String>,
    pub with_earlier: bool,
    pub note: Option<String>,
    pub include_note: bool,
    pub reference: Vec<u8>,
}

pub fn forward_body(c: &ForwardChoice, held: &[HeldMessage]) -> Vec<u8> {
    let ForwardChoice {
        subject,
        reason,
        reported,
        with_earlier,
        note,
        include_note,
        reference,
    } = c;
    let by_subject = || held.iter().filter(|m| m.author == *subject);
    let own: BTreeSet<&str> = by_subject().map(|m| m.id.as_str()).collect();
    let mut taken = BTreeSet::new();
    let mut ids: Vec<&String> = reported
        .iter()
        .filter(|id| own.contains(id.as_str()) && taken.insert(id.as_str()))
        .collect();
    let last = by_subject()
        .filter(|m| taken.contains(m.id.as_str()))
        .map(|m| m.order)
        .max();
    if let (true, Some(last)) = (*with_earlier, last) {
        for m in by_subject().filter(|m| m.order <= last) {
            if taken.insert(m.id.as_str()) {
                ids.push(&m.id);
            }
        }
    }
    let note = match include_note {
        true => note.as_deref().unwrap_or_default(),
        false => "",
    };
    ForwardRequest {
        kind: ReportKind::Letter as i32,
        subject: subject.clone(),
        reason: *reason as i32,
        note: note.chars().take(NOTE_MAX).collect(),
        message_ids: ids.into_iter().take(REPORT_IDS_MAX).cloned().collect(),
        r#ref: reference.clone(),
        ..ForwardRequest::default()
    }
    .encode_to_vec()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldEntry {
    pub author: String,
    pub delivered_to: Vec<String>,
    pub until: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemState {
    Checked,
    NotDeliveredToYou,
    NotFound,
}

pub fn check_items(
    ids: &[String],
    subject: &str,
    caller: &str,
    hold: &BTreeMap<String, HoldEntry>,
    now: i64,
) -> Vec<ItemState> {
    ids.iter()
        .map(|id| match hold.get(id) {
            Some(e) if e.until >= now && e.author == subject => {
                match e.delivered_to.iter().any(|host| host == caller) {
                    true => ItemState::Checked,
                    false => ItemState::NotDeliveredToYou,
                }
            }
            Some(_) | None => ItemState::NotFound,
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Taken {
    Stored,
    Duplicate,
    Dropped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReportBudget {
    pub per_host_day: usize,
    pub per_domain_day: usize,
}

impl Default for ReportBudget {
    fn default() -> ReportBudget {
        ReportBudget {
            per_host_day: 50,
            per_domain_day: 200,
        }
    }
}

type Pair = (String, String);
type Times<K> = HashMap<K, Vec<i64>>;

#[derive(Clone, Debug, Default)]
pub struct ReportIntake {
    budget: ReportBudget,
    stored_host: Times<String>,
    stored_domain: Times<String>,
    subject: Times<String>,
    by_domain: Times<Pair>,
    by_host: Times<Pair>,
    unchecked: Times<String>,
    seen: HashMap<(String, String, Vec<String>), i64>,
}

fn full(times: &mut Vec<i64>, now: i64, max: usize) -> bool {
    times.retain(|t| *t > now - DAY);
    times.len() >= max
}

fn forget<K: std::hash::Hash + Eq>(times: &mut Times<K>, now: i64) {
    times.retain(|_, list| {
        list.retain(|t| *t > now - DAY);
        !list.is_empty()
    });
}

impl ReportIntake {
    pub fn new(budget: ReportBudget) -> ReportIntake {
        ReportIntake {
            budget,
            ..ReportIntake::default()
        }
    }

    pub fn take(
        &mut self,
        subject: &str,
        caller: &str,
        domain: &str,
        states: &[ItemState],
        now: i64,
        checked_ids: &[String],
    ) -> Taken {
        let ReportBudget {
            per_host_day,
            per_domain_day,
        } = self.budget;
        let pair = |with: &str| (subject.to_string(), with.to_string());
        let checked = states.contains(&ItemState::Checked);
        let mut ids = checked_ids.to_vec();
        ids.sort();
        let key = (subject.to_string(), caller.to_string(), ids);
        if checked && self.seen.get(&key).is_some_and(|at| *at > now - DAY) {
            return Taken::Duplicate;
        }
        let mut tiers = vec![
            (
                self.stored_host.entry(caller.to_string()).or_default(),
                per_host_day,
            ),
            (
                self.stored_domain.entry(domain.to_string()).or_default(),
                per_domain_day,
            ),
        ];
        match checked {
            true => tiers.extend([
                (
                    self.by_host.entry(pair(caller)).or_default(),
                    SUBJECT_HOST_DAY,
                ),
                (
                    self.by_domain.entry(pair(domain)).or_default(),
                    SUBJECT_DOMAIN_DAY,
                ),
                (
                    self.subject.entry(subject.to_string()).or_default(),
                    SUBJECT_DAY,
                ),
            ]),
            false => tiers.push((
                self.unchecked.entry(caller.to_string()).or_default(),
                PER_HOST_UNCHECKED,
            )),
        }
        if tiers.iter_mut().any(|(times, max)| full(times, now, *max)) {
            return Taken::Dropped;
        }
        for (times, _) in tiers {
            times.push(now);
        }
        if checked {
            self.seen.insert(key, now);
        }
        Taken::Stored
    }

    pub fn sweep(&mut self, now: i64) {
        self.seen.retain(|_, at| *at > now - DAY);
        forget(&mut self.stored_host, now);
        forget(&mut self.stored_domain, now);
        forget(&mut self.subject, now);
        forget(&mut self.by_domain, now);
        forget(&mut self.by_host, now);
        forget(&mut self.unchecked, now);
    }

    pub fn tracked(&self) -> usize {
        self.seen.len()
            + self.stored_host.len()
            + self.stored_domain.len()
            + self.subject.len()
            + self.by_domain.len()
            + self.by_host.len()
            + self.unchecked.len()
    }
}
