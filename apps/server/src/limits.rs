use serde::Deserialize;

use crate::api::media::{DEFAULT_BUDGET_MIB, DEFAULT_BUFFER_MIB};
use crate::bus::DEFAULT_HUB_MAXLEN;
use crate::hub::{
    CONNECT_BURST, CONNECTS_PER_MINUTE, CONNS_PER_USER, GUESTS_MAX, GUESTS_PER_IP, SOCKETS_PER_IP,
};
use crate::relay::{DEFAULT_TOTAL_KIB_PER_SEC, DEFAULT_USER_ALLOCATIONS, DEFAULT_USER_KIB_PER_SEC};

const MIN_HUB_MAXLEN: u64 = 1_000;

/// The operator's instance limits, one field per env name (the name lowercased).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(default)]
pub struct Limits {
    pub rate_limit_per_second: u64,
    pub rate_limit_burst: u32,
    pub ws_connections_per_user: usize,
    pub ws_connect_burst: u32,
    pub ws_connects_per_minute: u32,
    pub ws_sockets_per_ip: usize,
    pub ws_guest_sockets_per_ip: usize,
    pub ws_guest_sockets_max: usize,
    pub redis_hub_maxlen: u64,
    #[serde(skip)]
    pub database_max_connections: Option<u32>,
    #[serde(skip)]
    pub database_min_connections: Option<u32>,
    #[serde(skip)]
    pub database_acquire_timeout_secs: Option<u64>,
    #[serde(skip)]
    pub database_read_connections: Option<u32>,
    pub upload_budget_mib: u64,
    pub upload_buffer_mib: u64,
    #[serde(skip)]
    pub guest_grant_days: i64,
    #[serde(skip)]
    pub embed_cache_days: i64,
    #[serde(skip)]
    pub voice_idle_secs: i64,
    #[serde(skip)]
    pub voice_room_max: usize,
    pub relay_user_allocations: u32,
    pub relay_max_allocations: Option<u32>,
    pub relay_user_kib_per_sec: u64,
    pub relay_max_kib_per_sec: u64,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            rate_limit_per_second: 10,
            rate_limit_burst: 60,
            ws_connections_per_user: CONNS_PER_USER,
            ws_connect_burst: CONNECT_BURST,
            ws_connects_per_minute: CONNECTS_PER_MINUTE,
            ws_sockets_per_ip: SOCKETS_PER_IP,
            ws_guest_sockets_per_ip: GUESTS_PER_IP,
            ws_guest_sockets_max: GUESTS_MAX,
            redis_hub_maxlen: DEFAULT_HUB_MAXLEN,
            database_max_connections: None,
            database_min_connections: None,
            database_acquire_timeout_secs: None,
            database_read_connections: None,
            upload_budget_mib: DEFAULT_BUDGET_MIB,
            upload_buffer_mib: DEFAULT_BUFFER_MIB,
            guest_grant_days: 30,
            embed_cache_days: 30,
            voice_idle_secs: 60,
            voice_room_max: crate::ws::VOICE_ROOM_MAX,
            relay_user_allocations: DEFAULT_USER_ALLOCATIONS as u32,
            relay_max_allocations: None,
            relay_user_kib_per_sec: DEFAULT_USER_KIB_PER_SEC,
            relay_max_kib_per_sec: DEFAULT_TOTAL_KIB_PER_SEC,
        }
    }
}

impl Limits {
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.ws_connections_per_user == 0
            || self.ws_connect_burst == 0
            || self.ws_connects_per_minute == 0
            || self.ws_sockets_per_ip == 0
        {
            anyhow::bail!(
                "WS_CONNECTIONS_PER_USER, WS_CONNECT_BURST, WS_CONNECTS_PER_MINUTE and WS_SOCKETS_PER_IP must be at least 1"
            );
        }
        if self.redis_hub_maxlen < MIN_HUB_MAXLEN {
            anyhow::bail!("REDIS_HUB_MAXLEN must be at least {MIN_HUB_MAXLEN}");
        }
        if self.upload_buffer_mib < 32 {
            anyhow::bail!("UPLOAD_BUFFER_MIB must be at least 32");
        }
        Ok(())
    }

    /// The realtime limits the hub enforces.
    pub fn ws_limits(&self) -> crate::hub::Limits {
        crate::hub::Limits {
            conns_per_user: self.ws_connections_per_user,
            connect_burst: self.ws_connect_burst,
            connect_every: std::time::Duration::from_secs(60) / self.ws_connects_per_minute,
            sockets_per_ip: self.ws_sockets_per_ip,
            guests_per_ip: self.ws_guest_sockets_per_ip,
            guests_max: self.ws_guest_sockets_max,
            voice_room_max: self.voice_room_max,
        }
    }

    /// Seconds an unused guest grant lives (`GUEST_GRANT_DAYS`, at least one day).
    pub fn guest_grant_ttl(&self) -> i64 {
        self.guest_grant_days.max(1) * 86400
    }

    /// Seconds an unreferenced link preview is cached (`EMBED_CACHE_DAYS`, at least one day).
    pub fn embed_cache_ttl(&self) -> i64 {
        self.embed_cache_days.max(1) * 86400
    }
}
