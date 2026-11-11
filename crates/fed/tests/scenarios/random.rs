use std::collections::BTreeMap;

use rchat_fed::health::{Cause, Event, HelloFail, HelloOk, Op, Refused, StrikeWhy, TheirPolicy};
use rchat_fed::levels::Service;
use rchat_fed::negotiate::Caps;

use crate::support::{kids, letters_at, ours, signed, v080};

pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng(seed)
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next() * n as f64).floor() as usize
    }

    pub fn pick<T: Clone>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len())].clone()
    }

    pub fn whole(&mut self, scale: f64, shift: f64) -> i64 {
        (self.next() * scale + shift).floor() as i64
    }

    pub fn advance(&mut self) -> i64 {
        let span = match self.next() < 0.7 {
            true => 120.0,
            false => 8.0 * 3600.0,
        };
        self.whole(span, 0.0)
    }
}

const KIDS: [&str; 7] = ["kB", "kB", "kB", "kB2", "kX", "kY", "kOld"];

pub fn caps_pool() -> [Caps; 4] {
    [ours(), v080(), Caps::default(), letters_at(4, 3)]
}

fn random_hello(r: &mut Rng, svc: Service, now: i64) -> HelloOk {
    let signer = match r.next() < 0.8 {
        true => "kB",
        false => r.pick(&["kB2", "kX", "kY", "kOld"]),
    };
    let jwks: Vec<&str> = if ["kX", "kY", "kOld"].contains(&signer) {
        match r.next() < 0.5 {
            true => vec![signer],
            false => vec!["kB", signer],
        }
    } else if r.next() < 0.5 {
        vec!["kB"]
    } else if r.next() < 0.5 {
        vec!["kB", "kB2"]
    } else {
        vec!["kB", "kOld"]
    };
    let caps = r.pick(&caps_pool());
    let id = match r.next() < 0.9 {
        true => "ib",
        false => "ib-other",
    };
    let rev = r.below(5) as u64;
    let policy = match r.next() < 0.2 {
        true => BTreeMap::from([(svc, TheirPolicy::Refused)]),
        false => BTreeMap::new(),
    };
    let their_now = now + r.whole(120.0, -60.0);
    let call_kids: Vec<&str> = jwks
        .iter()
        .copied()
        .filter(|k| *k == signer || r.next() < 0.7)
        .collect();
    let mut endorsed = Vec::new();
    if jwks.contains(&"kB2") && r.next() < 0.8 {
        endorsed.push("kB2");
    }
    if jwks.contains(&"kOld") && signer == "kB" && r.next() < 0.2 {
        endorsed.push("kOld");
    }
    HelloOk {
        caps,
        id: id.to_string(),
        rev,
        policy,
        their_now,
        endorsed: kids(&endorsed),
        ..signed(signer, &jwks, &call_kids)
    }
}

pub fn random_event(r: &mut Rng, now: i64) -> Event {
    let svc = r.pick(&Service::ALL);
    let kid = r.pick(&KIDS).to_string();
    match r.below(18) {
        0 | 1 => Event::HelloOk(Box::new(random_hello(r, svc, now))),
        2 => {
            let why = r.pick(&[
                HelloFail::Transport,
                HelloFail::NoFed,
                HelloFail::NotRchat,
                HelloFail::Unauthenticated,
            ]);
            let their_now = match r.next() < 0.5 {
                true => Some(now + r.whole(80.0, -40.0)),
                false => None,
            };
            Event::HelloFail { why, their_now }
        }
        3 => Event::OutOk { svc },
        4 => Event::OutFail {
            svc,
            unauthenticated: r.pick(&[false, true]),
            their_now: None,
        },
        5 => {
            let reason = r.pick(&[
                Refused::Refused,
                Refused::Paused,
                Refused::Version,
                Refused::Identity,
                Refused::HelloNeeded,
            ]);
            let until = Some(now + r.whole(1_000_000.0, 0.0));
            Event::OutRefused { svc, reason, until }
        }
        6 => Event::OutBadReply { svc },
        7 => Event::InOk { svc, kid },
        8 | 9 => {
            let why = r.pick(&[
                StrikeWhy::Malformed,
                StrikeWhy::BadOwnSeal,
                StrikeWhy::BadObject,
            ]);
            Event::InStrike { svc, why, kid }
        }
        10 => {
            let retry_after = r.whole(120.0, 0.0);
            let cause = match r.next() < 0.5 {
                true => Cause::Host,
                false => Cause::Shared,
            };
            Event::InLimited {
                svc,
                retry_after,
                cause,
            }
        }
        11 => Event::ThirdParty { svc },
        12 => Event::OutLimited {
            svc,
            until: now + r.whole(120.0, 0.0),
        },
        13 => Event::OutBusy {
            until: now + r.whole(120.0, 0.0),
        },
        14 => {
            let trust = r.pick(&[true, false]);
            let kid = r.pick(&KIDS).to_string();
            Event::Op(match trust {
                true => Op::Trust(kid),
                false => Op::Distrust(kid),
            })
        }
        _ => Event::Op(r.pick(&[Op::Block, Op::BlockIn, Op::Unblock, Op::Retry])),
    }
}

pub fn first_contact(now: i64) -> Event {
    Event::HelloOk(Box::new(HelloOk {
        their_now: now,
        ..signed("kB", &["kB", "kOld"], &["kB"])
    }))
}
