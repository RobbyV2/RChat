use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::{Hub, PACED_USERS_MAX};

/// Per-user bounds on realtime connections: at most `conns_per_user` open at once across all
/// instances (the oldest is closed), and `connect_burst` new ones, then one per
/// `connect_every`, per instance. Per client address (an IPv6 /64 counts as one), at most
/// `sockets_per_ip` open on this instance, `guests_per_ip` of them as guests. At most
/// `guests_max` guest sockets on this instance from all addresses together (0 turns guests off).
/// At most `voice_room_max` people in one voice channel (0 for no limit).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limits {
    pub conns_per_user: usize,
    pub connect_burst: u32,
    pub connect_every: Duration,
    pub sockets_per_ip: usize,
    pub guests_per_ip: usize,
    pub guests_max: usize,
    pub voice_room_max: usize,
}

pub const CONNS_PER_USER: usize = 20;
pub const CONNECT_BURST: u32 = 20;
pub const CONNECTS_PER_MINUTE: u32 = 30;
pub const SOCKETS_PER_IP: usize = 200;
/// How long a new realtime socket has to send its `auth` frame.
pub const AUTH_WAIT: Duration = Duration::from_secs(10);
pub const GUESTS_PER_IP: usize = 50;
pub const GUESTS_MAX: usize = 2000;

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            conns_per_user: CONNS_PER_USER,
            connect_burst: CONNECT_BURST,
            connect_every: Duration::from_secs(60) / CONNECTS_PER_MINUTE,
            sockets_per_ip: SOCKETS_PER_IP,
            guests_per_ip: GUESTS_PER_IP,
            guests_max: GUESTS_MAX,
            voice_room_max: crate::ws::VOICE_ROOM_MAX,
        }
    }
}

/// A token bucket per user: `burst` units at once, then one more per `every`.
pub(super) struct Pacer {
    burst: AtomicU64,
    every: Duration,
    users: Mutex<HashMap<String, (f64, Instant)>>,
}

impl Pacer {
    fn new(burst: f64, every: Duration) -> Pacer {
        Pacer {
            burst: AtomicU64::new(burst.to_bits()),
            every,
            users: Mutex::new(HashMap::new()),
        }
    }

    fn burst(&self) -> f64 {
        f64::from_bits(self.burst.load(Ordering::Relaxed))
    }

    pub(super) fn set_burst(&self, burst: f64) {
        self.burst.store(burst.to_bits(), Ordering::Relaxed);
    }

    pub(super) fn take(&self, key: &str, cost: f64) -> bool {
        self.take_at(key, cost, Instant::now())
    }

    pub(super) fn take_at(&self, key: &str, cost: f64, now: Instant) -> bool {
        let burst = self.burst();
        let mut users = self.users.lock().unwrap();
        if users.len() > PACED_USERS_MAX {
            let full = self.every.mul_f64(burst);
            users.retain(|_, (_, at)| now.duration_since(*at) < full);
        }
        let (tokens, at) = users.entry(key.to_string()).or_insert((burst, now));
        let refill = now.duration_since(*at).as_secs_f64() / self.every.as_secs_f64();
        *tokens = (*tokens + refill).min(burst);
        *at = now;
        match *tokens >= cost {
            true => {
                *tokens -= cost;
                true
            }
            false => false,
        }
    }
}

pub const VOICE_BURST: u32 = 5;
pub const VOICE_EVERY: Duration = Duration::from_millis(250);
pub const CALL_BURST: u32 = 5;
pub const CALL_EVERY: Duration = Duration::from_secs(3);
pub const DM_CALL_BURST: u32 = 3;
pub const DM_CALL_EVERY: Duration = Duration::from_secs(10);
pub const SIGNAL_BURST: usize = 512 * 1024;
pub const SIGNAL_BYTES_PER_SEC: u32 = 64 * 1024;
pub const ACCEPT_BURST: u32 = 5;
pub const ACCEPT_EVERY: Duration = Duration::from_secs(3);
pub const TYPING_USER_BURST: u32 = 8;
pub const TYPING_USER_EVERY: Duration = Duration::from_millis(500);

/// Per-account pacing of realtime commands, across all of a user's connections on this
/// instance.
pub(super) struct Pacing {
    pub(super) voice: Pacer,
    pub(super) calls: Pacer,
    pub(super) dm_calls: Pacer,
    pub(super) accepts: Pacer,
    pub(super) signals: Pacer,
    pub(super) typing: Pacer,
}

/// Signalling bytes one account may send at once: at least enough to negotiate with a full voice
/// room twice (joining, then turning on a camera or screen share). Rooms without a limit get the
/// budget of a default-sized room.
pub(super) fn signal_burst_for(room_max: usize) -> usize {
    let room = match room_max {
        0 => crate::ws::VOICE_ROOM_MAX,
        n => n,
    };
    SIGNAL_BURST.max(2 * room * crate::ws::SIGNAL_MAX)
}

impl Default for Pacing {
    fn default() -> Pacing {
        Pacing {
            voice: Pacer::new(f64::from(VOICE_BURST), VOICE_EVERY),
            calls: Pacer::new(f64::from(CALL_BURST), CALL_EVERY),
            dm_calls: Pacer::new(f64::from(DM_CALL_BURST), DM_CALL_EVERY),
            accepts: Pacer::new(f64::from(ACCEPT_BURST), ACCEPT_EVERY),
            signals: Pacer::new(
                signal_burst_for(Limits::default().voice_room_max) as f64,
                Duration::from_secs(1) / SIGNAL_BYTES_PER_SEC,
            ),
            typing: Pacer::new(f64::from(TYPING_USER_BURST), TYPING_USER_EVERY),
        }
    }
}

/// A realtime socket counted against its client address until dropped.
pub struct AddrSlot {
    pub(super) hub: Hub,
    pub(super) addr: IpAddr,
    pub(super) guest: bool,
}

impl AddrSlot {
    /// Counts this socket as a guest too: false past the guests' share of the address or past
    /// the guest sockets of the whole instance.
    pub fn guest(&mut self) -> bool {
        if self.guest {
            return true;
        }
        let limits = self.hub.limits();
        let mut addrs = self.hub.inner.addrs.lock().unwrap();
        let entry = addrs.entry(self.addr).or_insert((1, 0));
        let total = &self.hub.inner.guests;
        if entry.1 >= limits.guests_per_ip || total.load(Ordering::Relaxed) >= limits.guests_max {
            return false;
        }
        total.fetch_add(1, Ordering::Relaxed);
        entry.1 += 1;
        self.guest = true;
        true
    }
}

impl Drop for AddrSlot {
    fn drop(&mut self) {
        let mut addrs = self.hub.inner.addrs.lock().unwrap();
        if let Some((all, guests)) = addrs.get_mut(&self.addr) {
            *all = all.saturating_sub(1);
            if self.guest {
                *guests = guests.saturating_sub(1);
                let _ =
                    self.hub
                        .inner
                        .guests
                        .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1));
            }
            if *all == 0 {
                addrs.remove(&self.addr);
            }
        }
    }
}

pub(super) fn take_token(
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
