use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tracing::warn;

use crate::ws::{CallKind, CallPhase, WsEvent};

pub const DEAD_AFTER_MS: i64 = 30_000;
const GAPS_KEPT: usize = 32;

pub fn owner(conn: u64) -> u32 {
    (conn >> 32) as u32
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn stream_pos(id: &str) -> (u64, u64) {
    let (ms, seq) = id.split_once('-').unwrap_or((id, "0"));
    (ms.parse().unwrap_or(0), seq.parse().unwrap_or(0))
}

#[derive(Clone, Serialize, Deserialize)]
struct Room {
    server: String,
    users: Vec<(String, u64)>,
    lone_since: i64,
}

impl Room {
    fn touch(&mut self, t: i64) {
        if self.users.len() == 1 {
            self.lone_since = t;
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
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
    pub(crate) log_id: i64,
    pub(crate) answered: bool,
    pub(crate) dm_users: Vec<String>,
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

#[derive(Clone, Serialize, Deserialize)]
struct P2pHost {
    peer_id: String,
    ids: Vec<String>,
}

pub enum P2pDrop {
    Kept,
    Offline,
    Remaining(String, Vec<String>),
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Peer {
    seen: i64,
    seq: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    gaps: Vec<(u64, u64)>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Replica {
    presence: BTreeMap<String, BTreeMap<String, BTreeSet<u64>>>,
    rooms: BTreeMap<i64, Room>,
    calls: BTreeMap<i64, Call>,
    p2p: BTreeMap<String, BTreeMap<u64, P2pHost>>,
    peers: BTreeMap<u32, Peer>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Broadcast {
        event: WsEvent,
    },
    Viewing {
        user: String,
        conn: u64,
        old: Option<String>,
        new: Option<String>,
    },
    Present {
        user: String,
        conn: u64,
        server: Option<String>,
    },
    ForceOffline {
        server: String,
        user: String,
    },
    VoiceJoin {
        user: String,
        conn: u64,
        server: String,
        channel_id: i64,
    },
    VoiceLeave {
        user: String,
    },
    CallStart {
        user: String,
        conn: u64,
        dm_id: i64,
        dm_users: Vec<String>,
        kind: CallKind,
        log_id: i64,
    },
    CallAccept {
        user: String,
        conn: u64,
        dm_id: i64,
    },
    CallEnd {
        user: String,
        dm_id: i64,
    },
    DropConn {
        user: String,
        conn: u64,
    },
    SweepVoice {
        idle: i64,
    },
    SetP2p {
        user: String,
        conn: u64,
        peer_id: String,
        ids: Vec<String>,
    },
    EvictVoice {
        user: String,
        channel_id: i64,
    },
    Heartbeat,
    Depart,
}

impl Op {
    fn repostable(&self) -> bool {
        match self {
            Op::Broadcast { event: _ }
            | Op::ForceOffline { server: _, user: _ }
            | Op::EvictVoice {
                user: _,
                channel_id: _,
            } => true,
            Op::Viewing {
                user: _,
                conn: _,
                old: _,
                new: _,
            }
            | Op::Present {
                user: _,
                conn: _,
                server: _,
            }
            | Op::SetP2p {
                user: _,
                conn: _,
                peer_id: _,
                ids: _,
            }
            | Op::Heartbeat
            | Op::VoiceJoin {
                user: _,
                conn: _,
                server: _,
                channel_id: _,
            }
            | Op::VoiceLeave { user: _ }
            | Op::CallStart {
                user: _,
                conn: _,
                dm_id: _,
                dm_users: _,
                kind: _,
                log_id: _,
            }
            | Op::CallAccept {
                user: _,
                conn: _,
                dm_id: _,
            }
            | Op::CallEnd { user: _, dm_id: _ }
            | Op::DropConn { user: _, conn: _ }
            | Op::SweepVoice { idle: _ }
            | Op::Depart => false,
        }
    }

    fn hoster(&self) -> Option<&str> {
        match self {
            Op::Broadcast {
                event:
                    WsEvent::P2pAvailability {
                        hoster,
                        peer_id: _,
                        ids: _,
                        online: _,
                        scope_servers: _,
                        scope_users: _,
                    },
            } => Some(hoster),
            _ => None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub origin: u32,
    pub seq: u64,
    pub op: Op,
}

#[derive(Default)]
pub struct Purge {
    pub(crate) ends: Vec<CallEnd>,
    pub(crate) p2p: Vec<(String, P2pDrop)>,
}

impl Purge {
    pub fn is_empty(&self) -> bool {
        self.ends.is_empty() && self.p2p.is_empty()
    }
}

pub enum Aftermath {
    Settle(Purge),
    Repost(Vec<Op>),
}

pub enum Outcome {
    Done,
    Lost,
    Ends(Vec<CallEnd>),
    Started(Result<(), String>),
    Accepted(Result<(i64, Vec<String>), String>),
    Ended(Result<CallEnd, String>),
    Dropped(Vec<CallEnd>, P2pDrop),
    Departed(Purge),
}

pub struct Applied {
    pub events: Vec<WsEvent>,
    pub outcome: Outcome,
    pub purge: Purge,
    pub purged: Vec<u32>,
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

fn presence_ev(server: &str, username: &str, online: bool) -> WsEvent {
    WsEvent::PresenceChanged {
        server: server.to_string(),
        username: username.to_string(),
        online,
    }
}

impl Replica {
    fn leave_rooms<F: Fn(&str, &str, u64) -> bool>(
        &mut self,
        gone: F,
        t: i64,
        evs: &mut Vec<WsEvent>,
    ) {
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
                    *lone_since = t;
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

    fn unview(&mut self, server: &str, user: &str, conn: u64, evs: &mut Vec<WsEvent>) {
        if let Some(users) = self.presence.get_mut(server) {
            let emptied = users
                .get_mut(user)
                .is_some_and(|conns| conns.remove(&conn) && conns.is_empty());
            if emptied {
                users.remove(user);
                evs.push(presence_ev(server, user, false));
            }
            if users.is_empty() {
                self.presence.remove(server);
            }
        }
    }

    fn view(&mut self, server: &str, user: &str, conn: u64, evs: &mut Vec<WsEvent>) {
        let conns = self
            .presence
            .entry(server.to_string())
            .or_default()
            .entry(user.to_string())
            .or_default();
        let fresh = conns.is_empty();
        conns.insert(conn);
        if fresh {
            evs.push(presence_ev(server, user, true));
        }
    }

    fn present(&mut self, user: &str, conn: u64, server: Option<&str>, evs: &mut Vec<WsEvent>) {
        let stale: Vec<String> = self
            .presence
            .iter()
            .filter(|(s, users)| {
                Some(s.as_str()) != server && users.get(user).is_some_and(|c| c.contains(&conn))
            })
            .map(|(s, _)| s.clone())
            .collect();
        for s in stale {
            self.unview(&s, user, conn, evs);
        }
        if let Some(s) = server {
            self.view(s, user, conn, evs);
        }
    }

    fn clear_host(&mut self, user: &str, conn: u64) -> P2pDrop {
        let left = self.p2p.get_mut(user).and_then(|hosts| {
            hosts
                .remove(&conn)
                .map(|_| hosts.last_key_value().map(|(_, h)| h.clone()))
        });
        match left {
            None => P2pDrop::Kept,
            Some(Some(P2pHost { peer_id, ids })) => P2pDrop::Remaining(peer_id, ids),
            Some(None) => {
                self.p2p.remove(user);
                P2pDrop::Offline
            }
        }
    }

    fn side_effects(&mut self, ev: &WsEvent, t: i64, extra: &mut Vec<WsEvent>) {
        match ev {
            WsEvent::ServerRenamed { old_name, server } => {
                if let Some(v) = self.presence.remove(old_name) {
                    self.presence.insert(server.name.clone(), v);
                }
                for room in self.rooms.values_mut() {
                    if room.server == *old_name {
                        room.server = server.name.clone();
                    }
                }
            }
            WsEvent::ServerDeleted { name } => {
                self.presence.remove(name);
                self.rooms.retain(|_, r| r.server != *name);
            }
            WsEvent::ChannelDeleted {
                server: _,
                channel_id,
            } => {
                self.rooms.remove(channel_id);
            }
            WsEvent::MemberLeft { server, username }
            | WsEvent::MemberKicked {
                server,
                username,
                banned: _,
            } => {
                self.leave_rooms(|s, u, _| s == server && u == username, t, extra);
            }
            WsEvent::Banned { username } => {
                for (server, users) in self.presence.iter_mut() {
                    if users.remove(username).is_some() {
                        extra.push(presence_ev(server, username, false));
                    }
                }
                self.presence.retain(|_, users| !users.is_empty());
                self.p2p.remove(username);
                self.leave_rooms(|_, u, _| u == username, t, extra);
                self.end_calls(|c| c.dm_users.iter().any(|u| u == username), extra);
            }
            _ => {}
        }
    }

    fn purge(&mut self, id: u32, t: i64, evs: &mut Vec<WsEvent>, purge: &mut Purge) {
        self.peers.remove(&id);
        for (server, users) in self.presence.iter_mut() {
            let mut gone = Vec::new();
            for (user, conns) in users.iter_mut() {
                let before = conns.len();
                conns.retain(|c| owner(*c) != id);
                if before > 0 && conns.is_empty() {
                    gone.push(user.clone());
                }
            }
            for user in gone {
                users.remove(&user);
                evs.push(presence_ev(server, &user, false));
            }
        }
        self.presence.retain(|_, users| !users.is_empty());
        self.leave_rooms(|_, _, c| owner(c) == id, t, evs);
        let ends = self.end_calls(|c| c.occupants.iter().any(|(_, cn)| owner(*cn) == id), evs);
        purge.ends.extend(ends);
        for (user, hosts) in self.p2p.iter_mut() {
            let before = hosts.len();
            hosts.retain(|c, _| owner(*c) != id);
            if hosts.len() != before {
                let drop = match hosts.last_key_value() {
                    Some((_, h)) => P2pDrop::Remaining(h.peer_id.clone(), h.ids.clone()),
                    None => P2pDrop::Offline,
                };
                purge.p2p.push((user.clone(), drop));
            }
        }
        self.p2p.retain(|_, hosts| !hosts.is_empty());
    }

    pub fn admit(&mut self, origin: u32, seq: u64) -> bool {
        let peer = self.peers.entry(origin).or_default();
        if seq <= peer.seq {
            return false;
        }
        if peer.seq > 0 && seq > peer.seq + 1 {
            peer.gaps.push((peer.seq + 1, seq - 1));
            if peer.gaps.len() > GAPS_KEPT {
                peer.gaps.remove(0);
            }
        }
        peer.seq = seq;
        true
    }

    fn kept(&self, origin: u32, seq: u64) -> bool {
        self.peers.get(&origin).is_some_and(|p| {
            seq <= p.seq && !p.gaps.iter().any(|(from, to)| (*from..=*to).contains(&seq))
        })
    }

    fn holds<F: Fn(&str, u64) -> bool>(&self, mine: F) -> bool {
        let slots = |users: &[(String, u64)]| users.iter().any(|(u, c)| mine(u, *c));
        self.presence.values().any(|users| {
            users
                .iter()
                .any(|(u, conns)| conns.iter().any(|c| mine(u, *c)))
        }) || self.rooms.values().any(|r| slots(&r.users))
            || self.calls.values().any(|c| slots(&c.occupants))
            || self
                .p2p
                .iter()
                .any(|(u, hosts)| hosts.keys().any(|c| mine(u, *c)))
    }

    fn ended_since<F: Fn(&str, u64) -> bool>(&self, before: &Replica, mine: F) -> Vec<CallEnd> {
        before
            .calls
            .iter()
            .filter(|(id, call)| {
                call.occupants.iter().any(|(u, c)| mine(u, *c))
                    && self
                        .calls
                        .get(id)
                        .is_none_or(|now| now.log_id != call.log_id)
            })
            .map(|(_, call)| CallEnd::of(call))
            .collect()
    }

    fn host_drop(&self, user: &str) -> P2pDrop {
        match self.p2p.get(user).and_then(|hosts| hosts.last_key_value()) {
            Some((_, h)) => P2pDrop::Remaining(h.peer_id.clone(), h.ids.clone()),
            None => P2pDrop::Offline,
        }
    }

    fn recovered(&self, before: &Replica, me: u32, op: &Op) -> Option<Outcome> {
        match op {
            Op::DropConn { user, conn } => {
                let mine = |u: &str, c: u64| u == user && c == *conn;
                match self.holds(mine) {
                    true => None,
                    false => Some(Outcome::Dropped(
                        self.ended_since(before, mine),
                        self.host_drop(user),
                    )),
                }
            }
            Op::Depart => {
                let mine = |_: &str, c: u64| owner(c) == me;
                match self.holds(mine) {
                    true => None,
                    false => Some(Outcome::Departed(Purge {
                        ends: self.ended_since(before, mine),
                        p2p: before
                            .p2p
                            .iter()
                            .filter(|(_, hosts)| hosts.keys().any(|c| owner(*c) == me))
                            .map(|(u, _)| (u.clone(), self.host_drop(u)))
                            .collect(),
                    })),
                }
            }
            _ => Some(Outcome::Done),
        }
    }

    pub fn apply(&mut self, origin: u32, op: Op, t_ms: i64) -> Applied {
        let t = t_ms.div_euclid(1000);
        let mut evs = Vec::new();
        let mut purge = Purge::default();
        self.peers.entry(origin).or_default().seen = t_ms;
        let purged: Vec<u32> = self
            .peers
            .iter()
            .filter(|(_, p)| t_ms - p.seen > DEAD_AFTER_MS)
            .map(|(id, _)| *id)
            .collect();
        for id in &purged {
            self.purge(*id, t, &mut evs, &mut purge);
        }
        let outcome = match op {
            Op::Broadcast { event } => {
                let mut extra = Vec::new();
                self.side_effects(&event, t, &mut extra);
                evs.push(event);
                evs.append(&mut extra);
                Outcome::Done
            }
            Op::Viewing {
                user,
                conn,
                old,
                new,
            } => {
                if old != new {
                    if let Some(s) = &old {
                        self.unview(s, &user, conn, &mut evs);
                    }
                    if let Some(s) = &new {
                        self.view(s, &user, conn, &mut evs);
                    }
                }
                Outcome::Done
            }
            Op::Present { user, conn, server } => {
                self.present(&user, conn, server.as_deref(), &mut evs);
                Outcome::Done
            }
            Op::ForceOffline { server, user } => {
                let removed = self
                    .presence
                    .get_mut(&server)
                    .is_some_and(|users| users.remove(&user).is_some());
                if removed {
                    evs.push(presence_ev(&server, &user, false));
                }
                self.presence.retain(|_, users| !users.is_empty());
                Outcome::Done
            }
            Op::VoiceJoin {
                user,
                conn,
                server,
                channel_id,
            } => {
                let slot = self
                    .rooms
                    .get_mut(&channel_id)
                    .and_then(|room| room.users.iter_mut().find(|(u, _)| *u == user));
                match slot {
                    Some(slot) => {
                        slot.1 = conn;
                        Outcome::Ends(Vec::new())
                    }
                    None => {
                        self.leave_rooms(|_, u, _| u == user, t, &mut evs);
                        let ends = self.end_calls(|c| c.dm_users.contains(&user), &mut evs);
                        let room = self.rooms.entry(channel_id).or_insert_with(|| Room {
                            server,
                            users: Vec::new(),
                            lone_since: 0,
                        });
                        room.users.push((user, conn));
                        room.touch(t);
                        evs.push(room_state(channel_id, room));
                        Outcome::Ends(ends)
                    }
                }
            }
            Op::VoiceLeave { user } => {
                self.leave_rooms(|_, u, _| u == user, t, &mut evs);
                Outcome::Done
            }
            Op::CallStart {
                user,
                conn,
                dm_id,
                dm_users,
                kind,
                log_id,
            } => Outcome::Started('start: {
                if self.in_call(&user) {
                    break 'start Err("You are already in a call".to_string());
                }
                let other = dm_users.iter().find(|u| **u != user).cloned();
                match &other {
                    Some(name) if self.in_call(name) => {
                        break 'start Err(format!("{name} is already in a call"));
                    }
                    Some(_) => {}
                    None => break 'start Err("Cannot call yourself".to_string()),
                }
                self.leave_rooms(|_, u, _| u == user, t, &mut evs);
                let call = Call {
                    dm_users,
                    from: user.clone(),
                    occupants: vec![(user, conn)],
                    active: false,
                    kind,
                    log_id,
                    lone_since: t,
                };
                evs.push(call_state(dm_id, &call, CallPhase::Ringing));
                self.calls.insert(dm_id, call);
                Ok(())
            }),
            Op::CallAccept { user, conn, dm_id } => Outcome::Accepted('accept: {
                let valid = self
                    .calls
                    .get(&dm_id)
                    .is_some_and(|c| !c.active && c.from != user && c.dm_users.contains(&user));
                if !valid {
                    break 'accept Err("No incoming call".to_string());
                }
                self.leave_rooms(|_, u, _| u == user, t, &mut evs);
                let Some(call) = self.calls.get_mut(&dm_id) else {
                    break 'accept Err("No incoming call".to_string());
                };
                call.active = true;
                call.occupants.push((user, conn));
                evs.push(call_state(dm_id, call, CallPhase::Active));
                Ok((call.log_id, call.dm_users.clone()))
            }),
            Op::CallEnd { user, dm_id } => {
                let involved = self
                    .calls
                    .get(&dm_id)
                    .is_some_and(|c| c.dm_users.contains(&user));
                let call = match involved {
                    true => self.calls.remove(&dm_id),
                    false => None,
                };
                Outcome::Ended(match call {
                    Some(call) => {
                        evs.push(call_state(dm_id, &call, CallPhase::Ended));
                        Ok(CallEnd::of(&call))
                    }
                    None => Err("No such call".to_string()),
                })
            }
            Op::DropConn { user, conn } => {
                self.leave_rooms(|_, u, c| u == user && c == conn, t, &mut evs);
                let ends = self.end_calls(
                    |c| c.occupants.iter().any(|(u, cn)| *u == user && *cn == conn),
                    &mut evs,
                );
                self.present(&user, conn, None, &mut evs);
                Outcome::Dropped(ends, self.clear_host(&user, conn))
            }
            Op::SweepVoice { idle } => {
                let mut ends = Vec::new();
                let lone = |len: usize, since: i64| len == 1 && t - since >= idle;
                let cids: Vec<i64> = self
                    .rooms
                    .iter()
                    .filter(|(_, r)| lone(r.users.len(), r.lone_since))
                    .map(|(id, _)| *id)
                    .collect();
                for cid in cids {
                    if let Some(room) = self.rooms.remove(&cid) {
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
                let ids: Vec<i64> = self
                    .calls
                    .iter()
                    .filter(|(_, c)| lone(c.occupants.len(), c.lone_since))
                    .map(|(id, _)| *id)
                    .collect();
                for id in ids {
                    if let Some(call) = self.calls.remove(&id) {
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
                Outcome::Ends(ends)
            }
            Op::SetP2p {
                user,
                conn,
                peer_id,
                ids,
            } => {
                self.p2p
                    .entry(user)
                    .or_default()
                    .insert(conn, P2pHost { peer_id, ids });
                Outcome::Done
            }
            Op::EvictVoice { user, channel_id } => {
                let hit = match self.rooms.get_mut(&channel_id) {
                    Some(room) => {
                        let before = room.users.len();
                        room.users.retain(|(u, _)| *u != user);
                        match room.users.len() != before {
                            true => {
                                room.touch(t);
                                evs.push(room_state(channel_id, room));
                                true
                            }
                            false => false,
                        }
                    }
                    None => false,
                };
                if hit {
                    self.rooms.retain(|_, r| !r.users.is_empty());
                    evs.push(WsEvent::VoiceEnded {
                        server: None,
                        channel_id: Some(channel_id),
                        dm_id: None,
                        dm_users: Some(vec![user]),
                        reason: "You no longer have access to this voice channel".to_string(),
                    });
                }
                Outcome::Done
            }
            Op::Heartbeat => Outcome::Done,
            Op::Depart => {
                self.purge(origin, t, &mut evs, &mut purge);
                Outcome::Departed(std::mem::take(&mut purge))
            }
        };
        Applied {
            events: evs,
            outcome,
            purge,
            purged,
        }
    }

    fn rtc_shared(&self, a: &str, b: &str, channel_id: Option<i64>, dm_id: Option<i64>) -> bool {
        let both = |users: &[(String, u64)]| {
            users.iter().any(|(u, _)| u == a) && users.iter().any(|(u, _)| u == b)
        };
        match (channel_id, dm_id) {
            (Some(cid), None) => self.rooms.get(&cid).is_some_and(|r| both(&r.users)),
            (None, Some(id)) => self
                .calls
                .get(&id)
                .is_some_and(|c| c.active && c.kind == CallKind::Rtc && both(&c.occupants)),
            (_, _) => false,
        }
    }

    fn voice_snapshot(&self) -> Vec<WsEvent> {
        let mut evs: Vec<WsEvent> = self
            .rooms
            .iter()
            .map(|(cid, room)| room_state(*cid, room))
            .collect();
        for (id, call) in self.calls.iter() {
            let phase = match call.active {
                true => CallPhase::Active,
                false => CallPhase::Ringing,
            };
            evs.push(call_state(*id, call, phase));
        }
        evs
    }
}

struct Store {
    replica: Replica,
    last_id: String,
    own: u64,
}

struct Posted {
    op: Op,
    waiter: Option<oneshot::Sender<Outcome>>,
}

struct Link {
    out: mpsc::UnboundedSender<Envelope>,
    seq: Mutex<u64>,
    pending: Mutex<BTreeMap<u64, Posted>>,
    publishing: AtomicBool,
    following: AtomicBool,
    caught_up: AtomicBool,
    diverged: AtomicBool,
}

impl Link {
    fn take_through(&self, seq: u64) -> BTreeMap<u64, Posted> {
        let mut pending = self.pending.lock().unwrap();
        let later = pending.split_off(&seq.saturating_add(1));
        std::mem::replace(&mut *pending, later)
    }

    fn resolve<F: FnMut(u64, &Op) -> Option<Outcome>>(
        &self,
        taken: BTreeMap<u64, Posted>,
        mut applied: F,
    ) -> Vec<Op> {
        let settled: Vec<(Posted, Option<Outcome>)> = taken
            .into_iter()
            .map(|(seq, posted)| {
                let outcome = applied(seq, &posted.op);
                (posted, outcome)
            })
            .collect();
        let mut later: HashSet<String> = match settled.iter().any(|(_, o)| o.is_none()) {
            true => self
                .pending
                .lock()
                .unwrap()
                .values()
                .filter_map(|p| p.op.hoster().map(str::to_string))
                .collect(),
            false => HashSet::new(),
        };
        let mut reposts = Vec::new();
        for (Posted { op, waiter }, outcome) in settled.into_iter().rev() {
            let hoster = op.hoster().map(str::to_string);
            match (outcome, waiter) {
                (Some(outcome), waiter) => {
                    later.extend(hoster);
                    if let Some(waiter) = waiter {
                        let _ = waiter.send(outcome);
                    }
                }
                (None, Some(waiter)) => {
                    let _ = waiter.send(Outcome::Lost);
                }
                (None, None) => match hoster {
                    Some(h) if later.contains(&h) => {}
                    hoster => {
                        later.extend(hoster);
                        reposts.push(op);
                    }
                },
            }
        }
        reposts.reverse();
        reposts
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Epoch {
    pub count: u64,
    pub lossy: u64,
}

struct Inner {
    instance: u32,
    tx: broadcast::Sender<WsEvent>,
    store: Mutex<Store>,
    conns: AtomicU64,
    link: Option<Link>,
    epoch: watch::Sender<Epoch>,
    aftermath: mpsc::UnboundedSender<Aftermath>,
    aftermath_rx: Mutex<Option<mpsc::UnboundedReceiver<Aftermath>>>,
}

#[derive(Clone)]
pub struct Hub {
    inner: Arc<Inner>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    fn build(link: Option<Link>, capacity: usize) -> Hub {
        let (aftermath, aftermath_rx) = mpsc::unbounded_channel();
        Hub {
            inner: Arc::new(Inner {
                instance: rand::random(),
                tx: broadcast::channel(capacity).0,
                store: Mutex::new(Store {
                    replica: Replica::default(),
                    last_id: String::new(),
                    own: 0,
                }),
                conns: AtomicU64::new(0),
                link,
                epoch: watch::channel(Epoch::default()).0,
                aftermath,
                aftermath_rx: Mutex::new(Some(aftermath_rx)),
            }),
        }
    }

    pub fn new() -> Hub {
        Self::build(None, 256)
    }

    pub fn replicated() -> (Hub, mpsc::UnboundedReceiver<Envelope>) {
        let (out, rx) = mpsc::unbounded_channel();
        let link = Link {
            out,
            seq: Mutex::new(0),
            pending: Mutex::new(BTreeMap::new()),
            publishing: AtomicBool::new(false),
            following: AtomicBool::new(false),
            caught_up: AtomicBool::new(false),
            diverged: AtomicBool::new(false),
        };
        (Self::build(Some(link), 1024), rx)
    }

    pub fn instance(&self) -> u32 {
        self.inner.instance
    }

    pub fn next_conn(&self) -> u64 {
        let seq = self.inner.conns.fetch_add(1, Ordering::Relaxed) & 0xffff_ffff;
        ((self.inner.instance as u64) << 32) | seq
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WsEvent> {
        self.inner.tx.subscribe()
    }

    pub fn epoch(&self) -> watch::Receiver<Epoch> {
        self.inner.epoch.subscribe()
    }

    pub fn is_replicated(&self) -> bool {
        self.inner.link.is_some()
    }

    pub fn ready(&self) -> bool {
        self.inner.link.as_ref().is_none_or(|l| {
            l.publishing.load(Ordering::Relaxed)
                && l.following.load(Ordering::Relaxed)
                && l.caught_up.load(Ordering::Relaxed)
                && !l.diverged.load(Ordering::Relaxed)
        })
    }

    fn flag(&self, pick: fn(&Link) -> &AtomicBool, on: bool) {
        if let Some(link) = &self.inner.link {
            pick(link).store(on, Ordering::Relaxed);
        }
    }

    pub fn set_publishing(&self, up: bool) {
        self.flag(|l| &l.publishing, up);
    }

    pub fn set_following(&self, up: bool) {
        self.flag(|l| &l.following, up);
    }

    pub fn set_caught_up(&self, done: bool) {
        self.flag(|l| &l.caught_up, done);
    }

    pub fn set_diverged(&self, gap: bool) {
        self.flag(|l| &l.diverged, gap);
    }

    pub fn resync(&self, lossy: bool) {
        self.inner.epoch.send_modify(|e| {
            e.count += 1;
            e.lossy += lossy as u64;
        });
    }

    pub fn take_aftermath(&self) -> Option<mpsc::UnboundedReceiver<Aftermath>> {
        self.inner.aftermath_rx.lock().unwrap().take()
    }

    fn local(&self, op: Op) -> Outcome {
        let (outcome, purge) = {
            let mut store = self.inner.store.lock().unwrap();
            let Applied {
                events,
                outcome,
                purge,
                purged: _,
            } = store.replica.apply(self.inner.instance, op, now_ms());
            for ev in events {
                let _ = self.inner.tx.send(ev);
            }
            (outcome, purge)
        };
        if !purge.is_empty() {
            let _ = self.inner.aftermath.send(Aftermath::Settle(purge));
        }
        outcome
    }

    fn post(&self, op: Op) {
        match &self.inner.link {
            None => {
                self.local(op);
            }
            Some(link) => {
                let mut seq = link.seq.lock().unwrap();
                self.send(link, &mut seq, op);
            }
        }
    }

    fn send(&self, link: &Link, seq: &mut u64, op: Op) {
        *seq += 1;
        if op.repostable() {
            let posted = Posted {
                op: op.clone(),
                waiter: None,
            };
            link.pending.lock().unwrap().insert(*seq, posted);
        }
        let _ = link.out.send(Envelope {
            origin: self.inner.instance,
            seq: *seq,
            op,
        });
    }

    fn settle_own<F: FnMut(u64, &Op) -> Option<Outcome>>(
        &self,
        link: &Link,
        through: u64,
        applied: F,
    ) {
        let mut seq = link.seq.lock().unwrap();
        let lost = link.resolve(link.take_through(through), applied);
        if lost.is_empty() {
            return;
        }
        let (now, checked): (Vec<Op>, Vec<Op>) =
            lost.into_iter().partition(|op| op.hoster().is_some());
        warn!(
            "{} realtime ops were lost on the bus; posting them again ({} after a database check)",
            now.len() + checked.len(),
            checked.len()
        );
        for op in now {
            self.send(link, &mut seq, op);
        }
        drop(seq);
        if !checked.is_empty() {
            let _ = self.inner.aftermath.send(Aftermath::Repost(checked));
        }
    }

    async fn call(&self, op: Op) -> Outcome {
        let link = match &self.inner.link {
            None => return self.local(op),
            Some(link) => link,
        };
        let (tx, rx) = oneshot::channel();
        {
            let mut seq = link.seq.lock().unwrap();
            *seq += 1;
            let posted = Posted {
                op: op.clone(),
                waiter: Some(tx),
            };
            link.pending.lock().unwrap().insert(*seq, posted);
            let _ = link.out.send(Envelope {
                origin: self.inner.instance,
                seq: *seq,
                op,
            });
        }
        rx.await.unwrap_or(Outcome::Done)
    }

    async fn call_applied(&self, op: Op) -> Outcome {
        loop {
            match self.call(op.clone()).await {
                Outcome::Lost => warn!("realtime op was lost on the bus, posting it again"),
                outcome => return outcome,
            }
        }
    }

    pub fn ingest(&self, id: &str, env: Envelope, live: bool) {
        let link = match &self.inner.link {
            Some(link) => link,
            None => return,
        };
        let Envelope { origin, seq, op } = env;
        let mine = origin == self.inner.instance;
        let (t_ms, _) = stream_pos(id);
        let (outcome, purge, purged, skipped) = {
            let mut store = self.inner.store.lock().unwrap();
            store.last_id = id.to_string();
            if !store.replica.admit(origin, seq) {
                return;
            }
            let skipped = mine && seq > store.own + 1;
            if mine {
                store.own = store.own.max(seq);
            }
            let Applied {
                events,
                outcome,
                purge,
                purged,
            } = store.replica.apply(origin, op, t_ms as i64);
            if live {
                for ev in events {
                    let _ = self.inner.tx.send(ev);
                }
            }
            (outcome, purge, purged, skipped)
        };
        if mine {
            let mut outcome = Some(outcome);
            self.settle_own(link, seq, |s, _| match s == seq {
                true => outcome.take(),
                false => None,
            });
            if !purge.is_empty() {
                let _ = self.inner.aftermath.send(Aftermath::Settle(purge));
            }
        }
        if skipped {
            warn!("realtime ops before {seq} from this instance were lost; re-announcing");
            self.resync(false);
        }
        if live && purged.contains(&self.inner.instance) {
            self.resync(false);
        }
    }

    pub fn snapshot(&self) -> Option<(String, String)> {
        let store = self.inner.store.lock().unwrap();
        let gap = self
            .inner
            .link
            .as_ref()
            .is_some_and(|l| l.diverged.load(Ordering::Relaxed));
        if store.last_id.is_empty() || gap {
            return None;
        }
        serde_json::to_string(&store.replica)
            .ok()
            .map(|json| (store.last_id.clone(), json))
    }

    pub fn restore(&self, last_id: &str, json: &str) -> serde_json::Result<()> {
        let replica: Replica = serde_json::from_str(json)?;
        let me = self.inner.instance;
        let applied = replica.peers.get(&me).map_or(0, |p| p.seq);
        let mut store = self.inner.store.lock().unwrap();
        let before = std::mem::replace(&mut store.replica, replica);
        store.last_id = last_id.to_string();
        store.own = store.own.max(applied);
        let after = &store.replica;
        if let Some(link) = &self.inner.link {
            self.settle_own(link, applied, |seq, op| match after.kept(me, seq) {
                true => after.recovered(&before, me, op),
                false => None,
            });
        }
        Ok(())
    }

    pub fn heartbeat(&self) {
        if self.is_replicated() {
            self.post(Op::Heartbeat);
        }
    }

    pub async fn flush(&self) {
        if self.is_replicated() {
            self.call(Op::Heartbeat).await;
        }
    }

    pub async fn depart(&self) -> Option<Purge> {
        if !self.is_replicated() {
            return None;
        }
        match self.call_applied(Op::Depart).await {
            Outcome::Departed(purge) => Some(purge),
            _ => None,
        }
    }

    pub fn broadcast(&self, ev: WsEvent) {
        self.post(Op::Broadcast { event: ev });
    }

    pub async fn broadcast_confirmed(&self, ev: WsEvent) -> bool {
        !matches!(self.call(Op::Broadcast { event: ev }).await, Outcome::Lost)
    }

    pub async fn voice_join(
        &self,
        user: &str,
        conn: u64,
        server: &str,
        channel_id: i64,
    ) -> Vec<CallEnd> {
        let op = Op::VoiceJoin {
            user: user.to_string(),
            conn,
            server: server.to_string(),
            channel_id,
        };
        match self.call(op).await {
            Outcome::Ends(ends) => ends,
            _ => Vec::new(),
        }
    }

    pub async fn voice_leave(&self, user: &str) {
        let op = Op::VoiceLeave {
            user: user.to_string(),
        };
        self.call_applied(op).await;
    }

    pub async fn call_start(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
        dm_users: Vec<String>,
        kind: CallKind,
        log_id: i64,
    ) -> Result<(), String> {
        let op = Op::CallStart {
            user: user.to_string(),
            conn,
            dm_id,
            dm_users,
            kind,
            log_id,
        };
        match self.call(op).await {
            Outcome::Started(res) => res,
            _ => Err("Realtime service unavailable".to_string()),
        }
    }

    pub async fn call_accept(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
    ) -> Result<(i64, Vec<String>), String> {
        let op = Op::CallAccept {
            user: user.to_string(),
            conn,
            dm_id,
        };
        match self.call(op).await {
            Outcome::Accepted(res) => res,
            _ => Err("Realtime service unavailable".to_string()),
        }
    }

    pub async fn call_end(&self, user: &str, dm_id: i64) -> Result<CallEnd, String> {
        let op = Op::CallEnd {
            user: user.to_string(),
            dm_id,
        };
        match self.call(op).await {
            Outcome::Ended(res) => res,
            _ => Err("Realtime service unavailable".to_string()),
        }
    }

    pub fn rtc_shared(
        &self,
        a: &str,
        b: &str,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
    ) -> bool {
        self.inner
            .store
            .lock()
            .unwrap()
            .replica
            .rtc_shared(a, b, channel_id, dm_id)
    }

    pub async fn drop_conn(&self, user: &str, conn: u64) -> (Vec<CallEnd>, P2pDrop) {
        let op = Op::DropConn {
            user: user.to_string(),
            conn,
        };
        match self.call_applied(op).await {
            Outcome::Dropped(ends, drop) => (ends, drop),
            _ => (Vec::new(), P2pDrop::Kept),
        }
    }

    pub async fn sweep_voice(&self, idle: i64) -> Vec<CallEnd> {
        match self.call(Op::SweepVoice { idle }).await {
            Outcome::Ends(ends) => ends,
            _ => Vec::new(),
        }
    }

    pub fn set_p2p(&self, user: &str, conn: u64, peer_id: String, ids: Vec<String>) {
        self.post(Op::SetP2p {
            user: user.to_string(),
            conn,
            peer_id,
            ids,
        });
    }

    pub fn p2p_of(&self, user: &str) -> Option<(String, Vec<String>)> {
        self.inner
            .store
            .lock()
            .unwrap()
            .replica
            .p2p
            .get(user)
            .and_then(|hosts| hosts.last_key_value())
            .map(|(_, h)| (h.peer_id.clone(), h.ids.clone()))
    }

    pub fn online_set(&self, server: &str) -> HashSet<String> {
        match self
            .inner
            .store
            .lock()
            .unwrap()
            .replica
            .presence
            .get(server)
        {
            Some(users) => users.keys().cloned().collect(),
            None => HashSet::new(),
        }
    }

    pub fn online_count(&self, server: &str) -> i64 {
        self.inner
            .store
            .lock()
            .unwrap()
            .replica
            .presence
            .get(server)
            .map_or(0, |users| users.len() as i64)
    }

    pub fn is_online(&self, server: &str, username: &str) -> bool {
        self.inner
            .store
            .lock()
            .unwrap()
            .replica
            .presence
            .get(server)
            .is_some_and(|users| users.contains_key(username))
    }

    pub fn set_viewing(&self, user: &str, conn: u64, old: Option<&str>, new: Option<&str>) {
        if old == new {
            return;
        }
        self.post(Op::Viewing {
            user: user.to_string(),
            conn,
            old: old.map(str::to_string),
            new: new.map(str::to_string),
        });
    }

    pub fn reannounce(&self, user: &str, conn: u64, server: Option<&str>) {
        self.post(Op::Present {
            user: user.to_string(),
            conn,
            server: server.map(str::to_string),
        });
    }

    pub fn force_offline(&self, server: &str, user: &str) {
        self.post(Op::ForceOffline {
            server: server.to_string(),
            user: user.to_string(),
        });
    }

    pub fn rooms_in(&self, server: &str, channel_id: Option<i64>) -> Vec<(i64, Vec<String>)> {
        self.inner
            .store
            .lock()
            .unwrap()
            .replica
            .rooms
            .iter()
            .filter(|(cid, room)| room.server == server && channel_id.is_none_or(|c| c == **cid))
            .map(|(cid, room)| (*cid, room.users.iter().map(|(u, _)| u.clone()).collect()))
            .collect()
    }

    pub fn evict_voice(&self, user: &str, channel_id: i64) {
        self.post(Op::EvictVoice {
            user: user.to_string(),
            channel_id,
        });
    }

    pub fn voice_snapshot(&self) -> Vec<WsEvent> {
        self.inner.store.lock().unwrap().replica.voice_snapshot()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::AtomicI64;

    use super::*;
    use crate::ws::to_bus_json;

    const T0: i64 = 1_700_000_000_000;

    #[derive(Clone)]
    pub(crate) struct MemBus {
        hubs: Arc<Mutex<Vec<Hub>>>,
        log: Arc<Mutex<Vec<(String, String)>>>,
        clock: Arc<AtomicI64>,
    }

    impl MemBus {
        pub(crate) fn new() -> MemBus {
            MemBus {
                hubs: Arc::new(Mutex::new(Vec::new())),
                log: Arc::new(Mutex::new(Vec::new())),
                clock: Arc::new(AtomicI64::new(T0)),
            }
        }

        fn advance(&self, ms: i64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }

        pub(crate) fn join(&self) -> Hub {
            let (hub, out) = Hub::replicated();
            self.attach(hub.clone(), out, None);
            hub
        }

        fn attach(
            &self,
            hub: Hub,
            mut out: mpsc::UnboundedReceiver<Envelope>,
            after: Option<&str>,
        ) {
            {
                let log = self.log.lock().unwrap();
                for (id, json) in log.iter() {
                    if after.is_none_or(|a| stream_pos(id) > stream_pos(a)) {
                        hub.ingest(id, serde_json::from_str(json).unwrap(), false);
                    }
                }
                hub.set_publishing(true);
                hub.set_following(true);
                hub.set_caught_up(true);
                self.hubs.lock().unwrap().push(hub);
            }
            let bus = self.clone();
            tokio::spawn(async move {
                while let Some(env) = out.recv().await {
                    bus.append(to_bus_json(&env).unwrap());
                }
            });
        }

        fn append(&self, json: String) {
            let mut log = self.log.lock().unwrap();
            let id = format!("{}-{}", self.clock.load(Ordering::SeqCst), log.len());
            for hub in self.hubs.lock().unwrap().iter() {
                hub.ingest(&id, serde_json::from_str(&json).unwrap(), true);
            }
            log.push((id, json));
        }
    }

    fn drain(rx: &mut broadcast::Receiver<WsEvent>) -> Vec<WsEvent> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            out.push(ev);
        }
        out
    }

    fn presence_of(evs: &[WsEvent]) -> Vec<(String, String, bool)> {
        evs.iter()
            .filter_map(|ev| match ev {
                WsEvent::PresenceChanged {
                    server,
                    username,
                    online,
                } => Some((server.clone(), username.clone(), *online)),
                _ => None,
            })
            .collect()
    }

    fn voice_of(evs: &[WsEvent]) -> Vec<(i64, Vec<String>)> {
        evs.iter()
            .filter_map(|ev| match ev {
                WsEvent::VoiceState {
                    server: _,
                    channel_id,
                    users,
                } => Some((*channel_id, users.clone())),
                _ => None,
            })
            .collect()
    }

    fn calls_of(evs: &[WsEvent]) -> Vec<(i64, CallPhase)> {
        evs.iter()
            .filter_map(|ev| match ev {
                WsEvent::CallState {
                    dm_id,
                    dm_users: _,
                    state,
                    from: _,
                    kind: _,
                } => Some((*dm_id, *state)),
                _ => None,
            })
            .collect()
    }

    fn dm_users() -> Vec<String> {
        vec!["alice".to_string(), "bob".to_string()]
    }

    fn script() -> Vec<(u32, Op, i64)> {
        let s = |v: &str| v.to_string();
        vec![
            (
                1,
                Op::Viewing {
                    user: s("alice"),
                    conn: 1 << 32,
                    old: None,
                    new: Some(s("rchat")),
                },
                T0,
            ),
            (
                2,
                Op::Viewing {
                    user: s("bob"),
                    conn: 2 << 32,
                    old: None,
                    new: Some(s("rchat")),
                },
                T0 + 10,
            ),
            (
                2,
                Op::Viewing {
                    user: s("carol"),
                    conn: (2 << 32) | 1,
                    old: None,
                    new: Some(s("other")),
                },
                T0 + 15,
            ),
            (
                1,
                Op::VoiceJoin {
                    user: s("alice"),
                    conn: 1 << 32,
                    server: s("rchat"),
                    channel_id: 5,
                },
                T0 + 20,
            ),
            (
                2,
                Op::VoiceJoin {
                    user: s("carol"),
                    conn: (2 << 32) | 1,
                    server: s("other"),
                    channel_id: 6,
                },
                T0 + 25,
            ),
            (
                2,
                Op::CallStart {
                    user: s("bob"),
                    conn: 2 << 32,
                    dm_id: 9,
                    dm_users: dm_users(),
                    kind: CallKind::Rtc,
                    log_id: 70,
                },
                T0 + 30,
            ),
            (
                2,
                Op::SetP2p {
                    user: s("bob"),
                    conn: 2 << 32,
                    peer_id: s("peer"),
                    ids: vec![s("f1")],
                },
                T0 + 40,
            ),
            (
                1,
                Op::Broadcast {
                    event: WsEvent::Banned { username: s("bob") },
                },
                T0 + 50,
            ),
            (1, Op::SweepVoice { idle: 60 }, T0 + 59_000),
            (1, Op::SweepVoice { idle: 60 }, T0 + 80_100),
        ]
    }

    #[test]
    fn apply_is_deterministic() {
        let run = || {
            let mut replica = Replica::default();
            let mut events = Vec::new();
            for (origin, op, t) in script() {
                let applied = replica.apply(origin, op, t);
                events.extend(applied.events.iter().map(|ev| to_bus_json(ev).unwrap()));
            }
            (serde_json::to_string(&replica).unwrap(), events)
        };
        let (state, events) = run();
        assert_eq!(run(), (state.clone(), events.clone()));
        let reloaded: Replica = serde_json::from_str(&state).unwrap();
        assert_eq!(serde_json::to_string(&reloaded).unwrap(), state);
        assert!(
            events
                .iter()
                .any(|e| e.contains("\"type\":\"presence_changed\"")
                    && e.contains("\"bob\"")
                    && e.contains("false"))
        );
        assert!(
            events
                .iter()
                .any(|e| e.contains("Voice ended after 60s alone"))
        );
        let replica: Replica = serde_json::from_str(&state).unwrap();
        assert!(replica.rooms.is_empty());
        assert!(replica.calls.is_empty());
        assert!(replica.p2p.is_empty());
        assert_eq!(replica.presence.keys().collect::<Vec<_>>(), vec!["rchat"]);
    }

    #[test]
    fn sweep_uses_op_time() {
        let mut replica = Replica::default();
        let join = Op::VoiceJoin {
            user: "alice".to_string(),
            conn: 1 << 32,
            server: "rchat".to_string(),
            channel_id: 5,
        };
        replica.apply(1, join, T0);
        let early = replica.apply(1, Op::SweepVoice { idle: 60 }, T0 + 59_999);
        assert!(early.events.is_empty());
        let late = replica.apply(1, Op::SweepVoice { idle: 60 }, T0 + 60_000);
        assert_eq!(voice_of(&late.events), vec![(5, Vec::new())]);
    }

    #[test]
    fn duplicates_are_ignored() {
        let mut replica = Replica::default();
        assert!(replica.admit(7, 1));
        assert!(replica.admit(7, 2));
        assert!(!replica.admit(7, 2));
        assert!(!replica.admit(7, 1));
        assert!(replica.admit(8, 1));
    }

    #[test]
    fn skipped_seqs_are_remembered() {
        let mut replica = Replica::default();
        assert!(replica.admit(7, 1) && replica.admit(7, 2) && replica.admit(7, 5));
        assert!(replica.kept(7, 2) && replica.kept(7, 5));
        assert!(!replica.kept(7, 3) && !replica.kept(7, 4) && !replica.kept(7, 6));
        assert!(!replica.admit(7, 4));
        assert!(replica.admit(9, 40));
        assert!(replica.kept(9, 39));
        let json = serde_json::to_string(&replica).unwrap();
        let reloaded: Replica = serde_json::from_str(&json).unwrap();
        assert!(!reloaded.kept(7, 3) && reloaded.kept(7, 5));
        for seq in (7..200).step_by(2) {
            replica.admit(7, seq);
        }
        assert_eq!(replica.peers[&7].gaps.len(), GAPS_KEPT);
        assert!(!replica.kept(7, 196) && replica.kept(7, 197));
    }

    #[tokio::test]
    async fn local_hub_applies_inline() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        let a = hub.next_conn();
        let b = hub.next_conn();
        hub.set_viewing("alice", a, None, Some("rchat"));
        hub.set_viewing("alice", b, None, Some("rchat"));
        assert!(hub.is_online("rchat", "alice"));
        assert_eq!(hub.online_count("rchat"), 1);
        hub.set_viewing("alice", a, Some("rchat"), None);
        assert!(hub.is_online("rchat", "alice"));
        hub.set_viewing("alice", b, Some("rchat"), None);
        assert!(!hub.is_online("rchat", "alice"));
        assert_eq!(
            presence_of(&drain(&mut rx)),
            vec![
                ("rchat".to_string(), "alice".to_string(), true),
                ("rchat".to_string(), "alice".to_string(), false)
            ]
        );
        assert!(hub.voice_join("alice", a, "rchat", 5).await.is_empty());
        assert_eq!(
            hub.rooms_in("rchat", None),
            vec![(5, vec!["alice".to_string()])]
        );
        hub.broadcast(WsEvent::ChannelDeleted {
            server: "rchat".to_string(),
            channel_id: 5,
        });
        assert!(hub.rooms_in("rchat", None).is_empty());
        assert!(hub.ready());
    }

    #[tokio::test]
    async fn presence_across_instances() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let mut rx_b = b.subscribe();
        let conn_a = a.next_conn();
        let conn_b = b.next_conn();
        a.set_viewing("alice", conn_a, None, Some("rchat"));
        a.flush().await;
        assert!(b.is_online("rchat", "alice"));
        assert_eq!(b.online_set("rchat"), HashSet::from(["alice".to_string()]));
        b.set_viewing("alice", conn_b, None, Some("rchat"));
        b.flush().await;
        a.set_viewing("alice", conn_a, Some("rchat"), None);
        a.flush().await;
        assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
        b.set_viewing("alice", conn_b, Some("rchat"), None);
        b.flush().await;
        assert!(!a.is_online("rchat", "alice") && !b.is_online("rchat", "alice"));
        assert_eq!(
            presence_of(&drain(&mut rx_b)),
            vec![
                ("rchat".to_string(), "alice".to_string(), true),
                ("rchat".to_string(), "alice".to_string(), false)
            ]
        );
    }

    #[tokio::test]
    async fn voice_and_call_across_instances() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let mut rx_a = a.subscribe();
        let (alice, bob) = (a.next_conn(), b.next_conn());
        assert!(a.voice_join("alice", alice, "rchat", 5).await.is_empty());
        assert!(b.voice_join("bob", bob, "rchat", 5).await.is_empty());
        let both = vec![(5, vec!["alice".to_string(), "bob".to_string()])];
        assert_eq!(a.rooms_in("rchat", None), both);
        assert_eq!(b.rooms_in("rchat", Some(5)), both);
        assert!(a.rtc_shared("alice", "bob", Some(5), None));
        assert!(b.rtc_shared("bob", "alice", Some(5), None));
        assert_eq!(
            voice_of(&drain(&mut rx_a)),
            vec![(5, vec!["alice".to_string()]), (5, both[0].1.clone())]
        );
        a.call_start("alice", alice, 9, dm_users(), CallKind::Rtc, 70)
            .await
            .unwrap();
        assert_eq!(
            b.call_start("bob", bob, 9, dm_users(), CallKind::Rtc, 71)
                .await,
            Err("You are already in a call".to_string())
        );
        let (log_id, users) = b.call_accept("bob", bob, 9).await.unwrap();
        assert_eq!((log_id, users), (70, dm_users()));
        assert!(a.rooms_in("rchat", None).is_empty());
        assert!(a.rtc_shared("alice", "bob", None, Some(9)));
        assert!(b.rtc_shared("alice", "bob", None, Some(9)));
        let end = a.call_end("alice", 9).await.unwrap();
        assert!(end.answered && end.log_id == 70);
        assert!(!b.rtc_shared("alice", "bob", None, Some(9)));
        assert_eq!(
            calls_of(&drain(&mut rx_a)),
            vec![
                (9, CallPhase::Ringing),
                (9, CallPhase::Active),
                (9, CallPhase::Ended)
            ]
        );
        assert_eq!(
            to_bus_json(&a.voice_snapshot()).unwrap(),
            to_bus_json(&b.voice_snapshot()).unwrap()
        );
    }

    #[tokio::test]
    async fn broadcast_reaches_each_connection_once() {
        let bus = MemBus::new();
        let hubs = [bus.join(), bus.join(), bus.join()];
        let mut receivers: Vec<_> = hubs
            .iter()
            .flat_map(|h| [h.subscribe(), h.subscribe()])
            .collect();
        hubs[1].broadcast(WsEvent::RolesChanged {
            server: "rchat".to_string(),
        });
        for hub in &hubs {
            hub.flush().await;
        }
        for rx in receivers.iter_mut() {
            let evs = drain(rx);
            assert_eq!(evs.len(), 1);
            assert!(matches!(&evs[0], WsEvent::RolesChanged { server } if server == "rchat"));
        }
    }

    #[tokio::test]
    async fn dead_instance_is_purged() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let mut aftermath = b.take_aftermath().unwrap();
        let mut rx_b = b.subscribe();
        let (alice, bob) = (a.next_conn(), b.next_conn());
        a.set_viewing("alice", alice, None, Some("rchat"));
        b.set_viewing("bob", bob, None, Some("rchat"));
        a.set_p2p("alice", alice, "peer-a".to_string(), vec!["f".to_string()]);
        a.call_start("alice", alice, 9, dm_users(), CallKind::P2p, 70)
            .await
            .unwrap();
        b.call_accept("bob", bob, 9).await.unwrap();
        assert!(
            b.voice_join("carol", b.next_conn(), "rchat", 5)
                .await
                .is_empty()
        );
        drain(&mut rx_b);
        bus.advance(DEAD_AFTER_MS + 1);
        b.flush().await;
        let evs = drain(&mut rx_b);
        assert_eq!(
            presence_of(&evs),
            vec![("rchat".to_string(), "alice".to_string(), false)]
        );
        assert_eq!(calls_of(&evs), vec![(9, CallPhase::Ended)]);
        assert!(!b.is_online("rchat", "alice") && b.is_online("rchat", "bob"));
        assert!(b.p2p_of("alice").is_none());
        assert_eq!(
            b.rooms_in("rchat", None),
            vec![(5, vec!["carol".to_string()])]
        );
        let Aftermath::Settle(purge) = aftermath.try_recv().unwrap() else {
            panic!("expected the purge aftermath");
        };
        assert_eq!(purge.ends.len(), 1);
        assert!(purge.ends[0].answered && purge.ends[0].log_id == 70);
        assert!(matches!(purge.p2p.as_slice(), [(user, P2pDrop::Offline)] if user == "alice"));
        assert!(!a.is_online("rchat", "alice"));
    }

    #[tokio::test]
    async fn purged_instance_reannounces() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let mut epoch = a.epoch();
        let alice = a.next_conn();
        a.set_viewing("alice", alice, None, Some("rchat"));
        a.flush().await;
        bus.advance(DEAD_AFTER_MS + 1);
        b.flush().await;
        assert!(epoch.has_changed().unwrap());
        assert_eq!(epoch.borrow_and_update().lossy, 0);
        a.resync(true);
        assert_eq!(epoch.borrow_and_update().lossy, 1);
        a.set_viewing("alice", alice, None, Some("rchat"));
        a.flush().await;
        assert!(b.is_online("rchat", "alice"));
        a.set_viewing("alice", alice, Some("rchat"), None);
        a.flush().await;
        assert!(!b.is_online("rchat", "alice"));
    }

    #[tokio::test]
    async fn reannounce_repairs_lost_switch() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let alice = a.next_conn();
        let mut replica = Replica::default();
        let viewing = |old: Option<&str>, new: Option<&str>| Op::Viewing {
            user: "alice".to_string(),
            conn: alice,
            old: old.map(str::to_string),
            new: new.map(str::to_string),
        };
        replica.apply(1, viewing(None, Some("one")), T0);
        let stale = replica.apply(
            1,
            Op::Present {
                user: "alice".to_string(),
                conn: alice,
                server: Some("two".to_string()),
            },
            T0 + 1,
        );
        assert_eq!(
            presence_of(&stale.events),
            vec![
                ("one".to_string(), "alice".to_string(), false),
                ("two".to_string(), "alice".to_string(), true)
            ]
        );
        a.set_viewing("alice", alice, None, Some("one"));
        a.flush().await;
        a.reannounce("alice", alice, Some("two"));
        a.flush().await;
        assert!(!b.is_online("one", "alice") && b.is_online("two", "alice"));
        a.reannounce("alice", alice, None);
        a.flush().await;
        assert!(!b.is_online("two", "alice") && !a.is_online("two", "alice"));
    }

    #[tokio::test]
    async fn departing_instance_clears_its_state() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let alice = a.next_conn();
        a.set_viewing("alice", alice, None, Some("rchat"));
        assert!(a.voice_join("alice", alice, "rchat", 5).await.is_empty());
        let purge = a.depart().await.unwrap();
        assert!(purge.ends.is_empty());
        assert!(!b.is_online("rchat", "alice"));
        assert!(b.rooms_in("rchat", None).is_empty());
    }

    #[tokio::test]
    async fn bootstrap_from_snapshot() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let (alice, bob) = (a.next_conn(), b.next_conn());
        a.set_viewing("alice", alice, None, Some("rchat"));
        assert!(a.voice_join("alice", alice, "rchat", 5).await.is_empty());
        let (id, json) = a.snapshot().unwrap();
        b.set_viewing("bob", bob, None, Some("rchat"));
        assert!(b.voice_join("bob", bob, "rchat", 5).await.is_empty());
        let (c, out) = Hub::replicated();
        c.restore(&id, &json).unwrap();
        bus.attach(c.clone(), out, Some(&id));
        let mut rx_c = c.subscribe();
        assert_eq!(c.online_set("rchat"), a.online_set("rchat"));
        assert_eq!(c.rooms_in("rchat", None), a.rooms_in("rchat", None));
        assert_eq!(
            c.rooms_in("rchat", None),
            vec![(5, vec!["alice".to_string(), "bob".to_string()])]
        );
        assert!(drain(&mut rx_c).is_empty());
        let carol = c.next_conn();
        c.set_viewing("carol", carol, None, Some("rchat"));
        c.flush().await;
        assert!(a.is_online("rchat", "carol"));
        assert_eq!(a.snapshot().unwrap().1, c.snapshot().unwrap().1);
    }
}
