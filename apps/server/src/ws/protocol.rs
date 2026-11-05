use std::collections::{BTreeMap, HashMap};

use axum::extract::ws::{CloseFrame, Message as Frame, Utf8Bytes, WebSocket};
use serde::Deserialize;
use tokio::time::Instant;
use tracing::{debug, warn};

use super::access::AUTH_FAILED;
use super::p2p::RelaySet;

#[derive(Deserialize)]
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
    },
    VoiceLeave,
    CallStart {
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
        payload: serde_json::Value,
    },
    Typing {
        scope: String,
    },
    TypingStop {
        scope: String,
    },
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
