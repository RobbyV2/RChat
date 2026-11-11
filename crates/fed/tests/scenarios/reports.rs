use std::collections::BTreeMap;

use prost::Message;
use rchat_fed::limits::ranges::{NOTE_MAX as MAX_NOTE, REPORT_IDS_MAX as MAX_IDS};
use rchat_fed::pb::{ForwardRequest, Ranged, ReportKind, ReportReason};
use rchat_fed::registry::{List, registrable};
use rchat_fed::reports::{
    ForwardChoice, HeldMessage, HoldEntry, ItemState, PER_HOST_UNCHECKED, ReportBudget,
    ReportIntake, SUBJECT_DAY, SUBJECT_DOMAIN_DAY, SUBJECT_HOST_DAY, Taken, check_items,
    forward_body,
};

use crate::support::T0;

const BOB: &str = "bob@b.example";
const DAY: i64 = 86_400;

fn held() -> Vec<HeldMessage> {
    [(1, "m1", BOB), (2, "m2", "alice@a.example"), (3, "m3", BOB)]
        .into_iter()
        .map(|(order, id, author)| HeldMessage {
            id: id.to_string(),
            author: author.to_string(),
            order,
        })
        .collect()
}

fn base() -> ForwardChoice {
    ForwardChoice {
        subject: BOB.to_string(),
        reason: ReportReason::Harassment,
        reported: vec!["m3".to_string()],
        with_earlier: false,
        note: Some("I am alice and he keeps writing".to_string()),
        include_note: false,
        reference: vec![5; 16],
    }
}

fn read(choice: &ForwardChoice) -> ForwardRequest {
    ForwardRequest::decode(forward_body(choice, &held()).as_slice()).unwrap()
}

fn hold() -> BTreeMap<String, HoldEntry> {
    [("m1", "a.example"), ("m9", "c.example")]
        .into_iter()
        .map(|(id, host)| {
            let entry = HoldEntry {
                author: BOB.to_string(),
                delivered_to: vec![host.to_string()],
                until: T0 + 30 * DAY,
            };
            (id.to_string(), entry)
        })
        .collect()
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| id.to_string()).collect()
}

#[test]
fn the_evidence_is_references_so_the_reporter_is_nowhere_in_the_bytes() {
    let bytes = forward_body(&base(), &held());
    assert!(!bytes.windows(5).any(|w| w == b"alice"));
    let request = ForwardRequest::decode(bytes.as_slice()).unwrap();
    assert_eq!(request.message_ids, ["m3"]);
    assert_eq!(request.kind, ReportKind::Letter as i32);
    assert_eq!(request.subject, BOB);
    assert_eq!(request.reason, ReportReason::Harassment as i32);
    assert_eq!(request.r#ref, [5; 16]);
}

#[test]
fn the_note_goes_only_when_chosen() {
    let with_note = ForwardChoice {
        include_note: true,
        ..base()
    };
    assert!(read(&with_note).note.contains("alice"));
    assert_eq!(read(&base()).note, "");
    let long = ForwardChoice {
        include_note: true,
        note: Some("x".repeat(MAX_NOTE + 50)),
        ..base()
    };
    assert_eq!(read(&long).note.chars().count(), MAX_NOTE);
    let unsaid = ForwardChoice {
        include_note: true,
        note: None,
        ..base()
    };
    assert_eq!(read(&unsaid).note, "");
}

#[test]
fn earlier_messages_only_the_subjects_own_never_the_reporters() {
    let earlier = ForwardChoice {
        with_earlier: true,
        ..base()
    };
    let mut got = read(&earlier).message_ids;
    got.sort();
    assert_eq!(got, ["m1", "m3"]);
}

#[test]
fn a_reported_id_the_subject_didnt_write_is_dropped() {
    let both = ForwardChoice {
        reported: ids(&["m2", "m3"]),
        ..base()
    };
    assert_eq!(read(&both).message_ids, ["m3"]);
    let none = ForwardChoice {
        reported: ids(&["m2"]),
        with_earlier: true,
        ..base()
    };
    assert!(read(&none).message_ids.is_empty());
}

#[test]
fn at_most_twenty_message_ids_travel() {
    let many: Vec<HeldMessage> = (0..30)
        .map(|i| HeldMessage {
            id: format!("m{i}"),
            author: BOB.to_string(),
            order: i,
        })
        .collect();
    let choice = ForwardChoice {
        reported: many.iter().map(|m| m.id.clone()).collect(),
        ..base()
    };
    let request = ForwardRequest::decode(forward_body(&choice, &many).as_slice()).unwrap();
    assert_eq!(request.message_ids.len(), MAX_IDS);
    assert!(request.in_range());
}

#[test]
fn a_forward_outside_its_documented_ranges_is_malformed() {
    let good = read(&base());
    assert!(good.in_range());
    let too_many = ForwardRequest {
        message_ids: (0..=MAX_IDS).map(|i| format!("m{i}")).collect(),
        ..good.clone()
    };
    assert!(!too_many.in_range());
    let annotations = ForwardRequest {
        annotation_ids: (0..=MAX_IDS).map(|i| format!("a{i}")).collect(),
        ..good.clone()
    };
    assert!(!annotations.in_range());
    let events = ForwardRequest {
        p2p_events: vec![vec![1]; MAX_IDS + 1],
        ..good.clone()
    };
    assert!(!events.in_range());
    let note = ForwardRequest {
        note: "x".repeat(MAX_NOTE + 1),
        ..good.clone()
    };
    assert!(!note.in_range());
    let reference = ForwardRequest {
        r#ref: vec![5; 15],
        ..good.clone()
    };
    assert!(!reference.in_range());
    let unknown_kind = ForwardRequest { kind: 99, ..good };
    assert!(unknown_kind.in_range());
}

#[test]
fn the_moderation_hold_keeps_what_bob_delivered_even_after_he_purges_it() {
    assert_eq!(
        check_items(&ids(&["m1"]), BOB, "a.example", &hold(), T0 + DAY),
        [ItemState::Checked]
    );
    assert_eq!(
        check_items(&ids(&["m1"]), BOB, "a.example", &hold(), T0 + 30 * DAY + 1),
        [ItemState::NotFound]
    );
}

#[test]
fn only_messages_delivered_to_the_calling_host_are_checked() {
    assert_eq!(
        check_items(&ids(&["m9", "mX"]), BOB, "a.example", &hold(), T0),
        [ItemState::NotDeliveredToYou, ItemState::NotFound]
    );
    assert_eq!(
        check_items(&ids(&["m1"]), "carol@b.example", "a.example", &hold(), T0),
        [ItemState::NotFound]
    );
}

fn take(
    intake: &mut ReportIntake,
    host: &str,
    state: ItemState,
    t: i64,
    checked: &[&str],
) -> Taken {
    let domain = registrable(host, List::Full);
    intake.take(BOB, host, domain, &[state], T0 + t, &ids(checked))
}

#[test]
fn junk_reports_from_minted_hosts_never_fill_the_subjects_cap() {
    let mut intake = ReportIntake::default();
    for i in 0..1000 {
        let host = format!("x{i}.spam.example");
        take(&mut intake, &host, ItemState::NotFound, i, &[]);
    }
    let mut stored = 0;
    for i in 0..SUBJECT_DAY as i64 {
        let host = format!("chat.honest{}.example", i % 5);
        let id = format!("m{i}");
        if take(&mut intake, &host, ItemState::Checked, 2000 + i, &[&id]) == Taken::Stored {
            stored += 1;
        }
    }
    assert_eq!(stored, SUBJECT_DAY);
    assert_eq!(
        take(
            &mut intake,
            "chat.sixth.example",
            ItemState::Checked,
            3000,
            &["one-more"]
        ),
        Taken::Dropped
    );
    assert_eq!(
        take(
            &mut intake,
            "chat.sixth.example",
            ItemState::Checked,
            2000 + DAY,
            &["next-day"]
        ),
        Taken::Stored
    );
}

#[test]
fn one_calling_host_can_never_fill_a_persons_cap_by_varying_the_ids() {
    let mut intake = ReportIntake::default();
    let got: Vec<Taken> = (0..40)
        .map(|i| {
            let id = format!("m{i}");
            take(
                &mut intake,
                "chat.evil.example",
                ItemState::Checked,
                i,
                &["m0", &id],
            )
        })
        .collect();
    assert_eq!(
        got.iter().filter(|g| **g == Taken::Stored).count(),
        SUBJECT_HOST_DAY
    );
    assert!(got[SUBJECT_HOST_DAY..].iter().all(|g| *g == Taken::Dropped));
    assert_eq!(
        take(
            &mut intake,
            "chat.honest.example",
            ItemState::Checked,
            50,
            &["m0"]
        ),
        Taken::Stored
    );
    assert_eq!(
        take(
            &mut intake,
            "chat.evil.example",
            ItemState::Checked,
            DAY + 1,
            &["m0", "m99"]
        ),
        Taken::Stored
    );
}

#[test]
fn minted_hosts_under_one_domain_share_the_domains_part_of_a_persons_cap() {
    let mut intake = ReportIntake::default();
    let mut stored = 0;
    for host in 0..10 {
        for i in 0..SUBJECT_HOST_DAY {
            let name = format!("x{host}.spam.example");
            let id = format!("m{host}-{i}");
            if take(&mut intake, &name, ItemState::Checked, 10, &[&id]) == Taken::Stored {
                stored += 1;
            }
        }
    }
    assert_eq!(stored, SUBJECT_DOMAIN_DAY);
    assert_eq!(
        take(
            &mut intake,
            "chat.honest.example",
            ItemState::Checked,
            20,
            &["m0-0"]
        ),
        Taken::Stored
    );
}

#[test]
fn a_report_refused_for_the_domain_costs_the_host_nothing_of_its_own_part() {
    let mut intake = ReportIntake::default();
    for host in 0..5 {
        for i in 0..10 {
            let name = format!("x{host}.spam.example");
            let id = format!("m{host}-{i}");
            take(&mut intake, &name, ItemState::Checked, 10, &[&id]);
        }
    }
    for i in 0..30 {
        let id = format!("late{i}");
        assert_eq!(
            take(
                &mut intake,
                "fresh.spam.example",
                ItemState::Checked,
                20,
                &[&id]
            ),
            Taken::Dropped
        );
    }
    assert_eq!(
        take(
            &mut intake,
            "fresh.spam.example",
            ItemState::Checked,
            10 + DAY,
            &["tomorrow"]
        ),
        Taken::Stored
    );
}

#[test]
fn reports_with_nothing_checked_are_capped_per_calling_host() {
    let mut intake = ReportIntake::default();
    let got: Vec<Taken> = (0..8)
        .map(|i| take(&mut intake, "x.spam.example", ItemState::NotFound, i, &[]))
        .collect();
    assert_eq!(
        got.iter().filter(|g| **g == Taken::Stored).count(),
        PER_HOST_UNCHECKED
    );
    assert_eq!(got[7], Taken::Dropped);
}

#[test]
fn a_host_repeating_a_checked_report_about_the_same_ids_counts_once() {
    let mut intake = ReportIntake::default();
    let mut out = Vec::new();
    for h in 0..5 {
        for r in 0..100 {
            let host = format!("h{h}.example");
            out.push(take(&mut intake, &host, ItemState::Checked, r, &["m1"]));
        }
    }
    assert_eq!(out.iter().filter(|o| **o == Taken::Stored).count(), 5);
    assert_eq!(out.iter().filter(|o| **o == Taken::Duplicate).count(), 495);
    assert_eq!(
        take(&mut intake, "h0.example", ItemState::Checked, 200, &["m2"]),
        Taken::Stored
    );
    assert_eq!(
        take(
            &mut intake,
            "h0.example",
            ItemState::Checked,
            200,
            &["m2", "m1"]
        ),
        Taken::Stored
    );
    assert_eq!(
        take(
            &mut intake,
            "h0.example",
            ItemState::Checked,
            201,
            &["m1", "m2"]
        ),
        Taken::Duplicate
    );
}

#[test]
fn minted_hosts_under_one_domain_store_at_most_the_domains_daily_budget() {
    let mut intake = ReportIntake::default();
    let mut stored = 0;
    for host in 0..100 {
        for i in 0..PER_HOST_UNCHECKED as i64 {
            let name = format!("x{host}.spam.example");
            if take(&mut intake, &name, ItemState::NotFound, i, &[]) == Taken::Stored {
                stored += 1;
            }
        }
    }
    assert_eq!(stored, ReportBudget::default().per_domain_day);
    assert_eq!(
        ReportBudget::default(),
        ReportBudget {
            per_host_day: 50,
            per_domain_day: 200
        }
    );
    assert_eq!(
        take(
            &mut intake,
            "chat.honest.example",
            ItemState::NotFound,
            10,
            &[]
        ),
        Taken::Stored
    );
    assert_eq!(
        take(
            &mut intake,
            "x0.spam.example",
            ItemState::Checked,
            10,
            &["m1"]
        ),
        Taken::Dropped
    );
}

#[test]
fn a_host_stores_at_most_its_daily_budget_of_reports_checked_or_not() {
    let budget = ReportBudget {
        per_host_day: 3,
        per_domain_day: 200,
    };
    let mut intake = ReportIntake::new(budget);
    let got = [
        take(&mut intake, "a.example", ItemState::Checked, 0, &["m1"]),
        take(&mut intake, "a.example", ItemState::NotFound, 1, &[]),
        take(&mut intake, "a.example", ItemState::Checked, 2, &["m2"]),
        take(&mut intake, "a.example", ItemState::Checked, 3, &["m3"]),
        take(&mut intake, "a.example", ItemState::NotFound, 4, &[]),
    ];
    assert_eq!(
        got,
        [
            Taken::Stored,
            Taken::Stored,
            Taken::Stored,
            Taken::Dropped,
            Taken::Dropped
        ]
    );
    assert_eq!(
        take(&mut intake, "b.example", ItemState::Checked, 5, &["m3"]),
        Taken::Stored
    );
    let off = ReportBudget {
        per_host_day: 0,
        per_domain_day: 200,
    };
    assert_eq!(
        take(
            &mut ReportIntake::new(off),
            "a.example",
            ItemState::Checked,
            0,
            &["m1"]
        ),
        Taken::Dropped
    );
}

#[test]
fn a_report_dropped_for_a_full_cap_is_taken_when_it_comes_again_with_room() {
    let mut intake = ReportIntake::default();
    for i in 0..SUBJECT_DAY as i64 {
        let host = format!("chat.honest{}.example", i % 5);
        take(
            &mut intake,
            &host,
            ItemState::Checked,
            i,
            &[&format!("m{i}")],
        );
    }
    assert_eq!(
        take(
            &mut intake,
            "chat.sixth.example",
            ItemState::Checked,
            500,
            &["late"]
        ),
        Taken::Dropped
    );
    assert_eq!(
        take(
            &mut intake,
            "chat.sixth.example",
            ItemState::Checked,
            DAY + 1,
            &["late"]
        ),
        Taken::Stored
    );
    assert_eq!(
        take(
            &mut intake,
            "chat.sixth.example",
            ItemState::Checked,
            DAY + 2,
            &["late"]
        ),
        Taken::Duplicate
    );
}

#[test]
fn the_intake_forgets_what_is_older_than_a_day() {
    let mut intake = ReportIntake::default();
    for i in 0..50 {
        let host = format!("x{i}.spam{i}.example");
        take(&mut intake, &host, ItemState::NotFound, i, &[]);
        take(
            &mut intake,
            &host,
            ItemState::Checked,
            i,
            &[&format!("m{i}")],
        );
    }
    assert!(intake.tracked() > 300);
    intake.sweep(T0 + DAY - 1);
    assert!(intake.tracked() > 300);
    intake.sweep(T0 + DAY + 50);
    assert_eq!(intake.tracked(), 0);
    assert_eq!(
        take(
            &mut intake,
            "x0.spam0.example",
            ItemState::Checked,
            DAY + 60,
            &["m0"]
        ),
        Taken::Stored
    );
}

#[test]
fn a_stored_report_repeated_a_day_later_counts_again() {
    let mut intake = ReportIntake::default();
    let again = |intake: &mut ReportIntake, t: i64| {
        take(intake, "a.example", ItemState::Checked, t, &["m1"])
    };
    assert_eq!(again(&mut intake, 0), Taken::Stored);
    assert_eq!(again(&mut intake, DAY - 1), Taken::Duplicate);
    assert_eq!(again(&mut intake, DAY), Taken::Stored);
    assert_eq!(again(&mut intake, DAY + 1), Taken::Duplicate);
}

#[test]
fn a_long_letter_gives_the_reported_message_first_then_the_earliest_of_the_subjects() {
    let path: Vec<HeldMessage> = (0..2000)
        .map(|i| HeldMessage {
            id: format!("m{i}"),
            author: match i % 2 {
                0 => BOB.to_string(),
                _ => "alice@a.example".to_string(),
            },
            order: i,
        })
        .collect();
    let choice = ForwardChoice {
        reported: ids(&["m1500", "m1501", "m1500"]),
        with_earlier: true,
        ..base()
    };
    let request = ForwardRequest::decode(forward_body(&choice, &path).as_slice()).unwrap();
    let mut expected = vec!["m1500".to_string()];
    expected.extend((0..19).map(|i| format!("m{}", 2 * i)));
    assert_eq!(request.message_ids, expected);
    assert!(request.in_range());
}
