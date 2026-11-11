use std::collections::BTreeMap;

use rchat_fed::health::{
    Cause, Dir, Event, HelloFail, HelloOk, Host, Op, Refused, StrikeWhy, TheirPolicy, fresh, gate,
    step, view,
};
use rchat_fed::levels::Service;
use rchat_fed::negotiate::{Caps, Level};
use serde_json::Value;

use crate::random::{Rng, first_contact, random_event};
use crate::support::{T0, ours};

fn text(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

fn list(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(text).collect()
}

fn service(v: &Value) -> Service {
    Service::from_name(v.as_str().unwrap()).unwrap()
}

fn caps(v: &Value) -> Caps {
    Caps {
        majors: v["majors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m.as_u64().unwrap() as u32)
            .collect(),
        features: v["features"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| Level {
                name: text(&f["name"]),
                level: f["level"].as_u64().unwrap() as u32,
                min: f["min"].as_u64().unwrap() as u32,
            })
            .collect(),
    }
}

fn event(v: &Value) -> Event {
    let svc = || service(&v["svc"]);
    let kid = || text(&v["kid"]);
    match v["k"].as_str().unwrap() {
        "hello_ok" => Event::HelloOk(Box::new(HelloOk {
            caps: caps(&v["caps"]),
            id: text(&v["id"]),
            rev: v["rev"].as_u64().unwrap(),
            policy: v["policy"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(svc, policy)| {
                    let policy = match policy.as_str().unwrap() {
                        "refused" => TheirPolicy::Refused,
                        "accepted" => TheirPolicy::Accepted,
                        other => panic!("policy {other}"),
                    };
                    (Service::from_name(svc).unwrap(), policy)
                })
                .collect(),
            their_now: v["theirNow"].as_i64().unwrap(),
            jwks: list(&v["jwks"]),
            call_kids: list(&v["callKids"]),
            endorsed: list(&v["endorsed"]),
            signer: text(&v["signer"]),
            budgets: BTreeMap::new(),
        })),
        "hello_fail" => Event::HelloFail {
            why: match v["why"].as_str().unwrap() {
                "transport" => HelloFail::Transport,
                "no_fed" => HelloFail::NoFed,
                "not_rchat" => HelloFail::NotRchat,
                "unauthenticated" => HelloFail::Unauthenticated,
                other => panic!("why {other}"),
            },
            their_now: v["theirNow"].as_i64(),
        },
        "out_ok" => Event::OutOk { svc: svc() },
        "out_fail" => Event::OutFail {
            svc: svc(),
            unauthenticated: v["why"] == "unauthenticated",
            their_now: v["theirNow"].as_i64(),
        },
        "out_refused" => Event::OutRefused {
            svc: svc(),
            reason: match v["reason"].as_str().unwrap() {
                "refused" => Refused::Refused,
                "paused" => Refused::Paused,
                "version" => Refused::Version,
                "identity" => Refused::Identity,
                "hello_needed" => Refused::HelloNeeded,
                other => panic!("reason {other}"),
            },
            until: v["until"].as_i64(),
        },
        "out_limited" => Event::OutLimited {
            svc: svc(),
            until: v["until"].as_i64().unwrap(),
        },
        "out_busy" => Event::OutBusy {
            until: v["until"].as_i64().unwrap(),
        },
        "out_bad_reply" => Event::OutBadReply { svc: svc() },
        "in_ok" => Event::InOk {
            svc: svc(),
            kid: kid(),
        },
        "in_strike" => Event::InStrike {
            svc: svc(),
            why: match v["why"].as_str().unwrap() {
                "malformed" => StrikeWhy::Malformed,
                "bad_own_seal" => StrikeWhy::BadOwnSeal,
                "bad_object" => StrikeWhy::BadObject,
                other => panic!("why {other}"),
            },
            kid: kid(),
        },
        "in_limited" => Event::InLimited {
            svc: svc(),
            retry_after: v["retryAfter"].as_i64().unwrap(),
            cause: match v["cause"].as_str().unwrap() {
                "host" => Cause::Host,
                "shared" => Cause::Shared,
                other => panic!("cause {other}"),
            },
        },
        "third_party" => Event::ThirdParty { svc: svc() },
        "op" => Event::Op(match v["act"].as_str().unwrap() {
            "block" => Op::Block,
            "block_in" => Op::BlockIn,
            "unblock" => Op::Unblock,
            "retry" => Op::Retry,
            "trust" => Op::Trust(kid()),
            "distrust" => Op::Distrust(kid()),
            other => panic!("act {other}"),
        }),
        other => panic!("event {other}"),
    }
}

fn key_states(h: &Host) -> BTreeMap<String, String> {
    h.keys
        .iter()
        .map(|(kid, rec)| {
            let flags = [
                (rec.call, 'c'),
                (rec.retired, 'r'),
                (rec.seal_only, 's'),
                (rec.proven, 'p'),
            ];
            let state = flags.iter().filter(|(on, _)| *on).map(|(_, c)| c).collect();
            (kid.clone(), state)
        })
        .collect()
}

fn traces() -> Vec<Value> {
    let file: Value = serde_json::from_str(include_str!("../vectors/health_traces.json")).unwrap();
    file.as_array().unwrap().clone()
}

#[test]
fn the_health_traces_replay_step_by_step_with_equal_states_gates_notices_and_keys() {
    let ours = ours();
    let traces = traces();
    assert_eq!(traces.len(), 16);
    let mut steps = 0;
    for trace in &traces {
        let seed = trace["seed"].as_u64().unwrap();
        let mut h = step(&fresh("b.example", None), &first_contact(T0), T0, &ours);
        for (i, expected) in trace["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("seed {seed} step {i}");
            let now = expected["t"].as_i64().unwrap();
            h = step(&h, &event(&expected["e"]), now, &ours);
            let v = view(&h, &ours, now);
            assert_eq!(v.state.name(), expected["state"], "{at}");
            assert_eq!(v.notice, expected["notice"], "{at}");
            assert_eq!(
                gate(&h, &ours, Service::Letters, Dir::In, now, None).go(),
                expected["letters_in"],
                "{at}"
            );
            assert_eq!(
                gate(&h, &ours, Service::Letters, Dir::Out, now, None).go(),
                expected["letters_out"],
                "{at}"
            );
            let keys: BTreeMap<String, String> = expected["keys"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(kid, state)| (kid.clone(), text(state)))
                .collect();
            assert_eq!(key_states(&h), keys, "{at}");
            let pending = match &expected["pending"] {
                Value::Null => None,
                kids => Some(list(kids)),
            };
            assert_eq!(h.pending_keys, pending, "{at}");
            steps += 1;
        }
    }
    assert_eq!(steps, 16 * 150);
}

#[test]
fn the_random_generator_gives_the_events_and_times_of_the_models_traces() {
    for trace in &traces() {
        let seed = trace["seed"].as_u64().unwrap();
        let mut r = Rng::new(seed as u32);
        let mut now = T0;
        for (i, expected) in trace["steps"].as_array().unwrap().iter().enumerate() {
            now += r.advance();
            assert_eq!(now, expected["t"].as_i64().unwrap(), "seed {seed} step {i}");
            assert_eq!(
                random_event(&mut r, now),
                event(&expected["e"]),
                "seed {seed} step {i}"
            );
        }
    }
}
