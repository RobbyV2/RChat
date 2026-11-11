use rchat_fed::health::{
    BlockDir, Cause, Dir, Event, Gate, HelloFail, Host, LinkState, Op, PauseWhy, Support, Why,
    fresh, gate, needs_hello, step, view,
};
use rchat_fed::levels::Service;
use rchat_fed::limits::{NOTICE_MAX, abuse, hello, keys, strikes};
use rchat_fed::negotiate::service_use;

use crate::random::{Rng, first_contact, random_event};
use crate::support::{T0, ours};

const DIRS: [Dir; 2] = [Dir::In, Dir::Out];

fn gates(h: &Host, now: i64) -> Vec<Gate> {
    let ours = ours();
    Service::ALL
        .iter()
        .flat_map(|s| DIRS.map(|d| gate(h, &ours, *s, d, now, None)))
        .collect()
}

fn signer_of(e: &Event) -> Option<&str> {
    match e {
        Event::HelloOk(said) => Some(&said.signer),
        Event::InOk { svc: _, kid }
        | Event::InStrike {
            svc: _,
            why: _,
            kid,
        } => Some(kid),
        _ => None,
    }
}

fn vouched(e: &Event) -> bool {
    match e {
        Event::HelloOk(said) => {
            said.endorsed.contains(&said.signer) && said.jwks.contains(&said.signer)
        }
        _ => false,
    }
}

fn trusts(e: &Event, kid: &str) -> bool {
    matches!(e, Event::Op(Op::Trust(trusted)) if trusted == kid)
}

#[test]
fn property_the_halting_rules_hold_after_every_random_step() {
    let ours = ours();
    let mut steps = 0u32;
    let mut questions = 0u32;
    let mut pauses = 0u32;
    for seed in 1..=300u32 {
        let mut r = Rng::new(seed);
        let mut now = T0;
        let mut h = match seed % 2 == 0 {
            true => step(&fresh("b.example", None), &first_contact(now), now, &ours),
            false => fresh("b.example", None),
        };
        let mut last_block: Option<Op> = None;
        for i in 0..400 {
            now += r.advance();
            let e = random_event(&mut r, now);
            let before = h.clone();
            h = step(&h, &e, now, &ours);
            let at = format!("seed {seed} step {i} {e:?}");
            steps += 1;

            if matches!(e, Event::ThirdParty { svc: _ }) {
                assert_eq!(gates(&h, now), gates(&before, now), "{at}");
            }

            if let Event::Op(op @ (Op::Block | Op::BlockIn | Op::Unblock)) = &e {
                last_block = Some(op.clone());
            }
            assert_eq!(
                h.blocked.is_none(),
                matches!(last_block, None | Some(Op::Unblock)),
                "{at}"
            );

            let signer = signer_of(&e);
            let known = |kid: &str| before.keys.get(kid);
            if h.pending_keys.is_some() {
                assert!(gates(&h, now).iter().all(|g| !g.go()), "{at}");
                if before.pending_keys.is_none() {
                    questions += 1;
                    let raised = signer.is_some_and(|kid| match known(kid) {
                        None => !vouched(&e),
                        Some(rec) => rec.retired || (rec.seal_only && !vouched(&e)),
                    });
                    assert!(raised, "{at}");
                }
            }
            if before.pending_keys.is_some() && h.pending_keys.is_none() {
                let trusted = matches!(e, Event::Op(Op::Trust(_)));
                let current = signer
                    .and_then(known)
                    .is_some_and(|rec| !rec.retired && !rec.seal_only);
                assert!(trusted || vouched(&e) || current, "{at}");
            }
            for (kid, rec) in &before.keys {
                let after = h
                    .keys
                    .get(kid)
                    .unwrap_or_else(|| panic!("forgot {kid}: {at}"));
                if rec.retired && !after.retired {
                    assert!(trusts(&e, kid), "{at}");
                }
                if rec.seal_only && !after.seal_only {
                    let endorsed =
                        matches!(&e, Event::HelloOk(said) if said.endorsed.contains(kid));
                    assert!(endorsed || trusts(&e, kid), "{at}");
                }
                if let Event::HelloOk(said) = &e {
                    let was_current =
                        known(&said.signer).is_some_and(|s| s.call && !s.retired && !s.seal_only);
                    if !was_current {
                        if rec.omitted_since.is_none() {
                            assert_eq!(after.omitted_since, None, "{at}");
                        }
                        if !rec.retired {
                            assert!(!after.retired, "{at}");
                        }
                    }
                }
            }
            if let Some(kid) = signer
                && known(kid).is_some_and(|rec| rec.retired)
            {
                let counted = match &e {
                    Event::HelloOk(said) => {
                        said.call_kids.contains(&said.signer) && said.jwks.contains(&said.signer)
                    }
                    _ => true,
                };
                if counted {
                    let pending = h.pending_keys.clone().unwrap_or_default();
                    assert!(pending.iter().any(|p| p == kid), "{at}");
                }
            }
            assert!(
                h.pending_keys.as_ref().map_or(0, Vec::len) <= keys::PENDING_MAX,
                "{at}"
            );
            if let Event::Op(Op::Trust(kid)) = &e {
                let added: Vec<&String> = h
                    .keys
                    .keys()
                    .filter(|k| !before.keys.contains_key(*k))
                    .collect();
                assert!(added.len() <= 1, "{at}");
                if let [new] = added.as_slice() {
                    assert_eq!(*new, kid, "{at}");
                    assert!(
                        before
                            .pending_proven
                            .iter()
                            .any(|p| p.kid == *kid && now - p.at <= hello::TTL),
                        "{at}"
                    );
                }
            }
            match &e {
                Event::InLimited {
                    svc: _,
                    retry_after: _,
                    cause: Cause::Shared,
                } => assert_eq!(h, before, "{at}"),
                Event::OutLimited { svc: _, until: _ } | Event::OutBusy { until: _ } => {
                    assert_eq!(h.pauses, before.pauses, "{at}")
                }
                _ => {}
            }

            for (_, p) in &h.pauses {
                assert!(p.until > p.since, "{at}");
                let max = match p.why {
                    PauseWhy::Abuse => abuse::COOLDOWN_MAX,
                    PauseWhy::Malformed | PauseWhy::BadReply => strikes::COOLDOWN_MAX,
                };
                assert!(p.until - p.since <= max, "{at}");
            }
            if h.pauses.len() > before.pauses.len() {
                pauses += 1;
            }
            for until in h.their_pause.values() {
                assert!(until - now <= abuse::COOLDOWN_MAX, "{at}");
            }

            let unreached = match &e {
                Event::OutFail {
                    svc: _,
                    unauthenticated: _,
                    their_now: _,
                } => true,
                Event::HelloFail { why, their_now: _ } => {
                    matches!(why, HelloFail::Transport | HelloFail::Unauthenticated)
                }
                _ => false,
            };
            if unreached {
                assert_eq!(h.pauses, before.pauses, "{at}");
                assert_eq!(h.support, before.support, "{at}");
            }
            if h.support != before.support && h.support != Support::Rchat {
                let discovery = matches!(
                    e,
                    Event::HelloFail {
                        why: HelloFail::NoFed | HelloFail::NotRchat,
                        their_now: _
                    }
                );
                assert!(discovery, "{at}");
            }

            if let Some(caps) = &h.caps {
                for s in Service::ALL {
                    if service_use(s.needs(), &ours, caps).is_err() {
                        for d in DIRS {
                            assert!(!gate(&h, &ours, s, d, now, None).go(), "{at}");
                        }
                    }
                }
            }

            let quiet = h.blocked.is_none()
                && h.pending_keys.is_none()
                && h.caps.is_none()
                && h.pauses.iter().all(|(_, p)| now >= p.until);
            if quiet {
                for s in Service::ALL {
                    assert!(gate(&h, &ours, s, Dir::In, now, None).go(), "{at}");
                }
            }

            if matches!(e, Event::Op(Op::Retry)) {
                for g in gates(&h, now) {
                    assert!(
                        !matches!(
                            g,
                            Gate::No {
                                why: Why::Paused | Why::Halted,
                                until: _
                            }
                        ),
                        "{at}"
                    );
                }
            }

            if let Event::InLimited {
                svc,
                retry_after: _,
                cause,
            } = &e
            {
                let honoured = before.backoff.get(svc).is_none_or(|until| now >= *until);
                if *cause == Cause::Shared || honoured {
                    assert_eq!(h.violations.get(svc), before.violations.get(svc), "{at}");
                }
            }

            if h.circuit.open_since.is_some() {
                for s in Service::ALL {
                    assert!(!gate(&h, &ours, s, Dir::Out, now, None).go(), "{at}");
                }
            }
            if h.blocked.is_some_and(|b| b.dir == BlockDir::Both) {
                assert!(!needs_hello(&h, now), "{at}");
            }

            let v = view(&h, &ours, now);
            assert!(v.notice.len() <= NOTICE_MAX, "{at}");
            assert!(v.notice.bytes().all(|b| (0x20..=0x7e).contains(&b)), "{at}");
            assert!(!v.notice.contains(" - "), "{at}");
            if matches!(v.state, LinkState::Ok | LinkState::Unknown) {
                assert_eq!(v.notice, "", "{at}");
            }
        }
    }
    assert_eq!(steps, 120_000);
    assert!(questions > 1000 && pauses > 10, "{questions} {pauses}");
}
