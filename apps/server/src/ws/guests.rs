use std::time::Duration;

use super::CallKind;
use super::access::Access;
use super::calls::{finalize_call_log, relay_signal, still_on, switched_on};
use super::protocol::{ClientMsg, Refused};

use crate::api::access::{ws_channel_now, ws_guest_voice_channel};
use crate::db::ChannelKind;
use crate::hub::{Audio, Hub};
use crate::state::AppState;

/// Names of guests in voice rooms start with this. Usernames never contain `@`.
pub(crate) const GUEST_PREFIX: &str = "@guest:";

pub(crate) const ACCOUNT_FOR_VOICE: &str = "Create an account to join voice";

/// What a guest staff took out of voice is told.
pub(crate) const REMOVED_BY_STAFF: &str = "Removed from voice by staff";

/// How long a guest staff took out of a server's voice stays out of it, by its connection and
/// its address.
pub(crate) const GUEST_VOICE_BLOCK: Duration = Duration::from_secs(600);

/// Why a guest can't use the voice of a server whose "Guests can use voice" option is off.
pub(crate) const GUESTS_NO_VOICE: &str = "Guests can't use voice in this server";

/// The name a new guest connection has in voice rooms.
pub(super) fn guest_name() -> String {
    format!("{GUEST_PREFIX}{}", &crate::identity::random_id()[..16])
}

pub(crate) fn is_guest(name: &str) -> bool {
    name.starts_with(GUEST_PREFIX)
}

/// What a guest does in voice under `name`: join a voice channel of a server it follows and
/// may open, leave, say whether its mic and sound are off, and signal the others in its room.
/// Calls need an account.
pub(super) async fn guest_voice(
    state: &AppState,
    access: &Access,
    name: &str,
    conn: u64,
    msg: ClientMsg,
) -> Result<(), Refused> {
    match msg {
        ClientMsg::VoiceJoin {
            channel_id,
            muted,
            deafened,
        } => {
            switched_on(state, CallKind::Rtc).await?;
            let server = admit(state, access, channel_id).await?;
            let ends = state
                .hub
                .guest_join_with(
                    name,
                    conn,
                    (&server, channel_id),
                    state.limits.voice_room_max,
                    access.addr,
                    Audio { muted, deafened },
                )
                .await?;
            for end in ends {
                finalize_call_log(state, end, false).await;
            }
            still_on(state, CallKind::Rtc).await?;
            if let Err(e) = admit(state, access, channel_id).await {
                state
                    .hub
                    .kick_from_voice(name, &server, None, GUESTS_NO_VOICE, Duration::ZERO);
                return Err(e);
            }
            Ok(())
        }
        ClientMsg::VoiceLeave => {
            state.hub.voice_leave(name).await;
            Ok(())
        }
        ClientMsg::VoiceAudio { muted, deafened } => {
            state.hub.voice_audio(name, conn, Audio { muted, deafened });
            Ok(())
        }
        ClientMsg::RtcSignal {
            to,
            channel_id: Some(channel_id),
            dm_id: None,
            payload,
        } => {
            if !state.hub.rtc_shared(name, &to, Some(channel_id), None) {
                return Err(Refused::NoSharedVoice);
            }
            if let Err(e) = admit(state, access, channel_id).await {
                state.hub.evict_voice(name, channel_id);
                return Err(e);
            }
            switched_on(state, CallKind::Rtc).await?;
            relay_signal(state, name, to, Some(channel_id), None, payload).await
        }
        ClientMsg::RtcSignal {
            to: _,
            channel_id: _,
            dm_id: _,
            payload: _,
        } => Err(Refused::NoSharedVoice),
        ClientMsg::CallStart {
            attempt_id: _,
            dm_id: _,
            p2p: _,
            video: _,
            peer_id: _,
            relays: _,
        }
        | ClientMsg::CallAccept {
            attempt_id: _,
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

async fn admit(state: &AppState, access: &Access, channel_id: i64) -> Result<String, Refused> {
    let gone = || Refused::from("Channel not found");
    let Some((server, _)) = ws_channel_now(&state.db, channel_id).await? else {
        return Err(gone());
    };
    if !access.subs.contains(&server) {
        return Err(gone());
    }
    let grant = access.grants.get(&server).map(String::as_str);
    let channel = ws_guest_voice_channel(&state.db, channel_id, grant, &state.limits).await?;
    if channel.kind() != ChannelKind::Voice {
        return Err("Not a voice channel".into());
    }
    if !channel.member_rights(&state.db).await?.view {
        return Err(gone());
    }
    if !channel.guest_participation(&state.db).await? {
        return Err(GUESTS_NO_VOICE.into());
    }
    Ok(server)
}

/// Takes every guest out of the voice of `server`, whose option now keeps guests out.
pub(crate) fn guests_out_of_voice(hub: &Hub, server: &str) {
    for (_, users) in hub.rooms_in(server, None) {
        for user in users.iter().filter(|u| is_guest(u)) {
            hub.kick_from_voice(user, server, None, GUESTS_NO_VOICE, Duration::ZERO);
        }
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
