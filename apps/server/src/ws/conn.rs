use std::collections::{HashMap, HashSet};

use axum::Extension;
use axum::extract::State;
use axum::extract::ws::{Message as Frame, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::http::{Extensions, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{debug, warn};

use super::access::{
    ADDR_FULL, Access, COPY_FULL, Pace, SocketAccount, catch_up, grant_deadlines, reauthorize,
    socket_account,
};
use super::calls::{VoiceWait, finalize_call_log, noted_voice, send_voice_snapshot, voice_cmd};
use super::event::WsEvent;
use super::filter::on_event;
use super::guests::{guest_name, leave_closed_voice};
use super::p2p::{
    RECONNECTING, announce_drop, answer_who, hosting_ids, hosting_relays, p2p_refused, p2p_release,
};
use super::protocol::{
    CLOSE_NO_AUTH, CLOSE_PASSWORD_CHANGE, CLOSE_TOO_MANY, CLOSE_TOO_MANY_ADDR,
    CLOSE_TOO_MANY_GUESTS, CLOSE_TOO_OFTEN, ClientMsg, close_frame, first_frame, refuse,
};
use super::rewrite::{channel_for, event_frame, layout_for, own_timeout, presence_snapshot};
use super::typing::{Typer, type_in};
use super::{
    FRAME_MAX, LAG_REAUTH_EVERY, MSG_BURST, MSG_RATE, PING_EVERY, SILENT_LIMIT, authed_sub_ok,
    guest_sub_ok,
};

use crate::api::Settings;
use crate::api::access::{
    presence_mode, ws_banned, ws_is_member, ws_live_hosted, ws_member_servers,
};
use crate::db::setting_on;
use crate::fanout::Topic;
use crate::hub::{AUDIO_EVERY, AddrSlot, Hub, SlotRefused};
use crate::limits::bucket::{Policy, Single};
use crate::server::client_ip::ClientIp;
use crate::state::AppState;

/// Open the realtime WebSocket
///
/// Upgrades to a WebSocket carrying JSON text frames, each an object tagged by `type` in
/// snake_case. The first frame must be `{"type": "auth", "token": "<token>"}`; leave out
/// `token` (or send an unknown one) to connect as a guest, which only works while guest access
/// is on, otherwise the socket closes. Any other first frame also connects as a guest.
///
/// A signed-in user is online in every server they are a member of while any of their
/// connections is open, unless they appear offline. They go offline about 10 seconds after
/// their last connection closes, so a quick reconnect shows nothing. Switching to appear
/// offline hides them at once; coming back online is allowed a few times in a row, then
/// about once per 10 seconds (the last setting wins). An account keeps at most 20
/// connections open by default: opening another closes the oldest with code 4008. Opening
/// them too often closes the new one with code 4029 (try again later). Then the client sends
/// `viewing` (the open
/// server, for its `presence_snapshot` and `presence_changed` events), `subscribe` (servers to
/// follow, with guest grants for password-protected ones), `voice_join` (optional `muted` and
/// `deafened`: what the joiner says about its own mic and sound) / `voice_leave`, `voice_audio`
/// (`{muted, deafened}` for the voice seat the connection holds, ignored without one; paced per
/// account, a few per second, the latest waits and wins), `call_start` (with `p2p` and `video` flags) / `call_accept` / `call_decline` / `call_leave`
/// for DM calls, `rtc_signal` for
/// WebRTC signalling, and `p2p_hosting` / `p2p_who` / `p2p_peer` for P2P files (`p2p_peer`
/// gives a reader of one message the hoster's peer id and a short-lived download token; `p2p_who`
/// never carries peer ids). `call_start` / `call_accept` for P2P calls and `p2p_hosting` (per
/// file id) may declare `relays`: up to 4 relay hosts (no port, no credentials) the sender's
/// side connects through; only the other side of that call or download gets them, in
/// `call_state.relays` and `p2p_peer.relays`. `typing` / `typing_stop` with a `scope` (`c{channel}`,
/// `t{root}` or `d{dm}`) show or clear a typing indicator where the sender may send messages
/// (others are ignored silently); the client repeats `typing` every few seconds while typing.
/// Others there get `typing` (`{scope, username, display_name, until}`, `until` in unix
/// seconds, 0 when stopped), routed like messages and never to the typer's own connections.
/// Guests are read-only: no presence, typing or calls. A guest connection first gets
/// `guest_name` (`{name}`): its name in voice rooms, `@guest:` and 16 hex digits, new for each
/// connection. A guest may join the voice channels it can view in the servers it follows
/// (`subscribe`), say its `voice_audio` there and send `rtc_signal` to the others in its room. While the instance's `calls`
/// setting is off, `voice_join`, and `call_start` and `call_accept` for a call that is not
/// P2P, get an `error` frame with reason `off_site` and control `calls`, and running voice
/// rooms and calls end (`voice_ended` with `Calls were turned off`, `call_state` ended); P2P
/// calls follow `p2p` the same way. The server sends the events in `WsEvent` (`apps/server/src/ws/event.rs`),
/// for example `message`, `message_updated`, `message_deleted`, `member_joined`, `presence_changed`,
/// `voice_state` (in the snapshot a connection gets on opening or subscribing, `audio` lists
/// each user in the room not at the default with `{username, muted, deafened}`), `voice_audio`
/// (`{server, channel_id, username, muted, deafened}`, one change), `call_state` (with `kind` and `video`; an active P2P call also carries its id
/// and the peer id of both tabs), `p2p_hosted` (tells a `p2p_hosting` sender which of its files are still live
/// attachments, and the key it checks download tokens with), `p2p_peer`, `error` (`{message}`, plus the `reason` object of REST errors when the error has one) and `resync` (fetch state again after missed events). Frames
/// are at most 64 KiB. The token goes in the `auth` frame, not in the bearer security scheme.
/// General rate-limit bucket for the upgrade request.
#[utoipa::path(get, path = "/api/v1/ws", tag = "Realtime", responses((status = 101, description = "WebSocket upgrade"), (status = 429, description = "Too many requests in the general bucket, or too many open connections from this address", content((crate::api::ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "`Realtime is busy, try again in a moment` (JSON, reason `capacity`, control `ws_sockets_max`, `Retry-After: 5`): this copy holds `WS_SOCKETS_MAX` connections. Or `Realtime bus not ready` (plain text)", content((crate::api::ApiErrorBody = "application/json"), (String = "text/plain")))), security(()))]
pub async fn handler(
    axum::extract::Query(query): axum::extract::Query<SocketQuery>,
    State(state): State<AppState>,
    Extension(key): Extension<ClientIp>,
    extensions: Extensions,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !state.hub.ready() {
        return (StatusCode::SERVICE_UNAVAILABLE, "Realtime bus not ready").into_response();
    }
    // A request without a peer address counts as 0.0.0.0, like the rate limits.
    let addr = key
        .of(&extensions, &headers)
        .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    let slot = match state.hub.addr_slot(addr) {
        Ok(slot) => slot,
        Err(SlotRefused::Instance) => {
            if COPY_FULL.admit(Instant::now()) {
                warn!("refused a realtime connection: this copy holds WS_SOCKETS_MAX connections");
            }
            return crate::api::ApiError::capacity(
                StatusCode::SERVICE_UNAVAILABLE,
                REALTIME_BUSY,
                &rchat_settings::items::WS_SOCKETS_MAX,
                Some(BUSY_RETRY_SECS),
            )
            .into_response();
        }
        Err(SlotRefused::Address) => {
            match ADDR_FULL.admit(Instant::now()) {
                true => warn!(
                    "refused a realtime connection from an address with WS_SOCKETS_PER_IP connections open; raise it if many people share one address (carrier NAT, offices)"
                ),
                false => debug!("refused a realtime connection from an address with too many open"),
            }
            return (StatusCode::TOO_MANY_REQUESTS, CLOSE_TOO_MANY_ADDR.1).into_response();
        }
    };
    let limits = &state.limits;
    let ws = ws
        .max_message_size(FRAME_MAX)
        .max_frame_size(FRAME_MAX)
        .read_buffer_size(limits.ws_read_buffer_kib * 1024)
        .write_buffer_size(limits.ws_write_buffer_kib * 1024);
    let ws = match limits.ws_max_write_buffer_kib {
        0 => ws,
        kib => ws.max_write_buffer_size(kib * 1024),
    };
    ws.on_upgrade(move |socket| async move {
        match query.widget {
            Some(id) => super::widget_socket::run(state, id, socket, slot).await,
            None => run(state, socket, slot).await,
        }
    })
}

#[derive(serde::Deserialize)]
pub struct SocketQuery {
    widget: Option<String>,
}

pub(super) enum Sent {
    Queued,
    Full,
    Closed,
}

pub(super) struct Out {
    tx: mpsc::Sender<Frame>,
}

impl Out {
    /// A writer that holds `frames` frames (`WS_OUT_FRAMES`) and gives up on a socket that takes
    /// longer than `wait` (`WS_SEND_TIMEOUT_SECS`) to accept one.
    fn spawn(
        mut sink: SplitSink<WebSocket, Frame>,
        frames: usize,
        wait: std::time::Duration,
    ) -> Out {
        let (tx, mut rx) = mpsc::channel::<Frame>(frames.max(1));
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                match tokio::time::timeout(wait, sink.send(frame)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) | Err(_) => break,
                }
            }
            let _ = tokio::time::timeout(wait, sink.close()).await;
        });
        Out { tx }
    }

    fn push(&self, frame: Frame) -> Sent {
        match self.tx.try_send(frame) {
            Ok(()) => Sent::Queued,
            Err(mpsc::error::TrySendError::Full(_)) => Sent::Full,
            Err(mpsc::error::TrySendError::Closed(_)) => Sent::Closed,
        }
    }

    fn text(&self, text: Utf8Bytes) -> Sent {
        self.push(Frame::Text(text))
    }

    pub(super) fn event(&self, ev: &WsEvent) -> Sent {
        match serde_json::to_string(ev) {
            Ok(json) => self.text(json.into()),
            Err(_) => Sent::Queued,
        }
    }
}

pub(super) fn sent(access: &mut Access, res: Sent) -> bool {
    match res {
        Sent::Queued => true,
        Sent::Full => {
            access.missed = true;
            true
        }
        Sent::Closed => false,
    }
}

// A connection's client frames: `MSG_BURST` at once, then `MSG_RATE` a second.
pub(super) fn frame_bucket(now: Instant) -> Single {
    let policy = Policy::Tokens {
        burst: MSG_BURST,
        per_sec: MSG_RATE,
    };
    Single::new(policy, now)
}

/// The answer to an upgrade past `WS_SOCKETS_MAX`, with its `Retry-After`.
pub const REALTIME_BUSY: &str = "Realtime is busy, try again in a moment";
const BUSY_RETRY_SECS: u64 = 5;

// Whether a client frame is read, dropped (`Some(false)`), or ends a connection that kept
// sending past a second burst (`None`).
pub(super) fn admit_frame(frames: &mut Single, now: Instant) -> Option<bool> {
    match frames.spend(1.0, now) {
        left if left >= 0.0 => Some(true),
        left if left < -MSG_BURST => None,
        _ => Some(false),
    }
}

struct Listening {
    hub: Hub,
    conn: u64,
}

impl Drop for Listening {
    fn drop(&mut self) {
        self.hub.close(self.conn);
    }
}

async fn handle_voice(
    state: &AppState,
    access: &mut Access,
    conn: u64,
    out: &Out,
    msg: ClientMsg,
) -> bool {
    let request = msg.refusal_target();
    match voice_cmd(state, access, conn, msg).await {
        Ok(()) => true,
        Err(refused) => sent(access, out.event(&refused.frame(Some(request)))),
    }
}

async fn run(state: AppState, mut socket: WebSocket, mut slot: AddrSlot) {
    let conn = state.hub.next_conn();
    let token = match tokio::time::timeout(state.hub.auth_wait(), first_frame(&mut socket)).await {
        Ok(Some(token)) => token,
        Ok(None) => return,
        Err(_) => {
            debug!("closed a realtime connection that sent no auth frame in time");
            let _ = socket.send(close_frame(CLOSE_NO_AUTH)).await;
            return;
        }
    };
    let mut inbox = state.hub.open(conn, &HashSet::from([Topic::All]));
    let _listening = Listening {
        hub: state.hub.clone(),
        conn,
    };
    let mut epoch = state.hub.epoch();
    let mut lossy = epoch.borrow_and_update().lossy;
    let settings = Settings::cached(&state.read()).await;
    let account = match &token {
        Some(token) => match socket_account(&state.read(), &state.limits, token).await {
            Ok(account) => account,
            Err(e) => return refuse(e),
        },
        None => SocketAccount::Missing,
    };
    let (username, is_site_admin, since, password_expires) = match account {
        SocketAccount::Open {
            username,
            is_site_admin,
            since,
            password_expires,
        } => (Some(username), is_site_admin, Some(since), password_expires),
        SocketAccount::Missing => (None, false, None, None),
        SocketAccount::Restricted => {
            let _ = socket.send(close_frame(CLOSE_PASSWORD_CHANGE)).await;
            return;
        }
    };
    let mut mode = None;
    if let Some(user) = &username {
        if !state.hub.connect_ok(user) {
            debug!("closed a realtime connection of a user who reconnects too often");
            let _ = socket.send(close_frame(CLOSE_TOO_OFTEN)).await;
            return;
        }
        state.hub.listen(conn, &[Topic::User(user.clone())]);
        // Read once listening, from the primary: a change committed before this read is seen
        // here, a later one arrives as a `PresenceMode` event.
        mode = match presence_mode(&state.db, user).await {
            Ok(mode) => mode,
            Err(e) => return refuse(e),
        };
    }
    let member_servers: HashSet<String> = match &username {
        Some(user) => match ws_member_servers(&crate::ws::LAYER, &state.read(), user).await {
            Ok(servers) => servers,
            Err(e) => return refuse(e),
        },
        None => HashSet::new(),
    };
    if username.is_none() {
        match setting_on(&state.read(), "guests_enabled").await {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) => return refuse(e),
        }
        if !slot.guest() {
            debug!("closed a guest realtime connection past the guest caps");
            let full = match state.hub.guests_full() {
                true => CLOSE_TOO_MANY_GUESTS,
                false => CLOSE_TOO_MANY_ADDR,
            };
            let _ = socket.send(close_frame(full)).await;
            return;
        }
    }
    let mut access = Access::new(username, is_site_admin, member_servers);
    if access.user.is_none() {
        access.guest = Some(guest_name());
        access.addr = Some(slot.addr());
    }
    if let Some(mode) = mode {
        access.take_mode(mode);
    }
    access.since = since;
    access.password_expires = password_expires;
    access.reading = Some((settings.server_joining, settings.public_reading));
    access.member_lists = Some(settings.member_lists);
    access.password_change = Some(settings.password_change);
    access.token = token.filter(|_| access.user.is_some());
    access.note_closed(&state.read()).await;
    state.hub.reconcile(conn, &access.topics(), 0);
    let (sink, mut stream) = socket.split();
    let out = Out::spawn(
        sink,
        state.limits.ws_out_frames,
        state.limits.ws_send_timeout(),
    );
    let mut through = 0;
    let mut frames = frame_bucket(Instant::now());
    let mut typer = Typer::new();
    let mut voice = VoiceWait::default();
    let mut audio = VoiceWait::every(AUDIO_EVERY);
    let mut stated = None;
    let mut ping = tokio::time::interval_at(Instant::now() + PING_EVERY, PING_EVERY);
    let mut heard = Instant::now();
    let mut lag = Pace::new(LAG_REAUTH_EVERY);
    if let Some(name) = access.guest.clone()
        && !sent(&mut access, out.event(&WsEvent::GuestName { name }))
    {
        return;
    }
    if !send_voice_snapshot(&state, &out, &mut access).await {
        return;
    }
    access.sync(&state.hub, conn);
    loop {
        let until_expiry = access.password_expires.map(|at| {
            let epoch = std::time::Duration::from_millis(state.clock.unix_ms().max(0) as u64);
            std::time::Duration::from_secs(at.max(0) as u64).saturating_sub(epoch)
        });
        if until_expiry == Some(std::time::Duration::ZERO) {
            match access.token_live(&state.db, &state.limits).await {
                Ok(true) => continue,
                Ok(false) | Err(_) => break,
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(until_expiry.unwrap_or_default()), if until_expiry.is_some() => continue,
            got = inbox.rx.recv() => {
                let Some(fanned) = got else {
                    break;
                };
                if lag.due.is_some() {
                    through = inbox.drain().unwrap_or(fanned.seq).max(fanned.seq);
                } else if inbox.lagged() {
                    let (seen, open) = catch_up(&state, conn, &mut access, &mut inbox, &mut lag, fanned.seq).await;
                    through = seen;
                    if !open {
                        break;
                    }
                } else {
                    through = fanned.seq;
                    let ev = &fanned.ev;
                    let Some(deliver) = on_event(&state, conn, &mut access, ev).await else {
                        break;
                    };
                    if deliver && matches!(ev, WsEvent::LayoutChanged { .. }) {
                        let Some(mine) = layout_for(&state, &mut access, ev).await else {
                            break;
                        };
                        if let Some(mine) = mine && !sent(&mut access, out.event(&mine)) {
                            break;
                        }
                    }
                    if deliver {
                        let Some(mine) = channel_for(&state, &mut access, &fanned).await else {
                            break;
                        };
                        if let Some(mine) = mine && !sent(&mut access, out.event(&mine)) {
                            break;
                        }
                    }
                    if deliver {
                        let Some(mine) = own_timeout(&state, &mut access, ev).await else {
                            break;
                        };
                        if let Some(mine) = mine && !sent(&mut access, out.event(&mine)) {
                            break;
                        }
                    }
                    if deliver
                        && let Some(frame) = event_frame(&state, &mut access, &fanned).await
                        && !sent(&mut access, out.text(frame))
                    {
                        break;
                    }
                    match ev {
                        WsEvent::Banned { username: banned } if Some(banned.as_str()) == access.user.as_deref() => break,
                        WsEvent::TokensRevoked { username: user } if Some(user.as_str()) == access.user.as_deref() && !access.check_token(&state.read(), &state.limits).await => break,
                        WsEvent::SettingsChanged { settings } if !access.settings_changed(&state, conn, settings).await => break,
                        WsEvent::PresenceMode { username: user, appear_offline, seq } if Some(user.as_str()) == access.user.as_deref() => {
                            access.set_hidden(&state.hub, conn, *appear_offline, *seq);
                        }
                        _ => access.sync(&state.hub, conn),
                    }
                }
            }
            msg = stream.next() => {
                heard = Instant::now();
                if matches!(msg, Some(Ok(Frame::Text(_)))) {
                    match admit_frame(&mut frames, heard) {
                        Some(true) => {}
                        Some(false) => continue,
                        None => {
                            debug!("closed a realtime connection that kept flooding messages");
                            break;
                        }
                    }
                }
                match msg {
                    Some(Ok(Frame::Text(text))) => match serde_json::from_str::<ClientMsg>(&text) {
                        Ok(ClientMsg::Viewing { server }) => {
                            let seen = look(&state, conn, &mut access, server).await;
                            if let Some(ev) = seen.and_then(|s| presence_snapshot(&state.hub, &access, &s)) && !sent(&mut access, out.event(&ev)) {
                                break;
                            }
                        }
                        Ok(ClientMsg::Subscribe { servers, grants }) => {
                            access.sub.want(servers, grants);
                            if !try_subscribe(&state, conn, &mut access, &out).await {
                                break;
                            }
                        }
                        Ok(ClientMsg::P2pHosting { peer_id, ids, relays, relay_sets }) => {
                            let (ids, relays) = hosting_relays(hosting_ids(ids), relays, relay_sets);
                            if let Some(user) = access.user.clone() && crate::p2p::valid_peer_id(&peer_id) {
                                let (live, checked) = match ws_live_hosted(&crate::ws::LAYER, &state.read(), &user, &ids).await {
                                    Some(live) => (live, ids.clone()),
                                    None => (Vec::new(), Vec::new()),
                                };
                                let key = hex::encode(crate::p2p::host_key(&state.instance.p2p_secret, &user, &peer_id));
                                access.host(&state, conn, (peer_id.clone(), ids, relays)).await;
                                let hosted = WsEvent::P2pHosted { live, checked, key, peer_id, now: state.clock.unix() };
                                if !sent(&mut access, out.event(&hosted)) {
                                    break;
                                }
                            }
                        }
                        Ok(ClientMsg::P2pPeer { message_id, peer_id }) => {
                            let ev = match access.retry.pending() {
                                true => p2p_refused(message_id, RECONNECTING),
                                false => p2p_release(&state, &access, message_id, &peer_id).await,
                            };
                            if !sent(&mut access, out.event(&ev)) {
                                break;
                            }
                        }
                        Ok(ClientMsg::P2pWho { hosters: _ }) if access.retry.pending() => {}
                        Ok(ClientMsg::P2pWho { hosters }) => {
                            access.who.ask(hosters);
                            if access.who.pace.hit(Instant::now()) && !answer_who(&state, &mut access, &out).await {
                                break;
                            }
                        }
                        Ok(ClientMsg::Typing { scope }) => type_in(&state, &access, &mut typer, scope, true).await,
                        Ok(ClientMsg::TypingStop { scope }) => type_in(&state, &access, &mut typer, scope, false).await,
                        Ok(ClientMsg::Auth { token: _ }) | Err(_) => {}
                        Ok(other) => {
                            let now = Instant::now();
                            let ready = match (access.voice_name(), &other) {
                                (Some(me), ClientMsg::VoiceJoin { channel_id: _, muted: _, deafened: _ } | ClientMsg::VoiceLeave) =>
                                    voice.offer(other, || state.hub.voice_ok(me), now),
                                (Some(me), ClientMsg::VoiceAudio { muted: _, deafened: _ }) =>
                                    audio.offer(other, || state.hub.audio_ok(me), now),
                                (_, _) => Some(other),
                            };
                            if let Some(msg) = ready {
                                noted_voice(&msg, &mut audio, &mut stated);
                                if !handle_voice(&state, &mut access, conn, &out, msg).await {
                                    break;
                                }
                            }
                        }
                    },
                    Some(Ok(Frame::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            _ = ping.tick() => {
                if heard.elapsed() > SILENT_LIMIT || matches!(out.push(Frame::Ping(Default::default())), Sent::Closed) {
                    break;
                }
            }
            _ = tokio::time::sleep_until(access.retry.at.unwrap_or_else(Instant::now)), if access.retry.pending() => {
                if !access.refresh(&state, conn).await {
                    break;
                }
            }
            _ = tokio::time::sleep_until(access.who.pace.due.unwrap_or_else(Instant::now)), if access.who.pace.due.is_some() => {
                access.who.pace.fire(Instant::now());
                if !access.retry.pending() && !answer_who(&state, &mut access, &out).await {
                    break;
                }
            }
            _ = tokio::time::sleep_until(voice.due.unwrap_or_else(Instant::now)), if voice.due.is_some() => {
                let ready = match access.voice_name() {
                    Some(me) => voice.fire(|| state.hub.voice_ok(me), Instant::now()),
                    None => voice.wanted.take(),
                };
                if let Some(msg) = ready {
                    noted_voice(&msg, &mut audio, &mut stated);
                    if !handle_voice(&state, &mut access, conn, &out, msg).await {
                        break;
                    }
                }
            }
            _ = tokio::time::sleep_until(audio.due.unwrap_or_else(Instant::now)), if audio.due.is_some() => {
                let ready = match access.voice_name() {
                    Some(me) => audio.fire(|| state.hub.audio_ok(me), Instant::now()),
                    None => audio.wanted.take(),
                };
                if let Some(msg) = ready {
                    noted_voice(&msg, &mut audio, &mut stated);
                    if !handle_voice(&state, &mut access, conn, &out, msg).await {
                        break;
                    }
                }
            }
            _ = tokio::time::sleep_until(access.sub.due.unwrap_or_else(Instant::now)), if access.sub.due.is_some() => {
                if !try_subscribe(&state, conn, &mut access, &out).await {
                    break;
                }
            }
            _ = tokio::time::sleep_until(access.hosting_pace.due.unwrap_or_else(Instant::now)), if access.hosting_pace.due.is_some() => {
                access.hosting_pace.fire(Instant::now());
                access.announce_hosting(&state, conn).await;
            }
            _ = tokio::time::sleep_until(lag.due.unwrap_or_else(Instant::now)), if lag.due.is_some() => {
                lag.fire(Instant::now());
                access.missed = true;
                if !access.refresh(&state, conn).await {
                    break;
                }
            }
            Ok(()) = epoch.changed() => {
                access.note_epoch(&mut lossy, *epoch.borrow_and_update());
                let started = Instant::now();
                let res = reauthorize(&state, &mut access).await;
                if !access.settle(res, started) {
                    break;
                }
                access.announce(&state, conn).await;
                // The realtime state was rebuilt: the seat says its audio again.
                if let (Some(me), Some(said)) = (access.voice_name(), stated) {
                    state.hub.voice_audio(me, conn, said);
                }
            }
            _ = out.tx.closed() => break,
        }
        if access.roster_dirty {
            access.note_closed(&state.read()).await;
        }
        if std::mem::take(&mut access.topics_dirty) {
            access.layouts.retain(|server, _| {
                access.member_servers.contains(server) || access.subs.contains(server)
            });
            state.hub.reconcile(conn, &access.topics(), through);
        }
        if access.retry.pending() {
            continue;
        }
        if access.dark {
            access.announce(&state, conn).await;
        }
        if std::mem::take(&mut access.missed) {
            match out.event(&WsEvent::Resync) {
                Sent::Queued => {}
                Sent::Full => access.missed = true,
                Sent::Closed => break,
            }
        }
    }
    if access.restricted {
        out.push(close_frame(CLOSE_PASSWORD_CHANGE));
    } else if inbox.evicted() {
        out.push(close_frame(CLOSE_TOO_MANY));
    }
    drop(inbox);
    state.hub.close(conn);
    if let Some(user) = &access.user {
        if let Some(ev) = typer.stop(user) {
            state.hub.broadcast(ev);
        }
        let (ends, drop) = state.hub.drop_conn(user, conn).await;
        for end in ends {
            finalize_call_log(&state, end, false).await;
        }
        let cached = access.hosted_scope.take().map(|(_, scope)| scope);
        announce_drop(&state, user, drop, cached).await;
    }
    if let Some(name) = &access.guest
        && !state.hub.rooms_of(name).is_empty()
    {
        state.hub.voice_leave(name).await;
    }
}

// Whether `server` is subscribed already with `grant`, so needs no new check.
pub(super) fn sub_held(access: &Access, server: &str, grant: Option<&String>) -> bool {
    held_sub(
        &access.subs,
        &access.grants,
        access.user.is_some(),
        server,
        grant,
    )
}

fn held_sub(
    subs: &HashSet<String>,
    grants: &HashMap<String, String>,
    signed_in: bool,
    server: &str,
    grant: Option<&String>,
) -> bool {
    subs.contains(server) && (signed_in || grants.get(server) == grant)
}

async fn try_subscribe(state: &AppState, conn: u64, access: &mut Access, out: &Out) -> bool {
    let (subs, held, signed_in) = (&access.subs, &access.grants, access.user.is_some());
    let fresh = |servers: &[String], grants: &HashMap<String, String>| {
        servers
            .iter()
            .filter(|s| !held_sub(subs, held, signed_in, s, grants.get(*s)))
            .count()
    };
    let Some((servers, grants)) = access.sub.take(fresh, Instant::now()) else {
        return true;
    };
    subscribe(state, conn, access, servers, grants).await;
    send_voice_snapshot(state, out, access).await
}

// Replaces the subscriptions with `servers`, checking only those not held already.
pub(super) async fn subscribe(
    state: &AppState,
    conn: u64,
    access: &mut Access,
    servers: Vec<String>,
    grants: HashMap<String, String>,
) {
    let early: Vec<Topic> = servers
        .iter()
        .flat_map(|s| [Topic::Server(s.clone()), Topic::View(s.clone())])
        .collect();
    state.hub.listen(conn, &early);
    let peek = access.peek.take();
    let held: HashSet<String> = servers
        .iter()
        .filter(|s| sub_held(access, s, grants.get(*s)))
        .cloned()
        .collect();
    let old_grants = std::mem::take(&mut access.grants);
    let mut deadlines = std::mem::take(&mut access.deadlines);
    access.subs.clear();
    access.topics_dirty = true;
    let mut fresh = HashMap::new();
    for s in servers {
        let grant = grants.get(&s).cloned();
        let allowed = held.contains(&s)
            || match &access.user {
                Some(user) => authed_sub_ok(&state.read(), &s, user, access.site_admin)
                    .await
                    .unwrap_or(false),
                None => guest_sub_ok(&state.read(), &s, grant.as_deref(), &state.limits)
                    .await
                    .unwrap_or(false),
            };
        if allowed {
            if let Some(g) = grant {
                if !held.contains(&s) || old_grants.get(&s) != Some(&g) {
                    fresh.insert(s.clone(), g.clone());
                }
                access.grants.insert(s.clone(), g);
            }
            access.subs.insert(s);
        }
    }
    deadlines.retain(|s, _| access.grants.contains_key(s) && !fresh.contains_key(s));
    match grant_deadlines(&state.read(), &fresh).await {
        Ok(found) => deadlines.extend(found),
        Err(_) => deadlines.extend(fresh.into_keys().map(|s| (s, 0))),
    }
    access.deadlines = deadlines;
    access.set_peek(peek);
    access.note_closed(&state.read()).await;
    leave_closed_voice(&state.hub, access);
}

pub(super) async fn look(
    state: &AppState,
    conn: u64,
    access: &mut Access,
    server: Option<String>,
) -> Option<String> {
    let server = server.map(|s| s.to_lowercase());
    access.looking = server.clone().filter(|_| access.user.is_some());
    let (target, peek, seen) = match (access.user.clone(), server) {
        (Some(user), Some(s))
            if !ws_banned(&crate::ws::LAYER, &state.read(), &s, &user)
                .await
                .unwrap_or(true) =>
        {
            state
                .hub
                .listen(conn, &[Topic::View(s.clone()), Topic::Server(s.clone())]);
            let member = ws_is_member(&crate::ws::LAYER, &state.read(), &s, &user)
                .await
                .unwrap_or(false);
            let open = !member
                && !access.retry.pending()
                && authed_sub_ok(&state.read(), &s, &user, access.site_admin)
                    .await
                    .unwrap_or(false);
            (member.then(|| s.clone()), open.then(|| s.clone()), Some(s))
        }
        (_, _) => (None, None, None),
    };
    access.set_peek(peek);
    access.note_closed(&state.read()).await;
    if let Some(s) = &seen {
        access.topics_dirty |= !access.held(s);
    }
    access.view(&state.hub, conn, target);
    seen
}

pub(super) fn join(access: &mut Access, server: String) {
    access.roster_dirty = true;
    access.moved.push(server.clone());
    access.member_servers.insert(server);
    access.hosted_scope = None;
    access.viewable.clear();
    access.floors.clear();
    access.who.forget();
    access.topics_dirty = true;
}

pub(super) fn forget_server(access: &mut Access, server: &str) {
    access.roster_dirty |= access.held(server);
    access.layouts.remove(server);
    access.viewable.retain(|_, (owner, _, _)| owner != server);
    access.floors.clear();
    access.who.forget();
}

pub(super) fn leave(access: &mut Access, server: &str) {
    access.roster_dirty = true;
    access.moved.push(server.to_string());
    access.member_servers.remove(server);
    access.hosted_scope = None;
    access.viewable.clear();
    access.floors.clear();
    access.who.forget();
    access.topics_dirty = true;
    if access.viewing.as_deref() == Some(server) {
        access.viewing = None;
    }
}
