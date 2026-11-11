use std::collections::BTreeMap;

use rchat_fed::health::{Dir, Event, Gate, HelloOk, Host, Op, StrikeWhy, fresh, gate, step};
use rchat_fed::levels::{self, Service};
use rchat_fed::negotiate::Caps;

pub const T0: i64 = 1_800_000_000;

pub fn ours() -> Caps {
    levels::ours("0.9.0", false).unwrap()
}

pub fn v080() -> Caps {
    levels::ours("0.8.0", false).unwrap()
}

pub fn letters_at(level: u32, min: u32) -> Caps {
    let mut caps = ours();
    for f in &mut caps.features {
        if f.name == "letters" {
            f.level = level;
            f.min = min;
        }
    }
    caps
}

pub fn kids(names: &[&str]) -> Vec<String> {
    names.iter().map(|k| k.to_string()).collect()
}

pub fn hello() -> HelloOk {
    signed("kB", &["kB"], &["kB"])
}

pub fn signed(signer: &str, jwks: &[&str], call_kids: &[&str]) -> HelloOk {
    HelloOk {
        caps: ours(),
        id: "ib".to_string(),
        rev: 1,
        policy: BTreeMap::new(),
        their_now: 0,
        jwks: kids(jwks),
        call_kids: kids(call_kids),
        endorsed: Vec::new(),
        signer: signer.to_string(),
        budgets: BTreeMap::new(),
    }
}

pub fn said(hello: HelloOk, their_now: i64) -> Event {
    Event::HelloOk(Box::new(HelloOk { their_now, ..hello }))
}

pub fn hello_at(t: i64, hello: HelloOk) -> (i64, Event) {
    (t, said(hello, T0 + t))
}

pub fn in_ok(kid: &str) -> Event {
    Event::InOk {
        svc: Service::Letters,
        kid: kid.to_string(),
    }
}

pub fn strike_on(svc: Service, why: StrikeWhy, kid: &str) -> Event {
    Event::InStrike {
        svc,
        why,
        kid: kid.to_string(),
    }
}

pub fn strike(t: i64) -> (i64, Event) {
    (t, strike_on(Service::Letters, StrikeWhy::Malformed, "kB"))
}

pub fn strikes(from: i64, count: i64) -> Vec<(i64, Event)> {
    (0..count).map(|i| strike(from + i)).collect()
}

pub fn trust(kid: &str) -> Event {
    Event::Op(Op::Trust(kid.to_string()))
}

pub fn distrust(kid: &str) -> Event {
    Event::Op(Op::Distrust(kid.to_string()))
}

pub fn run_from(host: Host, ours: &Caps, events: Vec<(i64, Event)>) -> Host {
    events
        .into_iter()
        .fold(host, |h, (t, e)| step(&h, &e, T0 + t, ours))
}

pub fn run(events: Vec<(i64, Event)>) -> Host {
    run_from(fresh("b.example", None), &ours(), events)
}

pub fn at(h: &Host, e: Event, t: i64) -> Host {
    step(h, &e, T0 + t, &ours())
}

pub fn gate_at(h: &Host, svc: Service, dir: Dir, t: i64) -> Gate {
    gate(h, &ours(), svc, dir, T0 + t, None)
}

pub fn go(h: &Host, svc: Service, dir: Dir, t: i64) -> bool {
    gate_at(h, svc, dir, t).go()
}
