use crate::api::media::{DEFAULT_BUDGET_MIB, DEFAULT_BUFFER_MIB};
use crate::bus::DEFAULT_HUB_MAXLEN;
use crate::hub::{
    CONNECT_BURST, CONNECTS_PER_MINUTE, CONNS_PER_USER, GUESTS_MAX, GUESTS_PER_IP, SOCKETS_PER_IP,
};
use crate::relay::{DEFAULT_TOTAL_KIB_PER_SEC, DEFAULT_USER_ALLOCATIONS, DEFAULT_USER_KIB_PER_SEC};

const MIB: usize = 1024 * 1024;

/// Every numeric limit: its env name, smallest and largest value.
const RANGES: [(&str, i64, i64); 42] = [
    ("RATE_LIMIT_PER_SECOND", 1, 1_000),
    ("RATE_LIMIT_BURST", 1, 1_000_000),
    ("WS_CONNECTIONS_PER_USER", 1, 10_000),
    ("WS_CONNECT_BURST", 1, 10_000),
    ("WS_CONNECTS_PER_MINUTE", 1, 60_000),
    ("WS_SOCKETS_PER_IP", 1, 1_000_000),
    ("WS_GUEST_SOCKETS_PER_IP", 0, 1_000_000),
    ("WS_GUEST_SOCKETS_MAX", 0, 1_000_000),
    ("REDIS_HUB_MAXLEN", 1_000, 100_000_000),
    ("DATABASE_MAX_CONNECTIONS", 1, 1_000),
    ("DATABASE_MIN_CONNECTIONS", 0, 1_000),
    ("DATABASE_ACQUIRE_TIMEOUT_SECS", 1, 3_600),
    ("DATABASE_READ_CONNECTIONS", 0, 64),
    ("UPLOAD_MAX_MIB", 1, 512),
    ("UPLOAD_BUDGET_MIB", 0, 1_048_576),
    ("UPLOAD_BUFFER_MIB", 32, 1_048_576),
    ("UPLOAD_SERVER_KEPT_MIB", 0, 1_048_576),
    ("UPLOAD_OWNER_KEPT_MIB", 0, 1_048_576),
    ("MESSAGE_MAX_CHARS", 1, 100_000),
    ("GUEST_GRANT_DAYS", 1, 3_650),
    ("EMBED_CACHE_DAYS", 1, 3_650),
    ("VOICE_IDLE_SECS", 5, 86_400),
    ("VOICE_ROOM_MAX", 0, 10_000),
    ("RELAY_USER_ALLOCATIONS", 1, 65_535),
    ("RELAY_MAX_ALLOCATIONS", 1, 65_535),
    ("RELAY_USER_KIB_PER_SEC", 1, 10_485_760),
    ("RELAY_MAX_KIB_PER_SEC", 1, 10_485_760),
    ("REPORT_SAME_TARGET_HOURS", 0, 8_760),
    ("REPORT_TARGETS_PER_DAY", 0, 10_000),
    ("REPORT_MAX_PER_WEEK", 0, 100_000),
    ("REPORT_RETENTION_DAYS", 0, 3_650),
    ("E2EE_GUESTS_PER_GROUP", 0, 5_000),
    ("E2EE_KEY_RETENTION_DAYS", 1, 69),
    ("SFU_MAX_PARTICIPANTS", 2, 10_000),
    ("SFU_MAX_STREAMS", 1, 1_000_000),
    ("SFU_USER_KIB_PER_SEC", 1, 1_048_576),
    ("P2P_BACKUP_MAX_MIB", 0, 512),
    ("WIDGET_QUICK_JOINS_PER_HOUR", 1, 10_000),
    ("WIDGET_VIEWERS_MAX", 0, 1_000_000),
    ("WIDGET_BRIDGE_SERVERS_MAX", 1, 10_000),
    ("PEERJS_PEERS_PER_IP", 0, 1_000_000),
    ("PEERJS_CONCURRENT_LIMIT", 1, 1_000_000),
];

/// The operator's instance limits, one field per env name (the name lowercased).
#[derive(Clone, Debug, PartialEq)]
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
    pub database_max_connections: Option<u32>,
    pub database_min_connections: Option<u32>,
    pub database_acquire_timeout_secs: Option<u64>,
    pub database_read_connections: Option<u32>,
    pub upload_max_mib: u64,
    pub upload_budget_mib: u64,
    pub upload_buffer_mib: u64,
    pub upload_server_kept_mib: u64,
    pub upload_owner_kept_mib: u64,
    pub message_max_chars: usize,
    pub guest_grant_days: i64,
    pub embed_cache_days: i64,
    pub voice_idle_secs: i64,
    pub voice_room_max: usize,
    pub relay_user_allocations: u32,
    pub relay_max_allocations: Option<u32>,
    pub relay_user_kib_per_sec: u64,
    pub relay_max_kib_per_sec: u64,
    pub report_same_target_hours: u32,
    pub report_targets_per_day: u32,
    pub report_max_per_week: u32,
    pub report_retention_days: u32,
    pub e2ee_guests_per_group: u32,
    pub e2ee_key_retention_days: u32,
    pub sfu_enabled: bool,
    pub sfu_max_participants: u32,
    pub sfu_max_streams: u32,
    pub sfu_user_kib_per_sec: u32,
    pub p2p_backup_max_mib: u32,
    pub widget_quick_joins_per_hour: u32,
    pub widget_viewers_max: u32,
    pub widget_bridge_servers_max: u32,
    pub peerjs_builtin: bool,
    pub peerjs_peers_per_ip: usize,
    pub peerjs_concurrent_limit: usize,
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
            upload_max_mib: 25,
            upload_budget_mib: DEFAULT_BUDGET_MIB,
            upload_buffer_mib: DEFAULT_BUFFER_MIB,
            upload_server_kept_mib: 8192,
            upload_owner_kept_mib: 16384,
            message_max_chars: 4000,
            guest_grant_days: 30,
            embed_cache_days: 30,
            voice_idle_secs: 60,
            voice_room_max: crate::ws::VOICE_ROOM_MAX,
            relay_user_allocations: DEFAULT_USER_ALLOCATIONS as u32,
            relay_max_allocations: None,
            relay_user_kib_per_sec: DEFAULT_USER_KIB_PER_SEC,
            relay_max_kib_per_sec: DEFAULT_TOTAL_KIB_PER_SEC,
            report_same_target_hours: 72,
            report_targets_per_day: 3,
            report_max_per_week: 10,
            report_retention_days: 180,
            e2ee_guests_per_group: 500,
            e2ee_key_retention_days: 30,
            sfu_enabled: false,
            sfu_max_participants: 100,
            sfu_max_streams: 2000,
            sfu_user_kib_per_sec: 4096,
            p2p_backup_max_mib: 64,
            widget_quick_joins_per_hour: 10,
            widget_viewers_max: 5000,
            widget_bridge_servers_max: 50,
            peerjs_builtin: true,
            peerjs_peers_per_ip: crate::peerjs::DEFAULT_PEERS_PER_IP,
            peerjs_concurrent_limit: crate::peerjs::DEFAULT_CONCURRENT_LIMIT,
        }
    }
}

/// The values the operator set, by env name. Blank values count as unset.
pub(crate) struct Env<'a>(pub(crate) &'a dyn Fn(&str) -> Option<String>);

impl Env<'_> {
    pub(crate) fn raw(&self, name: &str) -> Option<String> {
        (self.0)(name)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }

    fn opt<T: TryFrom<i64>>(&self, name: &str) -> anyhow::Result<Option<T>> {
        let Some((_, lo, hi)) = RANGES.iter().find(|(n, _, _)| *n == name) else {
            anyhow::bail!("{name} has no range");
        };
        let Some(raw) = self.raw(name) else {
            return Ok(None);
        };
        raw.parse::<i64>()
            .ok()
            .filter(|v| (lo..=hi).contains(&v))
            .and_then(|v| T::try_from(v).ok())
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("{name}: expected {lo} to {hi}, got {raw}"))
    }

    fn num<T: TryFrom<i64>>(&self, name: &str, default: T) -> anyhow::Result<T> {
        Ok(self.opt(name)?.unwrap_or(default))
    }

    pub(crate) fn switch(&self, name: &str, default: bool) -> anyhow::Result<bool> {
        let Some(raw) = self.raw(name) else {
            return Ok(default);
        };
        match raw.to_ascii_lowercase().as_str() {
            "on" | "true" | "yes" | "1" => Ok(true),
            "off" | "false" | "no" | "0" => Ok(false),
            _ => anyhow::bail!("{name}: expected on or off, got {raw}"),
        }
    }
}

impl Limits {
    /// Every limit from `env` (the value of an env name, if set). A value that is not a number
    /// in its range, or not on or off, is an error naming the variable and the range.
    pub fn load(env: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<Limits> {
        let d = Limits::default();
        let e = Env(env);
        let limits = Limits {
            rate_limit_per_second: e.num("RATE_LIMIT_PER_SECOND", d.rate_limit_per_second)?,
            rate_limit_burst: e.num("RATE_LIMIT_BURST", d.rate_limit_burst)?,
            ws_connections_per_user: e.num("WS_CONNECTIONS_PER_USER", d.ws_connections_per_user)?,
            ws_connect_burst: e.num("WS_CONNECT_BURST", d.ws_connect_burst)?,
            ws_connects_per_minute: e.num("WS_CONNECTS_PER_MINUTE", d.ws_connects_per_minute)?,
            ws_sockets_per_ip: e.num("WS_SOCKETS_PER_IP", d.ws_sockets_per_ip)?,
            ws_guest_sockets_per_ip: e.num("WS_GUEST_SOCKETS_PER_IP", d.ws_guest_sockets_per_ip)?,
            ws_guest_sockets_max: e.num("WS_GUEST_SOCKETS_MAX", d.ws_guest_sockets_max)?,
            redis_hub_maxlen: e.num("REDIS_HUB_MAXLEN", d.redis_hub_maxlen)?,
            database_max_connections: e.opt("DATABASE_MAX_CONNECTIONS")?,
            database_min_connections: e.opt("DATABASE_MIN_CONNECTIONS")?,
            database_acquire_timeout_secs: e.opt("DATABASE_ACQUIRE_TIMEOUT_SECS")?,
            database_read_connections: e.opt("DATABASE_READ_CONNECTIONS")?,
            upload_max_mib: e.num("UPLOAD_MAX_MIB", d.upload_max_mib)?,
            upload_budget_mib: e.num("UPLOAD_BUDGET_MIB", d.upload_budget_mib)?,
            upload_buffer_mib: e.num("UPLOAD_BUFFER_MIB", d.upload_buffer_mib)?,
            upload_server_kept_mib: e.num("UPLOAD_SERVER_KEPT_MIB", d.upload_server_kept_mib)?,
            upload_owner_kept_mib: e.num("UPLOAD_OWNER_KEPT_MIB", d.upload_owner_kept_mib)?,
            message_max_chars: e.num("MESSAGE_MAX_CHARS", d.message_max_chars)?,
            guest_grant_days: e.num("GUEST_GRANT_DAYS", d.guest_grant_days)?,
            embed_cache_days: e.num("EMBED_CACHE_DAYS", d.embed_cache_days)?,
            voice_idle_secs: e.num("VOICE_IDLE_SECS", d.voice_idle_secs)?,
            voice_room_max: e.num("VOICE_ROOM_MAX", d.voice_room_max)?,
            relay_user_allocations: e.num("RELAY_USER_ALLOCATIONS", d.relay_user_allocations)?,
            relay_max_allocations: e.opt("RELAY_MAX_ALLOCATIONS")?,
            relay_user_kib_per_sec: e.num("RELAY_USER_KIB_PER_SEC", d.relay_user_kib_per_sec)?,
            relay_max_kib_per_sec: e.num("RELAY_MAX_KIB_PER_SEC", d.relay_max_kib_per_sec)?,
            report_same_target_hours: e
                .num("REPORT_SAME_TARGET_HOURS", d.report_same_target_hours)?,
            report_targets_per_day: e.num("REPORT_TARGETS_PER_DAY", d.report_targets_per_day)?,
            report_max_per_week: e.num("REPORT_MAX_PER_WEEK", d.report_max_per_week)?,
            report_retention_days: e.num("REPORT_RETENTION_DAYS", d.report_retention_days)?,
            e2ee_guests_per_group: e.num("E2EE_GUESTS_PER_GROUP", d.e2ee_guests_per_group)?,
            e2ee_key_retention_days: e.num("E2EE_KEY_RETENTION_DAYS", d.e2ee_key_retention_days)?,
            sfu_enabled: e.switch("SFU_ENABLED", d.sfu_enabled)?,
            sfu_max_participants: e.num("SFU_MAX_PARTICIPANTS", d.sfu_max_participants)?,
            sfu_max_streams: e.num("SFU_MAX_STREAMS", d.sfu_max_streams)?,
            sfu_user_kib_per_sec: e.num("SFU_USER_KIB_PER_SEC", d.sfu_user_kib_per_sec)?,
            p2p_backup_max_mib: e.num("P2P_BACKUP_MAX_MIB", d.p2p_backup_max_mib)?,
            widget_quick_joins_per_hour: e
                .num("WIDGET_QUICK_JOINS_PER_HOUR", d.widget_quick_joins_per_hour)?,
            widget_viewers_max: e.num("WIDGET_VIEWERS_MAX", d.widget_viewers_max)?,
            widget_bridge_servers_max: e
                .num("WIDGET_BRIDGE_SERVERS_MAX", d.widget_bridge_servers_max)?,
            peerjs_builtin: e.switch("PEERJS_BUILTIN", d.peerjs_builtin)?,
            peerjs_peers_per_ip: e.num("PEERJS_PEERS_PER_IP", d.peerjs_peers_per_ip)?,
            peerjs_concurrent_limit: e.num("PEERJS_CONCURRENT_LIMIT", d.peerjs_concurrent_limit)?,
        };
        limits.validate()?;
        Ok(limits)
    }

    /// Every numeric limit by env name, in the order of `RANGES`. `None`: unset, and the
    /// process picks its own value.
    pub fn rows(&self) -> Vec<(&'static str, Option<i64>)> {
        let Limits {
            rate_limit_per_second,
            rate_limit_burst,
            ws_connections_per_user,
            ws_connect_burst,
            ws_connects_per_minute,
            ws_sockets_per_ip,
            ws_guest_sockets_per_ip,
            ws_guest_sockets_max,
            redis_hub_maxlen,
            database_max_connections,
            database_min_connections,
            database_acquire_timeout_secs,
            database_read_connections,
            upload_max_mib,
            upload_budget_mib,
            upload_buffer_mib,
            upload_server_kept_mib,
            upload_owner_kept_mib,
            message_max_chars,
            guest_grant_days,
            embed_cache_days,
            voice_idle_secs,
            voice_room_max,
            relay_user_allocations,
            relay_max_allocations,
            relay_user_kib_per_sec,
            relay_max_kib_per_sec,
            report_same_target_hours,
            report_targets_per_day,
            report_max_per_week,
            report_retention_days,
            e2ee_guests_per_group,
            e2ee_key_retention_days,
            sfu_enabled: _,
            sfu_max_participants,
            sfu_max_streams,
            sfu_user_kib_per_sec,
            p2p_backup_max_mib,
            widget_quick_joins_per_hour,
            widget_viewers_max,
            widget_bridge_servers_max,
            peerjs_builtin: _,
            peerjs_peers_per_ip,
            peerjs_concurrent_limit,
        } = *self;
        fn set<T: TryInto<i64>>(value: T) -> Option<i64> {
            value.try_into().ok()
        }
        fn opt<T: TryInto<i64>>(value: Option<T>) -> Option<i64> {
            value.and_then(set)
        }
        vec![
            ("RATE_LIMIT_PER_SECOND", set(rate_limit_per_second)),
            ("RATE_LIMIT_BURST", set(rate_limit_burst)),
            ("WS_CONNECTIONS_PER_USER", set(ws_connections_per_user)),
            ("WS_CONNECT_BURST", set(ws_connect_burst)),
            ("WS_CONNECTS_PER_MINUTE", set(ws_connects_per_minute)),
            ("WS_SOCKETS_PER_IP", set(ws_sockets_per_ip)),
            ("WS_GUEST_SOCKETS_PER_IP", set(ws_guest_sockets_per_ip)),
            ("WS_GUEST_SOCKETS_MAX", set(ws_guest_sockets_max)),
            ("REDIS_HUB_MAXLEN", set(redis_hub_maxlen)),
            ("DATABASE_MAX_CONNECTIONS", opt(database_max_connections)),
            ("DATABASE_MIN_CONNECTIONS", opt(database_min_connections)),
            (
                "DATABASE_ACQUIRE_TIMEOUT_SECS",
                opt(database_acquire_timeout_secs),
            ),
            ("DATABASE_READ_CONNECTIONS", opt(database_read_connections)),
            ("UPLOAD_MAX_MIB", set(upload_max_mib)),
            ("UPLOAD_BUDGET_MIB", set(upload_budget_mib)),
            ("UPLOAD_BUFFER_MIB", set(upload_buffer_mib)),
            ("UPLOAD_SERVER_KEPT_MIB", set(upload_server_kept_mib)),
            ("UPLOAD_OWNER_KEPT_MIB", set(upload_owner_kept_mib)),
            ("MESSAGE_MAX_CHARS", set(message_max_chars)),
            ("GUEST_GRANT_DAYS", set(guest_grant_days)),
            ("EMBED_CACHE_DAYS", set(embed_cache_days)),
            ("VOICE_IDLE_SECS", set(voice_idle_secs)),
            ("VOICE_ROOM_MAX", set(voice_room_max)),
            ("RELAY_USER_ALLOCATIONS", set(relay_user_allocations)),
            ("RELAY_MAX_ALLOCATIONS", opt(relay_max_allocations)),
            ("RELAY_USER_KIB_PER_SEC", set(relay_user_kib_per_sec)),
            ("RELAY_MAX_KIB_PER_SEC", set(relay_max_kib_per_sec)),
            ("REPORT_SAME_TARGET_HOURS", set(report_same_target_hours)),
            ("REPORT_TARGETS_PER_DAY", set(report_targets_per_day)),
            ("REPORT_MAX_PER_WEEK", set(report_max_per_week)),
            ("REPORT_RETENTION_DAYS", set(report_retention_days)),
            ("E2EE_GUESTS_PER_GROUP", set(e2ee_guests_per_group)),
            ("E2EE_KEY_RETENTION_DAYS", set(e2ee_key_retention_days)),
            ("SFU_MAX_PARTICIPANTS", set(sfu_max_participants)),
            ("SFU_MAX_STREAMS", set(sfu_max_streams)),
            ("SFU_USER_KIB_PER_SEC", set(sfu_user_kib_per_sec)),
            ("P2P_BACKUP_MAX_MIB", set(p2p_backup_max_mib)),
            (
                "WIDGET_QUICK_JOINS_PER_HOUR",
                set(widget_quick_joins_per_hour),
            ),
            ("WIDGET_VIEWERS_MAX", set(widget_viewers_max)),
            ("WIDGET_BRIDGE_SERVERS_MAX", set(widget_bridge_servers_max)),
            ("PEERJS_PEERS_PER_IP", set(peerjs_peers_per_ip)),
            ("PEERJS_CONCURRENT_LIMIT", set(peerjs_concurrent_limit)),
        ]
    }

    /// The smallest and largest value of the numeric limit `env`.
    pub fn range(env: &str) -> Option<(i64, i64)> {
        RANGES
            .iter()
            .find(|(name, _, _)| *name == env)
            .map(|(_, lo, hi)| (*lo, *hi))
    }

    /// The checks between limits.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.upload_buffer_mib < self.upload_max_mib {
            anyhow::bail!(
                "UPLOAD_BUFFER_MIB: expected at least UPLOAD_MAX_MIB ({}), got {}",
                self.upload_max_mib,
                self.upload_buffer_mib
            );
        }
        Ok(())
    }

    /// The warning to log at start when `UPLOAD_BUFFER_MIB` is under twice `UPLOAD_MAX_MIB`.
    pub fn upload_buffer_warning(&self) -> Option<String> {
        let twice = self.upload_max_mib.saturating_mul(2);
        match self.upload_buffer_mib < twice {
            true => Some(format!(
                "UPLOAD_BUFFER_MIB is {}, under twice UPLOAD_MAX_MIB: one upload can hold most of it while others wait. Set it to at least {twice}.",
                self.upload_buffer_mib
            )),
            false => None,
        }
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

    /// The largest upload in bytes (`UPLOAD_MAX_MIB`).
    pub fn upload_bytes(&self) -> usize {
        self.upload_max_mib as usize * MIB
    }

    /// The largest request body that carries an upload: the upload and 1 MiB for the rest.
    pub fn upload_body_bytes(&self) -> usize {
        self.upload_bytes() + MIB
    }

    /// Most bytes of files one server keeps longer than the instance default
    /// (`UPLOAD_SERVER_KEPT_MIB`); 0 for no limit.
    pub fn upload_server_kept_bytes(&self) -> i64 {
        self.upload_server_kept_mib
            .saturating_mul(MIB as u64)
            .min(i64::MAX as u64) as i64
    }

    /// Most bytes of files kept longer than the instance default across the servers whose file
    /// expiry one account set (`UPLOAD_OWNER_KEPT_MIB`); 0 for no limit.
    pub fn upload_owner_kept_bytes(&self) -> i64 {
        self.upload_owner_kept_mib
            .saturating_mul(MIB as u64)
            .min(i64::MAX as u64) as i64
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

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use super::{Limits, RANGES};

    fn load(pairs: &[(&str, String)]) -> anyhow::Result<Limits> {
        let set: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Limits::load(&|name| set.get(name).cloned())
    }

    /// The env names `Limits::load` reads, in order.
    fn names() -> Vec<String> {
        let asked = RefCell::new(Vec::new());
        Limits::load(&|name| {
            asked.borrow_mut().push(name.to_string());
            None
        })
        .expect("defaults");
        asked.into_inner()
    }

    #[test]
    fn every_range_loads_at_its_edges_and_refuses_past_them() {
        let read = names();
        for (name, lo, hi) in RANGES {
            assert!(read.iter().any(|n| n == name), "{name} is read");
            let with = |v: i64| {
                let mut pairs = vec![(name, v.to_string())];
                match name {
                    "UPLOAD_MAX_MIB" => pairs.push(("UPLOAD_BUFFER_MIB", "1048576".to_string())),
                    "UPLOAD_BUFFER_MIB" => pairs.push(("UPLOAD_MAX_MIB", "1".to_string())),
                    _ => {}
                }
                load(&pairs)
            };
            for edge in [lo, hi] {
                assert!(with(edge).is_ok(), "{name}={edge}");
            }
            for past in [lo - 1, hi + 1] {
                let err = with(past).unwrap_err().to_string();
                assert_eq!(err, format!("{name}: expected {lo} to {hi}, got {past}"));
            }
        }
        for name in read {
            let numeric = RANGES.iter().any(|(n, _, _)| *n == name);
            let default = load(&[]).expect("defaults");
            match numeric {
                true => {
                    let err = load(&[(&name, "1.5".to_string())]).unwrap_err();
                    assert!(err.to_string().starts_with(&format!("{name}: expected ")));
                }
                false => {
                    let on = load(&[(&name, " On ".to_string())]).expect("on");
                    let off = load(&[(&name, "FALSE".to_string())]).expect("off");
                    assert_ne!(on, off, "{name}");
                    assert!(on == default || off == default, "{name}");
                    for (word, same) in [("true", &on), ("yes", &on), ("1", &on)]
                        .into_iter()
                        .chain([("off", &off), ("no", &off), ("0", &off)])
                    {
                        assert_eq!(&load(&[(&name, word.to_string())]).expect(word), same);
                    }
                    let err = load(&[(&name, "maybe".to_string())]).unwrap_err();
                    assert_eq!(
                        err.to_string(),
                        format!("{name}: expected on or off, got maybe")
                    );
                }
            }
            assert_eq!(load(&[(&name, "  ".to_string())]).expect("blank"), default);
        }
    }

    #[test]
    fn every_ranged_limit_is_listed_with_its_value() {
        let default = Limits::default().rows();
        let names: Vec<&str> = default.iter().map(|(name, _)| *name).collect();
        let ranged: Vec<&str> = RANGES.iter().map(|(name, _, _)| *name).collect();
        assert_eq!(names, ranged);
        let unset: Vec<&str> = default
            .iter()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(
            unset,
            [
                "DATABASE_MAX_CONNECTIONS",
                "DATABASE_MIN_CONNECTIONS",
                "DATABASE_ACQUIRE_TIMEOUT_SECS",
                "DATABASE_READ_CONNECTIONS",
                "RELAY_MAX_ALLOCATIONS",
            ]
        );
        for (name, lo, hi) in RANGES {
            let mut pairs = vec![(name, hi.to_string())];
            match name {
                "UPLOAD_MAX_MIB" => pairs.push(("UPLOAD_BUFFER_MIB", "1048576".to_string())),
                "UPLOAD_BUFFER_MIB" => pairs.push(("UPLOAD_MAX_MIB", "1".to_string())),
                _ => {}
            }
            let rows = load(&pairs).expect("loads").rows();
            let value = rows.iter().find(|(n, _)| *n == name).map(|(_, v)| *v);
            assert_eq!(value, Some(Some(hi)), "{name}");
            assert_eq!(Limits::range(name), Some((lo, hi)), "{name}");
        }
        assert_eq!(Limits::range("SFU_ENABLED"), None);
    }

    #[test]
    fn the_server_kept_limit_has_a_default_a_range_and_no_limit_at_0() {
        let d = load(&[]).expect("defaults");
        assert_eq!(d.upload_server_kept_mib, 8192);
        assert_eq!(d.upload_server_kept_bytes(), 8192 * 1024 * 1024);
        let none = load(&[("UPLOAD_SERVER_KEPT_MIB", "0".to_string())]).expect("0");
        assert_eq!(none.upload_server_kept_bytes(), 0);
        let most = load(&[("UPLOAD_SERVER_KEPT_MIB", "1048576".to_string())]).expect("most");
        assert_eq!(most.upload_server_kept_bytes(), 1 << 40);
        for bad in ["-1", "1048577", "8 GiB"] {
            let err = load(&[("UPLOAD_SERVER_KEPT_MIB", bad.to_string())]).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("UPLOAD_SERVER_KEPT_MIB: expected 0 to 1048576, got {bad}")
            );
        }
    }

    #[test]
    fn the_owner_kept_limit_has_a_default_a_range_and_no_limit_at_0() {
        let d = load(&[]).expect("defaults");
        assert_eq!(d.upload_owner_kept_mib, 16384);
        assert_eq!(d.upload_owner_kept_bytes(), 16384 * 1024 * 1024);
        let none = load(&[("UPLOAD_OWNER_KEPT_MIB", "0".to_string())]).expect("0");
        assert_eq!(none.upload_owner_kept_bytes(), 0);
        let most = load(&[("UPLOAD_OWNER_KEPT_MIB", "1048576".to_string())]).expect("most");
        assert_eq!(most.upload_owner_kept_bytes(), 1 << 40);
        for bad in ["-1", "1048577", "16 GiB"] {
            let err = load(&[("UPLOAD_OWNER_KEPT_MIB", bad.to_string())]).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("UPLOAD_OWNER_KEPT_MIB: expected 0 to 1048576, got {bad}")
            );
        }
    }

    #[test]
    fn every_limit_is_documented_with_its_range_and_default() {
        let example = include_str!("../../../.env.local.example");
        let lines: Vec<&str> = example.lines().collect();
        let mut documented = Vec::new();
        for name in names() {
            let key = format!("# {name}=");
            let at = lines
                .iter()
                .position(|l| l.starts_with(&key))
                .unwrap_or_else(|| panic!("{name} is in .env.local.example"));
            let value = lines[at][key.len()..].to_string();
            let about: Vec<&str> = lines[..at]
                .iter()
                .rev()
                .take_while(|l| l.starts_with("# ") && !l.contains('='))
                .copied()
                .collect();
            match RANGES.iter().find(|(n, _, _)| *n == name) {
                Some((_, lo, hi)) => assert!(
                    about.iter().any(|l| l.contains(&format!("{lo} to {hi}"))),
                    "{name}: the comment above it gives {lo} to {hi}"
                ),
                None => assert!(
                    about.iter().any(|l| l.contains("on or off")),
                    "{name}: the comment above it says on or off"
                ),
            }
            documented.push((name, value));
        }
        let pairs: Vec<(&str, String)> = documented
            .iter()
            .map(|(n, v)| (n.as_str(), v.clone()))
            .collect();
        let shown = load(&pairs).expect("the documented values load");
        let unset = |l: Limits| Limits {
            database_max_connections: None,
            database_min_connections: None,
            database_acquire_timeout_secs: None,
            database_read_connections: None,
            relay_max_allocations: None,
            ..l
        };
        assert_eq!(
            unset(shown),
            Limits::default(),
            "the documented values are the defaults"
        );
    }
}
