use rchat_fed::invites;
use rchat_fed::limits::{
    BLOB_MAX, HOLD_MAX, NOTICE_MAX, abuse, call, circuit, established, hello, key_fetch, keys,
    lookup_new_hosts, ranges, stamp, strikes,
};
use rchat_fed::reports;

#[test]
fn the_call_numbers_are_the_models() {
    assert_eq!(call::LIFE_MAX, 60);
    assert_eq!(call::SKEW, 30);
    assert_eq!(call::HEAD_MAX, 2048);
    assert_eq!(call::JTI_BYTES, 16);
    assert_eq!(call::JTI_KEEP, 330);
}

#[test]
fn the_work_budgets_are_the_models() {
    assert_eq!(key_fetch::PER_MINUTE, 600);
    assert_eq!(key_fetch::PER_NETWORK_MINUTE, 5);
    assert_eq!(key_fetch::CAPPED_NETWORK_MINUTE, 1);
    assert_eq!(key_fetch::CAPPED_FOR, 600);
    assert_eq!(key_fetch::PRESSURE_AT, 60);
    assert_eq!(key_fetch::HELLO_REFETCH, 30);
    assert_eq!(lookup_new_hosts::PER_MINUTE, 300);
    assert_eq!(lookup_new_hosts::PER_ACCOUNT_HOUR, 10);
    assert_eq!(stamp::PUZZLES, 16);
    assert_eq!(stamp::WORK, 2_000_000);
    assert_eq!(stamp::SEEN_FOR, 90);
}

#[test]
fn the_health_thresholds_are_the_models() {
    assert_eq!(keys::RETIRE_AFTER, 3600);
    assert_eq!(keys::PENDING_MAX, 8);
    assert_eq!(circuit::FAILS, 5);
    assert_eq!(circuit::PROBES, [60, 300, 900, 3600]);
    assert_eq!(circuit::UNREACHABLE_AFTER, 86_400);
    assert_eq!(hello::TTL, 3600);
    assert_eq!(hello::RECHECK, 21_600);
    assert_eq!(hello::RECHECK_UNSUPPORTED, 86_400);
    assert_eq!(hello::SKEW_NOTICE, 30);
    assert_eq!(hello::BACKGROUND_EVERY, 300);
    assert_eq!(strikes::WINDOW, 3600);
    assert_eq!(strikes::PAUSE_AT, 10);
    assert_eq!(strikes::WEIGHT_MALFORMED, 1);
    assert_eq!(strikes::WEIGHT_BAD_REPLY, 1);
    assert_eq!(strikes::WEIGHT_BAD_OWN_SEAL, 5);
    assert_eq!(strikes::WEIGHT_BAD_OBJECT, 5);
    assert_eq!(strikes::COOLDOWN, 3600);
    assert_eq!(strikes::COOLDOWN_MAX, 86_400);
    assert_eq!(strikes::PROBATION, 86_400);
    assert_eq!(strikes::HALT_AT, 2);
    assert_eq!(abuse::WINDOW, 3600);
    assert_eq!(abuse::MINUTES, 30);
    assert_eq!(abuse::COOLDOWN, 21_600);
    assert_eq!(abuse::COOLDOWN_MAX, 172_800);
    assert_eq!(abuse::GRACE, 10);
    assert_eq!(abuse::CALLS_PER_MINUTE, 4);
    assert_eq!(HOLD_MAX, 3600);
    assert_eq!(NOTICE_MAX, 200);
}

#[test]
fn the_warmth_numbers_are_the_amendments() {
    assert_eq!(established::WRITERS, 2);
    assert_eq!(established::AFTER_DAYS, 7);
    assert_eq!(established::DECAY_DAYS, 30);
    assert_eq!(established::COOLING_DAYS, 7);
}

#[test]
fn the_service_numbers_are_the_models() {
    assert_eq!(BLOB_MAX, 262_144);
    assert_eq!(ranges::NAME_MAX, 64);
    assert_eq!(ranges::USERNAMES_MAX, 50);
    assert_eq!(ranges::QUERY_MAX, 100);
    assert_eq!(ranges::REPORT_IDS_MAX, 20);
    assert_eq!(ranges::NOTE_MAX, 1000);
    assert_eq!(ranges::REF_BYTES, 16);
    assert_eq!(ranges::SHA256_BYTES, 32);
    assert_eq!(
        (
            invites::HOST_FREE,
            invites::DOMAIN_FREE,
            invites::NETWORK_FREE
        ),
        (5, 20, 20)
    );
    assert_eq!(
        (
            invites::HOT_HOST_FREE,
            invites::HOT_DOMAIN_FREE,
            invites::HOT_NETWORK_FREE
        ),
        (1, 4, 4)
    );
    assert_eq!((invites::CAP, invites::HOT_CALLERS), (3600, 10));
    assert_eq!(
        (reports::SUBJECT_DAY, reports::PER_HOST_UNCHECKED),
        (100, 5)
    );
    assert_eq!(
        (reports::SUBJECT_DOMAIN_DAY, reports::SUBJECT_HOST_DAY),
        (50, 20)
    );
}
