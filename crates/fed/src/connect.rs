use base64::Engine;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use prost::Message;
use serde_json::Value;

use crate::call::CallError;
use crate::limits::NOTICE_MAX;
use crate::limits::hello::{FEATURES_MAX, TEXT_MAX};
use crate::outcomes::{self, Answer};
use crate::pb::{Refusal, RefusalReason};

pub const REFUSAL_TYPE: &str = "rchat.fed.v1.Refusal";
pub const ERROR_BODY_MAX: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    InvalidArgument,
    NotFound,
    PermissionDenied,
    ResourceExhausted,
    FailedPrecondition,
    Unimplemented,
    Internal,
    Unavailable,
    Unauthenticated,
}

impl Code {
    pub const ALL: [Code; 9] = [
        Code::InvalidArgument,
        Code::NotFound,
        Code::PermissionDenied,
        Code::ResourceExhausted,
        Code::FailedPrecondition,
        Code::Unimplemented,
        Code::Internal,
        Code::Unavailable,
        Code::Unauthenticated,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Code::InvalidArgument => "invalid_argument",
            Code::NotFound => "not_found",
            Code::PermissionDenied => "permission_denied",
            Code::ResourceExhausted => "resource_exhausted",
            Code::FailedPrecondition => "failed_precondition",
            Code::Unimplemented => "unimplemented",
            Code::Internal => "internal",
            Code::Unavailable => "unavailable",
            Code::Unauthenticated => "unauthenticated",
        }
    }

    pub fn from_name(name: &str) -> Option<Code> {
        Code::ALL.into_iter().find(|code| code.name() == name)
    }

    pub fn http(self) -> u16 {
        match self {
            Code::InvalidArgument | Code::FailedPrecondition => 400,
            Code::Unauthenticated => 401,
            Code::PermissionDenied => 403,
            Code::NotFound => 404,
            Code::ResourceExhausted => 429,
            Code::Internal => 500,
            Code::Unimplemented => 501,
            Code::Unavailable => 503,
        }
    }

    fn answer(self) -> outcomes::Code {
        match self {
            Code::InvalidArgument => outcomes::Code::InvalidArgument,
            Code::NotFound => outcomes::Code::NotFound,
            Code::PermissionDenied => outcomes::Code::PermissionDenied,
            Code::ResourceExhausted => outcomes::Code::ResourceExhausted,
            Code::FailedPrecondition => outcomes::Code::FailedPrecondition,
            Code::Unimplemented => outcomes::Code::Unimplemented,
            Code::Internal => outcomes::Code::Internal,
            Code::Unavailable => outcomes::Code::Unavailable,
            Code::Unauthenticated => outcomes::Code::Unauthenticated,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConnectError {
    pub code: Code,
    pub message: String,
    pub refusal: Option<Refusal>,
}

fn ascii_json(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            ' '..='~' => out.push(c),
            _ => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out.push('"');
    out
}

fn reason_of(refusal: &Refusal) -> Option<(Code, outcomes::Refusal)> {
    match RefusalReason::try_from(refusal.reason).ok()? {
        RefusalReason::Unspecified => None,
        RefusalReason::Refused => Some((Code::PermissionDenied, outcomes::Refusal::Refused)),
        RefusalReason::Paused => Some((Code::Unavailable, outcomes::Refusal::Paused)),
        RefusalReason::Version => Some((Code::FailedPrecondition, outcomes::Refusal::Version)),
        RefusalReason::Identity => Some((Code::PermissionDenied, outcomes::Refusal::Identity)),
        RefusalReason::HelloNeeded => {
            Some((Code::FailedPrecondition, outcomes::Refusal::HelloNeeded))
        }
        RefusalReason::Busy => Some((Code::Unavailable, outcomes::Refusal::Busy)),
        RefusalReason::StampNeeded => Some((Code::Unavailable, outcomes::Refusal::StampNeeded)),
    }
}

fn in_range(refusal: &Refusal) -> bool {
    let Refusal {
        reason: _,
        until: _,
        need,
        notice,
        stamp_work: _,
    } = refusal;
    notice.len() <= NOTICE_MAX
        && notice.bytes().all(|b| (b' '..=b'~').contains(&b))
        && need.len() <= FEATURES_MAX
        && need.iter().all(|level| level.name.len() <= TEXT_MAX)
}

impl ConnectError {
    pub fn new(code: Code) -> ConnectError {
        ConnectError {
            code,
            message: String::new(),
            refusal: None,
        }
    }

    pub fn refused(refusal: Refusal) -> Option<ConnectError> {
        let (code, _) = reason_of(&refusal).filter(|_| in_range(&refusal))?;
        Some(ConnectError {
            refusal: Some(refusal),
            ..ConnectError::new(code)
        })
    }

    pub fn for_call(error: CallError, stamp_work: u64) -> ConnectError {
        let (code, _) = crate::call::answer_of(error);
        let reason = |reason: RefusalReason, stamp_work| Refusal {
            reason: reason as i32,
            stamp_work,
            ..Refusal::default()
        };
        match error {
            CallError::Header | CallError::Iss | CallError::Aud => ConnectError {
                message: "Not found".to_string(),
                ..ConnectError::new(code)
            },
            CallError::StampNeeded => ConnectError {
                refusal: Some(reason(RefusalReason::StampNeeded, stamp_work)),
                ..ConnectError::new(code)
            },
            CallError::HelloNeeded => ConnectError {
                refusal: Some(reason(RefusalReason::HelloNeeded, 0)),
                ..ConnectError::new(code)
            },
            CallError::Unimplemented
            | CallError::Method
            | CallError::Time
            | CallError::Body
            | CallError::Jti
            | CallError::Busy
            | CallError::Keys
            | CallError::Kid
            | CallError::Forged
            | CallError::Replay
            | CallError::NotCallKey => ConnectError::new(code),
        }
    }

    pub fn http(&self) -> u16 {
        self.code.http()
    }

    pub fn to_json(&self) -> String {
        let ConnectError {
            code,
            message,
            refusal,
        } = self;
        let mut out = format!("{{\"code\":\"{}\"", code.name());
        if !message.is_empty() {
            out.push_str(&format!(",\"message\":{}", ascii_json(message)));
        }
        if let Some(refusal) = refusal {
            let value = STANDARD_NO_PAD.encode(refusal.encode_to_vec());
            out.push_str(&format!(
                ",\"details\":[{{\"type\":\"{REFUSAL_TYPE}\",\"value\":\"{value}\"}}]"
            ));
        }
        out.push('}');
        out
    }

    pub fn from_json(body: &[u8]) -> Option<ConnectError> {
        if body.len() > ERROR_BODY_MAX {
            return None;
        }
        let value: Value = serde_json::from_slice(body).ok()?;
        let code = Code::from_name(value.get("code")?.as_str()?)?;
        let message = value.get("message").and_then(Value::as_str).unwrap_or("");
        let refusal = value
            .get("details")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|detail| detail.get("type").and_then(Value::as_str) == Some(REFUSAL_TYPE))
            .filter_map(|detail| detail.get("value")?.as_str())
            .filter_map(|text| {
                let text = text.trim_end_matches('=');
                let bytes = STANDARD_NO_PAD.decode(text).ok()?;
                Refusal::decode(bytes.as_slice()).ok()
            })
            .find(in_range);
        Some(ConnectError {
            code,
            message: message.to_string(),
            refusal,
        })
    }
}

pub fn read_answer(
    status: u16,
    body: &[u8],
    retry_after: Option<i64>,
    now: i64,
    their_now: Option<i64>,
) -> Answer {
    let answer = |code| Answer {
        code,
        refusal: None,
        until: None,
        retry_after,
        now: Some(now),
        their_now,
    };
    if status == 200 {
        return answer(outcomes::Code::Ok);
    }
    let Some(error) = ConnectError::from_json(body) else {
        return answer(match status {
            401 => outcomes::Code::Unauthenticated,
            404 => outcomes::Code::NotFound,
            413 => outcomes::Code::InvalidArgument,
            429 => outcomes::Code::ResourceExhausted,
            501 => outcomes::Code::Unimplemented,
            503 => outcomes::Code::Unavailable,
            400..=499 => outcomes::Code::Transport,
            500..=599 => outcomes::Code::Internal,
            _ => outcomes::Code::BadReply,
        });
    };
    let refused = error.refusal.as_ref().and_then(|refusal| {
        let (_, reason) = reason_of(refusal)?;
        Some((reason, refusal.until))
    });
    Answer {
        refusal: refused.map(|(reason, _)| reason),
        until: refused.map(|(_, until)| until).filter(|until| *until != 0),
        ..answer(error.code.answer())
    }
}
