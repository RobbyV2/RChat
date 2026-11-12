use super::access::Access;
use super::calls::{finalize_call_log, relay_signal};
use super::protocol::{ClientMsg, Refused};

use crate::api::access::{ws_channel_now, ws_guest_voice_channel};
use crate::db::ChannelKind;
use crate::hub::Hub;
use crate::state::AppState;

/// Names of guests in voice rooms start with this. Usernames never contain `@`.
pub(crate) const GUEST_PREFIX: &str = "@guest:";

pub(crate) const ACCOUNT_FOR_VOICE: &str = "Create an account to join voice";

/// The name a new guest connection has in voice rooms.
pub(super) fn guest_name() -> String {
    format!("{GUEST_PREFIX}{}", &crate::identity::random_id()[..16])
}

pub(crate) fn is_guest(name: &str) -> bool {
    name.starts_with(GUEST_PREFIX)
}

/// What a guest does in voice under `name`: join a voice channel of a server it follows and
/// may open, leave, and signal the others in its room. Calls need an account.
pub(super) async fn guest_voice(
    state: &AppState,
    access: &Access,
    name: &str,
    conn: u64,
    msg: ClientMsg,
) -> Result<(), Refused> {
    match msg {
        ClientMsg::VoiceJoin { channel_id } => {
            let gone = || Refused::from("Channel not found");
            let Some((server, _)) = ws_channel_now(&state.read(), channel_id).await? else {
                return Err(gone());
            };
            if !access.subs.contains(&server) {
                return Err(gone());
            }
            let grant = access.grants.get(&server).map(String::as_str);
            let channel =
                ws_guest_voice_channel(&state.read(), channel_id, grant, &state.limits).await?;
            if channel.kind() != ChannelKind::Voice {
                return Err("Not a voice channel".into());
            }
            if !channel.member_rights(&state.read()).await?.view {
                return Err(gone());
            }
            let ends = state
                .hub
                .voice_join_capped(name, conn, &server, channel_id, state.limits.voice_room_max)
                .await?;
            for end in ends {
                finalize_call_log(state, end, false).await;
            }
            Ok(())
        }
        ClientMsg::VoiceLeave => {
            state.hub.voice_leave(name).await;
            Ok(())
        }
        ClientMsg::RtcSignal {
            to,
            channel_id: Some(channel_id),
            dm_id: None,
            payload,
        } => relay_signal(state, name, to, Some(channel_id), None, payload).await,
        ClientMsg::RtcSignal {
            to: _,
            channel_id: _,
            dm_id: _,
            payload: _,
        } => Err("No shared voice session".into()),
        ClientMsg::CallStart {
            dm_id: _,
            p2p: _,
            video: _,
            peer_id: _,
            relays: _,
        }
        | ClientMsg::CallAccept {
            dm_id: _,
            peer_id: _,
            relays: _,
        }
        | ClientMsg::CallDecline { dm_id: _ }
        | ClientMsg::CallLeave { dm_id: _ } => Err(ACCOUNT_FOR_VOICE.into()),
        ClientMsg::Auth { token: _ }
        | ClientMsg::Viewing { server: _ }
        | ClientMsg::Subscribe {
            servers: _,
            grants: _,
        }
        | ClientMsg::P2pHosting {
            peer_id: _,
            ids: _,
            relays: _,
            relay_sets: _,
        }
        | ClientMsg::P2pPeer {
            message_id: _,
            peer_id: _,
        }
        | ClientMsg::P2pWho { hosters: _ }
        | ClientMsg::Typing { scope: _ }
        | ClientMsg::TypingStop { scope: _ } => Ok(()),
    }
}

/// A guest leaves the voice rooms of servers it no longer follows (its password ended, the
/// server closed to it, or it stopped following it).
pub(super) fn leave_closed_voice(hub: &Hub, access: &Access) {
    let Some(name) = &access.guest else {
        return;
    };
    for (channel_id, server) in hub.rooms_of(name) {
        if !access.subs.contains(&server) {
            hub.evict_voice(name, channel_id);
        }
    }
}
