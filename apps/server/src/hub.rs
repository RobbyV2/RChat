use std::borrow::Borrow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tracing::warn;

use crate::fanout::{Channels, Inbox, Router, Topic};
use crate::ws::{CallKind, CallPeer, CallPhase, WsEvent};

pub const DEAD_AFTER_MS: i64 = 30_000;
pub const PRESENCE_GRACE_MS: i64 = 10_000;
pub const PRESENCE_SERVERS_MAX: usize = 1000;
// Coming back online (after appear offline, or a dark or closed spell) is allowed
// `SHOW_BURST` times at once, then once per `SHOW_EVERY_MS`; a show past that waits and the
// state at the end wins. Going offline by appear offline is never delayed.
pub const SHOW_BURST: i64 = 4;
pub const SHOW_EVERY_MS: i64 = PRESENCE_GRACE_MS;
const REANNOUNCE_EVERY: Duration = Duration::from_secs(10);
const CONNECT_USERS_MAX: usize = 10_000;
const GAPS_KEPT: usize = 32;
const OUT_CAP: usize = 10_000;
const PENDING_CAP: usize = 50_000;
pub const CALL_TIMEOUT: Duration = match cfg!(test) {
    true => Duration::from_secs(2),
    false => Duration::from_secs(10),
};
pub const READ_FLUSH: Duration = Duration::from_millis(500);
pub const RELEASE_BURST: u32 = 30;
pub const RELEASE_EVERY: Duration = Duration::from_secs(2);
const RELEASE_USERS_MAX: usize = 10_000;

static DROPPED: AtomicU64 = AtomicU64::new(0);

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

fn link<K: Ord, V: Ord>(map: &mut BTreeMap<K, BTreeSet<V>>, key: K, val: V) {
    map.entry(key).or_default().insert(val);
}

fn unlink<K, V, Q, R>(map: &mut BTreeMap<K, BTreeSet<V>>, key: &Q, val: &R)
where
    K: Ord + Borrow<Q>,
    V: Ord + Borrow<R>,
    Q: Ord + ?Sized,
    R: Ord + ?Sized,
{
    if let Some(set) = map.get_mut(key) {
        set.remove(val);
        if set.is_empty() {
            map.remove(key);
        }
    }
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
    #[serde(default)]
    video: bool,
    log_id: i64,
    lone_since: i64,
    // A P2P call is bound to this id and to the peer ids of the caller's tab and of the tab
    // that accepted. Only the two sides of the call learn them.
    #[serde(default)]
    call_id: String,
    #[serde(default)]
    answered_at: i64,
    #[serde(default)]
    peers: Vec<(String, String)>,
}

impl Call {
    fn people(&self) -> BTreeSet<String> {
        self.dm_users
            .iter()
            .chain(self.occupants.iter().map(|(u, _)| u))
            .cloned()
            .collect()
    }
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

#[derive(Clone, Default, Debug, PartialEq)]
struct Index {
    presence: BTreeMap<String, BTreeSet<String>>,
    scoped: BTreeMap<String, BTreeSet<String>>,
    lingering: BTreeSet<(i64, String)>,
    waking: BTreeSet<(i64, String)>,
    user_rooms: BTreeMap<String, BTreeSet<i64>>,
    server_rooms: BTreeMap<String, BTreeSet<i64>>,
    user_calls: BTreeMap<String, BTreeSet<i64>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct Tab {
    lit: bool,
    at: i64,
}

// What a signed-in user shows: their member servers and appear-offline flag once, shared by
// all their open connections. `up` while they are in those servers' presence; `gone` is when
// they stopped being visible, kept online until the grace ends.
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Seen {
    servers: BTreeSet<String>,
    #[serde(skip_serializing_if = "is_false")]
    hidden: bool,
    // The version (`users.presence_seq`) of `hidden`; an older value never replaces it.
    #[serde(skip_serializing_if = "is_zero_ms")]
    mode: i64,
    conns: BTreeMap<u64, Tab>,
    #[serde(skip_serializing_if = "is_false")]
    up: bool,
    #[serde(skip_serializing_if = "is_zero_ms")]
    gone: i64,
    // Rate state (GCRA theoretical arrival times, ms): of coming online, and of new
    // connections across the cluster. `wake` is when a show held back by the rate is due.
    #[serde(skip_serializing_if = "is_zero_ms")]
    shows: i64,
    #[serde(skip_serializing_if = "is_zero_ms")]
    wake: i64,
    #[serde(skip_serializing_if = "is_zero_ms")]
    opened: i64,
}

impl Seen {
    fn visible(&self) -> bool {
        !self.hidden && self.conns.values().any(|tab| tab.lit)
    }

    // Last writer wins by version: a connection that read the setting before a change can not
    // undo it.
    fn take_mode(&mut self, hidden: bool, seq: i64) {
        if seq >= self.mode {
            self.mode = seq;
            self.hidden = hidden;
        }
    }
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero_ms(t: &i64) -> bool {
    *t == 0
}

/// What a connection announces for its user: their member servers (the first
/// `PRESENCE_SERVERS_MAX` by name are kept) and whether they appear offline, with the version
/// of that setting (`users.presence_seq`) it read.
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
pub struct Scope {
    pub servers: Vec<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "is_zero_ms")]
    pub seq: i64,
}

// Older nodes wrote no `seen` map, only `presence` with the connections viewing each server.
// Those are taken as open, and the restoring node asks every node to announce again.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Wire {
    presence: BTreeMap<String, BTreeMap<String, BTreeSet<u64>>>,
    seen: Option<BTreeMap<String, Seen>>,
    rooms: BTreeMap<i64, Room>,
    calls: BTreeMap<i64, Call>,
    p2p: BTreeMap<String, BTreeMap<u64, P2pHost>>,
    peers: BTreeMap<u32, Peer>,
    clock: i64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(from = "Wire")]
pub struct Replica {
    seen: BTreeMap<String, Seen>,
    rooms: BTreeMap<i64, Room>,
    calls: BTreeMap<i64, Call>,
    p2p: BTreeMap<String, BTreeMap<u64, P2pHost>>,
    peers: BTreeMap<u32, Peer>,
    clock: i64,
    #[serde(skip)]
    legacy: bool,
    #[serde(skip)]
    index: Index,
}

impl From<Wire> for Replica {
    fn from(wire: Wire) -> Replica {
        let Wire {
            presence,
            seen,
            rooms,
            calls,
            p2p,
            peers,
            clock,
        } = wire;
        let legacy = seen.is_none();
        let seen = seen.unwrap_or_else(|| {
            let mut seen: BTreeMap<String, Seen> = BTreeMap::new();
            for (server, users) in presence {
                for (user, conns) in users {
                    let entry = seen.entry(user).or_default();
                    entry.servers.insert(server.clone());
                    entry.up = true;
                    for conn in conns {
                        entry.conns.insert(conn, Tab { lit: true, at: 0 });
                    }
                }
            }
            seen
        });
        let mut replica = Replica {
            seen,
            rooms,
            calls,
            p2p,
            peers,
            clock,
            legacy,
            index: Index::default(),
        };
        replica.reindex();
        replica
    }
}

impl Clone for Replica {
    fn clone(&self) -> Replica {
        let mut copy = self.detached();
        copy.index = self.index.clone();
        copy
    }
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
    Online {
        user: String,
        conn: u64,
        #[serde(default = "yes")]
        lit: bool,
        #[serde(default, skip_serializing_if = "is_zero")]
        cap: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<Scope>,
        // The poster's per-user connect interval (ms), counted across the cluster.
        #[serde(default, skip_serializing_if = "is_zero")]
        every: usize,
    },
    Rescope {
        user: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        add: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        remove: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hidden: Option<bool>,
        #[serde(default, skip_serializing_if = "is_zero_ms")]
        seq: i64,
    },
    Reannounce,
    ForceOffline {
        server: String,
        user: String,
    },
    VoiceJoin {
        user: String,
        conn: u64,
        server: String,
        channel_id: i64,
        #[serde(default, skip_serializing_if = "is_zero")]
        cap: usize,
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
        #[serde(default)]
        video: bool,
        log_id: i64,
        #[serde(default)]
        call_id: String,
        #[serde(default)]
        peer_id: Option<String>,
    },
    CallAccept {
        user: String,
        conn: u64,
        dm_id: i64,
        #[serde(default)]
        peer_id: Option<String>,
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

fn is_zero(n: &usize) -> bool {
    *n == 0
}

fn yes() -> bool {
    true
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
            | Op::Online {
                user: _,
                conn: _,
                lit: _,
                cap: _,
                scope: _,
                every: _,
            }
            | Op::Rescope {
                user: _,
                add: _,
                remove: _,
                hidden: _,
                seq: _,
            }
            | Op::Reannounce
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
                cap: _,
            }
            | Op::VoiceLeave { user: _ }
            | Op::CallStart {
                user: _,
                conn: _,
                dm_id: _,
                dm_users: _,
                kind: _,
                video: _,
                log_id: _,
                call_id: _,
                peer_id: _,
            }
            | Op::CallAccept {
                user: _,
                conn: _,
                dm_id: _,
                peer_id: _,
            }
            | Op::CallEnd { user: _, dm_id: _ }
            | Op::DropConn { user: _, conn: _ }
            | Op::SweepVoice { idle: _ }
            | Op::Depart => false,
        }
    }

    fn must_apply(&self) -> bool {
        matches!(
            self,
            Op::DropConn { user: _, conn: _ } | Op::VoiceLeave { user: _ } | Op::Depart
        )
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
    Full,
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
    pub evicted: Vec<u64>,
}

fn room_state(channel_id: i64, room: &Room) -> WsEvent {
    WsEvent::VoiceState {
        server: room.server.clone(),
        channel_id,
        users: room.users.iter().map(|(u, _)| u.clone()).collect(),
    }
}

// A relayed rtc signal is checked when sent. But the target can leave or switch rooms before the
// broadcast applies. So signals for a session the two users no longer share are dropped here, in
// log order with the joins and leaves.
fn stale_signal(replica: &Replica, ev: &WsEvent) -> bool {
    match ev {
        WsEvent::RtcSignal {
            to,
            from,
            channel_id,
            dm_id,
            payload: _,
        } => !replica.rtc_shared(from, to, *channel_id, *dm_id),
        _ => false,
    }
}

// An active P2P call also names its id and the peer id of each side, so the caller dials the
// tab that accepted and that tab answers only the caller.
fn call_state(dm_id: i64, call: &Call, state: CallPhase) -> WsEvent {
    let bound =
        state == CallPhase::Active && call.kind == CallKind::P2p && !call.call_id.is_empty();
    WsEvent::CallState {
        dm_id,
        dm_users: call.dm_users.clone(),
        state,
        from: call.from.clone(),
        kind: call.kind,
        video: call.video,
        call_id: bound.then(|| call.call_id.clone()),
        answered_at: (state == CallPhase::Active && call.answered_at > 0)
            .then_some(call.answered_at),
        peers: match bound {
            true => call
                .peers
                .iter()
                .map(|(user, peer_id)| CallPeer {
                    user: user.clone(),
                    peer_id: peer_id.clone(),
                })
                .collect(),
            false => Vec::new(),
        },
    }
}

fn call_phase(call: &Call) -> CallPhase {
    match call.active {
        true => CallPhase::Active,
        false => CallPhase::Ringing,
    }
}

fn shown_ev(username: &str, online: bool) -> WsEvent {
    WsEvent::UserShown {
        username: username.to_string(),
        online,
    }
}

fn presence_ev(server: &str, username: &str, online: bool, online_count: usize) -> WsEvent {
    WsEvent::PresenceChanged {
        server: server.to_string(),
        username: username.to_string(),
        online,
        online_count: online_count as i64,
    }
}

impl Replica {
    fn detached(&self) -> Replica {
        Replica {
            seen: self.seen.clone(),
            rooms: self.rooms.clone(),
            calls: self.calls.clone(),
            p2p: self.p2p.clone(),
            peers: self.peers.clone(),
            clock: self.clock,
            legacy: self.legacy,
            index: Index::default(),
        }
    }

    fn reindex(&mut self) {
        let mut index = Index::default();
        for (user, seen) in &self.seen {
            for server in &seen.servers {
                link(&mut index.scoped, server.clone(), user.clone());
                if seen.up {
                    link(&mut index.presence, server.clone(), user.clone());
                }
            }
            if seen.gone > 0 {
                index.lingering.insert((seen.gone, user.clone()));
            }
            if seen.wake > 0 {
                index.waking.insert((seen.wake, user.clone()));
            }
        }
        for (cid, room) in &self.rooms {
            link(&mut index.server_rooms, room.server.clone(), *cid);
            for (user, _) in &room.users {
                link(&mut index.user_rooms, user.clone(), *cid);
            }
        }
        for (id, call) in &self.calls {
            for user in call.people() {
                link(&mut index.user_calls, user, *id);
            }
        }
        self.index = index;
    }

    fn rooms_of(&self, user: &str) -> Vec<i64> {
        self.index
            .user_rooms
            .get(user)
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default()
    }

    fn calls_of(&self, user: &str) -> Vec<i64> {
        self.index
            .user_calls
            .get(user)
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default()
    }

    fn take_room(&mut self, cid: i64) -> Option<Room> {
        let room = self.rooms.remove(&cid)?;
        unlink(&mut self.index.server_rooms, room.server.as_str(), &cid);
        for (user, _) in &room.users {
            unlink(&mut self.index.user_rooms, user.as_str(), &cid);
        }
        Some(room)
    }

    fn add_call(&mut self, id: i64, call: Call) {
        self.take_call(id);
        for user in call.people() {
            link(&mut self.index.user_calls, user, id);
        }
        self.calls.insert(id, call);
    }

    fn take_call(&mut self, id: i64) -> Option<Call> {
        let call = self.calls.remove(&id)?;
        for user in call.people() {
            unlink(&mut self.index.user_calls, user.as_str(), &id);
        }
        Some(call)
    }

    fn leave_rooms<F: Fn(&str, &str, u64) -> bool>(
        &mut self,
        cids: Vec<i64>,
        gone: F,
        t: i64,
        evs: &mut Vec<WsEvent>,
    ) {
        for cid in cids {
            let Some(room) = self.rooms.get_mut(&cid) else {
                continue;
            };
            let Room {
                server,
                users,
                lone_since,
            } = room;
            let mut left = Vec::new();
            users.retain(|(u, c)| match gone(server, u, *c) {
                true => {
                    left.push(u.clone());
                    false
                }
                false => true,
            });
            if left.is_empty() {
                continue;
            }
            for user in &left {
                unlink(&mut self.index.user_rooms, user.as_str(), &cid);
            }
            if users.len() == 1 {
                *lone_since = t;
            }
            evs.push(room_state(cid, room));
            if room.users.is_empty() {
                self.take_room(cid);
            }
        }
    }

    fn end_calls<F: Fn(&Call) -> bool>(
        &mut self,
        ids: Vec<i64>,
        pred: F,
        evs: &mut Vec<WsEvent>,
    ) -> Vec<CallEnd> {
        let ids: Vec<i64> = ids
            .into_iter()
            .filter(|id| self.calls.get(id).is_some_and(&pred))
            .collect();
        let mut ends = Vec::new();
        for id in ids {
            if let Some(call) = self.take_call(id) {
                evs.push(call_state(id, &call, CallPhase::Ended));
                ends.push(CallEnd::of(&call));
            }
        }
        ends
    }

    fn in_call(&self, user: &str) -> bool {
        self.calls_of(user).iter().any(|id| {
            self.calls
                .get(id)
                .is_some_and(|c| c.dm_users.iter().any(|u| u == user))
        })
    }

    fn show_in(&mut self, server: &str, user: &str, evs: &mut Vec<WsEvent>) {
        let users = self.index.presence.entry(server.to_string()).or_default();
        if users.insert(user.to_string()) {
            evs.push(presence_ev(server, user, true, users.len()));
        }
    }

    fn unshow(&mut self, server: &str, user: &str, evs: &mut Vec<WsEvent>) {
        if let Some(users) = self.index.presence.get_mut(server)
            && users.remove(user)
        {
            evs.push(presence_ev(server, user, false, users.len()));
            if users.is_empty() {
                self.index.presence.remove(server);
            }
        }
    }

    fn set_gone(&mut self, user: &str, gone: i64) {
        let Some(seen) = self.seen.get_mut(user) else {
            return;
        };
        if seen.gone == gone {
            return;
        }
        if seen.gone > 0 {
            self.index.lingering.remove(&(seen.gone, user.to_string()));
        }
        seen.gone = gone;
        if gone > 0 {
            self.index.lingering.insert((gone, user.to_string()));
        }
    }

    fn set_wake(&mut self, user: &str, wake: i64) {
        let Some(seen) = self.seen.get_mut(user) else {
            return;
        };
        if seen.wake == wake {
            return;
        }
        if seen.wake > 0 {
            self.index.waking.remove(&(seen.wake, user.to_string()));
        }
        seen.wake = wake;
        if wake > 0 {
            self.index.waking.insert((wake, user.to_string()));
        }
    }

    // Past `PRESENCE_SERVERS_MAX`, a server joins only in place of the last one by name.
    fn scope_add(&mut self, user: &str, server: &str, evs: &mut Vec<WsEvent>) {
        let Some(seen) = self.seen.get(user) else {
            return;
        };
        if seen.servers.contains(server) {
            return;
        }
        if seen.servers.len() >= PRESENCE_SERVERS_MAX {
            match seen.servers.last() {
                Some(last) if server < last.as_str() => {
                    let last = last.clone();
                    self.scope_remove(user, &last, evs);
                }
                _ => return,
            }
        }
        let Some(seen) = self.seen.get_mut(user) else {
            return;
        };
        seen.servers.insert(server.to_string());
        let shown = seen.up && !seen.hidden;
        link(&mut self.index.scoped, server.to_string(), user.to_string());
        if shown {
            self.show_in(server, user, evs);
        }
    }

    fn scope_remove(&mut self, user: &str, server: &str, evs: &mut Vec<WsEvent>) {
        let Some(seen) = self.seen.get_mut(user) else {
            return;
        };
        if !seen.servers.remove(server) {
            return;
        }
        unlink(&mut self.index.scoped, server, user);
        self.unshow(server, user, evs);
    }

    fn rescope(&mut self, user: &str, scope: Scope, evs: &mut Vec<WsEvent>) {
        let Scope {
            mut servers,
            hidden,
            seq,
        } = scope;
        servers.sort_unstable();
        servers.dedup();
        servers.truncate(PRESENCE_SERVERS_MAX);
        let Some(seen) = self.seen.get_mut(user) else {
            return;
        };
        seen.take_mode(hidden, seq);
        let want: BTreeSet<String> = servers.into_iter().collect();
        let stale: Vec<String> = seen.servers.difference(&want).cloned().collect();
        let fresh: Vec<String> = want.difference(&seen.servers).cloned().collect();
        for server in stale {
            self.scope_remove(user, &server, evs);
        }
        for server in fresh {
            self.scope_add(user, &server, evs);
        }
    }

    // Shows `user` when they become visible, at once unless they came online too often
    // lately (`SHOW_BURST`), then when the rate allows (`expire`). Appear offline hides them at
    // once. Otherwise, when they stop being visible (last connection closed, dark), they stay
    // online until `PRESENCE_GRACE_MS` after `t`, so a reconnect inside the grace emits nothing.
    fn settle_user(&mut self, user: &str, t: i64, evs: &mut Vec<WsEvent>) {
        let Some(seen) = self.seen.get_mut(user) else {
            return;
        };
        match (seen.visible(), seen.up) {
            (true, true) => {
                self.set_gone(user, 0);
                self.set_wake(user, 0);
            }
            (true, false) => {
                let due = seen.shows.saturating_sub((SHOW_BURST - 1) * SHOW_EVERY_MS);
                if due > t {
                    self.set_wake(user, due);
                    return;
                }
                seen.shows = seen.shows.max(t).saturating_add(SHOW_EVERY_MS);
                seen.up = true;
                let servers: Vec<String> = seen.servers.iter().cloned().collect();
                self.set_wake(user, 0);
                evs.push(shown_ev(user, true));
                for server in servers {
                    self.show_in(&server, user, evs);
                }
            }
            (false, true) if seen.hidden => self.hide_now(user, t, evs),
            (false, true) if seen.gone == 0 => self.set_gone(user, t.max(1)),
            (false, true) => {}
            (false, false) if seen.conns.is_empty() => self.retire(user, t, evs),
            (false, false) => self.set_wake(user, 0),
        }
    }

    fn hide_now(&mut self, user: &str, t: i64, evs: &mut Vec<WsEvent>) {
        self.set_gone(user, 0);
        let Some(seen) = self.seen.get_mut(user) else {
            return;
        };
        let was_up = std::mem::take(&mut seen.up);
        let empty = seen.conns.is_empty();
        if was_up {
            let servers: Vec<String> = seen.servers.iter().cloned().collect();
            for server in servers {
                self.unshow(&server, user, evs);
            }
            evs.push(shown_ev(user, false));
        }
        if empty {
            self.retire(user, t, evs);
        }
    }

    // A user with no connections left is forgotten, except for their rate state and
    // appear-offline version while the rates have not drained: reconnecting then still counts
    // against the cluster-wide limits. `expire` forgets them at `wake`.
    fn retire(&mut self, user: &str, t: i64, evs: &mut Vec<WsEvent>) {
        let Some(seen) = self.seen.get(user) else {
            return;
        };
        let drained = seen.opened.max(seen.shows);
        let rates = Seen {
            hidden: seen.hidden,
            mode: seen.mode,
            shows: seen.shows,
            opened: seen.opened,
            ..Seen::default()
        };
        self.forget(user, evs);
        if drained > t {
            self.seen.insert(user.to_string(), rates);
            self.set_wake(user, drained);
        }
    }

    fn forget(&mut self, user: &str, evs: &mut Vec<WsEvent>) {
        self.set_gone(user, 0);
        self.set_wake(user, 0);
        let Some(seen) = self.seen.remove(user) else {
            return;
        };
        for server in &seen.servers {
            unlink(&mut self.index.scoped, server.as_str(), user);
            if seen.up {
                self.unshow(server, user, evs);
            }
        }
        if seen.up {
            evs.push(shown_ev(user, false));
        }
    }

    fn expire(&mut self, t: i64, evs: &mut Vec<WsEvent>) {
        while let Some((wake, user)) = self.index.waking.first().cloned()
            && wake <= t
        {
            self.set_wake(&user, 0);
            self.settle_user(&user, t, evs);
        }
        while let Some((gone, user)) = self.index.lingering.first().cloned()
            && t - gone >= PRESENCE_GRACE_MS
        {
            self.hide_now(&user, t, evs);
        }
    }

    // An open connection of `user`, `lit` unless it is waiting for the database. With `cap`,
    // the user's oldest connections past it are closed.
    #[allow(clippy::too_many_arguments)]
    fn connect(
        &mut self,
        user: &str,
        conn: u64,
        lit: bool,
        cap: usize,
        scope: Option<Scope>,
        t: i64,
        evs: &mut Vec<WsEvent>,
    ) -> Vec<u64> {
        let seen = self.seen.entry(user.to_string()).or_default();
        seen.conns.entry(conn).or_insert(Tab { lit, at: t }).lit = lit;
        let mut evicted = Vec::new();
        if cap > 0 && seen.conns.len() > cap {
            let mut oldest: Vec<(i64, u64)> = seen
                .conns
                .iter()
                .filter(|(c, _)| **c != conn)
                .map(|(c, tab)| (tab.at, *c))
                .collect();
            oldest.sort_unstable();
            for (_, c) in oldest.into_iter().take(seen.conns.len() - cap) {
                seen.conns.remove(&c);
                evicted.push(c);
            }
        }
        if let Some(scope) = scope {
            self.rescope(user, scope, evs);
        }
        self.settle_user(user, t, evs);
        evicted
    }

    fn disconnect(&mut self, user: &str, conn: u64, t: i64, evs: &mut Vec<WsEvent>) {
        if let Some(seen) = self.seen.get_mut(user)
            && seen.conns.remove(&conn).is_some()
        {
            self.settle_user(user, t, evs);
        }
    }

    // `Viewing` and `Present` come from nodes that predate site-wide presence: the connection
    // views one server, or none and is offline.
    fn legacy_view(
        &mut self,
        user: &str,
        conn: u64,
        server: Option<&str>,
        t: i64,
        evs: &mut Vec<WsEvent>,
    ) {
        match server {
            Some(s) => {
                let seen = self.seen.entry(user.to_string()).or_default();
                seen.conns
                    .entry(conn)
                    .or_insert(Tab { lit: true, at: t })
                    .lit = true;
                self.scope_add(user, s, evs);
                self.settle_user(user, t, evs);
            }
            None => self.disconnect(user, conn, t, evs),
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

    fn kick(&mut self, server: &str, username: &str, t: i64, extra: &mut Vec<WsEvent>) {
        let rooms = self.rooms_of(username);
        self.leave_rooms(rooms, |s, u, _| s == server && u == username, t, extra);
    }

    fn rename_server(&mut self, old_name: &str, new_name: &str) {
        if let Some(users) = self.index.scoped.remove(old_name) {
            for user in &users {
                if let Some(seen) = self.seen.get_mut(user) {
                    seen.servers.remove(old_name);
                    seen.servers.insert(new_name.to_string());
                }
            }
            self.index
                .scoped
                .entry(new_name.to_string())
                .or_default()
                .extend(users);
        }
        if let Some(users) = self.index.presence.remove(old_name) {
            self.index
                .presence
                .entry(new_name.to_string())
                .or_default()
                .extend(users);
        }
        if let Some(cids) = self.index.server_rooms.remove(old_name) {
            for cid in &cids {
                if let Some(room) = self.rooms.get_mut(cid) {
                    room.server = new_name.to_string();
                }
            }
            self.index
                .server_rooms
                .entry(new_name.to_string())
                .or_default()
                .extend(cids);
        }
    }

    fn side_effects(&mut self, ev: &WsEvent, t_ms: i64, extra: &mut Vec<WsEvent>) {
        let t = t_ms.div_euclid(1000);
        match ev {
            WsEvent::ServerRenamed { old_name, server } => {
                self.rename_server(old_name, &server.name);
            }
            WsEvent::ServerDeleted { name } => {
                for user in self.index.scoped.remove(name).unwrap_or_default() {
                    if let Some(seen) = self.seen.get_mut(&user) {
                        seen.servers.remove(name);
                    }
                }
                self.index.presence.remove(name);
                let cids: Vec<i64> = self
                    .index
                    .server_rooms
                    .get(name)
                    .map(|set| set.iter().copied().collect())
                    .unwrap_or_default();
                for cid in cids {
                    self.take_room(cid);
                }
            }
            WsEvent::ChannelDeleted {
                server: _,
                channel_id,
                rules: _,
            } => {
                self.take_room(*channel_id);
            }
            WsEvent::MemberLeft { server, username }
            | WsEvent::MemberKicked {
                server,
                username,
                banned: _,
            } => {
                self.kick(server, username, t, extra);
                self.scope_remove(username, server, extra);
            }
            WsEvent::ServerBanned { server, username } => {
                self.scope_remove(username, server, extra);
            }
            WsEvent::MembersPurged { server, usernames } => {
                for username in usernames {
                    self.kick(server, username, t, extra);
                    self.scope_remove(username, server, extra);
                }
            }
            WsEvent::MemberJoined { server, member } => {
                self.scope_add(&member.user.username, server, extra);
            }
            WsEvent::ServerCreated { server } => {
                if let Some(creator) = &server.creator {
                    self.scope_add(creator, &server.name, extra);
                }
            }
            WsEvent::PresenceMode {
                username,
                appear_offline,
                seq,
            } => {
                if let Some(seen) = self.seen.get_mut(username) {
                    seen.take_mode(*appear_offline, *seq);
                }
                self.settle_user(username, t_ms, extra);
            }
            WsEvent::Banned { username } => {
                self.hide_now(username, t_ms, extra);
                self.forget(username, extra);
                self.p2p.remove(username);
                let rooms = self.rooms_of(username);
                self.leave_rooms(rooms, |_, u, _| u == username, t, extra);
                let calls = self.calls_of(username);
                self.end_calls(calls, |c| c.dm_users.iter().any(|u| u == username), extra);
            }
            _ => {}
        }
    }

    // A departing instance's users get the offline grace, since its connections move to other
    // instances. A dead one's were gone for `DEAD_AFTER_MS` already.
    fn purge(
        &mut self,
        id: u32,
        t_ms: i64,
        grace: bool,
        evs: &mut Vec<WsEvent>,
        purge: &mut Purge,
    ) {
        let t = t_ms.div_euclid(1000);
        self.peers.remove(&id);
        let users: Vec<String> = self
            .seen
            .iter_mut()
            .filter_map(|(user, seen)| {
                let before = seen.conns.len();
                seen.conns.retain(|c, _| owner(*c) != id);
                (seen.conns.len() != before).then(|| user.clone())
            })
            .collect();
        for user in users {
            self.settle_user(&user, t_ms, evs);
            if !grace && self.seen.get(&user).is_some_and(|seen| !seen.visible()) {
                self.hide_now(&user, t_ms, evs);
            }
        }
        let rooms: Vec<i64> = self.rooms.keys().copied().collect();
        self.leave_rooms(rooms, |_, _, c| owner(c) == id, t, evs);
        let calls: Vec<i64> = self.calls.keys().copied().collect();
        let ends = self.end_calls(
            calls,
            |c| c.occupants.iter().any(|(_, cn)| owner(*cn) == id),
            evs,
        );
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
        self.seen
            .iter()
            .any(|(u, seen)| seen.conns.keys().any(|c| mine(u, *c)))
            || self.rooms.values().any(|r| slots(&r.users))
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

    fn sweep_dead(&mut self, origin: u32, t_ms: i64) -> Vec<u32> {
        let last = self.clock;
        self.clock = last.max(t_ms);
        self.peers.entry(origin).or_default().seen = t_ms;
        if last != 0 && t_ms - last > DEAD_AFTER_MS {
            for peer in self.peers.values_mut() {
                peer.seen = peer.seen.max(t_ms);
            }
            return Vec::new();
        }
        if last != 0 && t_ms.div_euclid(1000) == last.div_euclid(1000) {
            return Vec::new();
        }
        self.peers
            .iter()
            .filter(|(_, p)| t_ms - p.seen > DEAD_AFTER_MS)
            .map(|(id, _)| *id)
            .collect()
    }

    pub fn apply(&mut self, origin: u32, op: Op, t_ms: i64) -> Applied {
        let t = t_ms.div_euclid(1000);
        let mut evs = Vec::new();
        let mut purge = Purge::default();
        let mut evicted = Vec::new();
        let purged = self.sweep_dead(origin, t_ms);
        for id in &purged {
            self.purge(*id, t_ms, false, &mut evs, &mut purge);
        }
        self.expire(self.clock, &mut evs);
        let outcome = match op {
            Op::Broadcast { event } if stale_signal(self, &event) => Outcome::Done,
            Op::Broadcast { event } => {
                let mut extra = Vec::new();
                self.side_effects(&event, t_ms, &mut extra);
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
                    self.legacy_view(&user, conn, new.as_deref(), t_ms, &mut evs);
                }
                Outcome::Done
            }
            Op::Present { user, conn, server } => {
                self.legacy_view(&user, conn, server.as_deref(), t_ms, &mut evs);
                Outcome::Done
            }
            Op::Online {
                user,
                conn,
                lit,
                cap,
                scope,
                every,
            } => {
                let seen = self.seen.entry(user.clone()).or_default();
                if every > 0 && !seen.conns.contains_key(&conn) {
                    seen.opened = seen.opened.max(t_ms).saturating_add(every as i64);
                }
                evicted = self.connect(&user, conn, lit, cap, scope, t_ms, &mut evs);
                Outcome::Done
            }
            Op::Rescope {
                user,
                add,
                remove,
                hidden,
                seq,
            } => {
                for server in &remove {
                    self.scope_remove(&user, server, &mut evs);
                }
                for server in &add {
                    self.scope_add(&user, server, &mut evs);
                }
                if let (Some(hidden), Some(seen)) = (hidden, self.seen.get_mut(&user)) {
                    seen.take_mode(hidden, seq);
                }
                self.settle_user(&user, t_ms, &mut evs);
                Outcome::Done
            }
            Op::Reannounce => Outcome::Done,
            Op::ForceOffline { server, user } => {
                self.scope_remove(&user, &server, &mut evs);
                Outcome::Done
            }
            Op::VoiceJoin {
                user,
                conn,
                server,
                channel_id,
                cap,
            } => {
                let full = self
                    .rooms
                    .get(&channel_id)
                    .is_some_and(|room| cap > 0 && room.users.len() >= cap);
                let slot = self
                    .rooms
                    .get_mut(&channel_id)
                    .and_then(|room| room.users.iter_mut().find(|(u, _)| *u == user));
                match (slot, full) {
                    (Some(slot), _) => {
                        let moved = slot.1 != conn;
                        slot.1 = conn;
                        if moved && let Some(room) = self.rooms.get(&channel_id) {
                            evs.push(room_state(channel_id, room));
                        }
                        Outcome::Ends(Vec::new())
                    }
                    (None, true) => Outcome::Full,
                    (None, false) => {
                        let rooms = self.rooms_of(&user);
                        self.leave_rooms(rooms, |_, u, _| u == user, t, &mut evs);
                        let calls = self.calls_of(&user);
                        let ends = self.end_calls(calls, |c| c.dm_users.contains(&user), &mut evs);
                        if !self.rooms.contains_key(&channel_id) {
                            link(&mut self.index.server_rooms, server.clone(), channel_id);
                        }
                        link(&mut self.index.user_rooms, user.clone(), channel_id);
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
                let rooms = self.rooms_of(&user);
                self.leave_rooms(rooms, |_, u, _| u == user, t, &mut evs);
                Outcome::Done
            }
            Op::CallStart {
                user,
                conn,
                dm_id,
                dm_users,
                kind,
                video,
                log_id,
                call_id,
                peer_id,
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
                let rooms = self.rooms_of(&user);
                self.leave_rooms(rooms, |_, u, _| u == user, t, &mut evs);
                let peers = self
                    .call_peer(&user, conn, peer_id)
                    .map(|p| (user.clone(), p))
                    .into_iter()
                    .collect();
                let call = Call {
                    dm_users,
                    from: user.clone(),
                    occupants: vec![(user, conn)],
                    active: false,
                    kind,
                    video,
                    log_id,
                    lone_since: t,
                    call_id,
                    answered_at: 0,
                    peers,
                };
                evs.push(call_state(dm_id, &call, CallPhase::Ringing));
                self.add_call(dm_id, call);
                Ok(())
            }),
            Op::CallAccept {
                user,
                conn,
                dm_id,
                peer_id,
            } => Outcome::Accepted('accept: {
                let valid = self
                    .calls
                    .get(&dm_id)
                    .is_some_and(|c| !c.active && c.from != user && c.dm_users.contains(&user));
                if !valid {
                    break 'accept Err("No incoming call".to_string());
                }
                let rooms = self.rooms_of(&user);
                self.leave_rooms(rooms, |_, u, _| u == user, t, &mut evs);
                let peer = self.call_peer(&user, conn, peer_id);
                let Some(call) = self.calls.get_mut(&dm_id) else {
                    break 'accept Err("No incoming call".to_string());
                };
                call.active = true;
                call.answered_at = t;
                if let Some(peer) = peer {
                    call.peers.retain(|(u, _)| *u != user);
                    call.peers.push((user.clone(), peer));
                }
                call.occupants.push((user.clone(), conn));
                evs.push(call_state(dm_id, call, CallPhase::Active));
                let res = Ok((call.log_id, call.dm_users.clone()));
                link(&mut self.index.user_calls, user, dm_id);
                res
            }),
            Op::CallEnd { user, dm_id } => {
                let involved = self
                    .calls
                    .get(&dm_id)
                    .is_some_and(|c| c.dm_users.contains(&user));
                let call = match involved {
                    true => self.take_call(dm_id),
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
                let rooms = self.rooms_of(&user);
                self.leave_rooms(rooms, |_, u, c| u == user && c == conn, t, &mut evs);
                let calls = self.calls_of(&user);
                let ends = self.end_calls(
                    calls,
                    |c| c.occupants.iter().any(|(u, cn)| *u == user && *cn == conn),
                    &mut evs,
                );
                self.disconnect(&user, conn, t_ms, &mut evs);
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
                    if let Some(room) = self.take_room(cid) {
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
                    if let Some(call) = self.take_call(id) {
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
                    unlink(&mut self.index.user_rooms, user.as_str(), &channel_id);
                    if self
                        .rooms
                        .get(&channel_id)
                        .is_some_and(|r| r.users.is_empty())
                    {
                        self.take_room(channel_id);
                    }
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
                self.purge(origin, t_ms, true, &mut evs, &mut purge);
                Outcome::Departed(std::mem::take(&mut purge))
            }
        };
        Applied {
            events: evs,
            outcome,
            purge,
            purged,
            evicted,
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

    fn in_p2p_call(&self, a: &str, b: &str) -> bool {
        self.calls.values().any(|c| {
            c.kind == CallKind::P2p
                && c.dm_users.iter().any(|u| u == a)
                && c.occupants.iter().any(|(u, _)| u == b)
        })
    }

    // The peer id a tab named for a call, or for older apps that don't name one, the id it
    // announced for hosting.
    fn call_peer(&self, user: &str, conn: u64, named: Option<String>) -> Option<String> {
        named.or_else(|| {
            self.p2p
                .get(user)
                .and_then(|hosts| hosts.get(&conn))
                .map(|h| h.peer_id.clone())
        })
    }

    fn voice_snapshot(&self) -> Vec<WsEvent> {
        let mut evs: Vec<WsEvent> = self
            .rooms
            .iter()
            .map(|(cid, room)| room_state(*cid, room))
            .collect();
        for (id, call) in self.calls.iter() {
            evs.push(call_state(*id, call, call_phase(call)));
        }
        evs
    }

    fn voice_snapshot_for<'a, I: IntoIterator<Item = &'a String>>(
        &self,
        servers: I,
        user: Option<&str>,
    ) -> Vec<WsEvent> {
        let cids: BTreeSet<i64> = servers
            .into_iter()
            .filter_map(|s| self.index.server_rooms.get(s))
            .flatten()
            .copied()
            .collect();
        let mut evs: Vec<WsEvent> = cids
            .iter()
            .filter_map(|cid| self.rooms.get(cid).map(|room| room_state(*cid, room)))
            .collect();
        if let Some(user) = user {
            for id in self.calls_of(user) {
                if let Some(call) = self.calls.get(&id) {
                    evs.push(call_state(id, call, call_phase(call)));
                }
            }
        }
        evs
    }
}

struct Store {
    replica: Replica,
    last_id: String,
    own: u64,
    dirty: bool,
}

enum Reply {
    Forget,
    Waiter(oneshot::Sender<Outcome>),
}

struct Posted {
    op: Op,
    reply: Reply,
}

type Reads = BTreeMap<(String, String), (i64, i64)>;

struct Link {
    out: mpsc::Sender<Envelope>,
    seq: Mutex<u64>,
    pending: Mutex<BTreeMap<u64, Posted>>,
    publishing: AtomicBool,
    following: AtomicBool,
    caught_up: AtomicBool,
    diverged: AtomicBool,
    overflow: AtomicBool,
    reads: Mutex<Option<Reads>>,
}

#[derive(Default)]
struct Resolved {
    reposts: Vec<Op>,
    retry: Vec<Op>,
    late: Vec<(Op, Outcome)>,
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
    ) -> Resolved {
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
        let mut done = Resolved::default();
        for (Posted { op, reply }, outcome) in settled.into_iter().rev() {
            let hoster = op.hoster().map(str::to_string);
            match (outcome, reply) {
                (Some(_), Reply::Forget) => later.extend(hoster),
                (Some(outcome), Reply::Waiter(waiter)) => {
                    later.extend(hoster);
                    if let Err(outcome) = waiter.send(outcome) {
                        done.late.push((op, outcome));
                    }
                }
                (None, Reply::Waiter(waiter)) => {
                    if waiter.send(Outcome::Lost).is_err() && op.must_apply() {
                        done.retry.push(op);
                    }
                }
                (None, Reply::Forget) => match hoster {
                    Some(h) if later.contains(&h) => {}
                    hoster => {
                        later.extend(hoster);
                        done.reposts.push(op);
                    }
                },
            }
        }
        done.reposts.reverse();
        done.retry.reverse();
        done.late.reverse();
        done
    }
}

fn late_purge(op: Op, outcome: Outcome) -> Purge {
    match (op, outcome) {
        (Op::DropConn { user, conn: _ }, Outcome::Dropped(ends, drop)) => Purge {
            ends,
            p2p: vec![(user, drop)],
        },
        (_, Outcome::Departed(purge)) => purge,
        (_, Outcome::Ends(ends)) => Purge {
            ends,
            p2p: Vec::new(),
        },
        (_, Outcome::Ended(Ok(end))) => Purge {
            ends: vec![end],
            p2p: Vec::new(),
        },
        (_, _) => Purge::default(),
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
    order: Mutex<()>,
    router: Router,
    channels: Channels,
    conns: AtomicU64,
    link: Option<Link>,
    epoch: watch::Sender<Epoch>,
    aftermath: mpsc::UnboundedSender<Aftermath>,
    aftermath_rx: Mutex<Option<mpsc::UnboundedReceiver<Aftermath>>>,
    shown: mpsc::UnboundedSender<(String, bool)>,
    shown_rx: Mutex<Option<mpsc::UnboundedReceiver<(String, bool)>>>,
    release: Mutex<HashMap<String, (f64, Instant)>>,
    connects: Mutex<HashMap<String, (f64, Instant)>>,
    limits: Mutex<Limits>,
    reannounced: Mutex<(Option<Instant>, bool)>,
}

/// Per-user bounds on realtime connections: at most `conns_per_user` open at once across all
/// instances (the oldest is closed), and `connect_burst` new ones, then one per
/// `connect_every`, per instance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limits {
    pub conns_per_user: usize,
    pub connect_burst: u32,
    pub connect_every: Duration,
}

pub const CONNS_PER_USER: usize = 20;
pub const CONNECT_BURST: u32 = 20;
pub const CONNECTS_PER_MINUTE: u32 = 30;

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            conns_per_user: CONNS_PER_USER,
            connect_burst: CONNECT_BURST,
            connect_every: Duration::from_secs(60) / CONNECTS_PER_MINUTE,
        }
    }
}

fn take_token(
    buckets: &mut HashMap<String, (f64, Instant)>,
    key: &str,
    burst: u32,
    every: Duration,
    users_max: usize,
) -> bool {
    let now = Instant::now();
    if buckets.len() > users_max {
        buckets.retain(|_, (_, at)| now.duration_since(*at) < every * burst);
    }
    let (tokens, at) = buckets
        .entry(key.to_string())
        .or_insert((burst as f64, now));
    let refill = now.duration_since(*at).as_secs_f64() / every.as_secs_f64().max(f64::EPSILON);
    *tokens = (*tokens + refill).min(burst as f64);
    *at = now;
    match *tokens >= 1.0 {
        true => {
            *tokens -= 1.0;
            true
        }
        false => false,
    }
}

enum Waited {
    Got(Outcome),
    TimedOut,
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
    fn build(link: Option<Link>) -> Hub {
        let (aftermath, aftermath_rx) = mpsc::unbounded_channel();
        let (shown, shown_rx) = mpsc::unbounded_channel();
        Hub {
            inner: Arc::new(Inner {
                instance: rand::random(),
                tx: broadcast::channel(1024).0,
                store: Mutex::new(Store {
                    replica: Replica::default(),
                    last_id: String::new(),
                    own: 0,
                    dirty: true,
                }),
                order: Mutex::new(()),
                router: Router::default(),
                channels: Channels::default(),
                conns: AtomicU64::new(0),
                link,
                epoch: watch::channel(Epoch::default()).0,
                aftermath,
                aftermath_rx: Mutex::new(Some(aftermath_rx)),
                shown,
                shown_rx: Mutex::new(Some(shown_rx)),
                release: Mutex::new(HashMap::new()),
                connects: Mutex::new(HashMap::new()),
                limits: Mutex::new(Limits::default()),
                reannounced: Mutex::new((None, false)),
            }),
        }
    }

    pub fn new() -> Hub {
        Self::build(None)
    }

    pub fn replicated() -> (Hub, mpsc::Receiver<Envelope>) {
        let (out, rx) = mpsc::channel(OUT_CAP);
        let link = Link {
            out,
            seq: Mutex::new(0),
            pending: Mutex::new(BTreeMap::new()),
            publishing: AtomicBool::new(false),
            following: AtomicBool::new(false),
            caught_up: AtomicBool::new(false),
            diverged: AtomicBool::new(false),
            overflow: AtomicBool::new(false),
            reads: Mutex::new(None),
        };
        (Self::build(Some(link)), rx)
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

    pub fn open(&self, conn: u64, topics: &HashSet<Topic>) -> Inbox {
        self.inner.router.open(conn, topics)
    }

    pub fn close(&self, conn: u64) {
        self.inner.router.close(conn);
    }

    pub fn listen(&self, conn: u64, topics: &[Topic]) {
        self.inner.router.add(conn, topics);
    }

    pub fn reconcile(&self, conn: u64, want: &HashSet<Topic>, through: u64) {
        self.inner.router.reconcile(conn, want, through);
    }

    pub fn topics(&self, conn: u64) -> HashSet<Topic> {
        self.inner.router.topics(conn)
    }

    pub fn connections(&self) -> usize {
        self.inner.router.connections()
    }

    /// Whether `user` has an open signed-in connection on any instance, whatever they view.
    /// It is true for users who appear offline: callers must check `appear_offline` before
    /// showing it to anyone else. This instance's connections are read from the router, so a
    /// closed one counts as gone at once: unlike server presence, there is no grace here.
    pub fn is_online_anywhere(&self, user: &str) -> bool {
        let me = self.inner.instance;
        self.inner.router.has_user(user)
            || self.replica(|r| {
                r.seen
                    .get(user)
                    .is_some_and(|seen| seen.conns.keys().any(|c| owner(*c) != me))
            })
    }

    /// Whether `user` is shown online on the site: connected anywhere (or inside the offline
    /// grace) and not appearing offline. Friends see this.
    pub fn shown_anywhere(&self, user: &str) -> bool {
        self.replica(|r| r.seen.get(user).is_some_and(|seen| seen.up && !seen.hidden))
    }

    /// Delivers `ev` to this instance's connections only. Each instance sends it itself, for
    /// events every instance derives from the replica.
    pub fn deliver_local(&self, ev: WsEvent) {
        if self.inner.tx.receiver_count() > 0 {
            let _ = self.inner.tx.send(ev.clone());
        }
        self.inner.router.deliver(ev);
    }

    /// Whether `user` has an open connection on this instance.
    pub fn listens_here(&self, user: &str) -> bool {
        self.inner.router.has_user(user)
    }

    pub fn channels(&self) -> &Channels {
        &self.inner.channels
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
        self.inner.channels.clear();
        self.inner.epoch.send_modify(|e| {
            e.count += 1;
            e.lossy += lossy as u64;
        });
    }

    pub fn take_aftermath(&self) -> Option<mpsc::UnboundedReceiver<Aftermath>> {
        self.inner.aftermath_rx.lock().unwrap().take()
    }

    /// Users who became visible on the site (`true`) or stopped being visible (`false`), in
    /// order, as this instance's replica sees it (`WsEvent::UserShown`, never delivered).
    pub fn take_shown(&self) -> Option<mpsc::UnboundedReceiver<(String, bool)>> {
        self.inner.shown_rx.lock().unwrap().take()
    }

    fn dispatch(&self, events: Vec<WsEvent>, live: bool) {
        for ev in events {
            self.inner.channels.observe(&ev);
            if !live {
                continue;
            }
            if let WsEvent::UserShown { username, online } = ev {
                let _ = self.inner.shown.send((username, online));
                continue;
            }
            if self.inner.tx.receiver_count() > 0 {
                let _ = self.inner.tx.send(ev.clone());
            }
            self.inner.router.deliver(ev);
        }
    }

    fn local(&self, op: Op) -> Outcome {
        let mut store = self.inner.store.lock().unwrap();
        let Applied {
            events,
            outcome,
            purge,
            purged: _,
            evicted,
        } = store.replica.apply(self.inner.instance, op, now_ms());
        let order = self.inner.order.lock().unwrap();
        drop(store);
        self.dispatch(events, true);
        drop(order);
        self.evict(&evicted);
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
                self.send(link, &mut seq, op, Reply::Forget);
            }
        }
    }

    fn send(&self, link: &Link, seq: &mut u64, op: Op, reply: Reply) {
        *seq += 1;
        let keep = match reply {
            Reply::Forget => op.repostable(),
            Reply::Waiter(_) => true,
        };
        if keep {
            let mut pending = link.pending.lock().unwrap();
            while pending.len() >= PENDING_CAP {
                let Some((_, evicted)) = pending.pop_first() else {
                    break;
                };
                if let Reply::Waiter(waiter) = evicted.reply {
                    let _ = waiter.send(Outcome::Lost);
                }
                link.overflow.store(true, Ordering::Relaxed);
            }
            pending.insert(
                *seq,
                Posted {
                    op: op.clone(),
                    reply,
                },
            );
        }
        let env = Envelope {
            origin: self.inner.instance,
            seq: *seq,
            op,
        };
        if let Err(mpsc::error::TrySendError::Full(_)) = link.out.try_send(env) {
            let n = DROPPED.fetch_add(1, Ordering::Relaxed);
            if n.is_multiple_of(1000) {
                warn!(
                    "realtime publish queue is full ({OUT_CAP} ops); dropped {} op(s) so far, they are reposted or re-announced once the bus recovers",
                    n + 1
                );
            }
        }
    }

    fn settle_own<F: FnMut(u64, &Op) -> Option<Outcome>>(
        &self,
        link: &Link,
        through: u64,
        applied: F,
    ) {
        let mut seq = link.seq.lock().unwrap();
        let Resolved {
            reposts,
            retry,
            late,
        } = link.resolve(link.take_through(through), applied);
        for op in retry {
            warn!("a realtime cleanup op was lost on the bus; posting it again");
            let (waiter, _) = oneshot::channel();
            self.send(link, &mut seq, op, Reply::Waiter(waiter));
        }
        if !reposts.is_empty() {
            let (now, checked): (Vec<Op>, Vec<Op>) =
                reposts.into_iter().partition(|op| op.hoster().is_some());
            warn!(
                "{} realtime ops were lost on the bus; posting them again ({} after a database check)",
                now.len() + checked.len(),
                checked.len()
            );
            for op in now {
                self.send(link, &mut seq, op, Reply::Forget);
            }
            if !checked.is_empty() {
                let _ = self.inner.aftermath.send(Aftermath::Repost(checked));
            }
        }
        drop(seq);
        for (op, outcome) in late {
            let purge = late_purge(op, outcome);
            if !purge.is_empty() {
                let _ = self.inner.aftermath.send(Aftermath::Settle(purge));
            }
        }
    }

    async fn call(&self, op: Op) -> Waited {
        let link = match &self.inner.link {
            None => return Waited::Got(self.local(op)),
            Some(link) => link,
        };
        let (tx, rx) = oneshot::channel();
        {
            let mut seq = link.seq.lock().unwrap();
            self.send(link, &mut seq, op, Reply::Waiter(tx));
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(outcome)) => Waited::Got(outcome),
            Ok(Err(_)) => Waited::Got(Outcome::Done),
            Err(_) => Waited::TimedOut,
        }
    }

    async fn ask(&self, op: Op) -> Outcome {
        match self.call(op).await {
            Waited::Got(outcome) => outcome,
            Waited::TimedOut => {
                warn!("realtime bus did not confirm an op in time");
                Outcome::Lost
            }
        }
    }

    async fn call_applied(&self, op: Op) -> Outcome {
        loop {
            match self.call(op.clone()).await {
                Waited::Got(Outcome::Lost) => {
                    warn!("realtime op was lost on the bus, posting it again")
                }
                Waited::Got(outcome) => return outcome,
                Waited::TimedOut => {
                    warn!(
                        "realtime bus did not confirm a cleanup op in time; it finishes once the bus recovers"
                    );
                    return Outcome::Done;
                }
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
        let mut store = self.inner.store.lock().unwrap();
        store.last_id = id.to_string();
        if !store.replica.admit(origin, seq) {
            return;
        }
        let skipped = mine && seq > store.own + 1;
        if mine {
            store.own = store.own.max(seq);
        }
        let beat = matches!(op, Op::Heartbeat);
        let reannounce = matches!(op, Op::Reannounce);
        let Applied {
            events,
            outcome,
            purge,
            purged,
            evicted,
        } = store.replica.apply(origin, op, t_ms as i64);
        store.dirty |= !beat || !events.is_empty() || !purged.is_empty();
        let order = self.inner.order.lock().unwrap();
        drop(store);
        self.dispatch(events, live);
        drop(order);
        self.evict(&evicted);
        if reannounce && live {
            self.reannounce();
        }
        if mine {
            let mut outcome = Some(outcome);
            self.settle_own(link, seq, |s, _| match s == seq {
                true => outcome.take(),
                false => None,
            });
            if !purge.is_empty() {
                let _ = self.inner.aftermath.send(Aftermath::Settle(purge));
            }
            if link.overflow.swap(false, Ordering::Relaxed) {
                warn!("realtime ops were dropped while the bus was unreachable; resyncing clients");
                self.resync(true);
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

    pub fn snapshot_state(&self, force: bool) -> Option<(String, Replica)> {
        let mut store = self.inner.store.lock().unwrap();
        let gap = self
            .inner
            .link
            .as_ref()
            .is_some_and(|l| l.diverged.load(Ordering::Relaxed));
        if store.last_id.is_empty() || gap || !(force || store.dirty) {
            return None;
        }
        store.dirty = false;
        Some((store.last_id.clone(), store.replica.detached()))
    }

    pub fn mark_dirty(&self) {
        self.inner.store.lock().unwrap().dirty = true;
    }

    pub fn snapshot(&self) -> Option<(String, String)> {
        let (id, replica) = self.snapshot_state(true)?;
        serde_json::to_string(&replica).ok().map(|json| (id, json))
    }

    pub fn restore(&self, last_id: &str, json: &str) -> serde_json::Result<()> {
        let replica: Replica = serde_json::from_str(json)?;
        let legacy = replica.legacy;
        let me = self.inner.instance;
        let applied = replica.peers.get(&me).map_or(0, |p| p.seq);
        let mut store = self.inner.store.lock().unwrap();
        let before = std::mem::replace(&mut store.replica, replica);
        store.last_id = last_id.to_string();
        store.own = store.own.max(applied);
        store.dirty = true;
        self.inner.channels.clear();
        let after = &store.replica;
        if let Some(link) = &self.inner.link {
            self.settle_own(link, applied, |seq, op| match after.kept(me, seq) {
                true => after.recovered(&before, me, op),
                false => None,
            });
        }
        drop(store);
        if legacy {
            warn!(
                "restored a realtime snapshot from an older version; asking every instance to announce its connections again"
            );
            self.post(Op::Reannounce);
        }
        Ok(())
    }

    fn evict(&self, conns: &[u64]) {
        for conn in conns {
            if owner(*conn) == self.inner.instance {
                self.inner.router.evict(*conn);
            }
        }
    }

    // Every connection on this instance announces itself again. Repeated requests within
    // `REANNOUNCE_EVERY` are folded into one more at its end.
    fn reannounce(&self) {
        let now = Instant::now();
        let mut at = self.inner.reannounced.lock().unwrap();
        let wait = match at.0 {
            Some(last) if now.duration_since(last) < REANNOUNCE_EVERY => {
                REANNOUNCE_EVERY - now.duration_since(last)
            }
            _ => {
                at.0 = Some(now);
                drop(at);
                self.resync(false);
                return;
            }
        };
        if std::mem::replace(&mut at.1, true) {
            return;
        }
        drop(at);
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            self.inner.reannounced.lock().unwrap().1 = false;
            return;
        };
        let hub = self.clone();
        rt.spawn(async move {
            tokio::time::sleep(wait).await;
            *hub.inner.reannounced.lock().unwrap() = (Some(Instant::now()), false);
            hub.resync(false);
        });
    }

    pub fn heartbeat(&self) {
        if self.is_replicated() {
            self.post(Op::Heartbeat);
        }
    }

    /// Ends the offline grace of users whose time is up. Replicated hubs do it on every op
    /// (heartbeats keep them coming), so this only acts without a bus.
    pub fn tick(&self) {
        if !self.is_replicated() {
            self.local(Op::Heartbeat);
        }
    }

    #[cfg(test)]
    pub(crate) fn expire_presence(&self) {
        let mut store = self.inner.store.lock().unwrap();
        let mut evs = Vec::new();
        let t = store.replica.clock.max(now_ms()) + PRESENCE_GRACE_MS;
        store.replica.expire(t, &mut evs);
        let order = self.inner.order.lock().unwrap();
        drop(store);
        self.dispatch(evs, true);
        drop(order);
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

    pub fn coalesce_reads(&self) {
        if let Some(link) = &self.inner.link {
            link.reads.lock().unwrap().get_or_insert_default();
        }
    }

    pub fn flush_reads(&self) {
        let Some(link) = &self.inner.link else {
            return;
        };
        let batch = match link.reads.lock().unwrap().as_mut() {
            Some(reads) => std::mem::take(reads),
            None => return,
        };
        for ((username, scope), (last_read, pings_until)) in batch {
            self.post(Op::Broadcast {
                event: WsEvent::ReadUpdated {
                    username,
                    scope,
                    last_read,
                    pings_until,
                },
            });
        }
    }

    pub fn broadcast(&self, ev: WsEvent) {
        if let (
            WsEvent::ReadUpdated {
                username,
                scope,
                last_read,
                pings_until,
            },
            Some(link),
        ) = (&ev, &self.inner.link)
            && let Some(reads) = link.reads.lock().unwrap().as_mut()
        {
            let at = reads
                .entry((username.clone(), scope.clone()))
                .or_insert((*last_read, *pings_until));
            *at = (at.0.max(*last_read), at.1.max(*pings_until));
            return;
        }
        self.post(Op::Broadcast { event: ev });
    }

    pub async fn broadcast_confirmed(&self, ev: WsEvent) -> bool {
        !matches!(self.ask(Op::Broadcast { event: ev }).await, Outcome::Lost)
    }

    pub async fn voice_join(
        &self,
        user: &str,
        conn: u64,
        server: &str,
        channel_id: i64,
    ) -> Vec<CallEnd> {
        self.voice_join_capped(user, conn, server, channel_id, 0)
            .await
            .unwrap_or_default()
    }

    pub async fn voice_join_capped(
        &self,
        user: &str,
        conn: u64,
        server: &str,
        channel_id: i64,
        cap: usize,
    ) -> Result<Vec<CallEnd>, String> {
        let op = Op::VoiceJoin {
            user: user.to_string(),
            conn,
            server: server.to_string(),
            channel_id,
            cap,
        };
        match self.ask(op).await {
            Outcome::Ends(ends) => Ok(ends),
            Outcome::Full => Err(format!("This voice channel is full ({cap} people)")),
            Outcome::Lost => Err("Realtime service unavailable".to_string()),
            _ => Ok(Vec::new()),
        }
    }

    pub async fn voice_leave(&self, user: &str) {
        let op = Op::VoiceLeave {
            user: user.to_string(),
        };
        self.call_applied(op).await;
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn call_start(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
        dm_users: Vec<String>,
        kind: CallKind,
        video: bool,
        log_id: i64,
        peer_id: Option<String>,
    ) -> Result<(), String> {
        let op = Op::CallStart {
            user: user.to_string(),
            conn,
            dm_id,
            dm_users,
            kind,
            video,
            log_id,
            call_id: crate::identity::random_id(),
            peer_id,
        };
        match self.ask(op).await {
            Outcome::Started(res) => res,
            _ => Err("Realtime service unavailable".to_string()),
        }
    }

    pub async fn call_accept(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
        peer_id: Option<String>,
    ) -> Result<(i64, Vec<String>), String> {
        let op = Op::CallAccept {
            user: user.to_string(),
            conn,
            dm_id,
            peer_id,
        };
        match self.ask(op).await {
            Outcome::Accepted(res) => res,
            _ => Err("Realtime service unavailable".to_string()),
        }
    }

    pub async fn call_end(&self, user: &str, dm_id: i64) -> Result<CallEnd, String> {
        let op = Op::CallEnd {
            user: user.to_string(),
            dm_id,
        };
        match self.ask(op).await {
            Outcome::Ended(res) => res,
            _ => Err("Realtime service unavailable".to_string()),
        }
    }

    fn replica<R>(&self, read: impl FnOnce(&Replica) -> R) -> R {
        read(&self.inner.store.lock().unwrap().replica)
    }

    pub fn rtc_shared(
        &self,
        a: &str,
        b: &str,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
    ) -> bool {
        self.replica(|r| r.rtc_shared(a, b, channel_id, dm_id))
    }

    pub fn in_p2p_call(&self, a: &str, b: &str) -> bool {
        self.replica(|r| r.in_p2p_call(a, b))
    }

    /// The server of the voice room `channel_id`, while anyone is in it.
    pub fn room_server(&self, channel_id: i64) -> Option<String> {
        self.replica(|r| r.rooms.get(&channel_id).map(|room| room.server.clone()))
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
        match self.ask(Op::SweepVoice { idle }).await {
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

    // The ids `user` hosts across all their tabs.
    pub fn p2p_ids(&self, user: &str) -> Option<Vec<String>> {
        self.replica(|r| {
            let mut ids: Vec<String> = Vec::new();
            for id in r.p2p.get(user)?.values().flat_map(|h| h.ids.iter()) {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
            Some(ids)
        })
    }

    // The peer id of the newest tab of `user` that hosts the file `id`.
    pub fn p2p_host_of(&self, user: &str, id: &str) -> Option<String> {
        self.replica(|r| {
            r.p2p
                .get(user)?
                .values()
                .rev()
                .find(|h| h.ids.iter().any(|x| x == id))
                .map(|h| h.peer_id.clone())
        })
    }

    // Peer id requests for downloads: a burst of RELEASE_BURST, then one every RELEASE_EVERY,
    // per user and per process.
    pub fn release_ok(&self, user: &str) -> bool {
        take_token(
            &mut self.inner.release.lock().unwrap(),
            user,
            RELEASE_BURST,
            RELEASE_EVERY,
            RELEASE_USERS_MAX,
        )
    }

    /// Whether `user` may open another realtime connection now: within the burst and rate
    /// both on this instance and across the cluster. The cluster part reads the connections
    /// the replica has seen open, against the replica clock (the last op, at most a heartbeat
    /// old), and starts over once the user has been offline past the grace.
    pub fn connect_ok(&self, user: &str) -> bool {
        let Limits {
            conns_per_user: _,
            connect_burst,
            connect_every,
        } = self.limits();
        let every = connect_every.as_millis() as i64;
        let (opened, clock) =
            self.replica(|r| (r.seen.get(user).map_or(0, |seen| seen.opened), r.clock));
        if opened.saturating_sub((i64::from(connect_burst) - 1) * every) > clock {
            return false;
        }
        take_token(
            &mut self.inner.connects.lock().unwrap(),
            user,
            connect_burst,
            connect_every,
            CONNECT_USERS_MAX,
        )
    }

    pub fn limits(&self) -> Limits {
        *self.inner.limits.lock().unwrap()
    }

    pub fn set_limits(&self, limits: Limits) {
        *self.inner.limits.lock().unwrap() = limits;
    }

    pub fn p2p_of(&self, user: &str) -> Option<(String, Vec<String>)> {
        self.replica(|r| {
            r.p2p
                .get(user)
                .and_then(|hosts| hosts.last_key_value())
                .map(|(_, h)| (h.peer_id.clone(), h.ids.clone()))
        })
    }

    fn presence<R>(&self, server: &str, read: impl FnOnce(&BTreeSet<String>) -> R) -> Option<R> {
        self.replica(|r| r.index.presence.get(server).map(read))
    }

    pub fn online_set(&self, server: &str) -> HashSet<String> {
        self.presence(server, |users| users.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn online_after(&self, server: &str, after: Option<&str>, n: usize) -> Vec<String> {
        self.presence(server, |users| {
            let range = match after {
                Some(a) => users
                    .range::<str, _>((std::ops::Bound::Excluded(a), std::ops::Bound::Unbounded)),
                None => users.range::<str, _>(..),
            };
            range.take(n).cloned().collect()
        })
        .unwrap_or_default()
    }

    pub fn online_among<'a>(&self, server: &str, names: &'a [String]) -> HashSet<&'a str> {
        self.presence(server, |users| {
            names
                .iter()
                .filter(|n| users.contains(n.as_str()))
                .map(String::as_str)
                .collect()
        })
        .unwrap_or_default()
    }

    pub fn online_count(&self, server: &str) -> i64 {
        self.presence(server, |users| users.len() as i64)
            .unwrap_or(0)
    }

    pub fn is_online(&self, server: &str, username: &str) -> bool {
        self.presence(server, |users| users.contains(username))
            .unwrap_or(false)
    }

    /// Announces an open connection of `user`, `lit` unless it waits for the database. With
    /// `scope`, it also replaces the user's member servers and appear-offline flag, which all
    /// their connections share.
    pub fn announce(&self, user: &str, conn: u64, lit: bool, scope: Option<Scope>) {
        self.post(Op::Online {
            user: user.to_string(),
            conn,
            lit,
            cap: self.limits().conns_per_user,
            scope,
            every: self.limits().connect_every.as_millis() as usize,
        });
    }

    pub fn set_online<S: AsRef<str>>(&self, user: &str, conn: u64, servers: &[S]) {
        let servers = servers.iter().map(|s| s.as_ref().to_string()).collect();
        let scope = Scope {
            servers,
            ..Scope::default()
        };
        self.announce(user, conn, true, Some(scope));
    }

    /// Changes the member servers or appear-offline flag (with its version) of `user` by a
    /// delta.
    pub fn rescope(
        &self,
        user: &str,
        add: Vec<String>,
        remove: Vec<String>,
        hidden: Option<(bool, i64)>,
    ) {
        if add.is_empty() && remove.is_empty() && hidden.is_none() {
            return;
        }
        self.post(Op::Rescope {
            user: user.to_string(),
            add,
            remove,
            hidden: hidden.map(|(hidden, _)| hidden),
            seq: hidden.map_or(0, |(_, seq)| seq),
        });
    }

    pub fn reannounce_all(&self) {
        self.post(Op::Reannounce);
    }

    pub fn force_offline(&self, server: &str, user: &str) {
        self.post(Op::ForceOffline {
            server: server.to_string(),
            user: user.to_string(),
        });
    }

    pub fn rooms_in(&self, server: &str, channel_id: Option<i64>) -> Vec<(i64, Vec<String>)> {
        self.replica(|replica| {
            replica
                .index
                .server_rooms
                .get(server)
                .into_iter()
                .flatten()
                .filter(|cid| channel_id.is_none_or(|c| c == **cid))
                .filter_map(|cid| {
                    replica
                        .rooms
                        .get(cid)
                        .map(|room| (*cid, room.users.iter().map(|(u, _)| u.clone()).collect()))
                })
                .collect()
        })
    }

    pub fn evict_voice(&self, user: &str, channel_id: i64) {
        self.post(Op::EvictVoice {
            user: user.to_string(),
            channel_id,
        });
    }

    pub fn voice_snapshot(&self) -> Vec<WsEvent> {
        self.replica(Replica::voice_snapshot)
    }

    pub fn voice_snapshot_for<'a, I: IntoIterator<Item = &'a String>>(
        &self,
        servers: I,
        user: Option<&str>,
    ) -> Vec<WsEvent> {
        self.replica(|r| r.voice_snapshot_for(servers, user))
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

        pub(crate) fn advance(&self, ms: i64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }

        pub(crate) fn join(&self) -> Hub {
            let (hub, out) = Hub::replicated();
            self.attach(hub.clone(), out, None);
            hub
        }

        fn attach(&self, hub: Hub, mut out: mpsc::Receiver<Envelope>, after: Option<&str>) {
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
                    online_count: _,
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
                    video: _,
                    call_id: _,
                    answered_at: _,
                    peers: _,
                } => Some((*dm_id, *state)),
                _ => None,
            })
            .collect()
    }

    async fn outlive(bus: &MemBus, alive: &Hub) {
        for _ in 0..3 {
            bus.advance(DEAD_AFTER_MS / 3);
            alive.flush().await;
        }
        bus.advance(1_000);
        alive.flush().await;
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
                    cap: 0,
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
                    cap: 0,
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
                    video: false,
                    log_id: 70,
                    call_id: String::new(),
                    peer_id: None,
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
            (1, Op::Heartbeat, T0 + 20_000),
            (1, Op::Heartbeat, T0 + 40_000),
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
        assert_eq!(
            replica.index.presence.keys().collect::<Vec<_>>(),
            vec!["rchat"]
        );
    }

    #[test]
    fn sweep_uses_op_time() {
        let mut replica = Replica::default();
        let join = Op::VoiceJoin {
            user: "alice".to_string(),
            conn: 1 << 32,
            server: "rchat".to_string(),
            channel_id: 5,
            cap: 0,
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
        hub.set_online("alice", a, &["rchat"]);
        hub.set_online("alice", b, &["rchat"]);
        assert!(hub.is_online("rchat", "alice"));
        assert_eq!(hub.online_count("rchat"), 1);
        hub.announce("alice", a, false, None);
        assert!(hub.is_online("rchat", "alice"));
        hub.announce("alice", b, false, None);
        assert!(hub.is_online("rchat", "alice"));
        hub.expire_presence();
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
            rules: None,
        });
        assert!(hub.rooms_in("rchat", None).is_empty());
        assert!(hub.ready());
    }

    fn online_op(user: &str, conn: u64, cap: usize, servers: Option<&[&str]>) -> Op {
        Op::Online {
            user: user.to_string(),
            conn,
            lit: true,
            cap,
            scope: servers.map(|servers| Scope {
                servers: servers.iter().map(|v| v.to_string()).collect(),
                hidden: false,
                seq: 0,
            }),
            every: 0,
        }
    }

    fn drop_op(user: &str, conn: u64) -> Op {
        Op::DropConn {
            user: user.to_string(),
            conn,
        }
    }

    #[test]
    fn presence_is_kept_per_user_and_reads_old_state() {
        let s = |v: &str| v.to_string();
        let (a1, a2, bob) = (1_u64 << 32, (1_u64 << 32) | 1, (1_u64 << 32) | 2);
        let mut replica = Replica::default();
        let first = replica.apply(1, online_op("alice", a1, 0, Some(&["one", "two"])), T0);
        assert_eq!(
            presence_of(&first.events),
            vec![(s("one"), s("alice"), true), (s("two"), s("alice"), true)]
        );
        assert!(
            replica
                .apply(1, online_op("alice", a2, 0, None), T0 + 1)
                .events
                .is_empty()
        );
        replica.apply(1, online_op("bob", bob, 0, Some(&[])), T0 + 2);
        let moved = replica.apply(
            1,
            Op::Rescope {
                user: s("alice"),
                add: vec![s("three")],
                remove: vec![s("one")],
                hidden: None,
                seq: 0,
            },
            T0 + 3,
        );
        assert_eq!(
            presence_of(&moved.events),
            vec![
                (s("one"), s("alice"), false),
                (s("three"), s("alice"), true)
            ]
        );
        let json = serde_json::to_string(&replica).unwrap();
        assert!(json.contains(
            r#""alice":{"servers":["three","two"],"conns":{"4294967296":{"lit":true,"at":1700000000000},"4294967297":{"lit":true,"at":1700000000001}},"up":true,"shows":1700000010000}"#
        ));
        assert!(!json.contains("\"presence\""));
        let reloaded: Replica = serde_json::from_str(&json).unwrap();
        assert!(!reloaded.legacy);
        assert_eq!(serde_json::to_string(&reloaded).unwrap(), json);
        assert_eq!(reloaded.index, reindexed(&replica));

        let old = r#"{"presence":{"rchat":{"carol":[8589934592]}},"rooms":{},"calls":{},"p2p":{},"peers":{},"clock":0}"#;
        let mut legacy: Replica = serde_json::from_str(old).unwrap();
        assert!(legacy.legacy);
        assert_eq!(
            legacy.index.presence,
            BTreeMap::from([(s("rchat"), BTreeSet::from([s("carol")]))])
        );
        let viewing: Op = serde_json::from_str(
            r#"{"op":"viewing","user":"dave","conn":8589934593,"old":null,"new":"rchat"}"#,
        )
        .unwrap();
        legacy.apply(2, viewing, T0);
        assert!(legacy.index.presence["rchat"].contains("dave"));
        let present: Op = serde_json::from_str(
            r#"{"op":"present","user":"dave","conn":8589934593,"server":null}"#,
        )
        .unwrap();
        assert!(legacy.apply(2, present, T0 + 1).events.is_empty());
        legacy.apply(2, drop_op("carol", 2 << 32), T0 + 2);
        let gone = legacy.apply(2, Op::Heartbeat, T0 + 2 + PRESENCE_GRACE_MS);
        assert_eq!(
            presence_of(&gone.events),
            vec![
                (s("rchat"), s("dave"), false),
                (s("rchat"), s("carol"), false)
            ]
        );
        assert!(legacy.seen.is_empty() && legacy.index.presence.is_empty());
        assert_eq!(legacy.index, reindexed(&legacy));
    }

    #[test]
    fn offline_waits_out_the_grace() {
        let s = |v: &str| v.to_string();
        let (c1, c2, c3) = (1_u64 << 32, (1_u64 << 32) | 1, (1_u64 << 32) | 2);
        let mut replica = Replica::default();
        let at = |r: &mut Replica, op: Op, t: i64| presence_of(&r.apply(1, op, T0 + t).events);
        assert_eq!(
            at(&mut replica, online_op("alice", c1, 0, Some(&["one"])), 0),
            vec![(s("one"), s("alice"), true)]
        );
        assert!(at(&mut replica, drop_op("alice", c1), 1_000).is_empty());
        assert!(replica.index.presence["one"].contains("alice"));
        assert!(
            at(
                &mut replica,
                online_op("alice", c2, 0, Some(&["one"])),
                1_000 + PRESENCE_GRACE_MS - 1
            )
            .is_empty()
        );
        assert!(at(&mut replica, Op::Heartbeat, 30_000).is_empty());
        assert!(at(&mut replica, drop_op("alice", c2), 40_000).is_empty());
        assert!(at(&mut replica, Op::Heartbeat, 40_000 + PRESENCE_GRACE_MS - 1).is_empty());
        assert_eq!(
            at(&mut replica, Op::Heartbeat, 40_000 + PRESENCE_GRACE_MS),
            vec![(s("one"), s("alice"), false)]
        );
        assert!(replica.seen.is_empty());

        let mode = |hidden: bool| Op::Broadcast {
            event: WsEvent::PresenceMode {
                username: s("bob"),
                appear_offline: hidden,
                seq: 0,
            },
        };
        let t = 100_000;
        assert_eq!(
            at(&mut replica, online_op("bob", c3, 0, Some(&["one"])), t),
            vec![(s("one"), s("bob"), true)]
        );
        assert_eq!(
            at(&mut replica, mode(true), t + 1_000),
            vec![(s("one"), s("bob"), false)]
        );
        assert!(replica.seen["bob"].hidden && !replica.seen["bob"].up);
        assert_eq!(
            at(&mut replica, mode(false), t + 30_000),
            vec![(s("one"), s("bob"), true)]
        );
        let banned = Op::Broadcast {
            event: WsEvent::Banned { username: s("bob") },
        };
        assert_eq!(
            at(&mut replica, banned, t + 31_000),
            vec![(s("one"), s("bob"), false)]
        );
        assert_eq!(replica.index, reindexed(&replica));
    }

    #[test]
    fn appear_offline_hides_at_once_even_inside_the_grace() {
        let s = |v: &str| v.to_string();
        let (c1, c2, c3) = (1_u64 << 32, (1_u64 << 32) | 1, (2_u64 << 32) | 1);
        let mut replica = Replica::default();
        let at = |r: &mut Replica, op: Op, t: i64| presence_of(&r.apply(1, op, T0 + t).events);
        let mode = |hidden: bool| Op::Broadcast {
            event: WsEvent::PresenceMode {
                username: s("bob"),
                appear_offline: hidden,
                seq: 0,
            },
        };
        assert_eq!(
            at(
                &mut replica,
                online_op("bob", c1, 0, Some(&["one", "two"])),
                0
            ),
            vec![(s("one"), s("bob"), true), (s("two"), s("bob"), true)]
        );
        // A reconnect inside the grace is silent, and appear offline right after it hides
        // bob at once in every server.
        assert!(at(&mut replica, drop_op("bob", c1), 1_000).is_empty());
        assert!(
            at(
                &mut replica,
                online_op("bob", c2, 0, Some(&["one", "two"])),
                2_000
            )
            .is_empty()
        );
        assert_eq!(
            at(&mut replica, mode(true), 2_001),
            vec![(s("one"), s("bob"), false), (s("two"), s("bob"), false)]
        );
        assert!(!replica.index.presence.contains_key("one"));
        // Also while lingering after a disconnect (another device still connected elsewhere
        // is dark): the hide does not wait for the grace.
        assert_eq!(
            at(&mut replica, mode(false), 3_000),
            vec![(s("one"), s("bob"), true), (s("two"), s("bob"), true)]
        );
        assert!(at(&mut replica, drop_op("bob", c2), 4_000).is_empty());
        assert!(replica.seen["bob"].gone > 0);
        assert_eq!(
            at(
                &mut replica,
                Op::Rescope {
                    user: s("bob"),
                    add: vec![],
                    remove: vec![],
                    hidden: Some(true),
                    seq: 0,
                },
                4_500
            ),
            vec![(s("one"), s("bob"), false), (s("two"), s("bob"), false)]
        );
        // Only bob's rate state and appear-offline version stay, until the rates drain.
        let rest = &replica.seen["bob"];
        assert!(rest.conns.is_empty() && rest.servers.is_empty() && !rest.up && rest.hidden);
        assert!(replica.index.scoped.is_empty() && replica.index.lingering.is_empty());
        // A connection that opens already hidden never shows.
        let hidden = Op::Online {
            user: s("bob"),
            conn: c3,
            lit: true,
            cap: 0,
            scope: Some(Scope {
                servers: vec![s("one")],
                hidden: true,
                seq: 0,
            }),
            every: 0,
        };
        assert!(at(&mut replica, hidden, 5_000).is_empty());
        assert_eq!(replica.index, reindexed(&replica));
    }

    #[test]
    fn a_stale_appear_offline_value_never_undoes_a_newer_one() {
        let s = |v: &str| v.to_string();
        let (c1, c2) = (1_u64 << 32, 2_u64 << 32);
        let mut replica = Replica::default();
        let at = |r: &mut Replica, op: Op, t: i64| presence_of(&r.apply(1, op, T0 + t).events);
        let mode = |hidden: bool, seq: i64| Op::Broadcast {
            event: WsEvent::PresenceMode {
                username: s("bob"),
                appear_offline: hidden,
                seq,
            },
        };
        let opened = |conn: u64, hidden: bool, seq: i64| Op::Online {
            user: s("bob"),
            conn,
            lit: true,
            cap: 0,
            scope: Some(Scope {
                servers: vec![s("one")],
                hidden,
                seq,
            }),
            every: 0,
        };
        assert_eq!(
            at(&mut replica, opened(c1, false, 4), 0),
            vec![(s("one"), s("bob"), true)]
        );
        assert_eq!(
            at(&mut replica, mode(true, 5), 1_000),
            vec![(s("one"), s("bob"), false)]
        );
        // A connection that read version 4 before the change announces after it, and a delta
        // or an event of an older version arrives late: bob stays hidden.
        assert!(at(&mut replica, opened(c2, false, 4), 2_000).is_empty());
        let late = Op::Rescope {
            user: s("bob"),
            add: vec![],
            remove: vec![],
            hidden: Some(false),
            seq: 4,
        };
        assert!(at(&mut replica, late, 3_000).is_empty());
        assert!(at(&mut replica, mode(false, 4), 4_000).is_empty());
        assert!(!replica.index.presence.contains_key("one"));
        assert_eq!(
            (replica.seen["bob"].hidden, replica.seen["bob"].mode),
            (true, 5)
        );
        // The same version again, or a newer one, applies.
        assert!(at(&mut replica, mode(true, 5), 5_000).is_empty());
        assert_eq!(
            at(&mut replica, mode(false, 6), 6_000),
            vec![(s("one"), s("bob"), true)]
        );
        assert_eq!(replica.index, reindexed(&replica));
        // A new connection whose scope adds a server and hides bob shows him nowhere first.
        let wider = Op::Online {
            user: s("bob"),
            conn: c2,
            lit: true,
            cap: 0,
            scope: Some(Scope {
                servers: vec![s("one"), s("two")],
                hidden: true,
                seq: 7,
            }),
            every: 0,
        };
        assert_eq!(
            at(&mut replica, wider, 7_000),
            vec![(s("one"), s("bob"), false)]
        );
        assert_eq!(replica.index, reindexed(&replica));
    }

    #[test]
    fn hidden_users_keep_their_connect_count_after_closing() {
        let s = |v: &str| v.to_string();
        let mut replica = Replica::default();
        let every = 60_000;
        let mut events = 0;
        for i in 0..3_u64 {
            let conn = (1_u64 << 32) | i;
            let open = Op::Online {
                user: s("bob"),
                conn,
                lit: true,
                cap: 0,
                scope: Some(Scope {
                    servers: vec![s("one")],
                    hidden: true,
                    seq: 1,
                }),
                every,
            };
            let t = T0 + i as i64 * 100;
            events += replica.apply(1, open, t).events.len();
            events += replica.apply(1, drop_op("bob", conn), t + 50).events.len();
            assert_eq!(replica.index, reindexed(&replica));
        }
        assert_eq!(events, 0);
        // Three opens are still counted, though bob has no connection left.
        let rest = &replica.seen["bob"];
        assert!(rest.conns.is_empty() && rest.servers.is_empty() && rest.hidden);
        assert_eq!(rest.opened, T0 + 3 * every as i64);
        assert_eq!(rest.wake, rest.opened);
        // Once the count drains, bob is forgotten.
        let later = online_op("carol", 2 << 32, 0, Some(&[]));
        replica.apply(1, later, rest.opened);
        assert!(!replica.seen.contains_key("bob"));
        assert!(replica.index.waking.iter().all(|(_, u)| u != "bob"));
    }

    #[test]
    fn appear_offline_toggle_storms_are_bounded_and_end_in_the_last_state() {
        let s = |v: &str| v.to_string();
        let names: Vec<String> = (0..50).map(|i| format!("s{i:02}")).collect();
        let all: Vec<&str> = names.iter().map(String::as_str).collect();
        let n = all.len();
        let mut replica = Replica::default();
        let at = |r: &mut Replica, op: Op, t: i64| presence_of(&r.apply(1, op, T0 + t).events);
        let mode = |hidden: bool| Op::Broadcast {
            event: WsEvent::PresenceMode {
                username: s("bob"),
                appear_offline: hidden,
                seq: 0,
            },
        };
        assert_eq!(
            at(&mut replica, online_op("bob", 1 << 32, 0, Some(&all)), 0).len(),
            n
        );
        // 200 toggles in 2 s: every hide is immediate; shows past the burst wait.
        let mut events = 0;
        for i in 0..200_i64 {
            let ev = at(&mut replica, mode(i % 2 == 0), 1 + i * 10);
            if i % 2 == 0 {
                assert!(
                    !replica.index.presence.contains_key("s00"),
                    "hide {i} waited"
                );
            }
            events += ev.len();
        }
        // The first show was spent connecting: three more shows, four hides.
        assert_eq!(events, 2 * n * (SHOW_BURST as usize - 1) + n);
        // The last toggle showed bob; it comes due when the rate allows, once.
        assert!(!replica.seen["bob"].up && replica.seen["bob"].wake > 0);
        assert_eq!(replica.index, reindexed(&replica));
        let wake = replica.seen["bob"].wake - T0;
        assert!(at(&mut replica, Op::Heartbeat, wake - 1).is_empty());
        let shown = at(&mut replica, Op::Heartbeat, wake);
        assert_eq!(shown.len(), n);
        assert!(
            shown
                .iter()
                .all(|(_, user, online)| user == "bob" && *online)
        );
        assert!(at(&mut replica, Op::Heartbeat, wake + 60_000).is_empty());
        // A storm that ends hidden leaves bob hidden, with no show due.
        let t = wake + 100_000;
        for i in 0..21_i64 {
            at(&mut replica, mode(i % 2 == 0), t + i);
        }
        assert!(!replica.index.presence.contains_key("s00"));
        assert!(replica.seen["bob"].hidden && !replica.seen["bob"].up);
        let later = replica.seen["bob"].wake.max(T0 + t) - T0 + 60_000;
        assert!(at(&mut replica, Op::Heartbeat, later).is_empty());
        assert!(!replica.index.presence.contains_key("s00"));
        assert_eq!(replica.seen["bob"].wake, 0);
    }

    #[test]
    fn connections_per_user_are_capped_and_the_replica_stays_small() {
        let names: Vec<String> = (0..PRESENCE_SERVERS_MAX)
            .map(|i| format!("server-{i:04}"))
            .collect();
        let all: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut replica = Replica::default();
        let mut evicted = Vec::new();
        let mut events = 0;
        for i in 0..200_u64 {
            let scope = (i % 50 == 0).then_some(all.as_slice());
            let applied = replica.apply(
                1,
                online_op("alice", (1 << 32) | i, 20, scope),
                T0 + i as i64,
            );
            events += presence_of(&applied.events).len();
            evicted.extend(applied.evicted);
        }
        assert_eq!(events, PRESENCE_SERVERS_MAX);
        assert_eq!(
            evicted,
            (0..180).map(|i| (1 << 32) | i).collect::<Vec<u64>>()
        );
        let seen = &replica.seen["alice"];
        assert_eq!(
            seen.conns.keys().copied().collect::<Vec<u64>>(),
            (180..200).map(|i| (1 << 32) | i).collect::<Vec<u64>>()
        );
        assert_eq!(seen.servers.len(), PRESENCE_SERVERS_MAX);
        let entries: usize = replica.index.presence.values().map(BTreeSet::len).sum();
        assert_eq!(entries, PRESENCE_SERVERS_MAX);
        let json = serde_json::to_string(&replica).unwrap();
        assert!(json.len() < 16_000 + 20 * 64, "{} bytes", json.len());

        let mut add = |server: &str| {
            let op = Op::Rescope {
                user: "alice".to_string(),
                add: vec![server.to_string()],
                remove: Vec::new(),
                hidden: None,
                seq: 0,
            };
            presence_of(&replica.apply(1, op, T0 + 1_000).events)
        };
        assert!(add("zed").is_empty());
        assert_eq!(
            add("aaa"),
            vec![
                ("server-0999".to_string(), "alice".to_string(), false),
                ("aaa".to_string(), "alice".to_string(), true)
            ]
        );
        assert_eq!(replica.seen["alice"].servers.len(), PRESENCE_SERVERS_MAX);
        assert_eq!(replica.index, reindexed(&replica));
    }

    #[tokio::test]
    async fn oldest_connection_closes_past_the_cap() {
        let hub = Hub::new();
        hub.set_limits(Limits {
            conns_per_user: 2,
            ..Limits::default()
        });
        let mut inboxes = Vec::new();
        for _ in 0..3 {
            let conn = hub.next_conn();
            inboxes.push(hub.open(conn, &HashSet::from([Topic::User("alice".to_string())])));
            hub.set_online("alice", conn, &["rchat"]);
        }
        let evicted: Vec<bool> = inboxes.iter().map(Inbox::evicted).collect();
        assert_eq!(evicted, [true, false, false]);
        assert!(inboxes[0].rx.recv().await.is_none());
        assert_eq!(hub.connections(), 2);
        assert_eq!(hub.online_count("rchat"), 1);
        hub.set_limits(Limits {
            connect_burst: 3,
            connect_every: Duration::from_secs(3600),
            ..Limits::default()
        });
        assert!((0..3).all(|_| hub.connect_ok("bob")));
        assert!(!hub.connect_ok("bob") && hub.connect_ok("carol"));
    }

    #[test]
    fn unknown_ops_fail_alone() {
        let future = r#"{"origin":7,"seq":1,"op":{"op":"future_op","user":"x"}}"#;
        assert!(serde_json::from_str::<Envelope>(future).is_err());
        let next = r#"{"origin":7,"seq":2,"op":{"op":"online","user":"amy","conn":30064771072,"scope":{"servers":["rchat"]}}}"#;
        let Envelope { origin, seq, op } = serde_json::from_str(next).unwrap();
        let mut replica = Replica::default();
        assert!(replica.admit(origin, seq));
        let applied = replica.apply(origin, op, T0);
        assert_eq!(
            presence_of(&applied.events),
            vec![("rchat".to_string(), "amy".to_string(), true)]
        );
    }

    #[tokio::test]
    async fn legacy_snapshot_makes_every_node_announce_again() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let (alice, bob) = (a.next_conn(), b.next_conn());
        a.set_online("alice", alice, &["rchat"]);
        b.set_online("bob", bob, &["rchat"]);
        a.flush().await;
        b.flush().await;
        let (id, current) = a.snapshot().unwrap();
        let mut epochs = [a.epoch(), b.epoch()];
        for epoch in epochs.iter_mut() {
            epoch.borrow_and_update();
        }
        let old = r#"{"presence":{"rchat":{"olga":[8589934592]}},"rooms":{},"calls":{},"p2p":{},"peers":{},"clock":0}"#;
        let (c, out) = Hub::replicated();
        c.restore(&id, old).unwrap();
        bus.attach(c.clone(), out, Some(&id));
        assert_eq!(c.online_set("rchat"), HashSet::from(["olga".to_string()]));
        c.flush().await;
        for ((hub, conn, user), epoch) in [(&a, alice, "alice"), (&b, bob, "bob")]
            .into_iter()
            .zip(epochs.iter_mut())
        {
            assert!(epoch.has_changed().unwrap());
            epoch.borrow_and_update();
            hub.set_online(user, conn, &["rchat"]);
            hub.flush().await;
        }
        assert_eq!(
            c.online_set("rchat"),
            HashSet::from(["alice", "bob", "olga"].map(String::from))
        );
        a.reannounce_all();
        a.flush().await;
        assert!(!epochs[0].has_changed().unwrap() && !epochs[1].has_changed().unwrap());
        let (d, out) = Hub::replicated();
        d.restore(&id, &current).unwrap();
        bus.attach(d.clone(), out, Some(&id));
        d.flush().await;
        assert!(!epochs[0].has_changed().unwrap());
    }

    #[tokio::test]
    async fn online_anywhere_spans_instances() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let conn = a.next_conn();
        let _inbox = a.open(conn, &HashSet::from([Topic::User("zoe".to_string())]));
        assert!(a.is_online_anywhere("zoe") && !b.is_online_anywhere("zoe"));
        a.set_online("zoe", conn, &[] as &[&str]);
        a.flush().await;
        b.flush().await;
        assert!(b.is_online_anywhere("zoe") && !b.is_online_anywhere("yan"));
        assert!(b.online_set("rchat").is_empty());
        a.close(conn);
        assert!(!a.is_online_anywhere("zoe") && b.is_online_anywhere("zoe"));
        let _ = a.drop_conn("zoe", conn).await;
        a.flush().await;
        b.flush().await;
        assert!(!b.is_online_anywhere("zoe"));
    }

    #[tokio::test]
    async fn connect_rate_counts_across_instances() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let limits = Limits {
            connect_burst: 3,
            connect_every: Duration::from_secs(60),
            ..Limits::default()
        };
        a.set_limits(limits);
        b.set_limits(limits);
        for _ in 0..3 {
            assert!(a.connect_ok("bob"));
            a.set_online("bob", a.next_conn(), &["rchat"]);
        }
        a.flush().await;
        b.flush().await;
        // b has not seen a connect from bob itself, but the cluster has seen three.
        assert!(!b.connect_ok("bob") && b.connect_ok("carol"));
        bus.advance(60_000);
        b.flush().await;
        assert!(b.connect_ok("bob"));
        b.set_online("bob", b.next_conn(), &["rchat"]);
        b.flush().await;
        assert!(!a.connect_ok("bob"));
    }

    #[tokio::test]
    async fn presence_across_instances() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let mut rx_b = b.subscribe();
        let conn_a = a.next_conn();
        let conn_b = b.next_conn();
        a.set_online("alice", conn_a, &["rchat"]);
        a.flush().await;
        assert!(b.is_online("rchat", "alice"));
        assert_eq!(b.online_set("rchat"), HashSet::from(["alice".to_string()]));
        b.set_online("alice", conn_b, &["rchat"]);
        b.flush().await;
        a.announce("alice", conn_a, false, None);
        a.flush().await;
        assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
        b.announce("alice", conn_b, false, None);
        b.flush().await;
        assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
        bus.advance(PRESENCE_GRACE_MS);
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
        a.call_start(
            "alice",
            alice,
            9,
            dm_users(),
            CallKind::Rtc,
            false,
            70,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            b.call_start("bob", bob, 9, dm_users(), CallKind::Rtc, false, 71, None)
                .await,
            Err("You are already in a call".to_string())
        );
        let (log_id, users) = b.call_accept("bob", bob, 9, None).await.unwrap();
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
    async fn p2p_calls_bind_their_id_and_the_peer_ids_of_both_tabs() {
        let s = |v: &str| v.to_string();
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        type Bound = (CallPhase, Option<String>, Vec<(String, String)>);
        let bound = |evs: Vec<WsEvent>| -> Vec<Bound> {
            evs.into_iter()
                .filter_map(|ev| match ev {
                    WsEvent::CallState {
                        dm_id: _,
                        dm_users: _,
                        state,
                        from: _,
                        kind: _,
                        video: _,
                        call_id,
                        answered_at: _,
                        peers,
                    } => Some((
                        state,
                        call_id,
                        peers.into_iter().map(|p| (p.user, p.peer_id)).collect(),
                    )),
                    _ => None,
                })
                .collect()
        };
        let pair = |a: &str, b: &str| vec![(s("alice"), s(a)), (s("bob"), s(b))];
        let (alice, bob, bob2) = (hub.next_conn(), hub.next_conn(), hub.next_conn());
        hub.set_p2p("alice", alice, s("hosted-a"), Vec::new());
        hub.set_p2p("bob", bob, s("hosted-b"), Vec::new());
        hub.call_start(
            "alice",
            alice,
            9,
            dm_users(),
            CallKind::P2p,
            false,
            70,
            Some(s("pa")),
        )
        .await
        .unwrap();
        hub.call_accept("bob", bob2, 9, Some(s("pb2")))
            .await
            .unwrap();
        hub.call_end("alice", 9).await.unwrap();
        let first = bound(drain(&mut rx));
        assert_eq!(first.len(), 3);
        assert_eq!(first[0], (CallPhase::Ringing, None, Vec::new()));
        let id = first[1].1.clone().expect("an active P2P call has an id");
        assert_eq!(id.len(), 32);
        assert_eq!(
            first[1],
            (CallPhase::Active, Some(id.clone()), pair("pa", "pb2")),
            "the tab that accepted, not bob's other tab"
        );
        assert_eq!(first[2], (CallPhase::Ended, None, Vec::new()));

        hub.call_start(
            "alice",
            alice,
            9,
            dm_users(),
            CallKind::P2p,
            false,
            71,
            None,
        )
        .await
        .unwrap();
        hub.call_accept("bob", bob, 9, None).await.unwrap();
        let old = bound(drain(&mut rx));
        assert_eq!(
            old[1].2,
            pair("hosted-a", "hosted-b"),
            "older apps name no peer id, so the hosting one stands in"
        );
        assert!(old[1].1.as_ref().is_some_and(|other| *other != id));
        hub.call_end("bob", 9).await.unwrap();

        hub.call_start(
            "alice",
            alice,
            9,
            dm_users(),
            CallKind::Rtc,
            false,
            72,
            Some(s("pa")),
        )
        .await
        .unwrap();
        hub.call_accept("bob", bob, 9, Some(s("pb"))).await.unwrap();
        assert_eq!(
            bound(drain(&mut rx)).last(),
            Some(&(CallPhase::Active, None, Vec::new())),
            "instance calls carry no peer ids"
        );
    }

    #[tokio::test]
    async fn dead_instance_is_purged() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let mut aftermath = b.take_aftermath().unwrap();
        let mut rx_b = b.subscribe();
        let (alice, bob) = (a.next_conn(), b.next_conn());
        a.set_online("alice", alice, &["rchat"]);
        b.set_online("bob", bob, &["rchat"]);
        a.set_p2p("alice", alice, "peer-a".to_string(), vec!["f".to_string()]);
        a.call_start(
            "alice",
            alice,
            9,
            dm_users(),
            CallKind::P2p,
            false,
            70,
            None,
        )
        .await
        .unwrap();
        b.call_accept("bob", bob, 9, None).await.unwrap();
        assert!(
            b.voice_join("carol", b.next_conn(), "rchat", 5)
                .await
                .is_empty()
        );
        drain(&mut rx_b);
        outlive(&bus, &b).await;
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
        a.set_online("alice", alice, &["rchat"]);
        a.flush().await;
        outlive(&bus, &b).await;
        assert!(epoch.has_changed().unwrap());
        assert_eq!(epoch.borrow_and_update().lossy, 0);
        a.resync(true);
        assert_eq!(epoch.borrow_and_update().lossy, 1);
        a.set_online("alice", alice, &["rchat"]);
        a.flush().await;
        assert!(b.is_online("rchat", "alice"));
        a.set_online("alice", alice, &[] as &[&str]);
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
            vec![("two".to_string(), "alice".to_string(), true)]
        );
        a.set_online("alice", alice, &["one"]);
        a.flush().await;
        a.set_online("alice", alice, &["two"]);
        a.flush().await;
        assert!(!b.is_online("one", "alice") && b.is_online("two", "alice"));
        a.set_online("alice", alice, &[] as &[&str]);
        a.flush().await;
        assert!(!b.is_online("two", "alice") && !a.is_online("two", "alice"));
    }

    #[tokio::test]
    async fn departing_instance_clears_its_state() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let alice = a.next_conn();
        a.set_online("alice", alice, &["rchat"]);
        assert!(a.voice_join("alice", alice, "rchat", 5).await.is_empty());
        let purge = a.depart().await.unwrap();
        assert!(purge.ends.is_empty());
        assert!(b.is_online("rchat", "alice"));
        assert!(b.rooms_in("rchat", None).is_empty());
        bus.advance(PRESENCE_GRACE_MS);
        b.flush().await;
        assert!(!b.is_online("rchat", "alice"));
    }

    #[tokio::test]
    async fn bootstrap_from_snapshot() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let (alice, bob) = (a.next_conn(), b.next_conn());
        a.set_online("alice", alice, &["rchat"]);
        assert!(a.voice_join("alice", alice, "rchat", 5).await.is_empty());
        let (id, json) = a.snapshot().unwrap();
        b.set_online("bob", bob, &["rchat"]);
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
        c.set_online("carol", carol, &["rchat"]);
        c.flush().await;
        assert!(a.is_online("rchat", "carol"));
        assert_eq!(a.snapshot().unwrap().1, c.snapshot().unwrap().1);
    }

    #[tokio::test]
    async fn bus_outage_does_not_purge_live_instances() {
        let bus = MemBus::new();
        let hubs: Vec<Hub> = (0..3).map(|_| bus.join()).collect();
        let mut epochs: Vec<_> = hubs.iter().map(|h| h.epoch()).collect();
        let mut rx = hubs[0].subscribe();
        for (i, h) in hubs.iter().enumerate() {
            for u in 0..100 {
                h.set_online(&format!("u{i}_{u}"), h.next_conn(), &["big"]);
            }
            h.flush().await;
        }
        drain(&mut rx);
        bus.advance(DEAD_AFTER_MS + 1_000);
        for h in &hubs {
            h.flush().await;
        }
        let offline = presence_of(&drain(&mut rx))
            .iter()
            .filter(|(_, _, on)| !on)
            .count();
        let resynced = epochs
            .iter_mut()
            .filter(|e| e.has_changed().unwrap())
            .count();
        assert_eq!((offline, resynced), (0, 0));
        assert!(hubs.iter().all(|h| h.online_count("big") == 300));
        for _ in 0..3 {
            bus.advance(DEAD_AFTER_MS / 3);
            hubs[0].flush().await;
            hubs[1].flush().await;
        }
        bus.advance(1_000);
        hubs[0].flush().await;
        let offline = presence_of(&drain(&mut rx))
            .iter()
            .filter(|(s, u, on)| s == "big" && u.starts_with("u2_") && !on)
            .count();
        assert_eq!(offline, 100);
        assert!(hubs.iter().all(|h| h.online_count("big") == 200));
        assert!(epochs[2].has_changed().unwrap());
    }

    fn reindexed(replica: &Replica) -> Index {
        let mut copy = replica.detached();
        copy.reindex();
        copy.index
    }

    #[test]
    fn indexes_follow_every_op() {
        let s = |v: &str| v.to_string();
        let mut replica = Replica::default();
        let mut ops = script();
        let t = T0 + 100_000;
        let more = vec![
            Op::Viewing {
                user: s("dave"),
                conn: 3 << 32,
                old: None,
                new: Some(s("one")),
            },
            Op::Present {
                user: s("dave"),
                conn: 3 << 32,
                server: Some(s("two")),
            },
            Op::Online {
                user: s("dave"),
                conn: 3 << 32,
                lit: true,
                cap: 2,
                scope: Some(Scope {
                    servers: vec![s("one"), s("two")],
                    hidden: false,
                    seq: 0,
                }),
                every: 0,
            },
            Op::Online {
                user: s("hal"),
                conn: (3 << 32) | 4,
                lit: true,
                cap: 0,
                scope: Some(Scope {
                    servers: vec![s("two")],
                    hidden: false,
                    seq: 0,
                }),
                every: 0,
            },
            Op::Online {
                user: s("hal"),
                conn: (3 << 32) | 5,
                lit: false,
                cap: 0,
                scope: None,
                every: 0,
            },
            Op::Rescope {
                user: s("hal"),
                add: vec![s("one")],
                remove: vec![s("two")],
                hidden: None,
                seq: 0,
            },
            Op::Broadcast {
                event: WsEvent::PresenceMode {
                    username: s("hal"),
                    appear_offline: true,
                    seq: 0,
                },
            },
            Op::DropConn {
                user: s("hal"),
                conn: (3 << 32) | 4,
            },
            Op::Broadcast {
                event: WsEvent::MemberLeft {
                    server: s("one"),
                    username: s("dave"),
                },
            },
            Op::VoiceJoin {
                user: s("dave"),
                conn: 3 << 32,
                server: s("two"),
                channel_id: 11,
                cap: 0,
            },
            Op::VoiceJoin {
                user: s("erin"),
                conn: (3 << 32) | 1,
                server: s("two"),
                channel_id: 11,
                cap: 0,
            },
            Op::Broadcast {
                event: WsEvent::ServerRenamed {
                    old_name: s("two"),
                    server: crate::api::ServerSummaryLite {
                        name: s("deux"),
                        display_name: s("deux"),
                        creator: None,
                        has_password: false,
                        banner_color: None,
                        name_color: None,
                    },
                },
            },
            Op::CallStart {
                user: s("frank"),
                conn: (3 << 32) | 2,
                dm_id: 4,
                dm_users: vec![s("frank"), s("gina")],
                kind: CallKind::Rtc,
                video: false,
                log_id: 9,
                call_id: String::new(),
                peer_id: None,
            },
            Op::CallAccept {
                user: s("gina"),
                conn: (3 << 32) | 3,
                dm_id: 4,
                peer_id: None,
            },
            Op::VoiceJoin {
                user: s("gina"),
                conn: (3 << 32) | 3,
                server: s("deux"),
                channel_id: 11,
                cap: 0,
            },
            Op::Broadcast {
                event: WsEvent::MembersPurged {
                    server: s("deux"),
                    usernames: vec![s("dave")],
                },
            },
            Op::EvictVoice {
                user: s("erin"),
                channel_id: 11,
            },
            Op::DropConn {
                user: s("gina"),
                conn: (3 << 32) | 3,
            },
            Op::Broadcast {
                event: WsEvent::ServerDeleted { name: s("deux") },
            },
            Op::Depart,
        ];
        ops.extend(
            more.into_iter()
                .enumerate()
                .map(|(i, op)| (3, op, t + i as i64 * 10)),
        );
        for (origin, op, at) in ops {
            replica.apply(origin, op, at);
            assert_eq!(replica.index, reindexed(&replica));
        }
        assert!(
            replica
                .index
                .lingering
                .iter()
                .all(|(_, u)| replica.seen[u].up)
        );
    }

    #[test]
    fn full_voice_rooms_turn_joins_away() {
        let mut replica = Replica::default();
        let join = |user: &str, conn: u64, channel_id: i64| Op::VoiceJoin {
            user: user.to_string(),
            conn,
            server: "rchat".to_string(),
            channel_id,
            cap: 2,
        };
        for (user, conn) in [("a", 1), ("b", 2)] {
            let applied = replica.apply(1, join(user, conn, 5), T0);
            assert!(matches!(applied.outcome, Outcome::Ends(_)));
        }
        replica.apply(1, join("c", 3, 6), T0);
        let refused = replica.apply(1, join("c", 3, 5), T0);
        assert!(matches!(refused.outcome, Outcome::Full) && refused.events.is_empty());
        assert!(matches!(
            replica.apply(1, join("a", 9, 5), T0).outcome,
            Outcome::Ends(_)
        ));
        assert_eq!(replica.rooms[&6].users, vec![("c".to_string(), 3)]);
        assert_eq!(replica.rooms[&5].users.len(), 2);
    }

    #[test]
    fn signals_for_a_left_room_are_dropped() {
        let mut replica = Replica::default();
        let join = |user: &str, conn: u64, channel_id: i64| Op::VoiceJoin {
            user: user.to_string(),
            conn,
            server: "rchat".to_string(),
            channel_id,
            cap: 0,
        };
        let signal = |channel_id: i64| Op::Broadcast {
            event: WsEvent::RtcSignal {
                to: "b".to_string(),
                from: "a".to_string(),
                channel_id: Some(channel_id),
                dm_id: None,
                payload: serde_json::json!({ "candidate": {} }),
            },
        };
        let relayed = |applied: &Applied| {
            applied
                .events
                .iter()
                .filter(|ev| matches!(ev, WsEvent::RtcSignal { .. }))
                .count()
        };
        replica.apply(1, join("a", 1, 5), T0);
        replica.apply(1, join("b", 2, 5), T0);
        assert_eq!(relayed(&replica.apply(1, signal(5), T0)), 1);
        replica.apply(1, join("b", 2, 6), T0);
        assert_eq!(relayed(&replica.apply(1, signal(5), T0)), 0);
        assert_eq!(relayed(&replica.apply(1, signal(6), T0)), 0);
        replica.apply(1, join("a", 1, 6), T0);
        assert_eq!(relayed(&replica.apply(1, signal(6), T0)), 1);
        replica.apply(
            1,
            Op::VoiceLeave {
                user: "b".to_string(),
            },
            T0,
        );
        assert_eq!(relayed(&replica.apply(1, signal(6), T0)), 0);
    }

    #[test]
    fn rejoin_from_another_connection_restates_the_room() {
        let mut replica = Replica::default();
        let join = |conn: u64| Op::VoiceJoin {
            user: "a".to_string(),
            conn,
            server: "rchat".to_string(),
            channel_id: 5,
            cap: 0,
        };
        replica.apply(1, join(1), T0);
        let moved = replica.apply(1, join(9), T0);
        assert_eq!(voice_of(&moved.events), vec![(5, vec!["a".to_string()])]);
        assert_eq!(replica.rooms[&5].users, vec![("a".to_string(), 9)]);
        assert!(replica.apply(1, join(9), T0).events.is_empty());
    }

    fn signal(from: &str, to: &str, channel_id: Option<i64>, dm_id: Option<i64>) -> WsEvent {
        WsEvent::RtcSignal {
            to: to.to_string(),
            from: from.to_string(),
            channel_id,
            dm_id,
            payload: serde_json::json!({ "candidate": {}, "sid": "s1" }),
        }
    }

    fn signals_of(evs: &[WsEvent]) -> Vec<(String, String)> {
        evs.iter()
            .filter_map(|ev| match ev {
                WsEvent::RtcSignal {
                    to,
                    from,
                    channel_id: _,
                    dm_id: _,
                    payload: _,
                } => Some((from.clone(), to.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn dm_call_signals_relay_only_while_the_call_is_active() {
        let mut replica = Replica::default();
        let s = |v: &str| v.to_string();
        let relay = |replica: &mut Replica| {
            let op = Op::Broadcast {
                event: signal("bob", "alice", None, Some(9)),
            };
            signals_of(&replica.apply(1, op, T0).events).len()
        };
        let start = Op::CallStart {
            user: s("alice"),
            conn: 1,
            dm_id: 9,
            dm_users: dm_users(),
            kind: CallKind::Rtc,
            video: false,
            log_id: 70,
            call_id: String::new(),
            peer_id: None,
        };
        assert!(matches!(
            replica.apply(1, start, T0).outcome,
            Outcome::Started(Ok(()))
        ));
        assert_eq!(relay(&mut replica), 0);
        let accept = Op::CallAccept {
            user: s("bob"),
            conn: 2,
            dm_id: 9,
            peer_id: None,
        };
        assert!(matches!(
            replica.apply(2, accept, T0).outcome,
            Outcome::Accepted(Ok(_))
        ));
        assert_eq!(relay(&mut replica), 1);
        let wrong_call = Op::Broadcast {
            event: signal("bob", "alice", None, Some(10)),
        };
        assert!(signals_of(&replica.apply(1, wrong_call, T0).events).is_empty());
        let end = Op::CallEnd {
            user: s("alice"),
            dm_id: 9,
        };
        replica.apply(1, end, T0);
        assert_eq!(relay(&mut replica), 0);
    }

    #[tokio::test]
    async fn signals_relay_across_instances_in_log_order() {
        let bus = MemBus::new();
        let (a, b) = (bus.join(), bus.join());
        let (mut rx_a, mut rx_b) = (a.subscribe(), b.subscribe());
        let (alice, bob) = (a.next_conn(), b.next_conn());
        a.voice_join("alice", alice, "rchat", 5).await;
        b.voice_join("bob", bob, "rchat", 5).await;
        a.flush().await;
        assert!(a.rtc_shared("alice", "bob", Some(5), None));
        a.broadcast(signal("alice", "bob", Some(5), None));
        a.flush().await;
        b.flush().await;
        let relayed = vec![("alice".to_string(), "bob".to_string())];
        assert_eq!(signals_of(&drain(&mut rx_b)), relayed);
        assert_eq!(signals_of(&drain(&mut rx_a)), relayed);
        // a still saw bob in the room when it checked, but bob's leave on b
        // lands in the log first, so neither instance relays the signal
        assert!(a.rtc_shared("alice", "bob", Some(5), None));
        b.voice_leave("bob").await;
        a.broadcast(signal("alice", "bob", Some(5), None));
        a.flush().await;
        b.flush().await;
        assert!(signals_of(&drain(&mut rx_a)).is_empty());
        assert!(signals_of(&drain(&mut rx_b)).is_empty());

        a.call_start(
            "alice",
            alice,
            9,
            dm_users(),
            CallKind::Rtc,
            false,
            70,
            None,
        )
        .await
        .unwrap();
        b.broadcast(signal("bob", "alice", None, Some(9)));
        b.flush().await;
        a.flush().await;
        assert!(signals_of(&drain(&mut rx_a)).is_empty());
        b.call_accept("bob", bob, 9, None).await.unwrap();
        b.broadcast(signal("bob", "alice", None, Some(9)));
        b.flush().await;
        a.flush().await;
        let back = vec![("bob".to_string(), "alice".to_string())];
        assert_eq!(signals_of(&drain(&mut rx_a)), back);
        assert_eq!(signals_of(&drain(&mut rx_b)), back);
        a.call_end("alice", 9).await.unwrap();
        b.broadcast(signal("bob", "alice", None, Some(9)));
        b.flush().await;
        a.flush().await;
        assert!(signals_of(&drain(&mut rx_a)).is_empty());
        assert!(signals_of(&drain(&mut rx_b)).is_empty());
    }

    #[test]
    fn purge_event_removes_members_in_one_op() {
        let mut replica = Replica::default();
        let s = |v: &str| v.to_string();
        for (i, user) in ["bob", "carol", "dave"].iter().enumerate() {
            let conn = (1 << 32) | i as u64;
            replica.apply(
                1,
                Op::Viewing {
                    user: s(user),
                    conn,
                    old: None,
                    new: Some(s("club")),
                },
                T0,
            );
            replica.apply(
                1,
                Op::VoiceJoin {
                    user: s(user),
                    conn,
                    server: s("club"),
                    channel_id: 3,
                    cap: 0,
                },
                T0,
            );
        }
        let applied = replica.apply(
            1,
            Op::Broadcast {
                event: WsEvent::MembersPurged {
                    server: s("club"),
                    usernames: vec![s("bob"), s("carol")],
                },
            },
            T0 + 1,
        );
        assert_eq!(
            presence_of(&applied.events),
            vec![(s("club"), s("bob"), false), (s("club"), s("carol"), false)]
        );
        assert_eq!(
            voice_of(&applied.events).last(),
            Some(&(3, vec![s("dave")]))
        );
        assert_eq!(
            replica.index.presence["club"].iter().collect::<Vec<_>>(),
            ["dave"]
        );
    }

    #[tokio::test]
    async fn voice_snapshot_covers_only_held_servers() {
        let hub = Hub::new();
        let s = |v: &str| v.to_string();
        hub.voice_join("alice", 1, "one", 5).await;
        hub.voice_join("bob", 2, "two", 6).await;
        hub.call_start(
            "carol",
            3,
            9,
            vec![s("carol"), s("dave")],
            CallKind::Rtc,
            false,
            1,
            None,
        )
        .await
        .unwrap();
        let held = [s("one")];
        assert_eq!(
            voice_of(&hub.voice_snapshot_for(held.iter(), Some("dave"))),
            vec![(5, vec![s("alice")])]
        );
        assert_eq!(
            calls_of(&hub.voice_snapshot_for(held.iter(), Some("dave"))),
            vec![(9, CallPhase::Ringing)]
        );
        assert!(calls_of(&hub.voice_snapshot_for(held.iter(), Some("erin"))).is_empty());
        assert_eq!(hub.voice_snapshot().len(), 3);
    }

    #[tokio::test]
    async fn reads_are_coalesced_per_scope() {
        let (hub, mut out) = Hub::replicated();
        hub.coalesce_reads();
        let read = |scope: &str, last_read, pings_until| WsEvent::ReadUpdated {
            username: "alice".to_string(),
            scope: scope.to_string(),
            last_read,
            pings_until,
        };
        hub.broadcast(read("c1", 5, 40));
        hub.broadcast(read("c1", 9, 0));
        hub.broadcast(read("c1", 7, 12));
        hub.broadcast(read("c2", 1, 0));
        assert!(out.try_recv().is_err());
        hub.flush_reads();
        let posted: Vec<(String, i64, i64)> = std::iter::from_fn(|| out.try_recv().ok())
            .map(|env| match env.op {
                Op::Broadcast {
                    event:
                        WsEvent::ReadUpdated {
                            scope,
                            last_read,
                            pings_until,
                            ..
                        },
                } => (scope, last_read, pings_until),
                _ => panic!("expected reads"),
            })
            .collect();
        assert_eq!(
            posted,
            vec![("c1".to_string(), 9, 40), ("c2".to_string(), 1, 0)]
        );
    }

    #[tokio::test]
    async fn full_publish_queue_is_recovered_by_a_resync() {
        let (hub, mut out) = Hub::replicated();
        let mut epoch = hub.epoch();
        let conn = hub.next_conn();
        for i in 0..=OUT_CAP {
            hub.set_online("alice", conn, &[&format!("s{}", i % 2)]);
        }
        let queued: Vec<Envelope> = std::iter::from_fn(|| out.try_recv().ok()).collect();
        assert_eq!(queued.len(), OUT_CAP);
        for (i, env) in queued.into_iter().enumerate() {
            hub.ingest(&format!("{}-{i}", T0), env, true);
        }
        assert!(!epoch.has_changed().unwrap());
        hub.heartbeat();
        hub.ingest(&format!("{}-0", T0 + 1), out.try_recv().unwrap(), true);
        assert!(epoch.has_changed().unwrap());
        assert_eq!(epoch.borrow_and_update().lossy, 0);
    }

    #[tokio::test]
    async fn unconfirmed_cleanup_finishes_in_the_background() {
        let (hub, mut out) = Hub::replicated();
        let mut aftermath = hub.take_aftermath().unwrap();
        let conn = hub.next_conn();
        hub.set_online("alice", conn, &["rchat"]);
        hub.set_p2p("alice", conn, "peer".to_string(), vec!["f".to_string()]);
        let started = std::time::Instant::now();
        let (ends, drop) = hub.drop_conn("alice", conn).await;
        assert!(started.elapsed() >= CALL_TIMEOUT);
        assert!(ends.is_empty() && matches!(drop, P2pDrop::Kept));
        let posted: Vec<Envelope> = std::iter::from_fn(|| out.try_recv().ok()).collect();
        assert_eq!(posted.len(), 3);
        for (i, env) in posted.into_iter().enumerate() {
            hub.ingest(&format!("{T0}-{i}"), env, true);
        }
        assert!(hub.is_online("rchat", "alice"));
        hub.heartbeat();
        let beat = out.try_recv().unwrap();
        hub.ingest(&format!("{}-0", T0 + PRESENCE_GRACE_MS), beat, true);
        assert!(!hub.is_online("rchat", "alice"));
        let Ok(Aftermath::Settle(purge)) = aftermath.try_recv() else {
            panic!("the late drop should be settled");
        };
        assert!(matches!(purge.p2p.as_slice(), [(user, P2pDrop::Offline)] if user == "alice"));
    }
}
