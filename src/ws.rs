use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message as Frame, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{debug, warn};

use crate::api::messages::{load_message, load_message_with_embeds};
use crate::api::servers::server_lite;
use crate::api::{
    Channel, Embed, Member, Message, ServerSummaryLite, Settings, UserRef, grant_matches,
};
use crate::db::{
    ChannelKind, Db, channel_access, channel_viewable, get_user, is_banned, now, setting_on,
    touch_interaction,
};
use crate::fanout::Topic;
pub use crate::hub::Hub;
use crate::hub::{Aftermath, CallEnd, Epoch, Op, P2pDrop, Purge};
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
        message: Box<Message>,
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
        filename: String,
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
    ChannelCreated {
        server: String,
        channel: Channel,
    },
    ChannelRenamed {
        server: String,
        channel: Channel,
    },
    ChannelDeleted {
        server: String,
        channel_id: i64,
    },
    ServerCreated {
        server: ServerSummaryLite,
    },
    ServerRenamed {
        old_name: String,
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
    },
    PresenceMode {
        username: String,
        appear_offline: bool,
    },
    ReadUpdated {
        username: String,
        scope: String,
        last_read: i64,
    },
    VoiceState {
        server: String,
        channel_id: i64,
        users: Vec<String>,
    },
    CallState {
        dm_id: i64,
        dm_users: Vec<String>,
        state: CallPhase,
        from: String,
        kind: CallKind,
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
    Banned {
        username: String,
    },
    SettingsChanged {
        settings: Settings,
    },
    TokensRevoked {
        username: String,
    },
    Resync,
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
    },
    P2pHosting {
        peer_id: String,
        ids: Vec<String>,
    },
    P2pWho {
        hosters: Vec<String>,
    },
    CallAccept {
        dm_id: i64,
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
}

pub(crate) async fn evict_unviewable(state: &AppState, server: &str, channel_id: Option<i64>) {
    for (cid, users) in state.hub.rooms_in(server, channel_id) {
        if let Ok(Some((owner, _))) = channel_now(&state.read(), cid).await
            && owner != server
        {
            continue;
        }
        for user in users {
            if !channel_viewable(&state.read(), server, cid, Some(&user)).await {
                state.hub.evict_voice(&user, cid);
            }
        }
    }
}

async fn insert_call_log(state: &AppState, dm_id: i64, caller: &str) -> Result<i64, sqlx::Error> {
    sqlx::query(
        "INSERT INTO messages(dm_id, author, content, kind, created_at) VALUES($1, $2, '', 'call', $3) RETURNING id",
    )
    .bind(dm_id)
    .bind(caller)
    .bind(now())
    .fetch_one(&state.db)
    .await?
    .try_get(0)
}

async fn broadcast_call_log(state: &AppState, dm_id: i64, dm_users: Vec<String>, log_id: i64) {
    if let Ok(Some(message)) = crate::api::messages::load_message(&state.read(), log_id).await {
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
    if let Ok(Some(message)) = crate::api::messages::load_message(&state.read(), log_id).await {
        state.hub.broadcast(WsEvent::MessageUpdated {
            message: Box::new(message),
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
    (scope_servers, scope_users): P2pScope,
) {
    state.hub.set_p2p(user, conn, peer_id.clone(), ids.clone());
    state.hub.broadcast(WsEvent::P2pAvailability {
        hoster: user.to_string(),
        peer_id: Some(peer_id),
        ids,
        online: true,
        scope_servers,
        scope_users,
    });
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
            let (scope_servers, scope_users) = scope().await;
            state.hub.broadcast(WsEvent::P2pAvailability {
                hoster: user.to_string(),
                peer_id: Some(peer_id),
                ids,
                online: true,
                scope_servers,
                scope_users,
            });
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
        sqlx::query("SELECT server, name, kind, slowmode_seconds FROM channels WHERE id = $1")
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
            },
        ))),
        None => Ok(None),
    }
}

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
            let message = load_message_with_embeds(db, message.id)
                .await
                .ok()
                .flatten()?;
            Some(WsEvent::Message {
                server,
                channel_id,
                dm_id,
                dm_users,
                message: Box::new(message),
            })
        }
        WsEvent::MessageUpdated { message, dm_users } => {
            let message = load_message_with_embeds(db, message.id)
                .await
                .ok()
                .flatten()?;
            Some(WsEvent::MessageUpdated {
                message: Box::new(message),
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
            let message = load_message_with_embeds(db, message_id)
                .await
                .ok()
                .flatten()?;
            Some(WsEvent::EmbedsResolved {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                embeds: message.embeds,
            })
        }
        WsEvent::ChannelCreated { server, channel } => {
            let (owner, channel) = channel_now(db, channel.id).await.ok().flatten()?;
            (owner == server).then_some(WsEvent::ChannelCreated { server, channel })
        }
        WsEvent::ChannelRenamed { server, channel } => {
            let (owner, channel) = channel_now(db, channel.id).await.ok().flatten()?;
            (owner == server).then_some(WsEvent::ChannelRenamed { server, channel })
        }
        WsEvent::ServerCreated { server } => {
            let server = server_lite(db, &server.name).await.ok().flatten()?;
            Some(WsEvent::ServerCreated { server })
        }
        WsEvent::ServerRenamed { old_name, server } => {
            let reused =
                old_name != server.name && !matches!(server_lite(db, &old_name).await, Ok(None));
            let server = server_lite(db, &server.name).await.ok().flatten()?;
            (!reused).then_some(WsEvent::ServerRenamed { old_name, server })
        }
        WsEvent::ServerDeleted { name } => match server_lite(db, &name).await {
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
        WsEvent::PresenceMode {
            username,
            appear_offline: _,
        } => {
            let appear_offline = appear_offline_of(db, &username).await.ok().flatten()?;
            Some(WsEvent::PresenceMode {
                username,
                appear_offline,
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
            if matches!(load_message(&state.read(), id).await, Ok(None)) {
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
            if !is_member(&state.read(), &server, &user)
                .await
                .unwrap_or(false)
            {
                state.hub.force_offline(&server, &user);
            }
        }
        Op::EvictVoice { user, channel_id } => {
            let allowed = match channel_now(&state.read(), channel_id).await {
                Ok(Some((server, _))) => {
                    channel_viewable(&state.read(), &server, channel_id, Some(&user)).await
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

#[utoipa::path(get, path = "/api/ws", responses((status = 101, description = "WebSocket upgrade"), (status = 503, description = "Realtime bus not ready")))]
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
            let row = sqlx::query("SELECT server, kind FROM channels WHERE id = $1")
                .bind(channel_id)
                .fetch_optional(&state.read())
                .await
                .map_err(db_err)?
                .ok_or_else(|| "Channel not found".to_string())?;
            let server: String = row.try_get(0).map_err(db_err)?;
            let kind = ChannelKind::parse(&row.try_get::<String, _>(1).map_err(db_err)?)
                .map_err(db_err)?;
            if kind != ChannelKind::Voice {
                return Err("Not a voice channel".to_string());
            }
            if is_banned(&state.read(), &server, user)
                .await
                .map_err(db_err)?
            {
                return Err("You are banned from this server".to_string());
            }
            if !channel_viewable(&state.read(), &server, channel_id, Some(user)).await {
                return Err("Not allowed".to_string());
            }
            let ends = state
                .hub
                .voice_join_capped(user, conn, &server, channel_id, voice_room_max())
                .await?;
            for end in ends {
                finalize_call_log(state, end, false).await;
            }
            touch_interaction(&state.db, &server, user)
                .await
                .map_err(db_err)
        }
        ClientMsg::VoiceLeave => {
            state.hub.voice_leave(user).await;
            Ok(())
        }
        ClientMsg::CallStart { dm_id, p2p } => {
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
            let kind = match p2p {
                true => CallKind::P2p,
                false => CallKind::Rtc,
            };
            let dm_users = vec![a, b];
            let log_id = insert_call_log(state, dm_id, user).await.map_err(db_err)?;
            match state
                .hub
                .call_start(user, conn, dm_id, dm_users.clone(), kind, log_id)
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
        ClientMsg::CallAccept { dm_id } => {
            let (log_id, dm_users) = state.hub.call_accept(user, conn, dm_id).await?;
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
            match state.hub.rtc_shared(user, &to, channel_id, dm_id) {
                true => {
                    state.hub.broadcast(WsEvent::RtcSignal {
                        to,
                        from: user.to_string(),
                        channel_id,
                        dm_id,
                        payload,
                    });
                    Ok(())
                }
                false => Err("No shared voice session".to_string()),
            }
        }
        ClientMsg::Auth { token: _ }
        | ClientMsg::Viewing { server: _ }
        | ClientMsg::Subscribe {
            servers: _,
            grants: _,
        }
        | ClientMsg::P2pHosting { peer_id: _, ids: _ }
        | ClientMsg::P2pWho { hosters: _ } => Ok(()),
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
    match (server_password_hash(db, server).await?, grant) {
        (None, _) => Ok(false),
        (Some(None), _) => Ok(true),
        (Some(Some(_)), Some(grant)) => grant_matches(db, grant, server).await,
        (Some(Some(_)), None) => Ok(false),
    }
}

async fn authed_sub_ok(db: &Db, server: &str, user: &str, site_admin: bool) -> sqlx::Result<bool> {
    match server_password_hash(db, server).await? {
        None => Ok(false),
        Some(None) => Ok(true),
        Some(Some(_)) => Ok(site_admin || is_member(db, server, user).await?),
    }
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
            .bind(token)
            .fetch_optional(db)
            .await?
            .is_some()),
        None => Ok(false),
    }
}

async fn session_of(db: &Db, token: &str) -> sqlx::Result<Option<bool>> {
    match sqlx::query(
        "SELECT u.appear_offline FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1 AND u.password_hash <> '!purging'",
    )
    .bind(token)
    .fetch_optional(db)
    .await?
    {
        Some(r) => Ok(Some(r.try_get::<i64, _>(0)? != 0)),
        None => Ok(None),
    }
}

async fn appear_offline_of(db: &Db, user: &str) -> sqlx::Result<Option<bool>> {
    match sqlx::query("SELECT appear_offline FROM users WHERE username = $1")
        .bind(user)
        .fetch_optional(db)
        .await?
    {
        Some(r) => Ok(Some(r.try_get::<i64, _>(0)? != 0)),
        None => Ok(None),
    }
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
    token: Option<String>,
    site_admin: bool,
    member_servers: HashSet<String>,
    subs: HashSet<String>,
    grants: HashMap<String, String>,
    viewing: Option<String>,
    hidden: bool,
    shown: Option<String>,
    dark: bool,
    missed: bool,
    hosting: Option<(String, Vec<String>)>,
    hosted_scope: Option<(Instant, P2pScope)>,
    hosting_pace: Pace,
    viewable: Viewable,
    retry: Retry,
    topics_dirty: bool,
}

impl Access {
    fn new(user: Option<String>, site_admin: bool, member_servers: HashSet<String>) -> Access {
        Access {
            user,
            token: None,
            site_admin,
            member_servers,
            subs: HashSet::new(),
            grants: HashMap::new(),
            viewing: None,
            hidden: false,
            shown: None,
            dark: false,
            missed: false,
            hosting: None,
            hosted_scope: None,
            hosting_pace: Pace::new(P2P_ANNOUNCE_EVERY),
            viewable: HashMap::new(),
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

    fn target(&self) -> Option<String> {
        match self.hidden {
            true => None,
            false => self.viewing.clone(),
        }
    }

    fn sync(&mut self, hub: &Hub, conn: u64) {
        let target = self.target();
        if let Some(user) = &self.user
            && !self.dark
            && target != self.shown
        {
            hub.set_viewing(user, conn, self.shown.as_deref(), target.as_deref());
            self.shown = target;
        }
    }

    fn view(&mut self, hub: &Hub, conn: u64, target: Option<String>) {
        self.topics_dirty |= self.viewing != target;
        self.viewing = target;
        self.sync(hub, conn);
    }

    fn set_hidden(&mut self, hub: &Hub, conn: u64, hidden: bool) {
        self.hidden = hidden;
        self.sync(hub, conn);
    }

    fn reshow(&mut self, hub: &Hub, conn: u64) {
        if let Some(user) = &self.user {
            let target = match self.retry.pending() {
                true => None,
                false => self.target(),
            };
            hub.reannounce(user, conn, target.as_deref());
            self.dark = self.retry.pending();
            self.shown = target;
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
    let (servers, hidden) = match &access.user {
        Some(user) => {
            let session = match &access.token {
                Some(token) => session_of(db, token).await?,
                None => appear_offline_of(db, user).await?,
            };
            let Some(hidden) = session else {
                return Ok(false);
            };
            (member_servers_of(db, user).await?, hidden)
        }
        None => {
            if !setting_on(db, "guests_enabled").await? {
                return Ok(false);
            }
            (HashSet::new(), false)
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
    if access.member_servers != servers {
        access.hosted_scope = None;
    }
    access.member_servers = servers;
    access.hidden = hidden;
    access.grants.retain(|server, _| kept.contains(server));
    access.subs = kept;
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

async fn still_held(db: &Db, access: &Access, name: &str) -> sqlx::Result<bool> {
    let Some(hash) = server_password_hash(db, name).await? else {
        return Ok(true);
    };
    match &access.user {
        Some(user) => {
            let member = access.member_servers.contains(name);
            let check = member || (hash.is_some() && !access.site_admin);
            Ok(!check || is_member(db, name, user).await?)
        }
        None => match (hash, access.grants.get(name)) {
            (None, _) => Ok(true),
            (Some(_), Some(grant)) => grant_matches(db, grant, name).await,
            (Some(_), None) => Ok(false),
        },
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
    let restricted = sqlx::query("SELECT 1 FROM channel_perms WHERE channel_id = $1 LIMIT 1")
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
    let user = match username {
        Some(name) => get_user(db, name).await?,
        None => None,
    };
    let view = channel_access(db, &owner, cid, user.as_ref()).await?.view;
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

async fn on_event(state: &AppState, conn: u64, access: &mut Access, ev: &WsEvent) -> Option<bool> {
    if let (Some(server), Some(user)) = (self_grant(ev, access.user.as_deref()), &access.user) {
        let started = Instant::now();
        match is_member(&state.read(), server, user).await {
            Ok(true) => {}
            Ok(false) => return Some(false),
            Err(e) => return access.hold(e, started).then_some(false),
        }
    }
    let mut deliver = access.wants(ev);
    track(ev, access);
    if let WsEvent::ServerRenamed {
        old_name: _,
        server,
    }
    | WsEvent::ServerCreated { server } = ev
        && !access.recheck(state, conn, &server.name).await
    {
        return None;
    }
    if let WsEvent::ServerRenamed {
        old_name: _,
        server,
    } = ev
    {
        deliver &= access.site_admin || access.held(&server.name);
    }
    if access.retry.pending() {
        deliver &= access.wants(ev);
    }
    if deliver && let Some((server, cid)) = event_channel(ev) {
        deliver = channel_gate(state, access, server, cid).await?;
    }
    Some(deliver)
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
}

impl Bucket {
    fn new() -> Bucket {
        Bucket {
            tokens: MSG_BURST,
            at: Instant::now(),
        }
    }

    fn take(&mut self, now: Instant) -> Option<bool> {
        let refill = now.duration_since(self.at).as_secs_f64() * MSG_RATE;
        self.tokens = (self.tokens + refill).min(MSG_BURST) - 1.0;
        self.at = now;
        match self.tokens {
            t if t >= 0.0 => Some(true),
            t if t < -MSG_BURST => None,
            _ => Some(false),
        }
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
        (_, _) => fanned.frame(),
    }
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
    }
    true
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
    let (username, is_site_admin, hidden): (Option<String>, bool, bool) = match &token {
        Some(token) => {
            let row = sqlx::query(
                "SELECT u.username, u.is_site_admin, u.appear_offline FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1 AND u.password_hash <> '!purging'",
            )
            .bind(token)
            .fetch_optional(&state.read())
            .await;
            match row {
                Ok(Some(r)) => (
                    r.try_get(0).ok(),
                    r.try_get::<i64, _>(1).map(|v| v != 0).unwrap_or(false),
                    r.try_get::<i64, _>(2).map(|v| v != 0).unwrap_or(false),
                ),
                Ok(None) => (None, false, false),
                Err(e) => return refuse(e),
            }
        }
        None => (None, false, false),
    };
    if let Some(user) = &username {
        state.hub.listen(conn, &[Topic::User(user.clone())]);
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
    access.hidden = hidden;
    access.token = token.filter(|_| access.user.is_some());
    state.hub.reconcile(conn, &access.topics(), 0);
    let (sink, mut stream) = socket.split();
    let out = Out::spawn(sink);
    let mut through = 0;
    let mut bucket = Bucket::new();
    let mut ping = tokio::time::interval_at(Instant::now() + PING_EVERY, PING_EVERY);
    let mut heard = Instant::now();
    let mut lag = Pace::new(LAG_REAUTH_EVERY);
    if !send_voice_snapshot(&state, &out, &mut access).await {
        return;
    }
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
                    if deliver
                        && let Some(frame) = client_frame(&fanned, access.user.as_deref())
                        && !sent(&mut access, out.text(frame))
                    {
                        break;
                    }
                    match ev {
                        WsEvent::Banned { username: banned } if Some(banned.as_str()) == access.user.as_deref() => break,
                        WsEvent::TokensRevoked { username: user } if Some(user.as_str()) == access.user.as_deref() && !access.check_token(&state.read()).await => break,
                        WsEvent::SettingsChanged { settings } if access.user.is_none() && !settings.guests_enabled => break,
                        WsEvent::PresenceMode { username: user, appear_offline } if Some(user.as_str()) == access.user.as_deref() => {
                            access.set_hidden(&state.hub, conn, *appear_offline);
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
                            let target = match (&access.user, server) {
                                (Some(user), Some(s)) => {
                                    let s = s.to_lowercase();
                                    state.hub.listen(conn, &[Topic::View(s.clone())]);
                                    let member = is_member(&state.read(), &s, user).await.unwrap_or(false);
                                    access.topics_dirty |= !member && !access.subs.contains(&s);
                                    member.then_some(s)
                                }
                                (_, _) => None,
                            };
                            access.view(&state.hub, conn, target);
                        }
                        Ok(ClientMsg::Subscribe { servers, grants }) => {
                            let servers: Vec<String> = servers.into_iter().take(SUBSCRIBE_CAP).map(|s| s.to_lowercase()).collect();
                            let early: Vec<Topic> = servers.iter().flat_map(|s| [Topic::Server(s.clone()), Topic::View(s.clone())]).collect();
                            state.hub.listen(conn, &early);
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
                            if !send_voice_snapshot(&state, &out, &mut access).await {
                                break;
                            }
                        }
                        Ok(ClientMsg::P2pHosting { peer_id, ids }) => {
                            if access.user.is_some() && peer_id.len() <= P2P_ID_MAX {
                                access.host(&state, conn, (peer_id, hosting_ids(ids))).await;
                            }
                        }
                        Ok(ClientMsg::P2pWho { hosters: _ }) if access.retry.pending() => {}
                        Ok(ClientMsg::P2pWho { hosters }) => {
                            let mut closed = false;
                            for hoster in hosters.into_iter().take(P2P_IDS_CAP) {
                                let hoster = hoster.to_lowercase();
                                let ev = match state.hub.p2p_of(&hoster) {
                                    Some((peer_id, ids)) => WsEvent::P2pAvailability {
                                        hoster,
                                        peer_id: Some(peer_id),
                                        ids,
                                        online: true,
                                        scope_servers: Vec::new(),
                                        scope_users: Vec::new(),
                                    },
                                    None => p2p_offline(hoster, Vec::new(), Vec::new()),
                                };
                                if !sent(&mut access, out.event(&ev)) {
                                    closed = true;
                                    break;
                                }
                            }
                            if closed {
                                break;
                            }
                        }
                        Ok(ClientMsg::Auth { token: _ }) | Err(_) => {}
                        Ok(other) => {
                            let leaving = matches!(other, ClientMsg::VoiceLeave | ClientMsg::CallLeave { dm_id: _ } | ClientMsg::CallDecline { dm_id: _ });
                            let res = match (&access.user, access.retry.pending() && !leaving) {
                                (Some(_), true) => Err("Reconnecting, try again in a moment".to_string()),
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
    drop(inbox);
    state.hub.close(conn);
    if let Some(user) = &access.user {
        let (ends, drop) = state.hub.drop_conn(user, conn).await;
        for end in ends {
            finalize_call_log(&state, end, false).await;
        }
        let cached = access.hosted_scope.take().map(|(_, scope)| scope);
        announce_drop(&state, user, drop, cached).await;
    }
}

fn leave(access: &mut Access, server: &str) {
    access.member_servers.remove(server);
    access.hosted_scope = None;
    access.viewable.clear();
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
                access.member_servers.insert(server.clone());
                access.hosted_scope = None;
                access.viewable.clear();
                access.topics_dirty = true;
            }
        }
        WsEvent::MemberLeft { server, username }
        | WsEvent::MemberKicked {
            server,
            username,
            banned: _,
        } => {
            if Some(username.as_str()) == me {
                leave(access, server);
            }
        }
        WsEvent::MembersPurged { server, usernames } => {
            if me.is_some_and(|me| usernames.iter().any(|u| u == me)) {
                leave(access, server);
            }
        }
        WsEvent::ServerCreated { server } => {
            if server.creator.as_deref() == me {
                access.member_servers.insert(server.name.clone());
                access.hosted_scope = None;
                access.viewable.clear();
                access.topics_dirty = true;
            }
        }
        WsEvent::AdminChanged {
            server,
            username,
            is_admin: _,
            perms: _,
        } => {
            if Some(username.as_str()) == me {
                access.viewable.retain(|_, (owner, _)| owner != server);
            }
        }
        WsEvent::RolesChanged { server } => {
            access.viewable.retain(|_, (owner, _)| owner != server);
        }
        WsEvent::ChannelPermsChanged {
            server: _,
            channel_id,
        }
        | WsEvent::ChannelDeleted {
            server: _,
            channel_id,
        } => {
            access.viewable.remove(channel_id);
        }
        WsEvent::ServerRenamed { old_name, server } => {
            access.topics_dirty |= access.held(old_name);
            if access.member_servers.remove(old_name) {
                access.member_servers.insert(server.name.clone());
                access.hosted_scope = None;
            }
            if access.subs.remove(old_name) {
                access.subs.insert(server.name.clone());
            }
            if let Some(grant) = access.grants.remove(old_name) {
                access.grants.insert(server.name.clone(), grant);
            }
            if access.viewing.as_deref() == Some(old_name.as_str()) {
                access.viewing = Some(server.name.clone());
            }
            access.viewable.retain(|_, (owner, _)| owner != old_name);
        }
        WsEvent::ServerDeleted { name } => {
            access.topics_dirty |= access.held(name);
            if access.member_servers.remove(name) {
                access.hosted_scope = None;
            }
            access.subs.remove(name);
            if access.viewing.as_deref() == Some(name.as_str()) {
                access.viewing = None;
            }
            access.viewable.retain(|_, (owner, _)| owner != name);
        }
        _ => {}
    }
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
            filename: _,
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
        WsEvent::ChannelRenamed { server, channel } => Some((server.as_str(), channel.id)),
        WsEvent::VoiceState {
            server,
            channel_id,
            users: _,
        } => Some((server.as_str(), *channel_id)),
        WsEvent::VoiceEnded {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            reason: _,
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
            message: _,
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
            filename: _,
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
        WsEvent::ChannelCreated { server, channel: _ }
        | WsEvent::ChannelRenamed { server, channel: _ } => in_server(server),
        WsEvent::ChannelDeleted {
            server,
            channel_id: _,
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
        } => in_server(server),
        WsEvent::PresenceMode {
            username,
            appear_offline: _,
        }
        | WsEvent::ReadUpdated {
            username,
            scope: _,
            last_read: _,
        } => Some(username.as_str()) == me,
        WsEvent::ServerCreated { server } => {
            is_site_admin || (me.is_some() && server.creator.as_deref() == me)
        }
        WsEvent::ServerRenamed {
            old_name,
            server: _,
        } => is_site_admin || in_server(old_name),
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
        WsEvent::CallState {
            dm_id: _,
            dm_users,
            state: _,
            from: _,
            kind: _,
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
        WsEvent::Error { message: _ }
        | WsEvent::TokensRevoked { username: _ }
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
            message: Box::new(message()),
            dm_users: vec!["alice".to_string(), "bob".to_string()],
        };
        let client = serde_json::to_string(&updated).unwrap();
        assert!(!client.contains("dm_users"));
        let back: WsEvent = serde_json::from_str(&to_bus_json(&updated).unwrap()).unwrap();
        assert!(
            matches!(&back, WsEvent::MessageUpdated { message: _, dm_users } if dm_users.len() == 2)
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

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
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
        load_message(db, id).await.ok().flatten().unwrap()
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
        state.hub.set_viewing("bob", bob, None, Some("rchat"));
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
        let state = AppState::new(local.db.clone(), hub.clone(), None, None);
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
        state.hub.set_viewing("alice", conn, None, Some("a"));
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
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g2', 'kept', 0, 4000000000)",
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
    async fn banned_user_cannot_join_voice() {
        let (state, path) = crate::api::test_util::temp_state("ban_voice").await;
        let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
        exec(&state.db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('rchat', 'bob', 'alice', 0)").await;
        let join = |user| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id: cid });
        assert_eq!(
            join("bob").await,
            Err("You are banned from this server".to_string())
        );
        join("carol").await.expect("carol joins");
        assert_eq!(
            state.hub.rooms_in("rchat", None),
            vec![(cid, vec!["carol".to_string()])]
        );
        crate::api::test_util::done(state, path).await;
    }

    fn presence_events(rx: &mut broadcast::Receiver<WsEvent>) -> Vec<(String, bool)> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::PresenceChanged {
                server,
                username: _,
                online,
            } = ev
            {
                out.push((server, online));
            }
        }
        out
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
        a.view(&hub, 1, Some(s("rchat")));
        b.view(&hub, 2, Some(s("rchat")));
        assert!(hub.is_online("rchat", "alice"));
        assert_eq!(hub.online_count("rchat"), 1);
        assert_eq!(presence_events(&mut rx), vec![(s("rchat"), true)]);
        a.set_hidden(&hub, 1, true);
        assert!(hub.is_online("rchat", "alice"));
        b.set_hidden(&hub, 2, true);
        assert!(!hub.is_online("rchat", "alice"));
        assert_eq!(hub.online_count("rchat"), 0);
        assert!(hub.online_set("rchat").is_empty());
        assert_eq!(presence_events(&mut rx), vec![(s("rchat"), false)]);
        let mut c = viewer("alice", true);
        c.view(&hub, 3, Some(s("rchat")));
        a.view(&hub, 1, Some(s("other")));
        b.set_hidden(&hub, 2, true);
        assert!(!hub.is_online("rchat", "alice"));
        assert!(!hub.is_online("other", "alice"));
        assert!(presence_events(&mut rx).is_empty());
        a.set_hidden(&hub, 1, false);
        assert!(hub.is_online("other", "alice"));
        assert!(!hub.is_online("rchat", "alice"));
        c.set_hidden(&hub, 3, false);
        b.set_hidden(&hub, 2, false);
        assert!(hub.is_online("rchat", "alice"));
        assert_eq!(hub.online_count("rchat"), 1);
        assert_eq!(
            presence_events(&mut rx),
            vec![(s("other"), true), (s("rchat"), true)]
        );
        a.set_hidden(&hub, 1, true);
        let _ = hub.drop_conn("alice", 1).await;
        let _ = hub.drop_conn("alice", 3).await;
        assert!(hub.is_online("rchat", "alice"));
        let _ = hub.drop_conn("alice", 2).await;
        assert!(!hub.is_online("rchat", "alice"));
        assert!(!hub.is_online("other", "alice"));
        assert_eq!(
            presence_events(&mut rx),
            vec![(s("other"), false), (s("rchat"), false)]
        );
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
        assert!(!hub.is_online("chat", "alice"));
        assert_eq!(presence_events(&mut rx), vec![(s("chat"), false)]);
        a.set_hidden(&hub, 1, false);
        let _ = hub.drop_conn("alice", 1).await;
        assert!(presence_events(&mut rx).is_empty());
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
        assert!(!hub.is_online("chat", "alice"));
        exec(&state.db, "UPDATE users SET appear_offline = 0").await;
        assert!(a.refresh(&state, 1).await);
        assert!(hub.is_online("chat", "alice"));
        let _ = hub.drop_conn("alice", 1).await;
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
        assert!(!hub.is_online("chat", "alice"));
        assert!(hub.online_set("chat").is_empty());
    }

    #[tokio::test]
    async fn force_offline_does_not_steal_other_connections() {
        let hub = Hub::new();
        let (mut a, mut b) = (viewer("alice", false), viewer("alice", false));
        a.view(&hub, 1, Some(s("rchat")));
        hub.force_offline("rchat", "alice");
        assert!(!hub.is_online("rchat", "alice"));
        b.view(&hub, 2, Some(s("rchat")));
        a.view(&hub, 1, None);
        assert!(hub.is_online("rchat", "alice"));
        a.view(&hub, 1, Some(s("rchat")));
        let _ = hub.drop_conn("alice", 2).await;
        assert!(hub.is_online("rchat", "alice"));
        let mut rx = hub.subscribe();
        hub.broadcast(WsEvent::Banned {
            username: s("alice"),
        });
        assert!(!hub.is_online("rchat", "alice"));
        let _ = hub.drop_conn("alice", 1).await;
        assert_eq!(presence_events(&mut rx), vec![(s("rchat"), false)]);
        assert!(hub.online_set("rchat").is_empty());
    }

    #[test]
    fn presence_mode_reaches_only_its_user() {
        let ev = WsEvent::PresenceMode {
            username: s("alice"),
            appear_offline: true,
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
            } = ev
                && access.user.as_deref() == Some(username.as_str())
            {
                access.set_hidden(hub, conn, appear_offline);
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
        });
        b.flush().await;
        apply_modes(&a, &mut rx_a, ca, &mut on_a);
        apply_modes(&b, &mut rx_b, cb, &mut on_b);
        a.flush().await;
        b.flush().await;
        assert!(a.is_online("rchat", "alice") && a.is_online("other", "alice"));
        assert!(b.is_online("rchat", "alice") && b.is_online("other", "alice"));
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
        assert!(!hub.is_online("chat", "alice"));
        a.view(&hub, 1, Some(s("chat")));
        a.set_hidden(&hub, 1, false);
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
            "INSERT INTO tokens(token, username, created_at) VALUES('t1', 'tia', 0)",
        )
        .await;
        assert!(token_live(db, Some("t1")).await.unwrap());
        assert!(!token_live(db, Some("t2")).await.unwrap());
        assert!(!token_live(db, None).await.unwrap());
        exec(db, "DELETE FROM tokens WHERE token = 't1'").await;
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
            "INSERT INTO tokens(token, username, created_at) VALUES('t1', 'tia', 0), ('t2', 'tia', 0)",
        )
        .await;
        let session = |token: &str| {
            let mut access = Access::new(Some(s("tia")), false, set(&["vault"]));
            access.token = Some(s(token));
            access.subs = set(&["open"]);
            access
        };
        let (mut tia, mut gone) = (session("t1"), session("t2"));
        exec(db, "DELETE FROM tokens WHERE token = 't2'").await;
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
            },
            WsEvent::PresenceChanged {
                server: s("open"),
                username: s("bob"),
                online: true,
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
            "INSERT INTO tokens(token, username, created_at) VALUES('t1', 'tia', 0), ('t2', 'tia', 0)",
        )
        .await;
        let session = |token: &str| {
            let mut access = Access::new(Some(s("tia")), false, HashSet::new());
            access.token = Some(s(token));
            access
        };
        let (mut kept, mut gone) = (session("t1"), session("t2"));
        exec(db, "DELETE FROM tokens WHERE token = 't2'").await;
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
                filename: s("f"),
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
                    },
                    WsEvent::ReadUpdated {
                        username: s(user),
                        scope: s("c1"),
                        last_read: 1,
                    },
                    WsEvent::TokensRevoked { username: s(user) },
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
            WsEvent::MessageUpdated {
                message: Box::new(message()),
                dm_users: vec![s("alice"), s("bob")],
            },
            WsEvent::CallState {
                dm_id: 1,
                dm_users: vec![s("alice"), s("bob")],
                state: CallPhase::Ringing,
                from: s("alice"),
                kind: CallKind::Rtc,
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
                    asset_previews: false,
                    asset_uploads: false,
                    guests_enabled: false,
                },
            },
            WsEvent::Error { message: s("e") },
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
        crate::api::test_util::done(state, path).await;
    }
}
