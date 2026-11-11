use rchat_fed::guard::{Fetch, KeyFetchGuard, LookupGuard};
use rchat_fed::limits::{key_fetch, lookup_new_hosts};

const T0: i64 = 1_800_000_000;

#[test]
fn one_network_gets_at_most_its_share_of_key_fetches_then_a_trickle() {
    let mut g = KeyFetchGuard::default();
    let net = "203.0.113.0/24";
    let ok = (0..100)
        .filter(|i| {
            g.may_fetch(
                net,
                &format!("https://h{i}.evil.example"),
                true,
                false,
                false,
                T0,
            ) == Fetch::Ok
        })
        .count();
    assert_eq!(ok, key_fetch::PER_NETWORK_MINUTE);
    assert_eq!(
        g.may_fetch(
            net,
            "https://late.evil.example",
            true,
            false,
            false,
            T0 + 61
        ),
        Fetch::Ok
    );
    assert_eq!(
        g.may_fetch(
            net,
            "https://later.evil.example",
            true,
            false,
            false,
            T0 + 62
        ),
        Fetch::Busy
    );
    assert_eq!(
        g.may_fetch(
            "198.51.100.0/24",
            "https://new.good.example",
            true,
            false,
            false,
            T0
        ),
        Fetch::Ok
    );
}

#[test]
fn six_networks_of_five_hellos_no_longer_stop_an_honest_new_instance() {
    let mut g = KeyFetchGuard::default();
    for n in 0..6 {
        for i in 0..5 {
            g.may_fetch(
                &format!("net{n}"),
                &format!("https://x{n}{i}.evil.net"),
                true,
                false,
                false,
                T0,
            );
        }
    }
    assert_eq!(
        g.may_fetch(
            "honest-net",
            "https://new.honest.org",
            true,
            false,
            false,
            T0 + 1
        ),
        Fetch::Ok
    );
}

#[test]
fn under_pressure_a_strangers_hello_needs_a_stamp_and_a_stamped_one_passes() {
    let mut g = KeyFetchGuard::default();
    for n in 0..20 {
        for i in 0..5 {
            g.may_fetch(
                &format!("net{n}"),
                &format!("https://x{n}-{i}.evil.net"),
                true,
                false,
                false,
                T0,
            );
        }
    }
    let honest = "https://new.honest.org";
    assert_eq!(
        g.may_fetch("honest-net", honest, true, false, false, T0 + 1),
        Fetch::StampNeeded
    );
    assert_eq!(
        g.may_fetch("honest-net", honest, true, true, false, T0 + 1),
        Fetch::Ok
    );
    assert_eq!(
        g.may_fetch(
            "net0",
            "https://neighbour.honest.org",
            true,
            true,
            false,
            T0 + 2
        ),
        Fetch::Ok
    );
}

#[test]
fn the_global_number_is_an_amplification_bound() {
    let mut g = KeyFetchGuard::default();
    let ok = (0..2000)
        .filter(|i| {
            g.may_fetch(
                &format!("net{i}"),
                &format!("https://h{i}.example"),
                true,
                true,
                false,
                T0,
            ) == Fetch::Ok
        })
        .count();
    assert_eq!(ok, key_fetch::PER_MINUTE);
}

#[test]
fn hosts_we_already_talk_to_never_wait_for_strangers() {
    let mut g = KeyFetchGuard::default();
    let net = "203.0.113.0/24";
    for i in 0..100 {
        g.may_fetch(
            net,
            &format!("https://h{i}.evil.example"),
            true,
            false,
            false,
            T0,
        );
    }
    assert_eq!(
        g.may_fetch(net, "https://a.example", true, false, true, T0),
        Fetch::Ok
    );
}

#[test]
fn a_hello_may_refetch_a_hosts_keys_at_most_every_30_s() {
    let mut g = KeyFetchGuard::default();
    let a = "https://a.example";
    assert_eq!(g.may_fetch("n", a, true, false, true, T0), Fetch::Ok);
    assert_eq!(g.may_fetch("n", a, true, false, true, T0 + 10), Fetch::Busy);
    assert_eq!(
        g.may_fetch("n", a, true, false, true, T0 + key_fetch::HELLO_REFETCH),
        Fetch::Ok
    );
}

#[test]
fn interactive_lookups_have_their_own_budget_per_account_too() {
    let mut keys = KeyFetchGuard::default();
    let mut look = LookupGuard::default();
    let ok = (0..100)
        .filter(|i| look.may_contact(&format!("h{i}.example"), "guest-token-1", false, T0))
        .count();
    assert_eq!(ok, lookup_new_hosts::PER_ACCOUNT_HOUR);
    for a in 0..40 {
        for i in 0..10 {
            look.may_contact(&format!("x{a}-{i}.example"), &format!("acct{a}"), false, T0);
        }
    }
    assert!(!look.may_contact("fresh.example", "acct-new", false, T0));
    assert!(look.may_contact("known.example", "acct-new", true, T0));
    assert!(look.may_contact("fresh.example", "acct-new", false, T0 + 60));
    assert_eq!(
        keys.may_fetch(
            "192.0.2.0/24",
            "https://another.good.example",
            true,
            false,
            false,
            T0
        ),
        Fetch::Ok
    );
}

#[test]
fn the_guards_forget_networks_hosts_and_accounts_that_went_quiet() {
    let mut g = KeyFetchGuard::default();
    for i in 0..40 {
        g.may_fetch(
            &format!("net{i}"),
            &format!("https://h{i}.example"),
            true,
            false,
            false,
            T0,
        );
    }
    for j in 0..10 {
        g.may_fetch(
            "net0",
            &format!("https://again{j}.example"),
            true,
            false,
            false,
            T0,
        );
    }
    assert_eq!(g.tracked(), 40 + 1 + 44);
    g.sweep(T0 + key_fetch::HELLO_REFETCH - 1);
    assert_eq!(g.tracked(), 40 + 1 + 44);
    g.sweep(T0 + 59);
    assert_eq!(g.tracked(), 40 + 1);
    assert_eq!(
        g.may_fetch("net0", "https://late.example", true, false, false, T0 + 59),
        Fetch::Busy
    );
    g.sweep(T0 + key_fetch::CAPPED_FOR);
    assert_eq!(g.tracked(), 0);
    assert_eq!(
        g.may_fetch("net0", "https://h0.example", true, false, false, T0 + 601),
        Fetch::Ok
    );

    let mut look = LookupGuard::default();
    for a in 0..30 {
        look.may_contact("h.example", &format!("acct{a}"), false, T0);
    }
    assert_eq!(look.tracked(), 30);
    look.sweep(T0 + 3599);
    assert_eq!(look.tracked(), 30);
    look.sweep(T0 + 3600);
    assert_eq!(look.tracked(), 0);
}
