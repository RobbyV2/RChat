use std::collections::BTreeMap;

use rchat_fed::health::{
    Cause, Dir, Event, Gate, HelloFail, HelloOk, LinkState, Op, Refused, StrikeWhy, TheirPolicy,
    Why, fresh, gate, needs_hello, step, view,
};
use rchat_fed::levels::Service;
use rchat_fed::limits::{abuse, circuit, hello as hello_limits, keys as key_limits, strikes};

use crate::support::{
    T0, at, distrust, gate_at, go, hello, hello_at, in_ok, kids, letters_at, ours, run, run_from,
    said, signed, strike, strike_on, strikes, trust, v080,
};

use Dir::{In, Out};
use Service::{Core, Invites, Letters, Profiles, Reports};

fn no(why: Why, until: Option<i64>) -> Gate {
    Gate::No { why, until }
}

fn why(g: Gate) -> Option<Why> {
    match g {
        Gate::Go => None,
        Gate::No { why, until: _ } => Some(why),
    }
}

fn until(g: Gate) -> Option<i64> {
    match g {
        Gate::Go => None,
        Gate::No { why: _, until } => until,
    }
}

fn notice(h: &rchat_fed::health::Host, t: i64) -> String {
    view(h, &ours(), T0 + t).notice
}

fn state(h: &rchat_fed::health::Host, t: i64) -> LinkState {
    view(h, &ours(), T0 + t).state
}

fn limited(retry_after: i64, cause: Cause) -> Event {
    Event::InLimited {
        svc: Letters,
        retry_after,
        cause,
    }
}

fn out_fail() -> Event {
    Event::OutFail {
        svc: Letters,
        unauthenticated: false,
        their_now: None,
    }
}

fn refused(reason: Refused, until: Option<i64>) -> Event {
    Event::OutRefused {
        svc: Letters,
        reason,
        until,
    }
}

fn rotated_hello(endorsed: bool) -> HelloOk {
    HelloOk {
        endorsed: if endorsed { kids(&["k2"]) } else { Vec::new() },
        ..signed("k2", &["k1", "k2"], &["k2"])
    }
}

fn first_k1() -> (i64, Event) {
    hello_at(0, signed("k1", &["k1"], &["k1"]))
}

fn rotated() -> rchat_fed::health::Host {
    run(vec![
        first_k1(),
        hello_at(100, rotated_hello(true)),
        hello_at(200, rotated_hello(false)),
        hello_at(200 + key_limits::RETIRE_AFTER, rotated_hello(false)),
    ])
}

fn seal_only_first() -> (i64, Event) {
    hello_at(0, signed("kCur", &["kOld", "kCur"], &["kCur"]))
}

#[test]
fn a_takeover_that_copies_the_instance_id_but_signs_with_a_new_key_halts_both_ways() {
    let h = run(vec![
        hello_at(0, hello()),
        hello_at(100, signed("kEvil", &["kEvil"], &["kEvil"])),
    ]);
    assert_eq!(h.pending_keys, Some(kids(&["kEvil"])));
    for d in [In, Out] {
        assert_eq!(gate_at(&h, Letters, d, 101), no(Why::Identity, None));
    }
    assert!(notice(&h, 101).contains("now signs with a key this instance doesn't know"));
}

#[test]
fn a_takeover_that_also_serves_the_old_public_key_still_halts_only_the_signer_counts() {
    let h = run(vec![
        hello_at(0, hello()),
        hello_at(100, signed("kEvil", &["kB", "kEvil"], &["kB", "kEvil"])),
    ]);
    assert!(!go(&h, Letters, Out, 101));
    assert!(h.keys["kB"].call);
}

#[test]
fn an_honest_reinstall_that_keeps_its_key_gets_a_new_instance_id_and_no_question() {
    let reinstalled = HelloOk {
        id: "ib-reinstalled".to_string(),
        ..hello()
    };
    let h = run(vec![hello_at(0, hello()), hello_at(100, reinstalled)]);
    assert_eq!(h.pending_keys, None);
    assert_eq!(h.id_changed_at, Some(T0 + 100));
    assert!(go(&h, Letters, Out, 101));
}

#[test]
fn a_rotation_vouched_for_by_the_remembered_key_passes_and_the_old_key_stays() {
    let vouched = HelloOk {
        endorsed: kids(&["kB2"]),
        ..signed("kB2", &["kB", "kB2"], &["kB2"])
    };
    let mut h = run(vec![hello_at(0, hello()), hello_at(100, vouched)]);
    assert_eq!(h.pending_keys, None);
    assert!(h.keys["kB"].call && !h.keys["kB"].retired);
    assert_eq!(h.keys["kB"].omitted_since, None);
    assert!(h.keys["kB2"].call);
    h = at(&h, said(signed("kB2", &["kB2"], &["kB2"]), T0 + 200), 200);
    assert_eq!(h.keys.keys().cloned().collect::<Vec<_>>(), ["kB", "kB2"]);
}

#[test]
fn an_inbound_call_signed_by_an_unknown_key_raises_the_question_and_trust_needs_a_proven_hello() {
    let mut h = run(vec![hello_at(0, hello()), (10, in_ok("kX"))]);
    assert!(!go(&h, Letters, In, 11));
    assert_eq!(
        at(&h, Event::Op(Op::Retry), 12).pending_keys,
        Some(kids(&["kX"]))
    );
    assert_eq!(at(&h, trust("kX"), 13).pending_keys, Some(kids(&["kX"])));
    h = at(&h, said(signed("kX", &["kX"], &["kX"]), T0 + 20), 20);
    h = at(&h, trust("kX"), 21);
    let rec = &h.keys["kX"];
    assert!(rec.call && rec.proven && !rec.retired);
    assert!(go(&h, Letters, In, 22));
}

#[test]
fn the_remembered_key_coming_back_ends_the_question_and_keeps_being_asked_for() {
    let mut h = run(vec![
        hello_at(0, hello()),
        hello_at(100, signed("kEvil", &["kEvil"], &["kEvil"])),
    ]);
    assert_eq!(h.next_hello, T0 + 100 + hello_limits::RECHECK);
    assert!(needs_hello(&h, T0 + 100 + hello_limits::RECHECK));
    h = at(&h, said(hello(), T0 + 200), 200);
    assert_eq!(h.pending_keys, None);
}

#[test]
fn nothing_an_unknown_signer_says_is_applied() {
    let evil = HelloOk {
        caps: v080(),
        policy: BTreeMap::from([(Letters, TheirPolicy::Refused)]),
        ..signed("kEvil", &["kEvil"], &["kEvil"])
    };
    let h = run(vec![hello_at(0, hello()), hello_at(100, evil)]);
    assert_eq!(h.caps, Some(ours()));
    assert!(h.their_policy.is_empty());
}

#[test]
fn a_call_key_a_proven_hello_leaves_out_for_an_hour_is_retired_and_before_that_it_isnt() {
    let early = run(vec![
        first_k1(),
        hello_at(100, rotated_hello(true)),
        hello_at(200, rotated_hello(false)),
    ]);
    assert!(!early.keys["k1"].retired);
    assert_eq!(early.keys["k1"].omitted_since, Some(T0 + 200));
    let late = rotated();
    assert!(late.keys["k1"].retired && !late.keys["k1"].call);
}

#[test]
fn a_thief_with_the_retired_key_who_later_serves_the_domain_raises_the_question() {
    let h = at(
        &rotated(),
        said(signed("k1", &["k1"], &["k1"]), T0 + 9000),
        9000,
    );
    assert_eq!(h.pending_keys, Some(kids(&["k1"])));
    assert!(h.keys["k1"].retired);
    assert_eq!(gate_at(&h, Letters, Out, 9001), no(Why::Identity, None));
    assert!(notice(&h, 9001).contains("signed with a key it retired"));
}

#[test]
fn a_call_signed_with_a_retired_key_raises_the_question_too() {
    assert_eq!(
        at(&rotated(), in_ok("k1"), 9000).pending_keys,
        Some(kids(&["k1"]))
    );
}

#[test]
fn a_retired_key_listed_again_by_a_proven_hello_stays_retired() {
    let h = at(
        &rotated(),
        said(signed("k2", &["k1", "k2"], &["k1", "k2"]), T0 + 9000),
        9000,
    );
    assert!(h.keys["k1"].retired && !h.keys["k1"].call);
}

#[test]
fn trust_takes_one_chosen_key_never_every_pending_one() {
    let mut h = run(vec![first_k1(), (100, in_ok("kAtt"))]);
    h = at(
        &h,
        said(
            signed("kNewOwner", &["kNewOwner"], &["kNewOwner"]),
            T0 + 200,
        ),
        200,
    );
    assert_eq!(h.pending_keys, Some(kids(&["kAtt", "kNewOwner"])));
    assert_eq!(
        h.pending_proven
            .iter()
            .map(|p| p.kid.as_str())
            .collect::<Vec<_>>(),
        ["kNewOwner"]
    );
    assert!(!at(&h, trust("kAtt"), 300).keys.contains_key("kAtt"));
    h = at(&h, trust("kNewOwner"), 300);
    assert_eq!(
        h.keys.keys().cloned().collect::<Vec<_>>(),
        ["k1", "kNewOwner"]
    );
    assert_eq!(
        at(&h, in_ok("kAtt"), 400).pending_keys,
        Some(kids(&["kAtt"]))
    );
}

#[test]
fn trust_needs_a_fresh_hello_a_proven_hello_over_an_hour_old_doesnt_count() {
    let mut h = run(vec![first_k1()]);
    h = at(&h, said(signed("kN", &["kN"], &["kN"]), T0 + 10), 10);
    assert_eq!(
        at(&h, trust("kN"), 10 + hello_limits::TTL + 1).pending_keys,
        Some(kids(&["kN"]))
    );
    assert_eq!(
        at(&h, trust("kN"), 10 + hello_limits::TTL).pending_keys,
        None
    );
}

#[test]
fn pending_keys_are_capped_at_eight_per_host() {
    let mut h = run(vec![hello_at(0, hello())]);
    for i in 0..20 {
        h = at(&h, in_ok(&format!("kx{i}")), 10 + i);
    }
    let pending = h.pending_keys.unwrap();
    assert_eq!(pending.len(), key_limits::PENDING_MAX);
    assert_eq!(pending[key_limits::PENDING_MAX - 1], "kx19");
    assert_eq!(pending[0], "kx12");
}

#[test]
fn distrust_retires_a_remembered_key_and_its_next_use_is_the_identity_question() {
    let mut h = run(vec![hello_at(
        0,
        signed("k1", &["k1", "k2"], &["k1", "k2"]),
    )]);
    h = at(&h, distrust("k2"), 5);
    assert!(h.keys["k2"].retired);
    assert_eq!(at(&h, in_ok("k2"), 6).pending_keys, Some(kids(&["k2"])));
    assert_eq!(at(&h, in_ok("k1"), 6).pending_keys, None);
    assert_eq!(at(&h, distrust("k2"), 7), h);
    assert_eq!(at(&h, distrust("kNever"), 7), h);
}

#[test]
fn a_seal_only_key_promoted_by_its_own_hello_raises_the_question_and_retires_nothing() {
    let mut h = run(vec![seal_only_first()]);
    assert!(h.keys["kOld"].seal_only && !h.keys["kOld"].call);
    let thief = |t: i64| {
        said(
            HelloOk {
                rev: 5,
                ..signed("kOld", &["kOld"], &["kOld"])
            },
            T0 + t,
        )
    };
    h = at(&h, thief(90_000), 90_000);
    assert_eq!(h.pending_keys, Some(kids(&["kOld"])));
    assert_eq!(gate_at(&h, Letters, Out, 90_001), no(Why::Identity, None));
    assert!(notice(&h, 90_001).contains("only published for old seals"));
    for t in 1..=5 {
        h = at(&h, thief(90_000 + t * 3600), 90_000 + t * 3600);
    }
    assert!(h.keys["kCur"].call && !h.keys["kCur"].retired);
    h = at(
        &h,
        said(signed("kCur", &["kOld", "kCur"], &["kCur"]), T0 + 120_000),
        120_000,
    );
    assert_eq!(h.pending_keys, None);
}

#[test]
fn a_seal_only_key_becomes_a_call_key_through_an_endorsement_by_a_current_call_key() {
    let mut h = run(vec![seal_only_first()]);
    let lifted = HelloOk {
        endorsed: kids(&["kOld"]),
        ..signed("kCur", &["kOld", "kCur"], &["kOld", "kCur"])
    };
    h = at(&h, said(lifted, T0 + 100), 100);
    assert!(!h.keys["kOld"].seal_only && h.keys["kOld"].call);
    assert_eq!(at(&h, in_ok("kOld"), 101).pending_keys, None);
}

#[test]
fn listing_a_seal_only_key_as_a_call_key_without_an_endorsement_changes_nothing() {
    let mut h = run(vec![seal_only_first()]);
    h = at(
        &h,
        said(
            signed("kCur", &["kOld", "kCur"], &["kOld", "kCur"]),
            T0 + 100,
        ),
        100,
    );
    assert!(h.keys["kOld"].seal_only && !h.keys["kOld"].call);
}

#[test]
fn a_signer_this_hello_just_admitted_cant_start_retiring_the_others() {
    let mut h = run(vec![first_k1()]);
    h = at(&h, said(rotated_hello(true), T0 + 100), 100);
    assert_eq!(h.keys["k1"].omitted_since, None);
    h = at(&h, said(rotated_hello(false), T0 + 200), 200);
    assert_eq!(h.keys["k1"].omitted_since, Some(T0 + 200));
}

#[test]
fn trust_says_hello_first_so_a_question_raised_long_ago_is_answered_in_one_action() {
    let mut h = run(vec![
        first_k1(),
        hello_at(100, signed("kN", &["kN"], &["kN"])),
    ]);
    let later = 5 * 3600;
    assert_eq!(at(&h, trust("kN"), later).pending_keys, Some(kids(&["kN"])));
    h = at(&h, said(signed("kN", &["kN"], &["kN"]), T0 + later), later);
    h = at(&h, trust("kN"), later);
    assert!(h.keys["kN"].call && h.keys["kN"].proven);
    assert_eq!(h.next_hello, T0 + later);
}

#[test]
fn a_hello_whose_proof_key_isnt_one_of_its_call_keys_is_unauthenticated_not_a_new_identity() {
    let h = run(vec![
        hello_at(0, hello()),
        hello_at(10, signed("kB", &["kB", "kC"], &["kC"])),
    ]);
    assert_eq!(h.pending_keys, None);
    assert_eq!(h.unauth_at, Some(T0 + 10));
    let unserved = run(vec![
        hello_at(0, hello()),
        hello_at(10, signed("kB", &["kC"], &["kB", "kC"])),
    ]);
    assert_eq!(unserved.unauth_at, Some(T0 + 10));
    assert!(!unserved.keys.contains_key("kC"));
}

#[test]
fn a_shared_cap_answer_never_touches_the_hosts_record() {
    let mut h = run(vec![hello_at(0, hello())]);
    let before = h.clone();
    for m in 0..120 {
        h = at(&h, limited(600, Cause::Shared), 60 * m);
    }
    assert_eq!(h, before);
}

#[test]
fn busy_holds_every_service_of_the_destination_and_a_429_holds_that_service() {
    let mut h = run(vec![
        hello_at(0, hello()),
        (10, Event::OutBusy { until: T0 + 70 }),
    ]);
    for s in [Letters, Invites, Profiles] {
        assert_eq!(gate_at(&h, s, Out, 20), no(Why::Held, Some(T0 + 70)));
    }
    assert!(!needs_hello(&h, T0 + 20));
    assert!(go(&h, Letters, Out, 70));
    h = at(
        &h,
        Event::OutLimited {
            svc: Letters,
            until: T0 + 200,
        },
        100,
    );
    assert_eq!(why(gate_at(&h, Letters, Out, 150)), Some(Why::Held));
    assert!(go(&h, Invites, Out, 150));
    assert_eq!(state(&h, 150), LinkState::Ok);
}

#[test]
fn a_hold_is_never_longer_than_an_hour() {
    let h = run(vec![
        hello_at(0, hello()),
        (
            10,
            Event::OutLimited {
                svc: Letters,
                until: T0 + 1_000_000,
            },
        ),
        (
            11,
            Event::OutBusy {
                until: T0 + 1_000_000,
            },
        ),
    ]);
    assert_eq!(h.holds[&Some(Letters)], T0 + 10 + 3600);
    assert_eq!(h.holds[&None], T0 + 11 + 3600);
}

#[test]
fn retry_never_lifts_a_hold_the_other_side_gave() {
    let h = run(vec![
        hello_at(0, hello()),
        (10, Event::OutBusy { until: T0 + 70 }),
        (11, Event::Op(Op::Retry)),
        hello_at(12, hello()),
    ]);
    assert_eq!(gate_at(&h, Letters, Out, 20), no(Why::Held, Some(T0 + 70)));
}

#[test]
fn a_404_or_401_from_a_host_that_announces_the_protocol_is_never_unsupported() {
    let unauth = Event::HelloFail {
        why: HelloFail::Unauthenticated,
        their_now: None,
    };
    let mut h = run(vec![hello_at(0, hello()), (3600, unauth.clone())]);
    assert_eq!(state(&h, 3601), LinkState::Degraded);
    assert!(notice(&h, 3601).contains("doesn't accept this instance's calls (clock or keys)"));
    for i in 0..10 {
        h = at(&h, unauth.clone(), 3700 + i);
    }
    assert_eq!(state(&h, 3800), LinkState::Degraded);
    assert_eq!(h.support, rchat_fed::health::Support::Rchat);
}

#[test]
fn only_the_discovery_document_makes_a_host_unsupported_checked_daily() {
    let h = run(vec![(
        0,
        Event::HelloFail {
            why: HelloFail::NoFed,
            their_now: None,
        },
    )]);
    assert_eq!(state(&h, 0), LinkState::Unsupported);
    assert_eq!(
        gate_at(&h, Letters, Out, 0),
        no(
            Why::Unsupported,
            Some(T0 + hello_limits::RECHECK_UNSUPPORTED)
        )
    );
    assert!(go(&h, Letters, In, 0));
    assert_eq!(
        notice(&h, 0),
        "b.example runs an RChat version without the instance protocol. Checked again every day."
    );
    let other = run(vec![(
        0,
        Event::HelloFail {
            why: HelloFail::NotRchat,
            their_now: None,
        },
    )]);
    assert_eq!(notice(&other, 0), "b.example isn't an RChat instance.");
}

#[test]
fn a_caller_whose_clock_is_31_s_fast_learns_the_skew_from_date_and_recovers() {
    let mut h = run(vec![
        hello_at(0, hello()),
        (
            100,
            Event::HelloFail {
                why: HelloFail::Unauthenticated,
                their_now: Some(T0 + 100 - 31),
            },
        ),
    ]);
    assert_eq!(h.skew, -31);
    assert!(notice(&h, 101).contains("The clocks differ by 31 seconds."));
    h = at(&h, said(hello(), T0 + 200 - 31), 200);
    assert_eq!(state(&h, 201), LinkState::Degraded);
    assert!(notice(&h, 201).contains("Calls are adjusted for it."));
    assert!(go(&h, Letters, Out, 201));
}

#[test]
fn bad_seals_on_a_third_hosts_messages_never_pause_the_relayer() {
    let mut relayer = run_from(
        fresh("a.example", None),
        &ours(),
        vec![hello_at(0, hello())],
    );
    let mut author = run_from(
        fresh("c.example", None),
        &ours(),
        vec![hello_at(0, signed("kC", &["kC"], &["kC"]))],
    );
    for i in 0..50 {
        author = at(&author, Event::ThirdParty { svc: Letters }, 10 + i);
    }
    assert!(go(&relayer, Letters, In, 100));
    assert!(go(&author, Letters, In, 100));
    assert_eq!(author.third_party, 50);
    relayer = at(
        &relayer,
        strike_on(Letters, StrikeWhy::BadOwnSeal, "kB"),
        200,
    );
    assert!(go(&relayer, Letters, In, 201));
}

#[test]
fn the_callers_own_bad_seals_and_content_ids_weigh_five() {
    let h = run(vec![
        hello_at(0, hello()),
        (1, strike_on(Letters, StrikeWhy::BadOwnSeal, "kB")),
        (2, strike_on(Letters, StrikeWhy::BadObject, "kB")),
    ]);
    assert!(!go(&h, Letters, In, 3));
}

#[test]
fn peers_on_0_8_0_get_letters_not_the_0_9_0_services() {
    let h = run(vec![hello_at(
        0,
        HelloOk {
            caps: v080(),
            ..hello()
        },
    )]);
    assert!(go(&h, Letters, Out, 0));
    assert_eq!(why(gate_at(&h, Invites, Out, 0)), Some(Why::Version));
    assert_eq!(notice(&h, 0), "b.example doesn't offer invite previews.");
    assert_eq!(h.next_hello, T0 + hello_limits::RECHECK);
}

#[test]
fn a_host_whose_letters_level_is_below_our_floor_is_halted_both_ways_until_it_updates() {
    let future = letters_at(3, 2);
    let old = HelloOk {
        caps: v080(),
        ..hello()
    };
    let mut h = run_from(fresh("b.example", None), &future, vec![hello_at(0, old)]);
    assert!(!gate(&h, &future, Letters, Out, T0, None).go());
    assert!(!gate(&h, &future, Letters, In, T0, None).go());
    assert_eq!(
        view(&h, &future, T0).notice,
        "b.example runs an older protocol for letters (letters 1). Paused until it updates. Checked every 6 hours."
    );
    let updated = HelloOk {
        caps: future.clone(),
        rev: 2,
        ..hello()
    };
    h = step(&h, &said(updated, 0), T0 + hello_limits::RECHECK, &future);
    assert!(gate(&h, &future, Letters, Out, T0 + hello_limits::RECHECK, None).go());
}

#[test]
fn a_caller_that_just_upgraded_passes_the_inbound_version_check_before_its_new_hello() {
    let h = run(vec![hello_at(
        0,
        HelloOk {
            caps: v080(),
            rev: 4,
            ..hello()
        },
    )]);
    assert_eq!(why(gate_at(&h, Invites, In, 1)), Some(Why::Version));
    assert!(gate(&h, &ours(), Invites, In, T0 + 1, Some(5)).go());
    assert!(!gate(&h, &ours(), Invites, In, T0 + 1, Some(4)).go());
    assert!(!gate(&h, &ours(), Invites, Out, T0 + 1, Some(5)).go());
}

#[test]
fn when_we_are_the_old_one_the_notice_says_to_update_this_instance() {
    let h = run(vec![hello_at(
        0,
        HelloOk {
            caps: letters_at(4, 3),
            ..hello()
        },
    )]);
    assert_eq!(
        notice(&h, 0),
        "b.example needs a newer RChat for letters (letters 4). Update this instance to reach it."
    );
    assert_eq!(state(&h, 0), LinkState::Version);
}

#[test]
fn transport_failures_open_the_circuit_probes_are_hellos_never_a_pause() {
    let mut h = run(vec![hello_at(0, hello())]);
    for i in 1..=i64::from(circuit::FAILS) {
        h = at(&h, out_fail(), i);
    }
    assert_eq!(why(gate_at(&h, Letters, Out, 10)), Some(Why::Waiting));
    let probe = i64::from(circuit::FAILS) + circuit::PROBES[0];
    assert!(needs_hello(&h, T0 + probe));
    assert!(!needs_hello(&h, T0 + probe - 1));
    assert!(!go(&h, Letters, Out, probe));
    assert!(h.pauses.is_empty());
    assert_eq!(
        notice(&h, 10),
        "b.example isn't answering. Next try at 01/15 08:01 UTC."
    );
    assert_eq!(
        state(&h, circuit::UNREACHABLE_AFTER + 10),
        LinkState::Unreachable
    );
    assert_eq!(
        notice(&h, circuit::UNREACHABLE_AFTER + 10),
        "b.example hasn't answered since 01/15 08:00 UTC. Waiting items stay queued until they expire."
    );
    h = at(&h, said(hello(), T0 + 100), 100);
    assert_eq!(state(&h, 100), LinkState::Ok);
    assert_eq!(notice(&h, 100), "");
}

#[test]
fn probe_delays_grow_and_hold_at_an_hour() {
    let mut h = run(vec![hello_at(0, hello())]);
    for i in 0..10 {
        h = at(&h, out_fail(), i);
    }
    assert_eq!(h.circuit.next_probe - (T0 + 9), 3600);
}

#[test]
fn one_strike_never_pauses_and_ten_in_an_hour_pause_inbound_letters_for_an_hour() {
    let mut h = run(vec![hello_at(0, hello()), strike(1)]);
    assert!(go(&h, Letters, In, 1));
    assert_eq!(state(&h, 1), LinkState::Degraded);
    assert_eq!(
        notice(&h, 1),
        "b.example sent some malformed calls in the last hour."
    );
    h = run_from(h, &ours(), strikes(2, 9));
    assert_eq!(
        gate_at(&h, Letters, In, 11),
        no(Why::Paused, Some(T0 + 10 + strikes::COOLDOWN))
    );
    assert!(go(&h, Letters, Out, 11));
    assert!(go(&h, Invites, In, 11));
    assert_eq!(
        notice(&h, 11),
        "b.example sent malformed calls for letters. Calls from it are paused until 01/15 09:00 UTC."
    );
}

#[test]
fn a_strike_in_probation_pauses_again_for_twice_as_long_capped_at_a_day() {
    let mut events = vec![hello_at(0, hello())];
    events.extend(strikes(1, 10));
    let mut h = run(events);
    let mut t = 10 + strikes::COOLDOWN;
    let mut lengths = Vec::new();
    for _ in 0..8 {
        t += 1;
        h = at(&h, strike(t).1, t);
        let (_, p) = h
            .pauses
            .iter()
            .find(|(key, _)| *key == (Letters, In))
            .unwrap();
        lengths.push(p.until - p.since);
        t = p.until - T0;
    }
    assert_eq!(
        lengths,
        [7200, 14400, 28800, 57600, 86400, 86400, 86400, 86400]
    );
}

#[test]
fn two_services_paused_one_way_halt_the_whole_host_that_way() {
    let mut events = vec![hello_at(0, hello())];
    events.extend(strikes(1, 10));
    let mut h = run(events);
    for i in 0..10 {
        h = at(&h, strike_on(Profiles, StrikeWhy::Malformed, "kB"), 20 + i);
    }
    let halt = T0 + 29 + strikes::COOLDOWN;
    assert_eq!(gate_at(&h, Reports, In, 40), no(Why::Halted, Some(halt)));
    assert!(go(&h, Reports, Out, 40));
    assert_eq!(state(&h, 40), LinkState::Halted);
    assert_eq!(
        notice(&h, 40),
        "b.example sent malformed calls for several services. Everything from it is halted until 01/15 09:00 UTC."
    );
}

#[test]
fn malformed_hello_calls_halt_everything_inbound() {
    let mut h = run(vec![hello_at(0, hello())]);
    for i in 0..10 {
        h = at(&h, strike_on(Core, StrikeWhy::Malformed, "kB"), 1 + i);
    }
    assert_eq!(why(gate_at(&h, Letters, In, 20)), Some(Why::Halted));
}

#[test]
fn retry_clears_pauses_and_strikes() {
    let mut events = vec![hello_at(0, hello())];
    events.extend(strikes(1, 10));
    let mut h = run(events);
    h = at(&h, Event::Op(Op::Retry), 20);
    assert!(go(&h, Letters, In, 20));
    assert_eq!(h.next_hello, T0 + 20);
    assert!(h.pauses.is_empty() && h.strikes.is_empty() && h.probation.is_empty());
}

#[test]
fn bad_answers_pause_the_outbound_side_only() {
    let mut h = run(vec![hello_at(0, hello())]);
    for i in 0..10 {
        h = at(&h, Event::OutBadReply { svc: Letters }, 1 + i);
    }
    assert!(!go(&h, Letters, Out, 20));
    assert!(go(&h, Letters, In, 20));
    assert_eq!(
        notice(&h, 20),
        "b.example gave malformed answers for letters. Calls to it are paused until 01/15 09:00 UTC."
    );
}

#[test]
fn draining_a_backlog_for_three_hours_at_the_limit_honouring_retry_after_never_pauses() {
    let mut h = run(vec![hello_at(0, hello())]);
    for m in 0..180 {
        h = at(&h, limited(20, Cause::Host), 60 * m + 5);
    }
    assert!(go(&h, Letters, In, 180 * 60));
    assert!(h.violations.is_empty());
}

#[test]
fn thirty_minutes_of_calls_while_told_to_wait_pause_inbound_for_six_hours() {
    let mut h = run(vec![
        hello_at(0, hello()),
        (0, limited(3 * 3600, Cause::Host)),
    ]);
    for m in 1..=30 {
        for c in 0..5 {
            h = at(&h, limited(600, Cause::Host), 60 * m + c);
        }
    }
    let g = gate_at(&h, Letters, In, 60 * 31);
    assert_eq!(why(g), Some(Why::Paused));
    assert_eq!(until(g).unwrap() - (T0 + 60 * 30 + 3), abuse::COOLDOWN);
    assert_eq!(
        notice(&h, 60 * 31),
        "b.example kept calling for letters while told to wait. Calls from it are paused until 01/15 14:30 UTC."
    );
}

#[test]
fn a_few_stray_calls_from_copies_that_hadnt_heard_of_the_429_yet_never_count() {
    let mut h = run(vec![
        hello_at(0, hello()),
        (0, limited(3 * 3600, Cause::Host)),
    ]);
    for c in 1..10 {
        h = at(&h, limited(600, Cause::Host), c);
    }
    for m in 1..=60 {
        for c in 0..3 {
            h = at(&h, limited(600, Cause::Host), 60 * m + c);
        }
    }
    assert!(h.violations.get(&Letters).is_none_or(|v| v.is_empty()));
    assert!(go(&h, Letters, In, 3700));
}

#[test]
fn block_stops_both_ways_and_only_unblock_lifts_it() {
    let mut h = run(vec![
        hello_at(0, hello()),
        (1, Event::Op(Op::Block)),
        (2, Event::Op(Op::Retry)),
        hello_at(3, hello()),
    ]);
    assert_eq!(gate_at(&h, Letters, Out, 4), no(Why::Blocked, None));
    assert!(!needs_hello(&h, T0 + 100_000));
    assert_eq!(notice(&h, 4), "Blocked by you on 01/15 08:00 UTC.");
    h = at(&h, Event::Op(Op::Unblock), 5);
    h = at(&h, said(hello(), T0 + 6), 6);
    assert!(go(&h, Letters, Out, 6));
}

#[test]
fn block_calls_from_it_only_our_users_can_still_write_there() {
    let h = run(vec![hello_at(0, hello()), (1, Event::Op(Op::BlockIn))]);
    assert!(!go(&h, Letters, In, 2));
    assert!(go(&h, Letters, Out, 2));
    assert_eq!(
        notice(&h, 2),
        "Calls from b.example blocked by you on 01/15 08:00 UTC. This instance still sends to it."
    );
}

#[test]
fn refused_stop_calling_until_the_next_hello_says_otherwise() {
    let mut h = run(vec![
        hello_at(0, hello()),
        (1, refused(Refused::Refused, None)),
    ]);
    assert_eq!(why(gate_at(&h, Letters, Out, 2)), Some(Why::RefusedByThem));
    assert_eq!(
        notice(&h, 2),
        "b.example doesn't take letters from this instance."
    );
    let accepted = HelloOk {
        policy: BTreeMap::from([(Letters, TheirPolicy::Accepted)]),
        ..hello()
    };
    let t = hello_limits::RECHECK + 1;
    h = at(&h, said(accepted, T0 + t), t);
    assert!(go(&h, Letters, Out, t + 1));
}

#[test]
fn paused_by_them_wait_until_their_time_at_most_48_hours() {
    let h = run(vec![
        hello_at(0, hello()),
        (1, refused(Refused::Paused, Some(T0 + 1_000_000_000))),
    ]);
    assert_eq!(
        gate_at(&h, Letters, Out, 2),
        no(Why::PausedByThem, Some(T0 + 1 + 48 * 3600))
    );
    assert_eq!(
        notice(&h, 2),
        "b.example paused letters from this instance until 01/17 08:00 UTC."
    );
    let unsaid = run(vec![
        hello_at(0, hello()),
        (1, refused(Refused::Paused, None)),
    ]);
    assert_eq!(
        until(gate_at(&unsaid, Letters, Out, 2)),
        Some(T0 + 1 + strikes::COOLDOWN)
    );
}

#[test]
fn an_identity_refusal_stops_outbound_until_their_operator_accepts_this_key() {
    let h = run(vec![
        hello_at(0, hello()),
        (1, refused(Refused::Identity, None)),
    ]);
    assert_eq!(
        gate_at(&h, Invites, Out, 2),
        no(Why::IdentityByThem, Some(T0 + 1 + hello_limits::RECHECK))
    );
    assert!(go(&h, Letters, In, 2));
    assert_eq!(
        notice(&h, 2),
        "b.example doesn't recognize this instance's key. Its operator has to accept this one."
    );
}

#[test]
fn a_version_or_hello_needed_refusal_asks_hello_at_once() {
    for reason in [Refused::Version, Refused::HelloNeeded] {
        let h = run(vec![hello_at(0, hello()), (100, refused(reason, None))]);
        assert_eq!(h.next_hello, T0 + 100);
    }
}

#[test]
fn outbound_waits_for_a_fresh_hello() {
    let h = run(vec![hello_at(0, hello())]);
    assert_eq!(
        gate_at(&h, Letters, Out, hello_limits::TTL),
        no(Why::Hello, None)
    );
    assert!(go(&h, Letters, Out, hello_limits::TTL - 1));
    assert_eq!(
        gate(&fresh("b.example", None), &ours(), Letters, Out, T0, None),
        no(Why::Hello, None)
    );
    assert_eq!(state(&fresh("b.example", None), 0), LinkState::Unknown);
}

#[test]
fn published_budgets_are_kept_for_pacing() {
    let h = run(vec![hello_at(
        0,
        HelloOk {
            budgets: BTreeMap::from([(Letters, 400), (Invites, 120)]),
            ..hello()
        },
    )]);
    assert_eq!(h.budgets, BTreeMap::from([(Letters, 400), (Invites, 120)]));
    assert_eq!(h.hello_rev, 1);
    assert_eq!(h.hello_at, Some(T0));
}

#[test]
fn a_clock_value_from_the_far_end_of_time_never_overflows() {
    for their_now in [i64::MIN, i64::MAX] {
        let h = run(vec![hello_at(0, hello()), (10, said(hello(), their_now))]);
        assert_eq!(state(&h, 11), LinkState::Degraded);
        assert!(notice(&h, 11).len() <= 200);
        assert!(go(&h, Letters, Out, 11));
        let failed = at(
            &h,
            Event::HelloFail {
                why: HelloFail::Unauthenticated,
                their_now: Some(their_now),
            },
            12,
        );
        assert!(notice(&failed, 13).contains("The clocks differ by"));
    }
    let far = run(vec![
        hello_at(0, hello()),
        (1, refused(Refused::Paused, Some(i64::MIN))),
        (
            2,
            Event::OutLimited {
                svc: Letters,
                until: i64::MAX,
            },
        ),
        (3, Event::OutBusy { until: i64::MIN }),
    ]);
    assert_eq!(why(gate_at(&far, Letters, Out, 4)), Some(Why::Held));
    assert!(go(&far, Invites, Out, 4));
}

#[test]
fn a_host_is_remembered_by_at_most_64_keys_and_endorsements_beyond_admit_nothing() {
    let max = key_limits::REMEMBERED_MAX;
    let names: Vec<String> = (0..max).map(|i| format!("k{i:02}")).collect();
    let served: Vec<&str> = names.iter().map(String::as_str).collect();
    let mut h = run(vec![hello_at(0, signed("k00", &served, &["k00"]))]);
    assert_eq!(h.keys.len(), max);
    let mut more = served.clone();
    more.push("kNew");
    let endorsing = HelloOk {
        endorsed: kids(&["kNew"]),
        ..signed("k00", &more, &["k00", "kNew"])
    };
    h = at(&h, said(endorsing, T0 + 10), 10);
    assert_eq!(h.keys.len(), max);
    assert!(!h.keys.contains_key("kNew"));
    assert_eq!(h.pending_keys, None);
    assert_eq!(
        at(&h, in_ok("kNew"), 11).pending_keys,
        Some(kids(&["kNew"]))
    );
}

#[test]
fn a_first_contact_serving_too_many_keys_remembers_the_call_keys_first() {
    let names: Vec<String> = (0..200).map(|i| format!("k{i:03}")).collect();
    let served: Vec<&str> = names.iter().map(String::as_str).collect();
    let h = run(vec![hello_at(
        0,
        signed("k199", &served, &["k150", "k199"]),
    )]);
    assert_eq!(h.keys.len(), key_limits::REMEMBERED_MAX);
    assert_eq!(h.pending_keys, None);
    assert!(h.keys["k199"].call && h.keys["k199"].proven);
    assert!(h.keys["k150"].call);
    assert!(h.keys["k000"].seal_only);
    assert!(!h.keys.contains_key("k100"));
}
