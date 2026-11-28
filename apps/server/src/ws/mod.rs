use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::api::access::perms::held;
use crate::api::access::{
    Proof, ws_channel_now, ws_server_open, ws_voice_rights, ws_voice_silenced, ws_voice_viewable,
};
use crate::db::Db;
pub use crate::hub::Hub;
use crate::limits::Limits;
use crate::state::AppState;

mod access;
pub mod calls;
mod conn;
mod event;
mod filter;
mod guests;
mod p2p;
mod protocol;
mod repost;
mod rewrite;
mod typing;
mod widget_socket;

pub(crate) use access::LogGate;
pub(crate) use calls::{end_dm_call, end_switched_off};
pub use conn::{__path_handler, handler};
pub use event::{
    CallPeer, CallRelays, EditStub, SeatAudio, Updated, UserScope, WsEvent, to_bus_json,
};
pub(crate) use guests::{GUEST_VOICE_BLOCK, REMOVED_BY_STAFF, guests_out_of_voice, is_guest};
pub use protocol::{
    CLOSE_NO_AUTH, CLOSE_TOO_MANY, CLOSE_TOO_MANY_ADDR, CLOSE_TOO_MANY_GUESTS, CLOSE_TOO_OFTEN,
};
pub use repost::{
    announce_expired_passwords, announce_purge, depart, settle, spawn_aftermath, sweep_and_log,
};

/// Proof that the caller is the socket layer. Only code in `ws` can make one, so the gate's
/// socket predicates and the socket session lookup cannot be called from anywhere else.
pub struct Layer(());

pub(in crate::ws) const LAYER: Layer = Layer(());

#[cfg(test)]
impl Layer {
    pub(crate) fn for_tests() -> &'static Layer {
        &LAYER
    }
}

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
const MSG_RATE: f64 = 50.0;
const MSG_BURST: f64 = 200.0;
pub(crate) const VOICE_ROOM_MAX: usize = rchat_settings::items::VOICE_ROOM_MAX.default() as usize;
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
        if moved_away(state, server, cid).await {
            continue;
        }
        for user in users {
            if !may_stay(state, server, cid, &user).await {
                state.hub.evict_voice(&user, cid);
            }
        }
    }
}

/// Whether voice channel `cid` belongs to a server other than `server` now.
async fn moved_away(state: &AppState, server: &str, cid: i64) -> bool {
    matches!(ws_channel_now(&crate::ws::LAYER, &state.read(), cid).await, Ok(Some((owner, _))) if owner != server)
}

/// Whether `user` may stay in voice channel `cid` of `server`.
async fn may_stay(state: &AppState, server: &str, cid: i64, user: &str) -> bool {
    // A guest's own connection takes it out when it stops following the server.
    let open = is_guest(user)
        || ws_server_open(
            &crate::ws::LAYER,
            &state.read(),
            server,
            Some(user),
            false,
            &Proof::none(),
        )
        .await
        .unwrap_or(false);
    open && ws_voice_viewable(&crate::ws::LAYER, &state.read(), server, cid, user).await
}

/// After `username`'s roles in `server` changed: takes them out of its voice when they may no
/// longer be there, else tells their room whether they are muted now.
pub(crate) async fn member_voice_changed(state: &AppState, server: &str, username: &str) {
    for (cid, users) in state.hub.rooms_in(server, None) {
        if !users.iter().any(|u| u == username) || moved_away(state, server, cid).await {
            continue;
        }
        if !may_stay(state, server, cid, username).await {
            state.hub.evict_voice(username, cid);
            continue;
        }
        let one = [username.to_string()];
        let Ok(silenced) =
            ws_voice_silenced(&crate::ws::LAYER, &state.read(), server, cid, &one).await
        else {
            continue;
        };
        state.hub.broadcast(WsEvent::VoiceMuted {
            server: server.to_string(),
            channel_id: cid,
            muted: silenced.contains(username),
            username: username.to_string(),
            staff: false,
        });
    }
}

/// Ends the mute of a timeout for `username` in the voice channel of `server` they are in,
/// unless they hold no Speak there.
pub(crate) async fn end_voice_mute(state: &AppState, server: &str, username: &str) {
    for (channel_id, users) in state.hub.rooms_in(server, None) {
        if users.iter().any(|u| u == username) {
            let rights = ws_voice_rights(
                &crate::ws::LAYER,
                &state.read(),
                server,
                channel_id,
                username,
            )
            .await;
            state.hub.broadcast(WsEvent::VoiceMuted {
                server: server.to_string(),
                channel_id,
                username: username.to_string(),
                muted: !rights.holds(held::SPEAK),
                staff: false,
            });
        }
    }
}

/// After the permissions of `server` (or of one of its channels) changed: takes out of its voice
/// who may no longer be there, and tells the rooms who is muted there now.
pub(crate) async fn voice_rules_changed(state: &AppState, server: &str, channel_id: Option<i64>) {
    evict_unviewable(state, server, channel_id).await;
    for (cid, users) in state.hub.rooms_in(server, channel_id) {
        let Ok(silenced) =
            ws_voice_silenced(&crate::ws::LAYER, &state.read(), server, cid, &users).await
        else {
            continue;
        };
        for username in users.into_iter().filter(|u| !is_guest(u)) {
            state.hub.broadcast(WsEvent::VoiceMuted {
                server: server.to_string(),
                channel_id: cid,
                muted: silenced.contains(&username),
                username,
                staff: false,
            });
        }
    }
}

/// Takes out of voice everyone who can no longer open the server of their room, after the
/// instance's rules for reading servers changed.
pub(crate) async fn evict_closed_voice(state: &AppState) {
    for server in state.hub.room_servers() {
        evict_unviewable(state, &server, None).await;
    }
}

async fn guest_sub_ok(
    db: &Db,
    server: &str,
    grant: Option<&str>,
    limits: &Limits,
) -> sqlx::Result<bool> {
    let proof = Proof::grants(grant.map(str::to_string).into_iter().collect(), limits);
    ws_server_open(&crate::ws::LAYER, db, server, None, false, &proof).await
}

async fn authed_sub_ok(db: &Db, server: &str, user: &str, site_admin: bool) -> sqlx::Result<bool> {
    ws_server_open(
        &crate::ws::LAYER,
        db,
        server,
        Some(user),
        site_admin,
        &Proof::none(),
    )
    .await
}

#[cfg(test)]
pub(crate) use repost::current;
#[cfg(test)]
mod tests;
