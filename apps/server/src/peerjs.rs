use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::extract::ws::{Message as Frame, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{Extensions, HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::server::client_ip::ClientIp;

/// The key every client uses (the PeerJS default).
pub const KEY: &str = "peerjs";
pub const DEFAULT_PEERS_PER_IP: usize = 50;
pub const DEFAULT_CONCURRENT_LIMIT: usize = 5000;

const FRAME_MAX: usize = 64 * 1024;
/// Most frames and bytes queued for one connection that reads slowly.
const OUT_FRAMES: usize = 256;
const OUT_BYTES_MAX: usize = 256 * 1024;
/// Most bytes queued for the connections of one client address.
const OUT_BYTES_ADDR_MAX: usize = 2 * 1024 * 1024;
/// Most bytes queued for all connections.
const OUT_BYTES_TOTAL_MAX: usize = 64 * 1024 * 1024;
/// Longest id or token, in bytes.
const ID_MAX: usize = 128;
/// Most messages kept for one peer that is not connected.
const WAITING_MAX: usize = 64;
/// Most bytes of messages kept for peers that are not connected: from the connections of one
/// client address, and in all.
const WAITING_BYTES_ADDR_MAX: usize = 512 * 1024;
const WAITING_BYTES_MAX: usize = 8 * 1024 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the id of a connection that was dropped for reading too slowly stays with its
/// token, and how many such ids are remembered.
const RESERVED: Duration = Duration::from_secs(60);
const RESERVED_MAX: usize = 10_000;

const OPEN: &str = r#"{"type":"OPEN"}"#;
const ID_TAKEN: &str = r#"{"type":"ID-TAKEN","payload":{"msg":"ID is taken"}}"#;
const INVALID_KEY: &str = "Invalid key provided";
const NO_PARAMETERS: &str = "No id, token, or key supplied to websocket server";
const TOO_LONG: &str = "The id or token is too long";
const LIMIT_REACHED: &str = "Server has reached its concurrent user limit";
const TURNED_OFF: &str = "P2P is turned off on this instance";

const HEARTBEAT: &str = "HEARTBEAT";
const OFFER: &str = "OFFER";
const ANSWER: &str = "ANSWER";
const CANDIDATE: &str = "CANDIDATE";
const LEAVE: &str = "LEAVE";
const EXPIRE: &str = "EXPIRE";

fn error(msg: &str) -> String {
    format!(r#"{{"type":"ERROR","payload":{{"msg":"{msg}"}}}}"#)
}

/// How the built-in PeerJS signaling runs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Most connections per client address (an IPv6 /64 counts as one); 0 for no limit.
    pub peers_per_ip: usize,
    /// Most peers connected at once.
    pub concurrent_limit: usize,
    /// How long a message waits for a peer that is not connected.
    pub expire: Duration,
    /// How long a connection may send no heartbeat.
    pub alive: Duration,
    /// Frames one connection may relay at once.
    pub burst: u32,
    /// Frames one connection may relay per second after that.
    pub per_sec: u32,
    /// How long a queued frame may wait to be written before its connection is dropped.
    pub stale: Duration,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            peers_per_ip: DEFAULT_PEERS_PER_IP,
            concurrent_limit: DEFAULT_CONCURRENT_LIMIT,
            expire: Duration::from_secs(5),
            alive: Duration::from_secs(90),
            burst: 1000,
            per_sec: 100,
            stale: Duration::from_secs(15),
        }
    }
}

#[derive(Deserialize)]
struct Incoming {
    #[serde(rename = "type")]
    kind: String,
    dst: Option<String>,
    payload: Option<Value>,
}

#[derive(Serialize)]
struct Relayed<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    src: &'a str,
    dst: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<&'a Value>,
}

/// A client address (an IPv6 /64 as one) and the bytes queued for its connections.
#[derive(Clone)]
struct Client {
    addr: IpAddr,
    queued: Arc<AtomicUsize>,
}

/// Bytes of the frames queued for one connection, counted for its client address and in the
/// total of all connections too.
struct Backlog {
    own: AtomicUsize,
    addr: Arc<AtomicUsize>,
    all: Arc<AtomicUsize>,
}

impl Backlog {
    /// Counts `bytes` more, unless this connection, its client address or all connections
    /// hold too much. Called with the realm locked.
    fn take(&self, bytes: usize) -> bool {
        let fits = self.own.load(Ordering::Relaxed) + bytes <= OUT_BYTES_MAX
            && self.addr.load(Ordering::Relaxed) + bytes <= OUT_BYTES_ADDR_MAX
            && self.all.load(Ordering::Relaxed) + bytes <= OUT_BYTES_TOTAL_MAX;
        if fits {
            for counted in [&self.own, &*self.addr, &*self.all] {
                counted.fetch_add(bytes, Ordering::Relaxed);
            }
        }
        fits
    }

    /// Counts `bytes` more whatever is held: for `OPEN`, which every connection gets.
    fn count(&self, bytes: usize) {
        for counted in [&self.own, &*self.addr, &*self.all] {
            counted.fetch_add(bytes, Ordering::Relaxed);
        }
    }

    fn give(&self, bytes: usize) {
        for counted in [&self.own, &*self.addr, &*self.all] {
            counted.fetch_sub(bytes, Ordering::Relaxed);
        }
    }
}

impl Drop for Backlog {
    fn drop(&mut self) {
        let left = *self.own.get_mut();
        self.addr.fetch_sub(left, Ordering::Relaxed);
        self.all.fetch_sub(left, Ordering::Relaxed);
    }
}

/// A frame in a connection's queue, with the time it got there.
struct Queued {
    at: Instant,
    frame: String,
}

/// When a frame queued at `queued` must be written by, or `None` when it waited too long
/// already: a connection that does not take its frames within `stale` is dropped.
fn write_by(queued: Instant, now: Instant, stale: Duration) -> Option<Instant> {
    let due = queued + stale;
    (now < due).then(|| due.min(now + SEND_TIMEOUT))
}

/// What a frame from a connection meant for the connection itself.
enum Heard {
    /// A heartbeat: it stays alive.
    Beat,
    /// It no longer holds its id: it ends.
    Gone,
    Other,
}

/// How writing a queued frame to its connection went.
enum Wrote {
    Yes,
    /// Not in time: the connection reads too slowly.
    Late,
    Closed,
}

/// Why a frame did not reach a peer's queue.
enum Undelivered {
    /// The queue is full: the peer reads slowly.
    Full,
    /// The connection ended.
    Gone,
}

struct Peer {
    token: String,
    conn: u64,
    addr: IpAddr,
    out: mpsc::Sender<Queued>,
    backlog: Arc<Backlog>,
}

impl Peer {
    fn send(&self, frame: String) -> Result<(), Undelivered> {
        let bytes = frame.len();
        if !self.backlog.take(bytes) {
            return Err(Undelivered::Full);
        }
        let queued = Queued {
            at: Instant::now(),
            frame,
        };
        self.out.try_send(queued).map_err(|refused| {
            self.backlog.give(bytes);
            match refused {
                mpsc::error::TrySendError::Full(_) => Undelivered::Full,
                mpsc::error::TrySendError::Closed(_) => Undelivered::Gone,
            }
        })
    }
}

/// What a connection holds of its peer: the frames queued for it and their byte count.
struct Joined {
    conn: u64,
    frames: mpsc::Receiver<Queued>,
    backlog: Arc<Backlog>,
}

/// How many frames one connection relays: a burst, then so many per second.
struct Pace {
    burst: f64,
    per_sec: f64,
    left: f64,
    at: Instant,
}

impl Pace {
    fn new(burst: u32, per_sec: u32, now: Instant) -> Pace {
        Pace {
            burst: f64::from(burst),
            per_sec: f64::from(per_sec),
            left: f64::from(burst),
            at: now,
        }
    }

    fn take(&mut self, now: Instant) -> bool {
        let gained = now.saturating_duration_since(self.at).as_secs_f64() * self.per_sec;
        self.left = (self.left + gained).min(self.burst);
        self.at = now;
        let fits = self.left >= 1.0;
        if fits {
            self.left -= 1.0;
        }
        fits
    }
}

/// A message kept for a peer that is not connected, with its sender and the sender's client
/// address.
struct Kept {
    src: String,
    addr: IpAddr,
    frame: String,
}

/// The messages kept for one peer that is not connected.
struct Waiting {
    since: Instant,
    bytes: usize,
    messages: Vec<Kept>,
}

#[derive(Default)]
struct Realm {
    /// The instance turned P2P off: nobody joins.
    off: bool,
    peers: HashMap<String, Peer>,
    waiting: HashMap<String, Waiting>,
    waiting_bytes: usize,
    /// The bytes each client address has waiting.
    waiting_from: HashMap<IpAddr, usize>,
    /// Ids of connections dropped for reading too slowly: the token that held each, and until
    /// when no other token gets it.
    reserved: HashMap<String, (String, Instant)>,
    queued: Arc<AtomicUsize>,
    conns: u64,
}

impl Realm {
    /// Registers `id` for a connection of `client`, or gives the frame that refuses it. A
    /// connection with the token of the one that holds `id` takes its place. Messages kept for
    /// `id` follow `OPEN`.
    fn join(
        &mut self,
        id: &str,
        token: &str,
        limit: usize,
        client: &Client,
    ) -> Result<Joined, String> {
        if self.off {
            return Err(error(TURNED_OFF));
        }
        let now = Instant::now();
        match self.peers.get(id) {
            Some(peer) if peer.token != token => return Err(ID_TAKEN.to_string()),
            Some(_) => {}
            None if matches!(self.reserved.get(id), Some((held, until)) if held != token && now < *until) =>
            {
                return Err(ID_TAKEN.to_string());
            }
            None if self.peers.len() >= limit => return Err(error(LIMIT_REACHED)),
            None => {}
        }
        self.reserved.remove(id);
        let (out, frames) = mpsc::channel(OUT_FRAMES);
        let backlog = Arc::new(Backlog {
            own: AtomicUsize::new(0),
            addr: Arc::clone(&client.queued),
            all: Arc::clone(&self.queued),
        });
        self.conns += 1;
        let peer = Peer {
            token: token.to_string(),
            conn: self.conns,
            addr: client.addr,
            out,
            backlog: Arc::clone(&backlog),
        };
        peer.backlog.count(OPEN.len());
        let opened = Queued {
            at: now,
            frame: OPEN.to_string(),
        };
        if peer.out.try_send(opened).is_err() {
            peer.backlog.give(OPEN.len());
        }
        let mut refused: Vec<String> = Vec::new();
        for Kept {
            src,
            addr: _,
            frame,
        } in self.taken(id)
        {
            if peer.send(frame).is_err() && !refused.contains(&src) {
                refused.push(src);
            }
        }
        self.peers.insert(id.to_string(), peer);
        for src in refused {
            self.relay(EXPIRE, id, &src, None);
        }
        Ok(Joined {
            conn: self.conns,
            frames,
            backlog,
        })
    }

    /// Whether the connection `conn` is the one that holds `id` now.
    fn holds(&self, id: &str, conn: u64) -> bool {
        self.peers.get(id).is_some_and(|peer| peer.conn == conn)
    }

    fn leave(&mut self, id: &str, conn: u64) {
        if self.holds(id, conn) {
            self.peers.remove(id);
        }
    }

    /// Drops the connection `conn` of `id`, which did not take its frames in time. The id
    /// stays with its token for a while, so nobody gets an id by making its holder slow.
    fn stalled(&mut self, id: &str, conn: u64) {
        if !self.holds(id, conn) {
            return;
        }
        let Some(peer) = self.peers.remove(id) else {
            return;
        };
        let now = Instant::now();
        if self.reserved.len() >= RESERVED_MAX {
            self.reserved.retain(|_, (_, until)| now < *until);
        }
        if self.reserved.len() < RESERVED_MAX {
            self.reserved
                .insert(id.to_string(), (peer.token, now + RESERVED));
        }
    }

    /// Takes the messages kept for `dst` out of the store and its counts.
    fn taken(&mut self, dst: &str) -> Vec<Kept> {
        let Some(waiting) = self.waiting.remove(dst) else {
            return Vec::new();
        };
        self.waiting_bytes -= waiting.bytes;
        for kept in &waiting.messages {
            if let Some(from) = self.waiting_from.get_mut(&kept.addr) {
                *from = from.saturating_sub(kept.frame.len());
                if *from == 0 {
                    self.waiting_from.remove(&kept.addr);
                }
            }
        }
        waiting.messages
    }

    /// Closes every connection and drops what waited.
    fn clear(&mut self) {
        self.peers.clear();
        self.waiting.clear();
        self.waiting_bytes = 0;
        self.waiting_from.clear();
        self.reserved.clear();
    }

    /// Sends `kind` from `src` to `dst`. For a `dst` that is not connected it is kept until
    /// `dst` connects or the wait expires (never `LEAVE` or `EXPIRE`). A `dst` whose queue is
    /// full keeps its place and `src` gets `EXPIRE`; one whose connection ended is dropped and
    /// `src` gets `LEAVE`.
    fn relay(&mut self, kind: &str, src: &str, dst: &str, payload: Option<&Value>) {
        let relayed = Relayed {
            kind,
            src,
            dst,
            payload,
        };
        let Ok(frame) = serde_json::to_string(&relayed) else {
            return;
        };
        let Some(peer) = self.peers.get(dst) else {
            return match matches!(kind, LEAVE | EXPIRE) || dst.is_empty() {
                true => {}
                false => self.keep(src, dst, frame),
            };
        };
        match peer.send(frame) {
            Ok(()) => {}
            Err(Undelivered::Gone) => {
                self.peers.remove(dst);
                self.relay(LEAVE, dst, src, None);
            }
            Err(Undelivered::Full) if matches!(kind, LEAVE | EXPIRE) => {}
            Err(Undelivered::Full) => self.relay(EXPIRE, dst, src, None),
        }
    }

    /// Keeps `frame` for `dst`, unless `src`'s client address, `dst` or the whole store holds
    /// too much: then `src` gets `EXPIRE` at once.
    fn keep(&mut self, src: &str, dst: &str, frame: String) {
        let Some(addr) = self.peers.get(src).map(|peer| peer.addr) else {
            return;
        };
        let bytes = frame.len();
        let from = self.waiting_from.get(&addr).copied().unwrap_or(0);
        let full = self.waiting_bytes + bytes > WAITING_BYTES_MAX
            || from + bytes > WAITING_BYTES_ADDR_MAX
            || self.waiting.get(dst).is_some_and(|waiting| {
                waiting.messages.len() >= WAITING_MAX || waiting.bytes + bytes > OUT_BYTES_MAX
            });
        if full {
            return self.relay(EXPIRE, dst, src, None);
        }
        self.waiting_bytes += bytes;
        *self.waiting_from.entry(addr).or_default() += bytes;
        let waiting = self.waiting.entry(dst.to_string()).or_insert(Waiting {
            since: Instant::now(),
            bytes: 0,
            messages: Vec::new(),
        });
        waiting.bytes += bytes;
        waiting.messages.push(Kept {
            src: src.to_string(),
            addr,
            frame,
        });
    }

    /// Drops the messages that waited `wait` or longer and tells each sender with `EXPIRE`.
    fn expire(&mut self, wait: Duration, now: Instant) {
        self.reserved.retain(|_, (_, until)| now < *until);
        let due: Vec<String> = self
            .waiting
            .iter()
            .filter(|(_, waiting)| now.saturating_duration_since(waiting.since) >= wait)
            .map(|(dst, _)| dst.clone())
            .collect();
        for dst in due {
            let mut told: Vec<String> = Vec::new();
            for Kept {
                src,
                addr: _,
                frame: _,
            } in self.taken(&dst)
            {
                if !told.contains(&src) {
                    self.relay(EXPIRE, &dst, &src, None);
                    told.push(src);
                }
            }
        }
    }
}

/// What one client address holds: its open connections and the bytes queued for them.
#[derive(Default)]
struct Share {
    conns: usize,
    queued: Arc<AtomicUsize>,
}

struct Inner {
    settings: Settings,
    realm: Mutex<Realm>,
    open: Mutex<HashMap<IpAddr, Share>>,
}

/// PeerJS signaling as the `peer` package serves it: peers register an id, and offers, answers
/// and candidates go from one to the other. It lives in this process only.
#[derive(Clone)]
pub struct Peers(Arc<Inner>);

/// One open connection of a client address.
struct Slot {
    peers: Peers,
    client: Client,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut open = self.peers.open();
        match open.get_mut(&self.client.addr) {
            Some(share) if share.conns > 1 => share.conns -= 1,
            Some(_) | None => {
                open.remove(&self.client.addr);
            }
        }
    }
}

impl Peers {
    pub fn new(settings: Settings) -> Peers {
        Peers(Arc::new(Inner {
            settings,
            realm: Mutex::default(),
            open: Mutex::default(),
        }))
    }

    fn realm(&self) -> MutexGuard<'_, Realm> {
        match self.0.realm.lock() {
            Ok(realm) => realm,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn open(&self) -> MutexGuard<'_, HashMap<IpAddr, Share>> {
        match self.0.open.lock() {
            Ok(open) => open,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn slot(&self, addr: IpAddr) -> Option<Slot> {
        let max = self.0.settings.peers_per_ip;
        let mut open = self.open();
        let share = open.entry(addr).or_default();
        if max != 0 && share.conns >= max {
            return None;
        }
        share.conns += 1;
        Some(Slot {
            peers: self.clone(),
            client: Client {
                addr,
                queued: Arc::clone(&share.queued),
            },
        })
    }

    /// Whether the signaling serves: it stops while the instance has P2P turned off.
    pub fn on(&self) -> bool {
        !self.realm().off
    }

    /// Turns the signaling on or off. Off closes every connection and refuses new ones.
    pub fn set_on(&self, on: bool) {
        let mut realm = self.realm();
        realm.off = !on;
        if !on {
            realm.clear();
        }
    }

    /// Peers connected now.
    pub fn connected(&self) -> usize {
        self.realm().peers.len()
    }

    /// Closes every connection and drops what waited.
    pub fn close(&self) {
        self.realm().clear();
    }

    /// Tells senders when the peer they wrote to did not connect in time. Never returns.
    pub async fn expire(self) {
        let wait = self.0.settings.expire;
        let every = (wait / 5).clamp(Duration::from_millis(10), Duration::from_secs(1));
        let mut ticks = tokio::time::interval(every);
        loop {
            ticks.tick().await;
            self.realm().expire(wait, Instant::now());
        }
    }

    /// What the connection `conn` of `id` sent. Only the connection that holds the id relays
    /// under it. A frame past the connection's `pace` is refused with `EXPIRE`.
    fn heard(&self, id: &str, conn: u64, text: &str, pace: &mut Pace) -> Heard {
        let Ok(Incoming { kind, dst, payload }) = serde_json::from_str(text) else {
            return Heard::Other;
        };
        let dst = dst.as_deref().unwrap_or_default();
        let mut realm = self.realm();
        if !realm.holds(id, conn) {
            return Heard::Gone;
        }
        match kind.as_str() {
            HEARTBEAT => Heard::Beat,
            LEAVE if dst.is_empty() => {
                realm.leave(id, conn);
                Heard::Gone
            }
            OFFER | ANSWER | CANDIDATE | LEAVE | EXPIRE if dst.len() <= ID_MAX => {
                match pace.take(Instant::now()) {
                    true => realm.relay(&kind, id, dst, payload.as_ref()),
                    false => realm.relay(EXPIRE, dst, id, None),
                }
                Heard::Other
            }
            _ => Heard::Other,
        }
    }

    /// The signaling routes under `/peerjs`.
    pub fn routes(&self, key: ClientIp) -> Router {
        Router::new()
            .route("/peerjs", get(about))
            .route("/peerjs/peerjs", get(socket).layer(Extension(key)))
            .route("/peerjs/{key}/id", get(new_id))
            .with_state(self.clone())
    }
}

/// Describe the PeerJS server
///
/// The fixed description the `peer` package answers with. Only when the instance serves PeerJS
/// signaling itself (`PEERJS_BUILTIN`) and has P2P on. No authentication. Its own general
/// rate-limit bucket, shared by the `/peerjs` routes.
#[utoipa::path(get, path = "/peerjs", tag = "Realtime", responses((status = 200, description = "Name, description and website of the PeerJS server", body = Object), (status = 404, description = "The instance does not serve PeerJS signaling itself, or `P2P is turned off on this instance`: the `p2p` and `p2p_attachments` switches of `GET /api/v1/settings` are both off", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn about(State(peers): State<Peers>) -> Response {
    if !peers.on() {
        return turned_off();
    }
    Json(serde_json::json!({
        "name": "PeerJS Server",
        "description": "A server side element to broker connections between PeerJS clients.",
        "website": "https://peerjs.com/",
    }))
    .into_response()
}

/// The answer while the instance has P2P turned off.
fn turned_off() -> Response {
    (StatusCode::NOT_FOUND, TURNED_OFF).into_response()
}

/// Get a free peer id
///
/// A random id no connected peer uses, as plain text, for PeerJS clients that do not pick their
/// own. Only when the instance serves PeerJS signaling itself (`PEERJS_BUILTIN`) and has P2P on.
/// No authentication. The general rate-limit bucket of the `/peerjs` routes.
#[utoipa::path(get, path = "/peerjs/{key}/id", tag = "Realtime", params(("key" = String, Path, description = "The PeerJS key, `peerjs`. Not checked here.")), responses((status = 200, description = "A free peer id", content_type = "text/plain", body = String), (status = 404, description = "The instance does not serve PeerJS signaling itself, or `P2P is turned off on this instance`: the `p2p` and `p2p_attachments` switches of `GET /api/v1/settings` are both off", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn new_id(State(peers): State<Peers>) -> Response {
    if !peers.on() {
        return turned_off();
    }
    let mut id = crate::identity::random_id();
    while peers.realm().peers.contains_key(&id) {
        id = crate::identity::random_id();
    }
    (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        id,
    )
        .into_response()
}

/// Who a PeerJS client says it is.
#[derive(Deserialize)]
pub(crate) struct Hello {
    id: Option<String>,
    token: Option<String>,
    key: Option<String>,
}

/// Open the PeerJS signaling WebSocket
///
/// The signaling protocol of the `peer` package (1.0.2), for PeerJS clients: peer-to-peer
/// messages, files and calls find each other through it and then talk directly. Only when the
/// instance serves PeerJS signaling itself (`PEERJS_BUILTIN`); `peerjs_url` of
/// `GET /api/v1/instance` names the address. No authentication. While the `p2p` and
/// `p2p_attachments` switches of `GET /api/v1/settings` are both off, it answers 404 and closes
/// the connections that are open.
///
/// Frames are JSON text objects tagged by `type`. After the upgrade the server sends `OPEN`, or
/// refuses and closes: `ID-TAKEN` when a connected peer holds the id under another token (the
/// same token takes the connection over), or `ERROR` with `payload.msg` for a missing `id`,
/// `token` or `key`, a wrong key, an id or token over 128 bytes, or more peers than
/// `PEERJS_CONCURRENT_LIMIT`. A client sends `HEARTBEAT` (every 5 seconds; a connection silent
/// for 90 seconds is closed) and `OFFER`, `ANSWER`, `CANDIDATE` or `LEAVE` with `dst` and
/// `payload`; the peer `dst` gets the same frame with `src` set to the sender. Only the
/// connection that holds an id relays under it.
///
/// A frame for a peer that is not connected waits up to 5 seconds for it; after that the sender
/// gets `EXPIRE` with `src` set to that peer. A frame is refused the same way, at once, when
/// no room is left for it: 64 frames or 256 KiB wait for one absent peer, 512 KiB from one
/// client address, 8 MiB in all; 256 frames or 256 KiB are queued for one connection that reads
/// slowly, 2 MiB for the connections of one client address, 64 MiB in all; or the sender passes
/// its pace (1000 frames at once, then 100 per second). A client address is the one the rate
/// limits use (an IPv6 /64 counts as one; forwarded headers count only from trusted proxies).
/// A connection that does not take a queued frame within 15 seconds is closed, and its id
/// stays with its token for a minute. A sender whose peer's connection just ended gets `LEAVE`
/// from it. Frames are at most 64 KiB. Peers of one process see each other; run one process,
/// or keep the separate PeerJS server.
#[utoipa::path(get, path = "/peerjs/peerjs", tag = "Realtime", params(("key" = String, Query, description = "The PeerJS key: `peerjs`"), ("id" = String, Query, description = "The peer id to register, at most 128 bytes"), ("token" = String, Query, description = "A random value that lets the same client take its id back after a reconnect, at most 128 bytes")), responses((status = 101, description = "WebSocket upgrade"), (status = 404, description = "The instance does not serve PeerJS signaling itself, or `P2P is turned off on this instance`: the `p2p` and `p2p_attachments` switches of `GET /api/v1/settings` are both off", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket, or `PEERJS_PEERS_PER_IP` connections open from this address", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn socket(
    State(peers): State<Peers>,
    Extension(key): Extension<ClientIp>,
    extensions: Extensions,
    headers: HeaderMap,
    Query(hello): Query<Hello>,
    ws: WebSocketUpgrade,
) -> Response {
    if !peers.on() {
        return turned_off();
    }
    let addr = key
        .of(&extensions, &headers)
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let Some(slot) = peers.slot(addr) else {
        return (StatusCode::TOO_MANY_REQUESTS, "Too many connections").into_response();
    };
    ws.max_message_size(FRAME_MAX)
        .max_frame_size(FRAME_MAX)
        .on_upgrade(move |socket| serve(peers, socket, hello, slot))
}

async fn sent(socket: &mut WebSocket, frame: String) -> bool {
    matches!(
        tokio::time::timeout(SEND_TIMEOUT, socket.send(Frame::Text(frame.into()))).await,
        Ok(Ok(()))
    )
}

async fn write(socket: &mut WebSocket, frame: String, by: Instant) -> Wrote {
    match tokio::time::timeout_at(by, socket.send(Frame::Text(frame.into()))).await {
        Ok(Ok(())) => Wrote::Yes,
        Ok(Err(_)) => Wrote::Closed,
        Err(_) => Wrote::Late,
    }
}

async fn hang_up(mut socket: WebSocket) {
    let _ = tokio::time::timeout(SEND_TIMEOUT, socket.send(Frame::Close(None))).await;
}

async fn refuse(mut socket: WebSocket, frame: String) {
    let _ = sent(&mut socket, frame).await;
    hang_up(socket).await;
}

async fn serve(peers: Peers, mut socket: WebSocket, hello: Hello, slot: Slot) {
    let Hello { id, token, key } = hello;
    let given = |value: Option<String>| value.filter(|v| !v.is_empty());
    let (Some(id), Some(token), Some(key)) = (given(id), given(token), given(key)) else {
        return refuse(socket, error(NO_PARAMETERS)).await;
    };
    if key != KEY {
        return refuse(socket, error(INVALID_KEY)).await;
    }
    if id.len() > ID_MAX || token.len() > ID_MAX {
        return refuse(socket, error(TOO_LONG)).await;
    }
    let Settings {
        peers_per_ip: _,
        concurrent_limit,
        expire: _,
        alive,
        burst,
        per_sec,
        stale,
    } = peers.0.settings;
    let joined = peers
        .realm()
        .join(&id, &token, concurrent_limit, &slot.client);
    let Joined {
        conn,
        mut frames,
        backlog,
    } = match joined {
        Ok(joined) => joined,
        Err(frame) => return refuse(socket, frame).await,
    };
    let mut pace = Pace::new(burst, per_sec, Instant::now());
    let mut until = Instant::now() + alive;
    let mut slow = false;
    loop {
        tokio::select! {
            queued = frames.recv() => {
                let Some(Queued { at, frame }) = queued else {
                    break;
                };
                let bytes = frame.len();
                let wrote = match write_by(at, Instant::now(), stale) {
                    Some(by) => write(&mut socket, frame, by).await,
                    None => Wrote::Late,
                };
                backlog.give(bytes);
                match wrote {
                    Wrote::Yes => {}
                    Wrote::Late => {
                        slow = true;
                        break;
                    }
                    Wrote::Closed => break,
                }
            }
            got = socket.recv() => {
                let text = match &got {
                    Some(Ok(Frame::Text(text))) => Some(text.as_str()),
                    Some(Ok(Frame::Binary(bytes))) => std::str::from_utf8(bytes).ok(),
                    Some(Ok(Frame::Ping(_) | Frame::Pong(_))) => None,
                    Some(Ok(Frame::Close(_)) | Err(_)) | None => break,
                };
                match text.map(|text| peers.heard(&id, conn, text, &mut pace)) {
                    Some(Heard::Beat) => until = Instant::now() + alive,
                    Some(Heard::Gone) => break,
                    Some(Heard::Other) | None => {}
                }
            }
            _ = tokio::time::sleep_until(until) => break,
        }
    }
    match slow {
        true => peers.realm().stalled(&id, conn),
        false => peers.realm().leave(&id, conn),
    }
    drop(frames);
    drop(backlog);
    hang_up(socket).await;
    drop(slot);
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as T;

    use super::*;
    use crate::server::client_ip::ProxyTrust;

    type Ws = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    const CEILING: Duration = Duration::from_secs(30);

    struct Served {
        addr: SocketAddr,
        peers: Peers,
        tasks: Vec<tokio::task::JoinHandle<()>>,
    }

    impl Drop for Served {
        fn drop(&mut self) {
            for task in &self.tasks {
                task.abort();
            }
        }
    }

    /// A server behind a proxy on 127.0.0.1: `x-forwarded-for` names the client.
    async fn serve(settings: Settings) -> Served {
        serve_trusting(settings, Some("127.0.0.1")).await
    }

    async fn serve_trusting(settings: Settings, proxies: Option<&str>) -> Served {
        let peers = Peers::new(settings);
        let trusted = ProxyTrust::from_config(false, proxies).expect("trust");
        let app = peers.routes(ClientIp(trusted));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let serving = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        let expiring = tokio::spawn(peers.clone().expire());
        Served {
            addr,
            peers,
            tasks: vec![serving, expiring],
        }
    }

    async fn dial(
        addr: SocketAddr,
        query: &str,
        from: &str,
    ) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut req = format!("ws://{addr}/peerjs/peerjs?{query}")
            .into_client_request()
            .expect("request");
        req.headers_mut()
            .insert("x-forwarded-for", from.parse().expect("header"));
        tokio_tungstenite::connect_async(req)
            .await
            .map(|(ws, _)| ws)
    }

    /// The next JSON frame, or `None` once the socket closed.
    async fn next(ws: &mut Ws) -> Option<Value> {
        loop {
            match tokio::time::timeout(CEILING, ws.next())
                .await
                .expect("a frame or a close in time")
            {
                Some(Ok(T::Text(text))) => {
                    return Some(serde_json::from_str(text.as_str()).expect("json"));
                }
                Some(Ok(T::Close(_)) | Err(_)) | None => return None,
                Some(Ok(_)) => {}
            }
        }
    }

    /// The next frame as the server wrote it.
    async fn raw(ws: &mut Ws) -> String {
        match tokio::time::timeout(CEILING, ws.next())
            .await
            .expect("a frame in time")
        {
            Some(Ok(T::Text(text))) => text.as_str().to_string(),
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    async fn say(ws: &mut Ws, frame: Value) {
        ws.send(T::text(frame.to_string())).await.expect("send");
    }

    /// A peer that registered as `id` and got `OPEN`.
    async fn join(served: &Served, id: &str) -> Ws {
        let query = format!("key=peerjs&id={id}&token=t-{id}&version=1.5.5");
        let mut ws = dial(served.addr, &query, "203.0.113.1")
            .await
            .expect("dial");
        assert_eq!(raw(&mut ws).await, r#"{"type":"OPEN"}"#);
        ws
    }

    async fn until(what: &str, done: impl Fn() -> bool) {
        let ceiling = Instant::now() + CEILING;
        while !done() {
            assert!(Instant::now() < ceiling, "{what}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("json")
    }

    /// A peer registered straight in a realm, as its connection holds it.
    struct Member {
        id: String,
        conn: u64,
        frames: mpsc::Receiver<Queued>,
        backlog: Arc<Backlog>,
    }

    impl Member {
        /// The next queued frame, read as the connection reads it.
        fn next(&mut self) -> Option<String> {
            let Queued { at: _, frame } = self.frames.try_recv().ok()?;
            self.backlog.give(frame.len());
            Some(frame)
        }

        /// Bytes queued for this connection.
        fn held(&self) -> usize {
            self.backlog.own.load(Ordering::Relaxed)
        }
    }

    /// Bytes queued for all connections.
    fn queued(realm: &Realm) -> usize {
        realm.queued.load(Ordering::Relaxed)
    }

    /// A client address with nothing queued yet.
    fn client(addr: &str) -> Client {
        Client {
            addr: addr.parse().expect("address"),
            queued: Arc::default(),
        }
    }

    /// Bytes queued for the connections of `client`.
    fn share(client: &Client) -> usize {
        client.queued.load(Ordering::Relaxed)
    }

    fn member_of(realm: &mut Realm, id: &str, client: &Client) -> Member {
        let Joined {
            conn,
            frames,
            backlog,
        } = realm.join(id, "t", 100_000, client).expect("join");
        Member {
            id: id.to_string(),
            conn,
            frames,
            backlog,
        }
    }

    /// A member from an address of its own.
    fn member(realm: &mut Realm, id: &str) -> Member {
        let n = realm.conns + 1;
        let own = client(&format!(
            "10.{}.{}.{}",
            n >> 16 & 255,
            n >> 8 & 255,
            n & 255
        ));
        member_of(realm, id, &own)
    }

    /// Whether `sender` was told that its frame for `by` found no room, and nothing else.
    fn refused(sender: &mut Member, by: &str) -> bool {
        let told = sender.next();
        assert!(sender.next().is_none());
        match told {
            Some(frame) => {
                assert_eq!(
                    frame,
                    format!(r#"{{"type":"EXPIRE","src":"{by}","dst":"{}"}}"#, sender.id)
                );
                true
            }
            None => false,
        }
    }

    /// Relays `payload` from `sender` to `id` until one frame is refused; how many got in.
    fn fill(realm: &mut Realm, sender: &mut Member, id: &str, payload: &Value) -> usize {
        let from = sender.id.clone();
        let mut sent = 0;
        loop {
            realm.relay(OFFER, &from, id, Some(payload));
            if refused(sender, id) {
                return sent;
            }
            sent += 1;
            assert!(sent < OUT_FRAMES, "the bytes run out before the frames");
        }
    }

    #[tokio::test]
    async fn peers_open_and_relay_offers_answers_and_candidates_with_their_sender() {
        let served = serve(Settings::default()).await;
        let mut alice = join(&served, "alice").await;
        let mut bob = join(&served, "bob").await;
        assert_eq!(served.peers.connected(), 2);
        say(
            &mut alice,
            json(r#"{"type":"OFFER","dst":"bob","src":"mallory","payload":{"sdp":{"type":"offer","sdp":"v=0"},"type":"data","connectionId":"dc_1","browser":"firefox"},"extra":1}"#),
        )
        .await;
        assert_eq!(
            next(&mut bob).await,
            Some(json(
                r#"{"type":"OFFER","src":"alice","dst":"bob","payload":{"sdp":{"type":"offer","sdp":"v=0"},"type":"data","connectionId":"dc_1","browser":"firefox"}}"#
            )),
            "the sender is the connection's own id and only type, dst and payload pass"
        );
        say(
            &mut bob,
            json(r#"{"type":"ANSWER","dst":"alice","payload":{"sdp":{"type":"answer","sdp":"v=0"},"type":"data","connectionId":"dc_1"}}"#),
        )
        .await;
        assert_eq!(
            next(&mut alice).await,
            Some(json(
                r#"{"type":"ANSWER","src":"bob","dst":"alice","payload":{"sdp":{"type":"answer","sdp":"v=0"},"type":"data","connectionId":"dc_1"}}"#
            ))
        );
        for alice_sends in [true, false] {
            let (from, to, name, other) = match alice_sends {
                true => (&mut alice, &mut bob, "alice", "bob"),
                false => (&mut bob, &mut alice, "bob", "alice"),
            };
            let payload = serde_json::json!({
                "candidate": { "candidate": "candidate:1 1 udp 1 192.0.2.1 9 typ host", "sdpMid": "0" },
                "type": "data",
                "connectionId": "dc_1",
            });
            say(
                from,
                serde_json::json!({ "type": "CANDIDATE", "dst": other, "payload": payload }),
            )
            .await;
            assert_eq!(
                next(to).await,
                Some(serde_json::json!({
                    "type": "CANDIDATE", "src": name, "dst": other, "payload": payload,
                }))
            );
        }
        for ignored in [
            r#"{"type":"OFFER""#,
            r#"{"type":"NOPE","dst":"bob","payload":1}"#,
            r#"{"type":5,"dst":"bob"}"#,
            r#"{"type":"OFFER","dst":7,"payload":1}"#,
            r#"{"type":"OPEN","dst":"bob"}"#,
            r#"{"type":"ID-TAKEN","dst":"bob"}"#,
            r#"{"type":"OFFER","payload":1}"#,
            r#"{"type":"OFFER","dst":"","payload":1}"#,
        ] {
            alice.send(T::text(ignored)).await.expect("send");
        }
        alice
            .send(T::binary(
                br#"{"type":"OFFER","dst":"bob","payload":2}"#.to_vec(),
            ))
            .await
            .expect("send");
        assert_eq!(
            raw(&mut bob).await,
            r#"{"type":"OFFER","src":"alice","dst":"bob","payload":2}"#
        );
        drop(alice);
        until("alice left", || served.peers.connected() == 1).await;
        drop(bob);
        until("bob left", || served.peers.connected() == 0).await;
        until("the address holds nothing", || {
            served.peers.open().is_empty()
        })
        .await;
    }

    #[tokio::test]
    async fn a_live_id_is_taken_for_another_token_and_handed_over_for_the_same() {
        let served = serve(Settings::default()).await;
        let mut alice = join(&served, "alice").await;
        let mut other = dial(
            served.addr,
            "key=peerjs&id=alice&token=another",
            "203.0.113.2",
        )
        .await
        .expect("dial");
        assert_eq!(
            raw(&mut other).await,
            r#"{"type":"ID-TAKEN","payload":{"msg":"ID is taken"}}"#
        );
        assert_eq!(next(&mut other).await, None, "and the socket closes");
        let mut bob = join(&served, "bob").await;
        say(
            &mut bob,
            json(r#"{"type":"OFFER","dst":"alice","payload":1}"#),
        )
        .await;
        assert_eq!(
            next(&mut alice).await,
            Some(json(
                r#"{"type":"OFFER","src":"bob","dst":"alice","payload":1}"#
            )),
            "the first connection still holds the id"
        );
        let mut again = join(&served, "alice").await;
        assert_eq!(next(&mut alice).await, None, "the old connection closes");
        assert_eq!(served.peers.connected(), 2);
        say(
            &mut bob,
            json(r#"{"type":"OFFER","dst":"alice","payload":2}"#),
        )
        .await;
        assert_eq!(
            next(&mut again).await,
            Some(json(
                r#"{"type":"OFFER","src":"bob","dst":"alice","payload":2}"#
            ))
        );
        drop(again);
        until("alice left", || served.peers.connected() == 1).await;
        let mut fresh = dial(
            served.addr,
            "key=peerjs&id=alice&token=another",
            "203.0.113.2",
        )
        .await
        .expect("dial");
        assert_eq!(raw(&mut fresh).await, OPEN, "a free id goes to any token");
    }

    #[tokio::test]
    async fn a_message_waits_for_its_peer_and_expires_when_it_never_comes() {
        let wait = Duration::from_millis(400);
        let served = serve(Settings {
            expire: wait,
            ..Settings::default()
        })
        .await;
        let mut alice = join(&served, "alice").await;
        let mut carol = join(&served, "carol").await;
        let waiting = |dst: &'static str, n: usize| {
            let peers = served.peers.clone();
            move || {
                let realm = peers.realm();
                realm.waiting.get(dst).map_or(0, |w| w.messages.len()) == n
            }
        };
        for n in 1..=2 {
            say(
                &mut alice,
                serde_json::json!({ "type": "OFFER", "dst": "bob", "payload": n }),
            )
            .await;
        }
        until("alice's messages wait", waiting("bob", 2)).await;
        say(
            &mut carol,
            json(r#"{"type":"CANDIDATE","dst":"bob","payload":3}"#),
        )
        .await;
        until("carol's message waits", waiting("bob", 3)).await;
        let mut bob = join(&served, "bob").await;
        let mut got = Vec::new();
        for _ in 0..3 {
            got.push(next(&mut bob).await.expect("a kept message"));
        }
        assert_eq!(
            got,
            [
                json(r#"{"type":"OFFER","src":"alice","dst":"bob","payload":1}"#),
                json(r#"{"type":"OFFER","src":"alice","dst":"bob","payload":2}"#),
                json(r#"{"type":"CANDIDATE","src":"carol","dst":"bob","payload":3}"#),
            ]
        );
        assert!(served.peers.realm().waiting.is_empty());
        assert_eq!(served.peers.realm().waiting_bytes, 0);

        let asked = Instant::now();
        for n in 1..=2 {
            say(
                &mut alice,
                serde_json::json!({ "type": "OFFER", "dst": "dave", "payload": n }),
            )
            .await;
        }
        say(
            &mut carol,
            json(r#"{"type":"ANSWER","dst":"dave","payload":3}"#),
        )
        .await;
        for unkept in ["LEAVE", "EXPIRE"] {
            say(
                &mut alice,
                serde_json::json!({ "type": unkept, "dst": "erin" }),
            )
            .await;
        }
        assert_eq!(
            raw(&mut alice).await,
            r#"{"type":"EXPIRE","src":"dave","dst":"alice"}"#
        );
        assert!(asked.elapsed() >= wait, "{:?}", asked.elapsed());
        assert_eq!(
            raw(&mut carol).await,
            r#"{"type":"EXPIRE","src":"dave","dst":"carol"}"#
        );
        assert!(served.peers.realm().waiting.is_empty());
        assert_eq!(served.peers.realm().waiting_bytes, 0);
        tokio::time::sleep(wait * 2).await;
        let mut dave = join(&served, "dave").await;
        say(
            &mut alice,
            json(r#"{"type":"OFFER","dst":"dave","payload":9}"#),
        )
        .await;
        assert_eq!(
            raw(&mut dave).await,
            r#"{"type":"OFFER","src":"alice","dst":"dave","payload":9}"#,
            "nothing expired reaches a peer that comes later"
        );
        say(
            &mut alice,
            json(r#"{"type":"OFFER","dst":"alice","payload":0}"#),
        )
        .await;
        assert_eq!(
            raw(&mut alice).await,
            r#"{"type":"OFFER","src":"alice","dst":"alice","payload":0}"#,
            "one EXPIRE per peer, and none for LEAVE or EXPIRE"
        );
    }

    #[tokio::test]
    async fn waiting_messages_are_bounded() {
        let served = serve(Settings {
            expire: Duration::from_secs(3600),
            ..Settings::default()
        })
        .await;
        let mut alice = join(&served, "alice").await;
        for n in 0..WAITING_MAX + 1 {
            say(
                &mut alice,
                serde_json::json!({ "type": "CANDIDATE", "dst": "bob", "payload": n }),
            )
            .await;
        }
        assert_eq!(
            raw(&mut alice).await,
            r#"{"type":"EXPIRE","src":"bob","dst":"alice"}"#,
            "the message past the limit is refused at once"
        );
        let kept = |peers: &Peers| {
            let realm = peers.realm();
            (
                realm.waiting.get("bob").map_or(0, |w| w.messages.len()),
                realm.waiting_bytes,
            )
        };
        let (messages, bytes) = kept(&served.peers);
        assert_eq!(messages, WAITING_MAX);
        assert!(bytes > 0 && bytes < 8 * 1024);
        let long = "x".repeat(ID_MAX + 1);
        say(
            &mut alice,
            serde_json::json!({ "type": "OFFER", "dst": long, "payload": 1 }),
        )
        .await;
        say(
            &mut alice,
            json(r#"{"type":"OFFER","dst":"alice","payload":0}"#),
        )
        .await;
        assert_eq!(
            raw(&mut alice).await,
            r#"{"type":"OFFER","src":"alice","dst":"alice","payload":0}"#
        );
        assert_eq!(
            kept(&served.peers),
            (messages, bytes),
            "nothing waits for an id no peer can have"
        );
        served.peers.close();
        assert_eq!(
            next(&mut alice).await,
            None,
            "closing ends every connection"
        );
        assert_eq!(kept(&served.peers), (0, 0));
    }

    #[tokio::test]
    async fn leave_is_relayed_and_a_dead_peer_answers_leave() {
        let served = serve(Settings::default()).await;
        let mut alice = join(&served, "alice").await;
        let mut bob = join(&served, "bob").await;
        say(&mut alice, json(r#"{"type":"LEAVE","dst":"bob"}"#)).await;
        assert_eq!(
            raw(&mut bob).await,
            r#"{"type":"LEAVE","src":"alice","dst":"bob"}"#
        );
        say(&mut alice, json(r#"{"type":"LEAVE"}"#)).await;
        assert_eq!(
            next(&mut alice).await,
            None,
            "LEAVE without a peer ends the sender's connection"
        );
        until("alice left", || served.peers.connected() == 1).await;

        let mut realm = Realm::default();
        let mut alice = member(&mut realm, "alice");
        drop(member(&mut realm, "bob"));
        assert_eq!(alice.next().as_deref(), Some(OPEN));
        realm.relay(OFFER, "alice", "bob", Some(&Value::from(1)));
        assert_eq!(
            alice.next().as_deref(),
            Some(r#"{"type":"LEAVE","src":"bob","dst":"alice"}"#)
        );
        assert!(!realm.peers.contains_key("bob"));
        assert!(realm.waiting.is_empty());
        drop(alice);
        let mut carol = member(&mut realm, "carol");
        assert_eq!(carol.next().as_deref(), Some(OPEN));
        realm.relay(LEAVE, "carol", "alice", None);
        assert_eq!(
            carol.next().as_deref(),
            Some(r#"{"type":"LEAVE","src":"alice","dst":"carol"}"#)
        );
        assert!(!realm.peers.contains_key("alice"));
        drop(carol);
        drop(member(&mut realm, "dave"));
        realm.relay(OFFER, "carol", "dave", None);
        assert!(realm.peers.is_empty(), "two dead peers end there");
        assert!(realm.waiting.is_empty());
    }

    #[test]
    fn a_peer_that_reads_slowly_keeps_its_id_and_the_sender_is_told() {
        let mut realm = Realm::default();
        let mut alice = member(&mut realm, "alice");
        let mut slow = member(&mut realm, "slow");
        assert_eq!(alice.next().as_deref(), Some(OPEN));
        for n in 0..OUT_FRAMES {
            realm.relay(CANDIDATE, "alice", "slow", Some(&Value::from(n)));
        }
        assert!(
            realm.peers.contains_key("slow"),
            "another peer's frames never cost a peer its id"
        );
        assert_eq!(
            alice.next().as_deref(),
            Some(r#"{"type":"EXPIRE","src":"slow","dst":"alice"}"#),
            "the frame that did not fit is refused"
        );
        assert_eq!(alice.next(), None);
        for unanswered in [LEAVE, EXPIRE] {
            realm.relay(unanswered, "alice", "slow", None);
        }
        assert_eq!(
            alice.next(),
            None,
            "a refused LEAVE or EXPIRE has no answer"
        );
        let mut seen = 0;
        while slow.next().is_some() {
            seen += 1;
        }
        assert_eq!(seen, OUT_FRAMES);
        assert_eq!(slow.held(), 0);
        realm.relay(CANDIDATE, "alice", "slow", Some(&Value::from(7)));
        assert_eq!(
            slow.next().as_deref(),
            Some(r#"{"type":"CANDIDATE","src":"alice","dst":"slow","payload":7}"#),
            "frames flow again once it reads"
        );
        assert!(realm.waiting.is_empty());
    }

    #[test]
    fn a_connection_queue_is_bounded_in_bytes() {
        let mut realm = Realm::default();
        let big = Value::String("y".repeat(FRAME_MAX / 2));
        let mut alice = member(&mut realm, "alice");
        assert_eq!(alice.next().as_deref(), Some(OPEN));
        let mut slow = member(&mut realm, "slow");
        let sent = fill(&mut realm, &mut alice, "slow", &big);
        assert!((4..=8).contains(&sent), "{sent}");
        assert!(slow.held() <= OUT_BYTES_MAX);
        assert!(slow.held() > OUT_BYTES_MAX - FRAME_MAX);
        assert_eq!(queued(&realm), slow.held());
        assert!(realm.peers.contains_key("slow"));
        assert_eq!(slow.next().as_deref(), Some(OPEN));
        assert!(slow.next().is_some_and(|frame| frame.len() > FRAME_MAX / 2));
        realm.relay(OFFER, "alice", "slow", Some(&big));
        assert!(!refused(&mut alice, "slow"), "reading makes room");
        let held = slow.held();
        assert!(held > 0);
        realm.leave(&slow.id, slow.conn);
        drop(slow);
        assert_eq!(queued(&realm), 0, "a closed connection frees what it held");
    }

    /// The reviewer's case: one client that does not read fills what its address may hold, and
    /// everyone else's frames still go through.
    #[test]
    fn one_address_holds_only_its_share_and_others_still_relay() {
        let mut realm = Realm::default();
        let big = Value::String("y".repeat(FRAME_MAX / 2));
        let mut alice = member(&mut realm, "alice");
        let mut bob = member(&mut realm, "bob");
        assert_eq!(alice.next().as_deref(), Some(OPEN));
        assert_eq!(bob.next().as_deref(), Some(OPEN));
        let hog = client("203.0.113.7");
        let most = OUT_BYTES_ADDR_MAX / OUT_BYTES_MAX;
        let mut stalled = Vec::new();
        let mut fits = Vec::new();
        for n in 0..most + 6 {
            let id = format!("hog{n}");
            stalled.push(member_of(&mut realm, &id, &hog));
            fits.push(fill(&mut realm, &mut alice, &id, &big));
        }
        assert!(fits[0] >= 4, "{fits:?}");
        assert!(
            fits[most + 2..].iter().all(|fit| *fit == 0),
            "the address is full whatever the number of its connections: {fits:?}"
        );
        assert!(share(&hog) <= OUT_BYTES_ADDR_MAX + (most + 6) * OPEN.len());
        assert!(share(&hog) > OUT_BYTES_ADDR_MAX - FRAME_MAX);
        assert_eq!(queued(&realm), share(&hog));
        assert!(queued(&realm) < OUT_BYTES_TOTAL_MAX / 16);
        assert_eq!(realm.peers.len(), most + 8, "nobody lost a place");

        for n in 0..200 {
            realm.relay(OFFER, "alice", "bob", Some(&big));
            assert!(!refused(&mut alice, "bob"), "frame {n}");
            assert!(bob.next().is_some_and(|frame| frame.len() > FRAME_MAX / 2));
        }
        let mut carol = member(&mut realm, "carol");
        assert_eq!(carol.next().as_deref(), Some(OPEN));
        assert!(fill(&mut realm, &mut alice, "carol", &big) >= 4);

        // One of the address's connections reads two frames: only that much room comes back.
        let first = &mut stalled[0];
        assert_eq!(first.next().as_deref(), Some(OPEN));
        let read = first.next().expect("a frame").len() + first.next().expect("a frame").len();
        let last = format!("hog{}", most + 5);
        let again = fill(&mut realm, &mut alice, &last, &big);
        assert!(
            (1..=2).contains(&again),
            "{read} bytes were read, {again} frames fit"
        );

        // Its connections end: the address holds nothing.
        for gone in stalled {
            realm.leave(&gone.id, gone.conn);
        }
        assert_eq!(share(&hog), 0);
        assert_eq!(queued(&realm), carol.held());
        assert!(carol.held() > 0);
    }

    #[test]
    fn many_addresses_at_their_cap_stop_at_the_shared_budget() {
        let mut realm = Realm::default();
        let big = Value::String("y".repeat(FRAME_MAX / 2));
        let mut alice = member(&mut realm, "alice");
        assert_eq!(alice.next().as_deref(), Some(OPEN));
        let per_address = OUT_BYTES_ADDR_MAX / OUT_BYTES_MAX + 2;
        let addresses = OUT_BYTES_TOTAL_MAX / OUT_BYTES_ADDR_MAX + 3;
        let mut held = Vec::new();
        let mut clients = Vec::new();
        let mut shut_out = 0;
        for a in 0..addresses {
            // IPv4 hosts and IPv6 /64s alike: each is one address.
            let one = match a % 2 {
                0 => client(&format!("198.51.100.{a}")),
                _ => client(&format!("2001:db8:0:{a:x}::")),
            };
            for n in 0..per_address {
                let id = format!("a{a}n{n}");
                held.push(member_of(&mut realm, &id, &one));
                fill(&mut realm, &mut alice, &id, &big);
            }
            assert!(
                share(&one) <= OUT_BYTES_ADDR_MAX + per_address * OPEN.len(),
                "address {a}"
            );
            if share(&one) < OUT_BYTES_ADDR_MAX / 2 {
                shut_out += 1;
            }
            clients.push(one);
        }
        let opens = (addresses * per_address + 1) * OPEN.len();
        assert!(queued(&realm) <= OUT_BYTES_TOTAL_MAX + opens);
        assert!(queued(&realm) > OUT_BYTES_TOTAL_MAX - FRAME_MAX);
        assert_eq!(
            queued(&realm),
            clients.iter().map(share).sum::<usize>() + alice.held()
        );
        assert!(
            (2..=3).contains(&shut_out),
            "{shut_out} addresses came after the shared budget was used up"
        );
        let mut late = member(&mut realm, "late");
        assert_eq!(late.next().as_deref(), Some(OPEN), "OPEN always fits");
        realm.relay(OFFER, "alice", "late", Some(&big));
        assert!(refused(&mut alice, "late"));

        // Room comes back as soon as one address is gone.
        let before = queued(&realm);
        let freed = share(&clients[0]);
        for gone in held.drain(..per_address) {
            realm.leave(&gone.id, gone.conn);
        }
        assert_eq!(share(&clients[0]), 0);
        assert_eq!(queued(&realm), before - freed);
        realm.relay(OFFER, "alice", "late", Some(&big));
        assert!(!refused(&mut alice, "late"));
        realm.peers.clear();
        drop(held);
        drop(late);
        drop(alice);
        assert_eq!(
            queued(&realm),
            0,
            "nothing is counted once every connection ended"
        );
    }

    #[test]
    fn waiting_messages_are_shared_out_by_sender_address() {
        let mut realm = Realm::default();
        let big = Value::String("y".repeat(FRAME_MAX / 2));
        let hog = client("203.0.113.7");
        let mut senders: Vec<Member> = (0..3)
            .map(|n| member_of(&mut realm, &format!("hog{n}"), &hog))
            .collect();
        for sender in &mut senders {
            assert_eq!(sender.next().as_deref(), Some(OPEN));
        }
        let waiting_from =
            |realm: &Realm, of: &Client| realm.waiting_from.get(&of.addr).copied().unwrap_or(0);
        // Each frame goes to another absent peer: only the address's share stops them.
        let mut kept = 0;
        'address: loop {
            for sender in &mut senders {
                let from = sender.id.clone();
                realm.relay(OFFER, &from, &format!("absent{kept}"), Some(&big));
                if refused(sender, &format!("absent{kept}")) {
                    break 'address;
                }
                kept += 1;
                assert!(kept < 1000);
            }
        }
        assert!(waiting_from(&realm, &hog) <= WAITING_BYTES_ADDR_MAX);
        assert!(waiting_from(&realm, &hog) > WAITING_BYTES_ADDR_MAX - FRAME_MAX);
        assert_eq!(realm.waiting_bytes, waiting_from(&realm, &hog));
        assert!(realm.waiting_bytes < WAITING_BYTES_MAX / 8);
        assert_eq!(realm.waiting.len(), kept);

        // Another address still gets its messages kept, and delivered.
        let mut alice = member(&mut realm, "alice");
        assert_eq!(alice.next().as_deref(), Some(OPEN));
        realm.relay(OFFER, "alice", "bob", Some(&Value::from(1)));
        assert!(!refused(&mut alice, "bob"));
        let mut bob = member(&mut realm, "bob");
        assert_eq!(bob.next().as_deref(), Some(OPEN));
        assert_eq!(
            bob.next().as_deref(),
            Some(r#"{"type":"OFFER","src":"alice","dst":"bob","payload":1}"#)
        );
        assert_eq!(realm.waiting_from.len(), 1, "only the first address waits");

        // A sender that is gone keeps nothing more, and expiry gives the share back.
        let gone = senders.pop().expect("a sender");
        realm.leave(&gone.id, gone.conn);
        realm.relay(OFFER, &gone.id, "nobody", Some(&big));
        assert!(!realm.waiting.contains_key("nobody"));
        realm.expire(Duration::ZERO, Instant::now());
        assert!(realm.waiting.is_empty() && realm.waiting_from.is_empty());
        assert_eq!(realm.waiting_bytes, 0);
        for sender in &mut senders {
            let mut told = 0;
            while let Some(frame) = sender.next() {
                assert!(
                    frame.starts_with(r#"{"type":"EXPIRE","src":"absent"#),
                    "{frame}"
                );
                told += 1;
            }
            assert!(told >= 1, "one EXPIRE for each peer that never came");
        }
        let from = senders[0].id.clone();
        realm.relay(OFFER, &from, "absent", Some(&big));
        assert!(!refused(&mut senders[0], "absent"));

        // The whole store is bounded too, whatever the number of addresses.
        let mut others = Vec::new();
        for a in 0..WAITING_BYTES_MAX / WAITING_BYTES_ADDR_MAX + 3 {
            let one = client(&format!("198.51.100.{a}"));
            let mut sender = member_of(&mut realm, &format!("s{a}"), &one);
            assert_eq!(sender.next().as_deref(), Some(OPEN));
            for n in 0..WAITING_BYTES_ADDR_MAX / (FRAME_MAX / 2) + 2 {
                let from = sender.id.clone();
                realm.relay(OFFER, &from, &format!("x{a}n{n}"), Some(&big));
                while sender.next().is_some() {}
            }
            assert!(waiting_from(&realm, &one) <= WAITING_BYTES_ADDR_MAX);
            others.push(sender);
        }
        assert!(realm.waiting_bytes <= WAITING_BYTES_MAX);
        assert!(realm.waiting_bytes > WAITING_BYTES_MAX - FRAME_MAX);
        assert_eq!(
            realm.waiting_bytes,
            realm.waiting_from.values().sum::<usize>()
        );
    }

    #[test]
    fn a_queued_frame_must_be_written_in_time() {
        let stale = Duration::from_secs(15);
        let queued = Instant::now();
        let at = |secs: u64| queued + Duration::from_secs(secs);
        assert_eq!(write_by(queued, queued, stale), Some(queued + SEND_TIMEOUT));
        assert_eq!(write_by(queued, at(3), stale), Some(at(13)));
        assert_eq!(write_by(queued, at(9), stale), Some(at(15)));
        assert_eq!(write_by(queued, at(14), stale), Some(at(15)));
        assert_eq!(write_by(queued, at(15), stale), None);
        assert_eq!(write_by(queued, at(60), stale), None);
        let stock = Settings::default();
        assert_eq!(stock.stale, stale);
        let shares = [
            (OUT_BYTES_MAX, OUT_BYTES_ADDR_MAX, 8),
            (OUT_BYTES_ADDR_MAX, OUT_BYTES_TOTAL_MAX, 16),
            (WAITING_BYTES_ADDR_MAX, WAITING_BYTES_MAX, 16),
        ];
        for (part, whole, times) in shares {
            assert!(part * times <= whole, "{part} of {whole}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_id_of_a_dropped_slow_connection_stays_with_its_token() {
        let mut realm = Realm::default();
        let home = client("203.0.113.1");
        let other = client("203.0.113.2");
        let limit = 100;
        let slow = realm.join("slow", "its-token", limit, &home).expect("join");
        realm.stalled("slow", slow.conn + 1);
        assert!(realm.peers.contains_key("slow"), "not its connection");
        realm.stalled("slow", slow.conn);
        assert!(!realm.peers.contains_key("slow"));
        assert_eq!(
            realm
                .join("slow", "another", limit, &other)
                .err()
                .as_deref(),
            Some(ID_TAKEN),
            "nobody gets an id by making its holder slow"
        );
        tokio::time::advance(RESERVED - Duration::from_secs(1)).await;
        assert!(realm.join("slow", "another", limit, &other).is_err());
        let back = realm.join("slow", "its-token", limit, &home).expect("back");
        assert!(realm.reserved.is_empty());
        realm.leave("slow", back.conn);
        assert!(
            realm.join("slow", "another", limit, &other).is_ok(),
            "an id its holder left is free"
        );
        realm.leave("slow", realm.conns);

        let again = realm.join("slow", "its-token", limit, &home).expect("join");
        realm.stalled("slow", again.conn);
        tokio::time::advance(RESERVED).await;
        realm.expire(Duration::from_secs(5), Instant::now());
        assert!(realm.reserved.is_empty(), "forgotten after a minute");
        assert!(realm.join("slow", "another", limit, &other).is_ok());

        for n in 0..RESERVED_MAX + 50 {
            let id = format!("p{n}");
            let joined = realm.join(&id, "t", usize::MAX, &home).expect("join");
            realm.stalled(&id, joined.conn);
        }
        assert_eq!(realm.reserved.len(), RESERVED_MAX);
        tokio::time::advance(RESERVED).await;
        let joined = realm.join("fresh", "t", usize::MAX, &home).expect("join");
        realm.stalled("fresh", joined.conn);
        assert_eq!(realm.reserved.len(), 1, "old entries make room");
    }

    #[test]
    fn only_the_connection_that_holds_an_id_relays_under_it() {
        let peers = Peers::new(Settings::default());
        let home = client("203.0.113.1");
        let mut pace = Pace::new(1000, 0, Instant::now());
        let offer = r#"{"type":"OFFER","dst":"bob","payload":1}"#;
        let first = peers.realm().join("alice", "t", 10, &home).expect("join");
        let mut bob = {
            let mut realm = peers.realm();
            member_of(&mut realm, "bob", &client("203.0.113.2"))
        };
        assert_eq!(bob.next().as_deref(), Some(OPEN));
        assert!(matches!(
            peers.heard("alice", first.conn, offer, &mut pace),
            Heard::Other
        ));
        assert!(bob.next().is_some());
        // The same token connects again: the first connection holds the id no more.
        let second = peers.realm().join("alice", "t", 10, &home).expect("join");
        for frame in [offer, r#"{"type":"HEARTBEAT"}"#, r#"{"type":"LEAVE"}"#] {
            assert!(matches!(
                peers.heard("alice", first.conn, frame, &mut pace),
                Heard::Gone
            ));
        }
        assert_eq!(bob.next(), None, "nothing is relayed for it");
        assert!(peers.realm().holds("alice", second.conn));
        assert!(matches!(
            peers.heard("alice", second.conn, r#"{"type":"HEARTBEAT"}"#, &mut pace),
            Heard::Beat
        ));
        assert!(matches!(
            peers.heard("alice", second.conn, "not json", &mut pace),
            Heard::Other
        ));
        // It leaves, another token takes the id: the old connection can't speak as it.
        assert!(matches!(
            peers.heard("alice", second.conn, r#"{"type":"LEAVE"}"#, &mut pace),
            Heard::Gone
        ));
        let taken = peers
            .realm()
            .join("alice", "another", 10, &home)
            .expect("join");
        assert!(matches!(
            peers.heard("alice", second.conn, offer, &mut pace),
            Heard::Gone
        ));
        assert_eq!(bob.next(), None);
        assert!(matches!(
            peers.heard("alice", taken.conn, offer, &mut pace),
            Heard::Other
        ));
        assert_eq!(
            bob.next().as_deref(),
            Some(r#"{"type":"OFFER","src":"alice","dst":"bob","payload":1}"#)
        );
    }

    #[test]
    fn a_connection_relays_a_burst_and_then_at_a_pace() {
        let start = Instant::now();
        let mut pace = Pace::new(100, 10, start);
        for _ in 0..100 {
            assert!(pace.take(start));
        }
        assert!(!pace.take(start));
        assert!(!pace.take(start + Duration::from_millis(50)));
        assert!(pace.take(start + Duration::from_millis(150)));
        assert!(!pace.take(start + Duration::from_millis(150)));
        let later = start + Duration::from_secs(1);
        let passed = (0..50).filter(|_| pace.take(later)).count();
        assert_eq!(passed, 9);
        let idle = start + Duration::from_secs(3600);
        let passed = (0..500).filter(|_| pace.take(idle)).count();
        assert_eq!(passed, 100, "idle time never adds more than the burst");
        let mut none = Pace::new(2, 0, start);
        assert!(none.take(idle) && none.take(idle) && !none.take(idle + Duration::from_secs(60)));
        let stock = Settings::default();
        assert_eq!((stock.burst, stock.per_sec), (1000, 100));
    }

    #[tokio::test]
    async fn frames_past_the_pace_are_refused_and_heartbeats_still_count() {
        let served = serve(Settings {
            burst: 3,
            per_sec: 0,
            alive: Duration::from_secs(3),
            ..Settings::default()
        })
        .await;
        let mut alice = join(&served, "alice").await;
        let mut bob = join(&served, "bob").await;
        let opened = Instant::now();
        for n in 1..=5 {
            say(
                &mut alice,
                serde_json::json!({ "type": "OFFER", "dst": "bob", "payload": n }),
            )
            .await;
        }
        for n in 1..=3 {
            assert_eq!(
                raw(&mut bob).await,
                format!(r#"{{"type":"OFFER","src":"alice","dst":"bob","payload":{n}}}"#)
            );
        }
        for _ in 0..2 {
            assert_eq!(
                raw(&mut alice).await,
                r#"{"type":"EXPIRE","src":"bob","dst":"alice"}"#
            );
        }
        say(
            &mut bob,
            json(r#"{"type":"ANSWER","dst":"alice","payload":9}"#),
        )
        .await;
        assert_eq!(
            raw(&mut alice).await,
            r#"{"type":"ANSWER","src":"bob","dst":"alice","payload":9}"#,
            "each connection has its own pace, and bob got nothing past alice's"
        );
        while opened.elapsed() < Duration::from_millis(4500) {
            say(&mut alice, json(r#"{"type":"HEARTBEAT"}"#)).await;
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        assert_eq!(next(&mut bob).await, None, "bob sent no heartbeat");
        assert_eq!(
            served.peers.connected(),
            1,
            "heartbeats are outside the pace"
        );
    }

    #[tokio::test]
    async fn heartbeats_keep_a_connection_and_silence_closes_it() {
        let alive = Duration::from_secs(3);
        let served = serve(Settings {
            alive,
            ..Settings::default()
        })
        .await;
        let before = Instant::now();
        let mut quiet = join(&served, "quiet").await;
        let mut beating = join(&served, "beating").await;
        let opened = Instant::now();
        let quiet_closed = tokio::spawn(async move {
            let closed = next(&mut quiet).await;
            (closed, Instant::now())
        });
        while opened.elapsed() < alive * 3 / 2 {
            say(&mut beating, json(r#"{"type":"HEARTBEAT"}"#)).await;
            tokio::time::sleep(alive / 20).await;
        }
        let (closed, at) = quiet_closed.await.expect("quiet");
        assert_eq!(closed, None);
        assert!(at.duration_since(before) >= alive);
        assert_eq!(served.peers.connected(), 1, "heartbeats kept the other");
        say(
            &mut beating,
            json(r#"{"type":"OFFER","dst":"beating","payload":1}"#),
        )
        .await;
        assert_eq!(
            next(&mut beating).await,
            Some(json(
                r#"{"type":"OFFER","src":"beating","dst":"beating","payload":1}"#
            )),
            "a heartbeat has no answer"
        );
        assert_eq!(next(&mut beating).await, None, "other frames do not count");
    }

    fn too_many(dialed: Result<Ws, tokio_tungstenite::tungstenite::Error>) {
        match dialed {
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
                assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
                if let Some(body) = res.body() {
                    assert_eq!(body.as_slice(), b"Too many connections");
                }
            }
            Err(e) => panic!("unexpected error {e}"),
            Ok(_) => panic!("a connection past the cap was accepted"),
        }
    }

    #[tokio::test]
    async fn connections_are_capped_per_address() {
        let served = serve(Settings {
            peers_per_ip: 2,
            ..Settings::default()
        })
        .await;
        let hello = |id: &str| format!("key=peerjs&id={id}&token=t");
        let open = |from: &'static str, id: &'static str| {
            let query = hello(id);
            let addr = served.addr;
            async move {
                let mut ws = dial(addr, &query, from).await.expect("dial");
                assert_eq!(raw(&mut ws).await, OPEN);
                ws
            }
        };
        let mut held = vec![
            open("203.0.113.5", "a").await,
            open("203.0.113.5", "b").await,
        ];
        too_many(dial(served.addr, &hello("c"), "203.0.113.5").await);
        let _v6 = [
            open("2001:db8:1:2::1", "c").await,
            open("2001:db8:1:2:ffff::9", "d").await,
        ];
        too_many(dial(served.addr, &hello("e"), "2001:db8:1:2::7").await);
        let _other = open("2001:db8:1:3::1", "e").await;
        let v4: IpAddr = "203.0.113.5".parse().expect("ip");
        let conns = |addr: &IpAddr| served.peers.open().get(addr).map(|share| share.conns);
        assert_eq!(conns(&v4), Some(2));
        let mut v6: Vec<usize> = served
            .peers
            .open()
            .iter()
            .filter(|(addr, _)| addr.is_ipv6())
            .map(|(_, share)| share.conns)
            .collect();
        v6.sort();
        assert_eq!(v6, [1, 2], "an IPv6 /64 is one address, with one share");
        drop(held.pop());
        until("the slot is free again", || conns(&v4) == Some(1)).await;
        let _next_tab = open("203.0.113.5", "f").await;
        too_many(dial(served.addr, &hello("g"), "203.0.113.5").await);
        assert_eq!(served.peers.connected(), 5);

        let unlimited = serve(Settings {
            peers_per_ip: 0,
            ..Settings::default()
        })
        .await;
        let mut many = Vec::new();
        for n in 0..DEFAULT_PEERS_PER_IP + 5 {
            many.push(join(&unlimited, &format!("p{n}")).await);
        }
        assert_eq!(unlimited.peers.connected(), DEFAULT_PEERS_PER_IP + 5);
    }

    #[tokio::test]
    async fn a_client_can_not_name_its_own_address() {
        // No trusted proxy: the address is the connection's own, whatever the header says.
        let served = serve_trusting(
            Settings {
                peers_per_ip: 2,
                ..Settings::default()
            },
            None,
        )
        .await;
        let hello = |id: &str| format!("key=peerjs&id={id}&token=t");
        let mut held = Vec::new();
        for (id, claimed) in [("a", "203.0.113.1"), ("b", "203.0.113.2")] {
            let mut ws = dial(served.addr, &hello(id), claimed).await.expect("dial");
            assert_eq!(raw(&mut ws).await, OPEN);
            held.push(ws);
        }
        too_many(dial(served.addr, &hello("c"), "203.0.113.3").await);
        too_many(dial(served.addr, &hello("d"), "2001:db8::9").await);
        let open = served.peers.open();
        let local: IpAddr = "127.0.0.1".parse().expect("ip");
        assert_eq!(open.len(), 1);
        assert_eq!(open.get(&local).map(|share| share.conns), Some(2));
    }

    #[tokio::test]
    async fn a_client_that_stops_reading_is_dropped_and_others_still_relay() {
        let served = serve(Settings {
            stale: Duration::from_millis(800),
            ..Settings::default()
        })
        .await;
        let alice = join(&served, "alice").await;
        let mut bob = join(&served, "bob").await;
        // A peer at another address that never reads what the server sends it.
        let stalled = dial(
            served.addr,
            "key=peerjs&id=slow&token=its-token",
            "203.0.113.50",
        )
        .await
        .expect("dial");
        until("the slow peer joined", || served.peers.connected() == 3).await;
        let slow_holds = |peers: &Peers| {
            let realm = peers.realm();
            realm
                .peers
                .get("slow")
                .map(|peer| peer.backlog.own.load(Ordering::Relaxed))
        };

        // Alice reads her own socket all along, so only the slow peer stalls.
        let (mut to_server, mut from_server) = alice.split();
        let refusals = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&refusals);
        let reading = tokio::spawn(async move {
            while let Some(Ok(frame)) = from_server.next().await {
                if let T::Text(text) = frame
                    && text.as_str() == r#"{"type":"EXPIRE","src":"slow","dst":"alice"}"#
                {
                    counted.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
        // She floods the slow peer until the server gives up on it, and writes to Bob all along.
        let big = "y".repeat(FRAME_MAX - 1024);
        let mut sent = 0;
        let mut most_queued = 0;
        while slow_holds(&served.peers).is_some() {
            assert!(sent < 900, "a peer that does not read is dropped");
            let frame = serde_json::json!({ "type": "OFFER", "dst": "slow", "payload": big });
            to_server
                .send(T::text(frame.to_string()))
                .await
                .expect("send");
            if sent % 10 == 0 {
                let frame = serde_json::json!({ "type": "OFFER", "dst": "bob", "payload": sent });
                to_server
                    .send(T::text(frame.to_string()))
                    .await
                    .expect("send");
                assert_eq!(
                    raw(&mut bob).await,
                    format!(r#"{{"type":"OFFER","src":"alice","dst":"bob","payload":{sent}}}"#),
                    "everyone else's frames go through meanwhile"
                );
            }
            sent += 1;
            most_queued = most_queued.max(served.peers.realm().queued.load(Ordering::Relaxed));
            tokio::time::sleep(Duration::from_millis(4)).await;
        }
        assert!(
            refusals.load(Ordering::Relaxed) > 0,
            "frames that found no room were refused"
        );
        assert!(
            most_queued <= OUT_BYTES_ADDR_MAX,
            "one stalled client holds a small part of the shared budget: {most_queued}"
        );
        until("what was queued for it is freed", || {
            served.peers.realm().queued.load(Ordering::Relaxed) == 0
        })
        .await;
        assert_eq!(served.peers.connected(), 2);
        let mut thief = dial(
            served.addr,
            "key=peerjs&id=slow&token=another",
            "203.0.113.60",
        )
        .await
        .expect("dial");
        assert_eq!(
            raw(&mut thief).await,
            ID_TAKEN,
            "its id is not up for grabs"
        );
        let mut back = dial(
            served.addr,
            "key=peerjs&id=slow&token=its-token",
            "203.0.113.50",
        )
        .await
        .expect("dial");
        assert_eq!(raw(&mut back).await, OPEN, "its own token gets it back");
        drop(stalled);
        reading.abort();
    }

    #[tokio::test]
    async fn turning_p2p_off_closes_every_connection_and_refuses_new_ones() {
        let served = serve(Settings::default()).await;
        let base = format!("http://{}", served.addr);
        let mut alice = join(&served, "alice").await;
        let mut bob = join(&served, "bob").await;
        say(
            &mut alice,
            json(r#"{"type":"OFFER","dst":"carol","payload":1}"#),
        )
        .await;
        until("the offer waits for carol", || {
            served.peers.realm().waiting.contains_key("carol")
        })
        .await;
        assert!(served.peers.on());

        served.peers.set_on(false);
        assert!(!served.peers.on());
        assert_eq!(next(&mut alice).await, None, "open connections are closed");
        assert_eq!(next(&mut bob).await, None);
        assert_eq!(served.peers.connected(), 0);
        assert!(served.peers.realm().waiting.is_empty());
        match dial(
            served.addr,
            "key=peerjs&id=alice&token=t-alice",
            "203.0.113.1",
        )
        .await
        {
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
                assert_eq!(res.status(), StatusCode::NOT_FOUND);
                if let Some(body) = res.body() {
                    assert_eq!(body.as_slice(), TURNED_OFF.as_bytes());
                }
            }
            Err(e) => panic!("unexpected error {e}"),
            Ok(_) => panic!("a connection was accepted while P2P is off"),
        }
        for path in ["/peerjs", "/peerjs/peerjs/id"] {
            let res = reqwest::get(format!("{base}{path}")).await.expect("get");
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(
                res.text().await.expect("body"),
                "P2P is turned off on this instance"
            );
        }
        // A connection that got through the door just before the switch is refused inside.
        let late = served
            .peers
            .realm()
            .join("late", "t", 10, &client("203.0.113.9"));
        assert_eq!(
            late.err().as_deref(),
            Some(r#"{"type":"ERROR","payload":{"msg":"P2P is turned off on this instance"}}"#)
        );
        until("closed connections hold no slot", || {
            served.peers.open().is_empty()
        })
        .await;

        served.peers.set_on(true);
        let mut carol = join(&served, "carol").await;
        let mut alice = join(&served, "alice").await;
        say(
            &mut alice,
            json(r#"{"type":"OFFER","dst":"carol","payload":2}"#),
        )
        .await;
        assert_eq!(
            raw(&mut carol).await,
            r#"{"type":"OFFER","src":"alice","dst":"carol","payload":2}"#,
            "it serves again, and nothing from before the switch is left"
        );
    }

    #[tokio::test]
    async fn peers_are_capped_in_all() {
        let served = serve(Settings {
            peers_per_ip: 0,
            concurrent_limit: 2,
            ..Settings::default()
        })
        .await;
        let _alice = join(&served, "alice").await;
        let bob = join(&served, "bob").await;
        let mut carol = dial(served.addr, "key=peerjs&id=carol&token=t", "203.0.113.1")
            .await
            .expect("dial");
        assert_eq!(
            raw(&mut carol).await,
            r#"{"type":"ERROR","payload":{"msg":"Server has reached its concurrent user limit"}}"#
        );
        assert_eq!(next(&mut carol).await, None);
        let _alice_again = join(&served, "alice").await;
        assert_eq!(
            served.peers.connected(),
            2,
            "taking an id over needs no room"
        );
        drop(bob);
        until("bob left", || served.peers.connected() == 1).await;
        let _carol = join(&served, "carol").await;
    }

    #[tokio::test]
    async fn bad_hellos_get_an_error_and_a_close() {
        let served = serve(Settings::default()).await;
        let long = "x".repeat(ID_MAX + 1);
        for (query, msg) in [
            ("key=nope&id=a&token=t", "Invalid key provided"),
            (
                "id=a&token=t",
                "No id, token, or key supplied to websocket server",
            ),
            (
                "key=peerjs&token=t",
                "No id, token, or key supplied to websocket server",
            ),
            (
                "key=peerjs&id=a&token=",
                "No id, token, or key supplied to websocket server",
            ),
            ("", "No id, token, or key supplied to websocket server"),
            (
                &format!("key=peerjs&id={long}&token=t"),
                "The id or token is too long",
            ),
            (
                &format!("key=peerjs&id=a&token={long}"),
                "The id or token is too long",
            ),
        ] {
            let mut ws = dial(served.addr, query, "203.0.113.9").await.expect("dial");
            assert_eq!(
                raw(&mut ws).await,
                format!(r#"{{"type":"ERROR","payload":{{"msg":"{msg}"}}}}"#),
                "{query}"
            );
            assert_eq!(next(&mut ws).await, None, "{query}");
        }
        assert_eq!(served.peers.connected(), 0);
        until("refused sockets hold no slot", || {
            served.peers.open().is_empty()
        })
        .await;
        let plain = reqwest::get(format!("http://{}/peerjs/peerjs?key=peerjs", served.addr))
            .await
            .expect("get");
        assert!(plain.status().is_client_error(), "{}", plain.status());
    }

    #[tokio::test]
    async fn ids_and_the_description_come_over_http() {
        let served = serve(Settings::default()).await;
        let base = format!("http://{}", served.addr);
        let mut ids = Vec::new();
        for path in [
            "/peerjs/peerjs/id",
            "/peerjs/peerjs/id?ts=17000000000000.5&version=1.5.5",
            "/peerjs/other/id",
        ] {
            let res = reqwest::get(format!("{base}{path}")).await.expect("id");
            assert_eq!(res.status(), StatusCode::OK, "{path}");
            assert_eq!(
                res.headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok()),
                Some("text/plain; charset=utf-8")
            );
            let id = res.text().await.expect("body");
            assert!(id.len() >= 16 && id.len() <= ID_MAX, "{id}");
            assert!(id.chars().all(|c| c.is_ascii_alphanumeric()), "{id}");
            assert!(!ids.contains(&id));
            ids.push(id);
        }
        let mut ws = dial(
            served.addr,
            &format!("key=peerjs&id={}&token=t", ids[0]),
            "203.0.113.4",
        )
        .await
        .expect("dial");
        assert_eq!(raw(&mut ws).await, OPEN);
        let about = reqwest::get(format!("{base}/peerjs")).await.expect("about");
        assert_eq!(about.status(), StatusCode::OK);
        let about: Value = serde_json::from_str(&about.text().await.expect("body")).expect("json");
        assert_eq!(
            about,
            json(
                r#"{"name":"PeerJS Server","description":"A server side element to broker connections between PeerJS clients.","website":"https://peerjs.com/"}"#
            )
        );
        for missing in ["/peerjs/id", "/peerjs/peerjs/peers", "/peerjs/x/y/id"] {
            let res = reqwest::get(format!("{base}{missing}")).await.expect("get");
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{missing}");
        }
    }
}
