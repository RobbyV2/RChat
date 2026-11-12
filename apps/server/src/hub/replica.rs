use std::borrow::Borrow;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::link::SignalKey;
use super::{
    DEAD_AFTER_MS, GAPS_KEPT, PRESENCE_GRACE_MS, PRESENCE_SERVERS_MAX, SHOW_BURST, SHOW_EVERY_MS,
    owner,
};

use crate::ws::{CallKind, CallPeer, CallPhase, CallRelays, WsEvent};

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
pub(super) struct Room {
    pub(super) server: String,
    pub(super) users: Vec<(String, u64)>,
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
pub(super) struct Call {
    dm_users: Vec<String>,
    from: String,
    occupants: Vec<(String, u64)>,
    active: bool,
    pub(super) kind: CallKind,
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
    // The relay hosts each side of a P2P call declared; see `p2p::relay_hosts`.
    #[serde(default)]
    pub(super) relays: Vec<(String, Vec<String>)>,
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
pub(super) struct P2pHost {
    pub(super) peer_id: String,
    pub(super) ids: Vec<String>,
    // Relay hosts declared per file id; only the downloader of that file learns them.
    #[serde(default)]
    pub(super) relays: BTreeMap<String, Vec<String>>,
}

pub enum P2pDrop {
    Kept,
    Offline,
    Remaining(String, Vec<String>),
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Peer {
    seen: i64,
    pub(super) seq: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) gaps: Vec<(u64, u64)>,
}

#[derive(Clone, Default, Debug, PartialEq)]
pub(super) struct Index {
    pub(super) presence: BTreeMap<String, BTreeSet<String>>,
    pub(super) scoped: BTreeMap<String, BTreeSet<String>>,
    pub(super) lingering: BTreeSet<(i64, String)>,
    pub(super) waking: BTreeSet<(i64, String)>,
    user_rooms: BTreeMap<String, BTreeSet<i64>>,
    pub(super) server_rooms: BTreeMap<String, BTreeSet<i64>>,
    user_calls: BTreeMap<String, BTreeSet<i64>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Tab {
    lit: bool,
    at: i64,
}

// What a signed-in user shows: their member servers and appear-offline flag once, shared by
// all their open connections. `up` while they are in those servers' presence; `gone` is when
// they stopped being visible, kept online until the grace ends.
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct Seen {
    pub(super) servers: BTreeSet<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub(super) hidden: bool,
    // The version (`users.presence_seq`) of `hidden`; an older value never replaces it.
    #[serde(skip_serializing_if = "is_zero_ms")]
    pub(super) mode: i64,
    pub(super) conns: BTreeMap<u64, Tab>,
    #[serde(skip_serializing_if = "is_false")]
    pub(super) up: bool,
    #[serde(skip_serializing_if = "is_zero_ms")]
    pub(super) gone: i64,
    // Rate state (GCRA theoretical arrival times, ms): of coming online, and of new
    // connections across the cluster. `wake` is when a show held back by the rate is due.
    #[serde(skip_serializing_if = "is_zero_ms")]
    shows: i64,
    #[serde(skip_serializing_if = "is_zero_ms")]
    pub(super) wake: i64,
    #[serde(skip_serializing_if = "is_zero_ms")]
    pub(super) opened: i64,
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
    pub(super) seen: BTreeMap<String, Seen>,
    pub(super) rooms: BTreeMap<i64, Room>,
    pub(super) calls: BTreeMap<i64, Call>,
    pub(super) p2p: BTreeMap<String, BTreeMap<u64, P2pHost>>,
    pub(super) peers: BTreeMap<u32, Peer>,
    pub(super) clock: i64,
    #[serde(skip)]
    pub(super) legacy: bool,
    #[serde(skip)]
    pub(super) index: Index,
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
        #[serde(default)]
        relays: Vec<String>,
    },
    CallAccept {
        user: String,
        conn: u64,
        dm_id: i64,
        #[serde(default)]
        peer_id: Option<String>,
        #[serde(default)]
        relays: Vec<String>,
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
        #[serde(default)]
        relays: BTreeMap<String, Vec<String>>,
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
    // The call or voice room of an RTC signal.
    pub(super) fn signal_key(&self) -> Option<SignalKey> {
        match self {
            Op::Broadcast {
                event:
                    WsEvent::RtcSignal {
                        to: _,
                        from: _,
                        channel_id,
                        dm_id,
                        payload: _,
                    },
            } => Some((*channel_id, *dm_id)),
            _ => None,
        }
    }

    pub(super) fn repostable(&self) -> bool {
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
                relays: _,
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
                relays: _,
            }
            | Op::CallAccept {
                user: _,
                conn: _,
                dm_id: _,
                peer_id: _,
                relays: _,
            }
            | Op::CallEnd { user: _, dm_id: _ }
            | Op::DropConn { user: _, conn: _ }
            | Op::SweepVoice { idle: _ }
            | Op::Depart => false,
        }
    }

    pub(super) fn must_apply(&self) -> bool {
        matches!(
            self,
            Op::DropConn { user: _, conn: _ } | Op::VoiceLeave { user: _ } | Op::Depart
        )
    }

    pub(super) fn hoster(&self) -> Option<&str> {
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
        relays: match call.kind {
            CallKind::P2p => call
                .relays
                .iter()
                .filter(|(user, hosts)| !hosts.is_empty() && (call.active || *user == call.from))
                .map(|(user, hosts)| CallRelays {
                    user: user.clone(),
                    hosts: hosts.clone(),
                })
                .collect(),
            CallKind::Rtc => Vec::new(),
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
    pub(super) fn detached(&self) -> Replica {
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

    pub(super) fn reindex(&mut self) {
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

    pub(super) fn rooms_of(&self, user: &str) -> Vec<i64> {
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

    /// Whether `user` is in any DM call, ringing or answered, of any kind: a new call to or from
    /// them is busy.
    pub(super) fn in_call(&self, user: &str) -> bool {
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

    pub(super) fn expire(&mut self, t: i64, evs: &mut Vec<WsEvent>) {
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
            Some(Some(P2pHost {
                peer_id,
                ids,
                relays: _,
            })) => P2pDrop::Remaining(peer_id, ids),
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

    pub(super) fn kept(&self, origin: u32, seq: u64) -> bool {
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

    pub(super) fn recovered(&self, before: &Replica, me: u32, op: &Op) -> Option<Outcome> {
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
                relays,
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
                let user_name = user.clone();
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
                    relays: vec![(user_name, relays)],
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
                relays,
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
                call.relays.retain(|(u, _)| *u != user);
                match call.kind {
                    CallKind::P2p => call.relays.push((user.clone(), relays)),
                    CallKind::Rtc => {}
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
                relays,
            } => {
                self.p2p.entry(user).or_default().insert(
                    conn,
                    P2pHost {
                        peer_id,
                        ids,
                        relays,
                    },
                );
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

    pub(super) fn rtc_shared(
        &self,
        a: &str,
        b: &str,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
    ) -> bool {
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

    pub(super) fn in_room(&self, server: &str, channel_id: i64, user: &str) -> bool {
        self.rooms
            .get(&channel_id)
            .is_some_and(|r| r.server == server && r.users.iter().any(|(u, _)| u == user))
    }

    pub(super) fn in_active_call(&self, dm_id: i64, user: &str) -> bool {
        self.calls.get(&dm_id).is_some_and(|c| {
            c.active && c.kind == CallKind::Rtc && c.occupants.iter().any(|(u, _)| u == user)
        })
    }

    pub(super) fn in_p2p_call(&self, a: &str, b: &str) -> bool {
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

    pub(super) fn voice_snapshot(&self) -> Vec<WsEvent> {
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

    pub(super) fn voice_snapshot_for<'a, I: IntoIterator<Item = &'a String>>(
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
