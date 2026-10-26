use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::extract::ws::{Message as Frame, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::sync::broadcast;

use crate::api::{
    Channel, Embed, Member, Message, ServerSummaryLite, Settings, UserRef, grant_matches,
};
use crate::db::{ChannelKind, Db, channel_viewable, is_banned, now, setting_on, touch_interaction};
use crate::state::AppState;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallPhase {
    Ringing,
    Active,
    Ended,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallKind {
    Rtc,
    P2p,
}

const P2P_IDS_CAP: usize = 256;

#[derive(Clone, Serialize)]
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
        #[serde(skip)]
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
        #[serde(skip)]
        scope_servers: Vec<String>,
        #[serde(skip)]
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

struct Room {
    server: String,
    users: Vec<(String, u64)>,
    lone_since: i64,
}

impl Room {
    fn touch(&mut self) {
        if self.users.len() == 1 {
            self.lone_since = now();
        }
    }
}

struct Call {
    dm_users: Vec<String>,
    from: String,
    occupants: Vec<(String, u64)>,
    active: bool,
    kind: CallKind,
    log_id: i64,
    lone_since: i64,
}

pub struct CallEnd {
    log_id: i64,
    answered: bool,
    dm_users: Vec<String>,
}

impl CallEnd {
    fn of(call: &Call) -> CallEnd {
        CallEnd {
            log_id: call.log_id,
            answered: call.active,
            dm_users: call.dm_users.clone(),
        }
    }
}

struct P2pHost {
    peer_id: String,
    ids: Vec<String>,
}

pub enum P2pDrop {
    Kept,
    Offline,
    Remaining(String, Vec<String>),
}

#[derive(Default)]
struct VoiceMap {
    rooms: HashMap<i64, Room>,
    calls: HashMap<i64, Call>,
}

fn room_state(channel_id: i64, room: &Room) -> WsEvent {
    WsEvent::VoiceState {
        server: room.server.clone(),
        channel_id,
        users: room.users.iter().map(|(u, _)| u.clone()).collect(),
    }
}

fn call_state(dm_id: i64, call: &Call, state: CallPhase) -> WsEvent {
    WsEvent::CallState {
        dm_id,
        dm_users: call.dm_users.clone(),
        state,
        from: call.from.clone(),
        kind: call.kind,
    }
}

impl VoiceMap {
    fn leave_rooms<F: Fn(&str, &str, u64) -> bool>(&mut self, gone: F, evs: &mut Vec<WsEvent>) {
        for (cid, room) in self.rooms.iter_mut() {
            let Room {
                server,
                users,
                lone_since,
            } = room;
            let before = users.len();
            users.retain(|(u, c)| !gone(server, u, *c));
            if users.len() != before {
                if users.len() == 1 {
                    *lone_since = now();
                }
                evs.push(room_state(*cid, room));
            }
        }
        self.rooms.retain(|_, r| !r.users.is_empty());
    }

    fn end_calls<F: Fn(&Call) -> bool>(&mut self, pred: F, evs: &mut Vec<WsEvent>) -> Vec<CallEnd> {
        let ids: Vec<i64> = self
            .calls
            .iter()
            .filter(|(_, c)| pred(c))
            .map(|(id, _)| *id)
            .collect();
        let mut ends = Vec::new();
        for id in ids {
            if let Some(call) = self.calls.remove(&id) {
                evs.push(call_state(id, &call, CallPhase::Ended));
                ends.push(CallEnd::of(&call));
            }
        }
        ends
    }

    fn in_call(&self, user: &str) -> bool {
        self.calls
            .values()
            .any(|c| c.dm_users.iter().any(|u| u == user))
    }
}

#[derive(Default)]
struct Presence {
    servers: HashMap<String, HashMap<String, HashSet<u64>>>,
    conns: HashMap<u64, String>,
}

impl Presence {
    fn forget(&mut self, viewers: &HashSet<u64>) {
        for conn in viewers {
            self.conns.remove(conn);
        }
    }
}

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<WsEvent>,
    presence: Arc<Mutex<Presence>>,
    voice: Arc<Mutex<VoiceMap>>,
    p2p: Arc<Mutex<HashMap<String, BTreeMap<u64, P2pHost>>>>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Hub {
        Hub {
            tx: broadcast::channel(256).0,
            presence: Arc::new(Mutex::new(Presence::default())),
            voice: Arc::new(Mutex::new(VoiceMap::default())),
            p2p: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WsEvent> {
        self.tx.subscribe()
    }

    pub fn broadcast(&self, ev: WsEvent) {
        let mut extra: Vec<WsEvent> = Vec::new();
        {
            let mut p = self.presence.lock().unwrap();
            match &ev {
                WsEvent::ServerRenamed { old_name, server } => {
                    if let Some(users) = p.servers.remove(old_name) {
                        for conn in users.values().flatten() {
                            p.conns.insert(*conn, server.name.clone());
                        }
                        p.servers.insert(server.name.clone(), users);
                    }
                }
                WsEvent::ServerDeleted { name } => {
                    if let Some(users) = p.servers.remove(name) {
                        for viewers in users.values() {
                            p.forget(viewers);
                        }
                    }
                }
                WsEvent::Banned { username } => {
                    let mut gone = Vec::new();
                    for (server, users) in p.servers.iter_mut() {
                        if let Some(viewers) = users.remove(username) {
                            gone.push(viewers);
                            extra.push(WsEvent::PresenceChanged {
                                server: server.clone(),
                                username: username.clone(),
                                online: false,
                            });
                        }
                    }
                    for viewers in &gone {
                        p.forget(viewers);
                    }
                    p.servers.retain(|_, users| !users.is_empty());
                    self.p2p.lock().unwrap().remove(username);
                }
                _ => {}
            }
        }
        {
            let mut v = self.voice.lock().unwrap();
            match &ev {
                WsEvent::ServerRenamed { old_name, server } => {
                    for room in v.rooms.values_mut() {
                        if room.server == *old_name {
                            room.server = server.name.clone();
                        }
                    }
                }
                WsEvent::ServerDeleted { name } => {
                    v.rooms.retain(|_, r| r.server != *name);
                }
                WsEvent::ChannelDeleted {
                    server: _,
                    channel_id,
                } => {
                    v.rooms.remove(channel_id);
                }
                WsEvent::MemberLeft { server, username }
                | WsEvent::MemberKicked {
                    server,
                    username,
                    banned: _,
                } => {
                    v.leave_rooms(|s, u, _| s == server && u == username, &mut extra);
                }
                WsEvent::Banned { username } => {
                    v.leave_rooms(|_, u, _| u == username, &mut extra);
                    v.end_calls(|c| c.dm_users.iter().any(|u| u == username), &mut extra);
                }
                _ => {}
            }
        }
        let _ = self.tx.send(ev);
        for e in extra {
            let _ = self.tx.send(e);
        }
    }

    fn voice_events(&self, evs: Vec<WsEvent>) {
        for ev in evs {
            self.broadcast(ev);
        }
    }

    pub fn voice_join(&self, user: &str, conn: u64, server: &str, channel_id: i64) -> Vec<CallEnd> {
        let mut evs = Vec::new();
        let ends;
        {
            let mut v = self.voice.lock().unwrap();
            if let Some(room) = v.rooms.get_mut(&channel_id)
                && let Some(slot) = room.users.iter_mut().find(|(u, _)| u == user)
            {
                slot.1 = conn;
                return Vec::new();
            }
            v.leave_rooms(|_, u, _| u == user, &mut evs);
            ends = v.end_calls(|c| c.dm_users.iter().any(|u| u == user), &mut evs);
            let room = v.rooms.entry(channel_id).or_insert_with(|| Room {
                server: server.to_string(),
                users: Vec::new(),
                lone_since: 0,
            });
            room.users.push((user.to_string(), conn));
            room.touch();
            evs.push(room_state(channel_id, room));
        }
        self.voice_events(evs);
        ends
    }

    pub fn voice_leave(&self, user: &str) {
        let mut evs = Vec::new();
        {
            let mut v = self.voice.lock().unwrap();
            v.leave_rooms(|_, u, _| u == user, &mut evs);
        }
        self.voice_events(evs);
    }

    pub fn call_start(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
        dm_users: Vec<String>,
        kind: CallKind,
        log_id: i64,
    ) -> Result<(), String> {
        let mut evs = Vec::new();
        {
            let mut v = self.voice.lock().unwrap();
            if v.in_call(user) {
                return Err("You are already in a call".to_string());
            }
            let other = dm_users.iter().find(|u| *u != user).cloned();
            match &other {
                Some(name) if v.in_call(name) => {
                    return Err(format!("{name} is already in a call"));
                }
                Some(_) => {}
                None => return Err("Cannot call yourself".to_string()),
            }
            v.leave_rooms(|_, u, _| u == user, &mut evs);
            let call = Call {
                dm_users,
                from: user.to_string(),
                occupants: vec![(user.to_string(), conn)],
                active: false,
                kind,
                log_id,
                lone_since: now(),
            };
            evs.push(call_state(dm_id, &call, CallPhase::Ringing));
            v.calls.insert(dm_id, call);
        }
        self.voice_events(evs);
        Ok(())
    }

    pub fn call_accept(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
    ) -> Result<(i64, Vec<String>), String> {
        let mut evs = Vec::new();
        let out;
        {
            let mut v = self.voice.lock().unwrap();
            let valid = v.calls.get(&dm_id).is_some_and(|c| {
                !c.active && c.from != user && c.dm_users.iter().any(|u| u == user)
            });
            if !valid {
                return Err("No incoming call".to_string());
            }
            v.leave_rooms(|_, u, _| u == user, &mut evs);
            let call = v
                .calls
                .get_mut(&dm_id)
                .ok_or_else(|| "No incoming call".to_string())?;
            call.active = true;
            call.occupants.push((user.to_string(), conn));
            evs.push(call_state(dm_id, call, CallPhase::Active));
            out = (call.log_id, call.dm_users.clone());
        }
        self.voice_events(evs);
        Ok(out)
    }

    pub fn call_end(&self, user: &str, dm_id: i64) -> Result<CallEnd, String> {
        let mut evs = Vec::new();
        let end;
        {
            let mut v = self.voice.lock().unwrap();
            let involved = v
                .calls
                .get(&dm_id)
                .is_some_and(|c| c.dm_users.iter().any(|u| u == user));
            if !involved {
                return Err("No such call".to_string());
            }
            let call = v
                .calls
                .remove(&dm_id)
                .ok_or_else(|| "No such call".to_string())?;
            evs.push(call_state(dm_id, &call, CallPhase::Ended));
            end = CallEnd::of(&call);
        }
        self.voice_events(evs);
        Ok(end)
    }

    pub fn rtc_shared(
        &self,
        a: &str,
        b: &str,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
    ) -> bool {
        let v = self.voice.lock().unwrap();
        let both = |users: &[(String, u64)]| {
            users.iter().any(|(u, _)| u == a) && users.iter().any(|(u, _)| u == b)
        };
        match (channel_id, dm_id) {
            (Some(cid), None) => v.rooms.get(&cid).is_some_and(|r| both(&r.users)),
            (None, Some(id)) => v
                .calls
                .get(&id)
                .is_some_and(|c| c.active && c.kind == CallKind::Rtc && both(&c.occupants)),
            (_, _) => false,
        }
    }

    pub fn drop_conn(&self, user: &str, conn: u64) -> Vec<CallEnd> {
        let mut evs = Vec::new();
        let ends;
        {
            let mut v = self.voice.lock().unwrap();
            v.leave_rooms(|_, u, c| u == user && c == conn, &mut evs);
            ends = v.end_calls(
                |c| c.occupants.iter().any(|(u, cn)| u == user && *cn == conn),
                &mut evs,
            );
        }
        self.voice_events(evs);
        ends
    }

    pub fn sweep_voice(&self, idle: i64) -> Vec<CallEnd> {
        let mut evs = Vec::new();
        let mut ends = Vec::new();
        {
            let mut v = self.voice.lock().unwrap();
            let t = now();
            let lone = |len: usize, since: i64| len == 1 && t - since >= idle;
            let cids: Vec<i64> = v
                .rooms
                .iter()
                .filter(|(_, r)| lone(r.users.len(), r.lone_since))
                .map(|(id, _)| *id)
                .collect();
            for cid in cids {
                if let Some(room) = v.rooms.remove(&cid) {
                    evs.push(WsEvent::VoiceState {
                        server: room.server.clone(),
                        channel_id: cid,
                        users: Vec::new(),
                    });
                    evs.push(WsEvent::VoiceEnded {
                        server: Some(room.server),
                        channel_id: Some(cid),
                        dm_id: None,
                        dm_users: None,
                        reason: format!("Voice ended after {idle}s alone"),
                    });
                }
            }
            let ids: Vec<i64> = v
                .calls
                .iter()
                .filter(|(_, c)| lone(c.occupants.len(), c.lone_since))
                .map(|(id, _)| *id)
                .collect();
            for id in ids {
                if let Some(call) = v.calls.remove(&id) {
                    ends.push(CallEnd::of(&call));
                    evs.push(call_state(id, &call, CallPhase::Ended));
                    evs.push(WsEvent::VoiceEnded {
                        server: None,
                        channel_id: None,
                        dm_id: Some(id),
                        dm_users: Some(call.dm_users),
                        reason: format!("Call ended after {idle}s with one participant"),
                    });
                }
            }
        }
        self.voice_events(evs);
        ends
    }

    pub fn set_p2p(&self, user: &str, conn: u64, peer_id: String, ids: Vec<String>) {
        self.p2p
            .lock()
            .unwrap()
            .entry(user.to_string())
            .or_default()
            .insert(conn, P2pHost { peer_id, ids });
    }

    pub fn p2p_of(&self, user: &str) -> Option<(String, Vec<String>)> {
        self.p2p
            .lock()
            .unwrap()
            .get(user)
            .and_then(|hosts| hosts.last_key_value())
            .map(|(_, h)| (h.peer_id.clone(), h.ids.clone()))
    }

    pub fn clear_p2p(&self, user: &str, conn: u64) -> P2pDrop {
        let mut p = self.p2p.lock().unwrap();
        let hosts = match p.get_mut(user) {
            Some(hosts) => hosts,
            None => return P2pDrop::Kept,
        };
        if hosts.remove(&conn).is_none() {
            return P2pDrop::Kept;
        }
        match hosts.last_key_value() {
            Some((_, h)) => P2pDrop::Remaining(h.peer_id.clone(), h.ids.clone()),
            None => {
                p.remove(user);
                P2pDrop::Offline
            }
        }
    }

    pub fn online_set(&self, server: &str) -> HashSet<String> {
        match self.presence.lock().unwrap().servers.get(server) {
            Some(users) => users.keys().cloned().collect(),
            None => HashSet::new(),
        }
    }

    pub fn online_count(&self, server: &str) -> i64 {
        self.presence
            .lock()
            .unwrap()
            .servers
            .get(server)
            .map_or(0, |users| users.len() as i64)
    }

    pub fn is_online(&self, server: &str, username: &str) -> bool {
        self.presence
            .lock()
            .unwrap()
            .servers
            .get(server)
            .is_some_and(|users| users.contains_key(username))
    }

    pub fn set_viewing(&self, conn: u64, user: &str, new: Option<&str>) {
        let mut deltas = Vec::new();
        {
            let mut p = self.presence.lock().unwrap();
            let Presence { servers, conns } = &mut *p;
            if conns.get(&conn).map(String::as_str) == new {
                return;
            }
            if let Some(old) = conns.remove(&conn)
                && let Some(users) = servers.get_mut(&old)
                && let Some(viewers) = users.get_mut(user)
                && viewers.remove(&conn)
                && viewers.is_empty()
            {
                users.remove(user);
                if users.is_empty() {
                    servers.remove(&old);
                }
                deltas.push((old, false));
            }
            if let Some(s) = new {
                let viewers = servers
                    .entry(s.to_string())
                    .or_default()
                    .entry(user.to_string())
                    .or_default();
                viewers.insert(conn);
                if viewers.len() == 1 {
                    deltas.push((s.to_string(), true));
                }
                conns.insert(conn, s.to_string());
            }
        }
        for (server, online) in deltas {
            self.broadcast(WsEvent::PresenceChanged {
                server,
                username: user.to_string(),
                online,
            });
        }
    }

    pub fn force_offline(&self, server: &str, user: &str) {
        let removed = {
            let mut p = self.presence.lock().unwrap();
            let gone = p.servers.get_mut(server).and_then(|users| {
                let gone = users.remove(user);
                gone.map(|viewers| (viewers, users.is_empty()))
            });
            match gone {
                Some((viewers, empty)) => {
                    p.forget(&viewers);
                    if empty {
                        p.servers.remove(server);
                    }
                    true
                }
                None => false,
            }
        };
        if removed {
            self.broadcast(WsEvent::PresenceChanged {
                server: server.to_string(),
                username: user.to_string(),
                online: false,
            });
        }
    }

    pub fn rooms_in(&self, server: &str, channel_id: Option<i64>) -> Vec<(i64, Vec<String>)> {
        self.voice
            .lock()
            .unwrap()
            .rooms
            .iter()
            .filter(|(cid, room)| room.server == server && channel_id.is_none_or(|c| c == **cid))
            .map(|(cid, room)| (*cid, room.users.iter().map(|(u, _)| u.clone()).collect()))
            .collect()
    }

    pub fn evict_voice(&self, user: &str, channel_id: i64) {
        let mut evs = Vec::new();
        {
            let mut v = self.voice.lock().unwrap();
            let hit = match v.rooms.get_mut(&channel_id) {
                Some(room) => {
                    let before = room.users.len();
                    room.users.retain(|(u, _)| u != user);
                    match room.users.len() != before {
                        true => {
                            room.touch();
                            evs.push(room_state(channel_id, room));
                            true
                        }
                        false => false,
                    }
                }
                None => false,
            };
            if hit {
                v.rooms.retain(|_, r| !r.users.is_empty());
                evs.push(WsEvent::VoiceEnded {
                    server: None,
                    channel_id: Some(channel_id),
                    dm_id: None,
                    dm_users: Some(vec![user.to_string()]),
                    reason: "You no longer have access to this voice channel".to_string(),
                });
            }
        }
        self.voice_events(evs);
    }

    pub fn voice_snapshot(&self) -> Vec<WsEvent> {
        let v = self.voice.lock().unwrap();
        let mut evs: Vec<WsEvent> = v
            .rooms
            .iter()
            .map(|(cid, room)| room_state(*cid, room))
            .collect();
        for (id, call) in v.calls.iter() {
            let phase = match call.active {
                true => CallPhase::Active,
                false => CallPhase::Ringing,
            };
            evs.push(call_state(*id, call, phase));
        }
        evs
    }
}

pub(crate) async fn evict_unviewable(state: &AppState, server: &str, channel_id: Option<i64>) {
    for (cid, users) in state.hub.rooms_in(server, channel_id) {
        for user in users {
            if !channel_viewable(&state.db, server, cid, Some(&user)).await {
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
    if let Ok(Some(message)) = crate::api::messages::load_message(&state.db, log_id).await {
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
    if let Ok(Some(message)) = crate::api::messages::load_message(&state.db, log_id).await {
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
    for end in state.hub.sweep_voice(idle) {
        finalize_call_log(state, end, false).await;
    }
}

#[utoipa::path(get, path = "/api/ws", responses((status = 101, description = "WebSocket upgrade")))]
pub async fn handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| run(state, socket))
}

static CONN_SEQ: AtomicU64 = AtomicU64::new(0);

async fn voice_msg(state: &AppState, user: &str, conn: u64, msg: ClientMsg) -> Result<(), String> {
    let db_err = |e: sqlx::Error| e.to_string();
    match msg {
        ClientMsg::VoiceJoin { channel_id } => {
            let row = sqlx::query("SELECT server, kind FROM channels WHERE id = $1")
                .bind(channel_id)
                .fetch_optional(&state.db)
                .await
                .map_err(db_err)?
                .ok_or_else(|| "Channel not found".to_string())?;
            let server: String = row.try_get(0).map_err(db_err)?;
            let kind = ChannelKind::parse(&row.try_get::<String, _>(1).map_err(db_err)?)
                .map_err(db_err)?;
            if kind != ChannelKind::Voice {
                return Err("Not a voice channel".to_string());
            }
            if is_banned(&state.db, &server, user).await.map_err(db_err)? {
                return Err("You are banned from this server".to_string());
            }
            if !channel_viewable(&state.db, &server, channel_id, Some(user)).await {
                return Err("Not allowed".to_string());
            }
            for end in state.hub.voice_join(user, conn, &server, channel_id) {
                finalize_call_log(state, end, false).await;
            }
            touch_interaction(&state.db, &server, user)
                .await
                .map_err(db_err)
        }
        ClientMsg::VoiceLeave => {
            state.hub.voice_leave(user);
            Ok(())
        }
        ClientMsg::CallStart { dm_id, p2p } => {
            let row = sqlx::query("SELECT user_a, user_b FROM dms WHERE id = $1")
                .bind(dm_id)
                .fetch_optional(&state.db)
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
            let (log_id, dm_users) = state.hub.call_accept(user, conn, dm_id)?;
            answer_call_log(state, dm_users, log_id).await;
            Ok(())
        }
        ClientMsg::CallDecline { dm_id } => {
            let end = state.hub.call_end(user, dm_id)?;
            finalize_call_log(state, end, true).await;
            Ok(())
        }
        ClientMsg::CallLeave { dm_id } => {
            let end = state.hub.call_end(user, dm_id)?;
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

async fn p2p_scope(db: &Db, user: &str) -> (Vec<String>, Vec<String>) {
    let servers = sqlx::query("SELECT server FROM members WHERE username = $1")
        .bind(user)
        .fetch_all(db)
        .await
        .map(|rows| rows.iter().filter_map(|r| r.try_get(0).ok()).collect())
        .unwrap_or_default();
    let users = sqlx::query("SELECT user_a, user_b FROM dms WHERE user_a = $1 OR user_b = $1")
        .bind(user)
        .fetch_all(db)
        .await
        .map(|rows| {
            rows.iter()
                .flat_map(|r| [r.try_get(0).ok(), r.try_get(1).ok()])
                .flatten()
                .collect()
        })
        .unwrap_or_default();
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

async fn server_password_hash(db: &Db, server: &str) -> Option<Option<String>> {
    sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .map(|r| r.try_get(0).unwrap_or(None))
}

async fn is_member(db: &Db, server: &str, user: &str) -> bool {
    sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
        .bind(server)
        .bind(user)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .is_some()
}

async fn guest_sub_ok(db: &Db, server: &str, grant: Option<&str>) -> bool {
    match (server_password_hash(db, server).await, grant) {
        (None, _) => false,
        (Some(None), _) => true,
        (Some(Some(_)), Some(grant)) => grant_matches(db, grant, server).await.unwrap_or(false),
        (Some(Some(_)), None) => false,
    }
}

async fn recheck_guest_subs(
    db: &Db,
    subs: &mut HashSet<String>,
    grants: &mut HashMap<String, String>,
) {
    let mut kept = HashSet::new();
    for server in subs.drain() {
        if guest_sub_ok(db, &server, grants.get(&server).map(String::as_str)).await {
            kept.insert(server);
        } else {
            grants.remove(&server);
        }
    }
    *subs = kept;
}

async fn authed_sub_ok(db: &Db, server: &str, user: &str, site_admin: bool) -> bool {
    match server_password_hash(db, server).await {
        None => false,
        Some(None) => true,
        Some(Some(_)) => site_admin || is_member(db, server, user).await,
    }
}

async fn member_servers_of(db: &Db, user: &str) -> HashSet<String> {
    sqlx::query("SELECT server FROM members WHERE username = $1")
        .bind(user)
        .fetch_all(db)
        .await
        .map(|rows| rows.iter().filter_map(|r| r.try_get(0).ok()).collect())
        .unwrap_or_default()
}

async fn channel_gate(
    state: &AppState,
    viewable: &mut HashMap<i64, bool>,
    username: Option<&str>,
    server: &str,
    cid: i64,
) -> bool {
    match viewable.get(&cid) {
        Some(v) => *v,
        None => {
            let v = channel_viewable(&state.db, server, cid, username).await;
            viewable.insert(cid, v);
            v
        }
    }
}

async fn send_voice_snapshot(
    state: &AppState,
    socket: &mut WebSocket,
    username: Option<&str>,
    is_site_admin: bool,
    member_servers: &HashSet<String>,
    subs: &HashSet<String>,
    viewable: &mut HashMap<i64, bool>,
) -> bool {
    for ev in state.hub.voice_snapshot() {
        if !wants(&ev, username, is_site_admin, member_servers, subs) {
            continue;
        }
        if let Some((server, cid)) = event_channel(&ev)
            && !channel_gate(state, viewable, username, server, cid).await
        {
            continue;
        }
        if let Ok(json) = serde_json::to_string(&ev)
            && socket.send(Frame::Text(json.into())).await.is_err()
        {
            return false;
        }
    }
    true
}

struct ConnPresence {
    conn: u64,
    viewing: Option<String>,
    hidden: bool,
}

impl ConnPresence {
    fn sync(&self, hub: &Hub, user: &str) {
        let target = match self.hidden {
            true => None,
            false => self.viewing.as_deref(),
        };
        hub.set_viewing(self.conn, user, target);
    }

    fn view(&mut self, hub: &Hub, user: &str, target: Option<String>) {
        self.viewing = target;
        self.sync(hub, user);
    }

    fn set_hidden(&mut self, hub: &Hub, user: &str, hidden: bool) {
        self.hidden = hidden;
        self.sync(hub, user);
    }

    fn resync(&mut self, hub: &Hub, user: &str, hidden: bool, member_servers: &HashSet<String>) {
        self.viewing = self.viewing.take().filter(|s| member_servers.contains(s));
        self.set_hidden(hub, user, hidden);
    }

    fn leave(&self, hub: &Hub, user: &str) {
        hub.set_viewing(self.conn, user, None);
    }
}

async fn run(state: AppState, mut socket: WebSocket) {
    let conn = CONN_SEQ.fetch_add(1, Ordering::Relaxed);
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
    let mut rx = state.hub.subscribe();
    let (username, is_site_admin, hidden): (Option<String>, bool, bool) = match token {
        Some(token) => {
            let row = sqlx::query(
                "SELECT u.username, u.is_site_admin, u.appear_offline FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1",
            )
            .bind(token)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
            match &row {
                Some(r) => (
                    r.try_get(0).ok(),
                    r.try_get::<i64, _>(1).map(|v| v != 0).unwrap_or(false),
                    r.try_get::<i64, _>(2).map(|v| v != 0).unwrap_or(false),
                ),
                None => (None, false, false),
            }
        }
        None => (None, false, false),
    };
    let mut member_servers: HashSet<String> = match &username {
        Some(user) => member_servers_of(&state.db, user).await,
        None => HashSet::new(),
    };
    if username.is_none() && !setting_on(&state.db, "guests_enabled").await {
        return;
    }
    let mut subs: HashSet<String> = HashSet::new();
    let mut guest_grants: HashMap<String, String> = HashMap::new();
    let mut presence = ConnPresence {
        conn,
        viewing: None,
        hidden,
    };
    let mut viewable: HashMap<i64, bool> = HashMap::new();
    if !send_voice_snapshot(
        &state,
        &mut socket,
        username.as_deref(),
        is_site_admin,
        &member_servers,
        &subs,
        &mut viewable,
    )
    .await
    {
        return;
    }
    loop {
        tokio::select! {
            ev = rx.recv() => {
                let ev = match ev {
                    Ok(ev) => ev,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        viewable.clear();
                        match &username {
                            Some(user) => {
                                let row = sqlx::query("SELECT appear_offline FROM users WHERE username = $1")
                                    .bind(user)
                                    .fetch_optional(&state.db)
                                    .await
                                    .ok()
                                    .flatten();
                                let hidden = match row {
                                    Some(r) => r.try_get::<i64, _>(0).map(|v| v != 0).unwrap_or(presence.hidden),
                                    None => break,
                                };
                                member_servers = member_servers_of(&state.db, user).await;
                                presence.resync(&state.hub, user, hidden, &member_servers);
                            }
                            None => {
                                if !setting_on(&state.db, "guests_enabled").await {
                                    break;
                                }
                                recheck_guest_subs(&state.db, &mut subs, &mut guest_grants).await;
                            }
                        }
                        if let Ok(json) = serde_json::to_string(&WsEvent::Resync)
                            && socket.send(Frame::Text(json.into())).await.is_err() {
                                break;
                            }
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let mut deliver = wants(&ev, username.as_deref(), is_site_admin, &member_servers, &subs);
                track(&ev, username.as_deref(), &mut member_servers, &mut subs, &mut presence.viewing, &mut viewable);
                if username.is_none() {
                    match &ev {
                        WsEvent::ServerRenamed { old_name, server } => {
                            if let Some(g) = guest_grants.remove(old_name) {
                                guest_grants.insert(server.name.clone(), g);
                            }
                            if server.has_password
                                && subs.contains(&server.name)
                                && !guest_sub_ok(&state.db, &server.name, guest_grants.get(&server.name).map(String::as_str)).await
                            {
                                subs.remove(&server.name);
                                guest_grants.remove(&server.name);
                            }
                        }
                        WsEvent::ServerCreated { server } if server.has_password => {
                            subs.remove(&server.name);
                        }
                        _ => {}
                    }
                }
                if deliver && let Some((server, cid)) = event_channel(&ev) {
                    deliver = channel_gate(&state, &mut viewable, username.as_deref(), server, cid).await;
                }
                if deliver
                    && let Ok(json) = serde_json::to_string(&ev)
                        && socket.send(Frame::Text(json.into())).await.is_err() {
                            break;
                        }
                match &ev {
                    WsEvent::Banned { username: banned } if Some(banned.as_str()) == username.as_deref() => break,
                    WsEvent::SettingsChanged { settings } if username.is_none() && !settings.guests_enabled => break,
                    WsEvent::PresenceMode { username: user, appear_offline } if Some(user.as_str()) == username.as_deref() => {
                        presence.set_hidden(&state.hub, user, *appear_offline);
                    }
                    _ => {}
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Frame::Text(text))) => match serde_json::from_str::<ClientMsg>(&text) {
                        Ok(ClientMsg::Viewing { server }) => {
                            let target = match (&username, server) {
                                (Some(user), Some(s)) => {
                                    let s = s.to_lowercase();
                                    is_member(&state.db, &s, user).await.then_some(s)
                                }
                                (_, _) => None,
                            };
                            if let Some(user) = &username {
                                presence.view(&state.hub, user, target);
                            }
                        }
                        Ok(ClientMsg::Subscribe { servers, grants }) => {
                            subs.clear();
                            guest_grants.clear();
                            for s in servers {
                                let s = s.to_lowercase();
                                let grant = grants.get(&s).cloned();
                                let allowed = match &username {
                                    Some(user) => authed_sub_ok(&state.db, &s, user, is_site_admin).await,
                                    None => guest_sub_ok(&state.db, &s, grant.as_deref()).await,
                                };
                                if allowed {
                                    if let Some(g) = grant {
                                        guest_grants.insert(s.clone(), g);
                                    }
                                    subs.insert(s);
                                }
                            }
                            if !send_voice_snapshot(&state, &mut socket, username.as_deref(), is_site_admin, &member_servers, &subs, &mut viewable).await {
                                break;
                            }
                        }
                        Ok(ClientMsg::P2pHosting { peer_id, ids }) => {
                            if let Some(user) = &username {
                                let ids: Vec<String> = ids.into_iter().take(P2P_IDS_CAP).collect();
                                state.hub.set_p2p(user, conn, peer_id.clone(), ids.clone());
                                let (scope_servers, scope_users) = p2p_scope(&state.db, user).await;
                                state.hub.broadcast(WsEvent::P2pAvailability {
                                    hoster: user.clone(),
                                    peer_id: Some(peer_id),
                                    ids,
                                    online: true,
                                    scope_servers,
                                    scope_users,
                                });
                            }
                        }
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
                                if let Ok(json) = serde_json::to_string(&ev)
                                    && socket.send(Frame::Text(json.into())).await.is_err() {
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
                            let res = match &username {
                                Some(user) => voice_msg(&state, user, conn, other).await,
                                None => Err("Create an account to join voice".to_string()),
                            };
                            if let Err(message) = res
                                && let Ok(json) = serde_json::to_string(&WsEvent::Error { message })
                                    && socket.send(Frame::Text(json.into())).await.is_err() {
                                        break;
                                    }
                        }
                    },
                    Some(Ok(Frame::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    if let Some(user) = &username {
        for end in state.hub.drop_conn(user, conn) {
            finalize_call_log(&state, end, false).await;
        }
        match state.hub.clear_p2p(user, conn) {
            P2pDrop::Kept => {}
            P2pDrop::Offline => {
                let (scope_servers, scope_users) = p2p_scope(&state.db, user).await;
                state
                    .hub
                    .broadcast(p2p_offline(user.clone(), scope_servers, scope_users));
            }
            P2pDrop::Remaining(peer_id, ids) => {
                let (scope_servers, scope_users) = p2p_scope(&state.db, user).await;
                state.hub.broadcast(WsEvent::P2pAvailability {
                    hoster: user.clone(),
                    peer_id: Some(peer_id),
                    ids,
                    online: true,
                    scope_servers,
                    scope_users,
                });
            }
        }
        presence.leave(&state.hub, user);
    }
}

fn track(
    ev: &WsEvent,
    me: Option<&str>,
    member_servers: &mut HashSet<String>,
    subs: &mut HashSet<String>,
    viewing: &mut Option<String>,
    viewable: &mut HashMap<i64, bool>,
) {
    match ev {
        WsEvent::MemberJoined { server, member } => {
            if Some(member.user.username.as_str()) == me {
                member_servers.insert(server.clone());
                viewable.clear();
            }
        }
        WsEvent::MemberLeft { server, username }
        | WsEvent::MemberKicked {
            server,
            username,
            banned: _,
        } => {
            if Some(username.as_str()) == me {
                member_servers.remove(server);
                viewable.clear();
                if viewing.as_deref() == Some(server.as_str()) {
                    *viewing = None;
                }
            }
        }
        WsEvent::ServerCreated { server } => {
            if server.creator.as_deref() == me {
                member_servers.insert(server.name.clone());
                viewable.clear();
            }
        }
        WsEvent::AdminChanged {
            server: _,
            username,
            is_admin: _,
            perms: _,
        } => {
            if Some(username.as_str()) == me {
                viewable.clear();
            }
        }
        WsEvent::RolesChanged { server: _ } => viewable.clear(),
        WsEvent::ChannelPermsChanged {
            server: _,
            channel_id,
        }
        | WsEvent::ChannelDeleted {
            server: _,
            channel_id,
        } => {
            viewable.remove(channel_id);
        }
        WsEvent::ServerRenamed { old_name, server } => {
            if member_servers.remove(old_name) {
                member_servers.insert(server.name.clone());
            }
            if subs.remove(old_name) {
                subs.insert(server.name.clone());
            }
            if viewing.as_deref() == Some(old_name.as_str()) {
                *viewing = Some(server.name.clone());
            }
        }
        WsEvent::ServerDeleted { name } => {
            member_servers.remove(name);
            subs.remove(name);
            if viewing.as_deref() == Some(name.as_str()) {
                *viewing = None;
            }
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
        WsEvent::UserUpdated { user: _ } | WsEvent::UserRegistered { user: _ } => true,
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
        WsEvent::ServerCreated { server } => is_site_admin || server.creator.as_deref() == me,
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
        WsEvent::Error { message: _ } | WsEvent::Resync => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
                .expect("server");
        }
        sqlx::query(
            "INSERT INTO guest_grants(\"grant\", server, created_at) VALUES('g2', 'kept', 0)",
        )
        .execute(db)
        .await
        .expect("grant");
        let mut subs: HashSet<String> = ["open", "locked", "kept", "gone"].map(String::from).into();
        let mut grants: HashMap<String, String> = [("locked", "g1"), ("kept", "g2")]
            .map(|(s, g)| (s.to_string(), g.to_string()))
            .into();
        recheck_guest_subs(db, &mut subs, &mut grants).await;
        let mut left: Vec<_> = subs.into_iter().collect();
        left.sort();
        assert_eq!(left, ["kept", "open"]);
        assert_eq!(grants.keys().collect::<Vec<_>>(), ["kept"]);
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

    #[tokio::test]
    async fn banned_user_cannot_join_voice() {
        let (state, path) = crate::api::test_util::temp_state("ban_voice").await;
        let cid: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id")
            .fetch_one(&state.db)
            .await
            .expect("voice channel")
            .try_get(0)
            .expect("channel id");
        sqlx::query("INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('rchat', 'bob', 'alice', 0)")
            .execute(&state.db)
            .await
            .expect("ban");
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

    #[test]
    fn appear_offline_suppresses_and_restores_presence() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        let conn = |conn, hidden| ConnPresence {
            conn,
            viewing: None,
            hidden,
        };
        let (mut a, mut b) = (conn(1, false), conn(2, false));
        a.view(&hub, "alice", Some("rchat".to_string()));
        b.view(&hub, "alice", Some("rchat".to_string()));
        assert!(hub.is_online("rchat", "alice"));
        assert_eq!(hub.online_count("rchat"), 1);
        assert_eq!(presence_events(&mut rx), vec![("rchat".to_string(), true)]);
        a.set_hidden(&hub, "alice", true);
        assert!(hub.is_online("rchat", "alice"));
        b.set_hidden(&hub, "alice", true);
        assert!(!hub.is_online("rchat", "alice"));
        assert_eq!(hub.online_count("rchat"), 0);
        assert!(hub.online_set("rchat").is_empty());
        assert_eq!(presence_events(&mut rx), vec![("rchat".to_string(), false)]);
        let mut c = conn(3, true);
        c.view(&hub, "alice", Some("rchat".to_string()));
        a.view(&hub, "alice", Some("other".to_string()));
        b.set_hidden(&hub, "alice", true);
        assert!(!hub.is_online("rchat", "alice"));
        assert!(!hub.is_online("other", "alice"));
        assert!(presence_events(&mut rx).is_empty());
        a.set_hidden(&hub, "alice", false);
        assert!(hub.is_online("other", "alice"));
        assert!(!hub.is_online("rchat", "alice"));
        c.set_hidden(&hub, "alice", false);
        b.set_hidden(&hub, "alice", false);
        assert!(hub.is_online("rchat", "alice"));
        assert_eq!(hub.online_count("rchat"), 1);
        assert_eq!(
            presence_events(&mut rx),
            vec![("other".to_string(), true), ("rchat".to_string(), true)]
        );
        a.set_hidden(&hub, "alice", true);
        a.leave(&hub, "alice");
        c.leave(&hub, "alice");
        assert!(hub.is_online("rchat", "alice"));
        b.leave(&hub, "alice");
        assert!(!hub.is_online("rchat", "alice"));
        assert!(!hub.is_online("other", "alice"));
        assert_eq!(
            presence_events(&mut rx),
            vec![("other".to_string(), false), ("rchat".to_string(), false)]
        );
    }

    fn rename(hub: &Hub, old_name: &str, name: &str) {
        hub.broadcast(WsEvent::ServerRenamed {
            old_name: old_name.to_string(),
            server: ServerSummaryLite {
                name: name.to_string(),
                display_name: name.to_string(),
                creator: None,
                has_password: false,
            },
        });
    }

    fn servers(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn lagged_rename_drops_stale_presence() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        let mut a = ConnPresence {
            conn: 1,
            viewing: None,
            hidden: false,
        };
        a.view(&hub, "alice", Some("rchat".to_string()));
        rename(&hub, "rchat", "chat");
        assert!(hub.is_online("chat", "alice"));
        let _ = presence_events(&mut rx);
        a.resync(&hub, "alice", true, &servers(&["chat"]));
        assert_eq!(a.viewing, None);
        assert!(!hub.is_online("chat", "alice"));
        assert_eq!(presence_events(&mut rx), vec![("chat".to_string(), false)]);
        a.set_hidden(&hub, "alice", false);
        a.leave(&hub, "alice");
        assert!(presence_events(&mut rx).is_empty());
        let p = hub.presence.lock().unwrap();
        assert!(p.servers.is_empty());
        assert!(p.conns.is_empty());
    }

    #[test]
    fn lagged_resync_keeps_valid_presence() {
        let hub = Hub::new();
        let mut a = ConnPresence {
            conn: 1,
            viewing: None,
            hidden: false,
        };
        a.view(&hub, "alice", Some("rchat".to_string()));
        rename(&hub, "rchat", "chat");
        a.viewing = Some("chat".to_string());
        a.resync(&hub, "alice", false, &servers(&["chat"]));
        assert!(hub.is_online("chat", "alice"));
        a.resync(&hub, "alice", true, &servers(&["chat"]));
        assert!(!hub.is_online("chat", "alice"));
        a.resync(&hub, "alice", false, &servers(&["chat"]));
        assert!(hub.is_online("chat", "alice"));
        a.leave(&hub, "alice");
        assert!(!hub.is_online("chat", "alice"));
        assert!(hub.presence.lock().unwrap().servers.is_empty());
    }

    #[test]
    fn leave_after_lagged_rename_removes_presence() {
        let hub = Hub::new();
        let mut a = ConnPresence {
            conn: 1,
            viewing: None,
            hidden: false,
        };
        a.view(&hub, "alice", Some("rchat".to_string()));
        rename(&hub, "rchat", "chat");
        a.leave(&hub, "alice");
        assert!(!hub.is_online("chat", "alice"));
        assert!(hub.presence.lock().unwrap().servers.is_empty());
    }

    #[test]
    fn force_offline_does_not_steal_other_connections() {
        let hub = Hub::new();
        let conn = |conn| ConnPresence {
            conn,
            viewing: None,
            hidden: false,
        };
        let (mut a, mut b) = (conn(1), conn(2));
        a.view(&hub, "alice", Some("rchat".to_string()));
        hub.force_offline("rchat", "alice");
        assert!(!hub.is_online("rchat", "alice"));
        b.view(&hub, "alice", Some("rchat".to_string()));
        a.view(&hub, "alice", None);
        assert!(hub.is_online("rchat", "alice"));
        a.view(&hub, "alice", Some("rchat".to_string()));
        b.leave(&hub, "alice");
        assert!(hub.is_online("rchat", "alice"));
        let mut rx = hub.subscribe();
        hub.broadcast(WsEvent::Banned {
            username: "alice".to_string(),
        });
        assert!(!hub.is_online("rchat", "alice"));
        a.leave(&hub, "alice");
        assert_eq!(presence_events(&mut rx), vec![("rchat".to_string(), false)]);
        let p = hub.presence.lock().unwrap();
        assert!(p.servers.is_empty());
        assert!(p.conns.is_empty());
    }

    #[test]
    fn presence_mode_reaches_only_its_user() {
        let ev = WsEvent::PresenceMode {
            username: "alice".to_string(),
            appear_offline: true,
        };
        let none = HashSet::new();
        assert!(wants(&ev, Some("alice"), false, &none, &none));
        assert!(!wants(&ev, Some("bob"), true, &none, &none));
        assert!(!wants(&ev, None, false, &none, &none));
    }
}
