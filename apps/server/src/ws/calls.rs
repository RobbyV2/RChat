use sqlx::Row;
use tokio::time::Instant;

use super::access::{Access, channel_gate};
use super::conn::{Out, sent};
use super::event::{Updated, WsEvent};
use super::filter::event_channel;
use super::p2p::{CALLING_TOO_OFTEN, RECONNECTING, TOO_FAST};
use super::protocol::ClientMsg;
use super::{CallKind, SIGNAL_MAX};

use crate::api::access::{ws_dm_users, ws_voice_channel};
use crate::api::messages::load_broadcast;
use crate::api::timeouts::running_timeouts;
use crate::db::{ChannelKind, now, touch_interaction};
use crate::hub::{CallEnd, VOICE_EVERY};
use crate::state::AppState;

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
    .bind(now())
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
    .bind(now())
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
    .bind(now())
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

pub(super) async fn voice_msg(
    state: &AppState,
    user: &str,
    conn: u64,
    msg: ClientMsg,
) -> Result<(), String> {
    let db_err = |e: sqlx::Error| e.to_string();
    match msg {
        ClientMsg::VoiceJoin { channel_id } => {
            let channel = ws_voice_channel(&state.read(), user, channel_id).await?;
            if channel.kind() != ChannelKind::Voice {
                return Err("Not a voice channel".to_string());
            }
            if channel.server().via() == crate::api::access::Via::Staff {
                return Err("Join this server to use voice".to_string());
            }
            if !channel
                .member_rights(&state.read())
                .await
                .map_err(|e| e.1)?
                .view
            {
                return Err("Channel not found".to_string());
            }
            channel.timeout_gate(&state.db).await.map_err(|e| e.1)?;
            let server = channel.server().name().to_string();
            let ends = state
                .hub
                .voice_join_capped(user, conn, &server, channel_id, state.limits.voice_room_max)
                .await?;
            for end in ends {
                finalize_call_log(state, end, false).await;
            }
            if crate::api::access::timed_out(&state.db, &server, user)
                .await
                .map_err(|e| e.1)?
                .is_some()
            {
                state.hub.broadcast(WsEvent::VoiceMuted {
                    server: server.clone(),
                    channel_id,
                    username: user.to_string(),
                    muted: true,
                });
            }
            touch_interaction(&state.db, &server, user)
                .await
                .map_err(db_err)
        }
        ClientMsg::VoiceLeave => {
            state.hub.voice_leave(user).await;
            Ok(())
        }
        ClientMsg::CallStart {
            dm_id,
            p2p,
            video,
            peer_id,
            relays,
        } => {
            let peer_id = call_peer_id(peer_id)?;
            let relays = match p2p {
                true => crate::p2p::relay_hosts(relays)?,
                false => Vec::new(),
            };
            if !state.hub.call_ok(user, dm_id) {
                return Err(CALLING_TOO_OFTEN.to_string());
            }
            let (a, b) = ws_dm_users(&state.read(), dm_id, user)
                .await
                .map_err(db_err)?
                .ok_or_else(|| "DM not found".to_string())?;
            if a == b {
                return Err("Cannot call yourself".to_string());
            }
            let other = match a == user {
                true => &b,
                false => &a,
            };
            crate::api::blocks::check_dm(&state.db, user, other)
                .await
                .map_err(|crate::api::ApiError(_, e)| e)?;
            let kind = match p2p {
                true => CallKind::P2p,
                false => CallKind::Rtc,
            };
            if let Some(busy) = state.hub.call_busy(user, other) {
                return Err(busy);
            }
            let dm_users = vec![a, b];
            let log_id = insert_call_log(state, dm_id, user, (kind, video))
                .await
                .map_err(db_err)?;
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
                    Ok(())
                }
                Err(e) => {
                    let _ = sqlx::query("DELETE FROM messages WHERE id = $1")
                        .bind(log_id)
                        .execute(&state.db)
                        .await;
                    Err(e)
                }
            }
        }
        ClientMsg::CallAccept {
            dm_id,
            peer_id,
            relays,
        } => {
            let peer_id = call_peer_id(peer_id)?;
            if !state.hub.accept_ok(user) {
                return Err(TOO_FAST.to_string());
            }
            let (a, b) = ws_dm_users(&state.read(), dm_id, user)
                .await
                .map_err(db_err)?
                .ok_or_else(|| "No incoming call".to_string())?;
            let relays = match state.hub.call_kind(dm_id) {
                Some(CallKind::P2p) => crate::p2p::relay_hosts(relays)?,
                Some(CallKind::Rtc) | None => Vec::new(),
            };
            crate::api::blocks::check_dm_write(&state.db, user, &[a, b])
                .await
                .map_err(|crate::api::ApiError(_, e)| e)?;
            let (log_id, dm_users) = state
                .hub
                .call_accept_from(user, conn, dm_id, (peer_id, relays))
                .await?;
            answer_call_log(state, dm_users, log_id).await;
            Ok(())
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
        } => {
            let to = to.to_lowercase();
            let size = serde_json::to_string(&payload).map_or(usize::MAX, |p| p.len());
            if size > SIGNAL_MAX {
                return Err("Signal too large".to_string());
            }
            if !state.hub.signal_ok(user, size) {
                return Err(TOO_FAST.to_string());
            }
            if let Some(cid) = channel_id
                && shows_video(&payload)
                && let Some(server) = state.hub.room_server(cid)
                && crate::api::access::timed_out(&state.db, &server, user)
                    .await
                    .map_err(|e| e.1)?
                    .is_some()
            {
                return Err(crate::api::access::TIMED_OUT.to_string());
            }
            if !state.hub.rtc_shared(user, &to, channel_id, dm_id) {
                return Err("No shared voice session".to_string());
            }
            if dm_id.is_some() {
                crate::api::blocks::check_dm(&state.db, user, &to)
                    .await
                    .map_err(|crate::api::ApiError(_, e)| e)?;
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
        } = &ev
            && !users.is_empty()
        {
            let muted = running_timeouts(&state.read(), server, users)
                .await
                .unwrap_or_default();
            for username in users.iter().filter(|u| muted.contains_key(*u)) {
                let ev = WsEvent::VoiceMuted {
                    server: server.clone(),
                    channel_id: *channel_id,
                    username: username.clone(),
                    muted: true,
                };
                if !sent(access, out.event(&ev)) {
                    return false;
                }
            }
        }
    }
    true
}

pub(super) async fn voice_cmd(
    state: &AppState,
    access: &Access,
    conn: u64,
    msg: ClientMsg,
) -> Result<(), String> {
    let leaving = matches!(
        msg,
        ClientMsg::VoiceLeave
            | ClientMsg::CallLeave { dm_id: _ }
            | ClientMsg::CallDecline { dm_id: _ }
    );
    match (&access.user, access.retry.pending() && !leaving) {
        (Some(_), true) => Err(RECONNECTING.to_string()),
        (Some(user), false) => voice_msg(state, user, conn, msg).await,
        (None, _) => Err("Create an account to join voice".to_string()),
    }
}

// A connection's `voice_join` / `voice_leave` past its user's pace: the latest waits and runs
// once the pace allows, and replaces any earlier one still waiting.
#[derive(Default)]
pub(super) struct VoiceWait {
    pub(super) wanted: Option<ClientMsg>,
    pub(super) due: Option<Instant>,
}

impl VoiceWait {
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
        self.due.get_or_insert(now + VOICE_EVERY);
        None
    }

    pub(super) fn fire(&mut self, ok: impl FnOnce() -> bool, now: Instant) -> Option<ClientMsg> {
        if self.wanted.is_some() && !ok() {
            self.due = Some(now + VOICE_EVERY);
            return None;
        }
        self.due = None;
        self.wanted.take()
    }
}
