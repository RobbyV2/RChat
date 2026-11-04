use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use stun::agent::TransactionId;
use stun::attributes::{ATTR_MESSAGE_INTEGRITY, ATTR_NONCE, ATTR_USERNAME, ATTR_XOR_PEER_ADDRESS};
use stun::error_code::{
    CODE_ALLOC_QUOTA_REACHED, CODE_FORBIDDEN, CODE_INSUFFICIENT_CAPACITY, ErrorCode,
    ErrorCodeAttribute,
};
use stun::message::{
    CLASS_ERROR_RESPONSE, CLASS_INDICATION, CLASS_REQUEST, CLASS_SUCCESS_RESPONSE, MAGIC_COOKIE,
    METHOD_ALLOCATE, METHOD_BINDING, METHOD_CHANNEL_BIND, METHOD_CREATE_PERMISSION, METHOD_REFRESH,
    METHOD_SEND, Message, MessageType, Method, Setter, is_message,
};
use stun::textattrs::{Nonce, Username};
use tokio::net::UdpSocket;
use turn::allocation::allocation_manager::{Manager, ManagerConfig};
use turn::auth::{AuthHandler, generate_auth_key};
use turn::proto::chandata::ChannelData;
use turn::proto::lifetime::DEFAULT_LIFETIME;
use turn::relay::RelayAddressGenerator;
use turn::server::request::Request;
use utoipa::ToSchema;
use webrtc_util::Conn;

pub use crate::net_guard::blocked;
use crate::net_guard::embedded_v4;
pub use crate::server::client_ip::Cidr;

pub const DEFAULT_PORT: u16 = 3478;
pub const DEFAULT_MIN_PORT: u16 = 49160;
pub const DEFAULT_MAX_PORT: u16 = 49415;
// Each relayed peer connection of an account takes one. A relay-only member of a full P2P voice
// mesh (10 people) holds a session and a media connection with each of the other 9, next to
// its P2P server links, a call and file transfers.
pub const DEFAULT_USER_ALLOCATIONS: usize = 64;
pub const DEFAULT_USER_KIB_PER_SEC: u64 = 1024;
pub const DEFAULT_TOTAL_KIB_PER_SEC: u64 = 64 * 1024;
pub const CREDENTIAL_TTL_SECS: i64 = 3600;
pub const IDLE: Duration = Duration::from_secs(600);
pub const SESSION_MAX_SECS: u64 = 12 * 3600;
pub const REALM: &str = "rchat";
const BURST_SECS: f64 = 4.0;
const PERMISSION_LIFETIME: Duration = Duration::from_secs(300);
const NONCE_TTL: Duration = Duration::from_secs(3600);
const PRUNE_EVERY: Duration = Duration::from_secs(30);
const RECONCILE_EVERY: Duration = Duration::from_secs(300);
const INBOUND_MTU: usize = 1500;
const STUN_LIST: &str = include_str!("../../../assets/stun_servers.json");
const ALLOCATE_RETRIES: usize = 10;

#[derive(Deserialize)]
struct StunList {
    servers: Vec<String>,
}

pub fn bundled_stun() -> Vec<String> {
    serde_json::from_str::<StunList>(STUN_LIST)
        .map(|l| l.servers)
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.starts_with("stun:"))
        .collect()
}

pub fn pick_stun(list: &[String], instance_id: &str, count: usize) -> Vec<String> {
    use sha2::{Digest, Sha256};
    let rank = |s: &String| {
        let mut h = Sha256::new();
        h.update(instance_id.as_bytes());
        h.update([0]);
        h.update(s.as_bytes());
        h.finalize().to_vec()
    };
    let mut ranked: Vec<&String> = list.iter().collect();
    ranked.sort_by_cached_key(|s| rank(s));
    ranked.truncate(count);
    list.iter()
        .filter(|s| ranked.contains(s))
        .cloned()
        .collect()
}

/// One ICE server, as in the WebRTC `RTCIceServer` dictionary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct IceServer {
    /// `stun:`, `stuns:`, `turn:` or `turns:` URLs.
    #[schema(example = json!(["turn:chat.example.com:3478?transport=udp"]))]
    pub urls: Vec<String>,
    /// TURN username, for TURN entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// TURN password, for TURN entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

impl IceServer {
    pub fn is_turn(&self) -> bool {
        self.urls
            .iter()
            .any(|u| u.starts_with("turn:") || u.starts_with("turns:"))
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Urls {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawIceServer {
    urls: Urls,
    username: Option<String>,
    credential: Option<String>,
}

/// Parses `ICE_SERVERS`: a JSON array of `{urls, username?, credential?}`.
pub fn parse_ice_servers(raw: &str) -> anyhow::Result<Vec<IceServer>> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let list: Vec<RawIceServer> = serde_json::from_str(raw)
        .map_err(|e| anyhow::anyhow!("ICE_SERVERS is not a JSON array of ICE servers: {e}"))?;
    list.into_iter()
        .map(
            |RawIceServer {
                 urls,
                 username,
                 credential,
             }| {
                let urls = match urls {
                    Urls::One(u) => vec![u],
                    Urls::Many(u) => u,
                };
                let schemes = ["stun:", "stuns:", "turn:", "turns:"];
                if urls.is_empty()
                    || urls.iter().any(|u| {
                        !schemes.iter().any(|s| u.starts_with(s)) || u.contains(char::is_whitespace)
                    })
                {
                    anyhow::bail!("ICE_SERVERS entries need stun:, stuns:, turn: or turns: URLs");
                }
                Ok(IceServer {
                    urls,
                    username,
                    credential,
                })
            },
        )
        .collect()
}

/// The built-in relay as clients see it.
#[derive(Debug, Clone, PartialEq)]
pub struct RelayAdvert {
    /// `RELAY_HOST`; `None` means the host of the instance URL.
    pub host: Option<String>,
    pub port: u16,
    pub turn: bool,
}

impl RelayAdvert {
    pub fn host_for(&self, fallback: &str) -> String {
        let host = self.host.clone().unwrap_or_else(|| fallback.to_string());
        match host.parse::<Ipv6Addr>() {
            Ok(_) => format!("[{host}]"),
            Err(_) => host,
        }
    }
}

/// What the operator configured for ICE: the public STUN list, the built-in relay and
/// extra servers from `ICE_SERVERS`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct IceConfig {
    pub public_stun: usize,
    pub relay: Option<RelayAdvert>,
    pub extra: Vec<IceServer>,
}

type HmacSha1 = Hmac<sha1::Sha1>;
type HmacSha256 = Hmac<sha2::Sha256>;

pub fn password(secret: &str, username: &str) -> String {
    let mut mac = HmacSha1::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(username.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

pub fn opaque(secret: &str, user: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(b"rchat-relay-user\0");
    mac.update(user.to_lowercase().as_bytes());
    hex::encode(&mac.finalize().into_bytes()[..8])
}

#[derive(Debug, Clone, PartialEq)]
pub struct Credential {
    pub username: String,
    pub password: String,
    pub expires_at: i64,
}

/// TURN REST credentials (draft-uberti-behave-turn-rest): username `{expiry}:{opaque}`,
/// password `base64(HMAC-SHA1(secret, username))`.
pub fn issue(secret: &str, user: &str, now: i64) -> Credential {
    let expires_at = now + CREDENTIAL_TTL_SECS;
    let username = format!("{expires_at}:{}", opaque(secret, user));
    Credential {
        password: password(secret, &username),
        username,
        expires_at,
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// How much the relay may carry. Allocations are per process.
#[derive(Debug, Clone, PartialEq)]
pub struct Capacity {
    pub user_allocations: usize,
    pub total_allocations: usize,
    pub user_bytes_per_sec: f64,
    pub total_bytes_per_sec: f64,
}

impl Default for Capacity {
    fn default() -> Self {
        Capacity {
            user_allocations: DEFAULT_USER_ALLOCATIONS,
            total_allocations: usize::from(DEFAULT_MAX_PORT - DEFAULT_MIN_PORT) + 1,
            user_bytes_per_sec: DEFAULT_USER_KIB_PER_SEC as f64 * 1024.0,
            total_bytes_per_sec: DEFAULT_TOTAL_KIB_PER_SEC as f64 * 1024.0,
        }
    }
}

/// Budgets for requests that carry no known nonce: Binding requests, and TURN requests
/// that make the server hand out a nonce. They bound reflection and the work an
/// unauthenticated sender causes, in tiers: one address (IPv6 per /64), its block (IPv4
/// /24, IPv6 /48), then the whole process. Clients holding an allocation skip the block and
/// process tiers, so a flood cannot cut existing sessions off from fresh nonces. The nonce
/// table holds at most `nonce_cap` entries and evicts the oldest when full.
#[derive(Debug, Clone, PartialEq)]
pub struct Limits {
    pub source_rate: f64,
    pub source_burst: f64,
    pub block_rate: f64,
    pub block_burst: f64,
    pub global_rate: f64,
    pub global_burst: f64,
    pub nonce_cap: usize,
    pub sources_cap: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            source_rate: 10.0,
            source_burst: 40.0,
            block_rate: 50.0,
            block_burst: 200.0,
            global_rate: 500.0,
            global_burst: 1000.0,
            nonce_cap: 50_000,
            sources_cap: 4096,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new(burst: f64, now: Instant) -> Bucket {
        Bucket {
            tokens: burst,
            at: now,
        }
    }

    fn level(&self, rate: f64, burst: f64, now: Instant) -> f64 {
        (self.tokens + now.saturating_duration_since(self.at).as_secs_f64() * rate).min(burst)
    }

    fn refill(&mut self, rate: f64, burst: f64, now: Instant) {
        self.tokens = self.level(rate, burst, now);
        self.at = now;
    }

    fn take(&mut self, rate: f64, burst: f64, n: f64, now: Instant) -> bool {
        self.refill(rate, burst, now);
        match self.tokens >= n {
            true => {
                self.tokens -= n;
                true
            }
            false => false,
        }
    }
}

/// Token buckets per key, at most `cap` of them: when full, refilled buckets are dropped
/// first, then an arbitrary one.
struct Buckets {
    rate: f64,
    burst: f64,
    cap: usize,
    map: HashMap<IpAddr, Bucket>,
}

impl Buckets {
    fn new(rate: f64, burst: f64, cap: usize) -> Buckets {
        Buckets {
            rate,
            burst,
            cap,
            map: HashMap::new(),
        }
    }

    fn level(&mut self, key: IpAddr, now: Instant) -> f64 {
        let (rate, burst) = (self.rate, self.burst);
        if !self.map.contains_key(&key) && self.map.len() >= self.cap {
            self.prune(now);
            if self.map.len() >= self.cap
                && let Some(evict) = self.map.keys().next().copied()
            {
                self.map.remove(&evict);
            }
        }
        self.map
            .entry(key)
            .or_insert_with(|| Bucket::new(burst, now))
            .level(rate, burst, now)
    }

    fn take(&mut self, key: IpAddr, now: Instant) {
        let (rate, burst) = (self.rate, self.burst);
        if let Some(b) = self.map.get_mut(&key) {
            b.take(rate, burst, 1.0, now);
        }
    }

    fn prune(&mut self, now: Instant) {
        let (rate, burst) = (self.rate, self.burst);
        self.map.retain(|_, b| b.level(rate, burst, now) < burst);
    }
}

struct Limiter {
    nonce_cap: usize,
    global_rate: f64,
    global_burst: f64,
    global: Bucket,
    sources: Buckets,
    blocks: Buckets,
}

fn mask(ip: IpAddr, v4: u8, v6: u8) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V4(a) => IpAddr::V4(Ipv4Addr::from(u32::from(a) & (!0u32 << (32 - v4)))),
        IpAddr::V6(a) => IpAddr::V6(Ipv6Addr::from(u128::from(a) & (!0u128 << (128 - v6)))),
    }
}

fn source_key(ip: IpAddr) -> IpAddr {
    mask(ip, 32, 64)
}

fn block_key(ip: IpAddr) -> IpAddr {
    mask(ip, 24, 48)
}

impl Limiter {
    fn new(limits: Limits) -> Limiter {
        let Limits {
            source_rate,
            source_burst,
            block_rate,
            block_burst,
            global_rate,
            global_burst,
            nonce_cap,
            sources_cap,
        } = limits;
        Limiter {
            nonce_cap,
            global_rate,
            global_burst,
            global: Bucket::new(global_burst, Instant::now()),
            sources: Buckets::new(source_rate, source_burst, sources_cap),
            blocks: Buckets::new(block_rate, block_burst, sources_cap),
        }
    }

    /// Admits one unauthenticated request from `ip`. A `holder` (the exact address of a live
    /// allocation) pays only its own address's budget. Every tier is checked before any is
    /// charged, so dropped requests spend nothing upstream.
    fn admit(&mut self, ip: IpAddr, holder: bool, now: Instant) -> bool {
        let (source, block) = (source_key(ip), block_key(ip));
        if self.sources.level(source, now) < 1.0 {
            return false;
        }
        if !holder
            && (self.blocks.level(block, now) < 1.0
                || self.global.level(self.global_rate, self.global_burst, now) < 1.0)
        {
            return false;
        }
        self.sources.take(source, now);
        if !holder {
            self.blocks.take(block, now);
            self.global
                .take(self.global_rate, self.global_burst, 1.0, now);
        }
        true
    }

    fn prune(&mut self, now: Instant) {
        self.sources.prune(now);
        self.blocks.prune(now);
    }
}

/// Which peers the relay may exchange packets with.
#[derive(Debug, Clone, PartialEq)]
pub struct PeerFilter {
    pub allow_private: bool,
    /// The relay's own addresses: `RELAY_PUBLIC_IP` and the listener's bound address.
    pub own: Vec<IpAddr>,
    /// `RELAY_MIN_PORT..=RELAY_MAX_PORT`: on its own addresses the relay reaches only ports
    /// in this range that a live allocation holds, so two relayed peers can still talk.
    pub relay_ports: (u16, u16),
    /// `RELAY_DENIED_PEERS`, refused even with `allow_private`.
    pub denied: Vec<Cidr>,
}

impl PeerFilter {
    /// `live` says whether a port in the relay range is held by an allocation right now.
    pub fn allows(&self, peer: SocketAddr, live: impl Fn(u16) -> bool) -> bool {
        let ip = peer.ip().to_canonical();
        let forms: Vec<IpAddr> = match ip {
            IpAddr::V6(v6) => [Some(ip), embedded_v4(v6).map(IpAddr::V4)]
                .into_iter()
                .flatten()
                .collect(),
            IpAddr::V4(_) => vec![ip],
        };
        if self
            .denied
            .iter()
            .any(|c| forms.iter().any(|f| c.contains(*f)))
        {
            return false;
        }
        if self.allow_private {
            return true;
        }
        if blocked(ip) {
            return false;
        }
        match self.own.iter().any(|o| forms.contains(&o.to_canonical())) {
            true => {
                (self.relay_ports.0..=self.relay_ports.1).contains(&peer.port())
                    && live(peer.port())
            }
            false => true,
        }
    }
}

type PermSet = Mutex<HashMap<IpAddr, Instant>>;

#[derive(Default)]
struct Current {
    method: Option<Method>,
    /// The opaque user part and the full TURN username the auth handler just accepted.
    user: Option<(String, String)>,
    src: Option<SocketAddr>,
    pending: Option<(TransactionId, Vec<IpAddr>, Duration)>,
    /// The client address and TURN username of the allocation this request created.
    allocated: Option<(SocketAddr, String)>,
}

/// Who holds the allocation of one client address, and where.
struct Holder {
    user: String,
    port: u16,
    perms: Weak<PermSet>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum NonceState {
    Missing,
    Mine,
    Foreign,
    Unknown,
}

/// State the listener, the auth handler, the relayed sockets and the relay handle share.
struct Shared {
    turn: bool,
    filter: PeerFilter,
    current: Mutex<Current>,
    quotas: Arc<Quotas>,
    holders: Mutex<HashMap<SocketAddr, Holder>>,
    ports: Mutex<HashSet<u16>>,
    revoked: Mutex<HashMap<String, u64>>,
    limiter: Mutex<Limiter>,
    nonces: Arc<tokio::sync::Mutex<HashMap<String, tokio::time::Instant>>>,
    nonce_owners: Mutex<HashMap<String, IpAddr>>,
}

impl Shared {
    fn new(turn: bool, filter: PeerFilter, capacity: Capacity, limits: Limits) -> Shared {
        Shared {
            turn,
            filter,
            current: Mutex::default(),
            quotas: Arc::new(Quotas::new(capacity)),
            holders: Mutex::default(),
            ports: Mutex::default(),
            revoked: Mutex::default(),
            limiter: Mutex::new(Limiter::new(limits)),
            nonces: Arc::default(),
            nonce_owners: Mutex::default(),
        }
    }

    fn allows(&self, peer: SocketAddr) -> bool {
        self.filter.allows(peer, |port| {
            self.ports.lock().is_ok_and(|p| p.contains(&port))
        })
    }

    /// True unless another user holds the allocation of this client address.
    fn owned_by(&self, client: SocketAddr, user: &str) -> bool {
        self.holders
            .lock()
            .is_ok_and(|h| h.get(&client).is_none_or(|a| a.user == user))
    }

    fn holds(&self, client: SocketAddr) -> bool {
        self.holders
            .lock()
            .is_ok_and(|h| h.get(&client).is_some_and(|a| a.perms.strong_count() > 0))
    }

    /// Whether the request's nonce is live and was handed to this source address.
    fn nonce_state(&self, m: &Message, from: IpAddr) -> NonceState {
        let Ok(nonce) = Nonce::get_from_as(m, ATTR_NONCE) else {
            return NonceState::Missing;
        };
        let live = self
            .nonces
            .try_lock()
            .is_ok_and(|n| n.contains_key(&nonce.text));
        let owner = self
            .nonce_owners
            .lock()
            .ok()
            .and_then(|o| o.get(&nonce.text).copied());
        match (live, owner) {
            (true, Some(ip)) if ip == from.to_canonical() => NonceState::Mine,
            (true, Some(_)) => NonceState::Foreign,
            (true, None) | (false, _) => NonceState::Unknown,
        }
    }

    /// Remembers which address each nonce the TURN server hands out went to.
    fn issued(&self, response: &[u8], client: SocketAddr) {
        const ERROR_CLASS: u16 = 0x0110;
        if response.len() < 20
            || !is_message(response)
            || u16::from_be_bytes([response[0], response[1]]) & ERROR_CLASS != ERROR_CLASS
        {
            return;
        }
        let mut m = Message::new();
        m.raw = response.to_vec();
        if m.decode().is_err() {
            return;
        }
        if let Ok(nonce) = Nonce::get_from_as(&m, ATTR_NONCE)
            && let Ok(mut owners) = self.nonce_owners.lock()
        {
            owners.insert(nonce.text, client.ip().to_canonical());
        }
    }

    /// Makes room for one more nonce: drops expired ones and, when the table is still
    /// full, the oldest eighth. False when the table is busy.
    fn make_room(&self) -> bool {
        let cap = self.limiter.lock().map(|l| l.nonce_cap).unwrap_or(0).max(1);
        let Ok(mut nonces) = self.nonces.try_lock() else {
            return false;
        };
        if nonces.len() < cap {
            return true;
        }
        let now = tokio::time::Instant::now();
        nonces.retain(|_, at| now.saturating_duration_since(*at) < NONCE_TTL);
        if nonces.len() >= cap {
            let mut ages: Vec<tokio::time::Instant> = nonces.values().copied().collect();
            let k = (cap / 8).clamp(1, ages.len()) - 1;
            let (_, cutoff, _) = ages.select_nth_unstable(k);
            let cutoff = *cutoff;
            nonces.retain(|_, at| *at > cutoff);
        }
        if let Ok(mut owners) = self.nonce_owners.lock() {
            owners.retain(|nonce, _| nonces.contains_key(nonce));
        }
        nonces.len() < cap
    }

    /// Decides what happens to a decoded STUN message before the TURN server sees it.
    fn screen(&self, m: &Message, from: SocketAddr, now: Instant) -> Verdict {
        let MessageType { method, class } = m.typ;
        let wanted = match (class, method) {
            (CLASS_REQUEST, METHOD_BINDING) => true,
            (CLASS_REQUEST, METHOD_ALLOCATE | METHOD_REFRESH)
            | (CLASS_REQUEST, METHOD_CREATE_PERMISSION | METHOD_CHANNEL_BIND)
            | (CLASS_INDICATION, METHOD_SEND) => self.turn,
            _ => false,
        };
        if !wanted {
            return Verdict::Drop;
        }
        let nonce = match class == CLASS_REQUEST && method != METHOD_BINDING {
            true => self.nonce_state(m, from.ip()),
            false => NonceState::Missing,
        };
        if nonce == NonceState::Foreign {
            return Verdict::Drop;
        }
        let unauthenticated = class == CLASS_REQUEST
            && (method == METHOD_BINDING
                || !m.contains(ATTR_MESSAGE_INTEGRITY)
                || nonce != NonceState::Mine);
        if unauthenticated {
            let holder = self.holds(from);
            let admitted = self
                .limiter
                .lock()
                .is_ok_and(|mut l| l.admit(from.ip(), holder, now));
            if !admitted || method != METHOD_BINDING && !self.make_room() {
                return Verdict::Drop;
            }
        }
        let verdict = judge(m, |peer| self.allows(peer), &self.quotas);
        if let Ok(mut current) = self.current.lock() {
            *current = Current {
                method: Some(method),
                user: None,
                src: Some(from),
                allocated: None,
                pending: match (&verdict, method) {
                    (Verdict::Pass, METHOD_CREATE_PERMISSION) => peer_addresses(m).map(|p| {
                        (
                            m.transaction_id,
                            p.iter().map(|a| a.ip()).collect(),
                            PERMISSION_LIFETIME,
                        )
                    }),
                    (Verdict::Pass, METHOD_CHANNEL_BIND) => peer_addresses(m).map(|p| {
                        (
                            m.transaction_id,
                            p.iter().map(|a| a.ip()).collect(),
                            DEFAULT_LIFETIME,
                        )
                    }),
                    _ => None,
                },
            };
        }
        verdict
    }

    /// Records the permissions the TURN server just granted, so relayed sockets can drop
    /// unpermitted inbound packets before charging anyone's budget.
    fn granted(&self, response: &[u8], client: SocketAddr) {
        if response.len() < 20 || !is_message(response) {
            return;
        }
        let typ = u16::from_be_bytes([response[0], response[1]]);
        let granting = [METHOD_CREATE_PERMISSION, METHOD_CHANNEL_BIND]
            .iter()
            .any(|m| MessageType::new(*m, CLASS_SUCCESS_RESPONSE).value() == typ);
        if !granting {
            return;
        }
        let Some((tid, ips, lifetime)) =
            self.current.lock().ok().and_then(|mut c| c.pending.take())
        else {
            return;
        };
        if response[8..20] != tid.0 {
            return;
        }
        let set = self
            .holders
            .lock()
            .ok()
            .and_then(|h| h.get(&client).and_then(|a| a.perms.upgrade()));
        if let Some(set) = set
            && let Ok(mut set) = set.lock()
        {
            let until = Instant::now() + lifetime;
            for ip in ips {
                set.insert(ip.to_canonical(), until);
            }
        }
    }

    fn revoked(&self, opaque: &str, expiry: u64) -> bool {
        self.revoked
            .lock()
            .map(|r| {
                r.get(opaque)
                    .is_some_and(|at| expiry <= at + CREDENTIAL_TTL_SECS as u64 + 60)
            })
            .unwrap_or(true)
    }

    async fn prune(&self) {
        let now = Instant::now();
        {
            let mut nonces = self.nonces.lock().await;
            let fresh = tokio::time::Instant::now();
            nonces.retain(|_, at| fresh.saturating_duration_since(*at) < NONCE_TTL);
            if let Ok(mut owners) = self.nonce_owners.lock() {
                owners.retain(|nonce, _| nonces.contains_key(nonce));
            }
        }
        if let Ok(mut holders) = self.holders.lock() {
            holders.retain(|_, a| a.perms.strong_count() > 0);
        }
        if let Ok(mut revoked) = self.revoked.lock() {
            let floor =
                unix_now().saturating_sub(CREDENTIAL_TTL_SECS as u64 + 60 + SESSION_MAX_SECS);
            revoked.retain(|_, at| *at >= floor);
        }
        if let Ok(mut limiter) = self.limiter.lock() {
            limiter.prune(now);
        }
    }
}

struct RestAuth {
    secret: String,
    shared: Arc<Shared>,
}

fn reject(why: &str) -> turn::Error {
    turn::Error::Other(why.to_string())
}

impl RestAuth {
    fn check(&self, username: &str, now: u64, method: Option<Method>) -> Result<String, String> {
        if !self.shared.turn {
            return Err("relaying is off".to_string());
        }
        let (expiry, opaque) = username
            .split_once(':')
            .ok_or_else(|| "username is not expiry:opaque".to_string())?;
        let expiry: u64 = expiry.parse().map_err(|_| "bad expiry".to_string())?;
        if opaque.is_empty() || opaque.len() > 64 {
            return Err("bad opaque".to_string());
        }
        if expiry > now + CREDENTIAL_TTL_SECS as u64 + 60 {
            return Err("expiry too far ahead".to_string());
        }
        let floor = match method {
            Some(METHOD_ALLOCATE) | None => now,
            Some(_) => now.saturating_sub(SESSION_MAX_SECS),
        };
        if expiry <= floor {
            return Err(format!("expired username {username}"));
        }
        if self.shared.revoked(opaque, expiry) {
            return Err("revoked".to_string());
        }
        Ok(opaque.to_string())
    }
}

impl AuthHandler for RestAuth {
    fn auth_handle(
        &self,
        username: &str,
        _realm: &str,
        src: SocketAddr,
    ) -> Result<Vec<u8>, turn::Error> {
        let mut current = self.shared.current.lock().map_err(|_| reject("poisoned"))?;
        current.user = None;
        let user = self
            .check(username, unix_now(), current.method)
            .map_err(|e| reject(&e))?;
        if current.method != Some(METHOD_ALLOCATE) && !self.shared.owned_by(src, &user) {
            return Err(reject("not the allocation's owner"));
        }
        current.user = Some((user, username.to_string()));
        Ok(generate_auth_key(
            username,
            REALM,
            &password(&self.secret, username),
        ))
    }
}

struct Usage {
    allocations: usize,
    bandwidth: Bucket,
}

struct QuotaState {
    users: HashMap<String, Usage>,
    total: usize,
    bandwidth: Bucket,
}

/// Allocation counts and bandwidth budgets, per user (keyed by the opaque part of the TURN
/// username) and for the whole process.
pub struct Quotas {
    capacity: Capacity,
    state: Mutex<QuotaState>,
}

impl Quotas {
    fn new(capacity: Capacity) -> Quotas {
        let now = Instant::now();
        Quotas {
            state: Mutex::new(QuotaState {
                users: HashMap::new(),
                total: 0,
                bandwidth: Bucket::new(capacity.total_bytes_per_sec * BURST_SECS, now),
            }),
            capacity,
        }
    }

    fn acquire(self: &Arc<Self>, user: &str) -> Option<Slot> {
        let mut state = self.state.lock().ok()?;
        if state.total >= self.capacity.total_allocations {
            return None;
        }
        let burst = self.capacity.user_bytes_per_sec * BURST_SECS;
        let usage = state.users.entry(user.to_string()).or_insert(Usage {
            allocations: 0,
            bandwidth: Bucket::new(burst, Instant::now()),
        });
        if usage.allocations >= self.capacity.user_allocations {
            return None;
        }
        usage.allocations += 1;
        state.total += 1;
        Some(Slot {
            quotas: Arc::clone(self),
            user: user.to_string(),
        })
    }

    /// The error an Allocate gets before the server sees it: 486 when the user is at their
    /// quota, 508 when the process is full.
    fn refusal(&self, user: Option<&str>) -> Option<ErrorCode> {
        let Ok(state) = self.state.lock() else {
            return Some(CODE_INSUFFICIENT_CAPACITY);
        };
        let user_full = user
            .and_then(|u| state.users.get(u))
            .is_some_and(|u| u.allocations >= self.capacity.user_allocations);
        match (user_full, state.total >= self.capacity.total_allocations) {
            (true, _) => Some(CODE_ALLOC_QUOTA_REACHED),
            (false, true) => Some(CODE_INSUFFICIENT_CAPACITY),
            (false, false) => None,
        }
    }

    fn take(&self, user: &str, bytes: usize) -> bool {
        let Capacity {
            user_allocations: _,
            total_allocations: _,
            user_bytes_per_sec,
            total_bytes_per_sec,
        } = self.capacity;
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let now = Instant::now();
        let n = bytes as f64;
        let total_burst = total_bytes_per_sec * BURST_SECS;
        if state.bandwidth.level(total_bytes_per_sec, total_burst, now) < n {
            return false;
        }
        let Some(usage) = state.users.get_mut(user) else {
            return false;
        };
        if !usage
            .bandwidth
            .take(user_bytes_per_sec, user_bytes_per_sec * BURST_SECS, n, now)
        {
            return false;
        }
        state
            .bandwidth
            .take(total_bytes_per_sec, total_burst, n, now)
    }

    pub fn allocations(&self) -> usize {
        self.state.lock().map(|s| s.total).unwrap_or(0)
    }
}

struct Slot {
    quotas: Arc<Quotas>,
    user: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut state) = self.quotas.state.lock() {
            state.total = state.total.saturating_sub(1);
            if let Some(usage) = state.users.get_mut(&self.user) {
                usage.allocations = usage.allocations.saturating_sub(1);
                if usage.allocations == 0 {
                    state.users.remove(&self.user);
                }
            }
        }
    }
}

/// The relayed socket of one allocation. It drops packets to and from peers the filter
/// refuses, inbound packets from peers without a permission, packets over the user's or the
/// process's bandwidth budget, and ends the allocation after `IDLE` without traffic.
struct Relayed {
    inner: UdpSocket,
    shared: Arc<Shared>,
    perms: Arc<PermSet>,
    slot: Mutex<Option<Slot>>,
    user: String,
    client: SocketAddr,
    active: Mutex<Instant>,
}

impl Relayed {
    /// Gives back the quota slot, the port and the client's holder entry. Runs on close and
    /// again on drop.
    fn release(&self) {
        if let Ok(mut slot) = self.slot.lock() {
            slot.take();
        }
        let Ok(port) = self.inner.local_addr().map(|a| a.port()) else {
            return;
        };
        if let Ok(mut ports) = self.shared.ports.lock() {
            ports.remove(&port);
        }
        if let Ok(mut holders) = self.shared.holders.lock()
            && holders.get(&self.client).is_some_and(|a| a.port == port)
        {
            holders.remove(&self.client);
        }
    }

    fn permitted(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        self.perms
            .lock()
            .is_ok_and(|p| p.get(&ip.to_canonical()).is_some_and(|until| *until > now))
    }

    fn touch(&self) {
        if let Ok(mut at) = self.active.lock() {
            *at = Instant::now();
        }
    }

    fn idle_until(&self) -> Instant {
        self.active
            .lock()
            .map(|at| *at + IDLE)
            .unwrap_or_else(|_| Instant::now())
    }
}

fn util_err(why: &str) -> webrtc_util::Error {
    webrtc_util::Error::Other(why.to_string())
}

#[async_trait]
impl Conn for Relayed {
    async fn connect(&self, _addr: SocketAddr) -> webrtc_util::Result<()> {
        Err(util_err("not supported"))
    }

    async fn recv(&self, _buf: &mut [u8]) -> webrtc_util::Result<usize> {
        Err(util_err("not supported"))
    }

    async fn recv_from(&self, buf: &mut [u8]) -> webrtc_util::Result<(usize, SocketAddr)> {
        loop {
            let deadline = tokio::time::Instant::from_std(self.idle_until());
            tokio::select! {
                got = self.inner.recv_from(buf) => {
                    let (n, from) = got?;
                    if self.shared.allows(from)
                        && self.permitted(from.ip())
                        && self.shared.quotas.take(&self.user, n)
                    {
                        self.touch();
                        return Ok((n, from));
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    if self.idle_until() <= Instant::now() {
                        return Err(util_err("allocation idle"));
                    }
                }
            }
        }
    }

    async fn send(&self, _buf: &[u8]) -> webrtc_util::Result<usize> {
        Err(util_err("not supported"))
    }

    async fn send_to(&self, buf: &[u8], target: SocketAddr) -> webrtc_util::Result<usize> {
        if !self.shared.allows(target) || !self.shared.quotas.take(&self.user, buf.len()) {
            return Ok(buf.len());
        }
        self.touch();
        Ok(self.inner.send_to(buf, target).await?)
    }

    fn local_addr(&self) -> webrtc_util::Result<SocketAddr> {
        Ok(self.inner.local_addr()?)
    }

    fn remote_addr(&self) -> Option<SocketAddr> {
        None
    }

    async fn close(&self) -> webrtc_util::Result<()> {
        self.release();
        Ok(())
    }

    fn as_any(&self) -> &(dyn std::any::Any + Send + Sync) {
        self
    }
}

impl Drop for Relayed {
    fn drop(&mut self) {
        self.release();
    }
}

struct Relays {
    public_ip: IpAddr,
    min_port: u16,
    max_port: u16,
    shared: Arc<Shared>,
}

#[async_trait]
impl RelayAddressGenerator for Relays {
    fn validate(&self) -> Result<(), turn::Error> {
        match self.min_port > 0 && self.min_port <= self.max_port {
            true => Ok(()),
            false => Err(turn::Error::ErrMaxPortLessThanMinPort),
        }
    }

    async fn allocate_conn(
        &self,
        use_ipv4: bool,
        requested_port: u16,
    ) -> Result<(Arc<dyn Conn + Send + Sync>, SocketAddr), turn::Error> {
        if !self.shared.turn || requested_port != 0 || use_ipv4 != self.public_ip.is_ipv4() {
            return Err(reject("allocation refused"));
        }
        let (user, src) = {
            let mut current = self.shared.current.lock().map_err(|_| reject("poisoned"))?;
            (current.user.take(), current.src)
        };
        let ((user, username), src) = user
            .zip(src)
            .ok_or_else(|| reject("no authenticated user"))?;
        let slot = self
            .shared
            .quotas
            .acquire(&user)
            .ok_or_else(|| reject("allocation quota reached"))?;
        let any: IpAddr = match self.public_ip {
            IpAddr::V4(_) => Ipv4Addr::UNSPECIFIED.into(),
            IpAddr::V6(_) => Ipv6Addr::UNSPECIFIED.into(),
        };
        let span = u32::from(self.max_port - self.min_port) + 1;
        for _ in 0..ALLOCATE_RETRIES {
            let port = self.min_port + (rand::random::<u32>() % span) as u16;
            let Ok(inner) = UdpSocket::bind(SocketAddr::new(any, port)).await else {
                continue;
            };
            let perms = Arc::new(PermSet::default());
            if let Ok(mut ports) = self.shared.ports.lock() {
                ports.insert(port);
            }
            if let Ok(mut holders) = self.shared.holders.lock() {
                holders.insert(
                    src,
                    Holder {
                        user: user.clone(),
                        port,
                        perms: Arc::downgrade(&perms),
                    },
                );
            }
            if let Ok(mut current) = self.shared.current.lock() {
                current.allocated = Some((src, username));
            }
            let conn = Relayed {
                inner,
                shared: Arc::clone(&self.shared),
                perms,
                slot: Mutex::new(Some(slot)),
                user,
                client: src,
                active: Mutex::new(Instant::now()),
            };
            return Ok((Arc::new(conn), SocketAddr::new(self.public_ip, port)));
        }
        Err(turn::Error::ErrMaxRetriesExceeded)
    }
}

/// Every XOR-PEER-ADDRESS of a message, or `None` when one doesn't decode.
fn peer_addresses(m: &Message) -> Option<Vec<SocketAddr>> {
    let mut mask = [0u8; 16];
    mask[..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    mask[4..].copy_from_slice(&m.transaction_id.0);
    m.attributes
        .0
        .iter()
        .filter(|a| a.typ == ATTR_XOR_PEER_ADDRESS)
        .map(|a| {
            let v = &a.value;
            let port = u16::from_be_bytes([*v.get(2)?, *v.get(3)?]) ^ (MAGIC_COOKIE >> 16) as u16;
            let xored = |len: usize| -> Option<Vec<u8>> {
                (v.len() == 4 + len).then(|| v[4..].iter().zip(mask).map(|(b, k)| b ^ k).collect())
            };
            let ip = match (v.first(), v.get(1)) {
                (Some(0), Some(1)) => {
                    let b: [u8; 4] = xored(4)?.try_into().ok()?;
                    IpAddr::from(b)
                }
                (Some(0), Some(2)) => {
                    let b: [u8; 16] = xored(16)?.try_into().ok()?;
                    IpAddr::from(b)
                }
                _ => return None,
            };
            Some(SocketAddr::new(ip, port))
        })
        .collect()
}

#[derive(PartialEq)]
enum Verdict {
    Pass,
    Drop,
    Refuse(ErrorCode),
}

impl std::fmt::Debug for Verdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Verdict::Pass => write!(f, "Pass"),
            Verdict::Drop => write!(f, "Drop"),
            Verdict::Refuse(ErrorCode(code)) => write!(f, "Refuse({code})"),
        }
    }
}

fn judge(m: &Message, allows: impl Fn(SocketAddr) -> bool, quotas: &Quotas) -> Verdict {
    let refuse = |code| match m.typ.class == CLASS_REQUEST {
        true => Verdict::Refuse(code),
        false => Verdict::Drop,
    };
    match m.typ.method {
        METHOD_CREATE_PERMISSION | METHOD_CHANNEL_BIND | METHOD_SEND => match peer_addresses(m) {
            Some(peers) if peers.iter().all(|p| allows(*p)) => Verdict::Pass,
            Some(_) | None => refuse(CODE_FORBIDDEN),
        },
        METHOD_ALLOCATE => {
            let user = Username::get_from_as(m, ATTR_USERNAME).ok();
            match user.as_ref().and_then(|u| u.text.split_once(':')) {
                Some((_, opaque)) => match quotas.refusal(Some(opaque)) {
                    Some(code) => refuse(code),
                    None => Verdict::Pass,
                },
                None => Verdict::Pass,
            }
        }
        _ => Verdict::Pass,
    }
}

fn error_response(m: &Message, code: ErrorCode) -> Option<Vec<u8>> {
    let mut out = Message::new();
    let setters: Vec<Box<dyn Setter>> = vec![
        Box::new(Message {
            transaction_id: m.transaction_id,
            ..Default::default()
        }),
        Box::new(MessageType::new(m.typ.method, CLASS_ERROR_RESPONSE)),
        Box::new(ErrorCodeAttribute {
            code,
            reason: Vec::new(),
        }),
    ];
    out.build(&setters).ok()?;
    Some(out.raw)
}

/// The TURN listener. It drops everything but Binding when TURN is off, rate-limits
/// requests without a known nonce, refuses permissions, channels and sends towards peers
/// the filter refuses (403) and allocations past a quota (486, 508) before the server sees
/// them, and tells the auth handler which method it is checking. `recv_from` only awaits
/// the socket read, so cancelling it never loses a reply. The TURN server calls `close` on
/// it whenever an allocation ends, so that is a no-op; `shut` releases the socket.
struct Guard {
    inner: Mutex<Option<Arc<UdpSocket>>>,
    shared: Arc<Shared>,
}

impl Guard {
    fn socket(&self) -> webrtc_util::Result<Arc<UdpSocket>> {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.clone())
            .ok_or(webrtc_util::Error::ErrClosedListener)
    }

    fn shut(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.take();
        }
    }
}

#[async_trait]
impl Conn for Guard {
    async fn connect(&self, _addr: SocketAddr) -> webrtc_util::Result<()> {
        Err(util_err("not supported"))
    }

    async fn recv(&self, _buf: &mut [u8]) -> webrtc_util::Result<usize> {
        Err(util_err("not supported"))
    }

    async fn recv_from(&self, buf: &mut [u8]) -> webrtc_util::Result<(usize, SocketAddr)> {
        let socket = self.socket()?;
        loop {
            let (n, from) = socket.recv_from(buf).await?;
            if ChannelData::is_channel_data(&buf[..n]) {
                match self.shared.turn {
                    true => return Ok((n, from)),
                    false => continue,
                }
            }
            if !is_message(&buf[..n]) {
                continue;
            }
            let mut m = Message::new();
            m.raw = buf[..n].to_vec();
            if m.decode().is_err() {
                continue;
            }
            match self.shared.screen(&m, from, Instant::now()) {
                Verdict::Pass => return Ok((n, from)),
                Verdict::Drop => {}
                Verdict::Refuse(code) => {
                    if let Some(raw) = error_response(&m, code) {
                        let _ = socket.try_send_to(&raw, from);
                    }
                }
            }
        }
    }

    async fn send(&self, _buf: &[u8]) -> webrtc_util::Result<usize> {
        Err(util_err("not supported"))
    }

    async fn send_to(&self, buf: &[u8], target: SocketAddr) -> webrtc_util::Result<usize> {
        let socket = self.socket()?;
        self.shared.granted(buf, target);
        self.shared.issued(buf, target);
        Ok(socket.send_to(buf, target).await?)
    }

    fn local_addr(&self) -> webrtc_util::Result<SocketAddr> {
        Ok(self.socket()?.local_addr()?)
    }

    fn remote_addr(&self) -> Option<SocketAddr> {
        None
    }

    async fn close(&self) -> webrtc_util::Result<()> {
        Ok(())
    }

    fn as_any(&self) -> &(dyn std::any::Any + Send + Sync) {
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RelaySettings {
    pub bind: SocketAddr,
    pub turn: bool,
    pub public_ip: Option<IpAddr>,
    pub min_port: u16,
    pub max_port: u16,
    pub allow_private: bool,
    pub denied: Vec<Cidr>,
    pub capacity: Capacity,
    pub limits: Limits,
}

/// A running relay. `close` stops it and waits; dropping the handle stops it too.
pub struct Relay {
    shared: Arc<Shared>,
    manager: Arc<Manager>,
    secret: String,
    stop: tokio::sync::watch::Sender<bool>,
    serving: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub quotas: Arc<Quotas>,
    pub addr: SocketAddr,
}

/// Ends an allocation that was created for a user whose revocation landed while the
/// Allocate was in flight, after `Relay::revoke` had already looked for their allocations.
async fn drop_if_revoked(shared: &Shared, manager: &Manager) {
    let allocated = shared
        .current
        .lock()
        .ok()
        .and_then(|mut c| c.allocated.take());
    let Some((_, username)) = allocated else {
        return;
    };
    let revoked = username
        .split_once(':')
        .and_then(|(expiry, opaque)| Some((expiry.parse::<u64>().ok()?, opaque)))
        .is_none_or(|(expiry, opaque)| shared.revoked(opaque, expiry));
    if revoked {
        manager.delete_allocations_by_username(&username).await;
    }
}

/// Handles one datagram at a time, like the crate's own server loop, and prunes between
/// datagrams. Stops on `Relay::close`, or when the `Relay` handle is dropped.
async fn serve(
    guard: Arc<Guard>,
    manager: Arc<Manager>,
    auth: Arc<RestAuth>,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    let conn: Arc<dyn Conn + Send + Sync> = guard.clone();
    let auth: Arc<dyn AuthHandler + Send + Sync> = auth;
    let nonces = Arc::clone(&guard.shared.nonces);
    let mut buf = vec![0u8; INBOUND_MTU];
    let mut prune = tokio::time::interval(PRUNE_EVERY);
    prune.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let got = tokio::select! {
            biased;
            changed = stop.changed() => match changed {
                Ok(()) if !*stop.borrow_and_update() => continue,
                Ok(()) | Err(_) => break,
            },
            _ = prune.tick() => {
                guard.shared.prune().await;
                continue;
            }
            got = guard.recv_from(&mut buf) => got,
        };
        let (n, src_addr) = match got {
            Ok(got) => got,
            Err(e) => {
                tracing::warn!("relay: listener stopped: {e}");
                break;
            }
        };
        let mut request = Request {
            conn: Arc::clone(&conn),
            src_addr,
            buff: buf[..n].to_vec(),
            allocation_manager: Arc::clone(&manager),
            nonces: Arc::clone(&nonces),
            auth_handler: Arc::clone(&auth),
            realm: REALM.to_string(),
            channel_bind_timeout: DEFAULT_LIFETIME,
        };
        if let Err(e) = request.handle_request().await {
            tracing::debug!("relay: {e}");
        }
        drop_if_revoked(&guard.shared, &manager).await;
    }
    let _ = manager.close().await;
    guard.shut();
}

impl Relay {
    pub async fn start(settings: &RelaySettings, secret: &str) -> anyhow::Result<Relay> {
        let RelaySettings {
            bind,
            turn,
            public_ip,
            min_port,
            max_port,
            allow_private,
            denied,
            capacity,
            limits,
        } = settings.clone();
        let socket = UdpSocket::bind(bind).await?;
        let addr = socket.local_addr()?;
        let turn = turn && public_ip.is_some();
        let own = [public_ip, Some(bind.ip()), Some(addr.ip())]
            .into_iter()
            .flatten()
            .filter(|ip| !ip.is_unspecified())
            .map(|ip| ip.to_canonical())
            .collect();
        let filter = PeerFilter {
            allow_private,
            own,
            relay_ports: (min_port, max_port),
            denied,
        };
        let shared = Arc::new(Shared::new(turn, filter, capacity, limits));
        let relays = Relays {
            public_ip: public_ip.unwrap_or(Ipv4Addr::UNSPECIFIED.into()),
            min_port,
            max_port,
            shared: Arc::clone(&shared),
        };
        relays.validate()?;
        let manager = Arc::new(Manager::new(ManagerConfig {
            relay_addr_generator: Box::new(relays),
            alloc_close_notify: None,
        }));
        let guard = Arc::new(Guard {
            inner: Mutex::new(Some(Arc::new(socket))),
            shared: Arc::clone(&shared),
        });
        let auth = Arc::new(RestAuth {
            secret: secret.to_string(),
            shared: Arc::clone(&shared),
        });
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let serving = tokio::spawn(serve(guard, Arc::clone(&manager), auth, stopped));
        Ok(Relay {
            quotas: Arc::clone(&shared.quotas),
            shared,
            manager,
            secret: secret.to_string(),
            stop,
            serving: tokio::sync::Mutex::new(Some(serving)),
            addr,
        })
    }

    /// Ends the user's allocations and refuses every credential issued to them so far, for
    /// as long as such credentials could still refresh an allocation.
    pub async fn revoke(&self, user: &str) {
        self.revoke_opaque(&opaque(&self.secret, user)).await;
    }

    async fn revoke_opaque(&self, opaque: &str) {
        if let Ok(mut revoked) = self.shared.revoked.lock() {
            revoked.insert(opaque.to_string(), unix_now());
        }
        let names: HashSet<String> = self
            .manager
            .get_allocations_info(None)
            .await
            .into_values()
            .map(|info| info.username)
            .filter(|name| name.split_once(':').is_some_and(|(_, o)| o == opaque))
            .collect();
        for name in names {
            self.manager.delete_allocations_by_username(&name).await;
        }
    }

    /// Revokes every allocation whose account no longer exists or is banned or being
    /// deleted, in case a `Banned` event never arrived. Returns how many accounts it revoked.
    pub async fn reconcile(&self, db: &crate::db::Db) -> anyhow::Result<usize> {
        use futures_util::StreamExt;
        let mut holders: HashSet<String> = self
            .shared
            .holders
            .lock()
            .map(|h| {
                h.values()
                    .filter(|a| a.perms.strong_count() > 0)
                    .map(|a| a.user.clone())
                    .collect()
            })
            .unwrap_or_default();
        if holders.is_empty() {
            return Ok(0);
        }
        {
            let mut rows = sqlx::query("SELECT username FROM users WHERE password_hash <> $1")
                .bind(crate::db::PURGING_HASH)
                .fetch(db);
            while let Some(row) = rows.next().await {
                let name: String = sqlx::Row::try_get(&row?, 0)?;
                holders.remove(&opaque(&self.secret, &name));
                if holders.is_empty() {
                    return Ok(0);
                }
            }
        }
        for gone in &holders {
            self.revoke_opaque(gone).await;
        }
        Ok(holders.len())
    }

    pub async fn close(&self) {
        let _ = self.stop.send(true);
        if let Some(serving) = self.serving.lock().await.take() {
            let _ = serving.await;
        }
    }
}

/// Revokes relay access for every account the site bans or deletes, wherever the ban
/// happens: the event reaches this process through the hub (and the bus with replicas).
/// When events may have been missed (the subscriber lagged or the bus resynced) and every
/// `RECONCILE_EVERY`, the relay checks its allocations against the database instead.
pub fn follow_revocations(relay: &Arc<Relay>, hub: &crate::ws::Hub, db: &crate::db::Db) {
    use tokio::sync::broadcast::error::RecvError;
    let relay = Arc::downgrade(relay);
    let mut events = hub.subscribe();
    let mut epoch = hub.epoch();
    let db = db.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval_at(
            tokio::time::Instant::now() + RECONCILE_EVERY,
            RECONCILE_EVERY,
        );
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut epoch_open = true;
        loop {
            let missed = tokio::select! {
                got = events.recv() => match got {
                    Ok(crate::ws::WsEvent::Banned { username }) => match relay.upgrade() {
                        Some(relay) => {
                            relay.revoke(&username).await;
                            false
                        }
                        None => break,
                    },
                    Ok(_) => false,
                    Err(RecvError::Lagged(_)) => true,
                    Err(RecvError::Closed) => break,
                },
                changed = epoch.changed(), if epoch_open => {
                    epoch_open = changed.is_ok();
                    epoch_open
                }
                _ = every.tick() => true,
            };
            if !missed {
                continue;
            }
            let Some(relay) = relay.upgrade() else {
                break;
            };
            match relay.reconcile(&db).await {
                Ok(0) => {}
                Ok(n) => tracing::info!("Relay: revoked {n} account(s) no longer allowed to relay"),
                Err(e) => {
                    tracing::warn!("Relay: checking allocations against the database failed: {e}")
                }
            }
        }
    });
}

#[derive(Clone, Copy)]
pub struct Status {
    pub port: u16,
    pub allocations: usize,
}

static RUNNING: OnceLock<(u16, Arc<Quotas>)> = OnceLock::new();

pub fn register(relay: &Relay) {
    let _ = RUNNING.set((relay.addr.port(), Arc::clone(&relay.quotas)));
}

/// The relay running in this process, if any.
pub fn status() -> Option<Status> {
    RUNNING.get().map(|(port, quotas)| Status {
        port: *port,
        allocations: quotas.allocations(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_allocations_fit_a_relay_only_p2p_user() {
        let mesh = 2 * (10 - 1);
        let servers = 2 * 8;
        let call = 2;
        let files = 4;
        assert!(DEFAULT_USER_ALLOCATIONS >= mesh + servers + call + files);
        let ports = usize::from(DEFAULT_MAX_PORT - DEFAULT_MIN_PORT) + 1;
        assert!(DEFAULT_USER_ALLOCATIONS <= ports);
    }

    #[test]
    fn classifier_blocks_internal_addresses() {
        let blocked_ips = [
            "0.0.0.0",
            "0.1.2.3",
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.0.1",
            "192.168.255.255",
            "169.254.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "224.0.0.1",
            "239.255.255.250",
            "255.255.255.255",
            "240.0.0.1",
            "192.0.0.8",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.9",
            "198.18.0.1",
            "198.19.255.255",
            "::",
            "::1",
            "fd00::1",
            "fc00::1",
            "fd00:ec2::254",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "ff0e::1",
            "::ffff:127.0.0.1",
            "::ffff:10.1.2.3",
            "::ffff:192.168.1.1",
            "::ffff:169.254.169.254",
            "::ffff:100.64.0.1",
            "::127.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
            "2002:7f00:1::1",
            "2002:c0a8:101::1",
            "2001:db8::1",
            "2001::1",
            "100::1",
            "3fff::1",
            "4000::1",
            "e000::1",
        ];
        for ip in blocked_ips {
            assert!(blocked(ip.parse().unwrap()), "{ip} should be blocked");
        }
        let public = [
            "1.1.1.1",
            "8.8.8.8",
            "9.9.9.9",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.255.255",
            "172.32.0.1",
            "192.169.0.1",
            "169.253.0.1",
            "198.20.0.1",
            "223.255.255.254",
            "2606:4700:4700::1111",
            "2a00:1450:4001::200e",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:808:808::1",
        ];
        for ip in public {
            assert!(!blocked(ip.parse().unwrap()), "{ip} should pass");
        }
    }

    #[test]
    fn credentials_follow_the_turn_rest_convention() {
        let secret = "s3cret";
        let cred = issue(secret, "Alice", 1_000);
        assert_eq!(cred.expires_at, 1_000 + CREDENTIAL_TTL_SECS);
        let (expiry, opaque_part) = cred.username.split_once(':').unwrap();
        assert_eq!(expiry, "4600");
        assert_eq!(opaque_part.len(), 16);
        assert!(!cred.username.to_lowercase().contains("alice"));
        assert_eq!(opaque_part, opaque(secret, "alice"));
        assert_ne!(opaque_part, opaque("other", "alice"));
        assert_ne!(opaque_part, opaque(secret, "bob"));
        let mut mac = HmacSha1::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(cred.username.as_bytes());
        assert_eq!(
            STANDARD.decode(&cred.password).unwrap(),
            mac.finalize().into_bytes().to_vec()
        );
        assert_eq!(
            password("key", "The quick brown fox jumps over the lazy dog"),
            STANDARD.encode(hex::decode("de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9").unwrap())
        );
    }

    fn filter(allow_private: bool) -> PeerFilter {
        PeerFilter {
            allow_private,
            own: vec!["1.2.3.4".parse().unwrap()],
            relay_ports: (49160, 49415),
            denied: ["8.8.4.0/24", "2001:4860:4860::/48"]
                .iter()
                .map(|s| Cidr::parse(s).unwrap())
                .collect(),
        }
    }

    fn shared(turn: bool, limits: Limits) -> Shared {
        Shared::new(turn, filter(false), Capacity::default(), limits)
    }

    #[test]
    fn auth_checks_expiry_format_and_revocation() {
        let auth = RestAuth {
            secret: "k".to_string(),
            shared: Arc::new(shared(true, Limits::default())),
        };
        let now = 100_000;
        let ok = |name: &str, m| auth.check(name, now, m);
        assert_eq!(ok("100100:abc", Some(METHOD_ALLOCATE)).unwrap(), "abc");
        assert!(ok("100000:abc", Some(METHOD_ALLOCATE)).is_err());
        assert!(ok("99999:abc", None).is_err());
        assert!(ok("99999:abc", Some(METHOD_CREATE_PERMISSION)).is_ok());
        assert!(ok("1:abc", Some(METHOD_CREATE_PERMISSION)).is_err());
        assert!(ok("999999:abc", Some(METHOD_ALLOCATE)).is_err());
        assert!(ok("100100", Some(METHOD_ALLOCATE)).is_err());
        assert!(ok("x:abc", Some(METHOD_ALLOCATE)).is_err());
        assert!(ok("100100:", Some(METHOD_ALLOCATE)).is_err());

        let revoked_at = now - 200;
        auth.shared
            .revoked
            .lock()
            .unwrap()
            .insert("abc".to_string(), revoked_at);
        let issued = |at: u64| format!("{}:abc", at + CREDENTIAL_TTL_SECS as u64);
        assert!(
            ok(&issued(revoked_at), Some(METHOD_ALLOCATE)).is_err(),
            "credentials issued before the revocation are refused"
        );
        assert!(
            ok("99999:abc", Some(METHOD_REFRESH)).is_err(),
            "and cannot refresh"
        );
        assert!(
            ok(&issued(now), Some(METHOD_ALLOCATE)).is_ok(),
            "credentials issued later work"
        );
        assert!(ok("100100:def", Some(METHOD_ALLOCATE)).is_ok());

        let off = RestAuth {
            secret: "k".to_string(),
            shared: Arc::new(shared(false, Limits::default())),
        };
        assert!(off.check("100100:abc", now, Some(METHOD_ALLOCATE)).is_err());
    }

    #[test]
    fn quotas_cap_allocations_and_bandwidth() {
        let code = |c: Option<ErrorCode>| c.map(|ErrorCode(n)| n);
        let quotas = Arc::new(Quotas::new(Capacity {
            user_allocations: 3,
            total_allocations: 5,
            user_bytes_per_sec: 1000.0,
            total_bytes_per_sec: 1500.0,
        }));
        let mut slots: Vec<Slot> = (0..3).map(|_| quotas.acquire("u").expect("slot")).collect();
        assert!(quotas.acquire("u").is_none());
        assert_eq!(code(quotas.refusal(Some("u"))), Some(486));
        assert_eq!(code(quotas.refusal(Some("v"))), None);
        slots.extend((0..2).map(|_| quotas.acquire("v").expect("other user")));
        assert_eq!(quotas.allocations(), 5);
        assert!(quotas.acquire("w").is_none(), "the process is full");
        assert_eq!(code(quotas.refusal(Some("w"))), Some(508));
        assert_eq!(code(quotas.refusal(None)), Some(508));
        assert!(quotas.take("u", 4000), "user burst");
        assert!(!quotas.take("u", 1));
        assert!(!quotas.take("v", 3000), "only 2000 left for the process");
        assert!(quotas.take("v", 2000));
        assert!(!quotas.take("v", 1), "process budget spent");
        assert!(!quotas.take("nobody", 1));
        slots.truncate(3);
        assert_eq!(code(quotas.refusal(Some("w"))), None);
        assert!(quotas.acquire("u").is_none());
        drop(slots);
        assert_eq!(quotas.allocations(), 0);
        assert!(quotas.acquire("u").is_some());
    }

    #[test]
    fn filter_refuses_own_and_denied_addresses() {
        let (strict_filter, open_filter) = (filter(false), filter(true));
        let held = [49160u16, 49415];
        let live = |port: u16| held.contains(&port);
        let strict = ReadyFilter(&strict_filter, &live);
        let open = ReadyFilter(&open_filter, &live);
        let addr = |s: &str| s.parse::<SocketAddr>().unwrap();
        for refused in [
            "1.2.3.4:3478",
            "1.2.3.4:80",
            "1.2.3.4:49159",
            "1.2.3.4:49416",
            "[::ffff:1.2.3.4]:3478",
            "[64:ff9b::102:304]:22",
            "8.8.4.4:53",
            "[::ffff:8.8.4.4]:53",
            "[64:ff9b::808:404]:53",
            "[2001:4860:4860::8844]:53",
            "127.0.0.1:9",
            "192.88.99.1:9",
            "1.2.3.4:49161",
            "1.2.3.4:49300",
            "[::ffff:1.2.3.4]:49300",
        ] {
            assert!(!strict.allows(addr(refused)), "{refused} should be refused");
        }
        for passed in [
            "1.2.3.4:49160",
            "1.2.3.4:49415",
            "[::ffff:1.2.3.4]:49160",
            "8.8.8.8:53",
            "[2606:4700::1]:53",
        ] {
            assert!(strict.allows(addr(passed)), "{passed} should pass");
        }
        assert!(open.allows(addr("127.0.0.1:9")));
        assert!(open.allows(addr("1.2.3.4:3478")));
        assert!(
            !open.allows(addr("8.8.4.4:53")),
            "the denylist holds with RELAY_ALLOW_PRIVATE"
        );
        assert!(blocked("192.88.99.1".parse().unwrap()));
        assert!(
            !strict_filter.allows(addr("1.2.3.4:49160"), |_| false),
            "a range port nobody holds is closed"
        );
    }

    struct ReadyFilter<'a>(&'a PeerFilter, &'a dyn Fn(u16) -> bool);

    impl ReadyFilter<'_> {
        fn allows(&self, peer: SocketAddr) -> bool {
            self.0.allows(peer, self.1)
        }
    }

    fn with_peer_at(method: Method, ip: &str, port: u16) -> Message {
        use turn::proto::peeraddr::PeerAddress;
        let mut m = Message::new();
        m.build(&[
            Box::new(TransactionId::new()),
            Box::new(MessageType::new(method, CLASS_REQUEST)),
            Box::new(PeerAddress {
                ip: ip.parse().unwrap(),
                port,
            }),
        ])
        .unwrap();
        let mut decoded = Message::new();
        decoded.raw = m.raw.clone();
        decoded.decode().unwrap();
        decoded
    }

    fn with_peer(method: Method, ip: &str) -> Message {
        with_peer_at(method, ip, 5000)
    }

    #[test]
    fn guard_refuses_private_own_and_denied_peers() {
        let quotas = Quotas::new(Capacity::default());
        let (strict_filter, open_filter) = (filter(false), filter(true));
        let live = |port: u16| port == 49200;
        let strict = |p: SocketAddr| strict_filter.allows(p, live);
        let open = |p: SocketAddr| open_filter.allows(p, live);
        for method in [METHOD_CREATE_PERMISSION, METHOD_CHANNEL_BIND] {
            for ip in ["127.0.0.1", "10.0.0.5", "192.168.1.1", "::1", "fd00::1"] {
                let m = with_peer(method, ip);
                assert_eq!(
                    peer_addresses(&m),
                    Some(vec![SocketAddr::new(ip.parse().unwrap(), 5000)])
                );
                assert_eq!(judge(&m, strict, &quotas), Verdict::Refuse(CODE_FORBIDDEN));
                assert_eq!(judge(&m, open, &quotas), Verdict::Pass);
            }
            for ip in ["1.2.3.4", "8.8.4.4"] {
                let m = with_peer(method, ip);
                assert_eq!(
                    judge(&m, strict, &quotas),
                    Verdict::Refuse(CODE_FORBIDDEN),
                    "{ip}"
                );
            }
            assert_eq!(
                judge(&with_peer_at(method, "1.2.3.4", 49200), strict, &quotas),
                Verdict::Pass,
                "another allocation on this relay"
            );
            assert_eq!(
                judge(&with_peer_at(method, "1.2.3.4", 49201), strict, &quotas),
                Verdict::Refuse(CODE_FORBIDDEN),
                "a free port of the relay range"
            );
            for ip in ["8.8.8.8", "2606:4700:4700::1111"] {
                assert_eq!(
                    judge(&with_peer(method, ip), strict, &quotas),
                    Verdict::Pass
                );
            }
        }
        let mut m = with_peer(METHOD_CREATE_PERMISSION, "8.8.8.8");
        let mut second = Message::new();
        second
            .build(&[
                Box::new(m.transaction_id),
                Box::new(MessageType::new(METHOD_CREATE_PERMISSION, CLASS_REQUEST)),
                Box::new(turn::proto::peeraddr::PeerAddress {
                    ip: "10.0.0.1".parse().unwrap(),
                    port: 1,
                }),
            ])
            .unwrap();
        m.attributes.0.push(stun::attributes::RawAttribute {
            typ: ATTR_XOR_PEER_ADDRESS,
            length: 8,
            value: second.get(ATTR_XOR_PEER_ADDRESS).unwrap(),
        });
        assert_eq!(
            judge(&m, strict, &quotas),
            Verdict::Refuse(CODE_FORBIDDEN),
            "a second, private peer address is caught"
        );
        m.attributes.0.last_mut().unwrap().value.truncate(5);
        assert_eq!(peer_addresses(&m), None);
        assert_eq!(judge(&m, open, &quotas), Verdict::Refuse(CODE_FORBIDDEN));
    }

    fn request(method: Method, class: stun::message::MessageClass) -> Message {
        let mut m = Message::new();
        m.build(&[
            Box::new(TransactionId::new()),
            Box::new(MessageType::new(method, class)),
        ])
        .unwrap();
        let mut decoded = Message::new();
        decoded.raw = m.raw.clone();
        decoded.decode().unwrap();
        decoded
    }

    #[test]
    fn without_turn_only_binding_gets_through() {
        let from: SocketAddr = "198.51.100.7:4000".parse().unwrap();
        let now = Instant::now();
        let off = shared(false, Limits::default());
        assert_eq!(
            off.screen(&request(METHOD_BINDING, CLASS_REQUEST), from, now),
            Verdict::Pass
        );
        for (method, class) in [
            (METHOD_ALLOCATE, CLASS_REQUEST),
            (METHOD_REFRESH, CLASS_REQUEST),
            (METHOD_CREATE_PERMISSION, CLASS_REQUEST),
            (METHOD_CHANNEL_BIND, CLASS_REQUEST),
            (METHOD_SEND, CLASS_INDICATION),
            (METHOD_BINDING, CLASS_SUCCESS_RESPONSE),
            (METHOD_BINDING, CLASS_INDICATION),
        ] {
            assert_eq!(
                off.screen(&request(method, class), from, now),
                Verdict::Drop,
                "{method} {class}"
            );
        }
        let on = shared(true, Limits::default());
        assert_eq!(
            on.screen(&request(METHOD_ALLOCATE, CLASS_REQUEST), from, now),
            Verdict::Pass
        );
        assert_eq!(
            on.screen(&request(METHOD_BINDING, CLASS_SUCCESS_RESPONSE), from, now),
            Verdict::Drop
        );
    }

    fn limits() -> Limits {
        Limits {
            source_rate: 1.0,
            source_burst: 3.0,
            block_rate: 1.0,
            block_burst: 5.0,
            global_rate: 1.0,
            global_burst: 100.0,
            nonce_cap: 1000,
            sources_cap: 64,
        }
    }

    #[test]
    fn unauthenticated_requests_are_bounded_per_address_block_and_process() {
        let now = Instant::now();
        let mut limiter = Limiter::new(limits());
        let mut admitted = 0;
        for i in 0..10_000u32 {
            let ip = IpAddr::V4(Ipv4Addr::from(0x0b00_0000 + (i << 8)));
            admitted += usize::from(limiter.admit(ip, false, now));
            assert!(limiter.sources.map.len() <= 64 && limiter.blocks.map.len() <= 64);
        }
        assert_eq!(admitted, 100, "process budget across many blocks");
        let holder: IpAddr = "198.51.100.77".parse().unwrap();
        assert!(
            !limiter.admit(holder, false, now),
            "the process budget is spent"
        );
        assert_eq!(
            (0..10).filter(|_| limiter.admit(holder, true, now)).count(),
            3,
            "an allocation holder pays only its own budget"
        );

        let mut limiter = Limiter::new(limits());
        let one: IpAddr = "198.51.100.1".parse().unwrap();
        assert_eq!(
            (0..10).filter(|_| limiter.admit(one, false, now)).count(),
            3
        );
        let block = (2..=254u8)
            .filter(|i| limiter.admit(IpAddr::V4(Ipv4Addr::new(198, 51, 100, *i)), false, now))
            .count();
        assert_eq!(block, 2, "one /24 shares a budget of 5");
        assert!(limiter.admit("198.51.101.1".parse().unwrap(), false, now));
        let (a, b): (IpAddr, IpAddr) = (
            "2001:db8::1".parse().unwrap(),
            "2001:db8::2".parse().unwrap(),
        );
        assert_eq!(
            (0..5)
                .filter(|i| limiter.admit(if i % 2 == 0 { a } else { b }, false, now))
                .count(),
            3,
            "one /64 is one source"
        );
        let per_64 = (1..=40u16)
            .filter(|i| {
                let ip = Ipv6Addr::new(0x2001, 0xdb8, 0, *i, 0, 0, 0, 1);
                limiter.admit(IpAddr::V6(ip), false, now)
            })
            .count();
        assert_eq!(per_64, 2, "one /48 shares a block budget");
        assert!(limiter.admit(one, false, now + Duration::from_secs(5)));
        limiter.prune(now + Duration::from_secs(60));
        assert!(limiter.sources.map.is_empty() && limiter.blocks.map.is_empty());
    }

    #[test]
    fn allocation_holders_get_nonces_during_a_flood() {
        let relay = shared(
            true,
            Limits {
                global_burst: 2.0,
                global_rate: 0.001,
                ..limits()
            },
        );
        let now = Instant::now();
        let allocate = || request(METHOD_ALLOCATE, CLASS_REQUEST);
        for i in 0..2u8 {
            let from = SocketAddr::from(([198, 51, 100 + i, 1], 4000));
            assert_eq!(relay.screen(&allocate(), from, now), Verdict::Pass);
        }
        let holder: SocketAddr = "203.0.113.50:5000".parse().unwrap();
        assert_eq!(
            relay.screen(&allocate(), holder, now),
            Verdict::Drop,
            "the flood spent the process budget"
        );
        let perms = Arc::new(PermSet::default());
        relay.holders.lock().unwrap().insert(
            holder,
            Holder {
                user: "alice".to_string(),
                port: 49200,
                perms: Arc::downgrade(&perms),
            },
        );
        let refresh = || request(METHOD_REFRESH, CLASS_REQUEST);
        assert_eq!(relay.screen(&refresh(), holder, now), Verdict::Pass);
        let other_port = SocketAddr::new(holder.ip(), 5001);
        assert_eq!(
            relay.screen(&refresh(), other_port, now),
            Verdict::Drop,
            "only the allocation's exact address is exempt"
        );
        drop(perms);
        assert_eq!(
            relay.screen(&refresh(), holder, now),
            Verdict::Drop,
            "an ended allocation exempts nothing"
        );
    }

    #[test]
    fn a_full_nonce_table_drops_its_oldest_entries() {
        let relay = shared(
            true,
            Limits {
                nonce_cap: 16,
                ..Limits::default()
            },
        );
        let start = tokio::time::Instant::now();
        {
            let mut nonces = relay.nonces.try_lock().unwrap();
            for i in 0..16u64 {
                nonces.insert(format!("n{i}"), start + Duration::from_millis(i));
            }
        }
        let from: SocketAddr = "198.51.100.9:1".parse().unwrap();
        assert_eq!(
            relay.screen(
                &request(METHOD_ALLOCATE, CLASS_REQUEST),
                from,
                Instant::now()
            ),
            Verdict::Pass,
            "a full table makes room instead of locking new clients out"
        );
        let nonces = relay.nonces.try_lock().unwrap();
        assert_eq!(nonces.len(), 14, "the oldest eighth went");
        assert!(!nonces.contains_key("n0") && !nonces.contains_key("n1"));
        assert!(nonces.contains_key("n2") && nonces.contains_key("n15"));
        assert_eq!(
            relay.screen(
                &request(METHOD_BINDING, CLASS_REQUEST),
                from,
                Instant::now()
            ),
            Verdict::Pass
        );
    }

    fn signed(method: Method, username: &str, nonce: &str) -> Message {
        let mut m = Message::new();
        m.build(&[
            Box::new(TransactionId::new()),
            Box::new(MessageType::new(method, CLASS_REQUEST)),
            Box::new(Username::new(ATTR_USERNAME, username.to_string())),
            Box::new(Nonce::new(ATTR_NONCE, nonce.to_string())),
            Box::new(stun::integrity::MessageIntegrity::new_short_term_integrity(
                "k".to_string(),
            )),
        ])
        .unwrap();
        let mut decoded = Message::new();
        decoded.raw = m.raw;
        decoded.decode().unwrap();
        decoded
    }

    #[test]
    fn nonces_belong_to_the_address_they_were_sent_to() {
        let relay = shared(
            true,
            Limits {
                source_burst: 1.0,
                source_rate: 0.001,
                ..Limits::default()
            },
        );
        let owner: SocketAddr = "198.51.100.1:4000".parse().unwrap();
        let spoofed: SocketAddr = "198.51.100.2:4000".parse().unwrap();
        let mut challenge = Message::new();
        challenge
            .build(&[
                Box::new(TransactionId::new()),
                Box::new(MessageType::new(METHOD_ALLOCATE, CLASS_ERROR_RESPONSE)),
                Box::new(Nonce::new(ATTR_NONCE, "n1".to_string())),
            ])
            .unwrap();
        relay.issued(&challenge.raw, owner);
        relay
            .nonces
            .try_lock()
            .unwrap()
            .insert("n1".to_string(), tokio::time::Instant::now());
        let now = Instant::now();
        assert_eq!(
            relay.nonce_state(&signed(METHOD_ALLOCATE, "1:abc", "n1"), owner.ip()),
            NonceState::Mine
        );
        for _ in 0..5 {
            assert_eq!(
                relay.screen(&signed(METHOD_ALLOCATE, "1:abc", "n1"), owner, now),
                Verdict::Pass
            );
        }
        for _ in 0..5 {
            assert_eq!(
                relay.screen(&signed(METHOD_ALLOCATE, "1:abc", "n1"), spoofed, now),
                Verdict::Drop,
                "someone else's nonce is refused outright"
            );
        }
        assert_eq!(
            relay.screen(&request(METHOD_BINDING, CLASS_REQUEST), spoofed, now),
            Verdict::Pass,
            "refusing it cost that source nothing"
        );
        assert_eq!(
            relay.screen(&signed(METHOD_ALLOCATE, "1:abc", "gone"), owner, now),
            Verdict::Pass,
            "an unknown nonce is only rate-limited: the server answers 438 with a new one"
        );
        assert_eq!(
            relay.screen(&signed(METHOD_ALLOCATE, "1:abc", "gone"), owner, now),
            Verdict::Drop
        );
    }

    #[test]
    fn allocations_answer_only_to_their_owner() {
        let shared = Arc::new(shared(true, Limits::default()));
        let auth = RestAuth {
            secret: "k".to_string(),
            shared: Arc::clone(&shared),
        };
        let client: SocketAddr = "198.51.100.1:4000".parse().unwrap();
        let elsewhere: SocketAddr = "198.51.100.1:4001".parse().unwrap();
        let perms = Arc::new(PermSet::default());
        shared.holders.lock().unwrap().insert(
            client,
            Holder {
                user: "aaaa".to_string(),
                port: 49200,
                perms: Arc::downgrade(&perms),
            },
        );
        let at = unix_now() + 600;
        let (alice, bob) = (format!("{at}:aaaa"), format!("{at}:bbbb"));
        let attempt = |method: Method, name: &str, src: SocketAddr| {
            shared.current.lock().unwrap().method = Some(method);
            auth.auth_handle(name, REALM, src).is_ok()
        };
        for method in [
            METHOD_REFRESH,
            METHOD_CREATE_PERMISSION,
            METHOD_CHANNEL_BIND,
        ] {
            assert!(attempt(method, &alice, client), "{method}");
            assert!(!attempt(method, &bob, client), "{method} from another user");
            assert!(
                shared.current.lock().unwrap().user.is_none(),
                "a refused user is not remembered"
            );
            assert!(attempt(method, &bob, elsewhere), "bob's own address");
        }
        assert!(
            attempt(METHOD_ALLOCATE, &bob, client),
            "Allocate is left to the server, which answers 437 for a taken address"
        );
    }

    #[test]
    fn stun_list_picks_are_stable_per_instance() {
        let list = bundled_stun();
        assert!(!list.is_empty() && list.len() <= 12, "{list:?}");
        assert!(list.iter().all(|s| s.starts_with("stun:")));
        let a = pick_stun(&list, "instance-a", 3);
        assert_eq!(a.len(), 3.min(list.len()));
        assert_eq!(a, pick_stun(&list, "instance-a", 3));
        let order: Vec<usize> = a
            .iter()
            .map(|s| list.iter().position(|l| l == s).unwrap())
            .collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "bundled order kept");
        let spread: std::collections::HashSet<Vec<String>> = (0..20)
            .map(|i| pick_stun(&list, &format!("instance-{i}"), 3))
            .collect();
        assert!(spread.len() > 1, "instances spread across the list");
    }

    mod live {
        use super::super::*;
        use turn::client::{Client, ClientConfig};

        const SECRET: &str = "test-relay-secret";

        fn settings(allow_private: bool, min_port: u16) -> RelaySettings {
            RelaySettings {
                bind: "127.0.0.1:0".parse().unwrap(),
                turn: true,
                public_ip: Some(Ipv4Addr::LOCALHOST.into()),
                min_port,
                max_port: min_port + 39,
                allow_private,
                denied: Vec::new(),
                capacity: Capacity {
                    total_allocations: 40,
                    ..Capacity::default()
                },
                limits: Limits::default(),
            }
        }

        async fn start(settings: RelaySettings) -> Relay {
            Relay::start(&settings, SECRET).await.expect("relay")
        }

        async fn relay(allow_private: bool, min_port: u16) -> Relay {
            start(settings(allow_private, min_port)).await
        }

        async fn client(relay: &Relay, username: &str, password: &str) -> Client {
            let conn = Arc::new(UdpSocket::bind("127.0.0.1:0").await.expect("bind"));
            let client = Client::new(ClientConfig {
                stun_serv_addr: relay.addr.to_string(),
                turn_serv_addr: relay.addr.to_string(),
                username: username.to_string(),
                password: password.to_string(),
                realm: String::new(),
                software: String::new(),
                rto_in_ms: 0,
                conn,
                vnet: None,
            })
            .await
            .expect("client");
            client.listen().await.expect("listen");
            client
        }

        async fn signed_in(relay: &Relay, user: &str, now: i64) -> Client {
            let cred = issue(SECRET, user, now);
            client(relay, &cred.username, &cred.password).await
        }

        fn unix() -> i64 {
            unix_now() as i64
        }

        #[tokio::test]
        async fn allocations_need_valid_unexpired_credentials() {
            let relay = relay(false, 49610).await;
            let alice = signed_in(&relay, "alice", unix()).await;
            let mapped = alice.send_binding_request().await.expect("stun binding");
            assert_eq!(mapped.ip(), IpAddr::from(Ipv4Addr::LOCALHOST));
            let conn = alice
                .allocate()
                .await
                .expect("allocation with valid credentials");
            let relayed = conn.local_addr().unwrap();
            assert_eq!(relayed.ip(), IpAddr::from(Ipv4Addr::LOCALHOST));
            assert!((49610..=49649).contains(&relayed.port()), "{relayed}");
            assert_eq!(relay.quotas.allocations(), 1);

            let cred = issue(SECRET, "bob", unix());
            let wrong = client(&relay, &cred.username, "not-the-password").await;
            assert!(wrong.allocate().await.is_err(), "wrong password");
            let other = issue("another-secret", "bob", unix());
            let foreign = client(&relay, &other.username, &other.password).await;
            assert!(
                foreign.allocate().await.is_err(),
                "credentials of another secret"
            );
            let expired = signed_in(&relay, "bob", unix() - CREDENTIAL_TTL_SECS - 5).await;
            assert!(expired.allocate().await.is_err(), "expired credentials");
            let plain = client(&relay, "bob", &password(SECRET, "bob")).await;
            assert!(plain.allocate().await.is_err(), "username without expiry");
            assert_eq!(relay.quotas.allocations(), 1);
            for c in [alice, wrong, foreign, expired, plain] {
                c.close().await.unwrap();
            }
            relay.close().await;
        }

        #[tokio::test]
        async fn relay_refuses_private_and_loopback_peers() {
            let relay = relay(false, 49650).await;
            let echo = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let alice = signed_in(&relay, "alice", unix()).await;
            let conn = alice.allocate().await.expect("allocation");
            for target in [
                echo.local_addr().unwrap().to_string(),
                "10.1.2.3:9".to_string(),
                "192.168.1.10:9".to_string(),
                "169.254.169.254:80".to_string(),
                "100.64.0.1:9".to_string(),
                "192.88.99.1:9".to_string(),
                "[::1]:9".to_string(),
                "[fd00::1]:9".to_string(),
                "[::ffff:127.0.0.1]:9".to_string(),
            ] {
                let addr: SocketAddr = target.parse().unwrap();
                let err = conn
                    .send_to(b"hello", addr)
                    .await
                    .expect_err(&format!("permission to {target} must be refused"));
                assert!(err.to_string().contains("403"), "{target}: {err}");
            }
            let mut buf = [0u8; 64];
            assert!(
                tokio::time::timeout(Duration::from_millis(300), echo.recv_from(&mut buf))
                    .await
                    .is_err(),
                "nothing reached the loopback peer"
            );
            alice.close().await.unwrap();
            relay.close().await;
        }

        #[tokio::test]
        async fn relay_refuses_its_own_address_and_denied_peers() {
            let public: IpAddr = "1.2.3.4".parse().unwrap();
            let relay = start(RelaySettings {
                public_ip: Some(public),
                denied: vec![Cidr::parse("9.9.9.0/24").unwrap()],
                ..settings(false, 49770)
            })
            .await;
            let alice = signed_in(&relay, "alice", unix()).await;
            let conn = alice.allocate().await.expect("allocation");
            assert_eq!(conn.local_addr().unwrap().ip(), public);
            for target in [
                SocketAddr::new(public, relay.addr.port()),
                SocketAddr::new(public, 22),
                SocketAddr::new(public, 49810),
                "[::ffff:1.2.3.4]:3478".parse().unwrap(),
                "9.9.9.9:53".parse().unwrap(),
                "[64:ff9b::909:909]:53".parse().unwrap(),
            ] {
                let err = conn
                    .send_to(b"hello", target)
                    .await
                    .expect_err(&format!("permission to {target} must be refused"));
                assert!(err.to_string().contains("403"), "{target}: {err}");
            }
            assert!(
                !relay
                    .shared
                    .allows(SocketAddr::new(public, relay.addr.port())),
                "the relayed sockets refuse it too"
            );
            alice.close().await.unwrap();
            relay.close().await;
        }

        #[tokio::test]
        async fn relay_forwards_when_private_peers_are_allowed() {
            let relay = relay(true, 49690).await;
            let echo = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let alice = signed_in(&relay, "alice", unix()).await;
            let conn = alice.allocate().await.expect("allocation");
            let relayed = conn.local_addr().unwrap();
            conn.send_to(b"ping", echo.local_addr().unwrap())
                .await
                .expect("send through the relay");
            let mut buf = [0u8; 64];
            let (n, from) = tokio::time::timeout(Duration::from_secs(5), echo.recv_from(&mut buf))
                .await
                .expect("relayed packet")
                .unwrap();
            assert_eq!(&buf[..n], b"ping");
            assert_eq!(from.port(), relayed.port());
            echo.send_to(b"pong", from).await.unwrap();
            let (n, peer) = tokio::time::timeout(Duration::from_secs(5), conn.recv_from(&mut buf))
                .await
                .expect("reply through the relay")
                .unwrap();
            assert_eq!(&buf[..n], b"pong");
            assert_eq!(peer, echo.local_addr().unwrap());
            alice.close().await.unwrap();
            relay.close().await;
        }

        #[tokio::test]
        async fn users_and_the_process_have_allocation_caps() {
            let relay = start(RelaySettings {
                capacity: Capacity {
                    user_allocations: 3,
                    total_allocations: 5,
                    ..Capacity::default()
                },
                ..settings(false, 49730)
            })
            .await;
            let mut clients = Vec::new();
            let mut conns = Vec::new();
            for _ in 0..3 {
                let c = signed_in(&relay, "alice", unix()).await;
                conns.push(c.allocate().await.expect("within quota"));
                clients.push(c);
            }
            let extra = signed_in(&relay, "alice", unix()).await;
            let err = extra
                .allocate()
                .await
                .err()
                .expect("fourth allocation refused");
            assert!(err.to_string().contains("486"), "{err}");
            for _ in 0..2 {
                let c = signed_in(&relay, "bob", unix()).await;
                conns.push(c.allocate().await.expect("other users are unaffected"));
                clients.push(c);
            }
            assert_eq!(relay.quotas.allocations(), 5);
            let carol = signed_in(&relay, "carol", unix()).await;
            let err = carol.allocate().await.err().expect("process cap reached");
            assert!(err.to_string().contains("508"), "{err}");
            for c in clients.into_iter().chain([extra, carol]) {
                c.close().await.unwrap();
            }
            relay.close().await;
        }

        #[tokio::test]
        async fn revoked_users_lose_allocations_and_credentials() {
            let relay = Arc::new(relay(false, 49810).await);
            let hub = crate::ws::Hub::new();
            let (db, path) = temp_db("revoked").await;
            follow_revocations(&relay, &hub, &db);
            let alice = signed_in(&relay, "alice", unix()).await;
            let _alice_conn = alice.allocate().await.expect("alice allocates");
            let bob = signed_in(&relay, "bob", unix()).await;
            let _bob_conn = bob.allocate().await.expect("bob allocates");
            assert_eq!(relay.quotas.allocations(), 2);

            hub.broadcast(crate::ws::WsEvent::Banned {
                username: "Alice".to_string(),
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while relay.quotas.allocations() != 1 && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert_eq!(relay.quotas.allocations(), 1, "alice's allocation ended");
            let left: Vec<String> = relay
                .manager
                .get_allocations_info(None)
                .await
                .into_values()
                .map(|i| i.username)
                .collect();
            assert_eq!(left.len(), 1);
            assert!(left[0].ends_with(&opaque(SECRET, "bob")), "{left:?}");

            let again = signed_in(&relay, "alice", unix()).await;
            assert!(
                again.allocate().await.is_err(),
                "credentials issued before the ban are refused"
            );
            let bob2 = signed_in(&relay, "bob", unix()).await;
            let _bob2_conn = bob2.allocate().await.expect("bob is unaffected");
            for c in [alice, bob, again, bob2] {
                c.close().await.unwrap();
            }
            relay.close().await;
            drop_db(db, path).await;
        }

        async fn temp_db(tag: &str) -> (crate::db::Db, std::path::PathBuf) {
            let path = crate::db::temp_db_path(&format!("relay_{tag}"));
            let _ = std::fs::remove_file(&path);
            let db = crate::db::open(path.to_str()).await.expect("open db");
            (db, path)
        }

        async fn drop_db(db: crate::db::Db, path: std::path::PathBuf) {
            crate::db::close(&db).await;
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        }

        async fn add_user(db: &crate::db::Db, name: &str) {
            sqlx::query(
                "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES ($1, $1, 'x', 'text', 'identicon', 0)",
            )
            .bind(name)
            .execute(db)
            .await
            .expect("user");
        }

        async fn until(what: &str, check: impl Fn() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !check() {
                assert!(Instant::now() < deadline, "timed out waiting: {what}");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        #[tokio::test]
        async fn missed_bans_are_caught_from_the_database() {
            let relay = Arc::new(relay(false, 49930).await);
            let hub = crate::ws::Hub::new();
            let (db, path) = temp_db("reconcile").await;
            for name in ["alice", "Bob", "carol"] {
                add_user(&db, name).await;
            }
            assert_eq!(relay.reconcile(&db).await.unwrap(), 0, "nothing to check");
            follow_revocations(&relay, &hub, &db);
            let mut clients = Vec::new();
            let mut conns = Vec::new();
            for name in ["alice", "bob", "carol"] {
                let c = signed_in(&relay, name, unix()).await;
                conns.push(c.allocate().await.expect("allocates"));
                clients.push(c);
            }
            assert_eq!(relay.reconcile(&db).await.unwrap(), 0, "everyone is fine");

            sqlx::query("UPDATE users SET password_hash = $1 WHERE username = 'alice'")
                .bind(crate::db::PURGING_HASH)
                .execute(&db)
                .await
                .unwrap();
            for _ in 0..1500 {
                hub.broadcast(crate::ws::WsEvent::Banned {
                    username: "nobody".to_string(),
                });
            }
            until("the lagged subscriber reconciles", || {
                relay.quotas.allocations() == 2
            })
            .await;
            let left: HashSet<String> = relay
                .manager
                .get_allocations_info(None)
                .await
                .into_values()
                .map(|i| i.username.split_once(':').unwrap().1.to_string())
                .collect();
            assert_eq!(
                left,
                HashSet::from([opaque(SECRET, "bob"), opaque(SECRET, "carol")])
            );
            let again = signed_in(&relay, "alice", unix()).await;
            assert!(
                again.allocate().await.is_err(),
                "alice's credentials are revoked"
            );

            sqlx::query("DELETE FROM users WHERE username = 'carol'")
                .execute(&db)
                .await
                .unwrap();
            hub.resync(false);
            until("a bus resync reconciles", || {
                relay.quotas.allocations() == 1
            })
            .await;
            assert_eq!(relay.reconcile(&db).await.unwrap(), 0, "bob stays");
            for c in clients.into_iter().chain([again]) {
                c.close().await.unwrap();
            }
            relay.close().await;
            drop_db(db, path).await;
        }

        #[tokio::test]
        async fn allocations_made_while_a_revocation_runs_end() {
            let relay = relay(false, 49970).await;
            let alice = signed_in(&relay, "alice", unix()).await;
            let _alice_conn = alice.allocate().await.expect("alice allocates");
            let bob = signed_in(&relay, "bob", unix()).await;
            let _bob_conn = bob.allocate().await.expect("bob allocates");
            let names: HashMap<String, SocketAddr> = relay
                .manager
                .get_allocations_info(None)
                .await
                .into_iter()
                .map(|(t, i)| (i.username, t.src_addr))
                .collect();
            let name_of = |user: &str| {
                let o = opaque(SECRET, user);
                names
                    .iter()
                    .find(|(n, _)| n.ends_with(&o))
                    .map(|(n, a)| (*a, n.clone()))
                    .unwrap()
            };
            relay
                .shared
                .revoked
                .lock()
                .unwrap()
                .insert(opaque(SECRET, "alice"), unix_now());
            relay.shared.current.lock().unwrap().allocated = Some(name_of("bob"));
            drop_if_revoked(&relay.shared, &relay.manager).await;
            assert_eq!(relay.quotas.allocations(), 2, "bob is not revoked");
            relay.shared.current.lock().unwrap().allocated = Some(name_of("alice"));
            drop_if_revoked(&relay.shared, &relay.manager).await;
            assert_eq!(
                relay.quotas.allocations(),
                1,
                "alice's new allocation ended"
            );
            assert!(relay.shared.current.lock().unwrap().allocated.is_none());
            for c in [alice, bob] {
                c.close().await.unwrap();
            }
            relay.close().await;
        }

        #[tokio::test]
        async fn own_address_ports_are_open_only_while_an_allocation_holds_them() {
            let public: IpAddr = "1.2.3.4".parse().unwrap();
            let relay = start(RelaySettings {
                public_ip: Some(public),
                ..settings(false, 50010)
            })
            .await;
            let alice = signed_in(&relay, "alice", unix()).await;
            let alice_conn = alice.allocate().await.expect("alice allocates");
            let bob = signed_in(&relay, "bob", unix()).await;
            let bob_conn = bob.allocate().await.expect("bob allocates");
            let bob_at = bob_conn.local_addr().unwrap();
            assert_eq!(bob_at.ip(), public);
            let free = (50010..=50049u16)
                .find(|p| *p != bob_at.port() && *p != alice_conn.local_addr().unwrap().port())
                .unwrap();
            let permission = |peer: SocketAddr| {
                let m = super::with_peer_at(
                    METHOD_CREATE_PERMISSION,
                    &peer.ip().to_string(),
                    peer.port(),
                );
                judge(&m, |p| relay.shared.allows(p), &relay.shared.quotas)
            };
            assert_eq!(permission(bob_at), Verdict::Pass, "bob's relayed address");
            assert!(relay.shared.allows(bob_at), "at both layers");
            let err = alice_conn
                .send_to(b"hello", SocketAddr::new(public, free))
                .await
                .expect_err("a range port no allocation holds");
            assert!(err.to_string().contains("403"), "{err}");

            bob_conn.close().await.unwrap();
            until("bob's allocation ends", || relay.quotas.allocations() == 1).await;
            assert!(!relay.shared.allows(bob_at), "closed with the allocation");
            let err = alice_conn
                .send_to(b"hello", bob_at)
                .await
                .expect_err("bob's old port");
            assert!(err.to_string().contains("403"), "{err}");
            for c in [alice, bob] {
                c.close().await.unwrap();
            }
            relay.close().await;
        }

        async fn turn_exchange(s: &UdpSocket, to: SocketAddr, m: &Message) -> Option<Message> {
            s.send_to(&m.raw, to).await.unwrap();
            let mut buf = [0u8; 1500];
            let (n, _) = tokio::time::timeout(Duration::from_millis(500), s.recv_from(&mut buf))
                .await
                .ok()?
                .unwrap();
            let mut reply = Message::new();
            reply.raw = buf[..n].to_vec();
            reply.decode().unwrap();
            Some(reply)
        }

        fn turn_request(
            method: Method,
            cred: Option<(&Credential, &str)>,
            extra: Vec<Box<dyn Setter>>,
        ) -> Message {
            let mut setters: Vec<Box<dyn Setter>> = vec![
                Box::new(TransactionId::new()),
                Box::new(MessageType::new(method, CLASS_REQUEST)),
            ];
            setters.extend(extra);
            if let Some((cred, nonce)) = cred {
                setters.push(Box::new(Username::new(
                    ATTR_USERNAME,
                    cred.username.clone(),
                )));
                setters.push(Box::new(stun::textattrs::Realm::new(
                    stun::attributes::ATTR_REALM,
                    REALM.to_string(),
                )));
                setters.push(Box::new(Nonce::new(ATTR_NONCE, nonce.to_string())));
                setters.push(Box::new(
                    stun::integrity::MessageIntegrity::new_long_term_integrity(
                        cred.username.clone(),
                        REALM.to_string(),
                        cred.password.clone(),
                    ),
                ));
            }
            let mut m = Message::new();
            m.build(&setters).unwrap();
            m
        }

        fn transport() -> Vec<Box<dyn Setter>> {
            vec![Box::new(turn::proto::reqtrans::RequestedTransport {
                protocol: turn::proto::PROTO_UDP,
            })]
        }

        fn delete() -> Vec<Box<dyn Setter>> {
            vec![Box::new(turn::proto::lifetime::Lifetime(Duration::ZERO))]
        }

        fn class_of(m: &Option<Message>) -> Option<stun::message::MessageClass> {
            m.as_ref().map(|m| m.typ.class)
        }

        #[tokio::test]
        async fn other_users_cannot_touch_an_allocation() {
            let relay = relay(false, 50050).await;
            let s = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let challenge = turn_exchange(
                &s,
                relay.addr,
                &turn_request(METHOD_ALLOCATE, None, transport()),
            )
            .await
            .expect("401 with a nonce");
            let nonce = Nonce::get_from_as(&challenge, ATTR_NONCE).unwrap().text;
            let (alice, bob) = (issue(SECRET, "alice", unix()), issue(SECRET, "bob", unix()));
            let made = turn_exchange(
                &s,
                relay.addr,
                &turn_request(METHOD_ALLOCATE, Some((&alice, &nonce)), transport()),
            )
            .await;
            assert_eq!(
                class_of(&made),
                Some(CLASS_SUCCESS_RESPONSE),
                "alice allocates"
            );
            assert_eq!(relay.quotas.allocations(), 1);

            for (method, extra) in [
                (METHOD_REFRESH, delete()),
                (METHOD_REFRESH, Vec::new()),
                (
                    METHOD_CREATE_PERMISSION,
                    vec![Box::new(turn::proto::peeraddr::PeerAddress {
                        ip: "8.8.8.8".parse().unwrap(),
                        port: 53,
                    }) as Box<dyn Setter>],
                ),
            ] {
                let reply = turn_exchange(
                    &s,
                    relay.addr,
                    &turn_request(method, Some((&bob, &nonce)), extra),
                )
                .await;
                assert_eq!(
                    class_of(&reply),
                    Some(CLASS_ERROR_RESPONSE),
                    "bob's {method} on alice's allocation"
                );
            }
            assert_eq!(
                relay.quotas.allocations(),
                1,
                "alice's allocation is intact"
            );

            let elsewhere = UdpSocket::bind("127.0.0.2:0").await.unwrap();
            let foreign = turn_exchange(
                &elsewhere,
                relay.addr,
                &turn_request(METHOD_ALLOCATE, Some((&bob, &nonce)), transport()),
            )
            .await;
            assert!(
                foreign.is_none(),
                "a nonce sent to another address gets no answer"
            );

            let ended = turn_exchange(
                &s,
                relay.addr,
                &turn_request(METHOD_REFRESH, Some((&alice, &nonce)), delete()),
            )
            .await;
            assert_eq!(
                class_of(&ended),
                Some(CLASS_SUCCESS_RESPONSE),
                "alice may end it"
            );
            until("alice's allocation ends", || {
                relay.quotas.allocations() == 0
            })
            .await;
            assert!(relay.shared.holders.lock().unwrap().is_empty());
            assert!(relay.shared.ports.lock().unwrap().is_empty());
            relay.close().await;
        }

        #[tokio::test]
        async fn stopping_releases_the_listener() {
            let relay = relay(false, 50090).await;
            let alice = signed_in(&relay, "alice", unix()).await;
            let conn = alice.allocate().await.expect("alice allocates");
            conn.close().await.unwrap();
            until("the allocation ends", || relay.quotas.allocations() == 0).await;
            let bob = signed_in(&relay, "bob", unix()).await;
            bob.allocate()
                .await
                .expect("an ending allocation leaves the listener open");
            let addr = relay.addr;
            assert!(std::net::UdpSocket::bind(addr).is_err(), "listening");
            relay.close().await;
            std::net::UdpSocket::bind(addr).expect("close released the listener");
            for c in [alice, bob] {
                c.close().await.unwrap();
            }

            let dropped = start(settings(false, 50130)).await;
            let addr = dropped.addr;
            drop(dropped);
            let deadline = Instant::now() + Duration::from_secs(5);
            while std::net::UdpSocket::bind(addr).is_err() {
                assert!(
                    Instant::now() < deadline,
                    "dropping the handle stops the relay"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        fn raw(method: Method) -> Vec<u8> {
            use turn::proto::reqtrans::RequestedTransport;
            let mut m = Message::new();
            let mut setters: Vec<Box<dyn Setter>> = vec![
                Box::new(TransactionId::new()),
                Box::new(MessageType::new(method, CLASS_REQUEST)),
            ];
            if method == METHOD_ALLOCATE {
                setters.push(Box::new(RequestedTransport {
                    protocol: turn::proto::PROTO_UDP,
                }));
            }
            m.build(&setters).unwrap();
            m.raw
        }

        async fn answers(sockets: &[UdpSocket]) -> usize {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let mut buf = [0u8; 1500];
            let mut n = 0;
            for s in sockets {
                while let Ok(Ok(_)) =
                    tokio::time::timeout(Duration::from_millis(20), s.recv_from(&mut buf)).await
                {
                    n += 1;
                }
            }
            n
        }

        #[tokio::test]
        async fn without_turn_the_listener_answers_only_binding() {
            let relay = start(RelaySettings {
                turn: false,
                public_ip: None,
                ..settings(false, 49850)
            })
            .await;
            let s = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            s.send_to(&raw(METHOD_ALLOCATE), relay.addr).await.unwrap();
            s.send_to(&raw(METHOD_REFRESH), relay.addr).await.unwrap();
            assert_eq!(answers(std::slice::from_ref(&s)).await, 0);
            s.send_to(&raw(METHOD_BINDING), relay.addr).await.unwrap();
            assert_eq!(answers(std::slice::from_ref(&s)).await, 1);
            assert!(relay.shared.nonces.lock().await.is_empty());
            relay.close().await;
        }

        #[tokio::test]
        async fn unauthenticated_floods_stay_within_budget() {
            let limits = Limits {
                source_rate: 0.001,
                source_burst: 2.0,
                block_rate: 0.001,
                block_burst: 1000.0,
                global_rate: 0.001,
                global_burst: 1000.0,
                nonce_cap: 1000,
                sources_cap: 16,
            };
            let one_block = |i: u8| SocketAddr::from(([127, 0, 0, i], 0));
            let many_blocks = |i: u8| SocketAddr::from(([127, 0, i, 2], 0));
            type Spread = fn(u8) -> SocketAddr;
            let cases: [(Limits, Spread, usize); 3] = [
                (
                    Limits {
                        block_burst: 15.0,
                        ..limits.clone()
                    },
                    one_block,
                    15,
                ),
                (
                    Limits {
                        global_burst: 15.0,
                        ..limits.clone()
                    },
                    many_blocks,
                    15,
                ),
                (
                    Limits {
                        nonce_cap: 10,
                        ..limits.clone()
                    },
                    many_blocks,
                    60,
                ),
            ];
            for (limits, at, bound) in cases {
                let nonce_cap = limits.nonce_cap;
                let relay = start(RelaySettings {
                    limits,
                    ..settings(false, 49890)
                })
                .await;
                let mut sockets = Vec::new();
                for i in 2..32u8 {
                    sockets.push(UdpSocket::bind(at(i)).await.unwrap());
                }
                for s in &sockets {
                    for _ in 0..3 {
                        s.send_to(&raw(METHOD_ALLOCATE), relay.addr).await.unwrap();
                    }
                }
                let got = answers(&sockets).await;
                let nonces = relay.shared.nonces.lock().await.len();
                assert!(got > 0 && got <= bound, "{got} answers, bound {bound}");
                assert!(nonces <= bound.min(nonce_cap), "{nonces} nonces");
                {
                    let limiter = relay.shared.limiter.lock().unwrap();
                    assert!(limiter.sources.map.len() <= 16 && limiter.blocks.map.len() <= 16);
                }
                let one = &sockets[sockets.len() - 1..];
                for _ in 0..5 {
                    one[0]
                        .send_to(&raw(METHOD_BINDING), relay.addr)
                        .await
                        .unwrap();
                }
                assert_eq!(answers(one).await, 0, "that source spent its budget");
                relay.close().await;
            }
        }

        #[tokio::test]
        async fn relayed_sockets_filter_and_charge_only_permitted_traffic() {
            let shared = Arc::new(Shared::new(
                true,
                PeerFilter {
                    allow_private: true,
                    own: Vec::new(),
                    relay_ports: (1, 1),
                    denied: vec![Cidr::parse("127.0.0.2").unwrap()],
                },
                Capacity {
                    user_allocations: 1,
                    total_allocations: 1,
                    user_bytes_per_sec: 2.0,
                    total_bytes_per_sec: 1000.0,
                },
                Limits::default(),
            ));
            let slot = shared.quotas.acquire("u").unwrap();
            let relayed = Relayed {
                inner: UdpSocket::bind("127.0.0.1:0").await.unwrap(),
                shared: Arc::clone(&shared),
                perms: Arc::default(),
                slot: Mutex::new(Some(slot)),
                user: "u".to_string(),
                client: "127.0.0.1:9".parse().unwrap(),
                active: Mutex::new(Instant::now() - IDLE + Duration::from_millis(500)),
            };
            let at = relayed.local_addr().unwrap();
            let sender = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            for _ in 0..10 {
                sender.send_to(b"probe", at).await.unwrap();
            }
            let mut buf = [0u8; 16];
            let got = tokio::time::timeout(Duration::from_secs(3), relayed.recv_from(&mut buf))
                .await
                .expect("ends instead of hanging");
            assert!(
                got.is_err(),
                "unpermitted packets dropped, then idle: {got:?}"
            );

            *relayed.active.lock().unwrap() = Instant::now();
            relayed.perms.lock().unwrap().insert(
                "127.0.0.1".parse().unwrap(),
                Instant::now() + Duration::from_secs(60),
            );
            sender.send_to(b"hello", at).await.unwrap();
            let (n, _) = tokio::time::timeout(Duration::from_secs(3), relayed.recv_from(&mut buf))
                .await
                .expect("permitted packet")
                .expect("delivered: the 50 dropped bytes cost nothing of the 8-byte burst");
            assert_eq!(&buf[..n], b"hello");

            let denied = UdpSocket::bind("127.0.0.2:0").await.unwrap();
            relayed.perms.lock().unwrap().insert(
                "127.0.0.2".parse().unwrap(),
                Instant::now() + Duration::from_secs(60),
            );
            assert_eq!(
                relayed
                    .send_to(b"x", denied.local_addr().unwrap())
                    .await
                    .unwrap(),
                1
            );
            denied.send_to(b"in", at).await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(300), relayed.recv_from(&mut buf))
                    .await
                    .is_err(),
                "a denied source is dropped"
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(200), denied.recv_from(&mut buf))
                    .await
                    .is_err(),
                "nothing sent to a denied peer"
            );
            assert_eq!(shared.quotas.allocations(), 1);
            relayed.close().await.unwrap();
            assert_eq!(shared.quotas.allocations(), 0);
        }
    }
}
