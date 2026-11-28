use std::time::Duration;

use sqlx::Row;
use tokio::time::Instant;

use super::access::{Access, channel_gate};
use super::conn::{Out, sent};
use super::event::{Updated, WsEvent};
use super::filter::event_channel;
use super::guests::{ACCOUNT_FOR_VOICE, guest_voice};
use super::p2p::{CALLING_TOO_OFTEN, RECONNECTING, TOO_FAST};
use super::protocol::{ClientMsg, Refused};
use super::{CallKind, SIGNAL_MAX};

use crate::api::access::perms::held;
use crate::api::access::{ws_dm_users, ws_voice_channel, ws_voice_rights, ws_voice_silenced};
use crate::api::messages::load_broadcast;
use crate::db::{ChannelKind, touch_interaction};
use crate::hub::{Audio, CallEnd, VOICE_EVERY};
use crate::state::AppState;

/// The refusal of a voice join without Connect in the channel.
pub(crate) const NO_CONNECT: &str = "You can't join this voice channel";
/// The refusal of a camera or a screen share without Video in the channel.
pub(crate) const NO_VIDEO: &str = "You can't share video in this voice channel";

async fn insert_call_log(
    state: &AppState,
    dm_id: i64,
    caller: &str,
    (kind, video): (CallKind, bool),
) -> Result<i64, sqlx::Error> {
    let kind = match kind {
        CallKind::Rtc => "rtc",
        CallKind::P2p => "p2p",
    };
    sqlx::query(
        "INSERT INTO messages(dm_id, author, content, kind, call_kind, call_video, created_at) VALUES($1, $2, '', 'call', $3, $4, $5) RETURNING id",
    )
    .bind(dm_id)
    .bind(caller)
    .bind(kind)
    .bind(i64::from(video))
    .bind(state.clock.unix())
    .fetch_one(&state.db)
    .await?
    .try_get(0)
}

async fn broadcast_call_log(state: &AppState, dm_id: i64, dm_users: Vec<String>, log_id: i64) {
    if let Ok(Some(message)) = load_broadcast(&state.read(), log_id).await {
        crate::api::dms::reopen_for(state, dm_id, &message.author.username, &dm_users).await;
        state.hub.broadcast(WsEvent::Message {
            server: None,
            channel_id: None,
            dm_id: Some(dm_id),
            dm_users: Some(dm_users),
            message: Box::new(message),
        });
    }
}

async fn broadcast_call_update(state: &AppState, dm_users: Vec<String>, log_id: i64) {
    if let Ok(Some(message)) = load_broadcast(&state.read(), log_id).await {
        state.hub.broadcast(WsEvent::MessageUpdated {
            server: None,
            channel_id: None,
            update: Updated::full(message),
            dm_users,
        });
    }
}

async fn answer_call_log(state: &AppState, dm_users: Vec<String>, log_id: i64) {
    let res = sqlx::query(
        "UPDATE messages SET call_answered_at = $1 WHERE id = $2 AND call_answered_at IS NULL",
    )
    .bind(state.clock.unix())
    .bind(log_id)
    .execute(&state.db)
    .await;
    if matches!(res, Ok(r) if r.rows_affected() > 0) {
        broadcast_call_update(state, dm_users, log_id).await;
    }
}

/// Ends the call on DM `dm_id`, if there is one, for `user` (a block): a ringing call is logged
/// as declined.
pub(crate) async fn end_dm_call(state: &AppState, user: &str, dm_id: i64) {
    if let Ok(end) = state.hub.call_end(user, dm_id).await {
        finalize_call_log(state, end, true).await;
    }
}

pub(super) async fn finalize_call_log(state: &AppState, end: CallEnd, declined: bool) {
    let CallEnd {
        log_id,
        answered,
        dm_users,
    } = end;
    let outcome = match (answered, declined) {
        (true, _) => "completed",
        (false, true) => "declined",
        (false, false) => "missed",
    };
    let res = sqlx::query(
        "UPDATE messages SET call_ended_at = $1, call_outcome = $2 WHERE id = $3 AND call_ended_at IS NULL",
    )
    .bind(state.clock.unix())
    .bind(outcome)
    .bind(log_id)
    .execute(&state.db)
    .await;
    if matches!(res, Ok(r) if r.rows_affected() > 0) {
        broadcast_call_update(state, dm_users, log_id).await;
    }
}

/// Whether `user` is in voice channel `channel` of `server` now.
pub fn in_voice(state: &AppState, server: &str, channel: i64, user: &str) -> bool {
    state.hub.in_room(server, channel, user)
}

/// Whether `user` is a joined participant of the call in DM `dm` now: an RTC call (not P2P) that
/// was answered, with them in it, the rule `rtc_shared` uses for DM signalling. A ringing call
/// does not count, unlike the busy check of `call_start`.
pub fn in_call(state: &AppState, dm: i64, user: &str) -> bool {
    state.hub.in_active_call(dm, user)
}

/// What a voice room's users are told when the instance turns calls off.
const CALLS_ENDED: &str = "Calls were turned off";

pub(crate) const CALLS_OFF: &str = "Calls are turned off on this site";
pub(crate) const P2P_OFF: &str = "P2P is turned off on this site";

/// Whether the instance lets calls of `kind` run: voice channels and calls through the instance
/// follow `calls`, P2P calls follow `p2p`. The refusal names the switch. A site admin follows
/// the same rule as everyone.
pub(super) async fn switched_on(state: &AppState, kind: CallKind) -> Result<(), Refused> {
    let allowed = crate::api::policy::effective(&state.db, None).await;
    match kind {
        CallKind::Rtc if !allowed.calls() => Err(crate::api::policy::refused(
            &rchat_settings::items::FEATURE_CALLS,
            crate::api::ApiError::perm(CALLS_OFF, "member"),
        )
        .into()),
        CallKind::P2p if !allowed.p2p() => Err(crate::api::policy::refused(
            crate::api::features::Feature::P2p.item(),
            crate::api::ApiError::perm(P2P_OFF, "member"),
        )
        .into()),
        CallKind::Rtc | CallKind::P2p => Ok(()),
    }
}

/// Ends what the instance's switches no longer allow: every voice room and every call through
/// the instance while `calls` is off, every P2P call while `p2p` is off. Nothing else changes:
/// the voice channels and the call logs stay.
pub(crate) async fn end_switched_off(state: &AppState) {
    let allowed = crate::api::policy::effective(&state.db, None).await;
    if !allowed.calls() {
        for (channel_id, users) in state.hub.rooms() {
            for user in users {
                state.hub.end_voice(&user, channel_id, CALLS_ENDED);
            }
        }
    }
    for (dm_id, kind, user) in state.hub.calls() {
        let off = match kind {
            CallKind::Rtc => !allowed.calls(),
            CallKind::P2p => !allowed.p2p(),
        };
        if off && let Ok(end) = state.hub.call_end(&user, dm_id).await {
            finalize_call_log(state, end, false).await;
        }
    }
}

/// A call of `kind` just started or grew: when its switch went off meanwhile, it ends with the
/// rest and the caller gets the refusal.
pub(super) async fn still_on(state: &AppState, kind: CallKind) -> Result<(), Refused> {
    match switched_on(state, kind).await {
        Ok(()) => Ok(()),
        Err(refusal) => {
            end_switched_off(state).await;
            Err(Refused::AfterJoin(Box::new(refusal)))
        }
    }
}

pub(super) async fn voice_msg(
    state: &AppState,
    user: &str,
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
            let channel =
                ws_voice_channel(&crate::ws::LAYER, &state.read(), user, channel_id).await?;
            if channel.kind() != ChannelKind::Voice {
                return Err("Not a voice channel".into());
            }
            if channel.server().via() == crate::api::access::Via::Staff {
                return Err("Join this server to use voice".into());
            }
            let rights = channel.member_rights(&state.read()).await?;
            if !rights.view() {
                return Err("Channel not found".into());
            }
            if !rights.holds(held::CONNECT) {
                return Err(NO_CONNECT.into());
            }
            channel.timeout_gate(&state.db).await?;
            let server = channel.server().name().to_string();
            let ends = state
                .hub
                .voice_join_with(
                    user,
                    conn,
                    (&server, channel_id),
                    state.limits.voice_room_max,
                    Audio { muted, deafened },
                )
                .await?;
            for end in ends {
                finalize_call_log(state, end, false).await;
            }
            still_on(state, CallKind::Rtc).await?;
            if !rights.holds(held::SPEAK)
                || crate::api::access::timed_out(&state.db, &server, user)
                    .await?
                    .is_some()
            {
                state.hub.broadcast(WsEvent::VoiceMuted {
                    server: server.clone(),
                    channel_id,
                    username: user.to_string(),
                    muted: true,
                    staff: false,
                });
            }
            Ok(touch_interaction(&state.db, &server, user).await?)
        }
        ClientMsg::VoiceLeave => {
            state.hub.voice_leave(user).await;
            Ok(())
        }
        ClientMsg::VoiceAudio { muted, deafened } => {
            state.hub.voice_audio(user, conn, Audio { muted, deafened });
            Ok(())
        }
        ClientMsg::CallStart {
            attempt_id: _,
            dm_id,
            p2p,
            video,
            peer_id,
            relays,
        } => {
            let kind = match p2p {
                true => CallKind::P2p,
                false => CallKind::Rtc,
            };
            switched_on(state, kind).await?;
            let peer_id = call_peer_id(peer_id)?;
            let relays = match p2p {
                true => crate::p2p::relay_hosts(relays)?,
                false => Vec::new(),
            };
            if !state.hub.call_ok(user, dm_id) {
                return Err(CALLING_TOO_OFTEN.into());
            }
            let (a, b) = ws_dm_users(&crate::ws::LAYER, &state.read(), dm_id, user)
                .await?
                .ok_or_else(|| "DM not found".to_string())?;
            if a == b {
                return Err("Cannot call yourself".into());
            }
            let other = match a == user {
                true => &b,
                false => &a,
            };
            crate::api::blocks::check_dm(&state.db, user, other).await?;
            if let Some(busy) = state.hub.call_busy(user, other) {
                return Err(busy.into());
            }
            let dm_users = vec![a, b];
            let log_id = insert_call_log(state, dm_id, user, (kind, video)).await?;
            match state
                .hub
                .call_start_from(
                    user,
                    conn,
                    dm_id,
                    dm_users.clone(),
                    (kind, video),
                    log_id,
                    (peer_id, relays),
                )
                .await
            {
                Ok(()) => {
                    broadcast_call_log(state, dm_id, dm_users, log_id).await;
                    still_on(state, kind).await
                }
                Err(e) => {
                    let _ = sqlx::query("DELETE FROM messages WHERE id = $1")
                        .bind(log_id)
                        .execute(&state.db)
                        .await;
                    Err(e.into())
                }
            }
        }
        ClientMsg::CallAccept {
            attempt_id: _,
            dm_id,
            peer_id,
            relays,
        } => {
            let peer_id = call_peer_id(peer_id)?;
            if !state.hub.accept_ok(user) {
                return Err(TOO_FAST.into());
            }
            let (a, b) = ws_dm_users(&crate::ws::LAYER, &state.read(), dm_id, user)
                .await?
                .ok_or_else(|| "No incoming call".to_string())?;
            let ringing = state.hub.call_kind(dm_id);
            if let Some(kind) = ringing {
                switched_on(state, kind).await?;
            }
            let relays = match ringing {
                Some(CallKind::P2p) => crate::p2p::relay_hosts(relays)?,
                Some(CallKind::Rtc) | None => Vec::new(),
            };
            let other = match a == user {
                true => &b,
                false => &a,
            };
            crate::api::blocks::check_dm(&state.db, user, other).await?;
            let (log_id, dm_users) = state
                .hub
                .call_accept_from(user, conn, dm_id, (peer_id, relays))
                .await?;
            answer_call_log(state, dm_users, log_id).await;
            match ringing {
                Some(kind) => still_on(state, kind).await,
                None => Ok(()),
            }
        }
        ClientMsg::CallDecline { dm_id } => {
            let end = state.hub.call_end(user, dm_id).await?;
            finalize_call_log(state, end, true).await;
            Ok(())
        }
        ClientMsg::CallLeave { dm_id } => {
            let end = state.hub.call_end(user, dm_id).await?;
            finalize_call_log(state, end, false).await;
            Ok(())
        }
        ClientMsg::RtcSignal {
            to,
            channel_id,
            dm_id,
            payload,
        } => relay_signal(state, user, to, channel_id, dm_id, payload).await,
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

/// Passes an RTC signal from `user` to `to` when they share the voice room or the call.
pub(super) async fn relay_signal(
    state: &AppState,
    user: &str,
    to: String,
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    payload: serde_json::Value,
) -> Result<(), Refused> {
    let to = to.to_lowercase();
    let size = serde_json::to_string(&payload).map_or(usize::MAX, |p| p.len());
    if size > SIGNAL_MAX {
        return Err("Signal too large".into());
    }
    if !state.hub.signal_ok(user, size) {
        return Err(TOO_FAST.into());
    }
    if !state.hub.rtc_shared(user, &to, channel_id, dm_id) {
        return Err(Refused::NoSharedVoice);
    }
    if let Some(cid) = channel_id
        && shows_video(&payload)
        && let Some(server) = state.hub.room_server(cid)
    {
        if crate::api::access::timed_out(&state.db, &server, user)
            .await?
            .is_some()
        {
            return Err(crate::api::access::timed_out_error().into());
        }
        if !ws_voice_rights(&crate::ws::LAYER, &state.read(), &server, cid, user)
            .await
            .holds(held::VIDEO)
        {
            return Err(NO_VIDEO.into());
        }
    }
    if dm_id.is_some() {
        crate::api::blocks::check_dm(&state.db, user, &to).await?;
    }
    state.hub.broadcast(WsEvent::RtcSignal {
        to,
        from: user.to_string(),
        channel_id,
        dm_id,
        payload,
    });
    Ok(())
}

/// Whether an RTC signal turns on (or announces) a camera or a screen share.
fn shows_video(payload: &serde_json::Value) -> bool {
    ["cam", "screen"]
        .iter()
        .any(|k| payload.get(k).and_then(serde_json::Value::as_bool) == Some(true))
}

pub(super) fn call_peer_id(peer_id: Option<String>) -> Result<Option<String>, String> {
    match peer_id {
        Some(id) if !crate::p2p::valid_peer_id(&id) => Err("Invalid peer id".to_string()),
        other => Ok(other),
    }
}

pub(super) async fn send_voice_snapshot(state: &AppState, out: &Out, access: &mut Access) -> bool {
    let snapshot = state.hub.voice_snapshot_for(
        access.member_servers.iter().chain(access.subs.iter()),
        access.user.as_deref(),
    );
    for ev in snapshot {
        if !access.wants(&ev) {
            continue;
        }
        if let Some((server, cid)) = event_channel(&ev) {
            match channel_gate(state, access, server, cid).await {
                Some(true) => {}
                Some(false) => continue,
                None => return false,
            }
        }
        if !sent(access, out.event(&ev)) {
            return false;
        }
        if let WsEvent::VoiceState {
            server,
            channel_id,
            users,
            audio: _,
        } = &ev
            && !users.is_empty()
        {
            let muted =
                ws_voice_silenced(&crate::ws::LAYER, &state.read(), server, *channel_id, users)
                    .await
                    .unwrap_or_default();
            for username in users.iter().filter(|u| muted.contains(*u)) {
                let ev = WsEvent::VoiceMuted {
                    server: server.clone(),
                    channel_id: *channel_id,
                    username: username.clone(),
                    muted: true,
                    staff: false,
                };
                if !sent(access, out.event(&ev)) {
                    return false;
                }
            }
        }
    }
    true
}

/// What `msg` says about the sender's own audio: `voice_audio` does, and so does a join.
fn stated_audio(msg: &ClientMsg) -> Option<Audio> {
    match msg {
        ClientMsg::VoiceJoin {
            channel_id: _,
            muted,
            deafened,
        }
        | ClientMsg::VoiceAudio { muted, deafened } => Some(Audio {
            muted: *muted,
            deafened: *deafened,
        }),
        _ => None,
    }
}

/// A voice frame of a connection about to run. A join or a leave carries the audio state that
/// matters, so a change still waiting for the pace (`audio`) goes; what the frame states is
/// kept in `stated`, to say again when the realtime state was rebuilt.
pub(super) fn noted_voice(msg: &ClientMsg, audio: &mut VoiceWait, stated: &mut Option<Audio>) {
    match msg {
        ClientMsg::VoiceJoin {
            channel_id: _,
            muted: _,
            deafened: _,
        } => audio.clear(),
        ClientMsg::VoiceLeave => {
            audio.clear();
            *stated = None;
            return;
        }
        _ => {}
    }
    if let Some(said) = stated_audio(msg) {
        *stated = Some(said);
    }
}

pub(super) async fn voice_cmd(
    state: &AppState,
    access: &Access,
    conn: u64,
    msg: ClientMsg,
) -> Result<(), Refused> {
    let audio = matches!(
        msg,
        ClientMsg::VoiceAudio {
            muted: _,
            deafened: _
        }
    );
    // A connection without a voice name holds no seat to say anything about.
    if audio && access.voice_name().is_none() {
        return Ok(());
    }
    // Leaving, and what a seat says about its own audio, need no access read again.
    let held = audio
        || matches!(
            msg,
            ClientMsg::VoiceLeave
                | ClientMsg::CallLeave { dm_id: _ }
                | ClientMsg::CallDecline { dm_id: _ }
        );
    match (&access.user, &access.guest, access.retry.pending() && !held) {
        (Some(_), _, true) | (None, Some(_), true) => Err(RECONNECTING.into()),
        (Some(user), _, false) => voice_msg(state, user, conn, msg).await,
        (None, Some(name), false) => guest_voice(state, access, name, conn, msg).await,
        (None, None, _) => Err(ACCOUNT_FOR_VOICE.into()),
    }
}

// A connection's `voice_join` / `voice_leave` (or, on a wait of its own, `voice_audio`) past its
// user's pace: the latest waits and runs once the pace allows, and replaces any earlier one still
// waiting. It tries again every `every`.
pub(super) struct VoiceWait {
    pub(super) wanted: Option<ClientMsg>,
    pub(super) due: Option<Instant>,
    every: Duration,
}

impl Default for VoiceWait {
    fn default() -> VoiceWait {
        VoiceWait::every(VOICE_EVERY)
    }
}

impl VoiceWait {
    pub(super) fn every(every: Duration) -> VoiceWait {
        VoiceWait {
            wanted: None,
            due: None,
            every,
        }
    }

    pub(super) fn offer(
        &mut self,
        msg: ClientMsg,
        ok: impl FnOnce() -> bool,
        now: Instant,
    ) -> Option<ClientMsg> {
        if self.wanted.is_none() && ok() {
            return Some(msg);
        }
        self.wanted = Some(msg);
        self.due.get_or_insert(now + self.every);
        None
    }

    // Drops what is waiting: a join or leave carries the state that matters now.
    pub(super) fn clear(&mut self) {
        self.wanted = None;
        self.due = None;
    }

    pub(super) fn fire(&mut self, ok: impl FnOnce() -> bool, now: Instant) -> Option<ClientMsg> {
        if self.wanted.is_some() && !ok() {
            self.due = Some(now + self.every);
            return None;
        }
        self.due = None;
        self.wanted.take()
    }
}
