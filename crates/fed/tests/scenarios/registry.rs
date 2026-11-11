use std::collections::BTreeMap;

use rchat_fed::health::{Dir, Event, Gate, HelloOk, Op, StrikeWhy, Why};
use rchat_fed::levels::Service;
use rchat_fed::psl::{self, List};
use rchat_fed::registry::{
    EstablishedRule, Fleet, HostWriter, MemoryWarmth, Pin, Warmth, WarmthStore, budget_domain,
    budgets_fit, established, fair_shares, fit_budgets, registrable, sibling_gate,
};

use crate::support::{T0, ours, said, signed, strike_on};

use Dir::{In, Out};
use Service::{Invites, Letters, Profiles};

const DAY: i64 = 86_400;

fn hello_as(f: &mut Fleet, host: &str, t: i64, id: &str, hello: HelloOk) {
    let hello = HelloOk {
        id: id.to_string(),
        ..hello
    };
    f.step(host, &said(hello, T0 + t), T0 + t);
}

fn strikes(f: &mut Fleet, host: &str, kid: &str, t: i64, svc: Service) {
    for i in 0..10 {
        f.step(host, &strike_on(svc, StrikeWhy::Malformed, kid), T0 + t + i);
    }
}

fn why(g: Gate) -> Option<Why> {
    match g {
        Gate::Go => None,
        Gate::No { why, until: _ } => Some(why),
    }
}

#[test]
fn a_host_that_claims_bs_instance_id_and_lists_bs_public_key_never_gates_b() {
    let mut f = Fleet::new(ours());
    hello_as(
        &mut f,
        "chat.b.example",
        0,
        "id-b",
        signed("kB", &["kB"], &["kB"]),
    );
    hello_as(
        &mut f,
        "evil.attacker.net",
        10,
        "id-b",
        signed("kX", &["kX", "kB"], &["kX"]),
    );
    strikes(&mut f, "evil.attacker.net", "kX", 20, Letters);
    strikes(&mut f, "evil.attacker.net", "kX", 50, Profiles);
    assert_eq!(
        why(f.gate("evil.attacker.net", Invites, In, T0 + 70, None)),
        Some(Why::Halted)
    );
    for s in [Letters, Invites, Profiles] {
        for d in [In, Out] {
            assert!(f.gate("chat.b.example", s, d, T0 + 70, None).go());
        }
    }
    assert!(f.siblings("chat.b.example").is_empty());
}

#[test]
fn claiming_only_the_id_never_gates_b_and_blocking_the_spammer_never_blocks_b() {
    let mut f = Fleet::new(ours());
    hello_as(
        &mut f,
        "chat.b.example",
        0,
        "id-b",
        signed("kB", &["kB"], &["kB"]),
    );
    hello_as(
        &mut f,
        "evil.attacker.net",
        10,
        "id-b",
        signed("kX", &["kX"], &["kX"]),
    );
    strikes(&mut f, "evil.attacker.net", "kX", 20, Letters);
    assert!(f.gate("chat.b.example", Letters, In, T0 + 40, None).go());
    f.step("evil.attacker.net", &Event::Op(Op::Block), T0 + 41);
    assert!(f.gate("chat.b.example", Letters, Out, T0 + 42, None).go());
}

#[test]
fn a_spammer_that_reuses_its_own_key_on_a_minted_host_is_caught_both_proved_it() {
    let mut f = Fleet::new(ours());
    hello_as(
        &mut f,
        "x1.spam.example",
        0,
        "i1",
        signed("kS", &["kS"], &["kS"]),
    );
    strikes(&mut f, "x1.spam.example", "kS", 1, Letters);
    hello_as(
        &mut f,
        "x2.other.example",
        20,
        "i2",
        signed("kS", &["kS"], &["kS"]),
    );
    assert_eq!(
        why(f.gate("x2.other.example", Letters, In, T0 + 21, None)),
        Some(Why::Paused)
    );
    assert_eq!(
        f.siblings("x2.other.example")
            .iter()
            .map(|h| h.host.as_str())
            .collect::<Vec<_>>(),
        ["x1.spam.example"]
    );
    f.step("x1.spam.example", &Event::Op(Op::Retry), T0 + 30);
    assert!(f.gate("x2.other.example", Letters, In, T0 + 31, None).go());
    f.step("x1.spam.example", &Event::Op(Op::BlockIn), T0 + 32);
    assert_eq!(
        f.gate("x2.other.example", Letters, In, T0 + 33, None),
        Gate::No {
            why: Why::Blocked,
            until: None
        }
    );
    assert!(f.gate("x2.other.example", Letters, Out, T0 + 33, None).go());
}

#[test]
fn a_key_only_listed_never_signed_with_links_nothing() {
    let mut f = Fleet::new(ours());
    hello_as(
        &mut f,
        "x1.spam.example",
        0,
        "i1",
        signed("kS", &["kS", "kT"], &["kS"]),
    );
    strikes(&mut f, "x1.spam.example", "kS", 1, Letters);
    hello_as(
        &mut f,
        "y.other.example",
        20,
        "i2",
        signed("kT", &["kT"], &["kT"]),
    );
    assert!(f.gate("y.other.example", Letters, In, T0 + 21, None).go());
}

#[test]
fn a_sibling_gates_only_an_open_gate_and_by_its_halt_pause_or_block() {
    let mut f = Fleet::new(ours());
    hello_as(
        &mut f,
        "x1.spam.example",
        0,
        "i1",
        signed("kS", &["kS"], &["kS"]),
    );
    strikes(&mut f, "x1.spam.example", "kS", 1, Letters);
    strikes(&mut f, "x1.spam.example", "kS", 20, Profiles);
    let sibling = f.host("x1.spam.example").unwrap().clone();
    let own = Gate::No {
        why: Why::Hello,
        until: None,
    };
    assert_eq!(sibling_gate(own, [&sibling], Letters, Out, T0 + 40), own);
    assert_eq!(
        why(sibling_gate(Gate::Go, [&sibling], Invites, In, T0 + 40)),
        Some(Why::Halted)
    );
    assert_eq!(
        sibling_gate(Gate::Go, [&sibling], Invites, Out, T0 + 40),
        Gate::Go
    );
    assert_eq!(sibling_gate(Gate::Go, [], Invites, In, T0 + 40), Gate::Go);
}

#[test]
fn cold_hosts_pool_by_icann_domain_established_ones_by_the_full_list() {
    assert_eq!(registrable("m1.alice.ts.net", List::Icann), "ts.net");
    assert_eq!(registrable("m1.alice.ts.net", List::Full), "alice.ts.net");
    assert_eq!(budget_domain("m1.alice.ts.net", true), "ts.net");
    assert_eq!(budget_domain("m1.alice.ts.net", false), "alice.ts.net");
    assert_eq!(
        registrable("fluffy-cat.trycloudflare.com", List::Full),
        "fluffy-cat.trycloudflare.com"
    );
    assert_eq!(registrable("x1.spam.example", List::Full), "spam.example");
    assert_eq!(registrable("a.b.co.uk", List::Full), "b.co.uk");
    for suffix in [
        "duckdns.org",
        "github.io",
        "fly.dev",
        "onrender.com",
        "ngrok-free.app",
    ] {
        let host = format!("deep.site.{suffix}");
        assert_eq!(registrable(&host, List::Full), format!("site.{suffix}"));
        assert_eq!(registrable(&host, List::Icann), suffix);
    }
}

#[test]
fn the_public_suffix_list_rules_wildcards_exceptions_and_the_default() {
    assert_eq!(psl::public_suffix("a.b.co.uk", List::Icann), "co.uk");
    assert_eq!(registrable("co.uk", List::Full), "co.uk");
    assert_eq!(registrable("uk", List::Full), "uk");
    assert_eq!(registrable("localhost", List::Full), "localhost");
    assert_eq!(
        registrable("deep.host.internal", List::Full),
        "host.internal"
    );
    assert_eq!(psl::public_suffix("a.b.ck", List::Icann), "b.ck");
    assert_eq!(registrable("x.a.b.ck", List::Icann), "a.b.ck");
    assert_eq!(psl::public_suffix("www.ck", List::Icann), "ck");
    assert_eq!(registrable("x.www.ck", List::Icann), "www.ck");
    assert_eq!(registrable("www.ck", List::Icann), "www.ck");
    assert_eq!(
        registrable("shop.xn--55qx5d.cn", List::Icann),
        "shop.xn--55qx5d.cn"
    );
    assert_eq!(
        registrable("a.shop.xn--55qx5d.cn", List::Icann),
        "shop.xn--55qx5d.cn"
    );
    assert_eq!(psl::public_suffix("ts.net", List::Full), "ts.net");
    assert_eq!(psl::public_suffix("ts.net", List::Icann), "net");
    assert_eq!(registrable("", List::Full), "");
    assert_eq!(registrable("a..example", List::Full), ".example");
    assert!(psl::rules(List::Icann) > 6000);
    assert!(psl::rules(List::Full) > psl::rules(List::Icann) + 2000);
}

#[test]
fn a_paused_evil_ts_net_never_puts_bob_ts_net_in_probation_its_own_minted_hosts_are() {
    let mut f = Fleet::new(ours());
    hello_as(
        &mut f,
        "m1.evil.ts.net",
        0,
        "ie",
        signed("kE", &["kE"], &["kE"]),
    );
    strikes(&mut f, "m1.evil.ts.net", "kE", 1, Letters);
    hello_as(
        &mut f,
        "pc.bob.ts.net",
        20,
        "ib",
        signed("kBob", &["kBob"], &["kBob"]),
    );
    f.step(
        "pc.bob.ts.net",
        &strike_on(Letters, StrikeWhy::Malformed, "kBob"),
        T0 + 21,
    );
    assert!(f.gate("pc.bob.ts.net", Letters, In, T0 + 22, None).go());
    hello_as(
        &mut f,
        "m2.evil.ts.net",
        30,
        "ie2",
        signed("kE2", &["kE2"], &["kE2"]),
    );
    f.step(
        "m2.evil.ts.net",
        &strike_on(Letters, StrikeWhy::Malformed, "kE2"),
        T0 + 31,
    );
    assert!(!f.gate("m2.evil.ts.net", Letters, In, T0 + 32, None).go());
}

#[test]
fn two_honest_hosts_and_one_abusive_one_in_a_pool_keep_their_full_traffic() {
    assert_eq!(
        fair_shares(1200.0, &[300.0, 300.0, 5000.0]),
        [300.0, 300.0, 600.0]
    );
    assert_eq!(
        fair_shares(1200.0, &[100.0, 5000.0, 5000.0]),
        [100.0, 550.0, 550.0]
    );
    assert_eq!(fair_shares(100.0, &[0.0, 0.0]), [0.0, 0.0]);
    assert_eq!(fair_shares(90.0, &[50.0, 50.0, 50.0]), [30.0, 30.0, 30.0]);
    assert_eq!(fair_shares(0.0, &[5.0]), [0.0]);
    assert_eq!(fair_shares(10.0, &[]), Vec::<f64>::new());
}

#[test]
fn published_per_service_budgets_fit_under_the_all_services_cap() {
    let defaults = BTreeMap::from([
        (Service::Letters, 400),
        (Service::Invites, 120),
        (Service::Profiles, 120),
        (Service::Reports, 10),
        (Service::Directory, 30),
        (Service::LetterKeys, 60),
    ]);
    assert!(!budgets_fit(600, &defaults));
    let fitted = fit_budgets(600, &defaults);
    assert!(budgets_fit(600, &fitted));
    assert!(fitted[&Service::Letters] > fitted[&Service::Invites]);
    assert_eq!(fitted[&Service::Letters], 400 * 600 / 740);
    assert_eq!(fit_budgets(1000, &defaults), defaults);
}

fn writers(f: &mut Fleet, host: &str, names: &[&str], t: i64) {
    for name in names {
        f.note_local_writer(host, name, T0 + t);
    }
}

#[test]
fn a_host_warms_only_with_two_local_writers_and_a_week_its_own_letters_never_warm_it() {
    let host = "chat.c.example";
    let mut f = Fleet::new(ours());
    f.get(host, T0);
    f.note_local_mail(host, T0 + 29 * DAY);
    assert!(f.is_cold(host, T0 + 30 * DAY));
    writers(&mut f, host, &["alice"], 0);
    assert!(f.is_cold(host, T0 + 30 * DAY));
    writers(&mut f, host, &["alice"], 5);
    assert!(f.is_cold(host, T0 + 30 * DAY));
    writers(&mut f, host, &["bob"], 10);
    f.note_local_mail(host, T0 + 10);
    assert!(f.is_cold(host, T0 + DAY));
    assert!(f.is_cold(host, T0 + 7 * DAY - 1));
    assert!(!f.is_cold(host, T0 + 7 * DAY));
    assert!(!f.is_cold(host, T0 + 8 * DAY));
    assert!(f.established(host, T0 + 8 * DAY));
    assert!(f.is_cold("never.seen.example", T0 + 8 * DAY));
}

#[test]
fn an_established_host_decays_after_thirty_days_without_local_mail() {
    let host = "chat.c.example";
    let mut f = Fleet::new(ours());
    f.get(host, T0);
    writers(&mut f, host, &["alice", "bob"], 0);
    assert!(f.established(host, T0 + 8 * DAY));
    assert!(f.is_cold(host, T0 + 30 * DAY + 1));
    f.note_local_mail(host, T0 + DAY);
    assert!(f.established(host, T0 + 8 * DAY));
    assert!(f.established(host, T0 + 31 * DAY));
    assert!(!f.established(host, T0 + 31 * DAY + 1));
    f.note_local_mail(host, T0 + 40 * DAY);
    assert!(f.established(host, T0 + 41 * DAY));
    f.note_local_mail(host, T0 + 2 * DAY);
    assert!(f.established(host, T0 + 69 * DAY));
}

#[test]
fn a_cooling_host_is_cold_until_the_cooling_ends_and_a_shorter_one_never_cuts_it() {
    let host = "chat.c.example";
    let mut f = Fleet::new(ours());
    f.get(host, T0);
    writers(&mut f, host, &["alice", "bob"], 0);
    f.note_local_mail(host, T0 + 8 * DAY);
    assert!(f.established(host, T0 + 8 * DAY));
    f.cool(host, T0 + 15 * DAY);
    f.cool(host, T0 + 10 * DAY);
    assert!(f.is_cold(host, T0 + 9 * DAY));
    assert!(f.is_cold(host, T0 + 15 * DAY - 1));
    assert!(f.established(host, T0 + 15 * DAY));
    assert_eq!(
        budget_domain("m1.alice.ts.net", f.is_cold(host, T0 + 9 * DAY)),
        "ts.net"
    );
}

#[test]
fn the_operators_pin_wins_over_everything_until_it_is_cleared() {
    let host = "chat.c.example";
    let mut f = Fleet::new(ours());
    f.get(host, T0);
    f.pin(host, Some(Pin::Warm), T0);
    assert!(f.established(host, T0 + 1));
    f.cool(host, T0 + 7 * DAY);
    assert!(f.established(host, T0 + 2));
    f.pin(host, None, T0 + 2);
    assert!(f.is_cold(host, T0 + 3));
    writers(&mut f, host, &["alice", "bob"], 0);
    f.note_local_mail(host, T0 + 8 * DAY);
    assert!(f.established(host, T0 + 8 * DAY));
    f.pin(host, Some(Pin::Cold), T0 + 8 * DAY);
    assert!(f.is_cold(host, T0 + 8 * DAY));
    f.pin("pinned.before.seen.example", Some(Pin::Warm), T0 + 9 * DAY);
    assert!(f.established("pinned.before.seen.example", T0 + 9 * DAY));
}

#[test]
fn the_rule_reads_plain_rows_and_the_operators_numbers() {
    let row = Warmth {
        first_seen: T0,
        last_local: Some(T0 + 3 * DAY),
        cooling_until: None,
        pin: None,
    };
    let default = EstablishedRule::default();
    assert_eq!(
        default,
        EstablishedRule {
            writers: 2,
            after_days: 7,
            decay_days: 30
        }
    );
    assert!(established(&row, 2, T0 + 7 * DAY, &default));
    assert!(!established(&row, 1, T0 + 7 * DAY, &default));
    let strict = EstablishedRule {
        writers: 3,
        after_days: 14,
        decay_days: 7,
    };
    assert!(!established(&row, 2, T0 + 14 * DAY, &strict));
    assert!(!established(&row, 3, T0 + 14 * DAY, &strict));
    assert!(established(
        &row,
        3,
        T0 + 10 * DAY,
        &EstablishedRule {
            after_days: 10,
            ..strict
        }
    ));
    let unwritten = Warmth {
        last_local: None,
        ..row
    };
    assert!(!established(&unwritten, 5, T0 + 30 * DAY, &default));
}

#[test]
fn the_store_keeps_one_row_per_host_and_writer_with_the_first_times() {
    let mut store = MemoryWarmth::default();
    assert_eq!(store.warmth("b.example"), None);
    store.first_seen("b.example", T0);
    store.first_seen("b.example", T0 + 99);
    assert_eq!(store.warmth("b.example").unwrap().first_seen, T0);
    let writer = |name: &str, since: i64| HostWriter {
        host: "b.example".to_string(),
        username: name.to_string(),
        since,
    };
    store.add_writer(writer("alice", T0 + 1));
    store.add_writer(writer("alice", T0 + 50));
    store.add_writer(writer("bob", T0 + 2));
    assert_eq!(store.writers("b.example"), 2);
    assert_eq!(store.writers("c.example"), 0);
    assert_eq!(
        store.writer_rows("b.example"),
        [writer("alice", T0 + 1), writer("bob", T0 + 2)]
    );
    let mut f = Fleet::with_store(ours(), store, EstablishedRule::default());
    f.note_local_mail("b.example", T0 + 3);
    assert!(f.established("b.example", T0 + 7 * DAY));
    assert_eq!(
        f.warmth.warmth("b.example").unwrap().last_local,
        Some(T0 + 3)
    );
}

#[test]
fn a_thief_with_a_hosts_retired_or_distrusted_key_never_gates_it_from_another_name() {
    let b = "chat.b.example";
    let evil = "evil.attacker.net";
    let mut f = Fleet::new(ours());
    hello_as(&mut f, b, 0, "id-b", signed("k1", &["k1"], &["k1"]));
    let rotated = HelloOk {
        endorsed: vec!["k2".to_string()],
        ..signed("k2", &["k1", "k2"], &["k2"])
    };
    hello_as(&mut f, b, 100, "id-b", rotated);
    hello_as(&mut f, b, 200, "id-b", signed("k2", &["k1", "k2"], &["k2"]));
    hello_as(
        &mut f,
        b,
        3800,
        "id-b",
        signed("k2", &["k1", "k2"], &["k2"]),
    );
    let key = |f: &Fleet, kid: &str| f.host(b).unwrap().keys[kid].clone();
    assert!(key(&f, "k1").retired && key(&f, "k1").proven);

    hello_as(&mut f, evil, 3900, "id-b", signed("k1", &["k1"], &["k1"]));
    strikes(&mut f, evil, "k1", 3910, Letters);
    strikes(&mut f, evil, "k1", 3930, Profiles);
    f.step(evil, &Event::Op(Op::Block), T0 + 3950);
    assert!(!f.gate(evil, Letters, In, T0 + 3960, None).go());
    assert!(f.siblings(b).is_empty() && f.siblings(evil).is_empty());
    for s in [Letters, Invites, Profiles] {
        for d in [In, Out] {
            assert!(f.gate(b, s, d, T0 + 3960, None).go(), "{s:?} {d:?}");
        }
    }

    let mut f = Fleet::new(ours());
    hello_as(
        &mut f,
        b,
        0,
        "id-b",
        signed("k1", &["k1", "k2"], &["k1", "k2"]),
    );
    f.step(
        b,
        &Event::InOk {
            svc: Letters,
            kid: "k2".to_string(),
        },
        T0 + 1,
    );
    hello_as(&mut f, evil, 10, "id-x", signed("k2", &["k2"], &["k2"]));
    assert_eq!(f.siblings(b).len(), 1);
    f.step(b, &Event::Op(Op::Distrust("k2".to_string())), T0 + 20);
    assert!(f.siblings(b).is_empty());
    f.step(evil, &Event::Op(Op::Block), T0 + 30);
    assert!(f.gate(b, Letters, In, T0 + 40, None).go());
    assert!(f.gate(b, Letters, Out, T0 + 40, None).go());
}

#[test]
fn two_local_users_accepting_letters_warm_a_host_after_a_week() {
    let host = "chat.c.example";
    let mut f = Fleet::new(ours());
    f.get(host, T0);
    f.note_local_writer(host, "alice", T0 + 10);
    assert!(f.is_cold(host, T0 + 8 * DAY));
    f.note_local_writer(host, "bob", T0 + 20);
    assert_eq!(f.warmth.warmth(host).unwrap().last_local, Some(T0 + 20));
    assert!(f.is_cold(host, T0 + 7 * DAY - 1));
    assert!(f.established(host, T0 + 7 * DAY));
    f.note_local_writer(host, "alice", T0 + 5);
    assert_eq!(f.warmth.warmth(host).unwrap().last_local, Some(T0 + 20));
    assert!(!f.established(host, T0 + 20 + 30 * DAY + 1));
}

#[test]
fn a_name_with_a_hundred_labels_is_matched_by_its_last_few() {
    let deep = format!("{}b.co.uk", "a.".repeat(120));
    assert_eq!(registrable(&deep, List::Full), "b.co.uk");
    assert_eq!(psl::public_suffix(&deep, List::Icann), "co.uk");
    let exception = format!("{}x.www.ck", "a.".repeat(100));
    assert_eq!(registrable(&exception, List::Icann), "www.ck");
    let wildcard = format!("{}x.a.b.ck", "a.".repeat(100));
    assert_eq!(registrable(&wildcard, List::Icann), "a.b.ck");
    let private = format!("{}m1.alice.ts.net", "a.".repeat(100));
    assert_eq!(registrable(&private, List::Full), "alice.ts.net");
    let unknown = format!("{}host.internal", "a.".repeat(100));
    assert_eq!(registrable(&unknown, List::Full), "host.internal");
    assert!((3..=8).contains(&psl::depth()), "{}", psl::depth());
}
