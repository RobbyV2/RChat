use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message as Frame, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{debug, warn};

use crate::api::access::{
    TypingPlace, ViewRules, servers_with_expired_passwords, typing_scope, ws_banned,
    ws_channel_read_since, ws_channel_view, ws_grant_deadline, ws_sees_timeouts, ws_server_open,
    ws_typing_place, ws_view_under, ws_voice_channel, ws_voice_viewable,
};
use crate::api::messages::{Quotes, load_broadcast, load_message};
use crate::api::pings::{Ping, ThreadPings};
use crate::api::timeouts::running_timeouts;
use crate::api::{
    Channel, ChannelLayout, Embed, LayoutCategory, Member, Message, ServerSummaryLite, Settings,
    UserRef,
};
use crate::db::{ChannelKind, Db, MediaKind, get_user, now, setting_on, touch_interaction};
use crate::fanout::Topic;
pub use crate::hub::Hub;
use crate::hub::{Aftermath, CallEnd, Epoch, Op, P2pDrop, PRESENCE_SERVERS_MAX, Purge, Scope};
use crate::state::AppState;

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
const FRAME_MAX: usize = 64 * 1024;
const SIGNAL_MAX: usize = 32 * 1024;
const OUT_FRAMES: usize = 256;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const MSG_RATE: f64 = 50.0;
const MSG_BURST: f64 = 200.0;
const VOICE_ROOM_MAX: usize = 25;
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

struct Gate {
    last: Option<Instant>,
    hidden: u64,
    flushing: bool,
}

struct LogGate {
    state: Mutex<Gate>,
    every: Duration,
    summary: fn(u64),
}

impl LogGate {
    const fn new(every: Duration, summary: fn(u64)) -> LogGate {
        LogGate {
            state: Mutex::new(Gate {
                last: None,
                hidden: 0,
                flushing: false,
            }),
            every,
            summary,
        }
    }

    fn gate(&self) -> std::sync::MutexGuard<'_, Gate> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn admit(&'static self, now: Instant) -> bool {
        let due = {
            let mut gate = self.gate();
            match gate.last {
                Some(at) if now.duration_since(at) < self.every => {
                    gate.hidden += 1;
                    if std::mem::replace(&mut gate.flushing, true) {
                        return false;
                    }
                    at + self.every
                }
                _ => {
                    gate.last = Some(now);
                    return true;
                }
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move {
                    tokio::time::sleep_until(due).await;
                    self.flush(Instant::now());
                });
            }
            Err(_) => self.gate().flushing = false,
        }
        false
    }

    fn flush(&self, now: Instant) {
        let hidden = {
            let mut gate = self.gate();
            gate.flushing = false;
            gate.last = Some(now);
            std::mem::take(&mut gate.hidden)
        };
        if hidden > 0 {
            (self.summary)(hidden);
        }
    }
}

static REAUTH_FAILED: LogGate = LogGate::new(LOG_EVERY, |n| {
    warn!(
        "re-authorizing realtime connections failed {n} more time(s) in the last {}s; their events are held back while they retry",
        LOG_EVERY.as_secs()
    )
});
static REAUTH_GAVE_UP: LogGate = LogGate::new(LOG_EVERY, |n| {
    warn!(
        "closed {n} more realtime connection(s) in the last {}s whose re-authorization kept failing",
        LOG_EVERY.as_secs()
    )
});
static AUTH_FAILED: LogGate = LogGate::new(LOG_EVERY, |n| {
    warn!(
        "refused {n} more realtime connection(s) in the last {}s because their account could not be loaded",
        LOG_EVERY.as_secs()
    )
});

thread_local! {
    static BUS_WIRE: Cell<bool> = const { Cell::new(false) };
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserScope {
    pub servers: Vec<String>,
    pub views: Vec<String>,
    pub users: Vec<String>,
}

impl UserScope {
    pub fn is_empty(&self) -> bool {
        let UserScope {
            servers,
            views,
            users,
        } = self;
        servers.is_empty() && views.is_empty() && users.is_empty()
    }
}

pub const USER_SCOPE_SERVERS: i64 = 500;
pub const USER_SCOPE_DMS: i64 = 250;
pub const USER_SCOPE_SMALL: i64 = 1000;

pub async fn user_scope(db: &Db, user: &str) -> UserScope {
    let mut scope = UserScope::default();
    if let Ok(rows) = sqlx::query(
        "SELECT m.server, s.member_count FROM members m JOIN servers s ON s.name = m.server WHERE m.username = $1 ORDER BY m.joined_at DESC LIMIT $2",
    )
    .bind(user)
    .bind(USER_SCOPE_SERVERS)
    .fetch_all(db)
    .await
    {
        for r in &rows {
            let (Ok(server), Ok(count)) = (r.try_get::<String, _>(0), r.try_get::<i64, _>(1)) else {
                continue;
            };
            match count <= USER_SCOPE_SMALL {
                true => scope.servers.push(server),
                false => scope.views.push(server),
            }
        }
    }
    for sql in [
        "SELECT user_b FROM dms WHERE user_a = $1 ORDER BY last_message_id DESC LIMIT $2",
        "SELECT user_a FROM dms WHERE user_b = $1 ORDER BY last_message_id DESC LIMIT $2",
    ] {
        if let Ok(rows) = sqlx::query(sql)
            .bind(user)
            .bind(USER_SCOPE_DMS)
            .fetch_all(db)
            .await
        {
            scope.users.extend(
                rows.iter()
                    .filter_map(|r| r.try_get::<String, _>(0).ok())
                    .filter(|u| u != user),
            );
        }
    }
    scope.users.push(user.to_string());
    scope.users.sort();
    scope.users.dedup();
    scope
}

fn routing_only<T>(_: &T) -> bool {
    !BUS_WIRE.with(Cell::get)
}

pub fn to_bus_json<T: Serialize>(value: &T) -> serde_json::Result<String> {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            BUS_WIRE.with(|w| w.set(self.0));
        }
    }
    let _restore = Restore(BUS_WIRE.with(|w| w.replace(true)));
    serde_json::to_string(value)
}

/// What a `message_updated` carries: the whole message (DMs, call logs), or for an edit in a
/// server channel only which message changed, so viewers without read history of it learn
/// nothing; clients holding it re-read it through the gated REST list.
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Updated {
    Stub(EditStub),
    Full { message: Box<Message> },
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EditStub {
    pub id: i64,
    pub thread_root_id: Option<i64>,
    pub edited_at: Option<i64>,
    pub stub: bool,
}

impl Updated {
    pub fn full(message: Message) -> Self {
        Updated::Full {
            message: Box::new(message),
        }
    }

    pub fn stub(id: i64, thread_root_id: Option<i64>, edited_at: Option<i64>) -> Self {
        Updated::Stub(EditStub {
            id,
            thread_root_id,
            edited_at,
            stub: true,
        })
    }

    pub fn id(&self) -> i64 {
        match self {
            Updated::Stub(EditStub {
                id,
                thread_root_id: _,
                edited_at: _,
                stub: _,
            }) => *id,
            Updated::Full { message } => message.id,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsEvent {
    Message {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message: Box<Message>,
    },
    MessageUpdated {
        #[serde(default)]
        server: Option<String>,
        #[serde(default)]
        channel_id: Option<i64>,
        #[serde(flatten)]
        update: Updated,
        #[serde(default, skip_serializing_if = "routing_only")]
        dm_users: Vec<String>,
    },
    MessageDeleted {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        id: i64,
        thread_root_id: Option<i64>,
    },
    MediaRemoved {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        removed_by_author: bool,
    },
    EmbedsResolved {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        embeds: Vec<Embed>,
    },
    EmbedsRemoved {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        ord: i64,
        banner: bool,
    },
    ReactionAdded {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        thread_root_id: Option<i64>,
        emoji: String,
        username: String,
        count: i64,
    },
    ReactionRemoved {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        thread_root_id: Option<i64>,
        emoji: String,
        username: String,
        count: i64,
    },
    PollUpdated {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        thread_root_id: Option<i64>,
        created_at: i64,
        poll: Box<crate::api::polls::Poll>,
    },
    MessagePinned {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        pinned_at: i64,
        pinned_by: String,
    },
    MessageUnpinned {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
    },
    ChannelCreated {
        server: String,
        channel: Channel,
    },
    ChannelRenamed {
        server: String,
        channel: Channel,
    },
    ChannelUpdated {
        server: String,
        channel: Channel,
    },
    ChannelDeleted {
        server: String,
        channel_id: i64,
        #[serde(default, skip_serializing_if = "routing_only")]
        rules: Option<ViewRules>,
    },
    ServerCreated {
        server: ServerSummaryLite,
    },
    ServerRenamed {
        old_name: String,
        server: ServerSummaryLite,
    },
    ServerUpdated {
        server: ServerSummaryLite,
    },
    ServerDeleted {
        name: String,
    },
    MemberJoined {
        server: String,
        member: Member,
    },
    MemberLeft {
        server: String,
        username: String,
    },
    MemberKicked {
        server: String,
        username: String,
        banned: bool,
    },
    MembersPurged {
        server: String,
        #[serde(default, skip_serializing_if = "routing_only")]
        usernames: Vec<String>,
    },
    AdminChanged {
        server: String,
        username: String,
        is_admin: bool,
        perms: i64,
    },
    RolesChanged {
        server: String,
    },
    ChannelPermsChanged {
        server: String,
        channel_id: i64,
    },
    LayoutChanged {
        server: String,
        layout: ChannelLayout,
        #[serde(default, skip_serializing_if = "routing_only")]
        created: Option<i64>,
        #[serde(default, skip_serializing_if = "routing_only")]
        deleted: Option<ViewRules>,
    },
    UserUpdated {
        user: UserRef,
        #[serde(default, skip_serializing_if = "routing_only")]
        scope: UserScope,
    },
    UserRegistered {
        user: UserRef,
    },
    PresenceChanged {
        server: String,
        username: String,
        online: bool,
        online_count: i64,
    },
    PresenceMode {
        username: String,
        appear_offline: bool,
        // `users.presence_seq` of this value: the newest one wins.
        #[serde(default, skip_serializing_if = "routing_only")]
        seq: i64,
    },
    PresenceSnapshot {
        server: String,
        online: Vec<String>,
        online_count: i64,
    },
    ServerBanned {
        server: String,
        username: String,
    },
    ReadUpdated {
        username: String,
        scope: String,
        last_read: i64,
        pings_until: i64,
    },
    Ping {
        username: String,
        ping: Ping,
    },
    PingCount {
        username: String,
        scope: String,
        pings: i64,
        pings_until: i64,
        thread_pings: Vec<ThreadPings>,
    },
    VoiceState {
        server: String,
        channel_id: i64,
        users: Vec<String>,
    },
    /// A user in a voice channel was muted there by a timeout, or the timeout ended. Apps stop
    /// sending and playing a muted user's audio.
    VoiceMuted {
        server: String,
        channel_id: i64,
        username: String,
        muted: bool,
    },
    /// A timeout of `username` in `server` started or changed (`until`, `remaining` seconds and
    /// the reason) or ended (`until` null). Only to that user and to members with the Timeout
    /// members permission; the user's own copy has no reason unless they hold it too.
    MemberTimeout {
        server: String,
        username: String,
        until: Option<i64>,
        remaining: i64,
        reason: Option<String>,
    },
    CallState {
        dm_id: i64,
        dm_users: Vec<String>,
        state: CallPhase,
        from: String,
        kind: CallKind,
        /// The caller started with video on.
        #[serde(default)]
        video: bool,
        /// Active P2P calls only: the call's id, which the caller puts in the PeerJS metadata.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        /// Active calls only: when the call was answered, in unix seconds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answered_at: Option<i64>,
        /// Active P2P calls only: the peer id of the caller's tab and of the tab that accepted.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        peers: Vec<CallPeer>,
    },
    P2pAvailability {
        hoster: String,
        peer_id: Option<String>,
        ids: Vec<String>,
        online: bool,
        #[serde(default, skip_serializing_if = "routing_only")]
        scope_servers: Vec<String>,
        #[serde(default, skip_serializing_if = "routing_only")]
        scope_users: Vec<String>,
    },
    RtcSignal {
        to: String,
        from: String,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        payload: serde_json::Value,
    },
    VoiceEnded {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        reason: String,
    },
    Error {
        message: String,
    },
    DmCreated {
        dm_id: i64,
        dm_users: Vec<String>,
    },
    /// `username` closed the DM; to that user's connections only.
    DmClosed {
        username: String,
        dm_id: i64,
    },
    /// The DM is back in `username`'s list; to that user's connections only.
    DmReopened {
        username: String,
        dm_id: i64,
    },
    /// `username` blocked a user; to that user's connections only.
    UserBlocked {
        username: String,
        blocked: crate::api::blocks::BlockedUser,
    },
    /// `username` unblocked `blocked`; to that user's connections only.
    UserUnblocked {
        username: String,
        blocked: String,
    },
    /// `username` voted in or took back their vote in poll `message_id`; to their own
    /// connections only, so their other tabs load the poll again.
    PollVoted {
        username: String,
        message_id: i64,
    },
    /// A friend request between `username` and `request.user` was sent or arrived; to
    /// `username`'s connections only.
    FriendRequestAdded {
        username: String,
        request: crate::api::friends::FriendRequest,
    },
    /// The friend request between `username` and `other` is gone (accepted, denied or
    /// cancelled); to `username`'s connections only.
    FriendRequestRemoved {
        username: String,
        other: String,
    },
    /// `friend.user` is now a friend of `username`; to `username`'s connections only.
    FriendAdded {
        username: String,
        friend: crate::api::friends::Friend,
    },
    /// `friend` is no longer a friend of `username`; to `username`'s connections only.
    FriendRemoved {
        username: String,
        friend: String,
    },
    /// `friend` (a friend of `username`) came online or went offline; to `username`'s
    /// connections only.
    FriendPresence {
        username: String,
        friend: String,
        online: bool,
    },
    /// `username` changed their privacy settings; to that user's connections only.
    PrivacyChanged {
        username: String,
        privacy: crate::api::friends::Privacy,
    },
    /// Internal, never delivered: `username` became visible on the site (`online`), or stopped
    /// being visible (after the offline grace, or at once when they appear offline). The hub's
    /// replica emits it on every instance (`Hub::take_shown`), and each instance tells the
    /// friends connected to it (`friend_presence`).
    UserShown {
        username: String,
        online: bool,
    },
    Banned {
        username: String,
    },
    SettingsChanged {
        settings: Settings,
    },
    TokensRevoked {
        username: String,
    },
    /// Answer to `p2p_hosting`, to that connection only: which of the `checked` ids are still
    /// live P2P attachments of the sender, so its app stops serving removed ones.
    P2pHosted {
        live: Vec<String>,
        checked: Vec<String>,
        /// Hex key the hoster checks download tokens with, valid for `peer_id`.
        key: String,
        peer_id: String,
        /// Server time in unix seconds, so the hoster can check token expiry on a skewed clock.
        now: i64,
    },
    /// Answer to `p2p_peer`, to that connection only: where to fetch the attachment of
    /// `message_id` and the token for it, or `error`.
    P2pPeer {
        message_id: i64,
        peer_id: Option<String>,
        token: Option<String>,
        expires_at: Option<i64>,
        error: Option<String>,
    },
    Resync,
    /// Someone is typing in `scope` (`c{channel}`, `t{root}` or `d{dm}`) until `until` (unix
    /// seconds), or stopped when `until` is 0. Never sent to the typer's own connections.
    Typing {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        scope: String,
        username: String,
        display_name: String,
        until: i64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallPeer {
    pub user: String,
    pub peer_id: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
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
    },
    P2pHosting {
        peer_id: String,
        ids: Vec<String>,
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

pub(crate) async fn evict_unviewable(state: &AppState, server: &str, channel_id: Option<i64>) {
    for (cid, users) in state.hub.rooms_in(server, channel_id) {
        if let Ok(Some((owner, _))) = channel_now(&state.read(), cid).await
            && owner != server
        {
            continue;
        }
        for user in users {
            let open = ws_server_open(&state.read(), server, Some(&user), false, None)
                .await
                .unwrap_or(false);
            if !open || !ws_voice_viewable(&state.read(), server, cid, &user).await {
                state.hub.evict_voice(&user, cid);
            }
        }
    }
}

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

async fn finalize_call_log(state: &AppState, end: CallEnd, declined: bool) {
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

/// Asks the connections on servers whose extra passwords expired in `(since, until]` to
/// recheck their access, so guests let in through those passwords are cut even when idle.
pub async fn announce_expired_passwords(
    state: &AppState,
    since: i64,
    until: i64,
) -> sqlx::Result<()> {
    let db = &state.read();
    for name in servers_with_expired_passwords(db, since, until).await? {
        if let Some(server) = refresh_lite(db, &name).await? {
            state.hub.broadcast(WsEvent::ServerUpdated { server });
        }
    }
    Ok(())
}

pub async fn sweep_and_log(state: &AppState, idle: i64) {
    for end in state.hub.sweep_voice(idle).await {
        finalize_call_log(state, end, false).await;
    }
}

async fn announce_hosting(
    state: &AppState,
    user: &str,
    conn: u64,
    (peer_id, ids): (String, Vec<String>),
    scope: P2pScope,
) {
    state.hub.set_p2p(user, conn, peer_id.clone(), ids.clone());
    state.hub.broadcast(p2p_online(user, peer_id, ids, scope));
}

async fn announce_drop(state: &AppState, user: &str, drop: P2pDrop, cached: Option<P2pScope>) {
    let scope = async || match cached {
        Some(scope) => scope,
        None => p2p_scope(&state.read(), user).await,
    };
    match drop {
        P2pDrop::Kept => {}
        P2pDrop::Offline => {
            let (scope_servers, scope_users) = scope().await;
            state
                .hub
                .broadcast(p2p_offline(user.to_string(), scope_servers, scope_users));
        }
        P2pDrop::Remaining(peer_id, ids) => {
            let scope = scope().await;
            state.hub.broadcast(p2p_online(user, peer_id, ids, scope));
        }
    }
}

pub async fn settle(state: &AppState, purge: Purge) {
    let Purge { ends, p2p } = purge;
    for end in ends {
        finalize_call_log(state, end, false).await;
    }
    for (user, drop) in p2p {
        announce_drop(state, &user, drop, None).await;
    }
}

pub fn spawn_aftermath(state: &AppState) {
    if let Some(mut shown) = state.hub.take_shown() {
        let state = state.clone();
        tokio::spawn(async move {
            while let Some((user, online)) = shown.recv().await {
                crate::api::friends::tell_friends(&state, &user, online).await;
            }
        });
    }
    if let Some(mut rx) = state.hub.take_aftermath() {
        let state = state.clone();
        tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                match job {
                    Aftermath::Settle(purge) => settle(&state, purge).await,
                    Aftermath::Repost(ops) => {
                        for op in ops {
                            repost(&state, op).await;
                        }
                    }
                }
            }
        });
    }
}

async fn channel_now(db: &Db, id: i64) -> sqlx::Result<Option<(String, Channel)>> {
    let row =
        sqlx::query("SELECT server, name, kind, slowmode_seconds, restrict_view, restrict_send, topic, category_id, position FROM channels WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    match row {
        Some(r) => Ok(Some((
            r.try_get(0)?,
            Channel {
                id,
                name: r.try_get(1)?,
                kind: ChannelKind::parse(&r.try_get::<String, _>(2)?)?,
                slowmode_seconds: r.try_get(3)?,
                restrict_view: r.try_get::<i64, _>(4)? != 0,
                restrict_send: r.try_get::<i64, _>(5)? != 0,
                topic: r.try_get(6)?,
                category_id: r.try_get(7)?,
                position: r.try_get(8)?,
            },
        ))),
        None => Ok(None),
    }
}

const FLOOR_TTL: Duration = Duration::from_secs(30);

async fn admin_state(db: &Db, server: &str, user: &str) -> sqlx::Result<Option<(bool, i64)>> {
    let row =
        sqlx::query("SELECT is_admin, perms FROM members WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(user)
            .fetch_optional(db)
            .await?;
    match row {
        Some(r) => Ok(Some((r.try_get::<i64, _>(0)? != 0, r.try_get(1)?))),
        None => Ok(None),
    }
}

pub(crate) async fn current(state: &AppState, ev: WsEvent) -> Option<WsEvent> {
    let db = &state.read();
    match ev {
        WsEvent::Message {
            server,
            channel_id,
            dm_id,
            dm_users,
            message,
        } => {
            let message = load_broadcast(db, message.id).await.ok().flatten()?;
            Some(WsEvent::Message {
                server,
                channel_id,
                dm_id,
                dm_users,
                message: Box::new(message),
            })
        }
        WsEvent::MessageUpdated {
            server,
            channel_id,
            update,
            dm_users,
        } => {
            let message = load_broadcast(db, update.id()).await.ok().flatten()?;
            let update = match update {
                Updated::Stub(_) => {
                    Updated::stub(message.id, message.thread_root_id, message.edited_at)
                }
                Updated::Full { message: _ } => Updated::full(message),
            };
            Some(WsEvent::MessageUpdated {
                server,
                channel_id,
                update,
                dm_users,
            })
        }
        WsEvent::EmbedsResolved {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            embeds: _,
        } => {
            let message = load_broadcast(db, message_id).await.ok().flatten()?;
            Some(WsEvent::EmbedsResolved {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                embeds: message.embeds,
            })
        }
        WsEvent::ReactionAdded {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            thread_root_id,
            emoji,
            username,
            count: _,
        } => {
            let (stored, count) =
                crate::api::reactions::reaction_state(db, message_id, &username, &emoji)
                    .await
                    .ok()?;
            stored.then_some(WsEvent::ReactionAdded {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                thread_root_id,
                emoji,
                username,
                count,
            })
        }
        WsEvent::ReactionRemoved {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            thread_root_id,
            emoji,
            username,
            count: _,
        } => {
            let (stored, count) =
                crate::api::reactions::reaction_state(db, message_id, &username, &emoji)
                    .await
                    .ok()?;
            (!stored).then_some(WsEvent::ReactionRemoved {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                thread_root_id,
                emoji,
                username,
                count,
            })
        }
        WsEvent::PollUpdated {
            server: _,
            channel_id: _,
            dm_id: _,
            dm_users: _,
            message_id,
            thread_root_id: _,
            created_at: _,
            poll: _,
        } => crate::api::polls::update_event(db, message_id)
            .await
            .ok()
            .flatten(),
        WsEvent::MessagePinned {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            pinned_at: _,
            pinned_by,
        } => {
            let pinned_at = crate::api::pins::pinned_at(db, message_id).await.ok()??;
            Some(WsEvent::MessagePinned {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                pinned_at,
                pinned_by,
            })
        }
        WsEvent::MessageUnpinned {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
        } => match crate::api::pins::pinned_at(db, message_id).await.ok()? {
            Some(_) => None,
            None => Some(WsEvent::MessageUnpinned {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
            }),
        },
        WsEvent::ChannelCreated { server, channel } => {
            let (owner, channel) = channel_now(db, channel.id).await.ok().flatten()?;
            (owner == server).then_some(WsEvent::ChannelCreated { server, channel })
        }
        WsEvent::ChannelRenamed { server, channel } => {
            let (owner, channel) = channel_now(db, channel.id).await.ok().flatten()?;
            (owner == server).then_some(WsEvent::ChannelRenamed { server, channel })
        }
        WsEvent::ChannelUpdated { server, channel } => {
            let (owner, channel) = channel_now(db, channel.id).await.ok().flatten()?;
            (owner == server).then_some(WsEvent::ChannelUpdated { server, channel })
        }
        WsEvent::LayoutChanged {
            server,
            layout: _,
            created,
            deleted,
        } => {
            let layout = crate::api::categories::current_layout(db, &server)
                .await
                .ok()
                .flatten()?;
            Some(WsEvent::LayoutChanged {
                server,
                layout,
                created,
                deleted,
            })
        }
        WsEvent::ServerCreated { server } => {
            let server = refresh_lite(db, &server.name).await.ok().flatten()?;
            Some(WsEvent::ServerCreated { server })
        }
        WsEvent::ServerRenamed { old_name, server } => {
            let reused =
                old_name != server.name && !matches!(refresh_lite(db, &old_name).await, Ok(None));
            let server = refresh_lite(db, &server.name).await.ok().flatten()?;
            (!reused).then_some(WsEvent::ServerRenamed { old_name, server })
        }
        WsEvent::ServerUpdated { server } => {
            let server = refresh_lite(db, &server.name).await.ok().flatten()?;
            Some(WsEvent::ServerUpdated { server })
        }
        WsEvent::ServerDeleted { name } => match refresh_lite(db, &name).await {
            Ok(Some(_)) => None,
            Ok(None) | Err(_) => Some(WsEvent::ServerDeleted { name }),
        },
        WsEvent::MemberJoined { server, member } => {
            match is_member(db, &server, &member.user.username).await {
                Ok(true) => Some(WsEvent::MemberJoined { server, member }),
                Ok(false) | Err(_) => None,
            }
        }
        WsEvent::MemberLeft { server, username } => match is_member(db, &server, &username).await {
            Ok(true) => {
                evict_unviewable(state, &server, None).await;
                None
            }
            Ok(false) | Err(_) => Some(WsEvent::MemberLeft { server, username }),
        },
        WsEvent::MemberKicked {
            server,
            username,
            banned,
        } => match is_member(db, &server, &username).await {
            Ok(true) => {
                evict_unviewable(state, &server, None).await;
                None
            }
            Ok(false) | Err(_) => Some(WsEvent::MemberKicked {
                server,
                username,
                banned,
            }),
        },
        WsEvent::MembersPurged { server, usernames } => {
            let mut gone = Vec::new();
            let mut stayed = false;
            for username in usernames {
                match is_member(db, &server, &username).await {
                    Ok(true) => stayed = true,
                    Ok(false) | Err(_) => gone.push(username),
                }
            }
            if stayed {
                evict_unviewable(state, &server, None).await;
            }
            (!gone.is_empty()).then_some(WsEvent::MembersPurged {
                server,
                usernames: gone,
            })
        }
        WsEvent::ServerBanned { server, username } => match ws_banned(db, &server, &username).await
        {
            Ok(true) => Some(WsEvent::ServerBanned { server, username }),
            Ok(false) | Err(_) => None,
        },
        WsEvent::PresenceMode {
            username,
            appear_offline: _,
            seq: _,
        } => {
            let (appear_offline, seq) = presence_mode(&state.db, &username).await.ok().flatten()?;
            Some(WsEvent::PresenceMode {
                username,
                appear_offline,
                seq,
            })
        }
        WsEvent::AdminChanged {
            server,
            username,
            is_admin: _,
            perms: _,
        } => {
            let (is_admin, perms) = admin_state(db, &server, &username).await.ok().flatten()?;
            Some(WsEvent::AdminChanged {
                server,
                username,
                is_admin,
                perms,
            })
        }
        WsEvent::UserUpdated { user, scope } => {
            let user = get_user(db, &user.username).await.ok().flatten()?;
            Some(WsEvent::UserUpdated {
                user: UserRef::from_user(&user),
                scope,
            })
        }
        WsEvent::UserRegistered { user } => {
            let user = get_user(db, &user.username).await.ok().flatten()?;
            Some(WsEvent::UserRegistered {
                user: UserRef::from_user(&user),
            })
        }
        WsEvent::Banned { username } => match get_user(db, &username).await {
            Ok(Some(_)) => None,
            Ok(None) | Err(_) => Some(WsEvent::Banned { username }),
        },
        WsEvent::SettingsChanged { settings: _ } => Some(WsEvent::SettingsChanged {
            settings: Settings::load(db).await,
        }),
        WsEvent::RtcSignal {
            to,
            from,
            channel_id,
            dm_id,
            payload,
        } => state
            .hub
            .rtc_shared(&from, &to, channel_id, dm_id)
            .then_some(WsEvent::RtcSignal {
                to,
                from,
                channel_id,
                dm_id,
                payload,
            }),
        WsEvent::Typing {
            server: _,
            channel_id: _,
            dm_id: _,
            dm_users: _,
            scope: _,
            username: _,
            display_name: _,
            until: _,
        } => None,
        other => Some(other),
    }
}

async fn repost_event(state: &AppState, event: WsEvent) {
    loop {
        let Some(ev) = current(state, event.clone()).await else {
            return;
        };
        let WsEvent::Message {
            server,
            channel_id,
            dm_id,
            dm_users,
            message,
        } = &ev
        else {
            state.hub.broadcast(ev);
            return;
        };
        let id = message.id;
        let deleted = WsEvent::MessageDeleted {
            server: server.clone(),
            channel_id: *channel_id,
            dm_id: *dm_id,
            dm_users: dm_users.clone(),
            id,
            thread_root_id: message.thread_root_id,
        };
        if state.hub.broadcast_confirmed(ev).await {
            if matches!(
                load_message(&state.read(), id, Quotes::Skip).await,
                Ok(None)
            ) {
                state.hub.broadcast(deleted);
            }
            return;
        }
    }
}

pub(crate) async fn repost(state: &AppState, op: Op) {
    match op {
        Op::Broadcast { event } => repost_event(state, event).await,
        Op::ForceOffline { server, user } => {
            if !is_member(&state.db, &server, &user).await.unwrap_or(false) {
                state.hub.force_offline(&server, &user);
            }
        }
        Op::EvictVoice { user, channel_id } => {
            let allowed = match channel_now(&state.read(), channel_id).await {
                Ok(Some((server, _))) => {
                    ws_voice_viewable(&state.read(), &server, channel_id, &user).await
                }
                Ok(None) | Err(_) => false,
            };
            if !allowed {
                state.hub.evict_voice(&user, channel_id);
            }
        }
        _ => {}
    }
}

pub fn announce_purge(hub: &Hub, server: &str, usernames: &[String]) {
    for chunk in usernames.chunks(PURGE_CHUNK) {
        hub.broadcast(WsEvent::MembersPurged {
            server: server.to_string(),
            usernames: chunk.to_vec(),
        });
    }
}

fn voice_room_max() -> usize {
    static MAX: OnceLock<usize> = OnceLock::new();
    *MAX.get_or_init(|| {
        std::env::var("VOICE_ROOM_MAX")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(VOICE_ROOM_MAX)
    })
}

pub async fn depart(state: &AppState) {
    let wait = Duration::from_secs(3);
    if let Ok(Some(purge)) = tokio::time::timeout(wait, state.hub.depart()).await {
        let _ = tokio::time::timeout(wait, settle(state, purge)).await;
    }
    let _ = tokio::time::timeout(wait, state.hub.flush()).await;
}

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
/// follow, with guest grants for password-protected ones), `voice_join` / `voice_leave`,
/// `call_start` (with `p2p` and `video` flags) / `call_accept` / `call_decline` / `call_leave`
/// for DM calls, `rtc_signal` for
/// WebRTC signalling, and `p2p_hosting` / `p2p_who` / `p2p_peer` for P2P files (`p2p_peer`
/// gives a reader of one message the hoster's peer id and a short-lived download token; `p2p_who`
/// never carries peer ids). `typing` / `typing_stop` with a `scope` (`c{channel}`,
/// `t{root}` or `d{dm}`) show or clear a typing indicator where the sender may send messages
/// (others are ignored silently); the client repeats `typing` every few seconds while typing.
/// Others there get `typing` (`{scope, username, display_name, until}`, `until` in unix
/// seconds, 0 when stopped), routed like messages and never to the typer's own connections.
/// Guests are read-only: no presence, typing, voice or calls. The server sends the events in `WsEvent` (`apps/server/src/ws.rs`),
/// for example `message`, `message_updated`, `message_deleted`, `member_joined`, `presence_changed`,
/// `voice_state`, `call_state` (with `kind` and `video`; an active P2P call also carries its id
/// and the peer id of both tabs), `p2p_hosted` (tells a `p2p_hosting` sender which of its files are still live
/// attachments, and the key it checks download tokens with), `p2p_peer`, `error` and `resync` (fetch state again after missed events). Frames
/// are at most 64 KiB. The token goes in the `auth` frame, not in the bearer security scheme.
/// General rate-limit bucket for the upgrade request.
#[utoipa::path(get, path = "/api/ws", tag = "Realtime", responses((status = 101, description = "WebSocket upgrade"), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String), (status = 503, description = "Realtime bus not ready", content_type = "text/plain", body = String)), security(()))]
pub async fn handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    if !state.hub.ready() {
        return (StatusCode::SERVICE_UNAVAILABLE, "Realtime bus not ready").into_response();
    }
    ws.max_message_size(FRAME_MAX)
        .max_frame_size(FRAME_MAX)
        .on_upgrade(move |socket| run(state, socket))
}

async fn voice_msg(state: &AppState, user: &str, conn: u64, msg: ClientMsg) -> Result<(), String> {
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
                .voice_join_capped(user, conn, &server, channel_id, voice_room_max())
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
        } => {
            let peer_id = call_peer_id(peer_id)?;
            let row = sqlx::query("SELECT user_a, user_b FROM dms WHERE id = $1")
                .bind(dm_id)
                .fetch_optional(&state.read())
                .await
                .map_err(db_err)?
                .ok_or_else(|| "DM not found".to_string())?;
            let (a, b): (String, String) = (
                row.try_get(0).map_err(db_err)?,
                row.try_get(1).map_err(db_err)?,
            );
            if a != user && b != user {
                return Err("Not a participant".to_string());
            }
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
            let dm_users = vec![a, b];
            let log_id = insert_call_log(state, dm_id, user, (kind, video))
                .await
                .map_err(db_err)?;
            match state
                .hub
                .call_start(
                    user,
                    conn,
                    dm_id,
                    dm_users.clone(),
                    kind,
                    video,
                    log_id,
                    peer_id,
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
        ClientMsg::CallAccept { dm_id, peer_id } => {
            let peer_id = call_peer_id(peer_id)?;
            crate::api::blocks::check_dm_id(&state.db, user, dm_id)
                .await
                .map_err(|crate::api::ApiError(_, e)| e)?;
            let (log_id, dm_users) = state.hub.call_accept(user, conn, dm_id, peer_id).await?;
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
            if serde_json::to_string(&payload).map_or(true, |p| p.len() > SIGNAL_MAX) {
                return Err("Signal too large".to_string());
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
        | ClientMsg::P2pHosting { peer_id: _, ids: _ }
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

fn call_peer_id(peer_id: Option<String>) -> Result<Option<String>, String> {
    match peer_id {
        Some(id) if !crate::p2p::valid_peer_id(&id) => Err("Invalid peer id".to_string()),
        other => Ok(other),
    }
}

struct Who {
    pace: Pace,
    pending: Vec<String>,
    peers: HashMap<String, (Instant, Option<Peer>)>,
    media: HashMap<(String, String), (Instant, bool)>,
}

#[derive(Clone)]
struct Peer {
    offline: bool,
    dm: bool,
    servers: Vec<String>,
}

impl Who {
    fn new() -> Who {
        Who {
            pace: Pace::new(P2P_WHO_EVERY),
            pending: Vec::new(),
            peers: HashMap::new(),
            media: HashMap::new(),
        }
    }

    fn ask(&mut self, hosters: Vec<String>) {
        for hoster in hosters {
            let hoster = hoster.to_lowercase();
            if self.pending.len() >= P2P_WHO_CAP {
                break;
            }
            if !self.pending.contains(&hoster) {
                self.pending.push(hoster);
            }
        }
    }

    fn soon(&mut self, hoster: &str, now: Instant) {
        self.ask(vec![hoster.to_string()]);
        if self.pace.due.is_none() {
            self.pace.due = Some(
                self.pace
                    .last
                    .map_or(now, |last| (last + self.pace.every).max(now)),
            );
        }
    }

    fn forget(&mut self) {
        self.peers.clear();
        self.media.clear();
    }

    fn trim(&mut self, now: Instant) {
        if self.peers.len() > P2P_WHO_CACHE_MAX {
            self.peers.retain(|_, (at, _)| now < *at + P2P_WHO_TTL);
        }
        if self.peers.len() > P2P_WHO_CACHE_MAX {
            self.peers.clear();
        }
        if self.media.len() > P2P_WHO_CACHE_MAX {
            self.media.retain(|_, (at, _)| now < *at + P2P_WHO_TTL);
        }
        if self.media.len() > P2P_WHO_CACHE_MAX {
            self.media.clear();
        }
    }
}

/// Whether `user` appears offline, and the version of that setting (`users.presence_seq`).
pub(crate) async fn presence_mode(db: &Db, user: &str) -> sqlx::Result<Option<(bool, i64)>> {
    sqlx::query("SELECT appear_offline, presence_seq FROM users WHERE username = $1")
        .bind(user)
        .fetch_optional(db)
        .await?
        .map(|row| Ok((row.try_get::<i64, _>(0)? != 0, row.try_get::<i64, _>(1)?)))
        .transpose()
}

async fn appear_offline(db: &Db, hoster: &str) -> sqlx::Result<Option<bool>> {
    sqlx::query("SELECT appear_offline FROM users WHERE username = $1")
        .bind(hoster)
        .fetch_optional(db)
        .await?
        .map(|row| row.try_get::<i64, _>(0).map(|v| v != 0))
        .transpose()
}

async fn peer_facts(db: &Db, me: &str, hoster: &str) -> sqlx::Result<Option<Peer>> {
    let Some(offline) = appear_offline(db, hoster).await? else {
        return Ok(None);
    };
    let dm = sqlx::query(
        "SELECT 1 FROM dms WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)",
    )
    .bind(me)
    .bind(hoster)
    .fetch_optional(db)
    .await?
    .is_some();
    let servers = member_servers_of(db, hoster).await?.into_iter().collect();
    Ok(Some(Peer {
        offline,
        dm,
        servers,
    }))
}

// Whether `hoster` shows as hosting to `me`, and which of their files `me` can read. Peer ids
// are never part of it: a reader gets one per download, through `p2p_peer`.
async fn p2p_visible(
    state: &AppState,
    access: &mut Access,
    me: &str,
    hoster: &str,
) -> Option<Vec<String>> {
    let ids = state.hub.p2p_ids(hoster)?;
    if me == hoster {
        return Some(ids);
    }
    let db = state.read();
    let calling = state.hub.in_p2p_call(me, hoster);
    let now = Instant::now();
    let peer = match access.who.peers.get(hoster) {
        Some((at, peer)) if now < *at + P2P_WHO_TTL => match peer.clone() {
            Some(peer) => Some(Peer {
                offline: appear_offline(&db, hoster).await.ok()??,
                ..peer
            }),
            None => None,
        },
        Some(_) | None => {
            let peer = peer_facts(&db, me, hoster).await.ok()?;
            access.who.trim(now);
            access
                .who
                .peers
                .insert(hoster.to_string(), (now, peer.clone()));
            peer
        }
    }?;
    if peer.offline && !calling {
        return None;
    }
    let shared = peer.dm
        || calling
        || peer
            .servers
            .iter()
            .any(|s| access.member_servers.contains(s) || access.subs.contains(s));
    if !shared {
        return None;
    }
    let ids = match Settings::cached(&db).await.p2p_attachments {
        true => readable_p2p_ids(&db, access, me, hoster, ids).await,
        false => Vec::new(),
    };
    Some(ids)
}

const NOT_AVAILABLE: &str = "File not available";
const RECONNECTING: &str = "Reconnecting, try again in a moment";

fn p2p_refused(message_id: i64, error: &str) -> WsEvent {
    WsEvent::P2pPeer {
        message_id,
        peer_id: None,
        token: None,
        expires_at: None,
        error: Some(error.to_string()),
    }
}

// The answer to `p2p_peer`: the peer id of the hoster's tab that has the attachment of
// `message_id`, and a token for it, only for a signed-in user who can read that message. The
// hoster must be online (not appearing offline) and still host the file. Requests are rate
// limited per user, whatever the answer.
async fn p2p_release(state: &AppState, access: &Access, message_id: i64, peer_id: &str) -> WsEvent {
    let deny = |error: &str| p2p_refused(message_id, error);
    let Some(me) = access.user.clone() else {
        return deny("Create an account to download P2P files");
    };
    if !state.hub.release_ok(&me) {
        return deny("Too many downloads at once, try again in a moment");
    }
    if !crate::p2p::valid_peer_id(peer_id) {
        return deny(NOT_AVAILABLE);
    }
    let db = state.read();
    if !Settings::cached(&db).await.p2p_attachments {
        return deny(NOT_AVAILABLE);
    }
    let row = sqlx::query(
        "SELECT m.media_id, m.channel_id, c.server, d.user_a, d.user_b, m.created_at, m.media_hoster, m.media_expires_at FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id WHERE m.id = $1 AND m.media_kind = 'p2p' AND m.media_removed = 0",
    )
    .bind(message_id)
    .fetch_optional(&db)
    .await;
    let Ok(Some(row)) = row else {
        return deny(NOT_AVAILABLE);
    };
    let (Ok(media_id), Ok(Some(hoster)), Ok(expires)) = (
        row.try_get::<String, _>(0),
        row.try_get::<Option<String>, _>(6),
        row.try_get::<Option<i64>, _>(7),
    ) else {
        return deny(NOT_AVAILABLE);
    };
    let now = now();
    let live = expires.is_none_or(|at| at > now);
    if hoster == me || !live {
        return deny(NOT_AVAILABLE);
    }
    if !row_readable(&db, access, &me, &mut ReadCache::default(), &row).await {
        return deny(NOT_AVAILABLE);
    }
    let shown = matches!(appear_offline(&db, &hoster).await, Ok(Some(false)))
        || state.hub.in_p2p_call(&me, &hoster);
    let Some(hoster_peer) = state.hub.p2p_host_of(&hoster, &media_id).filter(|_| shown) else {
        return deny(NOT_AVAILABLE);
    };
    let exp = now + crate::p2p::TOKEN_TTL;
    let grant = crate::p2p::Grant {
        v: 1,
        message_id,
        p2p_id: media_id,
        requester: me,
        hoster,
        hoster_peer: hoster_peer.clone(),
        requester_peer: peer_id.to_string(),
        exp,
    };
    WsEvent::P2pPeer {
        message_id,
        peer_id: Some(hoster_peer),
        token: Some(crate::p2p::issue(&state.instance.p2p_secret, &grant)),
        expires_at: Some(exp),
        error: None,
    }
}

async fn readable_p2p_ids(
    db: &Db,
    access: &mut Access,
    me: &str,
    hoster: &str,
    ids: Vec<String>,
) -> Vec<String> {
    let now = Instant::now();
    let cached = |access: &Access, id: &String| {
        access
            .who
            .media
            .get(&(hoster.to_string(), id.clone()))
            .filter(|(at, _)| now < *at + P2P_WHO_TTL)
            .map(|(_, readable)| *readable)
    };
    let unknown: Vec<String> = ids
        .iter()
        .filter(|id| cached(access, id).is_none())
        .cloned()
        .collect();
    if !unknown.is_empty() {
        let found = lookup_p2p_ids(db, access, me, hoster, &unknown).await;
        access.who.trim(now);
        for id in unknown {
            let readable = found.contains(&id);
            access
                .who
                .media
                .insert((hoster.to_string(), id), (now, readable));
        }
    }
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if cached(access, &id) == Some(true) && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

async fn lookup_p2p_ids(
    db: &Db,
    access: &Access,
    me: &str,
    hoster: &str,
    ids: &[String],
) -> Vec<String> {
    let sql = format!(
        "SELECT m.media_id, m.channel_id, c.server, d.user_a, d.user_b, m.created_at FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id WHERE m.media_kind = 'p2p' AND m.media_removed = 0 AND m.media_hoster = $1 AND m.media_id IN ({})",
        (2..ids.len() + 2)
            .map(|n| format!("${n}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(hoster);
    for id in ids {
        query = query.bind(id);
    }
    let Ok(rows) = query.fetch_all(db).await else {
        return Vec::new();
    };
    let mut cache = ReadCache::default();
    let mut out: Vec<String> = Vec::new();
    for r in &rows {
        let Ok(id) = r.try_get::<String, _>(0) else {
            continue;
        };
        if !out.contains(&id) && row_readable(db, access, me, &mut cache, r).await {
            out.push(id);
        }
    }
    out
}

#[derive(Default)]
struct ReadCache {
    servers: HashMap<String, bool>,
    channels: HashMap<i64, Option<Option<i64>>>,
}

// Whether `me` can read a message row with channel_id, server, user_a, user_b and created_at in
// columns 1 to 5: server access, channel view and the read-history floor, or DM membership.
async fn row_readable(
    db: &Db,
    access: &Access,
    me: &str,
    cache: &mut ReadCache,
    r: &sqlx::any::AnyRow,
) -> bool {
    let channel: Option<i64> = r.try_get(1).ok().flatten();
    let server: Option<String> = r.try_get(2).ok().flatten();
    let pair: (Option<String>, Option<String>) =
        (r.try_get(3).ok().flatten(), r.try_get(4).ok().flatten());
    match (channel, server, pair) {
        (Some(cid), Some(server), _) => {
            let open = match cache.servers.get(&server) {
                Some(open) => *open,
                None => {
                    let open = authed_sub_ok(db, &server, me, access.site_admin)
                        .await
                        .unwrap_or(false);
                    cache.servers.insert(server.clone(), open);
                    open
                }
            };
            let hidden = access
                .viewable
                .get(&cid)
                .is_some_and(|(owner, view)| !*view || *owner != server);
            let since = match (hidden, cache.channels.get(&cid)) {
                (true, _) => None,
                (false, Some(since)) => *since,
                (false, None) => {
                    let since = ws_channel_read_since(db, &server, cid, me).await;
                    cache.channels.insert(cid, since);
                    since
                }
            };
            let created_at: Option<i64> = r.try_get(5).ok();
            open && since.is_some_and(|floor| {
                floor.is_none_or(|floor| created_at.is_some_and(|at| at >= floor))
            })
        }
        (_, _, (Some(a), Some(b))) => a == me || b == me,
        (_, _, _) => false,
    }
}

type P2pScope = (Vec<String>, Vec<String>);

async fn p2p_scope(db: &Db, user: &str) -> P2pScope {
    let UserScope {
        mut servers,
        views,
        users,
    } = user_scope(db, user).await;
    servers.extend(views);
    (servers, users)
}

fn p2p_online(
    hoster: &str,
    peer_id: String,
    ids: Vec<String>,
    (scope_servers, scope_users): P2pScope,
) -> WsEvent {
    WsEvent::P2pAvailability {
        hoster: hoster.to_string(),
        peer_id: Some(peer_id),
        ids,
        online: true,
        scope_servers,
        scope_users,
    }
}

fn p2p_offline(hoster: String, scope_servers: Vec<String>, scope_users: Vec<String>) -> WsEvent {
    WsEvent::P2pAvailability {
        hoster,
        peer_id: None,
        ids: Vec::new(),
        online: false,
        scope_servers,
        scope_users,
    }
}

async fn refresh_lite(db: &Db, name: &str) -> sqlx::Result<Option<ServerSummaryLite>> {
    let row = sqlx::query(
        "SELECT name, display_name, creator, password_hash, banner_color, name_color FROM servers WHERE name = $1 AND COALESCE(password_hash, '') <> '!purging'",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    match row {
        Some(r) => Ok(Some(ServerSummaryLite {
            name: r.try_get(0)?,
            display_name: r.try_get(1)?,
            creator: r.try_get(2)?,
            has_password: r.try_get::<Option<String>, _>(3)?.is_some(),
            banner_color: r.try_get(4)?,
            name_color: r.try_get(5)?,
        })),
        None => Ok(None),
    }
}

async fn server_password_hash(db: &Db, server: &str) -> sqlx::Result<Option<Option<String>>> {
    Ok(
        sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
            .bind(server)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get(0).unwrap_or(None)),
    )
}

async fn is_member(db: &Db, server: &str, user: &str) -> sqlx::Result<bool> {
    Ok(
        sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(user)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
}

async fn guest_sub_ok(db: &Db, server: &str, grant: Option<&str>) -> sqlx::Result<bool> {
    ws_server_open(db, server, None, false, grant).await
}

async fn authed_sub_ok(db: &Db, server: &str, user: &str, site_admin: bool) -> sqlx::Result<bool> {
    ws_server_open(db, server, Some(user), site_admin, None).await
}

async fn member_servers_of(db: &Db, user: &str) -> sqlx::Result<HashSet<String>> {
    Ok(
        sqlx::query("SELECT server FROM members WHERE username = $1")
            .bind(user)
            .fetch_all(db)
            .await?
            .iter()
            .filter_map(|r| r.try_get(0).ok())
            .collect(),
    )
}

async fn token_live(db: &Db, token: Option<&str>) -> sqlx::Result<bool> {
    match token {
        Some(token) => Ok(sqlx::query("SELECT 1 FROM tokens WHERE token = $1")
            .bind(crate::db::secret_key(token))
            .fetch_optional(db)
            .await?
            .is_some()),
        None => Ok(false),
    }
}

async fn session_of(db: &Db, token: &str) -> sqlx::Result<bool> {
    Ok(sqlx::query(
        "SELECT 1 FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1 AND u.password_hash <> '!purging'",
    )
    .bind(crate::db::secret_key(token))
    .fetch_optional(db)
    .await?
    .is_some())
}

type Viewable = HashMap<i64, (String, bool)>;

struct Retry {
    at: Option<Instant>,
    wait: Duration,
    since: Option<Instant>,
}

impl Retry {
    fn new() -> Retry {
        Retry {
            at: None,
            wait: REAUTH_RETRY,
            since: None,
        }
    }

    fn pending(&self) -> bool {
        self.at.is_some()
    }

    fn fail(&mut self, e: sqlx::Error, started: Instant) -> bool {
        let now = Instant::now();
        let deadline = *self.since.get_or_insert(started) + REAUTH_GIVE_UP;
        if now >= deadline {
            match REAUTH_GAVE_UP.admit(now) {
                true => warn!(
                    "closed a realtime connection whose re-authorization kept failing for {}s, so its client reconnects: {e}",
                    REAUTH_GIVE_UP.as_secs()
                ),
                false => {
                    debug!("closed a realtime connection whose re-authorization kept failing: {e}")
                }
            }
            return false;
        }
        if self.pending() {
            debug!("re-authorizing a realtime connection failed again before its retry: {e}");
            return true;
        }
        match REAUTH_FAILED.admit(now) {
            true => warn!(
                "re-authorizing a realtime connection failed; its events are held back while it retries: {e}"
            ),
            false => debug!("re-authorizing a realtime connection failed: {e}"),
        }
        let delay = self.wait + self.wait.mul_f64(rand::random::<f64>() / 2.0);
        self.at = Some((now + delay).min(deadline));
        self.wait *= 2;
        true
    }
}

struct Pace {
    every: Duration,
    last: Option<Instant>,
    due: Option<Instant>,
}

impl Pace {
    fn new(every: Duration) -> Pace {
        Pace {
            every,
            last: None,
            due: None,
        }
    }

    fn hit(&mut self, now: Instant) -> bool {
        match self.last {
            Some(last) if now < last + self.every => {
                self.due = Some(last + self.every);
                false
            }
            Some(_) | None => {
                self.fire(now);
                true
            }
        }
    }

    fn fire(&mut self, now: Instant) {
        self.last = Some(now);
        self.due = None;
    }
}

async fn catch_up(
    state: &AppState,
    conn: u64,
    access: &mut Access,
    inbox: &mut crate::fanout::Inbox,
    lag: &mut Pace,
    seq: u64,
) -> (u64, bool) {
    let through = inbox.drain().unwrap_or(seq).max(seq);
    if !lag.hit(Instant::now()) {
        return (through, true);
    }
    access.missed = true;
    (through, access.refresh(state, conn).await)
}

struct Access {
    user: Option<String>,
    /// When the account was created (it keys anonymous poll votes).
    since: Option<i64>,
    token: Option<String>,
    site_admin: bool,
    member_servers: HashSet<String>,
    subs: HashSet<String>,
    grants: HashMap<String, String>,
    deadlines: HashMap<String, i64>,
    viewing: Option<String>,
    looking: Option<String>,
    peek: Option<String>,
    hidden: bool,
    mode: i64,
    announced: bool,
    moved: Vec<String>,
    hidden_moved: bool,
    dark: bool,
    missed: bool,
    hosting: Option<(String, Vec<String>)>,
    hosted_scope: Option<(Instant, P2pScope)>,
    hosting_pace: Pace,
    who: Who,
    viewable: Viewable,
    floors: HashMap<i64, (Instant, Option<Option<i64>>)>,
    retry: Retry,
    topics_dirty: bool,
}

impl Access {
    fn new(user: Option<String>, site_admin: bool, member_servers: HashSet<String>) -> Access {
        Access {
            user,
            since: None,
            token: None,
            site_admin,
            member_servers,
            subs: HashSet::new(),
            grants: HashMap::new(),
            deadlines: HashMap::new(),
            viewing: None,
            looking: None,
            peek: None,
            hidden: false,
            mode: 0,
            announced: false,
            moved: Vec::new(),
            hidden_moved: false,
            dark: false,
            missed: false,
            hosting: None,
            hosted_scope: None,
            hosting_pace: Pace::new(P2P_ANNOUNCE_EVERY),
            who: Who::new(),
            viewable: HashMap::new(),
            floors: HashMap::new(),
            retry: Retry::new(),
            topics_dirty: false,
        }
    }

    fn topics(&self) -> HashSet<Topic> {
        let mut topics = HashSet::new();
        if self.site_admin {
            topics.insert(Topic::Admin);
        }
        if let Some(user) = &self.user {
            topics.insert(Topic::User(user.clone()));
        }
        for server in self.member_servers.iter().chain(self.subs.iter()) {
            topics.insert(Topic::Server(server.clone()));
        }
        for server in self.subs.iter().chain(self.viewing.iter()) {
            topics.insert(Topic::View(server.clone()));
        }
        topics
    }

    // What this connection announces for its user: every member server (at most
    // `PRESENCE_SERVERS_MAX`, by name), whatever is open, and whether they appear offline.
    fn scope(&self) -> Scope {
        let mut servers: Vec<String> = self.member_servers.iter().cloned().collect();
        servers.sort_unstable();
        servers.truncate(PRESENCE_SERVERS_MAX);
        Scope {
            servers,
            hidden: self.hidden,
            seq: self.mode,
        }
    }

    fn shows(&self, server: &str) -> bool {
        self.announced && !self.dark && !self.hidden && self.member_servers.contains(server)
    }

    // The first call announces the connection with the user's full scope. Later membership
    // or appear-offline changes go out as a delta of the servers they touched.
    fn sync(&mut self, hub: &Hub, conn: u64) {
        let Some(user) = &self.user else {
            return;
        };
        if self.dark {
            return;
        }
        if !self.announced {
            hub.announce(user, conn, true, Some(self.scope()));
            self.announced = true;
            self.moved.clear();
            self.hidden_moved = false;
            return;
        }
        if self.moved.is_empty() && !self.hidden_moved {
            return;
        }
        let mut moved = std::mem::take(&mut self.moved);
        moved.sort_unstable();
        moved.dedup();
        let (add, remove) = moved
            .into_iter()
            .partition(|s| self.member_servers.contains(s));
        let hidden = std::mem::take(&mut self.hidden_moved).then_some((self.hidden, self.mode));
        hub.rescope(user, add, remove, hidden);
    }

    fn view(&mut self, hub: &Hub, conn: u64, target: Option<String>) {
        self.topics_dirty |= self.viewing != target;
        self.viewing = target;
        self.sync(hub, conn);
    }

    fn set_peek(&mut self, server: Option<String>) {
        if self.peek == server {
            return;
        }
        if let Some(old) = self.peek.take() {
            self.subs.remove(&old);
            self.topics_dirty = true;
        }
        if let Some(server) = server
            && self.subs.insert(server.clone())
        {
            self.peek = Some(server);
            self.topics_dirty = true;
        }
    }

    fn tidy_peek(&mut self) {
        if self.peek.as_ref().is_some_and(|p| !self.subs.contains(p)) {
            self.peek = None;
        }
    }

    // Takes the appear-offline value of version `seq` unless a newer one is already known (an
    // event queued before the connection reread the setting).
    fn set_hidden(&mut self, hub: &Hub, conn: u64, hidden: bool, seq: i64) {
        if seq < self.mode {
            return;
        }
        self.mode = seq;
        self.hidden = hidden;
        self.hidden_moved = true;
        self.sync(hub, conn);
    }

    fn take_mode(&mut self, (hidden, seq): (bool, i64)) {
        if seq >= self.mode {
            self.mode = seq;
            self.hidden = hidden;
        }
    }

    // While the database retry is pending the connection is dark: open, but it shows nobody
    // and leaves the scope alone, since its membership may be stale.
    fn reshow(&mut self, hub: &Hub, conn: u64) {
        if let Some(user) = &self.user {
            let lit = !self.retry.pending();
            hub.announce(user, conn, lit, lit.then(|| self.scope()));
            self.dark = !lit;
            self.announced = true;
            self.moved.clear();
            self.hidden_moved = false;
        }
    }

    async fn announce(&mut self, state: &AppState, conn: u64) {
        self.reshow(&state.hub, conn);
        self.announce_hosting(state, conn).await;
    }

    async fn scope_of_hosting(&mut self, state: &AppState) -> Option<P2pScope> {
        let user = self.user.as_deref()?;
        if let Some((at, scope)) = &self.hosted_scope
            && at.elapsed() < P2P_SCOPE_TTL
        {
            return Some(scope.clone());
        }
        let scope = p2p_scope(&state.read(), user).await;
        self.hosted_scope = Some((Instant::now(), scope.clone()));
        Some(scope)
    }

    async fn announce_hosting(&mut self, state: &AppState, conn: u64) {
        if self.dark || self.hosting.is_none() {
            return;
        }
        let Some(scope) = self.scope_of_hosting(state).await else {
            return;
        };
        if let (Some(user), Some(hosting)) = (&self.user, &self.hosting) {
            announce_hosting(state, user, conn, hosting.clone(), scope).await;
        }
    }

    async fn host(&mut self, state: &AppState, conn: u64, hosting: (String, Vec<String>)) {
        if self.hosting.as_ref() == Some(&hosting) {
            return;
        }
        self.hosting = Some(hosting);
        if self.hosting_pace.hit(Instant::now()) {
            self.announce_hosting(state, conn).await;
        }
    }

    /// The read-history floor of channel `cid` for this connection (see `ws_read_floor`),
    /// remembered for 30 seconds.
    async fn floor(&mut self, state: &AppState, server: &str, cid: i64) -> Option<Option<i64>> {
        if let Some((at, floor)) = self.floors.get(&cid)
            && at.elapsed() < FLOOR_TTL
        {
            return *floor;
        }
        let floor =
            crate::api::access::ws_read_floor(&state.read(), server, cid, self.user.as_deref())
                .await;
        if self.floors.len() > 1000 {
            self.floors.clear();
        }
        self.floors.insert(cid, (Instant::now(), floor));
        floor
    }

    fn held(&self, name: &str) -> bool {
        self.member_servers.contains(name) || self.subs.contains(name)
    }

    fn wants(&self, ev: &WsEvent) -> bool {
        let me = self.user.as_deref();
        match self.retry.pending() {
            false => wants(ev, me, self.site_admin, &self.member_servers, &self.subs),
            true => wants(ev, None, false, &HashSet::new(), &HashSet::new()),
        }
    }

    fn hold(&mut self, e: sqlx::Error, started: Instant) -> bool {
        self.viewable.clear();
        self.floors.clear();
        self.missed = true;
        self.retry.fail(e, started)
    }

    async fn check_token(&mut self, db: &Db) -> bool {
        let started = Instant::now();
        match token_live(db, self.token.as_deref()).await {
            Ok(live) => live,
            Err(e) => self.hold(e, started),
        }
    }

    fn note_epoch(&mut self, lossy: &mut u64, now: Epoch) {
        self.missed |= now.lossy != *lossy;
        *lossy = now.lossy;
    }

    fn settle(&mut self, res: sqlx::Result<bool>, started: Instant) -> bool {
        match res {
            Ok(open) => {
                self.retry = Retry::new();
                open
            }
            Err(e) => self.hold(e, started),
        }
    }

    async fn refresh(&mut self, state: &AppState, conn: u64) -> bool {
        self.retry.at = None;
        let started = Instant::now();
        let res = reauthorize(state, self).await;
        if !self.settle(res, started) {
            return false;
        }
        if !self.retry.pending() && !self.dark {
            self.reshow(&state.hub, conn);
        }
        true
    }

    async fn past_deadlines(&mut self, state: &AppState, conn: u64) -> bool {
        let t = now();
        let due: Vec<String> = self
            .deadlines
            .iter()
            .filter(|(_, at)| **at <= t)
            .map(|(server, _)| server.clone())
            .collect();
        for server in due {
            if !self.recheck(state, conn, &server).await {
                return false;
            }
            if !self.retry.pending() {
                self.deadlines.remove(&server);
            }
        }
        true
    }

    async fn recheck(&mut self, state: &AppState, conn: u64, name: &str) -> bool {
        if self.retry.pending() || !self.held(name) {
            return true;
        }
        let started = Instant::now();
        match still_held(&state.read(), self, name).await {
            Ok(true) => true,
            Ok(false) => self.refresh(state, conn).await,
            Err(e) => self.hold(e, started),
        }
    }
}

async fn reauthorize(state: &AppState, access: &mut Access) -> sqlx::Result<bool> {
    let db = &state.read();
    // The appear-offline setting comes from the primary: a replica behind it would announce a
    // stale value, and only a newer one replaces what the presence replica holds.
    let (servers, mode) = match &access.user {
        Some(user) => {
            if let Some(token) = &access.token
                && !session_of(db, token).await?
            {
                return Ok(false);
            }
            let Some(mode) = presence_mode(&state.db, user).await? else {
                return Ok(false);
            };
            (member_servers_of(db, user).await?, Some(mode))
        }
        None => {
            if !setting_on(db, "guests_enabled").await? {
                return Ok(false);
            }
            (HashSet::new(), None)
        }
    };
    let mut kept = HashSet::new();
    for server in access.subs.iter() {
        let allowed = match &access.user {
            Some(user) => authed_sub_ok(db, server, user, access.site_admin).await?,
            None => {
                let grant = access.grants.get(server).map(String::as_str);
                guest_sub_ok(db, server, grant).await?
            }
        };
        if allowed {
            kept.insert(server.clone());
        }
    }
    access.viewable.clear();
    access.floors.clear();
    if access.member_servers != servers {
        access.hosted_scope = None;
    }
    access.member_servers = servers;
    if let Some(mode) = mode {
        access.take_mode(mode);
    }
    access.grants.retain(|server, _| kept.contains(server));
    access.deadlines = grant_deadlines(db, &access.grants).await?;
    access.subs = kept;
    access.tidy_peek();
    if let (Some(user), Some(server), None) = (&access.user, &access.looking, &access.peek)
        && !access.member_servers.contains(server)
        && !access.subs.contains(server)
        && authed_sub_ok(db, server, user, access.site_admin).await?
    {
        access.peek = Some(server.clone());
        access.subs.insert(server.clone());
    }
    if access
        .viewing
        .as_ref()
        .is_some_and(|s| !access.member_servers.contains(s))
    {
        access.viewing = None;
    }
    access.topics_dirty = true;
    Ok(true)
}

async fn grant_deadlines(
    db: &Db,
    grants: &HashMap<String, String>,
) -> sqlx::Result<HashMap<String, i64>> {
    let mut deadlines = HashMap::new();
    for (server, grant) in grants {
        if let Some(at) = ws_grant_deadline(db, server, grant).await? {
            deadlines.insert(server.clone(), at);
        }
    }
    Ok(deadlines)
}

async fn still_held(db: &Db, access: &Access, name: &str) -> sqlx::Result<bool> {
    if server_password_hash(db, name).await?.is_none() {
        return Ok(true);
    }
    match &access.user {
        Some(user) => {
            if access.member_servers.contains(name) && !is_member(db, name, user).await? {
                return Ok(false);
            }
            authed_sub_ok(db, name, user, access.site_admin).await
        }
        None => guest_sub_ok(db, name, access.grants.get(name).map(String::as_str)).await,
    }
}

fn self_grant<'a>(ev: &'a WsEvent, me: Option<&str>) -> Option<&'a str> {
    match ev {
        WsEvent::MemberJoined { server, member } if Some(member.user.username.as_str()) == me => {
            Some(server.as_str())
        }
        WsEvent::ServerCreated { server } if me.is_some() && server.creator.as_deref() == me => {
            Some(server.name.as_str())
        }
        _ => None,
    }
}

async fn channel_public(db: &Db, cid: i64) -> sqlx::Result<Option<(String, bool)>> {
    let Some((owner, _)) = channel_now(db, cid).await? else {
        return Ok(None);
    };
    let restricted = sqlx::query("SELECT 1 FROM channels c WHERE c.id = $1 AND (c.restrict_view <> 0 OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = c.id AND cp.can_view = 0))")
        .bind(cid)
        .fetch_optional(db)
        .await?
        .is_some();
    Ok(Some((owner, !restricted)))
}

async fn channel_view(
    db: &Db,
    username: Option<&str>,
    cid: i64,
) -> sqlx::Result<Option<(String, bool)>> {
    let Some((owner, _)) = channel_now(db, cid).await? else {
        return Ok(None);
    };
    let view = ws_channel_view(db, &owner, cid, username).await?;
    Ok(Some((owner, view)))
}

async fn channel_gate(
    state: &AppState,
    access: &mut Access,
    server: &str,
    cid: i64,
) -> Option<bool> {
    if let Some((owner, view)) = access.viewable.get(&cid) {
        return Some(*view && owner == server);
    }
    let started = Instant::now();
    let slot = state.hub.channels().slot(cid);
    let read = state.read();
    let shared = slot
        .get_or_try_init(|| channel_public(&read, cid))
        .await
        .cloned();
    let looked = match shared {
        Ok(Some((owner, true))) => Ok(Some((owner, true))),
        Ok(Some((_, false))) => channel_view(&state.read(), access.user.as_deref(), cid).await,
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    };
    match looked {
        Ok(Some((owner, view))) => {
            let open = view && owner == server;
            access.viewable.insert(cid, (owner, view));
            Some(open)
        }
        Ok(None) => Some(false),
        Err(e) => access.hold(e, started).then_some(false),
    }
}

/// Whether a connection could view a channel that is now deleted: its own memo when it has one,
/// else the channel's view rules taken before the delete. Without rules (an event from an older
/// node) only the memo counts. `None` when the connection must close.
async fn deleted_gate(
    state: &AppState,
    access: &mut Access,
    server: &str,
    known: Option<bool>,
    rules: Option<&ViewRules>,
) -> Option<bool> {
    if let Some(view) = known {
        return Some(view);
    }
    let Some(rules) = rules else {
        return Some(false);
    };
    let started = Instant::now();
    match ws_view_under(&state.read(), server, rules, access.user.as_deref()).await {
        Ok(view) => Some(view),
        Err(e) => access.hold(e, started).then_some(false),
    }
}

async fn on_event(state: &AppState, conn: u64, access: &mut Access, ev: &WsEvent) -> Option<bool> {
    if !access.past_deadlines(state, conn).await {
        return None;
    }
    if let (Some(server), Some(user)) = (self_grant(ev, access.user.as_deref()), &access.user) {
        let started = Instant::now();
        match is_member(&state.read(), server, user).await {
            Ok(true) => {}
            Ok(false) => return Some(false),
            Err(e) => return access.hold(e, started).then_some(false),
        }
    }
    let mut deliver = access.wants(ev);
    if deliver
        && let WsEvent::MemberTimeout {
            server,
            username,
            until: _,
            remaining: _,
            reason: _,
        } = ev
        && let Some(me) = access.user.as_deref()
        && me != username
    {
        let started = Instant::now();
        match ws_sees_timeouts(&state.read(), server, me, access.site_admin).await {
            Ok(sees) => deliver = sees,
            Err(e) => return access.hold(e, started).then_some(false),
        }
    }
    let known = match ev {
        WsEvent::ChannelDeleted {
            server,
            channel_id,
            rules: _,
        } => access
            .viewable
            .get(channel_id)
            .map(|(owner, view)| *view && owner == server),
        _ => None,
    };
    track(ev, access);
    if let WsEvent::MemberLeft { server, username }
    | WsEvent::MemberKicked {
        server,
        username,
        banned: false,
    } = ev
        && access.user.as_deref() == Some(username.as_str())
        && !access.recheck(state, conn, server).await
    {
        return None;
    }
    if let WsEvent::ServerRenamed {
        old_name: _,
        server,
    }
    | WsEvent::ServerUpdated { server }
    | WsEvent::ServerCreated { server } = ev
        && !access.recheck(state, conn, &server.name).await
    {
        return None;
    }
    if let WsEvent::ServerRenamed {
        old_name: _,
        server,
    }
    | WsEvent::ServerUpdated { server } = ev
    {
        deliver &= access.site_admin || access.held(&server.name);
    }
    if access.retry.pending() {
        deliver &= access.wants(ev);
    }
    if deliver && let Some((server, cid)) = event_channel(ev) {
        deliver = channel_gate(state, access, server, cid).await?;
    }
    if deliver
        && let WsEvent::PollUpdated {
            server: Some(server),
            channel_id: Some(cid),
            created_at,
            ..
        } = ev
    {
        deliver = access
            .floor(state, server, *cid)
            .await
            .is_some_and(|floor| floor.is_none_or(|floor| *created_at >= floor));
    }
    if deliver
        && let WsEvent::ChannelDeleted {
            server,
            channel_id: _,
            rules,
        } = ev
    {
        deliver = deleted_gate(state, access, server, known, rules.as_ref()).await?;
    }
    if deliver {
        deliver = !hosting_via_who(access, ev);
    }
    Some(deliver)
}

// Hosted ids are read capabilities, and the broadcast of a hoster goes to all who share a server
// with them. So others learn about hosting only through p2p_who: filtered to the ids they can
// read. Answers carry no peer ids: a peer id reaches a reader only through a p2p release.
fn hosting_via_who(access: &mut Access, ev: &WsEvent) -> bool {
    let me = access.user.as_deref();
    match ev {
        WsEvent::P2pAvailability {
            hoster,
            peer_id: _,
            ids: _,
            online: true,
            scope_servers: _,
            scope_users: _,
        } if me != Some(hoster.as_str()) => {
            access.who.soon(hoster, Instant::now());
            true
        }
        WsEvent::Message {
            server: _,
            channel_id: _,
            dm_id: _,
            dm_users: _,
            message,
        } => {
            if let Some(media) = &message.media
                && media.kind == MediaKind::P2p
                && let Some(hoster) = &media.hoster
                && me != Some(hoster.as_str())
            {
                access.who.media.remove(&(hoster.clone(), media.id.clone()));
                access.who.soon(hoster, Instant::now());
            }
            false
        }
        _ => false,
    }
}

enum Sent {
    Queued,
    Full,
    Closed,
}

struct Out {
    tx: mpsc::Sender<Frame>,
}

impl Out {
    fn spawn(mut sink: SplitSink<WebSocket, Frame>) -> Out {
        let (tx, mut rx) = mpsc::channel::<Frame>(OUT_FRAMES);
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                match tokio::time::timeout(SEND_TIMEOUT, sink.send(frame)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) | Err(_) => break,
                }
            }
            let _ = tokio::time::timeout(SEND_TIMEOUT, sink.close()).await;
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

    fn event(&self, ev: &WsEvent) -> Sent {
        match serde_json::to_string(ev) {
            Ok(json) => self.text(json.into()),
            Err(_) => Sent::Queued,
        }
    }
}

async fn answer_who(state: &AppState, access: &mut Access, out: &Out) -> bool {
    let me = access.user.clone();
    for hoster in std::mem::take(&mut access.who.pending) {
        let shown = match &me {
            Some(me) => p2p_visible(state, access, me, &hoster).await,
            None => None,
        };
        let ev = match shown {
            Some(ids) => WsEvent::P2pAvailability {
                hoster,
                peer_id: None,
                ids,
                online: true,
                scope_servers: Vec::new(),
                scope_users: Vec::new(),
            },
            None => p2p_offline(hoster, Vec::new(), Vec::new()),
        };
        if !sent(access, out.event(&ev)) {
            return false;
        }
    }
    true
}

fn sent(access: &mut Access, res: Sent) -> bool {
    match res {
        Sent::Queued => true,
        Sent::Full => {
            access.missed = true;
            true
        }
        Sent::Closed => false,
    }
}

struct Bucket {
    tokens: f64,
    at: Instant,
    rate: f64,
    burst: f64,
}

impl Bucket {
    fn new() -> Bucket {
        Bucket::with(MSG_RATE, MSG_BURST)
    }

    fn with(rate: f64, burst: f64) -> Bucket {
        Bucket {
            tokens: burst,
            at: Instant::now(),
            rate,
            burst,
        }
    }

    fn take(&mut self, now: Instant) -> Option<bool> {
        let refill = now.duration_since(self.at).as_secs_f64() * self.rate;
        self.tokens = (self.tokens + refill).min(self.burst) - 1.0;
        self.at = now;
        match self.tokens {
            t if t >= 0.0 => Some(true),
            t if t < -self.burst => None,
            _ => Some(false),
        }
    }
}

fn typing_event(place: &TypingPlace, scope: &str, username: &str, until: i64) -> WsEvent {
    let TypingPlace {
        server,
        channel_id,
        dm_id,
        dm_users,
        display_name,
    } = place.clone();
    WsEvent::Typing {
        server,
        channel_id,
        dm_id,
        dm_users,
        scope: scope.to_string(),
        username: username.to_string(),
        display_name,
        until,
    }
}

// One connection's typing indicator: at most one scope at a time, checked against the send
// gate whenever it is shown again. Starts are paced; a stop only ends the one shown.
struct Typer {
    bucket: Bucket,
    active: Option<(String, TypingPlace, Instant)>,
}

impl Typer {
    fn new() -> Typer {
        Typer {
            bucket: Bucket::with(TYPING_RATE, TYPING_BURST),
            active: None,
        }
    }

    fn stop(&mut self, user: &str) -> Option<WsEvent> {
        let (scope, place, at) = self.active.take()?;
        (at.elapsed() < Duration::from_secs(TYPING_TTL as u64))
            .then(|| typing_event(&place, &scope, user, 0))
    }

    // The events a `typing` (`on`) or `typing_stop` command gives, in order.
    async fn command(&mut self, db: &Db, user: &str, scope: String, on: bool) -> Vec<WsEvent> {
        let at = Instant::now();
        let Some(scope) = (scope.len() <= TYPING_SCOPE_MAX)
            .then(|| typing_scope(&scope))
            .flatten()
            .map(|(kind, id)| format!("{kind}{id}"))
        else {
            return Vec::new();
        };
        let same = self.active.as_ref().is_some_and(|(s, _, _)| *s == scope);
        if !on {
            return match same {
                true => self.stop(user).into_iter().collect(),
                false => Vec::new(),
            };
        }
        if same
            && let Some((_, _, since)) = &self.active
            && at.duration_since(*since) < TYPING_REFRESH
        {
            return Vec::new();
        }
        let allowed = self.bucket.take(at) == Some(true);
        self.bucket.tokens = self.bucket.tokens.max(-TYPING_BURST);
        if !allowed {
            return Vec::new();
        }
        let place = ws_typing_place(db, user, &scope).await;
        let mut out: Vec<WsEvent> = match (same, &place) {
            (true, Some(_)) => {
                self.active = None;
                Vec::new()
            }
            (_, _) => self.stop(user).into_iter().collect(),
        };
        if let Some(place) = place {
            out.push(typing_event(&place, &scope, user, now() + TYPING_TTL));
            self.active = Some((scope, place, at));
        }
        out
    }
}

async fn type_in(state: &AppState, access: &Access, typer: &mut Typer, scope: String, on: bool) {
    let Some(user) = access.user.as_deref() else {
        return;
    };
    if on && access.retry.pending() {
        return;
    }
    for ev in typer.command(&state.read(), user, scope, on).await {
        state.hub.broadcast(ev);
    }
}

fn client_frame(fanned: &crate::fanout::Fanned, me: Option<&str>) -> Option<Utf8Bytes> {
    match (&fanned.ev, me) {
        (WsEvent::MembersPurged { server, usernames }, Some(me))
            if usernames.iter().any(|u| u == me) =>
        {
            serde_json::to_string(&WsEvent::MemberKicked {
                server: server.clone(),
                username: me.to_string(),
                banned: false,
            })
            .ok()
            .map(Utf8Bytes::from)
        }
        (
            WsEvent::MemberTimeout {
                server: _,
                username,
                until: _,
                remaining: _,
                reason: _,
            },
            Some(me),
        ) if username == me => None,
        (
            WsEvent::LayoutChanged {
                server: _,
                layout: _,
                created: _,
                deleted: _,
            }
            | WsEvent::ChannelCreated {
                server: _,
                channel: _,
            }
            | WsEvent::ChannelRenamed {
                server: _,
                channel: _,
            }
            | WsEvent::ChannelUpdated {
                server: _,
                channel: _,
            },
            _,
        ) => None,
        (_, _) => fanned.frame(),
    }
}

/// A `member_timeout` about the connection's own user: without the reason unless they hold
/// Timeout members themselves. `Some(None)` for other events; `None` when the connection must
/// close.
async fn own_timeout(
    state: &AppState,
    access: &mut Access,
    ev: &WsEvent,
) -> Option<Option<WsEvent>> {
    let WsEvent::MemberTimeout {
        server,
        username,
        until,
        remaining,
        reason,
    } = ev
    else {
        return Some(None);
    };
    if access.user.as_deref() != Some(username.as_str()) {
        return Some(None);
    }
    let started = Instant::now();
    let sees = match ws_sees_timeouts(&state.read(), server, username, access.site_admin).await {
        Ok(sees) => sees,
        Err(e) => return access.hold(e, started).then_some(None),
    };
    Some(Some(WsEvent::MemberTimeout {
        server: server.clone(),
        username: username.clone(),
        until: *until,
        remaining: *remaining,
        reason: reason.clone().filter(|_| sees),
    }))
}

/// `poll_updated` of an open `after_vote` poll for a connection whose account voted in it:
/// with the counts the shared event leaves out. `None` for everything else.
async fn poll_for(state: &AppState, access: &Access, ev: &WsEvent) -> Option<WsEvent> {
    let WsEvent::PollUpdated {
        server,
        channel_id,
        dm_id,
        dm_users,
        message_id,
        thread_root_id,
        created_at,
        poll,
    } = ev
    else {
        return None;
    };
    if poll.results.is_some()
        || poll.closed
        || poll.show_results != crate::api::polls::ShowResults::AfterVote
    {
        return None;
    }
    let (user, since) = (access.user.as_deref()?, access.since?);
    let results =
        crate::api::polls::voter_results(&state.read(), *message_id, poll.anonymous, user, since)
            .await?;
    Some(WsEvent::PollUpdated {
        server: server.clone(),
        channel_id: *channel_id,
        dm_id: *dm_id,
        dm_users: dm_users.clone(),
        message_id: *message_id,
        thread_root_id: *thread_root_id,
        created_at: *created_at,
        poll: Box::new(crate::api::polls::Poll {
            results: Some(results),
            ..(**poll).clone()
        }),
    })
}

/// A channel event for one connection, with the channel's `position` counted among the channels
/// that connection can see. `Some(None)` for other events or when the order can't be loaded;
/// `None` when the connection must close.
async fn channel_for(
    state: &AppState,
    access: &mut Access,
    fanned: &crate::fanout::Fanned,
) -> Option<Option<WsEvent>> {
    let (server, channel) = match &fanned.ev {
        WsEvent::ChannelCreated { server, channel }
        | WsEvent::ChannelRenamed { server, channel }
        | WsEvent::ChannelUpdated { server, channel } => (server, channel),
        _ => return Some(None),
    };
    let started = Instant::now();
    let order = match fanned.channel_order(&state.read(), server).await {
        Ok(order) => order,
        Err(e) => return access.hold(e, started).then_some(None),
    };
    let mut position = 0;
    for cid in order.iter().take_while(|c| **c != channel.id) {
        if channel_gate(state, access, server, *cid).await? {
            position += 1;
        }
    }
    let channel = Channel {
        position,
        ..channel.clone()
    };
    let server = server.clone();
    Some(Some(match &fanned.ev {
        WsEvent::ChannelCreated {
            server: _,
            channel: _,
        } => WsEvent::ChannelCreated { server, channel },
        WsEvent::ChannelRenamed {
            server: _,
            channel: _,
        } => WsEvent::ChannelRenamed { server, channel },
        _ => WsEvent::ChannelUpdated { server, channel },
    }))
}

/// `layout_changed` for one connection: only the channels it can view, and only the categories
/// that hold one of them, unless it manages channels. `Some(None)` when it comes from creating or
/// deleting a channel the connection can't view (its layout is the same); `None` when the
/// connection must close.
async fn layout_for(
    state: &AppState,
    access: &mut Access,
    server: &str,
    layout: &ChannelLayout,
    created: Option<i64>,
    deleted: Option<&ViewRules>,
) -> Option<Option<WsEvent>> {
    if let Some(cid) = created
        && !channel_gate(state, access, server, cid).await?
    {
        return Some(None);
    }
    if deleted.is_some() && !deleted_gate(state, access, server, None, deleted).await? {
        return Some(None);
    }
    let mut uncategorized = Vec::new();
    for cid in &layout.uncategorized {
        if channel_gate(state, access, server, *cid).await? {
            uncategorized.push(*cid);
        }
    }
    let mut categories = Vec::new();
    let mut manages = None;
    for category in &layout.categories {
        let mut channels = Vec::new();
        for cid in &category.channels {
            if channel_gate(state, access, server, *cid).await? {
                channels.push(*cid);
            }
        }
        if channels.is_empty() && manages.is_none() {
            let started = Instant::now();
            manages = match crate::api::access::ws_manages_channels(
                &state.read(),
                server,
                access.user.as_deref(),
            )
            .await
            {
                Ok(m) => Some(m),
                Err(e) => match access.hold(e, started) {
                    true => Some(false),
                    false => return None,
                },
            };
        }
        if !channels.is_empty() || manages == Some(true) {
            categories.push(LayoutCategory {
                id: category.id,
                name: category.name.clone(),
                channels,
            });
        }
    }
    Some(Some(WsEvent::LayoutChanged {
        server: server.to_string(),
        layout: ChannelLayout {
            version: layout.version,
            uncategorized,
            categories,
        },
        created: None,
        deleted: None,
    }))
}

const PRESENCE_SNAPSHOT_MAX: usize = 50;

fn presence_snapshot(hub: &Hub, access: &Access, server: &str) -> Option<WsEvent> {
    if access.retry.pending() || !access.held(server) {
        return None;
    }
    let mut online = hub.online_after(server, None, PRESENCE_SNAPSHOT_MAX);
    let mut online_count = hub.online_count(server);
    if let Some(user) = access.user.as_deref()
        && access.shows(server)
        && !hub.is_online(server, user)
    {
        online_count += 1;
        if let Err(at) = online.binary_search_by(|n| n.as_str().cmp(user)) {
            online.insert(at, user.to_string());
            online.truncate(PRESENCE_SNAPSHOT_MAX);
        }
    }
    Some(WsEvent::PresenceSnapshot {
        server: server.to_string(),
        online,
        online_count,
    })
}

async fn send_voice_snapshot(state: &AppState, out: &Out, access: &mut Access) -> bool {
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

/// Close codes of realtime connections closed for a limit: the user opened more than
/// `CONNS_PER_USER` at once (this, the oldest, was closed; reconnect only when used again), or
/// opened too many in a short time (retry later, like a 429).
pub const CLOSE_TOO_MANY: (u16, &str) = (4008, "Too many open connections for this account");
pub const CLOSE_TOO_OFTEN: (u16, &str) = (4029, "Too many connection attempts, try again later");

fn close_frame((code, reason): (u16, &str)) -> Frame {
    Frame::Close(Some(CloseFrame {
        code,
        reason: Utf8Bytes::from(reason),
    }))
}

fn refuse(e: sqlx::Error) {
    match AUTH_FAILED.admit(Instant::now()) {
        true => warn!(
            "refused a realtime connection because its account could not be loaded; the client retries: {e}"
        ),
        false => debug!("refused a realtime connection whose account could not be loaded: {e}"),
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

/// Which of `ids` are live P2P attachments hosted by `user`: not removed, not expired. `None`
/// when the database can't say, so nothing is dropped by mistake.
async fn live_hosted(db: &Db, user: &str, ids: &[String]) -> Option<Vec<String>> {
    if ids.is_empty() {
        return Some(Vec::new());
    }
    let sql = format!(
        "SELECT DISTINCT media_id FROM messages WHERE media_kind = 'p2p' AND media_removed = 0 AND media_hoster = $1 AND (media_expires_at IS NULL OR media_expires_at > $2) AND media_id IN ({})",
        crate::api::placeholders(3, ids.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(user)
        .bind(crate::db::now());
    for id in ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(db).await.ok()?;
    Some(
        rows.iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .collect(),
    )
}

fn hosting_ids(ids: Vec<String>) -> Vec<String> {
    ids.into_iter()
        .filter(|id| id.len() <= P2P_ID_MAX)
        .take(P2P_IDS_CAP)
        .collect()
}

async fn run(state: AppState, mut socket: WebSocket) {
    let conn = state.hub.next_conn();
    let token = loop {
        match socket.recv().await {
            Some(Ok(Frame::Text(text))) => match serde_json::from_str::<ClientMsg>(&text) {
                Ok(ClientMsg::Auth { token }) => break token,
                Ok(_) | Err(_) => break None,
            },
            Some(Ok(Frame::Close(_))) | Some(Err(_)) | None => return,
            Some(Ok(_)) => {}
        }
    };
    let mut inbox = state.hub.open(conn, &HashSet::from([Topic::All]));
    let _listening = Listening {
        hub: state.hub.clone(),
        conn,
    };
    let mut epoch = state.hub.epoch();
    let mut lossy = epoch.borrow_and_update().lossy;
    let (username, is_site_admin, since): (Option<String>, bool, Option<i64>) = match &token {
        Some(token) => {
            let row = sqlx::query(
                "SELECT u.username, u.is_site_admin, u.created_at FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1 AND u.password_hash <> '!purging'",
            )
            .bind(crate::db::secret_key(token))
            .fetch_optional(&state.read())
            .await;
            match row {
                Ok(Some(r)) => (
                    r.try_get(0).ok(),
                    r.try_get::<i64, _>(1).map(|v| v != 0).unwrap_or(false),
                    r.try_get(2).ok(),
                ),
                Ok(None) => (None, false, None),
                Err(e) => return refuse(e),
            }
        }
        None => (None, false, None),
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
        Some(user) => match member_servers_of(&state.read(), user).await {
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
    }
    let mut access = Access::new(username, is_site_admin, member_servers);
    if let Some(mode) = mode {
        access.take_mode(mode);
    }
    access.since = since;
    access.token = token.filter(|_| access.user.is_some());
    state.hub.reconcile(conn, &access.topics(), 0);
    let (sink, mut stream) = socket.split();
    let out = Out::spawn(sink);
    let mut through = 0;
    let mut bucket = Bucket::new();
    let mut typer = Typer::new();
    let mut ping = tokio::time::interval_at(Instant::now() + PING_EVERY, PING_EVERY);
    let mut heard = Instant::now();
    let mut lag = Pace::new(LAG_REAUTH_EVERY);
    if !send_voice_snapshot(&state, &out, &mut access).await {
        return;
    }
    access.sync(&state.hub, conn);
    loop {
        tokio::select! {
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
                    if deliver && let WsEvent::LayoutChanged { server, layout, created, deleted } = ev {
                        let Some(mine) = layout_for(&state, &mut access, server, layout, *created, deleted.as_ref()).await else {
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
                    let mine = match deliver {
                        true => poll_for(&state, &access, ev).await,
                        false => None,
                    };
                    if let Some(mine) = &mine && !sent(&mut access, out.event(mine)) {
                        break;
                    }
                    if deliver
                        && mine.is_none()
                        && let Some(frame) = client_frame(&fanned, access.user.as_deref())
                        && !sent(&mut access, out.text(frame))
                    {
                        break;
                    }
                    match ev {
                        WsEvent::Banned { username: banned } if Some(banned.as_str()) == access.user.as_deref() => break,
                        WsEvent::TokensRevoked { username: user } if Some(user.as_str()) == access.user.as_deref() && !access.check_token(&state.read()).await => break,
                        WsEvent::SettingsChanged { settings } if access.user.is_none() && !settings.guests_enabled => break,
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
                    match bucket.take(heard) {
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
                            let servers: Vec<String> = servers.into_iter().take(SUBSCRIBE_CAP).map(|s| s.to_lowercase()).collect();
                            let early: Vec<Topic> = servers.iter().flat_map(|s| [Topic::Server(s.clone()), Topic::View(s.clone())]).collect();
                            state.hub.listen(conn, &early);
                            let peek = access.peek.take();
                            access.subs.clear();
                            access.grants.clear();
                            access.topics_dirty = true;
                            for s in servers {
                                let grant = grants.get(&s).cloned();
                                let allowed = match &access.user {
                                    Some(user) => authed_sub_ok(&state.read(), &s, user, access.site_admin).await.unwrap_or(false),
                                    None => guest_sub_ok(&state.read(), &s, grant.as_deref()).await.unwrap_or(false),
                                };
                                if allowed {
                                    if let Some(g) = grant {
                                        access.grants.insert(s.clone(), g);
                                    }
                                    access.subs.insert(s);
                                }
                            }
                            access.deadlines = match grant_deadlines(&state.read(), &access.grants).await {
                                Ok(deadlines) => deadlines,
                                Err(_) => access.grants.keys().map(|s| (s.clone(), 0)).collect(),
                            };
                            access.set_peek(peek);
                            if !send_voice_snapshot(&state, &out, &mut access).await {
                                break;
                            }
                        }
                        Ok(ClientMsg::P2pHosting { peer_id, ids }) => {
                            if let Some(user) = access.user.clone() && crate::p2p::valid_peer_id(&peer_id) {
                                let ids = hosting_ids(ids);
                                let (live, checked) = match live_hosted(&state.read(), &user, &ids).await {
                                    Some(live) => (live, ids.clone()),
                                    None => (Vec::new(), Vec::new()),
                                };
                                let key = hex::encode(crate::p2p::host_key(&state.instance.p2p_secret, &user, &peer_id));
                                access.host(&state, conn, (peer_id.clone(), ids)).await;
                                let hosted = WsEvent::P2pHosted { live, checked, key, peer_id, now: now() };
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
                            let leaving = matches!(other, ClientMsg::VoiceLeave | ClientMsg::CallLeave { dm_id: _ } | ClientMsg::CallDecline { dm_id: _ });
                            let res = match (&access.user, access.retry.pending() && !leaving) {
                                (Some(_), true) => Err(RECONNECTING.to_string()),
                                (Some(user), false) => voice_msg(&state, user, conn, other).await,
                                (None, _) => Err("Create an account to join voice".to_string()),
                            };
                            if let Err(message) = res
                                && !sent(&mut access, out.event(&WsEvent::Error { message }))
                            {
                                break;
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
            }
            _ = out.tx.closed() => break,
        }
        if std::mem::take(&mut access.topics_dirty) {
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
    if inbox.evicted() {
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
}

async fn look(
    state: &AppState,
    conn: u64,
    access: &mut Access,
    server: Option<String>,
) -> Option<String> {
    let server = server.map(|s| s.to_lowercase());
    access.looking = server.clone().filter(|_| access.user.is_some());
    let (target, peek, seen) = match (access.user.clone(), server) {
        (Some(user), Some(s)) if !ws_banned(&state.read(), &s, &user).await.unwrap_or(true) => {
            state
                .hub
                .listen(conn, &[Topic::View(s.clone()), Topic::Server(s.clone())]);
            let member = is_member(&state.read(), &s, &user).await.unwrap_or(false);
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
    if let Some(s) = &seen {
        access.topics_dirty |= !access.held(s);
    }
    access.view(&state.hub, conn, target);
    seen
}

fn join(access: &mut Access, server: String) {
    access.moved.push(server.clone());
    access.member_servers.insert(server);
    access.hosted_scope = None;
    access.viewable.clear();
    access.floors.clear();
    access.who.forget();
    access.topics_dirty = true;
}

fn forget_server(access: &mut Access, server: &str) {
    access.viewable.retain(|_, (owner, _)| owner != server);
    access.floors.clear();
    access.who.forget();
}

fn leave(access: &mut Access, server: &str) {
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

fn track(ev: &WsEvent, access: &mut Access) {
    let me = access.user.as_deref();
    match ev {
        WsEvent::MemberJoined { server, member } => {
            if Some(member.user.username.as_str()) == me {
                join(access, server.clone());
            }
        }
        WsEvent::MemberLeft { server, username }
        | WsEvent::MemberKicked {
            server,
            username,
            banned: false,
        } => {
            if Some(username.as_str()) == me {
                leave(access, server);
            }
        }
        WsEvent::MemberKicked {
            server,
            username,
            banned: true,
        }
        | WsEvent::ServerBanned { server, username } => {
            if Some(username.as_str()) == me {
                leave(access, server);
                access.subs.remove(server);
                access.grants.remove(server);
                if access.looking.as_deref() == Some(server.as_str()) {
                    access.looking = None;
                }
            }
        }
        WsEvent::MembersPurged { server, usernames } => {
            if me.is_some_and(|me| usernames.iter().any(|u| u == me)) {
                leave(access, server);
            }
        }
        WsEvent::ServerCreated { server } => {
            if server.creator.as_deref() == me {
                join(access, server.name.clone());
            }
        }
        WsEvent::AdminChanged {
            server,
            username,
            is_admin: _,
            perms: _,
        } => {
            if Some(username.as_str()) == me {
                forget_server(access, server);
            }
        }
        WsEvent::RolesChanged { server } => forget_server(access, server),
        WsEvent::ChannelPermsChanged {
            server: _,
            channel_id,
        }
        | WsEvent::ChannelDeleted {
            server: _,
            channel_id,
            rules: _,
        } => {
            access.viewable.remove(channel_id);
            access.floors.clear();
            access.who.forget();
        }
        WsEvent::ServerRenamed { old_name, server } => {
            access.topics_dirty |= access.held(old_name);
            if access.member_servers.remove(old_name) {
                access.member_servers.insert(server.name.clone());
                access.moved.extend([old_name.clone(), server.name.clone()]);
                access.hosted_scope = None;
            }
            if access.subs.remove(old_name) {
                access.subs.insert(server.name.clone());
            }
            if let Some(at) = access.deadlines.remove(old_name) {
                access.deadlines.insert(server.name.clone(), at);
            }
            if let Some(grant) = access.grants.remove(old_name) {
                access.grants.insert(server.name.clone(), grant);
            }
            for slot in [&mut access.viewing, &mut access.peek, &mut access.looking] {
                if slot.as_deref() == Some(old_name.as_str()) {
                    *slot = Some(server.name.clone());
                }
            }
            forget_server(access, old_name);
        }
        WsEvent::ServerUpdated { server } => forget_server(access, &server.name),
        WsEvent::ServerDeleted { name } => {
            access.topics_dirty |= access.held(name);
            if access.member_servers.remove(name) {
                access.moved.push(name.clone());
                access.hosted_scope = None;
            }
            access.subs.remove(name);
            if access.viewing.as_deref() == Some(name.as_str()) {
                access.viewing = None;
            }
            if access.looking.as_deref() == Some(name.as_str()) {
                access.looking = None;
            }
            forget_server(access, name);
        }
        _ => {}
    }
    access.tidy_peek();
}

fn event_channel(ev: &WsEvent) -> Option<(&str, i64)> {
    fn scoped<'a>(server: &'a Option<String>, channel_id: &Option<i64>) -> Option<(&'a str, i64)> {
        match (server, channel_id) {
            (Some(s), Some(c)) => Some((s.as_str(), *c)),
            (_, _) => None,
        }
    }
    match ev {
        WsEvent::Message {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message: _,
        } => scoped(server, channel_id),
        WsEvent::MessageUpdated {
            server,
            channel_id,
            update: _,
            dm_users: _,
        } => scoped(server, channel_id),
        WsEvent::MessageDeleted {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            id: _,
            thread_root_id: _,
        } => scoped(server, channel_id),
        WsEvent::MediaRemoved {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            removed_by_author: _,
        } => scoped(server, channel_id),
        WsEvent::EmbedsResolved {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            embeds: _,
        } => scoped(server, channel_id),
        WsEvent::EmbedsRemoved {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            ord: _,
            banner: _,
        } => scoped(server, channel_id),
        WsEvent::ReactionAdded {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            thread_root_id: _,
            emoji: _,
            username: _,
            count: _,
        }
        | WsEvent::ReactionRemoved {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            thread_root_id: _,
            emoji: _,
            username: _,
            count: _,
        }
        | WsEvent::PollUpdated {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            thread_root_id: _,
            created_at: _,
            poll: _,
        } => scoped(server, channel_id),
        WsEvent::MessagePinned {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            pinned_at: _,
            pinned_by: _,
        }
        | WsEvent::MessageUnpinned {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
        } => scoped(server, channel_id),
        WsEvent::ChannelCreated { server, channel }
        | WsEvent::ChannelRenamed { server, channel }
        | WsEvent::ChannelUpdated { server, channel } => Some((server.as_str(), channel.id)),
        WsEvent::VoiceState {
            server,
            channel_id,
            users: _,
        } => Some((server.as_str(), *channel_id)),
        WsEvent::VoiceMuted {
            server,
            channel_id,
            username: _,
            muted: _,
        } => Some((server.as_str(), *channel_id)),
        WsEvent::VoiceEnded {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            reason: _,
        } => scoped(server, channel_id),
        WsEvent::Typing {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            scope: _,
            username: _,
            display_name: _,
            until: _,
        } => scoped(server, channel_id),
        _ => None,
    }
}

fn wants(
    ev: &WsEvent,
    me: Option<&str>,
    is_site_admin: bool,
    member_servers: &HashSet<String>,
    subs: &HashSet<String>,
) -> bool {
    let in_server = |s: &String| member_servers.contains(s) || subs.contains(s);
    let scoped = |server: &Option<String>, dm_users: &Option<Vec<String>>| match server {
        Some(s) => in_server(s),
        None => match (me, dm_users) {
            (Some(user), Some(list)) => list.iter().any(|u| u == user),
            (_, _) => false,
        },
    };
    match ev {
        WsEvent::Message {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message: _,
        } => scoped(server, dm_users),
        WsEvent::MessageUpdated {
            server: Some(server),
            channel_id: _,
            update: _,
            dm_users: _,
        } => in_server(server),
        WsEvent::MessageUpdated {
            server: None,
            channel_id: _,
            update: _,
            dm_users,
        } => me.is_some_and(|user| dm_users.iter().any(|u| u == user)),
        WsEvent::MessageDeleted {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            id: _,
            thread_root_id: _,
        } => scoped(server, dm_users),
        WsEvent::MediaRemoved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            removed_by_author: _,
        } => scoped(server, dm_users),
        WsEvent::EmbedsResolved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            embeds: _,
        } => scoped(server, dm_users),
        WsEvent::EmbedsRemoved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            ord: _,
            banner: _,
        } => scoped(server, dm_users),
        WsEvent::ReactionAdded {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            thread_root_id: _,
            emoji: _,
            username: _,
            count: _,
        }
        | WsEvent::ReactionRemoved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            thread_root_id: _,
            emoji: _,
            username: _,
            count: _,
        }
        | WsEvent::PollUpdated {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            thread_root_id: _,
            created_at: _,
            poll: _,
        } => scoped(server, dm_users),
        WsEvent::MessagePinned {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            pinned_at: _,
            pinned_by: _,
        }
        | WsEvent::MessageUnpinned {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
        } => scoped(server, dm_users),
        WsEvent::ChannelCreated { server, channel: _ }
        | WsEvent::ChannelRenamed { server, channel: _ }
        | WsEvent::ChannelUpdated { server, channel: _ } => in_server(server),
        WsEvent::ChannelDeleted {
            server,
            channel_id: _,
            rules: _,
        } => in_server(server),
        WsEvent::MemberJoined { server, member } => {
            in_server(server) || Some(member.user.username.as_str()) == me
        }
        WsEvent::MemberLeft { server, username }
        | WsEvent::MemberKicked {
            server,
            username,
            banned: _,
        } => in_server(server) || Some(username.as_str()) == me,
        WsEvent::MembersPurged { server, usernames } => {
            in_server(server) || me.is_some_and(|user| usernames.iter().any(|u| u == user))
        }
        WsEvent::AdminChanged {
            server,
            username: _,
            is_admin: _,
            perms: _,
        } => in_server(server),
        WsEvent::RolesChanged { server } => in_server(server),
        WsEvent::ChannelPermsChanged {
            server,
            channel_id: _,
        } => in_server(server),
        WsEvent::LayoutChanged {
            server,
            layout: _,
            created: _,
            deleted: _,
        } => in_server(server),
        WsEvent::UserUpdated { user, scope } => {
            scope.is_empty()
                || Some(user.username.as_str()) == me
                || scope
                    .servers
                    .iter()
                    .chain(scope.views.iter())
                    .any(in_server)
                || me.is_some_and(|me| scope.users.iter().any(|u| u == me))
        }
        WsEvent::UserRegistered { user: _ } => is_site_admin,
        WsEvent::PresenceChanged {
            server,
            username: _,
            online: _,
            online_count: _,
        } => in_server(server),
        WsEvent::PresenceSnapshot {
            server: _,
            online: _,
            online_count: _,
        } => false,
        WsEvent::ServerBanned {
            server: _,
            username,
        }
        | WsEvent::PresenceMode {
            username,
            appear_offline: _,
            seq: _,
        }
        | WsEvent::ReadUpdated {
            username,
            scope: _,
            last_read: _,
            pings_until: _,
        }
        | WsEvent::Ping { username, ping: _ }
        | WsEvent::PingCount {
            username,
            scope: _,
            pings: _,
            pings_until: _,
            thread_pings: _,
        }
        | WsEvent::DmClosed { username, dm_id: _ }
        | WsEvent::DmReopened { username, dm_id: _ }
        | WsEvent::UserBlocked {
            username,
            blocked: _,
        }
        | WsEvent::UserUnblocked {
            username,
            blocked: _,
        }
        | WsEvent::PollVoted {
            username,
            message_id: _,
        }
        | WsEvent::FriendRequestAdded {
            username,
            request: _,
        }
        | WsEvent::FriendRequestRemoved { username, other: _ }
        | WsEvent::FriendAdded {
            username,
            friend: _,
        }
        | WsEvent::FriendRemoved {
            username,
            friend: _,
        }
        | WsEvent::FriendPresence {
            username,
            friend: _,
            online: _,
        }
        | WsEvent::PrivacyChanged {
            username,
            privacy: _,
        } => Some(username.as_str()) == me,
        WsEvent::ServerCreated { server } => {
            is_site_admin || (me.is_some() && server.creator.as_deref() == me)
        }
        WsEvent::ServerRenamed {
            old_name,
            server: _,
        } => is_site_admin || in_server(old_name),
        WsEvent::ServerUpdated { server } => is_site_admin || in_server(&server.name),
        WsEvent::ServerDeleted { name } => is_site_admin || in_server(name),
        WsEvent::Banned { username: _ } | WsEvent::SettingsChanged { settings: _ } => true,
        WsEvent::DmCreated { dm_id: _, dm_users } => {
            me.is_some_and(|user| dm_users.iter().any(|u| u == user))
        }
        WsEvent::VoiceState {
            server,
            channel_id: _,
            users: _,
        } => in_server(server),
        WsEvent::VoiceMuted {
            server,
            channel_id: _,
            username: _,
            muted: _,
        } => in_server(server),
        WsEvent::MemberTimeout {
            server,
            username,
            until: _,
            remaining: _,
            reason: _,
        } => Some(username.as_str()) == me || (me.is_some() && in_server(server)),
        WsEvent::CallState {
            dm_id: _,
            dm_users,
            state: _,
            from: _,
            kind: _,
            video: _,
            call_id: _,
            answered_at: _,
            peers: _,
        } => me.is_some_and(|user| dm_users.iter().any(|u| u == user)),
        WsEvent::P2pAvailability {
            hoster,
            peer_id: _,
            ids: _,
            online: _,
            scope_servers,
            scope_users,
        } => {
            Some(hoster.as_str()) == me
                || scope_servers.iter().any(in_server)
                || me.is_some_and(|user| scope_users.iter().any(|u| u == user))
        }
        WsEvent::RtcSignal {
            to,
            from: _,
            channel_id: _,
            dm_id: _,
            payload: _,
        } => Some(to.as_str()) == me,
        WsEvent::VoiceEnded {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            reason: _,
        } => scoped(server, dm_users),
        WsEvent::Typing {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            scope: _,
            username,
            display_name: _,
            until: _,
        } => me != Some(username.as_str()) && scoped(server, dm_users),
        WsEvent::Error { message: _ }
        | WsEvent::TokensRevoked { username: _ }
        | WsEvent::P2pHosted {
            live: _,
            checked: _,
            key: _,
            peer_id: _,
            now: _,
        }
        | WsEvent::P2pPeer {
            message_id: _,
            peer_id: _,
            token: _,
            expires_at: _,
            error: _,
        }
        | WsEvent::UserShown {
            username: _,
            online: _,
        }
        | WsEvent::Resync => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::db::AvatarKind;
    use tokio::sync::broadcast;

    fn message() -> Message {
        Message {
            id: 4,
            channel_id: None,
            dm_id: Some(2),
            thread_root_id: None,
            author: UserRef {
                username: "alice".to_string(),
                display_name: "Alice".to_string(),
                avatar_kind: AvatarKind::Identicon,
                avatar_color: None,
            },
            content: "hi".to_string(),
            created_at: 1,
            reply_count: 0,
            media: None,
            embeds: Vec::new(),
            kind: "user".to_string(),
            call: None,
            reactions: Vec::new(),
            reply_to: None,
            edited_at: None,
            forward: None,
            pinned_at: None,
            pin_message_id: None,
            group_mentions: Vec::new(),
            poll: None,
        }
    }

    #[test]
    fn routing_fields_stay_off_the_client_wire() {
        let availability = WsEvent::P2pAvailability {
            hoster: "alice".to_string(),
            peer_id: Some("peer".to_string()),
            ids: vec!["f1".to_string()],
            online: true,
            scope_servers: vec!["rchat".to_string()],
            scope_users: vec!["bob".to_string()],
        };
        assert_eq!(
            serde_json::to_string(&availability).unwrap(),
            r#"{"type":"p2p_availability","hoster":"alice","peer_id":"peer","ids":["f1"],"online":true}"#
        );
        let wire = to_bus_json(&availability).unwrap();
        assert!(
            wire.contains(r#""scope_servers":["rchat"]"#)
                && wire.contains(r#""scope_users":["bob"]"#)
        );
        let back: WsEvent = serde_json::from_str(&wire).unwrap();
        assert_eq!(to_bus_json(&back).unwrap(), wire);
        assert_eq!(
            serde_json::to_string(&back).unwrap(),
            serde_json::to_string(&availability).unwrap()
        );
        let updated = WsEvent::MessageUpdated {
            server: None,
            channel_id: None,
            update: Updated::full(message()),
            dm_users: vec!["alice".to_string(), "bob".to_string()],
        };
        let client = serde_json::to_string(&updated).unwrap();
        assert!(!client.contains("dm_users"));
        let back: WsEvent = serde_json::from_str(&to_bus_json(&updated).unwrap()).unwrap();
        assert!(
            matches!(&back, WsEvent::MessageUpdated { server: None, channel_id: None, update: Updated::Full { message: _ }, dm_users } if dm_users.len() == 2)
        );
        assert_eq!(serde_json::to_string(&back).unwrap(), client);
        let member = WsEvent::MemberJoined {
            server: "rchat".to_string(),
            member: Member {
                user: message().author,
                is_admin: false,
                is_creator: false,
                online: true,
                perms: 0,
                role_ids: vec![3],
                joined_via: None,
                timeout: None,
            },
        };
        let back: WsEvent = serde_json::from_str(&to_bus_json(&member).unwrap()).unwrap();
        assert_eq!(
            serde_json::to_string(&back).unwrap(),
            serde_json::to_string(&member).unwrap()
        );
    }

    async fn exec(db: &Db, sql: &'static str) {
        sqlx::query(sql).execute(db).await.unwrap();
    }

    async fn time_out(db: &Db, user: &str, until: i64) {
        sqlx::query("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', $1, $2, 0) ON CONFLICT(server, username) DO UPDATE SET until = excluded.until")
            .bind(user)
            .bind(until)
            .execute(db)
            .await
            .expect("timeout");
    }

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn after_vote_updates_carry_counts_only_for_voters() {
        let (state, path) = crate::api::test_util::temp_state("ws_poll_voters").await;
        let db = &state.db;
        for name in ["bob", "carol"] {
            add_user(db, name).await;
        }
        exec(db, "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1), ('rchat', 'carol', 1)").await;
        let pepper = crate::db::pepper(db).await.unwrap();
        for anonymous in [0, 1] {
            let id: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, kind, created_at) SELECT id, 'bob', 'q', 'poll', 5 FROM channels WHERE server = 'rchat' RETURNING id")
                .fetch_one(db)
                .await
                .unwrap()
                .try_get(0)
                .unwrap();
            sqlx::query("INSERT INTO polls(message_id, kind, question, anonymous, results, created_at) VALUES($1, 'single', 'q', $2, 'after_vote', 5)")
                .bind(id)
                .bind(anonymous)
                .execute(db)
                .await
                .unwrap();
            let option: i64 = sqlx::query("INSERT INTO poll_options(message_id, position, text, created_at) VALUES($1, 0, 'a', 5) RETURNING id")
                .bind(id)
                .fetch_one(db)
                .await
                .unwrap()
                .try_get(0)
                .unwrap();
            let voter = match anonymous {
                0 => "bob".to_string(),
                _ => crate::api::polls::anonymous_key(&pepper, id, "bob", 1),
            };
            sqlx::query("INSERT INTO poll_votes(message_id, voter, option_id, value, created_at) VALUES($1, $2, $3, 1, 6)")
                .bind(id)
                .bind(voter)
                .bind(option)
                .execute(db)
                .await
                .unwrap();
            let ev = crate::api::polls::update_event(db, id)
                .await
                .unwrap()
                .unwrap();
            let mut bob = Access::new(Some("bob".to_string()), false, set(&["rchat"]));
            bob.since = Some(1);
            let mut carol = Access::new(Some("carol".to_string()), false, set(&["rchat"]));
            carol.since = Some(1);
            let counts = |ev: Option<WsEvent>| match ev {
                Some(WsEvent::PollUpdated { poll, .. }) => poll
                    .results
                    .map(|r| r.counts.iter().map(|c| c.count).collect::<Vec<_>>()),
                _ => None,
            };
            assert_eq!(
                counts(Some(ev.clone())),
                None,
                "the shared event hides counts"
            );
            assert_eq!(
                counts(poll_for(&state, &bob, &ev).await),
                Some(vec![1]),
                "the voter's own copy has them"
            );
            assert!(
                poll_for(&state, &carol, &ev).await.is_none(),
                "others get the shared event"
            );
            bob.since = Some(2);
            assert_eq!(
                poll_for(&state, &bob, &ev).await.is_some(),
                anonymous == 0,
                "an anonymous vote belongs to the account that cast it"
            );
        }
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn poll_updates_respect_the_read_history_floor() {
        let (state, path) = crate::api::test_util::temp_state("ws_poll_floor").await;
        let db = &state.db;
        for name in ["bob", "erin", "nina"] {
            add_user(db, name).await;
        }
        exec(db, "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1), ('rchat', 'erin', 500)").await;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        let ev = |created_at: i64| WsEvent::PollUpdated {
            server: Some("rchat".to_string()),
            channel_id: Some(cid),
            dm_id: None,
            dm_users: None,
            message_id: 1,
            thread_root_id: None,
            created_at,
            poll: Box::new(crate::api::polls::sample_poll()),
        };
        let conn = state.hub.next_conn();
        let mut bob = Access::new(Some("bob".to_string()), false, set(&["rchat"]));
        let mut erin = Access::new(Some("erin".to_string()), false, set(&["rchat"]));
        let mut guest = Access::new(None, false, HashSet::new());
        guest.subs = set(&["rchat"]);
        for access in [&mut bob, &mut erin, &mut guest] {
            assert_eq!(
                on_event(&state, conn, access, &ev(100)).await,
                Some(true),
                "read history for all"
            );
        }
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:erin', 1, 1, 0)")
            .bind(cid)
            .execute(db)
            .await
            .unwrap();
        for access in [&mut bob, &mut erin, &mut guest] {
            access.viewable.clear();
            access.floors.clear();
        }
        assert_eq!(on_event(&state, conn, &mut bob, &ev(100)).await, Some(true));
        assert_eq!(
            on_event(&state, conn, &mut erin, &ev(100)).await,
            Some(false),
            "a poll from before erin joined"
        );
        assert_eq!(
            on_event(&state, conn, &mut erin, &ev(600)).await,
            Some(true)
        );
        assert_eq!(
            on_event(&state, conn, &mut guest, &ev(100)).await,
            Some(true)
        );
        let dm = WsEvent::PollUpdated {
            server: None,
            channel_id: None,
            dm_id: Some(1),
            dm_users: Some(vec!["bob".to_string(), "erin".to_string()]),
            message_id: 2,
            thread_root_id: None,
            created_at: 1,
            poll: Box::new(crate::api::polls::sample_poll()),
        };
        let mut nina = Access::new(Some("nina".to_string()), false, HashSet::new());
        assert_eq!(on_event(&state, conn, &mut erin, &dm).await, Some(true));
        assert_eq!(on_event(&state, conn, &mut nina, &dm).await, Some(false));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn reauthorize_drops_revoked_access() {
        let (state, path) = crate::api::test_util::temp_state("ws_reauthorize").await;
        exec(&state.db, "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, is_site_admin, created_at) VALUES('alice', 'alice', '', 'text', 'identicon', 0, 1)").await;
        exec(&state.db, "INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('vault', 'vault', 'hash', 1)").await;
        exec(
            &state.db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('open', 'open', 1)",
        )
        .await;
        exec(
            &state.db,
            "INSERT INTO members(server, username, joined_at) VALUES('vault', 'alice', 1)",
        )
        .await;
        let mut alice = Access::new(Some("alice".to_string()), false, HashSet::new());
        alice.subs = set(&["vault", "open", "gone"]);
        alice.viewing = Some("vault".to_string());
        alice.viewable = HashMap::from([(1, ("vault".to_string(), true))]);
        assert!(reauthorize(&state, &mut alice).await.unwrap());
        assert_eq!(alice.member_servers, set(&["vault"]));
        assert_eq!(alice.subs, set(&["vault", "open"]));
        assert_eq!(alice.viewing.as_deref(), Some("vault"));
        assert!(alice.viewable.is_empty());

        exec(&state.db, "DELETE FROM members WHERE server = 'vault'").await;
        assert!(reauthorize(&state, &mut alice).await.unwrap());
        assert!(alice.member_servers.is_empty());
        assert_eq!(alice.subs, set(&["open"]));
        assert_eq!(alice.viewing, None);

        exec(&state.db, "DELETE FROM users WHERE username = 'alice'").await;
        assert!(!reauthorize(&state, &mut alice).await.unwrap());

        let mut guest = Access::new(None, false, HashSet::new());
        guest.subs = set(&["vault", "open"]);
        guest.grants = HashMap::from([("vault".to_string(), "forged".to_string())]);
        assert!(reauthorize(&state, &mut guest).await.unwrap());
        assert_eq!(guest.subs, set(&["open"]));
        assert!(guest.grants.is_empty());
        exec(&state.db, "INSERT INTO settings(key, value) VALUES('guests_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value").await;
        assert!(!reauthorize(&state, &mut guest).await.unwrap());
        crate::api::test_util::done(state, path).await;
    }

    async fn add_user(db: &Db, name: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, is_site_admin, created_at) VALUES($1, $1, '', 'text', 'identicon', 0, 1)")
            .bind(name)
            .execute(db)
            .await
            .unwrap();
    }

    async fn post_message(db: &Db, channel_id: i64, content: &str) -> Message {
        let id: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', $2, 1) RETURNING id")
            .bind(channel_id)
            .bind(content)
            .fetch_one(db)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        load_message(db, id, Quotes::Since(None))
            .await
            .ok()
            .flatten()
            .unwrap()
    }

    async fn general(db: &Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'rchat' AND kind = 'text'")
            .fetch_one(db)
            .await
            .unwrap()
            .try_get(0)
            .unwrap()
    }

    fn in_channel(channel_id: i64, message: Message) -> WsEvent {
        WsEvent::Message {
            server: Some("rchat".to_string()),
            channel_id: Some(channel_id),
            dm_id: None,
            dm_users: None,
            message: Box::new(message),
        }
    }

    fn lite(name: &str) -> ServerSummaryLite {
        ServerSummaryLite {
            name: name.to_string(),
            display_name: name.to_string(),
            creator: None,
            has_password: false,
            banner_color: None,
            name_color: None,
        }
    }

    #[tokio::test]
    async fn reposts_are_checked_against_the_database() {
        let (state, path) = crate::api::test_util::temp_state("ws_repost").await;
        let db = &state.db;
        add_user(db, "alice").await;
        add_user(db, "bob").await;
        exec(
            db,
            "UPDATE users SET display_name = 'Alice Now' WHERE username = 'alice'",
        )
        .await;
        exec(
            db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('b', 'Bee', 1)",
        )
        .await;
        exec(
            db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('reused', 'Reused', 1)",
        )
        .await;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1)",
        )
        .await;
        let text = general(db).await;
        let talk: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'talk', 'voice', 1) RETURNING id")
            .fetch_one(db)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'r:999', 1, 1, 1)")
            .bind(talk)
            .execute(db)
            .await
            .unwrap();
        crate::api::test_util::restrict_ruled(db).await;
        let kept = post_message(db, text, "kept").await;
        let gone = post_message(db, text, "gone").await;
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(gone.id)
            .execute(db)
            .await
            .unwrap();
        let mut stale = kept.clone();
        stale.content = "stale".to_string();
        let bob = state.hub.next_conn();
        state.hub.set_online("bob", bob, &["rchat"]);
        state.hub.voice_join("bob", bob, "rchat", talk).await;
        let mut rx = state.hub.subscribe();
        let s = |v: &str| v.to_string();
        let ops = vec![
            Op::Broadcast {
                event: in_channel(text, gone),
            },
            Op::Broadcast {
                event: in_channel(text, stale),
            },
            Op::Broadcast {
                event: WsEvent::ServerRenamed {
                    old_name: s("reused"),
                    server: lite("b"),
                },
            },
            Op::Broadcast {
                event: WsEvent::ServerRenamed {
                    old_name: s("a"),
                    server: lite("b"),
                },
            },
            Op::Broadcast {
                event: WsEvent::ServerDeleted { name: s("reused") },
            },
            Op::Broadcast {
                event: WsEvent::ServerDeleted { name: s("a") },
            },
            Op::Broadcast {
                event: WsEvent::MemberKicked {
                    server: s("rchat"),
                    username: s("bob"),
                    banned: false,
                },
            },
            Op::Broadcast {
                event: WsEvent::MemberKicked {
                    server: s("rchat"),
                    username: s("alice"),
                    banned: true,
                },
            },
            Op::ForceOffline {
                server: s("rchat"),
                user: s("bob"),
            },
            Op::Broadcast {
                event: WsEvent::Banned {
                    username: s("alice"),
                },
            },
            Op::Broadcast {
                event: WsEvent::UserUpdated {
                    user: UserRef {
                        display_name: s("Alice Then"),
                        ..kept.author.clone()
                    },
                    scope: UserScope::default(),
                },
            },
        ];
        for op in ops {
            repost(&state, op).await;
        }
        let mut seen = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            seen.push(match ev {
                WsEvent::Message { message, .. } => format!("message {}", message.content),
                WsEvent::ServerRenamed { old_name, server } => {
                    format!("renamed {old_name} {} {}", server.name, server.display_name)
                }
                WsEvent::ServerDeleted { name } => format!("deleted {name}"),
                WsEvent::MemberKicked {
                    server,
                    username,
                    banned,
                } => format!("kicked {server} {username} {banned}"),
                WsEvent::VoiceState {
                    channel_id, users, ..
                } => format!("voice {channel_id} {users:?}"),
                WsEvent::VoiceEnded { dm_users, .. } => format!("voice ended {dm_users:?}"),
                WsEvent::UserUpdated { user, scope: _ } => format!("user {}", user.display_name),
                WsEvent::Banned { username } => format!("banned {username}"),
                WsEvent::PresenceChanged {
                    username, online, ..
                } => {
                    format!("presence {username} {online}")
                }
                _ => "other".to_string(),
            });
        }
        assert_eq!(
            seen,
            vec![
                s("message kept"),
                s("renamed a b Bee"),
                s("deleted a"),
                format!("voice {talk} []"),
                s("voice ended Some([\"bob\"])"),
                s("kicked rchat alice true"),
                s("user Alice Now"),
            ]
        );
        assert!(state.hub.is_online("rchat", "bob"));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn reposted_message_is_retracted_if_deleted_meanwhile() {
        let (local, path) = crate::api::test_util::temp_state("ws_retract").await;
        add_user(&local.db, "alice").await;
        let text = general(&local.db).await;
        let (hub, mut out) = Hub::replicated();
        let state = AppState::new(
            local.db.clone(),
            hub.clone(),
            None,
            None,
            local.instance.clone(),
        );
        let mut n = 0;
        for delete in [true, false] {
            let message = post_message(&state.db, text, "secret").await;
            let id = message.id;
            let task = {
                let state = state.clone();
                let event = in_channel(text, message);
                tokio::spawn(async move { repost(&state, Op::Broadcast { event }).await })
            };
            let started = Instant::now();
            let posted = loop {
                if let Ok(env) = out.try_recv() {
                    break env;
                }
                assert!(started.elapsed() < Duration::from_secs(5));
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            assert!(matches!(
                &posted.op,
                Op::Broadcast {
                    event: WsEvent::Message { .. }
                }
            ));
            if delete {
                sqlx::query("DELETE FROM messages WHERE id = $1")
                    .bind(id)
                    .execute(&state.db)
                    .await
                    .unwrap();
            }
            n += 1;
            hub.ingest(&format!("{n}-0"), posted, true);
            task.await.unwrap();
            match (delete, out.try_recv()) {
                (true, Ok(env)) => assert!(matches!(
                    &env.op,
                    Op::Broadcast { event: WsEvent::MessageDeleted { id: gone, .. } } if *gone == id
                )),
                (false, Err(_)) => {}
                (_, _) => panic!("unexpected retraction outcome (deleted: {delete})"),
            }
        }
        crate::api::test_util::done(local, path).await;
    }

    fn s(v: &str) -> String {
        v.to_string()
    }

    fn renamed(old: &str, new: &str) -> WsEvent {
        WsEvent::ServerRenamed {
            old_name: s(old),
            server: lite(new),
        }
    }

    fn joined(server: &str, username: &str) -> WsEvent {
        WsEvent::MemberJoined {
            server: s(server),
            member: Member {
                user: UserRef {
                    username: s(username),
                    ..message().author
                },
                is_admin: false,
                is_creator: false,
                online: false,
                perms: 0,
                role_ids: Vec::new(),
                joined_via: None,
                timeout: None,
            },
        }
    }

    async fn insert_id(db: &Db, sql: &'static str) -> i64 {
        sqlx::query(sql)
            .fetch_one(db)
            .await
            .unwrap()
            .try_get(0)
            .unwrap()
    }

    #[tokio::test]
    async fn failed_reauthorization_holds_back_scoped_events() {
        let (state, path) = crate::api::test_util::temp_state("ws_reauth_fail").await;
        add_user(&state.db, "alice").await;
        let mut alice = Access::new(Some(s("alice")), true, set(&["vault"]));
        alice.subs = set(&["vault", "open"]);
        alice.grants = HashMap::from([(s("open"), s("g"))]);
        alice.viewing = Some(s("vault"));
        alice.viewable = HashMap::from([(1, (s("vault"), true))]);
        let presence = WsEvent::PresenceChanged {
            server: s("vault"),
            username: s("bob"),
            online: true,
            online_count: 1,
        };
        let created = WsEvent::ServerCreated {
            server: lite("elsewhere"),
        };
        let dm = WsEvent::Message {
            server: None,
            channel_id: None,
            dm_id: Some(2),
            dm_users: Some(vec![s("alice"), s("bob")]),
            message: Box::new(message()),
        };
        let kicked = WsEvent::MemberKicked {
            server: s("vault"),
            username: s("alice"),
            banned: true,
        };
        assert!(alice.wants(&presence) && alice.wants(&created));
        crate::db::close(&state.db).await;
        let started = Instant::now();
        let res = reauthorize(&state, &mut alice).await;
        assert!(res.is_err());
        assert!(alice.settle(res, started));
        assert!(alice.retry.pending());
        assert_eq!(alice.member_servers, set(&["vault"]));
        assert_eq!(alice.subs, set(&["vault", "open"]));
        assert_eq!(alice.grants.len(), 1);
        assert_eq!(alice.viewing.as_deref(), Some("vault"));
        assert!(alice.viewable.is_empty());
        assert!(!alice.wants(&presence) && !alice.wants(&created));
        assert!(!alice.wants(&dm) && !alice.wants(&kicked));
        let conn = state.hub.next_conn();
        assert_eq!(
            on_event(&state, conn, &mut alice, &presence).await,
            Some(false)
        );
        assert_eq!(on_event(&state, conn, &mut alice, &dm).await, Some(false));
        assert_eq!(alice.retry.since, Some(started));
        let first = alice.retry.at.unwrap();
        assert!(first >= started + REAUTH_RETRY && first <= Instant::now() + REAUTH_RETRY * 3 / 2);
        let failed = || Err(sqlx::Error::PoolClosed);
        assert!(alice.settle(failed(), Instant::now()));
        assert_eq!(alice.retry.at, Some(first));
        assert_eq!(alice.retry.wait, REAUTH_RETRY * 2);
        for _ in 0..6 {
            alice.retry.at = None;
            assert!(alice.settle(failed(), Instant::now()));
            assert!(alice.retry.at.unwrap() <= started + REAUTH_GIVE_UP);
        }
        assert_eq!(alice.retry.since, Some(started));
        assert_eq!(alice.retry.at, Some(started + REAUTH_GIVE_UP));
        alice.retry.since = Instant::now().checked_sub(REAUTH_GIVE_UP);
        assert!(!alice.settle(failed(), Instant::now()));
        assert!(alice.settle(Ok(true), Instant::now()));
        assert!(!alice.retry.pending() && alice.retry.since.is_none());
        assert_eq!(alice.retry.wait, REAUTH_RETRY);
        assert!(alice.wants(&presence));
        let slow = Instant::now().checked_sub(REAUTH_GIVE_UP).unwrap();
        assert!(!alice.settle(failed(), slow));
        assert!(!Access::new(None, false, HashSet::new()).settle(Ok(false), Instant::now()));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn reused_name_is_rechecked() {
        let (state, path) = crate::api::test_util::temp_state("ws_reuse").await;
        let db = &state.db;
        for name in ["alice", "frank", "gina"] {
            add_user(db, name).await;
        }
        exec(
            db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('b', 'b', 1)",
        )
        .await;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('a', 'a', 'frank', 2)").await;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('b', 'alice', 1)",
        )
        .await;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('a', 'frank', 2)",
        )
        .await;
        let fresh = insert_id(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('a', 'general', 2) RETURNING id",
        )
        .await;
        let conn = state.hub.next_conn();
        state.hub.set_online("alice", conn, &["a"]);
        let mut alice = Access::new(Some(s("alice")), false, set(&["a"]));
        alice.viewing = Some(s("a"));
        let created = WsEvent::ServerCreated {
            server: ServerSummaryLite {
                creator: Some(s("frank")),
                ..lite("a")
            },
        };
        assert_eq!(
            on_event(&state, conn, &mut alice, &created).await,
            Some(false)
        );
        assert_eq!(alice.member_servers, set(&["b"]));
        assert_eq!(alice.viewing, None);
        assert!(!alice.retry.pending());
        assert!(!state.hub.is_online("a", "alice"));
        assert_eq!(
            on_event(&state, conn, &mut alice, &joined("a", "gina")).await,
            Some(false)
        );
        assert_eq!(
            on_event(&state, conn, &mut alice, &joined("b", "gina")).await,
            Some(true)
        );
        let secret = WsEvent::Message {
            server: Some(s("a")),
            channel_id: Some(fresh),
            dm_id: None,
            dm_users: None,
            message: Box::new(message()),
        };
        assert_eq!(
            on_event(&state, conn, &mut alice, &secret).await,
            Some(false)
        );

        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'vault', 'frank', 'hash', 3)").await;
        let mut guest = Access::new(None, false, HashSet::new());
        guest.subs = set(&["vault", "b"]);
        guest.grants = HashMap::from([(s("vault"), s("for-the-old-vault"))]);
        let made = WsEvent::ServerCreated {
            server: ServerSummaryLite {
                creator: Some(s("frank")),
                has_password: true,
                banner_color: None,
                name_color: None,
                ..lite("vault")
            },
        };
        assert_eq!(
            on_event(&state, state.hub.next_conn(), &mut guest, &made).await,
            Some(false)
        );
        assert_eq!(guest.subs, set(&["b"]));
        assert!(guest.grants.is_empty());
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn rename_recheck_survives_races_and_errors() {
        let (state, path) = crate::api::test_util::temp_state("ws_rename").await;
        let db = &state.db;
        add_user(db, "alice").await;
        add_user(db, "bob").await;
        exec(db, "INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('c', 'c', 'hash', 1)").await;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('c', 'alice', 1)",
        )
        .await;
        let conn = state.hub.next_conn();
        let mut alice = Access::new(Some(s("alice")), false, set(&["a", "rchat"]));
        alice.viewing = Some(s("a"));
        assert_eq!(
            on_event(&state, conn, &mut alice, &renamed("a", "b")).await,
            Some(true)
        );
        assert_eq!(alice.member_servers, set(&["b", "rchat"]));
        assert_eq!(
            on_event(&state, conn, &mut alice, &renamed("b", "c")).await,
            Some(true)
        );
        assert_eq!(alice.member_servers, set(&["c", "rchat"]));
        assert_eq!(alice.viewing.as_deref(), Some("c"));
        assert!(!alice.retry.pending());

        let mut bob = Access::new(Some(s("bob")), false, set(&["x"]));
        bob.viewing = Some(s("x"));
        assert_eq!(
            on_event(&state, conn, &mut bob, &renamed("x", "c")).await,
            Some(false)
        );
        assert!(bob.member_servers.is_empty());
        assert_eq!(bob.viewing, None);

        let mut carol = Access::new(Some(s("carol")), false, set(&["d", "rchat"]));
        carol.viewable = HashMap::from([(1, (s("rchat"), true))]);
        assert_eq!(
            on_event(&state, conn, &mut carol, &renamed("x", "y")).await,
            Some(false)
        );
        assert_eq!(carol.viewable.len(), 1);
        crate::db::close(&state.db).await;
        assert_eq!(
            on_event(&state, conn, &mut carol, &renamed("d", "e")).await,
            Some(false)
        );
        assert_eq!(carol.member_servers, set(&["e", "rchat"]));
        assert!(carol.retry.pending());
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn channel_events_need_the_owning_server() {
        let (state, path) = crate::api::test_util::temp_state("ws_owner").await;
        let db = &state.db;
        add_user(db, "bob").await;
        exec(
            db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('a', 'a', 1)",
        )
        .await;
        exec(
            db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('b', 'b', 1)",
        )
        .await;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('b', 'bob', 1)",
        )
        .await;
        let text = insert_id(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('b', 'chat', 1) RETURNING id",
        )
        .await;
        let talk = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('b', 'talk', 'voice', 1) RETURNING id").await;
        let role = insert_id(db, "INSERT INTO roles(server, name, color, perms) VALUES('b', 'crew', '#fff', 0) RETURNING id").await;
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('b', 'bob', $1)")
            .bind(role)
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, 1, 1, 1)")
            .bind(talk)
            .bind(format!("r:{role}"))
            .execute(db)
            .await
            .unwrap();
        crate::api::test_util::restrict_ruled(db).await;
        let mut bob = Access::new(Some(s("bob")), false, set(&["b"]));
        let mut guest = Access::new(None, false, HashSet::new());
        assert_eq!(channel_gate(&state, &mut bob, "a", text).await, Some(false));
        assert_eq!(bob.viewable.get(&text), Some(&(s("b"), true)));
        assert_eq!(channel_gate(&state, &mut bob, "b", text).await, Some(true));
        assert_eq!(channel_gate(&state, &mut bob, "a", text).await, Some(false));
        assert_eq!(channel_gate(&state, &mut bob, "b", talk).await, Some(true));
        assert_eq!(
            channel_gate(&state, &mut guest, "b", talk).await,
            Some(false)
        );
        track(&renamed("b", "c"), &mut bob);
        assert!(bob.viewable.is_empty());

        let conn = state.hub.next_conn();
        assert!(
            state
                .hub
                .voice_join("bob", conn, "a", talk)
                .await
                .is_empty()
        );
        evict_unviewable(&state, "a", None).await;
        assert_eq!(state.hub.rooms_in("a", None), vec![(talk, vec![s("bob")])]);
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn reposted_messages_carry_their_embeds() {
        let (state, path) = crate::api::test_util::temp_state("ws_embeds").await;
        let db = &state.db;
        add_user(db, "alice").await;
        let text = general(db).await;
        let posted = post_message(db, text, "see https://example.com").await;
        exec(db, "INSERT INTO embeds(url, site_name, title, fetched_at) VALUES('https://example.com', 'Example', 'Example Domain', 1)").await;
        sqlx::query(
            "INSERT INTO message_embeds(message_id, ord, url) VALUES($1, 0, 'https://example.com')",
        )
        .bind(posted.id)
        .execute(db)
        .await
        .unwrap();
        let mut rx = state.hub.subscribe();
        repost(
            &state,
            Op::Broadcast {
                event: in_channel(text, posted.clone()),
            },
        )
        .await;
        repost(
            &state,
            Op::Broadcast {
                event: WsEvent::EmbedsResolved {
                    server: Some(s("rchat")),
                    channel_id: Some(text),
                    dm_id: None,
                    dm_users: None,
                    message_id: posted.id,
                    embeds: Vec::new(),
                },
            },
        )
        .await;
        let titles = |embeds: &[Embed]| -> Vec<Option<String>> {
            embeds.iter().map(|e| e.title.clone()).collect()
        };
        let mut seen = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::Message { message, .. } => seen.push(titles(&message.embeds)),
                WsEvent::EmbedsResolved { embeds, .. } => seen.push(titles(&embeds)),
                _ => {}
            }
        }
        let example = vec![Some(s("Example Domain"))];
        assert_eq!(seen, vec![example.clone(), example]);
        crate::api::test_util::done(state, path).await;
    }

    #[test]
    fn database_failures_are_logged_in_summary() {
        static SUMMED: AtomicU64 = AtomicU64::new(0);
        static GATE: LogGate = LogGate::new(LOG_EVERY, |n| {
            SUMMED.fetch_add(n, Ordering::SeqCst);
        });
        let secs = Duration::from_secs;
        let t0 = Instant::now();
        assert!(GATE.admit(t0));
        for i in 1..=4 {
            assert!(!GATE.admit(t0 + secs(i)));
        }
        GATE.flush(t0 + LOG_EVERY);
        assert_eq!(SUMMED.load(Ordering::SeqCst), 4);
        assert!(!GATE.admit(t0 + LOG_EVERY + secs(1)));
        GATE.flush(t0 + LOG_EVERY * 2);
        assert_eq!(SUMMED.load(Ordering::SeqCst), 5);
        GATE.flush(t0 + LOG_EVERY * 3);
        assert_eq!(SUMMED.load(Ordering::SeqCst), 5);
        assert!(GATE.admit(t0 + LOG_EVERY * 5));
    }

    #[tokio::test]
    async fn hidden_failures_are_summarized_later() {
        const EVERY: Duration = Duration::from_millis(200);
        static SUMMED: AtomicU64 = AtomicU64::new(0);
        static GATE: LogGate = LogGate::new(EVERY, |n| {
            SUMMED.fetch_add(n, Ordering::SeqCst);
        });
        assert!(GATE.admit(Instant::now()));
        assert!(!GATE.admit(Instant::now()) && !GATE.admit(Instant::now()));
        tokio::time::sleep(EVERY / 4).await;
        assert_eq!(SUMMED.load(Ordering::SeqCst), 0);
        tokio::time::sleep(EVERY * 2).await;
        assert_eq!(SUMMED.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn self_grants_are_recognized() {
        let author = message().author;
        let joined = WsEvent::MemberJoined {
            server: "vault".to_string(),
            member: Member {
                user: author,
                is_admin: false,
                is_creator: false,
                online: false,
                perms: 0,
                role_ids: Vec::new(),
                joined_via: None,
                timeout: None,
            },
        };
        assert_eq!(self_grant(&joined, Some("alice")), Some("vault"));
        assert_eq!(self_grant(&joined, Some("bob")), None);
        let created = |creator: Option<&str>| WsEvent::ServerCreated {
            server: ServerSummaryLite {
                name: "vault".to_string(),
                display_name: "vault".to_string(),
                creator: creator.map(str::to_string),
                has_password: true,
                banner_color: None,
                name_color: None,
            },
        };
        assert_eq!(
            self_grant(&created(Some("alice")), Some("alice")),
            Some("vault")
        );
        assert_eq!(self_grant(&created(None), None), None);
        assert_eq!(self_grant(&created(Some("alice")), None), None);
        let kicked = WsEvent::MemberKicked {
            server: "vault".to_string(),
            username: "alice".to_string(),
            banned: false,
        };
        assert_eq!(self_grant(&kicked, Some("alice")), None);
    }

    #[tokio::test]
    async fn lagged_guest_recheck_drops_revoked_subs() {
        let (state, path) = crate::api::test_util::temp_state("guest_recheck").await;
        let db = &state.db;
        for (name, hash) in [("open", None), ("locked", Some("h")), ("kept", Some("h"))] {
            sqlx::query("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES($1, $1, $2, 0)")
                .bind(name)
                .bind(hash)
                .execute(db)
                .await
                .unwrap();
        }
        exec(
            db,
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('h:4d2f4b668cfc48e6059d36e91326bf87de39ba819f35450477bc1ce614a63bbd', 'kept', 0, 4000000000)",
        )
        .await;
        let mut guest = Access::new(None, false, HashSet::new());
        guest.subs = set(&["open", "locked", "kept", "gone"]);
        guest.grants = HashMap::from([(s("locked"), s("g1")), (s("kept"), s("g2"))]);
        assert!(guest.refresh(&state, 1).await);
        assert_eq!(guest.subs, set(&["kept", "open"]));
        assert_eq!(guest.grants.keys().collect::<Vec<_>>(), ["kept"]);
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn guests_of_an_expiring_password_are_cut_at_its_expiry() {
        let (state, path) = crate::api::test_util::temp_state("guest_deadline").await;
        let db = &state.db;
        for name in ["tmp", "kept"] {
            sqlx::query("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES($1, $1, 'h', 0)")
                .bind(name)
                .execute(db)
                .await
                .unwrap();
        }
        let at = now() + 1;
        let id: i64 = sqlx::query("INSERT INTO server_passwords(server, hash, lookup, created_by, created_at, expires_at) VALUES('tmp', 'h', 'l', 'alice', 0, $1) RETURNING id")
            .bind(at)
            .fetch_one(db)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id) VALUES('h:711430f6164e93803d93428bc1fab80f41e213bb197689307de8606d437c3038', 'tmp', 0, 4000000000, $1)")
            .bind(id)
            .execute(db)
            .await
            .unwrap();
        exec(
            db,
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('h:4d2f4b668cfc48e6059d36e91326bf87de39ba819f35450477bc1ce614a63bbd', 'kept', 0, 4000000000)",
        )
        .await;
        let mut guest = Access::new(None, false, HashSet::new());
        guest.subs = set(&["tmp", "kept"]);
        guest.grants = HashMap::from([(s("tmp"), s("g1")), (s("kept"), s("g2"))]);
        assert!(guest.refresh(&state, 1).await);
        assert_eq!(guest.subs, set(&["tmp", "kept"]));
        assert_eq!(guest.deadlines, HashMap::from([(s("tmp"), at)]));
        assert_eq!(
            servers_with_expired_passwords(db, at - 10, at - 1)
                .await
                .unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            servers_with_expired_passwords(db, at - 1, at)
                .await
                .unwrap(),
            vec![s("tmp")]
        );
        while now() < at {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let ev = WsEvent::PresenceChanged {
            server: s("tmp"),
            username: s("bob"),
            online: true,
            online_count: 1,
        };
        let conn = state.hub.next_conn();
        assert_eq!(on_event(&state, conn, &mut guest, &ev).await, Some(false));
        assert_eq!(guest.subs, set(&["kept"]));
        assert!(guest.deadlines.is_empty());
        assert_eq!(guest.grants.keys().collect::<Vec<_>>(), ["kept"]);
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn banned_user_cannot_join_voice() {
        let (state, path) = crate::api::test_util::temp_state("ban_voice").await;
        for name in ["bob", "carol"] {
            add_user_row(&state.db, name).await;
        }
        let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
        exec(&state.db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('rchat', 'bob', 'alice', 0)").await;
        let join = |user| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id: cid });
        assert_eq!(join("bob").await, Err("Channel not found".to_string()));
        join("carol").await.expect("carol joins");
        assert_eq!(
            state.hub.rooms_in("rchat", None),
            vec![(cid, vec!["carol".to_string()])]
        );
        assert!(
            !authed_sub_ok(&state.db, "rchat", "bob", false)
                .await
                .expect("sub")
        );
        assert!(
            authed_sub_ok(&state.db, "rchat", "carol", false)
                .await
                .expect("sub")
        );
        let access = Access::new(Some(s("bob")), false, set(&[]));
        assert!(!still_held(&state.db, &access, "rchat").await.expect("held"));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn timed_out_members_cannot_join_voice() {
        let (state, path) = crate::api::test_util::temp_state("timeout_voice").await;
        for name in ["bob", "carol"] {
            add_user_row(&state.db, name).await;
            crate::api::test_util::add_member(&state.db, "rchat", name, 0, 0, 0).await;
        }
        let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
        let other = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'den', 'voice', 0) RETURNING id").await;
        time_out(&state.db, "bob", now() + 600).await;
        let join =
            |user, channel_id| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id });
        let timed_out = Err(crate::api::access::TIMED_OUT.to_string());
        assert_eq!(join("bob", cid).await, timed_out);
        join("carol", cid).await.expect("carol joins");
        time_out(&state.db, "carol", now() + 600).await;
        assert_eq!(
            state.hub.rooms_in("rchat", None),
            vec![(cid, vec!["carol".to_string()])],
            "a timeout mutes, it does not disconnect"
        );
        assert_eq!(join("carol", other).await, timed_out, "no switching rooms");
        voice_msg(&state, "carol", 1, ClientMsg::VoiceLeave)
            .await
            .expect("leave");
        assert_eq!(
            join("carol", cid).await,
            timed_out,
            "leaving and rejoining stays blocked"
        );
        time_out(&state.db, "carol", now()).await;
        join("carol", cid).await.expect("joins once it ended");
        exec(
            &state.db,
            "DELETE FROM member_timeouts WHERE username = 'bob'",
        )
        .await;
        join("bob", cid).await.expect("joins once removed");
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn timeout_events_reach_only_the_member_and_moderators() {
        let (state, path) = crate::api::test_util::temp_state("timeout_events").await;
        let db = &state.db;
        for name in ["bob", "carol", "mo", "boss"] {
            add_user_row(db, name).await;
        }
        crate::api::test_util::add_member(db, "rchat", "bob", 0, 0, 0).await;
        crate::api::test_util::add_member(db, "rchat", "carol", 0, 0, 0).await;
        crate::api::test_util::add_member(db, "rchat", "mo", 0, 0, 0).await;
        crate::api::test_util::add_member(db, "rchat", "boss", 1, 0, 0).await;
        let role = insert_id(db, "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'mods', '#ffffff', 128) RETURNING id").await;
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'mo', $1)")
            .bind(role)
            .execute(db)
            .await
            .expect("role");
        let ev = WsEvent::MemberTimeout {
            server: s("rchat"),
            username: s("bob"),
            until: Some(now() + 60),
            remaining: 60,
            reason: Some(s("spam")),
        };
        let conn = state.hub.next_conn();
        for (user, site_admin, member, expected) in [
            ("bob", false, true, true),
            ("bob", false, false, true),
            ("mo", false, true, true),
            ("boss", false, true, true),
            ("carol", false, true, false),
            ("root", true, false, false),
        ] {
            let servers = match member {
                true => set(&["rchat"]),
                false => set(&[]),
            };
            let mut access = Access::new(Some(s(user)), site_admin, servers);
            assert_eq!(
                on_event(&state, conn, &mut access, &ev).await,
                Some(expected),
                "{user}"
            );
        }
        let mut guest = Access::new(None, false, set(&[]));
        guest.subs = set(&["rchat"]);
        assert_eq!(on_event(&state, conn, &mut guest, &ev).await, Some(false));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn timed_out_members_cannot_turn_on_video_in_voice() {
        let (state, path) = crate::api::test_util::temp_state("timeout_video").await;
        for name in ["bob", "carol"] {
            add_user_row(&state.db, name).await;
            crate::api::test_util::add_member(&state.db, "rchat", name, 0, 0, 0).await;
        }
        let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
        for name in ["bob", "carol"] {
            voice_msg(&state, name, 1, ClientMsg::VoiceJoin { channel_id: cid })
                .await
                .expect("join");
        }
        time_out(&state.db, "bob", now() + 600).await;
        let signal = |from, payload| {
            voice_msg(
                &state,
                from,
                1,
                ClientMsg::RtcSignal {
                    to: s(if from == "bob" { "carol" } else { "bob" }),
                    channel_id: Some(cid),
                    dm_id: None,
                    payload,
                },
            )
        };
        let timed_out = Err(crate::api::access::TIMED_OUT.to_string());
        assert_eq!(
            signal("bob", serde_json::json!({"cam": true})).await,
            timed_out
        );
        assert_eq!(
            signal(
                "bob",
                serde_json::json!({"muted": true, "cam": false, "screen": true})
            )
            .await,
            timed_out
        );
        for ok in [
            serde_json::json!({"muted": true, "cam": false, "screen": false}),
            serde_json::json!({"candidate": {"candidate": ""}}),
            serde_json::json!({"restart": true}),
        ] {
            signal("bob", ok.clone())
                .await
                .expect("audio signalling stays");
        }
        signal("carol", serde_json::json!({"cam": true, "screen": true}))
            .await
            .expect("others are not affected");
        time_out(&state.db, "bob", now()).await;
        signal("bob", serde_json::json!({"cam": true}))
            .await
            .expect("works once it ended");
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn the_member_gets_their_timeout_without_the_reason() {
        let (state, path) = crate::api::test_util::temp_state("timeout_reason").await;
        let db = &state.db;
        for name in ["bob", "mo"] {
            add_user_row(db, name).await;
            crate::api::test_util::add_member(db, "rchat", name, 0, 0, 0).await;
        }
        let role = insert_id(db, "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'mods', '#ffffff', 128) RETURNING id").await;
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'mo', $1)")
            .bind(role)
            .execute(db)
            .await
            .expect("role");
        let ev = |username: &str| WsEvent::MemberTimeout {
            server: s("rchat"),
            username: s(username),
            until: Some(now() + 60),
            remaining: 60,
            reason: Some(s("spam")),
        };
        let reason_of = |ev: &WsEvent| match ev {
            WsEvent::MemberTimeout {
                server: _,
                username: _,
                until: _,
                remaining: _,
                reason,
            } => reason.clone(),
            _ => panic!("not a timeout"),
        };
        let fanned = crate::fanout::Fanned::new(ev("bob"), 1);
        assert!(
            client_frame(&fanned, Some("bob")).is_none(),
            "the shared frame (with the reason) never goes to the member"
        );
        let mod_frame = client_frame(&fanned, Some("mo")).expect("moderators get the frame");
        assert!(mod_frame.as_str().contains("spam"));
        let mut bob = Access::new(Some(s("bob")), false, set(&["rchat"]));
        let mine = own_timeout(&state, &mut bob, &ev("bob"))
            .await
            .expect("open")
            .expect("bob's own event");
        assert_eq!(reason_of(&mine), None);
        assert!(!serde_json::to_string(&mine).unwrap().contains("spam"));
        let mut mo = Access::new(Some(s("mo")), false, set(&["rchat"]));
        assert!(matches!(
            own_timeout(&state, &mut mo, &ev("bob")).await,
            Some(None)
        ));
        let mine = own_timeout(&state, &mut mo, &ev("mo"))
            .await
            .expect("open")
            .expect("mo's own event");
        assert_eq!(
            reason_of(&mine),
            Some(s("spam")),
            "a member who holds Timeout members sees the reason of their own"
        );
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn typing_follows_the_send_gate() {
        let (state, path) = crate::api::test_util::temp_state("ws_typing").await;
        let db = &state.db;
        for name in ["bob", "carol", "dave", "root", "erin"] {
            add_user_row(db, name).await;
        }
        crate::api::test_util::add_member(db, "rchat", "erin", 1, 0, 0).await;
        exec(
            db,
            "UPDATE users SET display_name = 'Bobby' WHERE username = 'bob'",
        )
        .await;
        exec(
            db,
            "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
        )
        .await;
        for name in ["bob", "carol"] {
            crate::api::test_util::add_member(db, "rchat", name, 0, 0, 0).await;
        }
        let chat = insert_id(db, "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'chat', 0) RETURNING id").await;
        let news = insert_id(db, "INSERT INTO channels(server, name, created_at, restrict_send) VALUES('rchat', 'news', 0, 1) RETURNING id").await;
        let talk = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'talk', 'voice', 0) RETURNING id").await;
        let root = insert_id(db, "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'carol', 'hi', 1 FROM channels WHERE name = 'chat' RETURNING id").await;
        let dm = insert_id(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('bob', 'carol') RETURNING id",
        )
        .await;
        let read = state.read();
        let typed = |user: &'static str, scope: String, on: bool| {
            let read = read.clone();
            async move { Typer::new().command(&read, user, scope, on).await }
        };
        let shown = |evs: Vec<WsEvent>| match evs.as_slice() {
            [
                WsEvent::Typing {
                    server,
                    channel_id,
                    dm_id,
                    dm_users,
                    scope: _,
                    username,
                    display_name,
                    until,
                },
            ] => Some((
                server.clone(),
                channel_id.or(*dm_id),
                dm_users.clone(),
                username.clone(),
                display_name.clone(),
                *until > 0,
            )),
            _ => None,
        };
        assert_eq!(
            shown(typed("bob", format!("c{chat}"), true).await),
            Some((
                Some(s("rchat")),
                Some(chat),
                None,
                s("bob"),
                s("Bobby"),
                true
            ))
        );
        assert_eq!(
            shown(typed("bob", format!("t{root}"), true).await),
            Some((
                Some(s("rchat")),
                Some(chat),
                None,
                s("bob"),
                s("Bobby"),
                true
            ))
        );
        assert_eq!(
            shown(typed("carol", format!("d{dm}"), true).await),
            Some((
                None,
                Some(dm),
                Some(vec![s("bob"), s("carol")]),
                s("carol"),
                s("carol"),
                true
            ))
        );
        assert!(shown(typed("erin", format!("c{news}"), true).await).is_some());
        for (user, scope) in [
            ("carol", format!("c{news}")),
            ("bob", format!("c{talk}")),
            ("dave", format!("c{chat}")),
            ("dave", format!("d{dm}")),
            ("root", format!("c{chat}")),
            ("bob", "x1".to_string()),
            ("bob", "c".to_string()),
            ("bob", "c-1".to_string()),
            ("bob", "c999".to_string()),
            ("bob", format!("c{chat}{}", "0".repeat(30))),
        ] {
            assert!(
                typed(user, scope.clone(), true).await.is_empty(),
                "{user} {scope}"
            );
        }
        assert!(typed("bob", format!("c{chat}"), false).await.is_empty());

        let mut typer = Typer::new();
        let user = "bob";
        let first = typer.command(db, user, format!("c{chat}"), true).await;
        assert_eq!(first.len(), 1);
        assert!(
            typer
                .command(db, user, format!("c{chat}"), true)
                .await
                .is_empty()
        );
        let moved = typer.command(db, user, format!("d{dm}"), true).await;
        assert!(matches!(
            moved.as_slice(),
            [
                WsEvent::Typing { scope: a, until: 0, .. },
                WsEvent::Typing { scope: b, .. },
            ] if *a == format!("c{chat}") && *b == format!("d{dm}")
        ));
        let stopped = typer.command(db, user, format!("d{dm}"), false).await;
        assert!(matches!(
            stopped.as_slice(),
            [WsEvent::Typing { until: 0, .. }]
        ));
        assert!(
            typer
                .command(db, user, format!("d{dm}"), false)
                .await
                .is_empty()
        );
        assert!(typer.stop(user).is_none());
        typer.bucket.tokens = 0.0;
        assert!(
            typer
                .command(db, user, format!("d{dm}"), true)
                .await
                .is_empty()
        );
        typer.bucket.tokens = TYPING_BURST;
        assert_eq!(
            typer.command(db, user, format!("d{dm}"), true).await.len(),
            1
        );
        typer.bucket.tokens = -TYPING_BURST;
        let paced = typer.command(db, user, format!("d{dm}"), false).await;
        assert!(matches!(
            paced.as_slice(),
            [WsEvent::Typing { until: 0, .. }]
        ));
        assert_eq!(
            typer.command(db, user, format!("d{dm}"), true).await.len(),
            0
        );
        typer.bucket.tokens = TYPING_BURST;
        typer.command(db, user, format!("d{dm}"), true).await;
        assert!(typer.bucket.tokens >= 0.0);
        assert!(matches!(
            typer.stop(user),
            Some(WsEvent::Typing { until: 0, .. })
        ));
        let mut flood = Typer::new();
        for i in 0..50 {
            flood
                .command(db, user, format!("c{}", chat + i + 100), true)
                .await;
        }
        assert!(flood.bucket.tokens >= -TYPING_BURST);
        let mut canon = Typer::new();
        let first = canon.command(db, user, format!("c+{chat}"), true).await;
        assert!(matches!(
            first.as_slice(),
            [WsEvent::Typing { scope, .. }] if *scope == format!("c{chat}")
        ));
        assert!(
            canon
                .command(db, user, format!("c0{chat}"), true)
                .await
                .is_empty()
        );
        let stop = canon.command(db, user, format!("c{chat}"), false).await;
        assert!(matches!(
            stop.as_slice(),
            [WsEvent::Typing { until: 0, .. }]
        ));
        crate::api::test_util::done(state, path).await;
    }

    #[test]
    fn typing_skips_the_typer_and_strangers() {
        let typing = |server: Option<&str>, dm_users: Option<Vec<String>>| WsEvent::Typing {
            server: server.map(s),
            channel_id: server.map(|_| 3),
            dm_id: dm_users.as_ref().map(|_| 4),
            dm_users,
            scope: s("c3"),
            username: s("bob"),
            display_name: s("Bob"),
            until: 9,
        };
        let channel = typing(Some("rchat"), None);
        let dm = typing(None, Some(vec![s("bob"), s("carol")]));
        let members = set(&["rchat"]);
        let none = HashSet::new();
        assert!(wants(&channel, Some("carol"), false, &members, &none));
        assert!(wants(&channel, None, false, &none, &members));
        assert!(!wants(&channel, Some("bob"), false, &members, &none));
        assert!(!wants(&channel, Some("dave"), true, &none, &none));
        assert!(wants(&dm, Some("carol"), false, &none, &none));
        assert!(!wants(&dm, Some("bob"), false, &none, &none));
        assert!(!wants(&dm, Some("dave"), true, &members, &none));
        assert_eq!(event_channel(&channel), Some(("rchat", 3)));
        assert_eq!(event_channel(&dm), None);
        let wire = to_bus_json(&dm).expect("bus json");
        assert!(matches!(
            serde_json::from_str::<WsEvent>(&wire),
            Ok(WsEvent::Typing { dm_users: Some(users), until: 9, .. }) if users.len() == 2
        ));
        assert_eq!(
            crate::fanout::route(&dm),
            crate::fanout::Route::To(vec![
                crate::fanout::Target::User("bob"),
                crate::fanout::Target::User("carol")
            ])
        );
    }

    async fn add_user_row(db: &Db, name: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $1, 'x', 'text', 'identicon', 0)")
            .bind(name)
            .execute(db)
            .await
            .expect("user");
    }

    #[tokio::test]
    async fn locked_server_voice_needs_membership() {
        let (state, path) = crate::api::test_util::temp_state("locked_voice").await;
        let db = &state.db;
        for name in ["alice", "bob", "eve", "root"] {
            add_user_row(db, name).await;
        }
        exec(
            db,
            "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
        )
        .await;
        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 0)").await;
        let cid = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('vault', 'lounge', 'voice', 0) RETURNING id").await;
        exec(db, "INSERT INTO members(server, username, is_admin, joined_at) VALUES('vault', 'alice', 1, 0)").await;
        exec(db, "INSERT INTO members(server, username, is_admin, joined_at) VALUES('vault', 'bob', 0, 0)").await;
        let join = |user| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id: cid });
        join("bob").await.expect("member joins");
        state.hub.voice_leave("bob").await;
        exec(
            db,
            "DELETE FROM members WHERE server = 'vault' AND username = 'bob'",
        )
        .await;
        for (outsider, want) in [
            ("bob", "Channel not found"),
            ("eve", "Channel not found"),
            ("root", "Join this server to use voice"),
        ] {
            assert_eq!(join(outsider).await, Err(want.to_string()), "{outsider}");
        }
        join("alice").await.expect("alice joins");
        assert_eq!(
            state.hub.rooms_in("vault", None),
            vec![(cid, vec!["alice".to_string()])]
        );
        exec(
            db,
            "UPDATE servers SET password_hash = '!purging' WHERE name = 'vault'",
        )
        .await;
        state.hub.voice_leave("alice").await;
        assert_eq!(join("alice").await, Err("Channel not found".to_string()));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn site_admins_get_member_view_in_voice() {
        let (state, path) = crate::api::test_util::temp_state("admin_voice_view").await;
        let db = &state.db;
        for name in ["alice", "root"] {
            add_user_row(db, name).await;
            sqlx::query("INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, 0)")
                .bind(name)
                .execute(db)
                .await
                .expect("member");
        }
        exec(
            db,
            "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
        )
        .await;
        let cid = insert_id(db, "INSERT INTO channels(server, name, kind, created_at, restrict_view) VALUES('rchat', 'staff', 'voice', 0, 1) RETURNING id").await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 1)")
            .bind(cid)
            .execute(db)
            .await
            .expect("rule");
        let join = |user| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id: cid });
        assert_eq!(
            join("root").await,
            Err("Channel not found".to_string()),
            "a site admin who is a plain member can not join a hidden voice channel"
        );
        join("alice").await.expect("alice joins");
        let _ = state.hub.voice_join("root", 2, "rchat", cid).await;
        evict_unviewable(&state, "rchat", Some(cid)).await;
        assert_eq!(
            state.hub.rooms_in("rchat", None),
            vec![(cid, vec!["alice".to_string()])],
            "the recheck uses member rights too"
        );
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn p2p_who_answers_only_shared_scopes_and_readable_ids() {
        let (state, path) = crate::api::test_util::temp_state("p2p_who_scope").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "eve"] {
            add_user_row(db, name).await;
        }
        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 0)").await;
        let vault = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('vault', 'general', 'text', 0) RETURNING id").await;
        let general = insert_id(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        for (server, user) in [("rchat", "alice"), ("vault", "alice"), ("rchat", "bob")] {
            sqlx::query(
                "INSERT INTO members(server, username, is_admin, joined_at) VALUES($1, $2, 0, 0)",
            )
            .bind(server)
            .bind(user)
            .execute(db)
            .await
            .expect("member");
        }
        let dm = insert_id(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id",
        )
        .await;
        let ids: Vec<String> = ["f1", "f2", "f3", "f4"].map(str::to_string).to_vec();
        for (id, channel, dm_id) in [
            ("f1", Some(general), None),
            ("f2", Some(vault), None),
            ("f3", None, Some(dm)),
        ] {
            sqlx::query("INSERT INTO messages(channel_id, dm_id, author, content, media_id, media_kind, media_hoster, created_at) VALUES($1, $2, 'alice', '', $3, 'p2p', 'alice', 0)")
                .bind(channel)
                .bind(dm_id)
                .bind(id)
                .execute(db)
                .await
                .expect("p2p message");
        }
        state
            .hub
            .set_p2p("alice", 1, "peer-a".to_string(), ids.clone());
        let ask = |me: &'static str, servers: &[&str]| {
            let mut access = Access::new(Some(s(me)), false, set(servers));
            let state = state.clone();
            async move { p2p_visible(&state, &mut access, me, "alice").await }
        };
        assert_eq!(ask("bob", &["rchat"]).await, Some(vec![s("f1")]));
        let mut carol = ask("carol", &[]).await.expect("dm partner");
        carol.sort();
        assert_eq!(carol, [s("f1"), s("f3")]);
        assert_eq!(ask("eve", &[]).await, None);
        let mut own = ask("alice", &["rchat", "vault"]).await.expect("self");
        own.sort();
        assert_eq!(own, ids);
        exec(
            db,
            "UPDATE users SET appear_offline = 1 WHERE username = 'alice'",
        )
        .await;
        assert_eq!(ask("bob", &["rchat"]).await, None);
        assert_eq!(ask("carol", &[]).await, None);
        exec(
            db,
            "UPDATE users SET appear_offline = 0 WHERE username = 'alice'",
        )
        .await;
        let mut bob = Access::new(Some(s("bob")), false, set(&["rchat"]));
        let first = p2p_visible(&state, &mut bob, "bob", "alice").await;
        assert_eq!(first, Some(vec![s("f1")]));
        assert_eq!((bob.who.peers.len(), bob.who.media.len()), (1, 4));
        exec(db, "DELETE FROM messages WHERE media_id = 'f1'").await;
        assert_eq!(
            p2p_visible(&state, &mut bob, "bob", "alice").await,
            first,
            "a burst within the cache window reuses the scope lookups"
        );
        exec(
            db,
            "UPDATE users SET appear_offline = 1 WHERE username = 'alice'",
        )
        .await;
        assert_eq!(
            p2p_visible(&state, &mut bob, "bob", "alice").await,
            None,
            "appear offline applies at once, even within the cache window"
        );
        let left = WsEvent::MemberLeft {
            server: s("rchat"),
            username: s("bob"),
        };
        track(&left, &mut bob);
        assert!(bob.who.peers.is_empty() && bob.who.media.is_empty());
        bob.member_servers = set(&["rchat"]);
        assert_eq!(p2p_visible(&state, &mut bob, "bob", "alice").await, None);
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn p2p_who_keeps_the_read_history_floor_and_the_p2p_switch() {
        let (state, path) = crate::api::test_util::temp_state("p2p_who_floor").await;
        let db = &state.db;
        for name in ["alice", "bob", "dave"] {
            add_user_row(db, name).await;
        }
        let general = insert_id(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        for (user, joined) in [("alice", 0), ("bob", 50), ("dave", 50)] {
            sqlx::query("INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, $2)")
                .bind(user)
                .bind(joined)
                .execute(db)
                .await
                .expect("member");
        }
        exec(db, "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) SELECT id, 'u:bob', 1, 1, 0 FROM channels WHERE server = 'rchat'").await;
        for (id, at) in [("old", 10), ("new", 60)] {
            sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_kind, media_hoster, created_at) VALUES($1, 'alice', '', $2, 'p2p', 'alice', $3)")
                .bind(general)
                .bind(id)
                .bind(at)
                .execute(db)
                .await
                .expect("p2p message");
        }
        let ids = vec![s("old"), s("new")];
        state.hub.set_p2p("alice", 1, s("peer-a"), ids.clone());
        let ask = |me: &'static str| {
            let mut access = Access::new(Some(s(me)), false, set(&["rchat"]));
            let state = state.clone();
            async move { p2p_visible(&state, &mut access, me, "alice").await }
        };
        assert_eq!(
            ask("bob").await,
            Some(vec![s("new")]),
            "no read history: only files posted since joining"
        );
        let mut dave = ask("dave").await.expect("dave");
        dave.sort();
        assert_eq!(dave, [s("new"), s("old")]);
        exec(
            db,
            "INSERT INTO settings(key, value) VALUES('p2p_attachments', '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
        )
        .await;
        crate::api::Settings::forget(db);
        assert_eq!(
            ask("dave").await,
            Some(Vec::new()),
            "with P2P attachments off no file is offered; the peer stays for calls"
        );
        let mut live = live_hosted(db, "alice", &[s("old"), s("gone"), s("new")])
            .await
            .expect("live");
        live.sort();
        assert_eq!(live, [s("new"), s("old")]);
        assert_eq!(
            live_hosted(db, "bob", &ids).await,
            Some(Vec::new()),
            "only the hoster's own messages count, so a shared browser adopts no one else's file"
        );
        exec(
            db,
            "UPDATE messages SET media_removed = 2 WHERE media_id = 'old'",
        )
        .await;
        exec(
            db,
            "UPDATE messages SET media_expires_at = 1 WHERE media_id = 'new'",
        )
        .await;
        assert_eq!(live_hosted(db, "alice", &ids).await, Some(Vec::new()));
        assert_eq!(live_hosted(db, "bob", &[]).await, Some(Vec::new()));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn hosting_broadcasts_reach_others_only_through_p2p_who() {
        let (state, path) = crate::api::test_util::temp_state("p2p_broadcast_ids").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol"] {
            add_user_row(db, name).await;
        }
        for user in ["alice", "carol"] {
            sqlx::query(
                "INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, 0)",
            )
            .bind(user)
            .execute(db)
            .await
            .expect("member");
        }
        let general = insert_id(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        let dm = insert_id(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        for (id, channel, dm_id) in [("pub", Some(general), None), ("dm", None, Some(dm))] {
            sqlx::query("INSERT INTO messages(channel_id, dm_id, author, content, media_id, media_kind, media_hoster, created_at) VALUES($1, $2, 'alice', '', $3, 'p2p', 'alice', 0)")
                .bind(channel)
                .bind(dm_id)
                .bind(id)
                .execute(db)
                .await
                .expect("p2p message");
        }
        let ids = vec![s("pub"), s("dm")];
        state.hub.set_p2p("alice", 1, s("peer-a"), ids.clone());
        let hosting = WsEvent::P2pAvailability {
            hoster: s("alice"),
            peer_id: Some(s("peer-a")),
            ids,
            online: true,
            scope_servers: vec![s("rchat")],
            scope_users: vec![s("bob")],
        };
        let conn = state.hub.next_conn();
        let mut carol = Access::new(Some(s("carol")), false, set(&["rchat"]));
        assert!(carol.wants(&hosting));
        assert_eq!(
            on_event(&state, conn, &mut carol, &hosting).await,
            Some(false)
        );
        assert_eq!(carol.who.pending, [s("alice")]);
        assert!(carol.who.pace.due.is_some());
        assert_eq!(
            p2p_visible(&state, &mut carol, "carol", "alice").await,
            Some(vec![s("pub")]),
            "the DM attachment's id never reaches a server co-member"
        );
        let mut alice = Access::new(Some(s("alice")), false, set(&["rchat"]));
        assert_eq!(
            on_event(&state, conn, &mut alice, &hosting).await,
            Some(true)
        );
        assert!(alice.who.pending.is_empty());
        let offline = p2p_offline(s("alice"), vec![s("rchat")], Vec::new());
        assert_eq!(
            on_event(&state, conn, &mut carol, &offline).await,
            Some(true)
        );

        let mut bob = Access::new(Some(s("bob")), false, HashSet::new());
        assert_eq!(
            p2p_visible(&state, &mut bob, "bob", "alice").await,
            Some(vec![s("pub"), s("dm")])
        );
        bob.who.pace.fire(Instant::now());
        bob.who
            .media
            .insert((s("alice"), s("new")), (Instant::now(), false));
        let mut posted = message();
        posted.media = Some(crate::api::MediaRef {
            id: s("new"),
            filename: s("a.txt"),
            kind: MediaKind::P2p,
            hoster: Some(s("alice")),
            expires_at: None,
            size: Some(1),
            mime: None,
            sha256: None,
            removed: false,
            removed_by_author: false,
            spoiler: false,
        });
        let created = WsEvent::Message {
            server: None,
            channel_id: None,
            dm_id: Some(dm),
            dm_users: Some(vec![s("alice"), s("bob")]),
            message: Box::new(posted),
        };
        assert_eq!(on_event(&state, conn, &mut bob, &created).await, Some(true));
        assert!(!bob.who.media.contains_key(&(s("alice"), s("new"))));
        assert_eq!(bob.who.pending, [s("alice")]);
        assert_eq!(
            bob.who.pace.due,
            bob.who.pace.last.map(|last| last + P2P_WHO_EVERY),
            "a hoster's new attachment is re-asked about on the next paced p2p_who"
        );
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn p2p_peer_ids_go_only_to_readers_of_the_message_with_a_token() {
        let (state, path) = crate::api::test_util::temp_state("p2p_release").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dave", "eve"] {
            add_user_row(db, name).await;
        }
        let general = insert_id(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        for (user, joined) in [("alice", 0), ("bob", 50), ("dave", 50)] {
            sqlx::query("INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, $2)")
                .bind(user)
                .bind(joined)
                .execute(db)
                .await
                .expect("member");
        }
        exec(db, "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) SELECT id, 'u:bob', 1, 1, 0 FROM channels WHERE server = 'rchat'").await;
        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 0)").await;
        exec(db, "INSERT INTO members(server, username, is_admin, joined_at) VALUES('vault', 'alice', 0, 0)").await;
        let vault = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('vault', 'general', 'text', 0) RETURNING id").await;
        let dm = insert_id(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id",
        )
        .await;
        let mut ids = HashMap::new();
        for (name, channel, dm_id, at, removed, expires) in [
            ("old", Some(general), None, 10, 0, None),
            ("new", Some(general), None, 60, 0, None),
            ("dm", None, Some(dm), 60, 0, None),
            ("vault", Some(vault), None, 60, 0, None),
            ("gone", Some(general), None, 60, 1, None),
            ("expired", Some(general), None, 60, 0, Some(1)),
        ] {
            let id: i64 = sqlx::query("INSERT INTO messages(channel_id, dm_id, author, content, media_id, media_kind, media_hoster, created_at, media_removed, media_expires_at) VALUES($1, $2, 'alice', '', $3, 'p2p', 'alice', $4, $5, $6) RETURNING id")
                .bind(channel)
                .bind(dm_id)
                .bind(name)
                .bind(at)
                .bind(removed)
                .bind(expires)
                .fetch_one(db)
                .await
                .expect("p2p message")
                .try_get(0)
                .expect("id");
            ids.insert(name, id);
        }
        state.hub.set_p2p(
            "alice",
            1,
            s("peer-a"),
            ["old", "new", "dm", "vault", "gone", "expired"]
                .map(s)
                .to_vec(),
        );
        let ask = |me: Option<&'static str>, file: &'static str| {
            let access = Access::new(me.map(s), false, set(&["rchat"]));
            let state = state.clone();
            let id = ids[file];
            async move { p2p_release(&state, &access, id, "peer-b").await }
        };
        let token = |ev: WsEvent| match ev {
            WsEvent::P2pPeer {
                message_id: _,
                peer_id: Some(peer),
                token: Some(token),
                expires_at: Some(_),
                error: None,
            } => Some((peer, token)),
            _ => None,
        };
        let refusal = |ev: WsEvent| match ev {
            WsEvent::P2pPeer {
                message_id,
                peer_id: None,
                token: None,
                expires_at: None,
                error: Some(error),
            } => Some((message_id, error)),
            _ => None,
        };
        let key = crate::p2p::host_key(&state.instance.p2p_secret, "alice", "peer-a");
        let (peer, granted) = token(ask(Some("bob"), "new").await).expect("bob reads new");
        assert_eq!(peer, "peer-a");
        let grant = crate::p2p::verify(&key, &granted, now()).expect("signed for alice's tab");
        assert_eq!(
            (
                grant.message_id,
                grant.p2p_id.as_str(),
                grant.requester.as_str(),
                grant.hoster.as_str(),
                grant.hoster_peer.as_str(),
                grant.requester_peer.as_str(),
            ),
            (ids["new"], "new", "bob", "alice", "peer-a", "peer-b")
        );
        assert!((grant.exp - now() - crate::p2p::TOKEN_TTL).abs() <= 2);
        assert_eq!(
            crate::p2p::verify(&key, &granted, grant.exp),
            None,
            "short-lived"
        );
        assert!(token(ask(Some("dave"), "old").await).is_some());
        assert!(token(ask(Some("carol"), "dm").await).is_some());
        assert!(
            token(ask(Some("eve"), "new").await).is_some(),
            "a public server's messages can be read without joining"
        );
        for (me, file, why) in [
            (
                Some("bob"),
                "old",
                "before bob joined, without read history",
            ),
            (Some("bob"), "dm", "a DM bob is not in"),
            (Some("eve"), "vault", "a protected server eve is not in"),
            (Some("alice"), "new", "the hoster has the file"),
            (Some("dave"), "gone", "removed"),
            (Some("dave"), "expired", "expired"),
        ] {
            assert_eq!(
                refusal(ask(me, file).await),
                Some((ids[file], s(NOT_AVAILABLE))),
                "{why}"
            );
        }
        assert!(token(ask(None, "new").await).is_none(), "guests");
        let dave = Access::new(Some(s("dave")), false, set(&["rchat"]));
        assert!(token(p2p_release(&state, &dave, ids["new"], "bad id").await).is_none());
        assert!(token(p2p_release(&state, &dave, 999_999, "peer-b").await).is_none());
        exec(
            db,
            "UPDATE users SET appear_offline = 1 WHERE username = 'alice'",
        )
        .await;
        assert!(
            token(ask(Some("dave"), "new").await).is_none(),
            "appears offline"
        );
        exec(
            db,
            "UPDATE users SET appear_offline = 0 WHERE username = 'alice'",
        )
        .await;
        state.hub.set_p2p("alice", 1, s("peer-a"), vec![s("old")]);
        assert!(
            token(ask(Some("dave"), "new").await).is_none(),
            "no tab hosts the file"
        );
        state.hub.set_p2p("alice", 2, s("peer-a2"), vec![s("new")]);
        let (peer, _) = token(ask(Some("dave"), "new").await).expect("the other tab");
        assert_eq!(peer, "peer-a2");
        exec(
            db,
            "INSERT INTO settings(key, value) VALUES('p2p_attachments', '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
        )
        .await;
        crate::api::Settings::forget(db);
        assert!(token(ask(Some("dave"), "new").await).is_none(), "P2P off");
        let mut allowed = 0;
        while state.hub.release_ok("zed") {
            allowed += 1;
        }
        assert_eq!(allowed, crate::hub::RELEASE_BURST);
        let limited = Access::new(Some(s("zed")), false, set(&["rchat"]));
        assert_eq!(
            refusal(p2p_release(&state, &limited, ids["new"], "peer-b").await),
            Some((
                ids["new"],
                s("Too many downloads at once, try again in a moment")
            ))
        );
        crate::api::test_util::done(state, path).await;
    }

    #[test]
    fn calls_name_only_plain_peer_ids() {
        assert_eq!(call_peer_id(None), Ok(None));
        assert_eq!(call_peer_id(Some(s("peer-a"))), Ok(Some(s("peer-a"))));
        assert_eq!(call_peer_id(Some(s("a b"))), Err(s("Invalid peer id")));
    }

    #[test]
    fn p2p_who_is_paced_and_merged_per_connection() {
        let mut who = Who::new();
        let now = Instant::now();
        who.ask(vec![s("Alice"), s("bob"), s("alice")]);
        assert_eq!(who.pending, [s("alice"), s("bob")]);
        assert!(who.pace.hit(now));
        who.pending.clear();
        who.ask(vec![s("carol")]);
        assert!(!who.pace.hit(now + Duration::from_millis(100)));
        who.ask(vec![s("dave"), s("carol")]);
        assert_eq!(who.pending, [s("carol"), s("dave")]);
        assert_eq!(who.pace.due, Some(now + P2P_WHO_EVERY));
        who.ask((0..200).map(|n| format!("u{n}")).collect());
        assert_eq!(who.pending.len(), P2P_WHO_CAP);
    }

    #[tokio::test]
    async fn p2p_who_shows_an_offline_hoster_only_to_their_call_partner() {
        let (state, path) = crate::api::test_util::temp_state("p2p_who_call").await;
        let db = &state.db;
        for name in ["alice", "carol", "eve"] {
            add_user_row(db, name).await;
        }
        exec(
            db,
            "UPDATE users SET appear_offline = 1 WHERE username = 'alice'",
        )
        .await;
        let dm = insert_id(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id",
        )
        .await;
        state
            .hub
            .set_p2p("alice", 1, "peer-a".to_string(), Vec::new());
        let ask = |me: &'static str| {
            let mut access = Access::new(Some(s(me)), false, set(&[]));
            let state = state.clone();
            async move { p2p_visible(&state, &mut access, me, "alice").await }
        };
        assert_eq!(ask("carol").await, None);
        let pair = vec![s("alice"), s("carol")];
        state
            .hub
            .call_start("alice", 1, dm, pair.clone(), CallKind::Rtc, false, 1, None)
            .await
            .expect("voice call");
        assert_eq!(
            ask("carol").await,
            None,
            "only P2P calls show an offline hoster"
        );
        state.hub.call_end("alice", dm).await.expect("end");
        state
            .hub
            .call_start("alice", 1, dm, pair, CallKind::P2p, false, 2, None)
            .await
            .expect("p2p call");
        assert_eq!(
            ask("carol").await,
            Some(Vec::new()),
            "online to the call partner, and never with a peer id"
        );
        assert_eq!(ask("eve").await, None);
        state.hub.call_end("alice", dm).await.expect("end");
        assert_eq!(ask("carol").await, None);
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn active_call_state_carries_the_answer_time() {
        let (state, path) = crate::api::test_util::temp_state("call_answered_at").await;
        let db = &state.db;
        for name in ["alice", "bob"] {
            add_user_row(db, name).await;
        }
        let dm = insert_id(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let mut rx = state.hub.subscribe();
        let start = ClientMsg::CallStart {
            dm_id: dm,
            p2p: false,
            video: false,
            peer_id: None,
        };
        voice_msg(&state, "alice", 1, start).await.expect("start");
        let accept = ClientMsg::CallAccept {
            dm_id: dm,
            peer_id: None,
        };
        voice_msg(&state, "bob", 2, accept).await.expect("accept");
        let mut seen = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::CallState {
                dm_id: _,
                dm_users: _,
                state,
                from: _,
                kind: _,
                video: _,
                call_id: _,
                answered_at,
                peers: _,
            } = ev
            {
                seen.push((state, answered_at));
            }
        }
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], (CallPhase::Ringing, None));
        assert_eq!(seen[1].0, CallPhase::Active);
        assert!(seen[1].1.is_some_and(|at| at > 0));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn blocked_users_cannot_call() {
        let (state, path) = crate::api::test_util::temp_state("call_blocked").await;
        let db = &state.db;
        for name in ["alice", "bob"] {
            add_user_row(db, name).await;
        }
        let dm = insert_id(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 1)")
            .execute(db)
            .await
            .expect("block");
        let start = || ClientMsg::CallStart {
            dm_id: dm,
            p2p: false,
            video: false,
            peer_id: None,
        };
        assert_eq!(
            voice_msg(&state, "bob", 1, start()).await.err().as_deref(),
            Some(crate::api::blocks::NOT_ACCEPTING)
        );
        assert!(voice_msg(&state, "alice", 2, start()).await.is_err());
        let logs = insert_id(db, "SELECT COUNT(*) FROM messages WHERE kind = 'call'").await;
        assert_eq!(logs, 0);
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn blocking_ends_calls_and_stops_answers_and_signals() {
        let (state, path) = crate::api::test_util::temp_state("call_block_ends").await;
        let db = &state.db;
        for name in ["alice", "bob"] {
            add_user_row(db, name).await;
        }
        let dm = insert_id(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let start = || ClientMsg::CallStart {
            dm_id: dm,
            p2p: false,
            video: false,
            peer_id: None,
        };
        let accept = || ClientMsg::CallAccept {
            dm_id: dm,
            peer_id: None,
        };
        let signal = || ClientMsg::RtcSignal {
            to: s("alice"),
            channel_id: None,
            dm_id: Some(dm),
            payload: serde_json::json!({ "sdp": "x" }),
        };
        let block = async |on: bool| match on {
            true => {
                let _ = crate::api::blocks::block_user(
                    State(state.clone()),
                    crate::api::Authed(crate::api::test_util::mem_user("alice", false)),
                    axum::Json(
                        serde_json::from_value(serde_json::json!({ "username": "bob" }))
                            .expect("req"),
                    ),
                )
                .await
                .expect("block");
            }
            false => {
                sqlx::query("DELETE FROM blocks")
                    .execute(&state.db)
                    .await
                    .expect("unblock");
            }
        };
        let quiet_block = async || {
            sqlx::query(
                "INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 1)",
            )
            .execute(&state.db)
            .await
            .expect("row");
        };
        let outcome = async || -> (Option<String>, bool) {
            let r = sqlx::query(
                "SELECT call_outcome, call_ended_at FROM messages WHERE kind = 'call' ORDER BY id DESC LIMIT 1",
            )
            .fetch_one(&state.db)
            .await
            .expect("log");
            (r.get(0), r.get::<Option<i64>, _>(1).is_some())
        };
        let ended = |rx: &mut broadcast::Receiver<WsEvent>| {
            std::iter::from_fn(|| rx.try_recv().ok()).any(|ev| {
                matches!(ev, WsEvent::CallState { dm_id, state: CallPhase::Ended, .. } if dm_id == dm)
            })
        };

        voice_msg(&state, "bob", 1, start()).await.expect("ring");
        let mut rx = state.hub.subscribe();
        block(true).await;
        assert!(ended(&mut rx), "the ringing call ends");
        assert_eq!(outcome().await, (Some(s("declined")), true));
        assert!(voice_msg(&state, "alice", 2, accept()).await.is_err());
        block(false).await;

        voice_msg(&state, "bob", 1, start())
            .await
            .expect("ring again");
        quiet_block().await;
        assert_eq!(
            voice_msg(&state, "alice", 2, accept())
                .await
                .err()
                .as_deref(),
            Some("You blocked this user. Unblock them to send messages.")
        );
        state.hub.call_end("bob", dm).await.expect("end");
        block(false).await;

        voice_msg(&state, "bob", 1, start()).await.expect("ring");
        voice_msg(&state, "alice", 2, accept())
            .await
            .expect("answer");
        voice_msg(&state, "bob", 1, signal())
            .await
            .expect("signals flow");
        quiet_block().await;
        assert_eq!(
            voice_msg(&state, "bob", 1, signal()).await.err().as_deref(),
            Some(crate::api::blocks::NOT_ACCEPTING)
        );
        block(false).await;

        let mut rx = state.hub.subscribe();
        block(true).await;
        assert!(ended(&mut rx), "the active call ends");
        assert_eq!(outcome().await, (Some(s("completed")), true));
        assert!(voice_msg(&state, "bob", 1, signal()).await.is_err());
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn call_logs_record_video_and_the_connection() {
        let (state, path) = crate::api::test_util::temp_state("call_log_kind").await;
        let db = &state.db;
        for name in ["alice", "bob"] {
            add_user_row(db, name).await;
        }
        let dm = insert_id(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let mut logs = Vec::new();
        for (p2p, video) in [(false, false), (true, true), (false, true)] {
            let start = ClientMsg::CallStart {
                dm_id: dm,
                p2p,
                video,
                peer_id: p2p.then(|| s("peer-a")),
            };
            let mut rx = state.hub.subscribe();
            voice_msg(&state, "alice", 1, start).await.expect("start");
            let mut rung = None;
            while let Ok(ev) = rx.try_recv() {
                if let WsEvent::CallState {
                    dm_id: _,
                    dm_users: _,
                    state: _,
                    from: _,
                    kind,
                    video,
                    call_id: _,
                    answered_at: _,
                    peers: _,
                } = ev
                {
                    rung = Some((kind, video));
                }
            }
            let kind = match p2p {
                true => CallKind::P2p,
                false => CallKind::Rtc,
            };
            assert_eq!(
                rung,
                Some((kind, video)),
                "the ringing state names the call type"
            );
            state.hub.call_end("alice", dm).await.expect("end");
            let id: i64 = sqlx::query("SELECT MAX(id) FROM messages WHERE kind = 'call'")
                .fetch_one(db)
                .await
                .expect("log")
                .get(0);
            let call = load_message(db, id, Quotes::Skip)
                .await
                .expect("load")
                .expect("row")
                .call
                .expect("call log");
            logs.push((call.p2p, call.video));
        }
        assert_eq!(
            logs,
            [
                (Some(false), Some(false)),
                (Some(true), Some(true)),
                (Some(false), Some(true)),
            ]
        );
        exec(
            db,
            "INSERT INTO messages(dm_id, author, content, kind, created_at) VALUES(1, 'alice', '', 'call', 1)",
        )
        .await;
        let old: i64 = sqlx::query("SELECT MAX(id) FROM messages")
            .fetch_one(db)
            .await
            .expect("old")
            .get(0);
        let call = load_message(db, old, Quotes::Skip)
            .await
            .expect("load")
            .expect("row")
            .call
            .expect("call log");
        assert_eq!(
            (call.p2p, call.video),
            (None, None),
            "older logs stay unknown"
        );
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn viewing_snapshot_is_bounded_and_counts_the_viewer() {
        let hub = Hub::new();
        let mut names: Vec<String> = (0..60).map(|i| format!("u{i:02}")).collect();
        for (i, name) in names.iter().enumerate() {
            hub.set_online(name, 100 + i as u64, &["rchat"]);
        }
        let mut me = viewer("aaron", false);
        me.view(&hub, 1, Some(s("rchat")));
        let Some(WsEvent::PresenceSnapshot {
            server,
            online,
            online_count,
        }) = presence_snapshot(&hub, &me, "rchat")
        else {
            panic!("snapshot");
        };
        names.insert(0, s("aaron"));
        names.truncate(PRESENCE_SNAPSHOT_MAX);
        assert_eq!(
            (server.as_str(), online, online_count),
            ("rchat", names, 61)
        );
        let hidden = viewer("zed", true);
        let Some(WsEvent::PresenceSnapshot {
            online,
            online_count,
            ..
        }) = presence_snapshot(&hub, &hidden, "rchat")
        else {
            panic!("snapshot");
        };
        assert!(!online.iter().any(|n| n == "zed"));
        assert_eq!(online_count, 61);
        let mut early = viewer("ab", false);
        early.announced = true;
        let Some(WsEvent::PresenceSnapshot {
            online,
            online_count,
            ..
        }) = presence_snapshot(&hub, &early, "rchat")
        else {
            panic!("snapshot");
        };
        assert_eq!(
            (online.len(), &online[..3], online_count),
            (50, &[s("aaron"), s("ab"), s("u00")][..], 62)
        );
        assert!(presence_snapshot(&hub, &me, "elsewhere").is_none());
        let ev = presence_snapshot(&hub, &me, "rchat").expect("snapshot");
        assert!(!wants(
            &ev,
            Some("aaron"),
            true,
            &set(&["rchat"]),
            &set(&[])
        ));
    }

    #[test]
    fn presence_events_carry_the_online_count() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        hub.set_online("ann", 1, &["rchat"]);
        hub.set_online("bo", 2, &["rchat"]);
        hub.set_online("bo", 3, &["rchat"]);
        hub.set_online("bo", 2, &[] as &[&str]);
        hub.set_online("bo", 3, &[] as &[&str]);
        hub.set_online("ann", 1, &["other"]);
        let mut counts = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::PresenceChanged {
                server,
                username,
                online,
                online_count,
            } = ev
            {
                counts.push((server, username, online, online_count));
            }
        }
        assert_eq!(
            counts,
            [
                (s("rchat"), s("ann"), true, 1),
                (s("rchat"), s("bo"), true, 2),
                (s("rchat"), s("bo"), false, 1),
                (s("rchat"), s("ann"), false, 0),
                (s("other"), s("ann"), true, 1),
            ]
        );
    }

    #[test]
    fn presence_order_matches_the_client() {
        let hub = Hub::new();
        let names = [
            "\u{1f600}",
            "z",
            "\u{ff21}",
            "a",
            "\u{e9}",
            "ab",
            "\u{1f600}a",
        ];
        for (i, name) in names.iter().enumerate() {
            hub.set_online(name, 10 + i as u64, &["rchat"]);
        }
        assert_eq!(
            hub.online_after("rchat", None, 50),
            [
                "a",
                "ab",
                "z",
                "\u{e9}",
                "\u{ff21}",
                "\u{1f600}",
                "\u{1f600}a"
            ]
        );
    }

    #[test]
    fn server_ban_notice_goes_only_to_the_banned_user() {
        let ev = WsEvent::ServerBanned {
            server: s("open"),
            username: s("bob"),
        };
        let none = set(&[]);
        assert!(wants(&ev, Some("bob"), false, &none, &none));
        assert!(!wants(
            &ev,
            Some("carol"),
            false,
            &set(&["open"]),
            &set(&["open"])
        ));
        assert!(!wants(&ev, None, false, &none, &set(&["open"])));
    }

    #[tokio::test]
    async fn a_ban_drops_live_subscriptions() {
        let (state, path) = crate::api::test_util::temp_state("ws_ban_drops_subs").await;
        let conn = state.hub.next_conn();
        let post = |server: &str| WsEvent::Message {
            server: Some(s(server)),
            channel_id: Some(7),
            dm_id: None,
            dm_users: None,
            message: Box::new(message()),
        };
        let presence = WsEvent::PresenceChanged {
            server: s("open"),
            username: s("bob"),
            online: true,
            online_count: 1,
        };
        let mut carol = Access::new(Some(s("carol")), false, set(&["rchat"]));
        carol.subs = set(&["open", "other"]);
        carol.viewing = Some(s("open"));
        carol.viewable = HashMap::from([(7, (s("open"), true))]);
        assert_eq!(
            on_event(&state, conn, &mut carol, &post("open")).await,
            Some(true)
        );
        let banned = WsEvent::ServerBanned {
            server: s("open"),
            username: s("carol"),
        };
        let elsewhere = WsEvent::ServerBanned {
            server: s("open"),
            username: s("dave"),
        };
        assert_eq!(
            on_event(&state, conn, &mut carol, &elsewhere).await,
            Some(false)
        );
        assert_eq!(carol.subs, set(&["open", "other"]));
        assert_eq!(
            on_event(&state, conn, &mut carol, &banned).await,
            Some(true)
        );
        assert_eq!(carol.subs, set(&["other"]));
        assert_eq!(carol.viewing, None);
        assert!(carol.topics_dirty);
        let topics = carol.topics();
        assert!(!topics.contains(&Topic::Server(s("open"))));
        assert!(!topics.contains(&Topic::View(s("open"))));
        assert_eq!(
            on_event(&state, conn, &mut carol, &post("open")).await,
            Some(false)
        );
        assert_eq!(
            on_event(&state, conn, &mut carol, &presence).await,
            Some(false)
        );
        let mut bert = Access::new(Some(s("bert")), false, set(&["open"]));
        bert.subs = set(&["open"]);
        bert.viewable = HashMap::from([(7, (s("open"), true))]);
        let kicked = WsEvent::MemberKicked {
            server: s("open"),
            username: s("bert"),
            banned: true,
        };
        assert_eq!(on_event(&state, conn, &mut bert, &kicked).await, Some(true));
        assert!(bert.subs.is_empty() && bert.member_servers.is_empty());
        assert_eq!(
            on_event(&state, conn, &mut bert, &post("open")).await,
            Some(false)
        );
        let mut gail = Access::new(Some(s("gail")), false, set(&["open"]));
        gail.subs = set(&["open"]);
        let left = WsEvent::MemberKicked {
            server: s("open"),
            username: s("gail"),
            banned: false,
        };
        on_event(&state, conn, &mut gail, &left).await;
        assert_eq!(gail.subs, set(&["open"]));
        crate::api::test_util::done(state, path).await;
    }

    fn presence_events(rx: &mut broadcast::Receiver<WsEvent>) -> Vec<(String, bool)> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::PresenceChanged {
                server,
                username: _,
                online,
                online_count: _,
            } = ev
            {
                out.push((server, online));
            }
        }
        out
    }

    fn presence_counts(rx: &mut broadcast::Receiver<WsEvent>) -> Vec<(String, String, bool, i64)> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::PresenceChanged {
                server,
                username,
                online,
                online_count,
            } = ev
            {
                out.push((server, username, online, online_count));
            }
        }
        out
    }

    #[tokio::test]
    async fn members_are_online_in_every_server_without_viewing_one() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        let mut a = Access::new(Some(s("alice")), false, set(&["one", "two"]));
        a.sync(&hub, 1);
        assert!(a.viewing.is_none());
        assert!(hub.is_online("one", "alice") && hub.is_online("two", "alice"));
        a.view(&hub, 1, Some(s("one")));
        a.view(&hub, 1, None);
        assert!(hub.is_online("one", "alice") && hub.is_online("two", "alice"));
        let mut b = Access::new(Some(s("alice")), false, set(&["one", "two"]));
        b.sync(&hub, 2);
        assert_eq!(hub.online_count("one"), 1);
        assert_eq!(
            presence_counts(&mut rx),
            vec![
                (s("one"), s("alice"), true, 1),
                (s("two"), s("alice"), true, 1)
            ]
        );
        let _ = hub.drop_conn("alice", 1).await;
        assert!(hub.is_online("one", "alice") && hub.is_online("two", "alice"));
        assert!(presence_counts(&mut rx).is_empty());
        let _ = hub.drop_conn("alice", 2).await;
        let mut back = Access::new(Some(s("alice")), false, set(&["one", "two"]));
        back.sync(&hub, 5);
        let _ = hub.drop_conn("alice", 5).await;
        assert!(hub.is_online("one", "alice") && presence_counts(&mut rx).is_empty());
        hub.expire_presence();
        assert!(!hub.is_online("one", "alice") && !hub.is_online("two", "alice"));
        assert_eq!(
            presence_counts(&mut rx),
            vec![
                (s("one"), s("alice"), false, 0),
                (s("two"), s("alice"), false, 0)
            ]
        );
        let mut lone = Access::new(Some(s("zoe")), false, HashSet::new());
        lone.sync(&hub, 3);
        assert!(lone.announced && hub.is_online_anywhere("zoe"));
        assert!(presence_counts(&mut rx).is_empty());
        let mut guest = Access::new(None, false, set(&["one"]));
        guest.sync(&hub, 4);
        assert!(!guest.announced && hub.online_set("one").is_empty());
    }

    #[tokio::test]
    async fn online_counts_follow_membership() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        let mut alice = Access::new(Some(s("alice")), false, set(&["one"]));
        let mut bob = Access::new(Some(s("bob")), false, set(&["one", "two"]));
        alice.sync(&hub, 1);
        bob.sync(&hub, 2);
        assert_eq!((hub.online_count("one"), hub.online_count("two")), (2, 1));
        let _ = presence_counts(&mut rx);
        let mut step = |ev: WsEvent| {
            hub.broadcast(ev.clone());
            for (conn, access) in [(1, &mut alice), (2, &mut bob)] {
                track(&ev, access);
                access.sync(&hub, conn);
            }
            presence_counts(&mut rx)
        };
        assert_eq!(
            step(joined("two", "alice")),
            vec![(s("two"), s("alice"), true, 2)]
        );
        let left = WsEvent::MemberLeft {
            server: s("two"),
            username: s("alice"),
        };
        assert_eq!(step(left), vec![(s("two"), s("alice"), false, 1)]);
        step(joined("two", "alice"));
        let kicked = WsEvent::MemberKicked {
            server: s("two"),
            username: s("alice"),
            banned: false,
        };
        assert_eq!(step(kicked), vec![(s("two"), s("alice"), false, 1)]);
        let banned = WsEvent::MemberKicked {
            server: s("one"),
            username: s("bob"),
            banned: true,
        };
        assert_eq!(step(banned), vec![(s("one"), s("bob"), false, 1)]);
        assert!(step(renamed("two", "deux")).is_empty());
        assert_eq!(hub.online_set("deux"), HashSet::from([s("bob")]));
        assert!(hub.online_set("two").is_empty());
        assert!(step(WsEvent::ServerDeleted { name: s("deux") }).is_empty());
        assert_eq!(hub.online_count("deux"), 0);
        let purged = WsEvent::MembersPurged {
            server: s("one"),
            usernames: vec![s("alice")],
        };
        assert_eq!(step(purged), vec![(s("one"), s("alice"), false, 0)]);
        assert!(hub.online_set("one").is_empty());
        assert!(bob.member_servers.is_empty() && bob.moved.is_empty());
    }

    #[tokio::test]
    async fn membership_changes_post_deltas_not_full_lists() {
        let (hub, mut out) = Hub::replicated();
        let mut ops =
            || -> Vec<Op> { std::iter::from_fn(|| out.try_recv().ok().map(|e| e.op)).collect() };
        let many: HashSet<String> = (0..1500).map(|i| format!("s{i:04}")).collect();
        let mut alice = Access::new(Some(s("alice")), false, many);
        alice.sync(&hub, 1);
        assert!(matches!(
            ops().as_slice(),
            [Op::Online { lit: true, cap: 20, scope: Some(Scope { servers, hidden: false, seq: 0 }), .. }]
                if servers.len() == PRESENCE_SERVERS_MAX && servers[0] == "s0000"
        ));
        let mut step = |ev: WsEvent| {
            track(&ev, &mut alice);
            alice.sync(&hub, 1);
        };
        step(joined("elsewhere", "bob"));
        step(renamed("other", "else"));
        step(WsEvent::RolesChanged { server: s("s0001") });
        assert!(ops().is_empty());
        step(joined("new", "alice"));
        step(WsEvent::MemberLeft {
            server: s("s0002"),
            username: s("alice"),
        });
        alice.set_hidden(&hub, 1, true, 0);
        let posted = ops();
        assert!(matches!(
            posted.as_slice(),
            [
                Op::Rescope { add: a1, remove: r1, hidden: None, .. },
                Op::Rescope { add: a2, remove: r2, hidden: None, .. },
                Op::Rescope { add: a3, remove: r3, hidden: Some(true), .. },
            ] if *a1 == [s("new")] && r1.is_empty() && a2.is_empty() && *r2 == [s("s0002")]
                && a3.is_empty() && r3.is_empty()
        ));
    }

    fn viewer(user: &str, hidden: bool) -> Access {
        let mut access = Access::new(Some(s(user)), false, set(&["rchat", "other"]));
        access.hidden = hidden;
        access
    }

    #[tokio::test]
    async fn appear_offline_suppresses_and_restores_presence() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        let (mut a, mut b) = (viewer("alice", false), viewer("alice", false));
        a.sync(&hub, 1);
        b.sync(&hub, 2);
        assert!(hub.is_online("rchat", "alice") && hub.is_online("other", "alice"));
        assert_eq!(hub.online_count("rchat"), 1);
        assert_eq!(
            presence_events(&mut rx),
            vec![(s("other"), true), (s("rchat"), true)]
        );
        a.set_hidden(&hub, 1, true, 0);
        assert!(!hub.is_online("rchat", "alice") && !hub.is_online("other", "alice"));
        b.set_hidden(&hub, 2, true, 0);
        assert_eq!(hub.online_count("rchat"), 0);
        assert!(hub.online_set("rchat").is_empty());
        assert_eq!(
            presence_events(&mut rx),
            vec![(s("other"), false), (s("rchat"), false)]
        );
        let mut c = viewer("alice", true);
        c.sync(&hub, 3);
        c.view(&hub, 3, Some(s("rchat")));
        b.set_hidden(&hub, 2, true, 0);
        assert!(!hub.is_online("rchat", "alice") && !hub.is_online("other", "alice"));
        assert!(presence_events(&mut rx).is_empty());
        a.set_hidden(&hub, 1, false, 0);
        assert!(hub.is_online("other", "alice") && hub.is_online("rchat", "alice"));
        c.set_hidden(&hub, 3, false, 0);
        b.set_hidden(&hub, 2, false, 0);
        assert_eq!(hub.online_count("rchat"), 1);
        assert_eq!(
            presence_events(&mut rx),
            vec![(s("other"), true), (s("rchat"), true)]
        );
        a.set_hidden(&hub, 1, true, 0);
        assert!(!hub.is_online("rchat", "alice") && !hub.is_online("other", "alice"));
        assert_eq!(
            presence_events(&mut rx),
            vec![(s("other"), false), (s("rchat"), false)]
        );
        let _ = hub.drop_conn("alice", 1).await;
        let _ = hub.drop_conn("alice", 3).await;
        let _ = hub.drop_conn("alice", 2).await;
        hub.expire_presence();
        assert!(!hub.is_online("rchat", "alice") && presence_events(&mut rx).is_empty());
    }

    async fn lagged_presence_state(tag: &str) -> (AppState, std::path::PathBuf) {
        let (state, path) = crate::api::test_util::temp_state(tag).await;
        add_user(&state.db, "alice").await;
        exec(
            &state.db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('chat', 'chat', 1)",
        )
        .await;
        exec(
            &state.db,
            "INSERT INTO members(server, username, joined_at) VALUES('chat', 'alice', 1)",
        )
        .await;
        (state, path)
    }

    #[tokio::test]
    async fn lagged_rename_drops_stale_presence() {
        let (state, path) = lagged_presence_state("ws_lag_rename").await;
        let hub = state.hub.clone();
        let mut rx = hub.subscribe();
        let mut a = Access::new(Some(s("alice")), false, set(&["rchat"]));
        a.view(&hub, 1, Some(s("rchat")));
        hub.broadcast(renamed("rchat", "chat"));
        assert!(hub.is_online("chat", "alice"));
        let _ = presence_events(&mut rx);
        exec(&state.db, "UPDATE users SET appear_offline = 1").await;
        assert!(a.refresh(&state, 1).await);
        assert!(a.hidden);
        assert_eq!(a.viewing, None);
        hub.expire_presence();
        assert!(!hub.is_online("chat", "alice"));
        assert_eq!(presence_events(&mut rx), vec![(s("chat"), false)]);
        a.set_hidden(&hub, 1, false, 0);
        assert!(hub.is_online("chat", "alice") && !hub.is_online("rchat", "alice"));
        let _ = hub.drop_conn("alice", 1).await;
        hub.expire_presence();
        assert_eq!(
            presence_events(&mut rx),
            vec![(s("chat"), true), (s("chat"), false)]
        );
        assert!(hub.online_set("chat").is_empty() && hub.online_set("rchat").is_empty());
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn lagged_resync_keeps_valid_presence() {
        let (state, path) = lagged_presence_state("ws_lag_keep").await;
        let hub = state.hub.clone();
        let mut a = Access::new(Some(s("alice")), false, set(&["rchat"]));
        a.view(&hub, 1, Some(s("rchat")));
        hub.broadcast(renamed("rchat", "chat"));
        a.viewing = Some(s("chat"));
        assert!(a.refresh(&state, 1).await);
        assert!(hub.is_online("chat", "alice"));
        exec(&state.db, "UPDATE users SET appear_offline = 1").await;
        assert!(a.refresh(&state, 1).await);
        hub.expire_presence();
        assert!(!hub.is_online("chat", "alice"));
        exec(&state.db, "UPDATE users SET appear_offline = 0").await;
        assert!(a.refresh(&state, 1).await);
        assert!(hub.is_online("chat", "alice"));
        let _ = hub.drop_conn("alice", 1).await;
        hub.expire_presence();
        assert!(!hub.is_online("chat", "alice"));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn leave_after_lagged_rename_removes_presence() {
        let hub = Hub::new();
        let mut a = viewer("alice", false);
        a.view(&hub, 1, Some(s("rchat")));
        hub.broadcast(renamed("rchat", "chat"));
        let _ = hub.drop_conn("alice", 1).await;
        hub.expire_presence();
        assert!(!hub.is_online("chat", "alice"));
        assert!(hub.online_set("chat").is_empty());
    }

    #[tokio::test]
    async fn force_offline_does_not_steal_other_connections() {
        let hub = Hub::new();
        let (mut a, mut b) = (viewer("alice", false), viewer("alice", false));
        a.sync(&hub, 1);
        hub.force_offline("rchat", "alice");
        assert!(!hub.is_online("rchat", "alice") && hub.is_online("other", "alice"));
        b.sync(&hub, 2);
        assert!(hub.is_online("rchat", "alice"));
        let _ = hub.drop_conn("alice", 2).await;
        assert!(hub.is_online("rchat", "alice") && hub.is_online("other", "alice"));
        let mut rx = hub.subscribe();
        hub.broadcast(WsEvent::Banned {
            username: s("alice"),
        });
        assert!(!hub.is_online("other", "alice"));
        let _ = hub.drop_conn("alice", 1).await;
        hub.expire_presence();
        assert_eq!(
            presence_events(&mut rx),
            vec![(s("other"), false), (s("rchat"), false)]
        );
        assert!(hub.online_set("rchat").is_empty() && hub.online_set("other").is_empty());
    }

    #[test]
    fn presence_mode_reaches_only_its_user() {
        let ev = WsEvent::PresenceMode {
            username: s("alice"),
            appear_offline: true,
            seq: 0,
        };
        let none = HashSet::new();
        assert!(wants(&ev, Some("alice"), false, &none, &none));
        assert!(!wants(&ev, Some("bob"), true, &none, &none));
        assert!(!wants(&ev, None, false, &none, &none));
        assert!(!wants(&WsEvent::Resync, Some("alice"), true, &none, &none));
    }

    fn apply_modes(
        hub: &Hub,
        rx: &mut broadcast::Receiver<WsEvent>,
        conn: u64,
        access: &mut Access,
    ) {
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::PresenceMode {
                username,
                appear_offline,
                seq,
            } = ev
                && access.user.as_deref() == Some(username.as_str())
            {
                access.set_hidden(hub, conn, appear_offline, seq);
            }
        }
    }

    #[tokio::test]
    async fn appear_offline_holds_across_instances() {
        let bus = crate::hub::tests::MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let (mut rx_a, mut rx_b) = (a.subscribe(), b.subscribe());
        let (ca, cb) = (a.next_conn(), b.next_conn());
        let (mut on_a, mut on_b) = (viewer("alice", false), viewer("alice", false));
        on_a.view(&a, ca, Some(s("rchat")));
        on_b.view(&b, cb, Some(s("rchat")));
        a.flush().await;
        b.flush().await;
        assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
        a.broadcast(WsEvent::PresenceMode {
            username: s("alice"),
            appear_offline: true,
            seq: 1,
        });
        a.flush().await;
        apply_modes(&a, &mut rx_a, ca, &mut on_a);
        apply_modes(&b, &mut rx_b, cb, &mut on_b);
        a.flush().await;
        b.flush().await;
        assert!(!a.is_online("rchat", "alice") && !b.is_online("rchat", "alice"));
        on_b.view(&b, cb, Some(s("other")));
        b.flush().await;
        assert!(!a.is_online("other", "alice"));
        b.broadcast(WsEvent::PresenceMode {
            username: s("alice"),
            appear_offline: false,
            seq: 2,
        });
        b.flush().await;
        apply_modes(&a, &mut rx_a, ca, &mut on_a);
        apply_modes(&b, &mut rx_b, cb, &mut on_b);
        a.flush().await;
        b.flush().await;
        assert!(a.is_online("rchat", "alice") && a.is_online("other", "alice"));
        assert!(b.is_online("rchat", "alice") && b.is_online("other", "alice"));
    }

    // Review I1: a socket reads `appear_offline` before alice turns it on and announces after
    // the change, without ever seeing the event. She stays hidden on every node.
    #[tokio::test]
    async fn a_socket_with_a_stale_appear_offline_can_not_unhide() {
        let bus = crate::hub::tests::MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let mut rx_a = a.subscribe();
        let (ca, cb) = (a.next_conn(), b.next_conn());
        let mut on_a = viewer("alice", false);
        on_a.view(&a, ca, Some(s("rchat")));
        a.flush().await;
        b.flush().await;
        assert!(b.is_online("rchat", "alice"));
        let mut late = viewer("alice", false);
        late.take_mode((false, 0));
        a.broadcast(WsEvent::PresenceMode {
            username: s("alice"),
            appear_offline: true,
            seq: 1,
        });
        a.flush().await;
        apply_modes(&a, &mut rx_a, ca, &mut on_a);
        a.flush().await;
        b.flush().await;
        assert!(!a.is_online("rchat", "alice") && !b.is_online("rchat", "alice"));
        late.view(&b, cb, Some(s("rchat")));
        b.flush().await;
        a.flush().await;
        assert!(!a.is_online("rchat", "alice") && !b.is_online("rchat", "alice"));
        assert!(!b.is_online("other", "alice") && a.online_set("rchat").is_empty());
        // An event older than what the connection read is ignored by the connection too.
        late.take_mode((true, 1));
        late.set_hidden(&b, cb, false, 0);
        assert!(late.hidden);
        // A newer value shows her again.
        b.broadcast(WsEvent::PresenceMode {
            username: s("alice"),
            appear_offline: false,
            seq: 2,
        });
        b.flush().await;
        a.flush().await;
        assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
    }

    #[tokio::test]
    async fn pending_epoch_stays_dark_until_recovered() {
        let (state, path) = lagged_presence_state("ws_epoch_dark").await;
        let hub = state.hub.clone();
        let mut rx = hub.subscribe();
        let mut a = Access::new(Some(s("alice")), false, set(&["chat"]));
        a.view(&hub, 1, Some(s("chat")));
        a.hosting = Some((s("peer"), vec![s("f1")]));
        a.announce(&state, 1).await;
        assert!(hub.is_online("chat", "alice"));
        assert!(hub.p2p_of("alice").is_some());
        let _ = rx.try_recv();
        while rx.try_recv().is_ok() {}
        assert!(a.hold(sqlx::Error::PoolClosed, Instant::now()));
        a.announce(&state, 1).await;
        assert!(a.dark);
        hub.expire_presence();
        assert!(!hub.is_online("chat", "alice"));
        a.view(&hub, 1, Some(s("chat")));
        a.set_hidden(&hub, 1, false, 0);
        assert!(!hub.is_online("chat", "alice"));
        let mut hosted = 0;
        while let Ok(ev) = rx.try_recv() {
            hosted += matches!(ev, WsEvent::P2pAvailability { .. }) as usize;
        }
        assert_eq!(hosted, 0);
        assert!(a.refresh(&state, 1).await);
        assert!(!a.retry.pending() && a.dark && a.missed);
        a.announce(&state, 1).await;
        assert!(!a.dark);
        assert!(hub.is_online("chat", "alice"));
        let mut hosted = 0;
        while let Ok(ev) = rx.try_recv() {
            hosted += matches!(ev, WsEvent::P2pAvailability { online: true, .. }) as usize;
        }
        assert_eq!(hosted, 1);
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn channel_gate_holds_on_database_errors() {
        let (state, path) = crate::api::test_util::temp_state("ws_gate_error").await;
        let mut bob = Access::new(Some(s("bob")), false, set(&["rchat"]));
        crate::db::close(&state.db).await;
        assert_eq!(
            channel_gate(&state, &mut bob, "rchat", 1).await,
            Some(false)
        );
        assert!(bob.retry.pending() && bob.missed);
        assert!(bob.viewable.is_empty());
        bob.retry.since = Instant::now().checked_sub(REAUTH_GIVE_UP);
        assert_eq!(channel_gate(&state, &mut bob, "rchat", 1).await, None);
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn reposted_presence_mode_reads_the_database() {
        let (state, path) = crate::api::test_util::temp_state("ws_repost_mode").await;
        add_user(&state.db, "alice").await;
        exec(&state.db, "UPDATE users SET appear_offline = 1").await;
        let mode = |user: &str, appear_offline| WsEvent::PresenceMode {
            username: s(user),
            appear_offline,
            seq: 0,
        };
        assert!(matches!(
            current(&state, mode("alice", false)).await,
            Some(WsEvent::PresenceMode {
                appear_offline: true,
                ..
            })
        ));
        assert!(current(&state, mode("ghost", true)).await.is_none());
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn token_live_follows_the_tokens_table() {
        let (state, path) = crate::api::test_util::temp_state("token_live").await;
        let db = &state.db;
        add_user(db, "tia").await;
        exec(
            db,
            "INSERT INTO tokens(token, username, created_at) VALUES('h:628b49d96dcde97a430dd4f597705899e09a968f793491e4b704cae33a40dc02', 'tia', 0)",
        )
        .await;
        assert!(token_live(db, Some("t1")).await.unwrap());
        assert!(!token_live(db, Some("t2")).await.unwrap());
        assert!(!token_live(db, None).await.unwrap());
        exec(db, "DELETE FROM tokens WHERE token = 'h:628b49d96dcde97a430dd4f597705899e09a968f793491e4b704cae33a40dc02'").await;
        assert!(!token_live(db, Some("t1")).await.unwrap());
        crate::db::close(&state.db).await;
        assert!(token_live(db, Some("t1")).await.is_err());
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn token_recheck_fails_closed() {
        let (state, path) = crate::api::test_util::temp_state("ws_token_recheck").await;
        let db = &state.db;
        add_user(db, "tia").await;
        exec(
            db,
            "INSERT INTO tokens(token, username, created_at) VALUES('h:628b49d96dcde97a430dd4f597705899e09a968f793491e4b704cae33a40dc02', 'tia', 0), ('h:c44474038d459e40e4714afefa7bf8dae9f9834b22f5e8ec1dd434ecb62b512e', 'tia', 0)",
        )
        .await;
        let session = |token: &str| {
            let mut access = Access::new(Some(s("tia")), false, set(&["vault"]));
            access.token = Some(s(token));
            access.subs = set(&["open"]);
            access
        };
        let (mut tia, mut gone) = (session("t1"), session("t2"));
        exec(db, "DELETE FROM tokens WHERE token = 'h:c44474038d459e40e4714afefa7bf8dae9f9834b22f5e8ec1dd434ecb62b512e'").await;
        assert!(tia.check_token(db).await && !tia.retry.pending());
        assert!(!gone.check_token(db).await);
        let dm = WsEvent::Message {
            server: None,
            channel_id: None,
            dm_id: Some(2),
            dm_users: Some(vec![s("tia"), s("bob")]),
            message: Box::new(message()),
        };
        let scoped = [
            dm.clone(),
            WsEvent::MemberKicked {
                server: s("vault"),
                username: s("tia"),
                banned: false,
            },
            WsEvent::PresenceMode {
                username: s("tia"),
                appear_offline: true,
                seq: 0,
            },
            WsEvent::PresenceChanged {
                server: s("open"),
                username: s("bob"),
                online: true,
                online_count: 1,
            },
            WsEvent::ServerCreated {
                server: lite("seeded"),
            },
            WsEvent::RtcSignal {
                to: s("tia"),
                from: s("bob"),
                channel_id: None,
                dm_id: Some(2),
                payload: serde_json::Value::Null,
            },
        ];
        assert!(scoped.iter().take(4).all(|ev| tia.wants(ev)));
        crate::db::close(&state.db).await;
        let started = Instant::now();
        assert!(tia.check_token(db).await);
        assert!(tia.retry.pending() && tia.missed && tia.retry.since >= Some(started));
        assert!(scoped.iter().all(|ev| !tia.wants(ev)));
        let conn = state.hub.next_conn();
        assert_eq!(on_event(&state, conn, &mut tia, &dm).await, Some(false));
        assert!(tia.refresh(&state, conn).await && tia.retry.pending());
        assert!(tia.retry.at.unwrap() <= started + REAUTH_GIVE_UP);
        tia.retry.since = Instant::now().checked_sub(REAUTH_GIVE_UP);
        assert!(!tia.refresh(&state, conn).await);
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn an_overflowed_inbox_drops_stale_events_and_resyncs() {
        let (state, path) = crate::api::test_util::temp_state("ws_overflow").await;
        add_user(&state.db, "alice").await;
        exec(
            &state.db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('club', 'club', 1)",
        )
        .await;
        exec(
            &state.db,
            "INSERT INTO members(server, username, joined_at) VALUES('club', 'alice', 2)",
        )
        .await;
        let router = crate::fanout::Router::default();
        let conn = 1;
        let topics = HashSet::from([Topic::User(s("alice")), Topic::Server(s("club"))]);
        let mut inbox = router.open(conn, &topics);
        router.deliver(WsEvent::MemberLeft {
            server: s("club"),
            username: s("alice"),
        });
        let filler = |id| WsEvent::MessageDeleted {
            server: Some(s("club")),
            channel_id: Some(1),
            dm_id: None,
            dm_users: None,
            id,
            thread_root_id: None,
        };
        for id in 0..600 {
            router.deliver(filler(id));
        }
        router.deliver(WsEvent::MemberJoined {
            server: s("club"),
            member: Member {
                user: message().author,
                is_admin: false,
                is_creator: false,
                online: false,
                perms: 0,
                role_ids: Vec::new(),
                joined_via: None,
                timeout: None,
            },
        });
        let first = inbox.rx.recv().await.unwrap();
        assert!(matches!(first.ev, WsEvent::MemberLeft { .. }));
        assert!(inbox.lagged());
        let mut alice = Access::new(Some(s("alice")), false, HashSet::new());
        let mut lag = Pace::new(LAG_REAUTH_EVERY);
        let (through, open) =
            catch_up(&state, conn, &mut alice, &mut inbox, &mut lag, first.seq).await;
        assert!(open && alice.missed);
        assert!(through > first.seq);
        assert!(inbox.rx.try_recv().is_err());
        assert_eq!(alice.member_servers, set(&["club"]));
        router.deliver(filler(9000));
        let fresh = inbox.rx.recv().await.unwrap();
        assert!(fresh.seq > through && alice.wants(&fresh.ev));
        alice.missed = false;
        let (_, open) = catch_up(&state, conn, &mut alice, &mut inbox, &mut lag, fresh.seq).await;
        assert!(open && !alice.missed && lag.due.is_some());
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn hosting_announces_are_deduped_paced_cached_and_bounded() {
        let (state, path) = lagged_presence_state("ws_hosting_pace").await;
        let hub = state.hub.clone();
        let mut rx = hub.subscribe();
        let scopes = |rx: &mut tokio::sync::broadcast::Receiver<WsEvent>| {
            let mut out = Vec::new();
            while let Ok(ev) = rx.try_recv() {
                if let WsEvent::P2pAvailability {
                    ids, scope_servers, ..
                } = ev
                {
                    out.push((ids, scope_servers));
                }
            }
            out
        };
        let mut a = Access::new(Some(s("alice")), false, set(&["chat"]));
        a.host(&state, 1, (s("peer"), vec![s("f1")])).await;
        assert_eq!(scopes(&mut rx), vec![(vec![s("f1")], vec![s("chat")])]);
        a.host(&state, 1, (s("peer"), vec![s("f1")])).await;
        assert!(scopes(&mut rx).is_empty());
        a.host(&state, 1, (s("peer"), vec![s("f1"), s("f2")])).await;
        a.host(&state, 1, (s("peer"), vec![s("f2")])).await;
        assert!(scopes(&mut rx).is_empty());
        assert!(a.hosting_pace.due.is_some());
        exec(&state.db, "DELETE FROM members WHERE username = 'alice'").await;
        a.hosting_pace.fire(Instant::now());
        a.announce_hosting(&state, 1).await;
        assert_eq!(scopes(&mut rx), vec![(vec![s("f2")], vec![s("chat")])]);
        track(
            &WsEvent::MemberLeft {
                server: s("chat"),
                username: s("alice"),
            },
            &mut a,
        );
        a.announce_hosting(&state, 1).await;
        assert_eq!(scopes(&mut rx), vec![(vec![s("f2")], Vec::<String>::new())]);
        for i in 0..(USER_SCOPE_SERVERS + 20) {
            sqlx::query("INSERT INTO servers(name, display_name, created_at) VALUES($1, $1, 1)")
                .bind(format!("s{i}"))
                .execute(&state.db)
                .await
                .unwrap();
            sqlx::query("INSERT INTO members(server, username, joined_at) VALUES($1, 'alice', $2)")
                .bind(format!("s{i}"))
                .bind(i)
                .execute(&state.db)
                .await
                .unwrap();
        }
        let (servers, users) = p2p_scope(&state.read(), "alice").await;
        assert_eq!(servers.len() as i64, USER_SCOPE_SERVERS);
        assert_eq!(users, vec![s("alice")]);
        crate::api::test_util::done(state, path).await;
    }

    #[test]
    fn lag_reauthorizes_at_most_every_interval() {
        let mut lag = Pace::new(LAG_REAUTH_EVERY);
        let start = Instant::now();
        assert!(lag.hit(start));
        assert!(!lag.hit(start + Duration::from_millis(100)));
        assert_eq!(lag.due, Some(start + LAG_REAUTH_EVERY));
        assert!(!lag.hit(start + Duration::from_millis(500)));
        lag.fire(start + LAG_REAUTH_EVERY);
        assert!(lag.due.is_none());
        assert!(lag.hit(start + LAG_REAUTH_EVERY * 2));
    }

    #[test]
    fn only_lossy_epochs_owe_a_resync() {
        let mut access = Access::new(Some(s("tia")), false, HashSet::new());
        let mut seen = 0;
        access.note_epoch(&mut seen, Epoch { count: 1, lossy: 0 });
        access.note_epoch(&mut seen, Epoch { count: 2, lossy: 0 });
        assert!(!access.missed);
        access.note_epoch(&mut seen, Epoch { count: 3, lossy: 1 });
        assert!(std::mem::take(&mut access.missed) && seen == 1);
        access.note_epoch(&mut seen, Epoch { count: 4, lossy: 1 });
        assert!(!access.missed);
    }

    #[tokio::test]
    async fn reauthorization_ends_revoked_sessions() {
        let (state, path) = crate::api::test_util::temp_state("ws_revoked").await;
        let db = &state.db;
        add_user(db, "tia").await;
        exec(
            db,
            "INSERT INTO tokens(token, username, created_at) VALUES('h:628b49d96dcde97a430dd4f597705899e09a968f793491e4b704cae33a40dc02', 'tia', 0), ('h:c44474038d459e40e4714afefa7bf8dae9f9834b22f5e8ec1dd434ecb62b512e', 'tia', 0)",
        )
        .await;
        let session = |token: &str| {
            let mut access = Access::new(Some(s("tia")), false, HashSet::new());
            access.token = Some(s(token));
            access
        };
        let (mut kept, mut gone) = (session("t1"), session("t2"));
        exec(db, "DELETE FROM tokens WHERE token = 'h:c44474038d459e40e4714afefa7bf8dae9f9834b22f5e8ec1dd434ecb62b512e'").await;
        assert!(kept.refresh(&state, 1).await);
        assert!(!gone.refresh(&state, 2).await);
        assert!(!wants(
            &WsEvent::TokensRevoked { username: s("tia") },
            Some("tia"),
            true,
            &HashSet::new(),
            &HashSet::new()
        ));
        crate::api::test_util::done(state, path).await;
    }

    fn every_event() -> Vec<WsEvent> {
        let dm = || Some(vec![s("alice"), s("bob")]);
        let chan = Channel {
            id: 1,
            name: s("c"),
            kind: ChannelKind::Text,
            slowmode_seconds: 0,
            restrict_view: false,
            restrict_send: false,
            topic: None,
            category_id: None,
            position: 0,
        };
        let mut evs = Vec::new();
        for server in [Some(s("a")), Some(s("b")), None] {
            let dm_users = match server {
                Some(_) => None,
                None => dm(),
            };
            evs.push(WsEvent::Message {
                server: server.clone(),
                channel_id: Some(1),
                dm_id: None,
                dm_users: dm_users.clone(),
                message: Box::new(message()),
            });
            evs.push(WsEvent::MessageUpdated {
                server: server.clone(),
                channel_id: server.as_ref().map(|_| 1),
                update: Updated::full(message()),
                dm_users: dm_users.clone().unwrap_or_default(),
            });
            evs.push(WsEvent::PollUpdated {
                server: server.clone(),
                channel_id: server.as_ref().map(|_| 1),
                dm_id: None,
                dm_users: dm_users.clone(),
                message_id: 1,
                thread_root_id: None,
                created_at: 1,
                poll: Box::new(crate::api::polls::sample_poll()),
            });
            evs.push(WsEvent::MessageDeleted {
                server: server.clone(),
                channel_id: Some(1),
                dm_id: None,
                dm_users: dm_users.clone(),
                id: 1,
                thread_root_id: None,
            });
            evs.push(WsEvent::MediaRemoved {
                server: server.clone(),
                channel_id: Some(1),
                dm_id: None,
                dm_users: dm_users.clone(),
                message_id: 1,
                removed_by_author: false,
            });
            evs.push(WsEvent::EmbedsResolved {
                server: server.clone(),
                channel_id: Some(1),
                dm_id: None,
                dm_users: dm_users.clone(),
                message_id: 1,
                embeds: Vec::new(),
            });
            evs.push(WsEvent::EmbedsRemoved {
                server: server.clone(),
                channel_id: Some(1),
                dm_id: None,
                dm_users: dm_users.clone(),
                message_id: 1,
                ord: 0,
                banner: false,
            });
            evs.push(WsEvent::VoiceEnded {
                server,
                channel_id: Some(1),
                dm_id: None,
                dm_users,
                reason: s("r"),
            });
        }
        for server in ["a", "b", "z"] {
            for user in ["alice", "bob"] {
                evs.extend([
                    joined(server, user),
                    WsEvent::MemberLeft {
                        server: s(server),
                        username: s(user),
                    },
                    WsEvent::MemberKicked {
                        server: s(server),
                        username: s(user),
                        banned: true,
                    },
                    WsEvent::MembersPurged {
                        server: s(server),
                        usernames: vec![s(user)],
                    },
                    WsEvent::AdminChanged {
                        server: s(server),
                        username: s(user),
                        is_admin: true,
                        perms: 1,
                    },
                    WsEvent::ServerCreated {
                        server: ServerSummaryLite {
                            creator: Some(s(user)),
                            ..lite(server)
                        },
                    },
                    WsEvent::PresenceMode {
                        username: s(user),
                        appear_offline: true,
                        seq: 0,
                    },
                    WsEvent::ReadUpdated {
                        username: s(user),
                        scope: s("c1"),
                        last_read: 1,
                        pings_until: 0,
                    },
                    WsEvent::TokensRevoked { username: s(user) },
                    WsEvent::DmClosed {
                        username: s(user),
                        dm_id: 1,
                    },
                    WsEvent::DmReopened {
                        username: s(user),
                        dm_id: 1,
                    },
                    WsEvent::UserBlocked {
                        username: s(user),
                        blocked: crate::api::blocks::BlockedUser {
                            user: crate::api::missing_user("x"),
                            blocked_at: 1,
                        },
                    },
                    WsEvent::UserUnblocked {
                        username: s(user),
                        blocked: s("x"),
                    },
                    WsEvent::PollVoted {
                        username: s(user),
                        message_id: 1,
                    },
                    WsEvent::FriendRequestAdded {
                        username: s(user),
                        request: crate::api::friends::FriendRequest {
                            user: crate::api::missing_user("x"),
                            created_at: 1,
                            incoming: true,
                        },
                    },
                    WsEvent::FriendRequestRemoved {
                        username: s(user),
                        other: s("x"),
                    },
                    WsEvent::FriendAdded {
                        username: s(user),
                        friend: crate::api::friends::Friend {
                            user: crate::api::missing_user("x"),
                            since: 1,
                            online: false,
                        },
                    },
                    WsEvent::FriendRemoved {
                        username: s(user),
                        friend: s("x"),
                    },
                    WsEvent::FriendPresence {
                        username: s(user),
                        friend: s("x"),
                        online: true,
                    },
                    WsEvent::PrivacyChanged {
                        username: s(user),
                        privacy: crate::api::friends::Privacy::default(),
                    },
                    WsEvent::RtcSignal {
                        to: s(user),
                        from: s("x"),
                        channel_id: None,
                        dm_id: Some(1),
                        payload: serde_json::Value::Null,
                    },
                    WsEvent::P2pAvailability {
                        hoster: s(user),
                        peer_id: None,
                        ids: Vec::new(),
                        online: false,
                        scope_servers: vec![s(server)],
                        scope_users: vec![s("carol")],
                    },
                    WsEvent::Banned { username: s(user) },
                    WsEvent::UserUpdated {
                        user: UserRef {
                            username: s(user),
                            ..message().author
                        },
                        scope: UserScope {
                            servers: vec![s(server)],
                            views: Vec::new(),
                            users: vec![s("carol")],
                        },
                    },
                    WsEvent::UserUpdated {
                        user: UserRef {
                            username: s(user),
                            ..message().author
                        },
                        scope: UserScope {
                            servers: Vec::new(),
                            views: vec![s(server)],
                            users: Vec::new(),
                        },
                    },
                ]);
            }
            evs.extend([
                WsEvent::ChannelCreated {
                    server: s(server),
                    channel: chan.clone(),
                },
                WsEvent::ChannelRenamed {
                    server: s(server),
                    channel: chan.clone(),
                },
                WsEvent::ChannelDeleted {
                    server: s(server),
                    channel_id: 1,
                    rules: None,
                },
                WsEvent::RolesChanged { server: s(server) },
                WsEvent::ChannelPermsChanged {
                    server: s(server),
                    channel_id: 1,
                },
                WsEvent::VoiceState {
                    server: s(server),
                    channel_id: 1,
                    users: Vec::new(),
                },
                WsEvent::ServerCreated {
                    server: lite(server),
                },
                renamed(server, "q"),
                renamed("q", server),
                WsEvent::ServerDeleted { name: s(server) },
            ]);
        }
        evs.extend([
            WsEvent::CallState {
                dm_id: 1,
                dm_users: vec![s("alice"), s("bob")],
                state: CallPhase::Ringing,
                from: s("alice"),
                kind: CallKind::Rtc,
                video: false,
                call_id: None,
                answered_at: None,
                peers: Vec::new(),
            },
            WsEvent::CallState {
                dm_id: 1,
                dm_users: vec![s("alice"), s("bob")],
                state: CallPhase::Active,
                from: s("alice"),
                kind: CallKind::P2p,
                video: false,
                call_id: Some(s("c")),
                answered_at: Some(5),
                peers: vec![CallPeer {
                    user: s("alice"),
                    peer_id: s("pa"),
                }],
            },
            WsEvent::DmCreated {
                dm_id: 1,
                dm_users: vec![s("bob"), s("carol")],
            },
            WsEvent::UserUpdated {
                user: message().author,
                scope: UserScope::default(),
            },
            WsEvent::UserRegistered {
                user: message().author,
            },
            WsEvent::SettingsChanged {
                settings: Settings {
                    profanity_filter: false,
                    profanity_targets: crate::api::ProfanityTargets::ALL,
                    asset_previews: false,
                    asset_uploads: false,
                    p2p_attachments: false,
                    guests_enabled: false,
                },
            },
            WsEvent::Error { message: s("e") },
            WsEvent::P2pHosted {
                live: Vec::new(),
                checked: Vec::new(),
                key: s("k"),
                peer_id: s("p"),
                now: 1,
            },
            WsEvent::P2pPeer {
                message_id: 1,
                peer_id: Some(s("p")),
                token: Some(s("t")),
                expires_at: Some(2),
                error: None,
            },
            WsEvent::UserShown {
                username: s("alice"),
                online: true,
            },
            WsEvent::Resync,
        ]);
        evs
    }

    fn reaches(target: &crate::fanout::Target, topics: &HashSet<Topic>) -> bool {
        use crate::fanout::Target;
        match *target {
            Target::Admins => topics.contains(&Topic::Admin),
            Target::User(u) => topics.contains(&Topic::User(s(u))),
            Target::Server(v) => topics.contains(&Topic::Server(s(v))),
            Target::View(v) => topics.contains(&Topic::View(v.to_string())),
        }
    }

    #[test]
    fn routing_reaches_everyone_who_wants_an_event() {
        let mut alice = Access::new(Some(s("alice")), false, set(&["a"]));
        alice.subs = set(&["b"]);
        alice.viewing = Some(s("a"));
        let mut admin = Access::new(Some(s("bob")), true, set(&["b"]));
        admin.viewing = Some(s("b"));
        let mut guest = Access::new(None, false, HashSet::new());
        guest.subs = set(&["a"]);
        let mut held = Access::new(Some(s("carol")), false, set(&["a"]));
        held.retry.at = Some(Instant::now());
        let lurker = Access::new(Some(s("dave")), false, set(&["a", "b"]));
        let mut checked = 0;
        for access in [&alice, &admin, &guest, &held, &lurker] {
            let topics = access.topics();
            for ev in every_event() {
                if !access.wants(&ev) {
                    continue;
                }
                checked += 1;
                let routed = match crate::fanout::route(&ev) {
                    crate::fanout::Route::Everyone => true,
                    crate::fanout::Route::To(targets) => {
                        targets.iter().any(|t| reaches(t, &topics))
                    }
                };
                let viewer_only = match &ev {
                    WsEvent::PresenceChanged { .. } => true,
                    WsEvent::UserUpdated { user, scope } => {
                        !scope.views.is_empty() && access.user.as_ref() != Some(&user.username)
                    }
                    _ => false,
                };
                assert!(
                    routed || viewer_only,
                    "{:?} misses {}",
                    access.user,
                    to_bus_json(&ev).unwrap()
                );
            }
        }
        assert!(checked > 100);
        let presence = |server: &str| WsEvent::PresenceChanged {
            server: s(server),
            username: s("x"),
            online: true,
            online_count: 1,
        };
        fn viewers(ev: &WsEvent) -> Vec<crate::fanout::Target<'_>> {
            match crate::fanout::route(ev) {
                crate::fanout::Route::To(targets) => targets,
                crate::fanout::Route::Everyone => panic!("presence is never global"),
            }
        }
        assert!(
            viewers(&presence("a"))
                .iter()
                .any(|t| reaches(t, &alice.topics()))
        );
        assert!(
            viewers(&presence("b"))
                .iter()
                .any(|t| reaches(t, &alice.topics()))
        );
        assert!(
            viewers(&presence("a"))
                .iter()
                .any(|t| reaches(t, &guest.topics()))
        );
        assert!(
            !viewers(&presence("a"))
                .iter()
                .any(|t| reaches(t, &lurker.topics()))
        );
        assert!(!lurker.wants(&WsEvent::UserRegistered {
            user: message().author
        }));
    }

    #[tokio::test]
    async fn user_updates_reach_only_people_who_share_something() {
        let (state, path) = crate::api::test_util::temp_state("ws_user_scope").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dave"] {
            add_user(db, name).await;
        }
        exec(
            db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('club', 'club', 1)",
        )
        .await;
        exec(db, "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'alice', 1), ('rchat', 'bob', 1), ('rchat', 'carol', 1), ('rchat', 'dave', 1), ('club', 'alice', 2), ('club', 'bob', 2)").await;
        exec(
            db,
            "UPDATE servers SET member_count = 5000 WHERE name = 'rchat'",
        )
        .await;
        exec(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'alice'), ('carol', 'alice')",
        )
        .await;
        let scope = user_scope(db, "alice").await;
        assert_eq!(
            scope,
            UserScope {
                servers: vec![s("club")],
                views: vec![s("rchat")],
                users: vec![s("alice"), s("carol")],
            }
        );
        let loner = user_scope(db, "dave").await;
        exec(db, "DELETE FROM members WHERE username = 'dave'").await;
        let alone = user_scope(db, "dave").await;
        assert!(!loner.is_empty() && !alone.is_empty());
        assert_eq!(alone.users, vec![s("dave")]);
        assert!(matches!(
            crate::fanout::route(&WsEvent::UserUpdated {
                user: UserRef {
                    username: s("dave"),
                    ..message().author
                },
                scope: alone,
            }),
            crate::fanout::Route::To(_)
        ));
        let ev = WsEvent::UserUpdated {
            user: UserRef {
                username: s("alice"),
                ..message().author
            },
            scope,
        };
        let frame = crate::fanout::Fanned::new(ev.clone(), 1).frame().unwrap();
        assert!(!frame.as_str().contains("scope"), "{}", frame.as_str());
        assert!(to_bus_json(&ev).unwrap().contains(r#""views":["rchat"]"#));
        let reached = |access: &Access| match crate::fanout::route(&ev) {
            crate::fanout::Route::To(targets) => {
                let topics = access.topics();
                targets.iter().any(|t| reaches(t, &topics))
            }
            crate::fanout::Route::Everyone => panic!("user updates are scoped"),
        };
        let me = Access::new(Some(s("alice")), false, set(&["rchat", "club"]));
        let bob = Access::new(Some(s("bob")), false, set(&["rchat", "club"]));
        let carol = Access::new(Some(s("carol")), false, set(&["rchat"]));
        let dave = Access::new(Some(s("dave")), false, set(&["rchat"]));
        let mut viewer = Access::new(Some(s("dave")), false, set(&["rchat"]));
        viewer.viewing = Some(s("rchat"));
        assert!(reached(&me) && reached(&bob) && reached(&carol) && reached(&viewer));
        assert!(!reached(&dave));
        crate::api::test_util::done(state, path).await;
    }

    #[test]
    fn purged_members_get_their_own_kick() {
        let fanned = crate::fanout::Fanned::new(
            WsEvent::MembersPurged {
                server: s("club"),
                usernames: vec![s("bob"), s("carol")],
            },
            1,
        );
        assert_eq!(
            client_frame(&fanned, Some("carol")).unwrap().as_str(),
            r#"{"type":"member_kicked","server":"club","username":"carol","banned":false}"#
        );
        assert_eq!(
            client_frame(&fanned, Some("alice")).unwrap().as_str(),
            r#"{"type":"roles_changed","server":"club"}"#
        );
        let mut carol = Access::new(Some(s("carol")), false, set(&["club", "rchat"]));
        carol.viewing = Some(s("club"));
        track(&fanned.ev, &mut carol);
        assert_eq!(carol.member_servers, set(&["rchat"]));
        assert!(carol.viewing.is_none() && carol.topics_dirty);
        let mut alice = Access::new(Some(s("alice")), false, set(&["club"]));
        track(&fanned.ev, &mut alice);
        assert_eq!(alice.member_servers, set(&["club"]));
    }

    #[test]
    fn flooding_clients_are_throttled_then_closed() {
        let mut bucket = Bucket::new();
        let now = bucket.at;
        let mut allowed = 0;
        let mut dropped = 0;
        loop {
            match bucket.take(now) {
                Some(true) => allowed += 1,
                Some(false) => dropped += 1,
                None => break,
            }
        }
        assert_eq!((allowed, dropped), (MSG_BURST as usize, MSG_BURST as usize));
        let mut bucket = Bucket::new();
        for i in 0..1_000 {
            let at = bucket.at + Duration::from_millis(25);
            assert_eq!(bucket.take(at), Some(true), "message {i}");
        }
    }

    #[tokio::test]
    async fn shared_channel_cache_follows_permission_events() {
        let (state, path) = crate::api::test_util::temp_state("ws_channel_cache").await;
        let db = &state.db;
        add_user(db, "bob").await;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1)",
        )
        .await;
        let text = general(db).await;
        let mut bob = Access::new(Some(s("bob")), false, set(&["rchat"]));
        let mut guest = Access::new(None, false, set(&[]));
        assert_eq!(
            channel_gate(&state, &mut bob, "rchat", text).await,
            Some(true)
        );
        assert_eq!(
            channel_gate(&state, &mut guest, "rchat", text).await,
            Some(true)
        );
        assert_eq!(state.hub.channels().len(), 1);
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'r:999', 1, 1, 1)")
            .bind(text)
            .execute(db)
            .await
            .unwrap();
        crate::api::test_util::restrict_ruled(db).await;
        let mut late = Access::new(Some(s("bob")), false, set(&["rchat"]));
        assert_eq!(
            channel_gate(&state, &mut late, "rchat", text).await,
            Some(true)
        );
        state.hub.broadcast(WsEvent::ChannelPermsChanged {
            server: s("rchat"),
            channel_id: text,
        });
        let changed = WsEvent::ChannelPermsChanged {
            server: s("rchat"),
            channel_id: text,
        };
        track(&changed, &mut bob);
        track(&changed, &mut guest);
        assert_eq!(
            channel_gate(&state, &mut bob, "rchat", text).await,
            Some(false)
        );
        assert_eq!(
            channel_gate(&state, &mut guest, "rchat", text).await,
            Some(false)
        );
        let roles = WsEvent::RolesChanged { server: s("other") };
        track(&roles, &mut bob);
        assert_eq!(bob.viewable.len(), 1);
        track(&WsEvent::RolesChanged { server: s("rchat") }, &mut bob);
        assert!(bob.viewable.is_empty());
        exec(db, "DELETE FROM channel_perms").await;
        for (sql, open) in [
            (
                "UPDATE channels SET restrict_view = 0, restrict_send = 1",
                true,
            ),
            (
                "UPDATE channels SET restrict_view = 1, restrict_send = 0",
                false,
            ),
            (
                "UPDATE channels SET restrict_view = 0, restrict_send = 0",
                true,
            ),
        ] {
            exec(db, sql).await;
            state.hub.broadcast(changed.clone());
            track(&changed, &mut bob);
            track(&changed, &mut guest);
            assert_eq!(
                channel_gate(&state, &mut bob, "rchat", text).await,
                Some(open),
                "{sql}"
            );
            assert_eq!(
                channel_gate(&state, &mut guest, "rchat", text).await,
                Some(open),
                "{sql}"
            );
        }
        crate::api::test_util::done(state, path).await;
    }

    async fn routed(inbox: &mut crate::fanout::Inbox, hub: &Hub, ev: WsEvent) -> Option<WsEvent> {
        hub.broadcast(ev);
        let wait = tokio::time::sleep(Duration::from_millis(300));
        tokio::pin!(wait);
        loop {
            tokio::select! {
                got = inbox.rx.recv() => match got.map(|f| f.ev.clone()) {
                    Some(ev @ WsEvent::Message { .. }) => return Some(ev),
                    Some(_) => {}
                    None => return None,
                },
                _ = &mut wait => return None,
            }
        }
    }

    async fn peek_world(name: &str) -> (AppState, std::path::PathBuf, i64, i64) {
        let (state, path) = crate::api::test_util::temp_state(name).await;
        let db = &state.db;
        add_user(db, "alice").await;
        add_user(db, "nora").await;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('open', 'Open', 'alice', 1)").await;
        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 1)").await;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('home', 'Home', 'nora', 1)").await;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('open', 'alice', 1)",
        )
        .await;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('home', 'nora', 1)",
        )
        .await;
        let general = insert_id(db, "INSERT INTO channels(server, name, created_at) VALUES('open', 'general', 1) RETURNING id").await;
        let secret = insert_id(db, "INSERT INTO channels(server, name, created_at) VALUES('open', 'secret', 1) RETURNING id").await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'r:999', 1, 1, 1)")
            .bind(secret)
            .execute(db)
            .await
            .unwrap();
        crate::api::test_util::restrict_ruled(db).await;
        (state, path, general, secret)
    }

    fn post_in(server: &str, cid: i64) -> WsEvent {
        WsEvent::Message {
            server: Some(s(server)),
            channel_id: Some(cid),
            dm_id: None,
            dm_users: None,
            message: Box::new(message()),
        }
    }

    #[tokio::test]
    async fn a_non_member_viewer_of_an_open_server_gets_its_live_events() {
        let (state, path, general, secret) = peek_world("ws_peek_live").await;
        let conn = state.hub.next_conn();
        let mut inbox = state
            .hub
            .open(conn, &HashSet::from([Topic::User(s("nora"))]));
        let mut nora = Access::new(Some(s("nora")), false, set(&["home"]));
        assert_eq!(
            look(&state, conn, &mut nora, Some(s("Open"))).await,
            Some(s("open"))
        );
        state.hub.reconcile(conn, &nora.topics(), 0);
        assert_eq!(nora.peek.as_deref(), Some("open"));
        assert_eq!(nora.viewing, None);
        let topics = state.hub.topics(conn);
        assert!(
            topics.contains(&Topic::Server(s("open"))) && topics.contains(&Topic::View(s("open")))
        );
        let got = routed(&mut inbox, &state.hub, post_in("open", general))
            .await
            .expect("routed");
        assert_eq!(on_event(&state, conn, &mut nora, &got).await, Some(true));
        let hidden = routed(&mut inbox, &state.hub, post_in("open", secret))
            .await
            .expect("routed");
        assert_eq!(
            on_event(&state, conn, &mut nora, &hidden).await,
            Some(false)
        );
        assert!(presence_snapshot(&state.hub, &nora, "open").is_some());

        let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
        look(&state, state.hub.next_conn(), &mut alice, Some(s("open"))).await;
        assert_eq!(alice.peek, None);
        assert!(alice.subs.is_empty());
        assert_eq!(alice.viewing.as_deref(), Some("open"));

        look(&state, conn, &mut nora, Some(s("vault"))).await;
        state.hub.reconcile(conn, &nora.topics(), u64::MAX);
        assert_eq!(nora.peek, None);
        assert!(nora.subs.is_empty());
        let topics = state.hub.topics(conn);
        assert!(!topics.iter().any(
            |t| matches!(t, Topic::Server(v) | Topic::View(v) if v == "open" || v == "vault")
        ));
        assert!(
            routed(&mut inbox, &state.hub, post_in("open", general))
                .await
                .is_none()
        );
        assert_eq!(
            on_event(&state, conn, &mut nora, &post_in("open", general)).await,
            Some(false)
        );

        look(&state, conn, &mut nora, Some(s("open"))).await;
        assert_eq!(nora.peek.as_deref(), Some("open"));
        look(&state, conn, &mut nora, Some(s("home"))).await;
        assert_eq!(nora.peek, None);
        assert_eq!(nora.viewing.as_deref(), Some("home"));
        assert!(!nora.topics().contains(&Topic::Server(s("open"))));
        look(&state, conn, &mut nora, Some(s("open"))).await;
        look(&state, conn, &mut nora, None).await;
        assert_eq!(nora.peek, None);
        assert!(!nora.topics().contains(&Topic::Server(s("open"))));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn a_non_member_viewer_loses_live_events_with_access() {
        let (state, path, general, _) = peek_world("ws_peek_lost").await;
        let db = &state.db;
        let conn = state.hub.next_conn();
        let mut nora = Access::new(Some(s("nora")), false, set(&["home"]));
        nora.viewable = HashMap::from([(general, (s("open"), true))]);

        look(&state, conn, &mut nora, Some(s("open"))).await;
        exec(
            db,
            "UPDATE servers SET password_hash = 'hash' WHERE name = 'open'",
        )
        .await;
        let locked = WsEvent::ServerUpdated {
            server: ServerSummaryLite {
                has_password: true,
                banner_color: None,
                name_color: None,
                ..lite("open")
            },
        };
        assert_eq!(
            on_event(&state, conn, &mut nora, &locked).await,
            Some(false)
        );
        assert_eq!(nora.peek, None);
        assert!(!nora.topics().contains(&Topic::Server(s("open"))));
        assert_eq!(
            on_event(&state, conn, &mut nora, &post_in("open", general)).await,
            Some(false)
        );
        assert!(reauthorize(&state, &mut nora).await.unwrap());
        assert_eq!(nora.peek, None);
        exec(
            db,
            "UPDATE servers SET password_hash = NULL WHERE name = 'open'",
        )
        .await;

        look(&state, conn, &mut nora, Some(s("open"))).await;
        nora.viewable = HashMap::from([(general, (s("open"), true))]);
        assert_eq!(
            on_event(&state, conn, &mut nora, &post_in("open", general)).await,
            Some(true)
        );
        exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('open', 'nora', 'alice', 2)").await;
        let banned = WsEvent::ServerBanned {
            server: s("open"),
            username: s("nora"),
        };
        assert_eq!(on_event(&state, conn, &mut nora, &banned).await, Some(true));
        assert_eq!((nora.peek.as_ref(), nora.looking.as_ref()), (None, None));
        assert!(!nora.topics().contains(&Topic::Server(s("open"))));
        assert_eq!(
            on_event(&state, conn, &mut nora, &post_in("open", general)).await,
            Some(false)
        );
        look(&state, conn, &mut nora, Some(s("open"))).await;
        assert_eq!(nora.peek, None);
        assert!(nora.subs.is_empty());
        assert!(reauthorize(&state, &mut nora).await.unwrap());
        assert_eq!(nora.peek, None);
        exec(db, "DELETE FROM server_bans").await;

        look(&state, conn, &mut nora, Some(s("open"))).await;
        let gone = WsEvent::ServerDeleted { name: s("open") };
        on_event(&state, conn, &mut nora, &gone).await;
        assert_eq!((nora.peek.as_ref(), nora.looking.as_ref()), (None, None));
        assert!(nora.subs.is_empty() && !nora.topics().contains(&Topic::Server(s("open"))));

        look(&state, conn, &mut nora, Some(s("open"))).await;
        assert!(nora.hold(sqlx::Error::PoolClosed, Instant::now()));
        assert!(!nora.wants(&post_in("open", general)));
        look(&state, conn, &mut nora, Some(s("open"))).await;
        assert_eq!(nora.peek, None);
        assert!(!nora.topics().contains(&Topic::Server(s("open"))));
        assert!(nora.refresh(&state, conn).await && !nora.retry.pending());
        assert_eq!(nora.peek.as_deref(), Some("open"));
        assert!(nora.wants(&post_in("open", general)));
        crate::api::test_util::done(state, path).await;
    }

    fn reaction_in(
        server: Option<&str>,
        cid: Option<i64>,
        dm: Option<i64>,
        added: bool,
    ) -> WsEvent {
        let (server, dm_users) = (server.map(s), dm.map(|_| vec![s("alice"), s("bob")]));
        let (message_id, thread_root_id, emoji, username) = (4, None, s("👍"), s("bob"));
        match added {
            true => WsEvent::ReactionAdded {
                server,
                channel_id: cid,
                dm_id: dm,
                dm_users,
                message_id,
                thread_root_id,
                emoji,
                username,
                count: 1,
            },
            false => WsEvent::ReactionRemoved {
                server,
                channel_id: cid,
                dm_id: dm,
                dm_users,
                message_id,
                thread_root_id,
                emoji,
                username,
                count: 0,
            },
        }
    }

    #[tokio::test]
    async fn reactions_reach_only_those_who_can_see_the_channel() {
        let (state, path, general, secret) = peek_world("ws_reaction_routes").await;
        let conn = state.hub.next_conn();
        let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
        let mut nora = Access::new(Some(s("nora")), false, set(&["home"]));
        for added in [true, false] {
            let seen = reaction_in(Some("open"), Some(general), None, added);
            let hidden = reaction_in(Some("open"), Some(secret), None, added);
            assert_eq!(
                crate::fanout::route(&seen),
                crate::fanout::Route::To(vec![crate::fanout::Target::Server("open")])
            );
            assert_eq!(event_channel(&hidden), Some(("open", secret)));
            assert_eq!(on_event(&state, conn, &mut alice, &seen).await, Some(true));
            assert_eq!(
                on_event(&state, conn, &mut alice, &hidden).await,
                Some(false)
            );
            assert_eq!(on_event(&state, conn, &mut nora, &seen).await, Some(false));
            let dm = reaction_in(None, None, Some(7), added);
            assert_eq!(
                crate::fanout::route(&dm),
                crate::fanout::Route::To(vec![
                    crate::fanout::Target::User("alice"),
                    crate::fanout::Target::User("bob")
                ])
            );
            assert!(wants(
                &dm,
                Some("alice"),
                false,
                &HashSet::new(),
                &HashSet::new()
            ));
            assert!(!wants(
                &dm,
                Some("nora"),
                true,
                &set(&["open"]),
                &HashSet::new()
            ));
            let wire = serde_json::to_value(&seen).expect("json");
            assert_eq!(
                wire["type"],
                if added {
                    "reaction_added"
                } else {
                    "reaction_removed"
                }
            );
            assert_eq!(wire["emoji"], "👍");
            assert_eq!(wire["username"], "bob");
        }
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn edits_reach_only_those_who_can_see_the_channel() {
        let (state, path, general, secret) = peek_world("ws_edit_routes").await;
        let conn = state.hub.next_conn();
        let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
        let mut nora = Access::new(Some(s("nora")), false, set(&["home"]));
        let edit = |server: Option<&str>, channel_id: Option<i64>, dm_users: &[&str]| {
            WsEvent::MessageUpdated {
                server: server.map(s),
                channel_id,
                update: Updated::full(message()),
                dm_users: dm_users.iter().map(|u| s(u)).collect(),
            }
        };
        let seen = edit(Some("open"), Some(general), &[]);
        let hidden = edit(Some("open"), Some(secret), &[]);
        assert_eq!(
            crate::fanout::route(&seen),
            crate::fanout::Route::To(vec![crate::fanout::Target::Server("open")])
        );
        assert_eq!(event_channel(&seen), Some(("open", general)));
        assert_eq!(event_channel(&hidden), Some(("open", secret)));
        assert_eq!(on_event(&state, conn, &mut alice, &seen).await, Some(true));
        assert_eq!(
            on_event(&state, conn, &mut alice, &hidden).await,
            Some(false)
        );
        assert_eq!(on_event(&state, conn, &mut nora, &seen).await, Some(false));
        let dm = edit(None, None, &["alice", "bob"]);
        assert_eq!(event_channel(&dm), None);
        assert_eq!(
            crate::fanout::route(&dm),
            crate::fanout::Route::To(vec![
                crate::fanout::Target::User("alice"),
                crate::fanout::Target::User("bob")
            ])
        );
        assert!(wants(
            &dm,
            Some("alice"),
            false,
            &HashSet::new(),
            &HashSet::new()
        ));
        assert!(!wants(
            &dm,
            Some("nora"),
            true,
            &set(&["open"]),
            &HashSet::new()
        ));
        let wire = serde_json::to_value(&seen).expect("json");
        assert_eq!(wire["type"], "message_updated");
        assert_eq!(wire["server"], "open");
        assert_eq!(wire["channel_id"], general);
        assert!(wire.get("dm_users").is_none());
        let bus = to_bus_json(&WsEvent::MessageUpdated {
            server: None,
            channel_id: None,
            update: Updated::full(message()),
            dm_users: vec![s("alice"), s("bob")],
        })
        .expect("bus");
        let stub = WsEvent::MessageUpdated {
            server: Some(s("open")),
            channel_id: Some(secret),
            update: Updated::stub(7, Some(3), Some(99)),
            dm_users: Vec::new(),
        };
        assert_eq!(event_channel(&stub), Some(("open", secret)));
        assert_eq!(on_event(&state, conn, &mut alice, &stub).await, Some(false));
        let wire = serde_json::to_value(&stub).expect("json");
        assert_eq!(
            wire,
            serde_json::json!({"type": "message_updated", "server": "open", "channel_id": secret, "id": 7, "thread_root_id": 3, "edited_at": 99, "stub": true})
        );
        let back: WsEvent =
            serde_json::from_str(&to_bus_json(&stub).expect("bus")).expect("stub parses");
        assert!(matches!(
            back,
            WsEvent::MessageUpdated {
                update: Updated::Stub(EditStub {
                    id: 7,
                    thread_root_id: Some(3),
                    edited_at: Some(99),
                    stub: true
                }),
                ..
            }
        ));
        let back: WsEvent =
            serde_json::from_str(&to_bus_json(&seen).expect("bus")).expect("full parses");
        assert!(matches!(
            back,
            WsEvent::MessageUpdated { update: Updated::Full { message }, .. } if message.id == 4
        ));
        let routing = ",\"server\":null,\"channel_id\":null";
        assert!(bus.contains(routing));
        let old: WsEvent = serde_json::from_str(&bus.replace(routing, ""))
            .expect("an event without server and channel_id still parses");
        assert!(matches!(
            old,
            WsEvent::MessageUpdated {
                server: None,
                channel_id: None,
                update: Updated::Full { message: _ },
                dm_users
            } if dm_users.len() == 2
        ));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn leaving_a_locked_server_drops_its_subscription() {
        let (state, path, general, _) = peek_world("ws_leave_locked").await;
        let db = &state.db;
        let conn = state.hub.next_conn();
        exec(
            db,
            "UPDATE servers SET password_hash = 'hash' WHERE name = 'open'",
        )
        .await;
        let mut nora = Access::new(Some(s("nora")), false, set(&["home", "open"]));
        nora.subs.insert(s("open"));
        nora.viewable = HashMap::from([(general, (s("open"), true))]);
        for left in [
            WsEvent::MemberLeft {
                server: s("open"),
                username: s("nora"),
            },
            WsEvent::MemberKicked {
                server: s("open"),
                username: s("nora"),
                banned: false,
            },
        ] {
            nora.member_servers.insert(s("open"));
            nora.subs.insert(s("open"));
            on_event(&state, conn, &mut nora, &left).await;
            assert!(!nora.held("open"));
            assert_eq!(
                on_event(&state, conn, &mut nora, &post_in("open", general)).await,
                Some(false)
            );
        }
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn layout_changes_only_carry_viewable_channels() {
        let (state, path, general, secret) = peek_world("layout_filter").await;
        let db = &state.db;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('open', 'nora', 1)",
        )
        .await;
        exec(
            db,
            "UPDATE members SET is_admin = 1 WHERE server = 'open' AND username = 'alice'",
        )
        .await;
        let hidden = insert_id(db, "INSERT INTO channel_categories(server, name, position, created_at) VALUES('open', 'Staff', 0, 1) RETURNING id").await;
        let empty = insert_id(db, "INSERT INTO channel_categories(server, name, position, created_at) VALUES('open', 'Later', 1, 1) RETURNING id").await;
        sqlx::query("UPDATE channels SET category_id = $1 WHERE id = $2")
            .bind(hidden)
            .bind(secret)
            .execute(db)
            .await
            .unwrap();
        let layout = crate::api::categories::current_layout(db, "open")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(layout.uncategorized, [general]);
        assert_eq!(
            layout.categories.iter().map(|c| c.id).collect::<Vec<_>>(),
            [hidden, empty]
        );
        let ev = WsEvent::LayoutChanged {
            server: s("open"),
            layout: layout.clone(),
            created: None,
            deleted: None,
        };
        let fanned = crate::fanout::Fanned::new(ev.clone(), 1);
        assert!(client_frame(&fanned, Some("nora")).is_none());
        let mut nora = Access::new(Some(s("nora")), false, set(&["open"]));
        assert_eq!(on_event(&state, 1, &mut nora, &ev).await, Some(true));
        let mine = layout_for(&state, &mut nora, "open", &layout, None, None)
            .await
            .unwrap()
            .unwrap();
        let json = serde_json::to_string(&mine).unwrap();
        assert!(json.contains("\"type\":\"layout_changed\""), "{json}");
        assert!(!json.contains(&format!("{secret}")), "{json}");
        assert!(!json.contains("Staff") && !json.contains("Later"), "{json}");
        match mine {
            WsEvent::LayoutChanged {
                server,
                layout,
                created: _,
                deleted: _,
            } => {
                assert_eq!(server, "open");
                assert_eq!(layout.uncategorized, [general]);
                assert!(layout.categories.is_empty());
            }
            _ => panic!("expected layout_changed"),
        }
        let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
        match layout_for(&state, &mut alice, "open", &layout, None, None)
            .await
            .unwrap()
            .unwrap()
        {
            WsEvent::LayoutChanged {
                server: _,
                layout: got,
                created: _,
                deleted: _,
            } => assert_eq!(got, layout),
            _ => panic!("expected layout_changed"),
        }
        let mut stranger = Access::new(Some(s("zed")), false, HashSet::new());
        assert_eq!(on_event(&state, 2, &mut stranger, &ev).await, Some(false));
        let stale = WsEvent::LayoutChanged {
            server: s("open"),
            layout: crate::api::ChannelLayout {
                version: 0,
                uncategorized: Vec::new(),
                categories: Vec::new(),
            },
            created: Some(secret),
            deleted: None,
        };
        match current(&state, stale).await {
            Some(WsEvent::LayoutChanged {
                server: _,
                layout: got,
                created,
                deleted: None,
            }) => {
                assert_eq!(got, layout);
                assert_eq!(created, Some(secret));
            }
            _ => panic!("expected the stored layout"),
        }
        crate::api::test_util::done(state, path).await;
    }
    #[tokio::test]
    async fn channel_events_reach_only_viewers_with_their_own_positions() {
        let (state, path, general, secret) = peek_world("channel_event_positions").await;
        let db = &state.db;
        exec(
            db,
            "INSERT INTO members(server, username, joined_at) VALUES('open', 'nora', 1)",
        )
        .await;
        let after = insert_id(db, "INSERT INTO channels(server, name, created_at, position) VALUES('open', 'after', 1, 2) RETURNING id").await;
        exec(db, "UPDATE channels SET position = 1 WHERE name = 'secret'").await;
        let (_, hidden) = channel_now(db, secret).await.unwrap().unwrap();
        let (_, shown) = channel_now(db, after).await.unwrap().unwrap();
        assert_eq!(shown.position, 2);
        let layout = crate::api::categories::current_layout(db, "open")
            .await
            .unwrap()
            .unwrap();
        let created = WsEvent::ChannelCreated {
            server: s("open"),
            channel: hidden.clone(),
        };
        assert_eq!(event_channel(&created), Some(("open", secret)));
        let fanned = crate::fanout::Fanned::new(created.clone(), 1);
        assert!(client_frame(&fanned, Some("nora")).is_none());
        let mut nora = Access::new(Some(s("nora")), false, set(&["open"]));
        assert_eq!(on_event(&state, 1, &mut nora, &created).await, Some(false));
        assert!(
            matches!(
                layout_for(&state, &mut nora, "open", &layout, Some(secret), None).await,
                Some(None)
            ),
            "creating a hidden channel sends its non-viewers no layout either"
        );
        for ev in [
            WsEvent::ChannelCreated {
                server: s("open"),
                channel: shown.clone(),
            },
            WsEvent::ChannelRenamed {
                server: s("open"),
                channel: shown.clone(),
            },
            WsEvent::ChannelUpdated {
                server: s("open"),
                channel: shown.clone(),
            },
        ] {
            let fanned = crate::fanout::Fanned::new(ev.clone(), 2);
            assert!(client_frame(&fanned, Some("nora")).is_none());
            assert_eq!(on_event(&state, 1, &mut nora, &ev).await, Some(true));
            let mine = channel_for(&state, &mut nora, &fanned)
                .await
                .unwrap()
                .expect("own frame");
            let wire = serde_json::to_value(&mine).unwrap();
            assert_eq!(wire["type"], serde_json::to_value(&ev).unwrap()["type"]);
            assert_eq!(wire["channel"]["id"], after);
            assert_eq!(
                wire["channel"]["position"], 1,
                "the hidden channel in between is not counted"
            );
        }
        assert!(matches!(
            layout_for(&state, &mut nora, "open", &layout, Some(after), None).await,
            Some(Some(WsEvent::LayoutChanged { .. }))
        ));
        let other = crate::fanout::Fanned::new(post_in("open", general), 3);
        assert!(matches!(
            channel_for(&state, &mut nora, &other).await,
            Some(None)
        ));
        exec(
            db,
            "UPDATE members SET is_admin = 1 WHERE server = 'open' AND username = 'alice'",
        )
        .await;
        let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
        assert_eq!(on_event(&state, 2, &mut alice, &created).await, Some(true));
        let fanned = crate::fanout::Fanned::new(
            WsEvent::ChannelRenamed {
                server: s("open"),
                channel: shown.clone(),
            },
            4,
        );
        match channel_for(&state, &mut alice, &fanned).await {
            Some(Some(WsEvent::ChannelRenamed { server: _, channel })) => {
                assert_eq!(channel.position, 2)
            }
            _ => panic!("expected channel_renamed"),
        }
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn channel_deleted_reaches_only_those_who_could_view_it() {
        let (state, path, general, secret) = peek_world("channel_deleted_viewers").await;
        let db = &state.db;
        add_user(db, "vic").await;
        add_user(db, "max").await;
        for sql in [
            "INSERT INTO members(server, username, joined_at) VALUES('open', 'nora', 1)",
            "INSERT INTO members(server, username, joined_at) VALUES('open', 'vic', 1)",
            "INSERT INTO members(server, username, joined_at) VALUES('open', 'max', 1)",
            "UPDATE members SET is_admin = 1 WHERE server = 'open' AND username = 'alice'",
        ] {
            exec(db, sql).await;
        }
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:vic', 1, 1, 1)")
            .bind(secret)
            .execute(db)
            .await
            .unwrap();
        let rules = crate::api::access::ws_view_rules(db, secret).await.unwrap();
        let open = crate::api::access::ws_view_rules(db, general)
            .await
            .unwrap();
        let mut warm_nora = Access::new(Some(s("nora")), false, set(&["open"]));
        let mut warm_vic = Access::new(Some(s("vic")), false, set(&["open"]));
        assert_eq!(
            channel_gate(&state, &mut warm_nora, "open", secret).await,
            Some(false)
        );
        assert_eq!(
            channel_gate(&state, &mut warm_vic, "open", secret).await,
            Some(true)
        );
        exec(db, "DELETE FROM channel_perms").await;
        sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(secret)
            .execute(db)
            .await
            .unwrap();
        let deleted = |rules: Option<ViewRules>| WsEvent::ChannelDeleted {
            server: s("open"),
            channel_id: secret,
            rules,
        };
        let ev = deleted(Some(rules.clone()));
        let wire = serde_json::to_string(&ev).unwrap();
        assert!(!wire.contains("rules") && !wire.contains("u:vic"), "{wire}");
        let back: WsEvent = serde_json::from_str(&to_bus_json(&ev).unwrap()).unwrap();
        assert!(
            matches!(&back, WsEvent::ChannelDeleted { rules: Some(r), .. } if r.rules.len() == 2)
        );
        let old: WsEvent = serde_json::from_str(&wire).unwrap();
        assert!(matches!(&old, WsEvent::ChannelDeleted { rules: None, .. }));
        let fanned = crate::fanout::Fanned::new(back.clone(), 1);
        assert_eq!(
            client_frame(&fanned, Some("nora")).as_deref(),
            Some(wire.as_str())
        );
        for (user, want) in [
            ("nora", false),
            ("max", false),
            ("vic", true),
            ("alice", true),
        ] {
            let mut cold = Access::new(Some(s(user)), false, set(&["open"]));
            assert_eq!(
                on_event(&state, 1, &mut cold, &back).await,
                Some(want),
                "{user}"
            );
        }
        let mut guest = Access::new(None, false, HashSet::new());
        guest.subs.insert(s("open"));
        assert_eq!(on_event(&state, 1, &mut guest, &back).await, Some(false));
        assert_eq!(
            on_event(&state, 1, &mut warm_nora, &back).await,
            Some(false)
        );
        assert!(warm_nora.viewable.is_empty());
        assert_eq!(on_event(&state, 1, &mut warm_vic, &back).await, Some(true));
        assert!(warm_vic.viewable.is_empty());
        let mut cold_vic = Access::new(Some(s("vic")), false, set(&["open"]));
        assert_eq!(
            on_event(&state, 1, &mut cold_vic, &old).await,
            Some(false),
            "no rules, no memo"
        );
        let mut warm_vic = Access::new(Some(s("vic")), false, set(&["open"]));
        warm_vic.viewable = HashMap::from([(secret, (s("open"), true))]);
        assert_eq!(
            on_event(&state, 1, &mut warm_vic, &old).await,
            Some(true),
            "the memo decides"
        );
        let mut nora = Access::new(Some(s("nora")), false, set(&["open"]));
        let public = WsEvent::ChannelDeleted {
            server: s("open"),
            channel_id: general,
            rules: Some(open),
        };
        assert_eq!(on_event(&state, 1, &mut nora, &public).await, Some(true));
        crate::api::test_util::done(state, path).await;
    }

    #[tokio::test]
    async fn deleting_a_hidden_channel_sends_its_non_viewers_no_layout() {
        let (state, path, general, secret) = peek_world("layout_after_delete").await;
        let db = &state.db;
        add_user(db, "vic").await;
        for sql in [
            "INSERT INTO members(server, username, joined_at) VALUES('open', 'nora', 1)",
            "INSERT INTO members(server, username, joined_at) VALUES('open', 'vic', 1)",
            "UPDATE members SET is_admin = 1 WHERE server = 'open' AND username = 'alice'",
        ] {
            exec(db, sql).await;
        }
        let after = insert_id(db, "INSERT INTO channels(server, name, created_at, position) VALUES('open', 'after', 1, 2) RETURNING id").await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:vic', 1, 1, 1)")
            .bind(secret)
            .execute(db)
            .await
            .unwrap();
        let rules = crate::api::access::ws_view_rules(db, secret).await.unwrap();
        let shown = crate::api::access::ws_view_rules(db, after).await.unwrap();
        sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(secret)
            .execute(db)
            .await
            .unwrap();
        let layout = crate::api::categories::current_layout(db, "open")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(layout.uncategorized, [general, after]);
        let ev = WsEvent::LayoutChanged {
            server: s("open"),
            layout: layout.clone(),
            created: None,
            deleted: Some(rules.clone()),
        };
        let wire = serde_json::to_string(&ev).unwrap();
        assert!(
            !wire.contains("deleted") && !wire.contains("u:vic"),
            "{wire}"
        );
        let back: WsEvent = serde_json::from_str(&to_bus_json(&ev).unwrap()).unwrap();
        let Some(WsEvent::LayoutChanged {
            server: _,
            layout: _,
            created: None,
            deleted: Some(kept),
        }) = current(&state, back).await
        else {
            panic!("expected layout_changed with its deleted rules");
        };
        for (user, sent) in [("nora", false), ("vic", true), ("alice", true)] {
            let mut access = Access::new(Some(s(user)), false, set(&["open"]));
            assert_eq!(on_event(&state, 1, &mut access, &ev).await, Some(true));
            let mine = layout_for(&state, &mut access, "open", &layout, None, Some(&kept))
                .await
                .unwrap();
            assert_eq!(mine.is_some(), sent, "{user}");
        }
        let mut nora = Access::new(Some(s("nora")), false, set(&["open"]));
        assert!(
            matches!(
                layout_for(&state, &mut nora, "open", &layout, None, Some(&shown)).await,
                Some(Some(WsEvent::LayoutChanged { .. }))
            ),
            "deleting a channel they could view still updates their layout"
        );
        crate::api::test_util::done(state, path).await;
    }
}
