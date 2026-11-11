use prost::Message;
use rchat_fed::invites::{
    CAP, Caller, DOMAIN_FREE, HOST_FREE, HOT_CALLERS, WrongPasswords, preview_body,
};
use rchat_fed::pb::PreviewRequest;

use crate::support::T0;

fn on(host: &str, cold: bool, network: &str) -> Caller {
    Caller {
        host: host.to_string(),
        cold,
        network: network.to_string(),
    }
}

fn c(host: &str) -> Caller {
    on(host, false, &format!("net-{host}"))
}

fn wrong(w: &mut WrongPasswords, caller: &Caller, server: &str, t: i64) {
    if w.attempt(caller, server, t) {
        w.result(caller, server, false, t);
    }
}

#[test]
fn automatic_previews_never_carry_the_links_password() {
    let read = |bytes: Vec<u8>| PreviewRequest::decode(bytes.as_slice()).unwrap();
    assert_eq!(
        read(preview_body("club", Some("hunter2"), false)).password,
        ""
    );
    assert_eq!(
        read(preview_body("club", Some("hunter2"), true)).password,
        "hunter2"
    );
    assert_eq!(read(preview_body("club", None, true)).password, "");
    assert_eq!(read(preview_body("club", None, true)).server, "club");
}

#[test]
fn wrong_passwords_lock_out_only_that_calling_host_for_that_server() {
    let mut w = WrongPasswords::default();
    for _ in 0..HOST_FREE {
        wrong(&mut w, &c("a.example"), "club", T0);
    }
    assert!(!w.attempt(&c("a.example"), "club", T0 + 1));
    assert!(w.attempt(&c("a.example"), "other", T0 + 1));
    assert!(w.attempt(&c("c.example"), "club", T0 + 1));
}

#[test]
fn the_wait_doubles_up_to_an_hour_and_a_quiet_hour_starts_over() {
    let mut w = WrongPasswords::default();
    for _ in 0..HOST_FREE {
        wrong(&mut w, &c("a.example"), "club", T0);
    }
    assert!(!w.attempt(&c("a.example"), "club", T0 + 1));
    assert!(w.attempt(&c("a.example"), "club", T0 + 2));
    w.result(&c("a.example"), "club", false, T0 + 2);
    assert!(!w.attempt(&c("a.example"), "club", T0 + 5));
    assert!(w.attempt(&c("a.example"), "club", T0 + 2 + CAP));
}

#[test]
fn right_passwords_never_count() {
    let mut w = WrongPasswords::default();
    for i in 0..50 {
        assert!(w.attempt(&c("a.example"), "club", T0 + i));
        w.result(&c("a.example"), "club", true, T0 + i);
    }
}

#[test]
fn ten_hosts_with_one_wrong_guess_each_never_lock_honest_instances_out() {
    let mut w = WrongPasswords::default();
    for i in 0..HOT_CALLERS {
        wrong(&mut w, &c(&format!("h{i}.spam{i}.net")), "club", T0);
    }
    for honest in ["a.example", "b.org", "c.net", "d.com", "e.co.uk"] {
        assert!(w.attempt(&c(honest), "club", T0 + 60), "{honest}");
    }
}

#[test]
fn hot_mode_tightens_each_callers_own_allowance_one_wrong_guess_then_an_hour() {
    let mut w = WrongPasswords::default();
    for i in 0..HOT_CALLERS {
        wrong(&mut w, &c(&format!("h{i}.spam{i}.net")), "club", T0);
    }
    wrong(&mut w, &c("a.example"), "club", T0 + 10);
    assert!(!w.attempt(&c("a.example"), "club", T0 + 20));
    assert!(!w.attempt(&c("a.example"), "club", T0 + CAP - 1));
    assert!(w.attempt(&c("b.org"), "club", T0 + 20));
}

#[test]
fn minted_hosts_under_one_domain_share_the_domains_allowance() {
    let mut w = WrongPasswords::default();
    for i in 0..20 {
        wrong(&mut w, &c(&format!("x{i}.spam.example")), "club", T0);
    }
    assert!(!w.attempt(&c("fresh.spam.example"), "club", T0 + 1));
    assert!(w.attempt(&c("a.example"), "club", T0 + 1));
}

#[test]
fn two_hundred_minted_cold_callers_on_one_free_suffix_and_network_get_one_allowance() {
    let mut w = WrongPasswords::default();
    let mut guesses = 0;
    for i in 0..200 {
        let caller = on(&format!("x{i}.duckdns.org"), true, "203.0.113.0/24");
        for j in 0..30 {
            if w.attempt(&caller, "club", T0 + 120 + j) {
                guesses += 1;
                w.result(&caller, "club", false, T0 + 120 + j);
            }
        }
    }
    assert!(guesses > 0 && guesses <= DOMAIN_FREE, "{guesses}");
    assert!(w.attempt(&c("chat.honest.example"), "club", T0 + 200));
}

#[test]
fn the_same_minted_names_on_many_networks_are_still_one_cold_domain() {
    let mut w = WrongPasswords::default();
    let mut guesses = 0;
    for i in 0..200 {
        let caller = on(
            &format!("x{i}.duckdns.org"),
            true,
            &format!("198.51.{i}.0/24"),
        );
        if w.attempt(&caller, "club", T0 + i) {
            guesses += 1;
            w.result(&caller, "club", false, T0 + i);
        }
    }
    assert!(guesses > 0 && guesses <= DOMAIN_FREE, "{guesses}");
}

#[test]
fn established_hosts_on_a_private_suffix_keep_their_own_allowance() {
    let mut w = WrongPasswords::default();
    for i in 0..30 {
        let caller = on(&format!("x{i}.evil.duckdns.org"), false, "n1");
        wrong(&mut w, &caller, "club", T0);
    }
    assert!(w.attempt(&on("pc.bob.duckdns.org", false, "n2"), "club", T0 + 1));
    assert!(!w.attempt(&on("x99.evil.duckdns.org", false, "n3"), "club", T0 + 1));
}

#[test]
fn a_try_refused_for_the_domain_costs_the_calling_host_nothing_of_its_own_allowance() {
    let mut w = WrongPasswords::default();
    for host in 0..4 {
        for _ in 0..HOST_FREE {
            wrong(&mut w, &c(&format!("x{host}.spam.example")), "club", T0);
        }
    }
    let fresh = c("fresh.spam.example");
    for _ in 0..10 {
        assert!(!w.attempt(&fresh, "club", T0 + 1));
    }
    assert!(w.attempt(&fresh, "club", T0 + 2));
}

#[test]
fn the_caller_side_the_same_rule_per_account_before_any_call() {
    let mut mine = WrongPasswords::default();
    for _ in 0..HOST_FREE {
        wrong(&mut mine, &c("acct:mallory"), "club", T0);
    }
    assert!(!mine.attempt(&c("acct:mallory"), "club", T0 + 1));
    assert!(mine.attempt(&c("acct:alice"), "club", T0 + 1));
}

#[test]
fn the_wrong_password_tables_forget_what_a_quiet_hour_reset_anyway() {
    let mut w = WrongPasswords::default();
    for i in 0..30 {
        wrong(&mut w, &c(&format!("h{i}.spam{i}.net")), "club", T0);
    }
    assert!(w.tracked() >= 90);
    w.sweep(T0 + CAP - 1);
    assert!(w.tracked() >= 90);
    assert!(!w.attempt(&c("h0.spam0.net"), "club", T0 + CAP - 1));
    w.sweep(T0 + CAP);
    assert_eq!(w.tracked(), 0);
    assert!(w.attempt(&c("h0.spam0.net"), "club", T0 + CAP));
}

#[test]
fn a_servers_list_of_failing_hosts_holds_only_the_ten_latest() {
    let mut w = WrongPasswords::default();
    for i in 0..1000 {
        wrong(&mut w, &c(&format!("h{i}.spam{i}.net")), "club", T0 + i);
    }
    assert_eq!(w.tracked(), 3 * 1000 + HOT_CALLERS);
    wrong(&mut w, &c("a.example"), "club", T0 + 1000);
    assert!(!w.attempt(&c("a.example"), "club", T0 + 1010));
    assert_eq!(w.tracked(), 3 * 1001 + HOT_CALLERS);
    wrong(&mut w, &c("b.org"), "club", T0 + CAP + 990);
    assert!(!w.attempt(&c("b.org"), "club", T0 + CAP + 991));
    wrong(&mut w, &c("c.net"), "club", T0 + 2 * CAP + 992);
    assert!(w.attempt(&c("c.net"), "club", T0 + 2 * CAP + 993));
}
