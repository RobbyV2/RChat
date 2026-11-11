use rchat_fed::health::{Cause, Dir, Event, Gate, Host, Why, fresh, gate, needs_hello, step};
use rchat_fed::levels::Service;
use rchat_fed::outcomes::{Answer, Code, Refusal, outcome};

use crate::support::{T0, hello, ours, said, signed};

use Service::Letters;

struct Sim {
    a: Host,
    b: Host,
}

enum Reply {
    Ok,
    Limited(i64),
    Busy(i64),
}

fn start() -> Sim {
    let ours = ours();
    Sim {
        a: step(&fresh("b.example", None), &said(hello(), T0), T0, &ours),
        b: step(
            &fresh("a.example", None),
            &said(signed("kA", &["kA"], &["kA"]), T0),
            T0,
            &ours,
        ),
    }
}

fn call(s: &mut Sim, t: i64, reply: Reply) {
    let ours = ours();
    let (retry_after, cause, code, refusal) = match reply {
        Reply::Ok => {
            s.a = step(&s.a, &Event::OutOk { svc: Letters }, t, &ours);
            return;
        }
        Reply::Limited(wait) => (wait, Cause::Host, Code::ResourceExhausted, None),
        Reply::Busy(wait) => (wait, Cause::Shared, Code::Unavailable, Some(Refusal::Busy)),
    };
    let limited = Event::InLimited {
        svc: Letters,
        retry_after,
        cause,
    };
    s.b = step(&s.b, &limited, t, &ours);
    let answer = Answer {
        code,
        refusal,
        until: None,
        retry_after: Some(retry_after),
        now: Some(t),
        their_now: None,
    };
    if let Some(e) = outcome(Letters, &answer).event {
        s.a = step(&s.a, &e, t, &ours);
    }
}

fn refresh_hellos(s: &mut Sim, t: i64) {
    let ours = ours();
    if needs_hello(&s.a, t) {
        s.a = step(&s.a, &said(hello(), t), t, &ours);
    }
    if needs_hello(&s.b, t) {
        s.b = step(&s.b, &said(signed("kA", &["kA"], &["kA"]), t), t, &ours);
    }
}

fn may_send(s: &Sim, t: i64) -> bool {
    gate(&s.a, &ours(), Letters, Dir::Out, t, None).go()
}

fn inbound(s: &Sim, t: i64) -> Gate {
    gate(&s.b, &ours(), Letters, Dir::In, t, None)
}

fn no_violations(s: &Sim) -> bool {
    s.b.violations.get(&Letters).is_none_or(|v| v.is_empty())
}

#[test]
fn a_neighbour_saturating_the_network_cap_for_three_hours_never_pauses_a() {
    let mut s = start();
    let mut sent = 0;
    for t in (T0 + 1..T0 + 3 * 3600).step_by(5) {
        refresh_hellos(&mut s, t);
        for _ in 0..50 {
            if may_send(&s, t) {
                sent += 1;
                call(&mut s, t, Reply::Busy(30));
            }
        }
    }
    assert!(inbound(&s, T0 + 3 * 3600).go());
    assert!(no_violations(&s));
    assert!(sent > 300 && sent < 3 * 3600 / 30 + 10, "{sent}");
}

#[test]
fn fifty_jobs_on_three_copies_honouring_one_retry_after_drain_a_backlog_and_are_never_paused() {
    let mut s = start();
    let budget = 100;
    let mut used = 0;
    let mut minute = T0 / 60;
    let mut delivered = 0;
    for t in T0 + 1..T0 + 3 * 3600 {
        refresh_hellos(&mut s, t);
        if t / 60 != minute {
            minute = t / 60;
            used = 0;
        }
        for _ in 0..50 {
            if may_send(&s, t) {
                let reply = match used < budget {
                    true => {
                        used += 1;
                        delivered += 1;
                        Reply::Ok
                    }
                    false => Reply::Limited(60 - t % 60),
                };
                call(&mut s, t, reply);
            }
        }
    }
    assert!(inbound(&s, T0 + 3 * 3600).go());
    assert!(no_violations(&s));
    assert!(delivered > budget * 170, "{delivered}");
}

#[test]
fn control_a_caller_that_ignores_the_hold_is_paused_after_thirty_minutes() {
    let mut s = start();
    let mut used = 0;
    let mut minute = T0 / 60;
    for t in T0 + 1..T0 + 3600 {
        refresh_hellos(&mut s, t);
        if t / 60 != minute {
            minute = t / 60;
            used = 0;
        }
        for _ in 0..5 {
            let reply = match used < 100 {
                true => {
                    used += 1;
                    Reply::Ok
                }
                false => Reply::Limited(60 - t % 60),
            };
            call(&mut s, t, reply);
        }
    }
    assert!(matches!(
        inbound(&s, T0 + 3600),
        Gate::No {
            why: Why::Paused,
            until: Some(_)
        }
    ));
}
