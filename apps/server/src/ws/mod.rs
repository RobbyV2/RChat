use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::api::access::{Proof, ws_channel_now, ws_server_open, ws_voice_viewable};
use crate::db::Db;
pub use crate::hub::Hub;
use crate::limits::Limits;
use crate::state::AppState;

mod access;
pub mod calls;
mod conn;
mod event;
mod filter;
mod p2p;
mod protocol;
mod repost;
mod rewrite;
mod typing;

pub(crate) use access::LogGate;
pub(crate) use calls::end_dm_call;
pub use conn::{__path_handler, handler};
pub use event::{CallPeer, CallRelays, EditStub, Updated, UserScope, WsEvent, to_bus_json};
pub use protocol::{
    CLOSE_NO_AUTH, CLOSE_TOO_MANY, CLOSE_TOO_MANY_ADDR, CLOSE_TOO_MANY_GUESTS, CLOSE_TOO_OFTEN,
};
pub use repost::{
    announce_expired_passwords, announce_purge, depart, settle, spawn_aftermath, sweep_and_log,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallPhase {
    Ringing,
    Active,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallKind {
    Rtc,
    P2p,
}

const P2P_IDS_CAP: usize = 256;
const P2P_ID_MAX: usize = 128;
const P2P_WHO_CAP: usize = 64;
const P2P_WHO_EVERY: Duration = Duration::from_secs(2);
const P2P_WHO_TTL: Duration = Duration::from_secs(10);
const P2P_WHO_CACHE_MAX: usize = 1024;
const SUBSCRIBE_CAP: usize = 100;
const GUEST_SUBSCRIBE_CAP: usize = 50;
// Server access checks a connection may run for `subscribe`: a burst, then this many per second.
const SUB_CHECKS_BURST: f64 = 200.0;
const SUB_CHECKS_RATE: f64 = 20.0;
const GUEST_SUB_CHECKS_BURST: f64 = 100.0;
const GUEST_SUB_CHECKS_RATE: f64 = 5.0;
const FRAME_MAX: usize = 64 * 1024;
pub(crate) const SIGNAL_MAX: usize = 20 * 1024;
const OUT_FRAMES: usize = 256;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const MSG_RATE: f64 = 50.0;
const MSG_BURST: f64 = 200.0;
pub(crate) const VOICE_ROOM_MAX: usize = 25;
pub const PURGE_CHUNK: usize = 500;
const PING_EVERY: Duration = Duration::from_secs(30);
const SILENT_LIMIT: Duration = Duration::from_secs(90);
const REAUTH_RETRY: Duration = Duration::from_secs(2);
const REAUTH_GIVE_UP: Duration = Duration::from_secs(30);
const LOG_EVERY: Duration = Duration::from_secs(10);
const LAG_REAUTH_EVERY: Duration = Duration::from_secs(2);
const P2P_ANNOUNCE_EVERY: Duration = Duration::from_secs(1);
const P2P_SCOPE_TTL: Duration = Duration::from_secs(60);
pub const TYPING_TTL: i64 = 8;
const TYPING_REFRESH: Duration = Duration::from_secs(2);
const TYPING_RATE: f64 = 1.0;
const TYPING_BURST: f64 = 4.0;
const TYPING_SCOPE_MAX: usize = 24;

pub(crate) async fn evict_unviewable(state: &AppState, server: &str, channel_id: Option<i64>) {
    for (cid, users) in state.hub.rooms_in(server, channel_id) {
        if let Ok(Some((owner, _))) = ws_channel_now(&state.read(), cid).await
            && owner != server
        {
            continue;
        }
        for user in users {
            let open = ws_server_open(&state.read(), server, Some(&user), false, &Proof::none())
                .await
                .unwrap_or(false);
            if !open || !ws_voice_viewable(&state.read(), server, cid, &user).await {
                state.hub.evict_voice(&user, cid);
            }
        }
    }
}

async fn guest_sub_ok(
    db: &Db,
    server: &str,
    grant: Option<&str>,
    limits: &Limits,
) -> sqlx::Result<bool> {
    let proof = Proof::grants(grant.map(str::to_string).into_iter().collect(), limits);
    ws_server_open(db, server, None, false, &proof).await
}

async fn authed_sub_ok(db: &Db, server: &str, user: &str, site_admin: bool) -> sqlx::Result<bool> {
    ws_server_open(db, server, Some(user), site_admin, &Proof::none()).await
}

#[cfg(test)]
pub(crate) use repost::current;
#[cfg(test)]
mod tests;
