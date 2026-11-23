use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use axum::extract::ws::{Message as Frame, WebSocket};
use serde::Deserialize;
use serde_json::json;
use tokio::time::Instant;

use super::WsEvent;
use super::access::Access;
use super::calls::{finalize_call_log, voice_cmd};
use super::conn::{admit_frame, frame_bucket};
use super::filter::event_channel;
use super::guests::guest_name;
use super::protocol::{ClientMsg, Refused};
use crate::api::access::{Proof, not_found};
use crate::api::budget::Shares;
use crate::api::widgets::{Room, room};
use crate::api::{ApiError, user_for_token};
use crate::db::{User, pool_key};
use crate::fanout::Topic;
use crate::hub::AddrSlot;
use crate::state::AppState;

static VIEWERS: LazyLock<Shares> = LazyLock::new(Shares::default);

#[derive(Deserialize)]
struct Hello {
    ticket: String,
    parent: String,
    token: Option<String>,
    grant: Option<String>,
}

impl Hello {
    async fn viewer(&self, state: &AppState) -> Result<Option<User>, ApiError> {
        match &self.token {
            Some(t) => Ok(Some(user_for_token(state, t).await?.ok_or_else(not_found)?)),
            None => Ok(None),
        }
    }
    async fn room(&self, state: &AppState, id: &str) -> Result<Room, ApiError> {
        let user = self.viewer(state).await?;
        room(
            state,
            id,
            &self.ticket,
            &self.parent,
            user.as_ref(),
            &Proof::grants(self.grant.iter().cloned().collect(), &state.limits),
        )
        .await
    }
}

async fn send(socket: &mut WebSocket, value: impl serde::Serialize, wait: Duration) -> bool {
    let Ok(text) = serde_json::to_string(&value) else {
        return false;
    };
    matches!(
        tokio::time::timeout(wait, socket.send(Frame::Text(text.into()))).await,
        Ok(Ok(()))
    )
}

/// The longest a seat goes without reading its room again.
const RECHECK_EVERY: Duration = Duration::from_secs(30);
/// The shortest time between two reads of the room, and between two refresh notices.
const SETTLE: Duration = Duration::from_secs(1);

struct Seat<'a> {
    state: &'a AppState,
    hello: &'a Hello,
    id: &'a str,
    name: &'a str,
    server: &'a str,
    channel: i64,
    conn: u64,
    active: bool,
    allowed: bool,
    roster: bool,
    checked: Instant,
    refreshed: Instant,
    recheck_at: Option<Instant>,
    refresh_at: Option<Instant>,
}

impl Seat<'_> {
    fn owns(&self) -> bool {
        self.state
            .hub
            .owns_voice(self.name, self.channel, self.conn)
    }

    /// Re-read configuration, credentials and access.
    async fn recheck(&mut self) -> Option<bool> {
        self.checked = Instant::now();
        self.recheck_at = None;
        let room = self.hello.room(self.state, self.id).await.ok()?;
        if self.active && (!room.may_stay || !self.owns()) {
            return None;
        }
        self.roster = room.channel.shows_membership_notices();
        Some(std::mem::replace(&mut self.allowed, room.participate) != room.participate)
    }

    /// Whether an event can change whether or how this seat may use its room.
    fn policy(&self, ev: &WsEvent) -> bool {
        let me = |name: &str| name == self.name;
        let ours = |server: &str| server == self.server;
        match ev {
            WsEvent::SettingsChanged { .. } => true,
            WsEvent::TokensRevoked { username } | WsEvent::Banned { username } => me(username),
            WsEvent::ChannelPermsChanged { server, channel_id }
            | WsEvent::ChannelDeleted {
                server, channel_id, ..
            } => ours(server) && *channel_id == self.channel,
            WsEvent::ChannelUpdated { server, channel } => {
                ours(server) && channel.id == self.channel
            }
            WsEvent::ServerUpdated { server } => ours(&server.name),
            WsEvent::ServerDeleted { name } => ours(name),
            WsEvent::RolesChanged { server } => ours(server),
            WsEvent::MemberLeft { server, username }
            | WsEvent::MemberKicked {
                server, username, ..
            }
            | WsEvent::ServerBanned { server, username }
            | WsEvent::AdminChanged {
                server, username, ..
            }
            | WsEvent::MemberTimeout {
                server, username, ..
            } => ours(server) && me(username),
            WsEvent::MembersPurged { server, usernames } => {
                ours(server) && usernames.iter().any(|u| me(u))
            }
            _ => false,
        }
    }

    /// The next time this seat owes a read of its room or a refresh notice.
    fn due(&self) -> Option<Instant> {
        match (self.recheck_at, self.refresh_at) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn later_refresh(&mut self) {
        self.refresh_at
            .get_or_insert(Instant::now().max(self.refreshed + SETTLE));
    }

    async fn catch_up(&mut self, socket: &mut WebSocket) -> bool {
        let now = Instant::now();
        if self.recheck_at.is_some_and(|at| at <= now) {
            if self.recheck().await.is_none() {
                return false;
            }
            self.later_refresh();
        }
        let now = Instant::now();
        if self.refresh_at.is_some_and(|at| at <= now) {
            self.refresh_at = None;
            self.refreshed = now;
            return send(
                socket,
                json!({"type":"widget_refresh"}),
                self.state.limits.ws_send_timeout(),
            )
            .await;
        }
        true
    }

    async fn command(&mut self, access: &Access, socket: &mut WebSocket, text: &str) -> bool {
        let Ok(cmd) = serde_json::from_str::<ClientMsg>(text) else {
            return false;
        };
        let joining = match &cmd {
            ClientMsg::VoiceJoin { channel_id } if *channel_id == self.channel => {
                if self.recheck().await.is_none() {
                    return false;
                }
                if self.active || !self.allowed || !self.state.hub.voice_ok(self.name) {
                    return false;
                }
                true
            }
            ClientMsg::RtcSignal {
                channel_id: Some(id),
                dm_id: None,
                ..
            } if *id == self.channel && self.active && self.owns() => false,
            _ => return false,
        };
        if let Err(e) = voice_cmd(self.state, access, self.conn, cmd).await {
            // Negotiation or a mute update can reach us after its recipient leaves.
            if !joining && matches!(e, Refused::NoSharedVoice) {
                return true;
            }
            send(socket, e.frame(None), self.state.limits.ws_send_timeout()).await;
            return false;
        }
        self.active |= joining;
        true
    }

    async fn event(&mut self, socket: &mut WebSocket, ev: &WsEvent) -> bool {
        let here = event_channel(ev).is_some_and(|(s, c)| s == self.server && c == self.channel);
        let ended = matches!(
            ev,
            WsEvent::VoiceEnded { channel_id: Some(id), dm_users, .. }
                if *id == self.channel
                    && dm_users.as_ref().is_none_or(|users| users.iter().any(|u| u == self.name))
        );
        let renamed =
            matches!(ev, WsEvent::ServerRenamed { old_name, .. } if old_name == self.server);
        if ended && self.active || renamed {
            return false;
        }
        if self.policy(ev) {
            self.recheck_at
                .get_or_insert(Instant::now().max(self.checked + SETTLE));
            return true;
        }
        match ev {
            WsEvent::RtcSignal {
                from,
                to,
                channel_id: Some(id),
                dm_id: None,
                ..
            } if to == self.name && *id == self.channel => {
                if !self.active
                    || !self
                        .state
                        .hub
                        .rtc_shared(self.name, from, Some(self.channel), None)
                {
                    return true;
                }
                send(socket, ev, self.state.limits.ws_send_timeout()).await
            }
            WsEvent::VoiceState { users, .. } if here && self.active => {
                if !self.owns() || !send(socket, ev, self.state.limits.ws_send_timeout()).await {
                    return false;
                }
                let Ok(timeouts) =
                    crate::api::timeouts::running_timeouts(&self.state.db, self.server, users)
                        .await
                else {
                    return false;
                };
                let muted: Vec<_> = users
                    .iter()
                    .filter(|u| self.state.hub.hushed(u, self.server) || timeouts.contains_key(*u))
                    .collect();
                send(
                    socket,
                    json!({"type":"widget_mutes","users":muted}),
                    self.state.limits.ws_send_timeout(),
                )
                .await
            }
            WsEvent::VoiceMuted { .. } if here && self.active => {
                self.owns() && send(socket, ev, self.state.limits.ws_send_timeout()).await
            }
            WsEvent::VoiceState { .. } if here => {
                !self.roster || send(socket, ev, self.state.limits.ws_send_timeout()).await
            }
            WsEvent::VoiceMuted { .. } | WsEvent::Typing { .. } => true,
            _ => {
                if here {
                    self.later_refresh();
                }
                true
            }
        }
    }
}

pub(super) async fn run(state: AppState, id: String, mut socket: WebSocket, mut slot: AddrSlot) {
    let Ok(Some(Ok(Frame::Text(first)))) =
        tokio::time::timeout(state.hub.auth_wait(), socket.recv()).await
    else {
        return;
    };
    let Ok(hello) = serde_json::from_str::<Hello>(&first) else {
        return;
    };
    let Ok(initial) = hello.room(&state, &id).await else {
        return;
    };
    let Ok(user) = hello.viewer(&state).await else {
        return;
    };
    let guest = user.is_none();
    let cap = state.limits.widget_viewers_max;
    let _viewer = if cap == 0 {
        None
    } else {
        let Some(share) = VIEWERS.take(&format!("{}:{id}", pool_key(&state.db)), 1, u64::from(cap))
        else {
            return;
        };
        Some(share)
    };
    if guest && !slot.guest() {
        return;
    }
    let name = user
        .as_ref()
        .map(|u| u.username.clone())
        .unwrap_or_else(guest_name);
    if !guest && !state.hub.connect_ok(&name) {
        return;
    }
    let server = initial.widget.server;
    let channel = initial.channel.id();
    let conn = state.hub.next_conn();
    let mut access = Access::new(user.map(|u| u.username), false, HashSet::new());
    access.subs.insert(server.clone());
    if let Some(grant) = &hello.grant {
        access.grants.insert(server.clone(), grant.clone());
    }
    if guest {
        access.guest = Some(name.clone());
        access.addr = Some(slot.addr());
    }
    let mut inbox = state.hub.open(
        conn,
        &HashSet::from([
            Topic::Server(server.clone()),
            Topic::User(name.clone()),
            Topic::All,
        ]),
    );
    let mut seat = Seat {
        state: &state,
        hello: &hello,
        id: &id,
        name: &name,
        server: &server,
        channel,
        conn,
        active: false,
        allowed: initial.participate,
        roster: initial.channel.shows_membership_notices(),
        checked: Instant::now(),
        refreshed: Instant::now(),
        recheck_at: None,
        refresh_at: None,
    };
    let mut frames = frame_bucket(Instant::now());
    let mut check = tokio::time::interval_at(Instant::now() + RECHECK_EVERY, RECHECK_EVERY);
    check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut heard = Instant::now();
    if send(
        &mut socket,
        json!({"type":"widget_ready","name":name}),
        state.limits.ws_send_timeout(),
    )
    .await
    {
        loop {
            tokio::select! {
                frame = socket.recv() => {
                    heard = Instant::now();
                    match frame {
                        Some(Ok(Frame::Text(text))) => {
                            if admit_frame(&mut frames, heard) != Some(true) || !seat.command(&access, &mut socket, &text).await { break; }
                        }
                        Some(Ok(Frame::Pong(_) | Frame::Ping(_))) => {}
                        _ => break,
                    }
                }
                event = inbox.rx.recv() => {
                    let Some(event) = event else { break };
                    if inbox.lagged() || !seat.event(&mut socket, &event.ev).await { break; }
                }
                _ = tokio::time::sleep_until(seat.due().unwrap_or_else(Instant::now)), if seat.due().is_some() => {
                    if !seat.catch_up(&mut socket).await { break; }
                }
                _ = check.tick() => {
                    if heard.elapsed() > super::SILENT_LIMIT { break; }
                    let Some(changed) = seat.recheck().await else { break };
                    if changed {
                        seat.later_refresh();
                    }
                    let ping = socket.send(Frame::Ping(Default::default()));
                    if !matches!(tokio::time::timeout(state.limits.ws_send_timeout(), ping).await, Ok(Ok(()))) { break; }
                }
            }
        }
    }
    state.hub.close(conn);
    if seat.active {
        let (ends, _) = state.hub.drop_conn(&name, conn).await;
        for end in ends {
            finalize_call_log(&state, end, false).await;
        }
    }
}
