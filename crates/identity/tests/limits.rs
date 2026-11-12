use rchat_identity::limits::{
    APPLICATION_GROUP_PER_MINUTE, APPLICATION_LOOKUP_SHARE, APPLICATION_PER_MINUTE, Budget,
    CLIENT_FAILS_PER_GROUP_HOUR, ClientAttempt, ClientAuth, DEVICE_PER_CLIENT,
    DEVICE_PER_CLIENT_GROUP, DEVICE_TOTAL, LiveDeviceCodes, Lookups, PER_USER_DAY,
    PER_USER_GROUP_DAY, PasswordAttempt, PasswordCounts, Take, device_code_allowed,
    password_attempt,
};

#[test]
fn bad_secrets_from_one_network_never_refuse_the_real_client() {
    let mut c = ClientAuth::new();
    for i in 0..500 {
        let want = match i < CLIENT_FAILS_PER_GROUP_HOUR {
            true => ClientAttempt::InvalidClient,
            false => ClientAttempt::SlowDown,
        };
        assert_eq!(c.attempt("pixel", "stranger", false), want);
    }
    assert_eq!(
        c.attempt("pixel", "stranger", false),
        ClientAttempt::SlowDown
    );
    assert_eq!(c.attempt("pixel", "stranger", true), ClientAttempt::Ok);
    assert_eq!(c.attempt("pixel", "service", true), ClientAttempt::Ok);
    assert_eq!(
        c.attempt("pixel", "service", false),
        ClientAttempt::InvalidClient
    );
    assert_eq!(
        c.attempt("other", "stranger", false),
        ClientAttempt::InvalidClient
    );
    assert_eq!(CLIENT_FAILS_PER_GROUP_HOUR, 20);
}

#[test]
fn one_network_spends_only_its_share_of_the_applications_budget() {
    let mut b = Budget::new();
    for _ in 0..APPLICATION_GROUP_PER_MINUTE {
        assert_eq!(b.take("pixel", "stranger", true), Take::Ok);
    }
    assert_eq!(b.take("pixel", "stranger", true), Take::Rate);
    assert_eq!(b.take("pixel", "service", true), Take::Ok);
    assert_eq!(b.take("other", "stranger", true), Take::Ok);
}

#[test]
fn the_ceiling_is_capacity_for_everyone_once_live_requests_reach_it() {
    let mut b = Budget::new();
    let groups = APPLICATION_PER_MINUTE / APPLICATION_GROUP_PER_MINUTE;
    for g in 0..groups {
        for _ in 0..APPLICATION_GROUP_PER_MINUTE {
            assert_eq!(b.take("pixel", &format!("g{g}"), true), Take::Ok);
        }
    }
    assert_eq!(b.take("pixel", "one-more", true), Take::Capacity);
    assert_eq!(b.take("pixel", "one-more", false), Take::Ok);
    assert_eq!(b.take("other", "one-more", true), Take::Ok);
    assert_eq!(
        (APPLICATION_GROUP_PER_MINUTE, APPLICATION_PER_MINUTE),
        (120, 6000)
    );
}

#[test]
fn device_codes_are_capped_per_client_and_network_first() {
    let live = |client_group, client, total| LiveDeviceCodes {
        client_group,
        client,
        total,
    };
    assert_eq!(device_code_allowed(live(10, 10, 10)), Take::Rate);
    assert_eq!(device_code_allowed(live(0, 10, 10)), Take::Ok);
    assert_eq!(device_code_allowed(live(0, 1000, 1000)), Take::Capacity);
    assert_eq!(device_code_allowed(live(0, 0, 50_000)), Take::Capacity);
    assert_eq!(device_code_allowed(live(9, 999, 49_999)), Take::Ok);
    assert_eq!(
        (DEVICE_PER_CLIENT_GROUP, DEVICE_PER_CLIENT, DEVICE_TOTAL),
        (10, 1000, 50_000)
    );
}

#[test]
fn the_per_username_cap_never_blocks_the_owners_remembered_device() {
    let counts = |user_group, user| PasswordCounts { user_group, user };
    assert_eq!(
        password_attempt(counts(0, 1000), false),
        PasswordAttempt::Locked
    );
    assert_eq!(password_attempt(counts(0, 1000), true), PasswordAttempt::Ok);
    assert_eq!(
        password_attempt(counts(200, 200), true),
        PasswordAttempt::Locked
    );
    assert_eq!(
        password_attempt(counts(199, 999), false),
        PasswordAttempt::Ok
    );
    assert_eq!((PER_USER_GROUP_DAY, PER_USER_DAY), (200, 1000));
}

#[test]
fn junk_never_spends_the_applications_ceiling() {
    let mut b = Budget::new();
    let groups = 2 * (APPLICATION_PER_MINUTE / APPLICATION_GROUP_PER_MINUTE);
    for g in 0..groups {
        for _ in 0..APPLICATION_GROUP_PER_MINUTE {
            b.take("public", &format!("g{g}"), false);
        }
    }
    assert_eq!(b.take("public", "g0", false), Take::Rate);
    assert_eq!(b.take("public", "the-real-user", true), Take::Ok);
}

#[test]
fn an_application_has_its_own_lookup_budget_inside_the_persons() {
    let mut l = Lookups::new(10);
    for _ in 0..5 {
        assert_eq!(l.take("alice", Some("x")), Take::Ok);
    }
    assert_eq!(l.take("alice", Some("x")), Take::Rate);
    assert_eq!(l.take("alice", None), Take::Ok);
    assert_eq!(l.take("alice", Some("y")), Take::Ok);
    assert_eq!(l.take("bob", Some("x")), Take::Ok);
    for _ in 0..9 {
        assert_eq!(l.take("alice", None), Take::Ok);
    }
    assert_eq!(l.take("alice", None), Take::Rate);
    assert_eq!(APPLICATION_LOOKUP_SHARE, 0.5);
    let mut odd = Lookups::new(3);
    assert_eq!(odd.take("alice", Some("x")), Take::Ok);
    assert_eq!(odd.take("alice", Some("x")), Take::Rate);
    assert_eq!(Lookups::new(0).take("alice", None), Take::Rate);
    assert_eq!(Lookups::new(u32::MAX).take("alice", Some("x")), Take::Ok);
}
