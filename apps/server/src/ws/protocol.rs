use std::collections::{BTreeMap, HashMap};

use axum::extract::ws::{CloseFrame, Message as Frame, Utf8Bytes, WebSocket};
use serde::Deserialize;
use tokio::time::Instant;
use tracing::{debug, warn};

use super::access::AUTH_FAILED;
use super::event::{RefusedRequest, WsEvent};
use super::p2p::RelaySet;
use crate::api::{ApiError, Reason};

/// What an `error` frame tells a client: the text and, when the error has one, its reason.
#[derive(Debug, PartialEq)]
pub(super) enum Refused {
    NoSharedVoice,
    // The join already broadcast its state. Its end follows that broadcast.
    AfterJoin(Box<Refused>),
    Error {
        message: String,
        reason: Option<Box<Reason>>,
    },
}

impl Refused {
    pub(super) fn into_parts(self) -> (String, Option<Reason>) {
        match self {
            Self::NoSharedVoice => ("No shared voice session".into(), None),
            Self::AfterJoin(refusal) => refusal.into_parts(),
            Self::Error { message, reason } => (message, reason.map(|r| *r)),
        }
    }

    pub(super) fn frame(self, request: Option<RefusedRequest>) -> WsEvent {
        let request = match self {
            Self::AfterJoin(_) => request.map(|_| RefusedRequest::Other),
            _ => request,
        };
        let (message, reason) = self.into_parts();
        WsEvent::Error {
            message,
            reason,
            request,
        }
    }
}

impl From<String> for Refused {
    fn from(message: String) -> Refused {
        Self::Error {
            message,
            reason: None,
        }
    }
}

impl From<&str> for Refused {
    fn from(message: &str) -> Refused {
        message.to_string().into()
    }
}

impl From<ApiError> for Refused {
    fn from(e: ApiError) -> Refused {
        Self::Error {
            message: e.error().to_string(),
            reason: e.reason().cloned().map(Box::new),
        }
    }
}

impl From<sqlx::Error> for Refused {
    fn from(e: sqlx::Error) -> Refused {
        ApiError::from(e).into()
    }
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ClientMsg {
    Auth {
        #[serde(default)]
        token: Option<String>,
    },
    Viewing {
        server: Option<String>,
    },
    Subscribe {
        servers: Vec<String>,
        #[serde(default)]
        grants: HashMap<String, String>,
    },
    VoiceJoin {
        channel_id: i64,
        #[serde(default)]
        muted: bool,
        #[serde(default)]
        deafened: bool,
    },
    VoiceLeave,
    VoiceAudio {
        #[serde(default)]
        muted: bool,
        #[serde(default)]
        deafened: bool,
    },
    CallStart {
        attempt_id: Option<u64>,
        dm_id: i64,
        #[serde(default)]
        p2p: bool,
        #[serde(default)]
        video: bool,
        #[serde(default)]
        peer_id: Option<String>,
        #[serde(default)]
        relays: Vec<String>,
    },
    P2pHosting {
        peer_id: String,
        ids: Vec<String>,
        #[serde(default)]
        relays: BTreeMap<String, Vec<String>>,
        #[serde(default)]
        relay_sets: Vec<RelaySet>,
    },
    P2pWho {
        hosters: Vec<String>,
    },
    P2pPeer {
        message_id: i64,
        peer_id: String,
    },
    CallAccept {
        attempt_id: Option<u64>,
        dm_id: i64,
        #[serde(default)]
        peer_id: Option<String>,
        #[serde(default)]
        relays: Vec<String>,
    },
    CallDecline {
        dm_id: i64,
    },
    CallLeave {
        dm_id: i64,
    },
    RtcSignal {
        to: String,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        #[schema(value_type = Object)]
        payload: serde_json::Value,
    },
    Typing {
        scope: String,
    },
    TypingStop {
        scope: String,
    },
}

impl ClientMsg {
    pub(super) fn refusal_target(&self) -> RefusedRequest {
        match self {
            Self::CallStart {
                attempt_id: Some(id),
                ..
            }
            | Self::CallAccept {
                attempt_id: Some(id),
                ..
            } => RefusedRequest::Call { attempt_id: *id },
            Self::VoiceJoin {
                channel_id,
                muted: _,
                deafened: _,
            } => RefusedRequest::VoiceJoin {
                channel_id: *channel_id,
            },
            _ => RefusedRequest::Other,
        }
    }
}

/// Close codes of realtime connections closed for a limit: the user opened more than
/// `CONNS_PER_USER` at once (this, the oldest, was closed; reconnect only when used again), or
/// opened too many in a short time (retry later, like a 429).
pub const CLOSE_TOO_MANY: (u16, &str) = (4008, "Too many open connections for this account");
pub const CLOSE_TOO_OFTEN: (u16, &str) = (4029, "Too many connection attempts, try again later");
/// Close codes of realtime connections from an address with too many open (as guests), and
/// of connections that sent no `auth` frame in time.
pub const CLOSE_TOO_MANY_ADDR: (u16, &str) = (
    4029,
    "Too many open connections from this address, try again later",
);
/// Close code of guest connections past the guest connections of the whole instance.
pub const CLOSE_TOO_MANY_GUESTS: (u16, &str) = (
    4029,
    "Too many guest connections right now, try again later",
);
pub const CLOSE_NO_AUTH: (u16, &str) = (4001, "No auth frame in time");
/// Close code of a realtime connection whose session must change its temporary password
/// first.
pub const CLOSE_PASSWORD_CHANGE: (u16, &str) = (4403, "password_change");

pub(super) fn close_frame((code, reason): (u16, &str)) -> Frame {
    Frame::Close(Some(CloseFrame {
        code,
        reason: Utf8Bytes::from(reason),
    }))
}

pub(super) fn refuse(e: sqlx::Error) {
    match AUTH_FAILED.admit(Instant::now()) {
        true => warn!(
            "refused a realtime connection because its account could not be loaded; the client retries: {e}"
        ),
        false => debug!("refused a realtime connection whose account could not be loaded: {e}"),
    }
}

pub(super) async fn first_frame(socket: &mut WebSocket) -> Option<Option<String>> {
    loop {
        match socket.recv().await {
            Some(Ok(Frame::Text(text))) => {
                return match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(ClientMsg::Auth { token }) => Some(token),
                    Ok(_) | Err(_) => Some(None),
                };
            }
            Some(Ok(Frame::Close(_))) | Some(Err(_)) | None => return None,
            Some(Ok(_)) => {}
        }
    }
}
