use rchat_fed::health::{Cause, Dir, Event, HelloOk, Op, StrikeWhy};
use rchat_fed::levels::Service;
use rchat_fed::registry::Fleet;

use crate::random::{Rng, random_event};
use crate::support::{T0, kids, ours, said, signed};

const B: &str = "chat.b.example";

fn as_b(e: Event) -> Event {
    match e {
        Event::InOk { svc, kid: _ } => Event::InOk {
            svc,
            kid: "kB".to_string(),
        },
        Event::InStrike { svc, why, kid: _ } => Event::InStrike {
            svc,
            why,
            kid: "kB".to_string(),
        },
        Event::HelloOk(said) => Event::HelloOk(Box::new(HelloOk {
            signer: "kB".to_string(),
            jwks: kids(&["kB"]),
            call_kids: kids(&["kB"]),
            id: "id-b".to_string(),
            ..*said
        })),
        other => other,
    }
}

fn attack(r: &mut Rng, now: i64) -> (&'static str, Event) {
    let host = r.pick(&["evil.attacker.net", "x2.attacker.net", "m1.evil.ts.net"]);
    let kid = r.pick(&["kX", "kX2"]);
    let roll = r.next();
    let e = if roll < 0.3 {
        let id = r.pick(&["id-b", "id-x"]);
        let jwks: &[&str] = match r.next() < 0.5 {
            true => &[kid, "kB"],
            false => &[kid],
        };
        let call_kids: &[&str] = match r.next() < 0.3 {
            true => &[kid, "kB"],
            false => &[kid],
        };
        let hello = HelloOk {
            id: id.to_string(),
            ..signed(kid, jwks, call_kids)
        };
        said(hello, now)
    } else if roll < 0.8 {
        let svc = r.pick(&Service::ALL);
        let why = r.pick(&[
            StrikeWhy::Malformed,
            StrikeWhy::BadOwnSeal,
            StrikeWhy::BadObject,
        ]);
        Event::InStrike {
            svc,
            why,
            kid: kid.to_string(),
        }
    } else if roll < 0.9 {
        Event::Op(r.pick(&[Op::Block, Op::BlockIn]))
    } else {
        Event::InLimited {
            svc: r.pick(&Service::ALL),
            retry_after: 60,
            cause: Cause::Host,
        }
    };
    (host, e)
}

#[test]
fn property_no_host_can_gate_another_by_claiming_to_be_its_sibling() {
    let mut attacks = 0;
    let mut gated = 0;
    for seed in 1..=150u32 {
        let mut r = Rng::new(seed);
        let mut alone = Fleet::new(ours());
        let mut crowd = Fleet::new(ours());
        let mut now = T0;
        let hello = said(
            HelloOk {
                id: "id-b".to_string(),
                ..signed("kB", &["kB"], &["kB"])
            },
            now,
        );
        alone.step(B, &hello, now);
        crowd.step(B, &hello, now);
        for i in 0..300 {
            now += r.whole(300.0, 0.0);
            if r.next() < 0.5 {
                let own = as_b(random_event(&mut r, now));
                alone.step(B, &own, now);
                crowd.step(B, &own, now);
            } else {
                let (host, e) = attack(&mut r, now);
                crowd.step(host, &e, now);
                attacks += 1;
                gated += usize::from(!crowd.gate(host, Service::Letters, Dir::In, now, None).go());
            }
            for s in Service::ALL {
                for d in [Dir::In, Dir::Out] {
                    assert_eq!(
                        crowd.gate(B, s, d, now, None),
                        alone.gate(B, s, d, now, None),
                        "seed {seed} step {i}"
                    );
                }
            }
        }
    }
    assert!(attacks > 20_000 && gated > 5_000, "{attacks} {gated}");
}
