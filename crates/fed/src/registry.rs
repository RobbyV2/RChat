use std::collections::{BTreeMap, HashMap};

use crate::health::{BlockDir, Dir, Event, Gate, Host, KeyRec, Why, fresh, gate, halted_dir, step};
use crate::levels::Service;
use crate::limits::{established as defaults, strikes};
use crate::negotiate::Caps;
pub use crate::psl::{List, registrable};

const DAY: i64 = 86_400;

pub fn budget_domain(host: &str, cold: bool) -> &str {
    let list = match cold {
        true => List::Icann,
        false => List::Full,
    };
    registrable(host, list)
}

pub fn fair_shares(cap: f64, demands: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; demands.len()];
    let mut left = cap;
    let mut open: Vec<usize> = (0..demands.len()).filter(|i| demands[*i] > 0.0).collect();
    while !open.is_empty() && left > 1e-9 {
        let each = left / open.len() as f64;
        let (small, rest): (Vec<usize>, Vec<usize>) =
            open.iter().partition(|i| demands[**i] - out[**i] <= each);
        if small.is_empty() {
            for i in &open {
                out[*i] += each;
            }
            break;
        }
        for i in small {
            left -= demands[i] - out[i];
            out[i] = demands[i];
        }
        open = rest;
    }
    out
}

pub fn budgets_fit(total: u32, budgets: &BTreeMap<Service, u32>) -> bool {
    budgets.values().map(|v| u64::from(*v)).sum::<u64>() <= u64::from(total)
}

pub fn fit_budgets(total: u32, budgets: &BTreeMap<Service, u32>) -> BTreeMap<Service, u32> {
    let sum: u64 = budgets.values().map(|v| u64::from(*v)).sum();
    if sum <= u64::from(total) {
        return budgets.clone();
    }
    budgets
        .iter()
        .map(|(svc, v)| (*svc, (u64::from(*v) * u64::from(total) / sum) as u32))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pin {
    Warm,
    Cold,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Warmth {
    pub first_seen: i64,
    pub last_local: Option<i64>,
    pub cooling_until: Option<i64>,
    pub pin: Option<Pin>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostWriter {
    pub host: String,
    pub username: String,
    pub since: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EstablishedRule {
    pub writers: usize,
    pub after_days: i64,
    pub decay_days: i64,
}

impl Default for EstablishedRule {
    fn default() -> EstablishedRule {
        EstablishedRule {
            writers: defaults::WRITERS,
            after_days: defaults::AFTER_DAYS,
            decay_days: defaults::DECAY_DAYS,
        }
    }
}

pub fn established(row: &Warmth, writers: usize, now: i64, rule: &EstablishedRule) -> bool {
    let Warmth {
        first_seen,
        last_local,
        cooling_until,
        pin,
    } = row;
    match pin {
        Some(Pin::Warm) => true,
        Some(Pin::Cold) => false,
        None => {
            !cooling_until.is_some_and(|until| now < until)
                && writers >= rule.writers
                && now - first_seen >= rule.after_days * DAY
                && last_local.is_some_and(|at| now - at <= rule.decay_days * DAY)
        }
    }
}

pub trait WarmthStore {
    fn warmth(&self, host: &str) -> Option<Warmth>;
    fn writers(&self, host: &str) -> usize;
    fn first_seen(&mut self, host: &str, now: i64);
    fn add_writer(&mut self, writer: HostWriter);
    fn set_last_local(&mut self, host: &str, at: i64);
    fn set_cooling(&mut self, host: &str, until: i64);
    fn set_pin(&mut self, host: &str, pin: Option<Pin>);
}

#[derive(Clone, Debug, Default)]
pub struct MemoryWarmth {
    hosts: HashMap<String, Warmth>,
    writers: BTreeMap<(String, String), i64>,
}

impl MemoryWarmth {
    pub fn writer_rows(&self, host: &str) -> Vec<HostWriter> {
        self.writers
            .iter()
            .filter(|((of, _), _)| of == host)
            .map(|((host, username), since)| HostWriter {
                host: host.clone(),
                username: username.clone(),
                since: *since,
            })
            .collect()
    }

    fn change(&mut self, host: &str, change: impl FnOnce(&mut Warmth)) {
        if let Some(row) = self.hosts.get_mut(host) {
            change(row);
        }
    }
}

impl WarmthStore for MemoryWarmth {
    fn warmth(&self, host: &str) -> Option<Warmth> {
        self.hosts.get(host).copied()
    }

    fn writers(&self, host: &str) -> usize {
        self.writers.keys().filter(|(of, _)| of == host).count()
    }

    fn first_seen(&mut self, host: &str, now: i64) {
        self.hosts.entry(host.to_string()).or_insert(Warmth {
            first_seen: now,
            last_local: None,
            cooling_until: None,
            pin: None,
        });
    }

    fn add_writer(&mut self, writer: HostWriter) {
        let HostWriter {
            host,
            username,
            since,
        } = writer;
        self.writers.entry((host, username)).or_insert(since);
    }

    fn set_last_local(&mut self, host: &str, at: i64) {
        self.change(host, |row| row.last_local = Some(at));
    }

    fn set_cooling(&mut self, host: &str, until: i64) {
        self.change(host, |row| row.cooling_until = Some(until));
    }

    fn set_pin(&mut self, host: &str, pin: Option<Pin>) {
        self.change(host, |row| row.pin = pin);
    }
}

fn links(rec: &KeyRec) -> bool {
    rec.proven && !rec.retired && !rec.seal_only
}

pub fn are_siblings(a: &Host, b: &Host) -> bool {
    a.host != b.host
        && a.keys
            .iter()
            .any(|(kid, rec)| links(rec) && b.keys.get(kid).is_some_and(links))
}

pub fn sibling_gate<'a>(
    own: Gate,
    siblings: impl IntoIterator<Item = &'a Host>,
    svc: Service,
    dir: Dir,
    now: i64,
) -> Gate {
    if !own.go() {
        return own;
    }
    for o in siblings {
        if let Some(halt) = halted_dir(o, dir, now) {
            return Gate::No {
                why: Why::Halted,
                until: Some(halt),
            };
        }
        let paused = o
            .pauses
            .iter()
            .find(|(key, p)| *key == (svc, dir) && now < p.until);
        if let Some((_, p)) = paused {
            return Gate::No {
                why: Why::Paused,
                until: Some(p.until),
            };
        }
        if o.blocked
            .is_some_and(|b| b.dir == BlockDir::Both || dir == Dir::In)
        {
            return Gate::No {
                why: Why::Blocked,
                until: None,
            };
        }
    }
    own
}

fn paused_now(h: &Host, now: i64) -> bool {
    h.pauses.iter().any(|(_, p)| now < p.until)
}

#[derive(Clone, Debug)]
pub struct Fleet<W: WarmthStore = MemoryWarmth> {
    ours: Caps,
    hosts: Vec<Host>,
    index: HashMap<String, usize>,
    pub warmth: W,
    pub rule: EstablishedRule,
}

impl Fleet<MemoryWarmth> {
    pub fn new(ours: Caps) -> Fleet<MemoryWarmth> {
        Fleet::with_store(ours, MemoryWarmth::default(), EstablishedRule::default())
    }
}

impl<W: WarmthStore> Fleet<W> {
    pub fn with_store(ours: Caps, warmth: W, rule: EstablishedRule) -> Fleet<W> {
        Fleet {
            ours,
            hosts: Vec::new(),
            index: HashMap::new(),
            warmth,
            rule,
        }
    }

    pub fn host(&self, host: &str) -> Option<&Host> {
        self.index.get(host).map(|at| &self.hosts[*at])
    }

    fn at(&mut self, host: &str, now: i64) -> usize {
        if let Some(at) = self.index.get(host) {
            return *at;
        }
        let domain = registrable(host, List::Full);
        let in_paused_domain = self
            .hosts
            .iter()
            .any(|o| registrable(&o.host, List::Full) == domain && paused_now(o, now));
        let probation = in_paused_domain.then_some(now + strikes::PROBATION);
        self.hosts.push(fresh(host, probation));
        self.index.insert(host.to_string(), self.hosts.len() - 1);
        self.warmth.first_seen(host, now);
        self.hosts.len() - 1
    }

    pub fn get(&mut self, host: &str, now: i64) -> &Host {
        let at = self.at(host, now);
        &self.hosts[at]
    }

    pub fn step(&mut self, host: &str, e: &Event, now: i64) {
        let at = self.at(host, now);
        self.hosts[at] = step(&self.hosts[at], e, now, &self.ours);
    }

    pub fn siblings(&self, host: &str) -> Vec<&Host> {
        let Some(h) = self.host(host) else {
            return Vec::new();
        };
        self.hosts.iter().filter(|o| are_siblings(h, o)).collect()
    }

    pub fn gate(
        &mut self,
        host: &str,
        svc: Service,
        dir: Dir,
        now: i64,
        hello_rev: Option<u64>,
    ) -> Gate {
        let at = self.at(host, now);
        let own = gate(&self.hosts[at], &self.ours, svc, dir, now, hello_rev);
        sibling_gate(own, self.siblings(host), svc, dir, now)
    }

    pub fn established(&self, host: &str, now: i64) -> bool {
        self.warmth
            .warmth(host)
            .is_some_and(|row| established(&row, self.warmth.writers(host), now, &self.rule))
    }

    pub fn is_cold(&self, host: &str, now: i64) -> bool {
        !self.established(host, now)
    }

    pub fn note_local_writer(&mut self, host: &str, username: &str, now: i64) {
        self.warmth.first_seen(host, now);
        self.warmth.add_writer(HostWriter {
            host: host.to_string(),
            username: username.to_string(),
            since: now,
        });
        self.note_local_mail(host, now);
    }

    pub fn note_local_mail(&mut self, host: &str, now: i64) {
        self.warmth.first_seen(host, now);
        let known = self.warmth.warmth(host).and_then(|row| row.last_local);
        self.warmth
            .set_last_local(host, known.map_or(now, |at| at.max(now)));
    }

    pub fn cool(&mut self, host: &str, until: i64) {
        let known = self.warmth.warmth(host).and_then(|row| row.cooling_until);
        self.warmth
            .set_cooling(host, known.map_or(until, |at| at.max(until)));
    }

    pub fn pin(&mut self, host: &str, pin: Option<Pin>, now: i64) {
        self.warmth.first_seen(host, now);
        self.warmth.set_pin(host, pin);
    }
}
