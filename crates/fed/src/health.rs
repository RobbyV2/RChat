use std::collections::{BTreeMap, BTreeSet};

use crate::levels::Service;
use crate::limits::{HOLD_MAX, abuse, circuit, hello, keys, strikes};
use crate::negotiate::{Caps, Gap, service_use};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Dir {
    In,
    Out,
}

pub type Key = (Service, Dir);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseWhy {
    Malformed,
    BadReply,
    Abuse,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pause {
    pub since: i64,
    pub until: i64,
    pub why: PauseWhy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyRec {
    pub first: i64,
    pub call: bool,
    pub retired: bool,
    pub proven: bool,
    pub seal_only: bool,
    pub omitted_since: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingProven {
    pub kid: String,
    pub at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockDir {
    Both,
    In,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Blocked {
    pub since: i64,
    pub dir: BlockDir,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Support {
    Unknown,
    Rchat,
    NoFed,
    NotRchat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TheirPolicy {
    Accepted,
    Refused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Circuit {
    pub fails: u32,
    pub open_since: Option<i64>,
    pub next_probe: i64,
    pub probes: u32,
    pub last_ok: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Probation {
    pub until: i64,
    pub level: u32,
    pub inherited: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AbuseLevel {
    pub until: i64,
    pub level: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViolationCalls {
    pub minute: i64,
    pub n: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Host {
    pub host: String,
    pub keys: BTreeMap<String, KeyRec>,
    pub pending_keys: Option<Vec<String>>,
    pub pending_since: Option<i64>,
    pub pending_proven: Vec<PendingProven>,
    pub id: Option<String>,
    pub id_changed_at: Option<i64>,
    pub blocked: Option<Blocked>,
    pub support: Support,
    pub caps: Option<Caps>,
    pub hello_at: Option<i64>,
    pub hello_rev: u64,
    pub next_hello: i64,
    pub budgets: BTreeMap<Service, u32>,
    pub their_policy: BTreeMap<Service, TheirPolicy>,
    pub their_pause: BTreeMap<Service, i64>,
    pub their_identity: bool,
    pub skew: i64,
    pub unauth_at: Option<i64>,
    pub circuit: Circuit,
    pub strikes: BTreeMap<Key, Vec<(i64, u32)>>,
    pub pauses: Vec<(Key, Pause)>,
    pub probation: BTreeMap<Key, Probation>,
    pub backoff: BTreeMap<Service, i64>,
    pub backoff_since: BTreeMap<Service, i64>,
    pub violation_calls: BTreeMap<Service, ViolationCalls>,
    pub violations: BTreeMap<Service, Vec<i64>>,
    pub holds: BTreeMap<Option<Service>, i64>,
    pub abuse_level: BTreeMap<Service, AbuseLevel>,
    pub third_party: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelloOk {
    pub caps: Caps,
    pub id: String,
    pub rev: u64,
    pub policy: BTreeMap<Service, TheirPolicy>,
    pub their_now: i64,
    pub jwks: Vec<String>,
    pub call_kids: Vec<String>,
    pub endorsed: Vec<String>,
    pub signer: String,
    pub budgets: BTreeMap<Service, u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelloFail {
    Transport,
    NoFed,
    NotRchat,
    Unauthenticated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    Refused,
    Paused,
    Version,
    Identity,
    HelloNeeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrikeWhy {
    Malformed,
    BadOwnSeal,
    BadObject,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    Host,
    Shared,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    Block,
    BlockIn,
    Unblock,
    Retry,
    Trust(String),
    Distrust(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    HelloOk(Box<HelloOk>),
    HelloFail {
        why: HelloFail,
        their_now: Option<i64>,
    },
    OutOk {
        svc: Service,
    },
    OutFail {
        svc: Service,
        unauthenticated: bool,
        their_now: Option<i64>,
    },
    OutRefused {
        svc: Service,
        reason: Refused,
        until: Option<i64>,
    },
    OutLimited {
        svc: Service,
        until: i64,
    },
    OutBusy {
        until: i64,
    },
    OutBadReply {
        svc: Service,
    },
    InOk {
        svc: Service,
        kid: String,
    },
    InStrike {
        svc: Service,
        why: StrikeWhy,
        kid: String,
    },
    InLimited {
        svc: Service,
        retry_after: i64,
        cause: Cause,
    },
    ThirdParty {
        svc: Service,
    },
    Op(Op),
}

const CLOSED: Circuit = Circuit {
    fails: 0,
    open_since: None,
    next_probe: 0,
    probes: 0,
    last_ok: None,
};

pub fn fresh(host: &str, probation: Option<i64>) -> Host {
    let inherited = probation.into_iter().flat_map(|until| {
        Service::ALL.into_iter().flat_map(move |svc| {
            [Dir::In, Dir::Out].map(|dir| {
                let probation = Probation {
                    until,
                    level: 0,
                    inherited: true,
                };
                ((svc, dir), probation)
            })
        })
    });
    Host {
        host: host.to_string(),
        keys: BTreeMap::new(),
        pending_keys: None,
        pending_since: None,
        pending_proven: Vec::new(),
        id: None,
        id_changed_at: None,
        blocked: None,
        support: Support::Unknown,
        caps: None,
        hello_at: None,
        hello_rev: 0,
        next_hello: 0,
        budgets: BTreeMap::new(),
        their_policy: BTreeMap::new(),
        their_pause: BTreeMap::new(),
        their_identity: false,
        skew: 0,
        unauth_at: None,
        circuit: CLOSED,
        strikes: BTreeMap::new(),
        pauses: Vec::new(),
        probation: inherited.collect(),
        backoff: BTreeMap::new(),
        backoff_since: BTreeMap::new(),
        violation_calls: BTreeMap::new(),
        violations: BTreeMap::new(),
        holds: BTreeMap::new(),
        abuse_level: BTreeMap::new(),
        third_party: 0,
    }
}

fn pause_of(h: &Host, key: Key) -> Option<Pause> {
    h.pauses
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, pause)| *pause)
}

fn set_pause(h: &mut Host, key: Key, pause: Pause) {
    match h.pauses.iter_mut().find(|(k, _)| *k == key) {
        Some((_, known)) => *known = pause,
        None => h.pauses.push((key, pause)),
    }
}

fn keep_last<T>(mut list: Vec<T>, max: usize) -> Vec<T> {
    let extra = list.len().saturating_sub(max);
    list.drain(..extra);
    list
}

fn signed_by(h: &mut Host, kid: &str, now: i64, lists_itself_as_call_key: bool) -> bool {
    if h.keys.is_empty() {
        let first = KeyRec {
            first: now,
            call: true,
            retired: false,
            proven: false,
            seal_only: false,
            omitted_since: None,
        };
        h.keys.insert(kid.to_string(), first);
    }
    if let Some(rec) = h.keys.get_mut(kid)
        && !rec.retired
        && !rec.seal_only
    {
        rec.proven = true;
        h.pending_keys = None;
        h.pending_since = None;
        h.pending_proven = Vec::new();
        return true;
    }
    let mut pending = h.pending_keys.take().unwrap_or_default();
    pending.retain(|k| k != kid);
    pending.push(kid.to_string());
    let pending = keep_last(pending, keys::PENDING_MAX);
    if lists_itself_as_call_key {
        h.pending_proven.retain(|p| p.kid != kid);
        h.pending_proven.push(PendingProven {
            kid: kid.to_string(),
            at: now,
        });
        h.pending_proven = keep_last(std::mem::take(&mut h.pending_proven), keys::PENDING_MAX);
    }
    h.pending_proven.retain(|p| pending.contains(&p.kid));
    h.pending_keys = Some(pending);
    if h.pending_since.is_none() {
        h.pending_since = Some(now);
        h.next_hello = now + hello::RECHECK;
    }
    false
}

fn ok(h: &mut Host, now: i64) {
    h.circuit = Circuit {
        last_ok: Some(now),
        ..CLOSED
    };
    h.unauth_at = None;
}

fn doubled(base: i64, level: u32, max: i64) -> i64 {
    base.saturating_mul(2i64.saturating_pow(level)).min(max)
}

fn pause_for(h: &mut Host, key: Key, why: PauseWhy, now: i64) {
    let level = match h.probation.get(&key) {
        Some(prob) if now < prob.until => match prob.inherited && pause_of(h, key).is_none() {
            true => 0,
            false => prob.level + 1,
        },
        Some(_) | None => 0,
    };
    let cooldown = doubled(strikes::COOLDOWN, level, strikes::COOLDOWN_MAX);
    let pause = Pause {
        since: now,
        until: now + cooldown,
        why,
    };
    set_pause(h, key, pause);
    h.strikes.insert(key, Vec::new());
    let probation = Probation {
        until: now + cooldown + strikes::PROBATION,
        level,
        inherited: false,
    };
    h.probation.insert(key, probation);
}

fn strike(h: &mut Host, key: Key, weight: u32, why: PauseWhy, now: i64) {
    let paused = pause_of(h, key);
    if paused.is_some_and(|p| now < p.until) {
        return;
    }
    if let Some(prob) = h.probation.get(&key)
        && now < prob.until
        && (paused.is_some() || prob.inherited)
    {
        return pause_for(h, key, why, now);
    }
    let list = h.strikes.entry(key).or_default();
    list.retain(|(t, _)| *t > now - strikes::WINDOW);
    list.push((now, weight));
    if list.iter().map(|(_, w)| w).sum::<u32>() >= strikes::PAUSE_AT {
        pause_for(h, key, why, now);
    }
}

fn failed(mut h: Host, now: i64, unauthenticated: bool, their_now: Option<i64>) -> Host {
    if let Some(their_now) = their_now {
        h.skew = their_now.saturating_sub(now);
    }
    if unauthenticated {
        h.unauth_at = Some(now);
    }
    let c = &mut h.circuit;
    c.fails += 1;
    match c.open_since {
        None if c.fails >= circuit::FAILS => {
            c.open_since = Some(now);
            c.probes = 0;
            c.next_probe = now + circuit::PROBES[0];
        }
        None => {}
        Some(_) => {
            c.probes += 1;
            let at = (c.probes as usize).min(circuit::PROBES.len() - 1);
            c.next_probe = now + circuit::PROBES[at];
        }
    }
    h
}

fn hello_ok(prev: &Host, e: &HelloOk, now: i64, ours: &Caps) -> Host {
    let HelloOk {
        caps,
        id,
        rev,
        policy,
        their_now,
        jwks,
        call_kids,
        endorsed,
        signer,
        budgets,
    } = e;
    let mut h = prev.clone();
    let served: BTreeSet<&str> = jwks.iter().map(String::as_str).collect();
    let calls: BTreeSet<&str> = call_kids.iter().map(String::as_str).collect();
    let listed = |kid: &str| served.contains(kid) && calls.contains(kid);
    if !listed(signer) {
        return failed(h, now, true, Some(*their_now));
    }
    h.support = Support::Rchat;
    if h.keys.is_empty() {
        let (first, rest): (Vec<&String>, Vec<&String>) = jwks.iter().partition(|kid| listed(kid));
        for kid in first.into_iter().chain(rest).take(keys::REMEMBERED_MAX) {
            let rec = KeyRec {
                first: now,
                call: listed(kid),
                retired: false,
                proven: false,
                seal_only: !listed(kid),
                omitted_since: None,
            };
            h.keys.insert(kid.clone(), rec);
        }
    }
    for kid in endorsed.iter().filter(|kid| served.contains(kid.as_str())) {
        let room = h.keys.len() < keys::REMEMBERED_MAX;
        match h.keys.get_mut(kid) {
            Some(rec) if !rec.retired => rec.seal_only = false,
            Some(_) => {}
            None if room => {
                let rec = KeyRec {
                    first: now,
                    call: calls.contains(kid.as_str()),
                    retired: false,
                    proven: false,
                    seal_only: false,
                    omitted_since: None,
                };
                h.keys.insert(kid.clone(), rec);
            }
            None => {}
        }
    }
    let signer_was_current = prev
        .keys
        .get(signer)
        .is_some_and(|rec| rec.call && !rec.retired && !rec.seal_only);
    if !signed_by(&mut h, signer, now, true) {
        return h;
    }
    for (kid, rec) in h.keys.iter_mut().filter(|(_, rec)| !rec.retired) {
        if listed(kid) {
            if !rec.seal_only {
                rec.call = true;
            }
            rec.omitted_since = None;
        } else if rec.call && signer_was_current {
            let since = *rec.omitted_since.get_or_insert(now);
            if now - since >= keys::RETIRE_AFTER {
                rec.retired = true;
                rec.call = false;
                rec.omitted_since = None;
            }
        }
    }
    if h.id.as_ref().is_some_and(|known| known != id) {
        h.id_changed_at = Some(now);
    }
    h.id = Some(id.clone());
    h.caps = Some(caps.clone());
    h.hello_at = Some(now);
    h.hello_rev = *rev;
    h.budgets = budgets.clone();
    h.their_policy = policy.clone();
    h.their_pause = BTreeMap::new();
    h.their_identity = false;
    h.skew = their_now.saturating_sub(now);
    ok(&mut h, now);
    let used = Service::ALL
        .iter()
        .all(|s| service_use(s.needs(), ours, caps).is_ok());
    let refused = policy.values().any(|p| *p == TheirPolicy::Refused);
    h.next_hello = now
        + match used && !refused {
            true => hello::TTL,
            false => hello::RECHECK,
        };
    h
}

fn in_limited(prev: &Host, svc: Service, retry_after: i64, now: i64) -> Host {
    let mut h = prev.clone();
    let key = (svc, Dir::In);
    let until = match h.backoff.get(&svc) {
        Some(until) if now < *until => *until,
        Some(_) | None => {
            h.backoff.insert(svc, now + retry_after);
            h.backoff_since.insert(svc, now);
            return h;
        }
    };
    h.backoff.insert(svc, until.max(now + retry_after));
    if pause_of(&h, key).is_some_and(|p| now < p.until) {
        return h;
    }
    if now < h.backoff_since.get(&svc).copied().unwrap_or(now) + abuse::GRACE {
        return h;
    }
    let minute = now.div_euclid(60);
    let n = match h.violation_calls.get(&svc) {
        Some(calls) if calls.minute == minute => calls.n + 1,
        Some(_) | None => 1,
    };
    h.violation_calls.insert(svc, ViolationCalls { minute, n });
    if n != abuse::CALLS_PER_MINUTE {
        return h;
    }
    let list = h.violations.entry(svc).or_default();
    list.retain(|m| *m > minute - abuse::WINDOW / 60);
    if !list.contains(&minute) {
        list.push(minute);
    }
    if list.len() >= abuse::MINUTES {
        list.clear();
        let level = match h.abuse_level.get(&svc) {
            Some(known) if now < known.until => known.level + 1,
            Some(_) | None => 0,
        };
        let cooldown = doubled(abuse::COOLDOWN, level, abuse::COOLDOWN_MAX);
        let pause = Pause {
            since: now,
            until: now + cooldown,
            why: PauseWhy::Abuse,
        };
        set_pause(&mut h, key, pause);
        let known = AbuseLevel {
            until: now + cooldown + abuse::COOLDOWN_MAX,
            level,
        };
        h.abuse_level.insert(svc, known);
    }
    h
}

fn operator(prev: &Host, op: &Op, now: i64) -> Host {
    let mut h = prev.clone();
    match op {
        Op::Block | Op::BlockIn => {
            let dir = match op {
                Op::Block => BlockDir::Both,
                _ => BlockDir::In,
            };
            h.blocked = Some(Blocked { since: now, dir });
        }
        Op::Unblock => {
            h.blocked = None;
            h.next_hello = now;
        }
        Op::Retry => {
            h.pauses = Vec::new();
            h.strikes = BTreeMap::new();
            h.probation = BTreeMap::new();
            h.violations = BTreeMap::new();
            h.violation_calls = BTreeMap::new();
            h.abuse_level = BTreeMap::new();
            h.backoff = BTreeMap::new();
            h.backoff_since = BTreeMap::new();
            h.their_policy = BTreeMap::new();
            h.their_pause = BTreeMap::new();
            h.their_identity = false;
            h.unauth_at = None;
            h.circuit = Circuit {
                last_ok: prev.circuit.last_ok,
                ..CLOSED
            };
            h.next_hello = now;
        }
        Op::Trust(kid) => {
            let proven = h
                .pending_proven
                .iter()
                .any(|p| p.kid == *kid && now - p.at <= hello::TTL);
            if h.pending_keys.is_none() || !proven {
                return h;
            }
            let rec = KeyRec {
                first: h.keys.get(kid).map_or(now, |known| known.first),
                call: true,
                retired: false,
                proven: true,
                seal_only: false,
                omitted_since: None,
            };
            h.keys.insert(kid.clone(), rec);
            h.pending_keys = None;
            h.pending_since = None;
            h.pending_proven = Vec::new();
            h.next_hello = now;
        }
        Op::Distrust(kid) => {
            if let Some(rec) = h.keys.get_mut(kid)
                && !rec.retired
            {
                rec.retired = true;
                rec.call = false;
                rec.omitted_since = None;
            }
        }
    }
    h
}

pub fn step(prev: &Host, e: &Event, now: i64, ours: &Caps) -> Host {
    let mut h = prev.clone();
    match e {
        Event::HelloOk(said) => return hello_ok(prev, said, now, ours),
        Event::HelloFail { why, their_now } => match why {
            HelloFail::Transport => return failed(h, now, false, *their_now),
            HelloFail::Unauthenticated => return failed(h, now, true, *their_now),
            HelloFail::NoFed | HelloFail::NotRchat => {
                h.support = match why {
                    HelloFail::NoFed => Support::NoFed,
                    _ => Support::NotRchat,
                };
                h.caps = None;
                h.next_hello = now + hello::RECHECK_UNSUPPORTED;
                ok(&mut h, now);
            }
        },
        Event::OutOk { svc: _ } => ok(&mut h, now),
        Event::OutFail {
            svc: _,
            unauthenticated,
            their_now,
        } => return failed(h, now, *unauthenticated, *their_now),
        Event::OutRefused { svc, reason, until } => {
            ok(&mut h, now);
            match reason {
                Refused::Refused => {
                    h.their_policy.insert(*svc, TheirPolicy::Refused);
                    h.next_hello = now + hello::RECHECK;
                }
                Refused::Paused => {
                    let until = until.unwrap_or(now + strikes::COOLDOWN);
                    h.their_pause
                        .insert(*svc, until.min(now + abuse::COOLDOWN_MAX));
                }
                Refused::Version | Refused::HelloNeeded => h.next_hello = now,
                Refused::Identity => {
                    h.their_identity = true;
                    h.next_hello = now + hello::RECHECK;
                }
            }
        }
        Event::OutLimited { svc, until } => {
            let hold = h.holds.entry(Some(*svc)).or_insert(0);
            *hold = (*hold).max((*until).min(now + HOLD_MAX));
        }
        Event::OutBusy { until } => {
            let hold = h.holds.entry(None).or_insert(0);
            *hold = (*hold).max((*until).min(now + HOLD_MAX));
        }
        Event::OutBadReply { svc } => {
            ok(&mut h, now);
            strike(
                &mut h,
                (*svc, Dir::Out),
                strikes::WEIGHT_BAD_REPLY,
                PauseWhy::BadReply,
                now,
            );
        }
        Event::InOk { svc: _, kid } => {
            signed_by(&mut h, kid, now, false);
        }
        Event::InStrike { svc, why, kid } => {
            if signed_by(&mut h, kid, now, false) {
                let weight = match why {
                    StrikeWhy::Malformed => strikes::WEIGHT_MALFORMED,
                    StrikeWhy::BadOwnSeal => strikes::WEIGHT_BAD_OWN_SEAL,
                    StrikeWhy::BadObject => strikes::WEIGHT_BAD_OBJECT,
                };
                strike(&mut h, (*svc, Dir::In), weight, PauseWhy::Malformed, now);
            }
        }
        Event::InLimited {
            svc,
            retry_after,
            cause,
        } => match cause {
            Cause::Shared => {}
            Cause::Host => return in_limited(prev, *svc, *retry_after, now),
        },
        Event::ThirdParty { svc: _ } => h.third_party += 1,
        Event::Op(op) => return operator(prev, op, now),
    }
    h
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    Blocked,
    Identity,
    Unsupported,
    Hello,
    Version,
    Halted,
    Paused,
    RefusedByThem,
    PausedByThem,
    IdentityByThem,
    Held,
    Waiting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Go,
    No { why: Why, until: Option<i64> },
}

impl Gate {
    pub fn go(self) -> bool {
        self == Gate::Go
    }

    fn why(self) -> Option<Why> {
        match self {
            Gate::Go => None,
            Gate::No { why, until: _ } => Some(why),
        }
    }
}

fn no(why: Why, until: Option<i64>) -> Gate {
    Gate::No { why, until }
}

fn active(h: &Host, key: Key, now: i64) -> Option<Pause> {
    pause_of(h, key).filter(|p| now < p.until)
}

pub fn halted_dir(h: &Host, dir: Dir, now: i64) -> Option<i64> {
    let paused: Vec<Pause> = Service::ALL
        .iter()
        .filter_map(|s| active(h, (*s, dir), now))
        .collect();
    match paused.len() >= strikes::HALT_AT || active(h, (Service::Core, dir), now).is_some() {
        true => paused.iter().map(|p| p.until).max(),
        false => None,
    }
}

pub fn gate(
    h: &Host,
    ours: &Caps,
    svc: Service,
    dir: Dir,
    now: i64,
    hello_rev: Option<u64>,
) -> Gate {
    if h.blocked
        .is_some_and(|b| b.dir == BlockDir::Both || dir == Dir::In)
    {
        return no(Why::Blocked, None);
    }
    if h.pending_keys.is_some() {
        return no(Why::Identity, None);
    }
    if dir == Dir::Out {
        if matches!(h.support, Support::NoFed | Support::NotRchat) {
            return no(Why::Unsupported, Some(h.next_hello));
        }
        if h.caps.is_none() || now >= h.next_hello {
            return no(Why::Hello, None);
        }
    }
    let newer = dir == Dir::In && hello_rev.is_some_and(|rev| rev > h.hello_rev);
    if let Some(caps) = &h.caps
        && !newer
        && service_use(svc.needs(), ours, caps).is_err()
    {
        return no(Why::Version, Some(h.next_hello));
    }
    if let Some(halt) = halted_dir(h, dir, now) {
        return no(Why::Halted, Some(halt));
    }
    if let Some(p) = active(h, (svc, dir), now) {
        return no(Why::Paused, Some(p.until));
    }
    if dir == Dir::In {
        return Gate::Go;
    }
    if h.their_identity {
        return no(Why::IdentityByThem, Some(h.next_hello));
    }
    if h.their_policy.get(&svc) == Some(&TheirPolicy::Refused) {
        return no(Why::RefusedByThem, Some(h.next_hello));
    }
    if let Some(until) = h.their_pause.get(&svc)
        && now < *until
    {
        return no(Why::PausedByThem, Some(*until));
    }
    let hold = |key| h.holds.get(&key).copied().unwrap_or(0);
    let held = hold(None).max(hold(Some(svc)));
    if now < held {
        return no(Why::Held, Some(held));
    }
    if h.circuit.open_since.is_some() {
        return no(Why::Waiting, Some(h.circuit.next_probe));
    }
    Gate::Go
}

pub fn needs_hello(h: &Host, now: i64) -> bool {
    if h.blocked.is_some_and(|b| b.dir == BlockDir::Both) {
        return false;
    }
    if now < h.holds.get(&None).copied().unwrap_or(0) {
        return false;
    }
    match h.circuit.open_since {
        Some(_) => now >= h.circuit.next_probe,
        None => now >= h.next_hello,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkState {
    Unknown,
    Ok,
    Degraded,
    Unreachable,
    RefusedByThem,
    Paused,
    Halted,
    Version,
    Unsupported,
    Identity,
    Blocked,
}

impl LinkState {
    pub fn name(self) -> &'static str {
        match self {
            LinkState::Unknown => "unknown",
            LinkState::Ok => "ok",
            LinkState::Degraded => "degraded",
            LinkState::Unreachable => "unreachable",
            LinkState::RefusedByThem => "refused_by_them",
            LinkState::Paused => "paused",
            LinkState::Halted => "halted",
            LinkState::Version => "version",
            LinkState::Unsupported => "unsupported",
            LinkState::Identity => "identity",
            LinkState::Blocked => "blocked",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServiceGates {
    pub service: Service,
    pub inbound: Gate,
    pub outbound: Gate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub state: LinkState,
    pub services: Vec<ServiceGates>,
    pub notice: String,
}

fn label(svc: Service) -> &'static str {
    match svc {
        Service::Core => "Hello",
        Service::Letters => "letters",
        Service::LetterFiles => "letter files",
        Service::LetterKeys => "letter keys",
        Service::Invites => "invite previews",
        Service::Profiles => "profiles",
        Service::Reports => "reports",
        Service::Directory => "server search",
    }
}

fn month_and_day(days: i64) -> (i64, i64) {
    let day_of_era = (days + 719_468).rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let march_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * march_month + 2) / 5 + 1;
    let month = match march_month < 10 {
        true => march_month + 3,
        false => march_month - 9,
    };
    (month, day)
}

pub fn when(t: i64) -> String {
    let (month, day) = month_and_day(t.div_euclid(86_400));
    let secs = t.rem_euclid(86_400);
    format!(
        "{month:02}/{day:02} {:02}:{:02} UTC",
        secs / 3600,
        secs % 3600 / 60
    )
}

fn levels_of(caps: &Caps, svc: Service) -> String {
    svc.needs()
        .iter()
        .filter(|name| **name != "core")
        .map(|name| match caps.feature(name) {
            Some(f) => format!("{name} {}", f.level),
            None => format!("no {name}"),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn view(h: &Host, ours: &Caps, now: i64) -> View {
    let services: Vec<ServiceGates> = Service::ALL
        .into_iter()
        .map(|service| ServiceGates {
            service,
            inbound: gate(h, ours, service, Dir::In, now, None),
            outbound: gate(h, ours, service, Dir::Out, now, None),
        })
        .collect();
    let first_out = |why: Why| {
        services
            .iter()
            .find(|s| s.outbound.why() == Some(why))
            .map(|s| s.service)
    };
    let host = &h.host;
    let c = &h.circuit;
    let halt_in = halted_dir(h, Dir::In, now);
    let halt_out = halted_dir(h, Dir::Out, now);
    let paused = h.pauses.iter().find(|(_, p)| now < p.until);
    let version = h.caps.as_ref().zip(first_out(Why::Version));
    let refused = first_out(Why::RefusedByThem);
    let paused_by_them = first_out(Why::PausedByThem);
    let skewed = h.skew.unsigned_abs() > hello::SKEW_NOTICE.unsigned_abs();
    let struck = h
        .strikes
        .values()
        .any(|list| list.iter().any(|(t, _)| *t > now - strikes::WINDOW));
    let (state, notice) = if let Some(blocked) = h.blocked {
        let on = when(blocked.since);
        let notice = match blocked.dir {
            BlockDir::Both => format!("Blocked by you on {on}."),
            BlockDir::In => format!(
                "Calls from {host} blocked by you on {on}. This instance still sends to it."
            ),
        };
        (LinkState::Blocked, notice)
    } else if let Some(pending) = &h.pending_keys {
        let since = when(h.pending_since.unwrap_or(now));
        let known =
            |flag: fn(&KeyRec) -> bool| pending.iter().any(|kid| h.keys.get(kid).is_some_and(flag));
        let notice = if known(|rec| rec.retired) {
            format!(
                "{host} signed with a key it retired (since {since}). Nothing is exchanged until you trust a current key or block it."
            )
        } else if known(|rec| rec.seal_only) {
            format!(
                "{host} signed with a key it only published for old seals (since {since}). Nothing is exchanged until you trust it or block it."
            )
        } else {
            format!(
                "{host} now signs with a key this instance doesn't know (since {since}). Nothing is exchanged until you trust it or block it."
            )
        };
        (LinkState::Identity, notice)
    } else if matches!(h.support, Support::NoFed | Support::NotRchat) {
        let notice = match h.support {
            Support::NoFed => format!(
                "{host} runs an RChat version without the instance protocol. Checked again every day."
            ),
            _ => format!("{host} isn't an RChat instance."),
        };
        (LinkState::Unsupported, notice)
    } else if let Some((caps, svc)) = version {
        let what = label(svc);
        let levels = levels_of(caps, svc);
        let gap = service_use(svc.needs(), ours, caps)
            .err()
            .map_or(Gap::Missing, |no| no.gap);
        let notice = match gap {
            Gap::OursOld => format!(
                "{host} needs a newer RChat for {what} ({levels}). Update this instance to reach it."
            ),
            Gap::Missing => format!("{host} doesn't offer {what}."),
            Gap::TheirsOld | Gap::Major => format!(
                "{host} runs an older protocol for {what} ({levels}). Paused until it updates. Checked every 6 hours."
            ),
        };
        (LinkState::Version, notice)
    } else if halt_in.is_some() || halt_out.is_some() {
        let notice = match (halt_in, halt_out) {
            (Some(until), _) => format!(
                "{host} sent malformed calls for several services. Everything from it is halted until {}.",
                when(until)
            ),
            (None, until) => format!(
                "{host} gave malformed answers for several services. Nothing is sent to it until {}.",
                when(until.unwrap_or(now))
            ),
        };
        (LinkState::Halted, notice)
    } else if let Some(((svc, dir), p)) = paused {
        let name = label(*svc);
        let what = match (p.why, dir) {
            (PauseWhy::Abuse, _) => format!("kept calling for {name} while told to wait"),
            (_, Dir::In) => format!("sent malformed calls for {name}"),
            (_, Dir::Out) => format!("gave malformed answers for {name}"),
        };
        let calls = match dir {
            Dir::In => "Calls from it",
            Dir::Out => "Calls to it",
        };
        let notice = format!("{host} {what}. {calls} are paused until {}.", when(p.until));
        (LinkState::Paused, notice)
    } else if h.their_identity || refused.is_some() || paused_by_them.is_some() {
        let notice = match (h.their_identity, refused, paused_by_them) {
            (true, _, _) => format!(
                "{host} doesn't recognize this instance's key. Its operator has to accept this one."
            ),
            (false, Some(svc), _) => {
                format!("{host} doesn't take {} from this instance.", label(svc))
            }
            (false, None, svc) => {
                let svc = svc.unwrap_or(Service::Core);
                format!(
                    "{host} paused {} from this instance until {}.",
                    label(svc),
                    when(h.their_pause.get(&svc).copied().unwrap_or(now))
                )
            }
        };
        (LinkState::RefusedByThem, notice)
    } else if let Some(since) = c.open_since
        && now - since >= circuit::UNREACHABLE_AFTER
    {
        let notice = format!(
            "{host} hasn't answered since {}. Waiting items stay queued until they expire.",
            when(since)
        );
        (LinkState::Unreachable, notice)
    } else if c.open_since.is_some() || h.unauth_at.is_some() || skewed || struck {
        let secs = h.skew.unsigned_abs();
        let notice = if h.unauth_at.is_some() {
            let clock = match skewed {
                true => format!(" The clocks differ by {secs} seconds."),
                false => String::new(),
            };
            let next = match c.open_since {
                Some(_) => c.next_probe,
                None => now,
            };
            format!(
                "{host} doesn't accept this instance's calls (clock or keys).{clock} Next try at {}.",
                when(next)
            )
        } else if c.open_since.is_some() {
            format!(
                "{host} isn't answering. Next try at {}.",
                when(c.next_probe)
            )
        } else if skewed {
            format!(
                "{host}'s clock and this instance's differ by {secs} seconds. Calls are adjusted for it."
            )
        } else {
            format!("{host} sent some malformed calls in the last hour.")
        };
        (LinkState::Degraded, notice)
    } else if h.caps.is_some() {
        (LinkState::Ok, String::new())
    } else {
        (LinkState::Unknown, String::new())
    };
    View {
        state,
        services,
        notice,
    }
}
