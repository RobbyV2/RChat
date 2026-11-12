use std::collections::BTreeSet;

use rchat_identity::events::{Declared, EVENTS, declared, event_allowed};
use rchat_identity::scopes::{all_scopes, scope_def};

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn everything() -> BTreeSet<String> {
    set(&all_scopes())
}

const SECURITY: [&str; 6] = [
    "security_notice",
    "sessions_changed",
    "two_factor_changed",
    "protections_changed",
    "grants_changed",
    "tokens_revoked",
];

#[test]
fn security_events_are_never_sent_to_an_application() {
    for e in SECURITY {
        assert_eq!(declared(e), Some(Declared::Never));
        assert!(!event_allowed(e, &everything(), None, None, true));
        assert!(!event_allowed(e, &everything(), None, None, false));
    }
    for e in ["site_admin_changed", "user_registered", "server_created"] {
        assert_eq!(declared(e), Some(Declared::Never));
    }
}

#[test]
fn an_undeclared_event_is_never_sent_others_need_realtime_their_permission_and_the_picks() {
    let lobby = set(&["lobby"]);
    let read = set(&["messages.read", "realtime"]);
    assert_eq!(declared("brand_new_event"), None);
    assert!(!event_allowed(
        "brand_new_event",
        &everything(),
        None,
        None,
        false
    ));
    assert!(!event_allowed(
        "message_created",
        &set(&["messages.read"]),
        None,
        Some("lobby"),
        false
    ));
    assert!(!event_allowed(
        "message_created",
        &set(&["realtime"]),
        None,
        Some("lobby"),
        false
    ));
    assert!(event_allowed(
        "message_created",
        &read,
        Some(&lobby),
        Some("lobby"),
        false
    ));
    assert!(!event_allowed(
        "message_created",
        &read,
        Some(&lobby),
        Some("eng"),
        false
    ));
    assert!(event_allowed(
        "message_created",
        &read,
        None,
        Some("eng"),
        false
    ));
    assert!(event_allowed("ping", &read, Some(&lobby), None, false));
    assert!(event_allowed(
        "settings_changed",
        &set(&["realtime"]),
        None,
        None,
        false
    ));
}

#[test]
fn encryption_events_go_only_to_the_applications_own_device_commit_requests_never() {
    let read = set(&["encrypted.read"]);
    assert!(event_allowed("e2ee_welcome", &read, None, None, true));
    assert!(!event_allowed(
        "e2ee_welcome",
        &set(&["encrypted.read", "realtime"]),
        None,
        None,
        false
    ));
    assert!(!event_allowed(
        "e2ee_welcome",
        &set(&["realtime"]),
        None,
        None,
        true
    ));
    assert!(!event_allowed(
        "e2ee_commit_request",
        &everything(),
        None,
        None,
        true
    ));
    for e in ["e2ee_handshake", "e2ee_welcome", "e2ee_keypackages_low"] {
        assert_eq!(declared(e), Some(Declared::Device));
    }
}

#[test]
fn every_event_declares_a_known_permission_device_or_never() {
    assert_eq!(EVENTS.len(), 30);
    let mut names: Vec<&str> = EVENTS.iter().map(|(name, _)| *name).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), 30);
    for (name, need) in EVENTS {
        assert_eq!(declared(name), Some(need));
        match need {
            Declared::Scope(scope) => assert!(scope_def(scope).is_some(), "{name}"),
            Declared::Device | Declared::Never => {}
        }
    }
    let by = |scope: &'static str| -> Vec<&str> {
        EVENTS
            .iter()
            .filter(|(_, need)| *need == Declared::Scope(scope))
            .map(|(name, _)| *name)
            .collect()
    };
    assert_eq!(
        by("messages.read"),
        [
            "message_created",
            "message_updated",
            "message_deleted",
            "reaction_added",
            "ping",
            "inbox_item"
        ]
    );
    assert_eq!(
        by("servers.read"),
        [
            "typing",
            "presence",
            "member_joined",
            "server_updated",
            "role_updated"
        ]
    );
    assert_eq!(by("dms.read"), ["dm_message_created"]);
    assert_eq!(by("friends"), ["friend_request"]);
    assert_eq!(by("calls"), ["voice_state", "call_offer"]);
    assert_eq!(by("account"), ["me_updated"]);
    assert_eq!(by("realtime"), ["settings_changed"]);
}
