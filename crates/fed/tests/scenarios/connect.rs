use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use prost::Message;
use rchat_fed::call::CallError;
use rchat_fed::connect::{Code, ConnectError, REFUSAL_TYPE, read_answer};
use rchat_fed::outcomes::{self, Answer};
use rchat_fed::pb::{FeatureLevel, Refusal, RefusalReason};
use serde_json::{Value, json};

use crate::support::T0;

const CODES: [(Code, &str, u16); 9] = [
    (Code::InvalidArgument, "invalid_argument", 400),
    (Code::NotFound, "not_found", 404),
    (Code::PermissionDenied, "permission_denied", 403),
    (Code::ResourceExhausted, "resource_exhausted", 429),
    (Code::FailedPrecondition, "failed_precondition", 400),
    (Code::Unimplemented, "unimplemented", 501),
    (Code::Internal, "internal", 500),
    (Code::Unavailable, "unavailable", 503),
    (Code::Unauthenticated, "unauthenticated", 401),
];

fn refusal(reason: RefusalReason) -> Refusal {
    Refusal {
        reason: reason as i32,
        ..Refusal::default()
    }
}

fn answer(code: outcomes::Code) -> Answer {
    Answer {
        code,
        refusal: None,
        until: None,
        retry_after: None,
        now: Some(T0),
        their_now: None,
    }
}

#[test]
fn codes_have_connects_names_and_http_statuses() {
    for (code, name, http) in CODES {
        assert_eq!(code.name(), name);
        assert_eq!(code.http(), http);
        assert_eq!(Code::from_name(name), Some(code));
    }
    assert_eq!(Code::from_name("deadline_exceeded"), None);
}

#[test]
fn what_isnt_addressed_to_the_protocol_gets_the_plain_not_found_body() {
    for error in [CallError::Header, CallError::Iss, CallError::Aud] {
        let e = ConnectError::for_call(error, 0);
        assert_eq!(e.http(), 404);
        assert_eq!(e.to_json(), r#"{"code":"not_found","message":"Not found"}"#);
    }
}

#[test]
fn calls_not_accepted_answer_with_a_code_and_nothing_else() {
    for (error, json, http) in [
        (CallError::Forged, r#"{"code":"unauthenticated"}"#, 401),
        (CallError::Replay, r#"{"code":"unauthenticated"}"#, 401),
        (CallError::Unimplemented, r#"{"code":"unimplemented"}"#, 501),
        (CallError::Busy, r#"{"code":"unavailable"}"#, 503),
        (CallError::Keys, r#"{"code":"unavailable"}"#, 503),
    ] {
        let e = ConnectError::for_call(error, 2_000_000);
        assert_eq!((e.to_json().as_str(), e.http()), (json, http));
    }
}

#[test]
fn a_stamp_or_a_hello_is_asked_for_with_a_refusal() {
    let stamp = ConnectError::for_call(CallError::StampNeeded, 2_000_000);
    assert_eq!(stamp.http(), 503);
    let asked = stamp.refusal.clone().unwrap();
    assert_eq!(asked.reason, RefusalReason::StampNeeded as i32);
    assert_eq!(asked.stamp_work, 2_000_000);
    let hello = ConnectError::for_call(CallError::HelloNeeded, 0);
    assert_eq!(hello.http(), 400);
    assert_eq!(
        hello.refusal.unwrap().reason,
        RefusalReason::HelloNeeded as i32
    );
}

#[test]
fn each_refusal_reason_has_its_code() {
    for (reason, code) in [
        (RefusalReason::Refused, Code::PermissionDenied),
        (RefusalReason::Paused, Code::Unavailable),
        (RefusalReason::Version, Code::FailedPrecondition),
        (RefusalReason::Identity, Code::PermissionDenied),
        (RefusalReason::HelloNeeded, Code::FailedPrecondition),
        (RefusalReason::Busy, Code::Unavailable),
        (RefusalReason::StampNeeded, Code::Unavailable),
    ] {
        let e = ConnectError::refused(refusal(reason)).unwrap();
        assert_eq!(e.code, code, "{reason:?}");
        assert_eq!(e.message, "");
    }
    assert_eq!(
        ConnectError::refused(refusal(RefusalReason::Unspecified)),
        None
    );
    assert_eq!(
        ConnectError::refused(Refusal {
            reason: 99,
            ..Refusal::default()
        }),
        None
    );
}

#[test]
fn an_error_with_a_refusal_detail_round_trips_through_its_json() {
    let paused = Refusal {
        reason: RefusalReason::Paused as i32,
        until: T0 + 3600,
        need: vec![FeatureLevel {
            name: "letters".to_string(),
            level: 3,
            min: 2,
        }],
        notice: "Calls from a.example are paused until 01/15 09:00 UTC.".to_string(),
        stamp_work: 0,
    };
    let e = ConnectError::refused(paused.clone()).unwrap();
    let json = e.to_json();
    assert!(json.is_ascii());
    let value: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["code"], "unavailable");
    assert_eq!(value["details"][0]["type"], REFUSAL_TYPE);
    assert_eq!(REFUSAL_TYPE, "rchat.fed.v1.Refusal");
    let detail = value["details"][0]["value"].as_str().unwrap();
    assert!(!detail.ends_with('='));
    assert_eq!(
        STANDARD_NO_PAD.decode(detail).unwrap(),
        paused.encode_to_vec()
    );
    assert_eq!(value.as_object().unwrap().len(), 2);
    assert_eq!(ConnectError::from_json(json.as_bytes()), Some(e));
}

#[test]
fn a_reader_takes_padded_details_and_ignores_what_it_doesnt_know() {
    let busy = Refusal {
        reason: RefusalReason::Busy as i32,
        until: T0 + 30,
        ..Refusal::default()
    };
    let body = json!({
        "code": "unavailable",
        "message": "busy",
        "future": true,
        "details": [
            {"type": "google.rpc.RetryInfo", "value": "CgIIPA"},
            {"type": REFUSAL_TYPE, "value": STANDARD.encode(busy.encode_to_vec()), "debug": {"reason": "BUSY"}},
        ],
    });
    let e = ConnectError::from_json(body.to_string().as_bytes()).unwrap();
    assert_eq!(e.code, Code::Unavailable);
    assert_eq!(e.message, "busy");
    assert_eq!(e.refusal, Some(busy));
}

#[test]
fn a_body_that_is_no_connect_error_reads_as_none() {
    for body in [
        "",
        "not json",
        "[]",
        r#"{"message":"no code"}"#,
        r#"{"code":"deadline_exceeded"}"#,
        r#"{"code":7}"#,
    ] {
        assert_eq!(ConnectError::from_json(body.as_bytes()), None, "{body}");
    }
    let bad_detail =
        json!({"code": "unavailable", "details": [{"type": REFUSAL_TYPE, "value": "!!"}]});
    let e = ConnectError::from_json(bad_detail.to_string().as_bytes()).unwrap();
    assert_eq!(e.refusal, None);
    let huge = format!(
        r#"{{"code":"unavailable","message":"{}"}}"#,
        "x".repeat(70_000)
    );
    assert_eq!(ConnectError::from_json(huge.as_bytes()), None);
}

#[test]
fn every_answer_of_the_table_is_read_from_its_status_and_body() {
    let read = |status: u16, body: &str, retry_after: Option<i64>| {
        read_answer(status, body.as_bytes(), retry_after, T0, Some(T0 + 2))
    };
    let dated = |code: outcomes::Code| Answer {
        their_now: Some(T0 + 2),
        ..answer(code)
    };
    assert_eq!(read(200, "", None), dated(outcomes::Code::Ok));
    assert_eq!(read(502, "<html>", None), dated(outcomes::Code::Internal));
    assert_eq!(read(500, "", None), dated(outcomes::Code::Internal));
    assert_eq!(
        read(404, r#"{"code":"not_found","message":"Not found"}"#, None),
        dated(outcomes::Code::NotFound)
    );
    assert_eq!(read(404, "<html>", None), dated(outcomes::Code::NotFound));
    assert_eq!(
        read(401, r#"{"code":"unauthenticated"}"#, None),
        dated(outcomes::Code::Unauthenticated)
    );
    assert_eq!(read(501, "", None), dated(outcomes::Code::Unimplemented));
    assert_eq!(
        read(429, r#"{"code":"resource_exhausted"}"#, Some(20)),
        Answer {
            retry_after: Some(20),
            ..dated(outcomes::Code::ResourceExhausted)
        }
    );
    assert_eq!(
        read(503, "", Some(30)),
        Answer {
            retry_after: Some(30),
            ..dated(outcomes::Code::Unavailable)
        }
    );
    assert_eq!(
        read(400, r#"{"code":"invalid_argument"}"#, None),
        dated(outcomes::Code::InvalidArgument)
    );
    assert_eq!(
        read(429, "", Some(20)),
        Answer {
            retry_after: Some(20),
            ..dated(outcomes::Code::ResourceExhausted)
        }
    );
    assert_eq!(read(401, "", None), dated(outcomes::Code::Unauthenticated));
    assert_eq!(read(599, "", None), dated(outcomes::Code::Internal));
    assert_eq!(read(302, "", None), dated(outcomes::Code::BadReply));
    assert_eq!(read(413, "", None), dated(outcomes::Code::InvalidArgument));
    assert_eq!(read(418, "", None), dated(outcomes::Code::Transport));
    assert_eq!(read(400, "<html>", None), dated(outcomes::Code::Transport));
    assert_eq!(read(403, "<html>", None), dated(outcomes::Code::Transport));
}

#[test]
fn refusals_are_read_with_their_reason_and_time() {
    let read = |refused: Refusal, retry_after: Option<i64>| {
        let e = ConnectError::refused(refused).unwrap();
        read_answer(e.http(), e.to_json().as_bytes(), retry_after, T0, None)
    };
    let reason = |code: outcomes::Code, refusal: outcomes::Refusal| Answer {
        refusal: Some(refusal),
        ..answer(code)
    };
    assert_eq!(
        read(
            Refusal {
                until: T0 + 600,
                ..refusal(RefusalReason::Paused)
            },
            Some(600)
        ),
        Answer {
            until: Some(T0 + 600),
            retry_after: Some(600),
            ..reason(outcomes::Code::Unavailable, outcomes::Refusal::Paused)
        }
    );
    assert_eq!(
        read(refusal(RefusalReason::Busy), Some(45)),
        Answer {
            retry_after: Some(45),
            ..reason(outcomes::Code::Unavailable, outcomes::Refusal::Busy)
        }
    );
    for (wire, code, refusal_read) in [
        (
            RefusalReason::StampNeeded,
            outcomes::Code::Unavailable,
            outcomes::Refusal::StampNeeded,
        ),
        (
            RefusalReason::Version,
            outcomes::Code::FailedPrecondition,
            outcomes::Refusal::Version,
        ),
        (
            RefusalReason::HelloNeeded,
            outcomes::Code::FailedPrecondition,
            outcomes::Refusal::HelloNeeded,
        ),
        (
            RefusalReason::Refused,
            outcomes::Code::PermissionDenied,
            outcomes::Refusal::Refused,
        ),
        (
            RefusalReason::Identity,
            outcomes::Code::PermissionDenied,
            outcomes::Refusal::Identity,
        ),
    ] {
        assert_eq!(read(refusal(wire), None), reason(code, refusal_read));
    }
    let unknown = ConnectError {
        code: Code::Unavailable,
        message: String::new(),
        refusal: Some(Refusal {
            reason: 99,
            ..Refusal::default()
        }),
    };
    assert_eq!(
        read_answer(503, unknown.to_json().as_bytes(), None, T0, None),
        answer(outcomes::Code::Unavailable)
    );
}

#[test]
fn a_message_is_written_as_plain_ascii_json() {
    let e = ConnectError {
        code: Code::Internal,
        message: "quote \" slash \\ line\n caf\u{e9}".to_string(),
        refusal: None,
    };
    let json = e.to_json();
    assert!(json.is_ascii(), "{json}");
    assert_eq!(ConnectError::from_json(json.as_bytes()), Some(e));
}

#[test]
fn a_refusal_outside_its_documented_ranges_is_not_used() {
    let notice = |text: String| Refusal {
        notice: text,
        ..refusal(RefusalReason::Paused)
    };
    let detail = |refused: &Refusal| {
        json!({
            "code": "unavailable",
            "details": [{"type": REFUSAL_TYPE, "value": STANDARD.encode(refused.encode_to_vec())}],
        })
        .to_string()
    };
    let read = |refused: &Refusal| ConnectError::from_json(detail(refused).as_bytes()).unwrap();
    assert_eq!(
        read(&notice("n".repeat(200))).refusal,
        Some(notice("n".repeat(200)))
    );
    assert_eq!(read(&notice("n".repeat(201))).refusal, None);
    assert_eq!(read(&notice("caf\u{e9}".to_string())).refusal, None);
    assert_eq!(read(&notice("line\nbreak".to_string())).refusal, None);
    let needs = |n: usize| Refusal {
        need: vec![
            FeatureLevel {
                name: "letters".to_string(),
                level: 1,
                min: 1
            };
            n
        ],
        ..refusal(RefusalReason::Version)
    };
    assert!(read(&needs(64)).refusal.is_some());
    assert_eq!(read(&needs(65)).refusal, None);
    assert_eq!(read(&needs(65)).code, Code::Unavailable);
    assert_eq!(ConnectError::refused(notice("n".repeat(201))), None);
    assert_eq!(ConnectError::refused(needs(65)), None);
    assert_eq!(
        read_answer(
            503,
            detail(&notice("n".repeat(201))).as_bytes(),
            None,
            T0,
            None
        ),
        answer(outcomes::Code::Unavailable)
    );
}

#[test]
fn an_answer_that_is_no_connect_error_is_read_by_its_status() {
    let read = |status: u16| read_answer(status, b"<html>", None, T0, None).code;
    assert_eq!(read(413), outcomes::Code::InvalidArgument);
    for status in [400, 402, 403, 405, 408, 418, 451] {
        assert_eq!(read(status), outcomes::Code::Transport, "{status}");
    }
    for status in [201, 204, 301, 302, 304] {
        assert_eq!(read(status), outcomes::Code::BadReply, "{status}");
    }
}
