use std::collections::BTreeMap;

use serde::Deserialize;

use crate::api::media::{DEFAULT_BUDGET_MIB, DEFAULT_BUFFER_MIB};
use crate::bus::DEFAULT_HUB_MAXLEN;
use crate::hub::{
    CONNECT_BURST, CONNECTS_PER_MINUTE, CONNS_PER_USER, GUESTS_MAX, GUESTS_PER_IP, SOCKETS_PER_IP,
};
use crate::relay::{DEFAULT_TOTAL_KIB_PER_SEC, DEFAULT_USER_ALLOCATIONS, DEFAULT_USER_KIB_PER_SEC};

pub mod bucket;
pub mod http;
pub mod shared;

const MIB: usize = 1024 * 1024;

/// Seconds a request waits for a free database connection when the operator sets nothing.
pub const DEFAULT_ACQUIRE_TIMEOUT_SECS: u64 = 10;

/// The shortest idle timeout: sessions are marked used once a minute.
pub const SESSION_IDLE_MIN: i64 = 300;

/// Every numeric limit: its env name, smallest and largest value.
const RANGES: [(&str, i64, i64); 123] = [
    ("RATE_LIMIT_PER_SECOND", 1, 1_000),
    ("RATE_LIMIT_BURST", 1, 1_000_000),
    ("RATE_LIMIT_STRICT_PER_SECOND", 1, 1_000),
    ("RATE_LIMIT_STRICT_BURST", 1, 1_000_000),
    ("RATE_LIMIT_INVITE_PER_SECOND", 1, 1_000),
    ("RATE_LIMIT_INVITE_BURST", 1, 1_000_000),
    ("ARGON2_PERMITS", 0, 1_024),
    ("ARGON2_MEMORY_KIB", 4_096, 1_048_576),
    ("ARGON2_ITERATIONS", 1, 64),
    ("ARGON2_PARALLELISM", 1, 16),
    ("SERVER_PASSWORD_QUEUE_MAX", 1, 100_000),
    ("SERVER_PASSWORD_QUEUE_PER_ADDRESS", 1, 100_000),
    ("SERVER_PASSWORD_QUEUE_PER_NETWORK", 1, 100_000),
    ("WS_CONNECTIONS_PER_USER", 1, 10_000),
    ("WS_CONNECT_BURST", 1, 10_000),
    ("WS_CONNECTS_PER_MINUTE", 1, 60_000),
    ("WS_SOCKETS_PER_IP", 1, 1_000_000),
    ("WS_GUEST_SOCKETS_PER_IP", 0, 1_000_000),
    ("WS_GUEST_SOCKETS_MAX", 0, 1_000_000),
    ("REDIS_HUB_MAXLEN", 1_000, 100_000_000),
    ("DATABASE_MAX_CONNECTIONS", 1, 1_000),
    ("DATABASE_REPLICA_MAX_CONNECTIONS", 1, 1_000),
    ("DATABASE_REPLICA_MAX_LAG_MS", 100, 600_000),
    ("DATABASE_MIN_CONNECTIONS", 0, 1_000),
    ("DATABASE_ACQUIRE_TIMEOUT_SECS", 1, 3_600),
    ("DATABASE_READ_CONNECTIONS", 0, 64),
    ("DATABASE_INDEX_BUILD_MIB", 16, 16_384),
    ("DATABASE_STATEMENT_TIMEOUT_SECS", 0, 3_600),
    ("UPLOAD_MAX_MIB", 1, 512),
    ("UPLOAD_BUDGET_MIB", 0, 1_048_576),
    ("UPLOAD_BUFFER_MIB", 32, 1_048_576),
    ("UPLOAD_SERVER_KEPT_MIB", 0, 1_048_576),
    ("UPLOAD_OWNER_KEPT_MIB", 0, 1_048_576),
    ("MESSAGE_MAX_CHARS", 1, 100_000),
    ("MESSAGE_RATE_PER_MINUTE", 0, 100_000),
    ("MESSAGE_RATE_BURST", 0, 100_000),
    ("GUEST_GRANT_DAYS", 1, 3_650),
    ("GUEST_GRANTS_PER_PASSWORD", 1, 1_000_000),
    ("GUEST_GRANTS_PER_NETWORK", 1, 1_000_000),
    ("GUEST_GRANT_MINTS_PER_NETWORK", 1, 1_000_000),
    ("WEBHOOK_HOOK_BURST", 1, 10_000),
    ("WEBHOOK_CHANNEL_PER_MINUTE", 1, 100_000),
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
    ("REPORT_FEEDBACK_PER_WEEK", 0, 100_000),
    ("REPORT_RETENTION_DAYS", 0, 3_650),
    ("E2EE_GUESTS_PER_GROUP", 0, 5_000),
    ("E2EE_KEY_RETENTION_DAYS", 1, 69),
    ("SFU_MAX_PARTICIPANTS", 2, 10_000),
    ("SFU_MAX_STREAMS", 1, 1_000_000),
    ("SFU_USER_KIB_PER_SEC", 1, 1_048_576),
    ("P2P_BACKUP_MAX_MIB", 0, 512),
    ("P2P_BACKUP_TOTAL_MIB", 0, 1_048_576),
    ("WIDGET_QUICK_JOINS_PER_HOUR", 1, 10_000),
    ("WIDGET_VIEWERS_MAX", 0, 1_000_000),
    ("WIDGET_BRIDGE_SERVERS_MAX", 1, 10_000),
    ("PEERJS_PEERS_PER_IP", 0, 1_000_000),
    ("PEERJS_CONCURRENT_LIMIT", 1, 1_000_000),
    ("LOOKUP_LIST_PER_MINUTE", 10, 10_000),
    ("LOOKUP_TYPEAHEAD_PER_MINUTE", 10, 10_000),
    ("LOOKUP_SEARCH_PER_MINUTE", 1, 1_000),
    ("LOOKUP_PROFILE_PER_MINUTE", 10, 10_000),
    ("LOOKUP_MEMBER_SEARCH_PER_MINUTE", 1, 1_000),
    ("LOOKUP_MISSES_PER_HOUR", 0, 100_000),
    ("MESSAGE_SEARCH_PER_MINUTE", 1, 1_000),
    ("MESSAGE_SEARCH_AT_ONCE", 1, 100),
    ("MESSAGE_SEARCH_CONCURRENT_LIMIT", 1, 1_000),
    ("RARE_REQUESTS_PER_HOUR", 0, 10_000),
    ("RARE_REQUESTS_PER_DAY", 0, 100_000),
    ("SERVER_CHANNELS_MAX", 1, 10_000),
    ("SERVER_CATEGORIES_MAX", 1, 1_000),
    ("SERVER_ROLES_MAX", 1, 10_000),
    ("CHANNEL_PINS_MAX", 1, 1_000),
    ("MESSAGE_USER_MENTIONS_MAX", 1, 400),
    ("MESSAGE_ROLE_MENTIONS_MAX", 1, 1_000),
    ("HERE_RECIPIENTS_MAX", 1, 10_000),
    ("FRIENDS_MAX", 1, 10_000),
    ("FRIEND_REQUESTS_IN_MAX", 1, 10_000),
    ("CHANNEL_WEBHOOKS_MAX", 1, 1_000),
    ("SERVER_WEBHOOKS_MAX", 1, 10_000),
    ("SERVER_OUTGOING_WEBHOOKS_MAX", 1, 1_000),
    ("WEBHOOK_QUEUE_MAX", 1, 1_000_000),
    ("WEBHOOK_WORKERS", 1, 1_024),
    ("WEBHOOK_ATTEMPTS", 1, 100),
    ("WEBHOOK_LOG_DAYS", 1, 3_650),
    ("WEBHOOK_LOG_KEPT", 1, 100_000),
    ("AUDIT_KEEP_DAYS", 1, 36_500),
    ("PING_KEEP_DAYS", 1, 3_650),
    ("PREVIEW_CACHE_MIB", 1, 1_048_576),
    ("PREVIEW_CACHE_ROWS", 1, 10_000_000),
    ("PREVIEW_CACHE_DAYS", 1, 3_650),
    ("EMBED_FETCHES", 1, 1_024),
    ("EMBED_QUEUE", 1, 100_000),
    ("WS_INBOX_FRAMES", 16, 65_536),
    ("WS_OUT_FRAMES", 16, 65_536),
    ("WS_SEND_TIMEOUT_SECS", 1, 600),
    ("WS_READ_BUFFER_KIB", 4, 65_536),
    ("WS_WRITE_BUFFER_KIB", 0, 65_536),
    ("WS_MAX_WRITE_BUFFER_KIB", 0, 1_048_576),
    ("WS_PACED_USERS_MAX", 100, 10_000_000),
    ("WS_CHANNEL_SLOTS", 1_000, 10_000_000),
    ("HUB_AFTERMATH_MAX", 0, 1_000_000),
    ("HUB_SHOWN_MAX", 0, 1_000_000),
    ("RECONNECT_BASE_MS", 100, 60_000),
    ("RECONNECT_CAP_MS", 1_000, 3_600_000),
    ("RECONNECT_FLOOR_MS", 0, 60_000),
    ("RESYNC_JITTER_MS", 0, 600_000),
    ("CATCH_UP_DELAY_MS", 0, 600_000),
    ("SERVERS_PER_ACCOUNT", 0, 1_000_000),
    ("SERVER_MEMBERS_MAX", 0, 100_000_000),
    ("SIGNUPS_PER_NETWORK_PER_DAY", 0, 1_000_000),
    ("SERVERS_PER_NETWORK_PER_DAY", 0, 1_000_000),
    ("WS_SOCKETS_MAX", 0, 10_000_000),
    ("SESSION_MAX_AGE_SECS", 0, 315_360_000),
    ("SESSION_IDLE_SECS", 0, 315_360_000),
];

/// The P2P limits registry, generated from the web app's `p2p/limits.ts`: each device-local name
/// (`section.key`) with its default, smallest and largest value.
const P2P_REGISTRY: &str = include_str!("../../../assets/p2p_limits.json");

#[derive(Deserialize)]
struct P2pRegistry {
    local: BTreeMap<String, [f64; 3]>,
    #[serde(default)]
    agreed: BTreeMap<String, [f64; 3]>,
    #[serde(default)]
    refresh: Vec<P2pRefresh>,
}

/// A refresh and the expiry it renews, as registry names: `times` refreshes, each the sum of the
/// intervals in `refresh`, fit in the expiry, and with `below` end before it.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct P2pRefresh {
    pub refresh: Vec<String>,
    pub expiry: String,
    pub times: u32,
    #[serde(default)]
    pub below: bool,
}

/// What a `P2P_LIMITS` name takes: its default, smallest and largest value, and whole numbers
/// only when its default and both ends are whole (a count, a size or a time, not a share).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct P2pRange {
    pub default: f64,
    pub lo: f64,
    pub hi: f64,
    pub whole: bool,
}

/// Every `P2P_LIMITS` name (`local.<section>.<key>`, and `agreed.<key>` where the registry has
/// an `agreed` part) with what it takes.
pub fn p2p_ranges() -> anyhow::Result<BTreeMap<String, P2pRange>> {
    let P2pRegistry {
        local,
        agreed,
        refresh: _,
    } = serde_json::from_str(P2P_REGISTRY)?;
    let named = |part: &'static str, of: BTreeMap<String, [f64; 3]>| {
        of.into_iter().map(move |(name, [default, lo, hi])| {
            let whole = [default, lo, hi].iter().all(|v| v.fract() == 0.0);
            let range = P2pRange {
                default,
                lo,
                hi,
                whole,
            };
            (format!("{part}.{name}"), range)
        })
    };
    Ok(named("local", local)
        .chain(named("agreed", agreed))
        .collect())
}

/// Each refresh with the expiry it renews, as `P2P_LIMITS` names.
pub fn p2p_refresh() -> anyhow::Result<Vec<P2pRefresh>> {
    let P2pRegistry {
        local: _,
        agreed: _,
        refresh,
    } = serde_json::from_str(P2P_REGISTRY)?;
    let named = |name: String| format!("local.{name}");
    Ok(refresh
        .into_iter()
        .map(
            |P2pRefresh {
                 refresh,
                 expiry,
                 times,
                 below,
             }| P2pRefresh {
                refresh: refresh.into_iter().map(named).collect(),
                expiry: named(expiry),
                times,
                below,
            },
        )
        .collect())
}

/// `text` in printable ASCII: every other character as its JSON `\u` escapes.
fn ascii(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            ' '..='~' => out.push(c),
            _ => {
                for unit in c.encode_utf16(&mut [0; 2]) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out
}

/// The operator's instance limits, one field per env name (the name lowercased).
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    pub rate_limit_per_second: u64,
    pub rate_limit_burst: u32,
    pub rate_limit_strict_per_second: u64,
    pub rate_limit_strict_burst: u32,
    pub rate_limit_invite_per_second: u64,
    pub rate_limit_invite_burst: u32,
    pub argon2_permits: u32,
    pub argon2_memory_kib: u32,
    pub argon2_iterations: u32,
    pub argon2_parallelism: u32,
    pub server_password_queue_max: usize,
    pub server_password_queue_per_address: usize,
    pub server_password_queue_per_network: usize,
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
    pub database_index_build_mib: u32,
    pub database_statement_timeout_secs: u64,
    pub database_replica_max_connections: u32,
    pub database_replica_max_lag_ms: u64,
    pub upload_max_mib: u64,
    pub upload_budget_mib: u64,
    pub upload_buffer_mib: u64,
    pub upload_server_kept_mib: u64,
    pub upload_owner_kept_mib: u64,
    pub message_max_chars: usize,
    pub message_rate_per_minute: u32,
    pub message_rate_burst: u32,
    pub guest_grant_days: i64,
    pub guest_grants_per_password: u32,
    pub guest_grants_per_network: u32,
    pub guest_grant_mints_per_network: u32,
    pub webhook_hook_burst: u32,
    pub webhook_channel_per_minute: u32,
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
    pub report_feedback_per_week: u32,
    pub report_retention_days: u32,
    pub e2ee_guests_per_group: u32,
    pub e2ee_key_retention_days: u32,
    pub sfu_enabled: bool,
    pub sfu_max_participants: u32,
    pub sfu_max_streams: u32,
    pub sfu_user_kib_per_sec: u32,
    pub p2p_backup_max_mib: u32,
    pub p2p_backup_total_mib: u32,
    pub widget_quick_joins_per_hour: u32,
    pub widget_viewers_max: u32,
    pub widget_bridge_servers_max: u32,
    pub peerjs_builtin: bool,
    pub peerjs_peers_per_ip: usize,
    pub peerjs_concurrent_limit: usize,
    pub lookup_list_per_minute: u32,
    pub lookup_typeahead_per_minute: u32,
    pub lookup_search_per_minute: u32,
    pub lookup_profile_per_minute: u32,
    pub lookup_member_search_per_minute: u32,
    pub lookup_misses_per_hour: u32,
    pub message_search_per_minute: u32,
    pub message_search_at_once: u32,
    pub message_search_concurrent_limit: Option<u32>,
    pub rare_requests_per_hour: u32,
    pub rare_requests_per_day: u32,
    pub server_channels_max: i64,
    pub server_categories_max: i64,
    pub server_roles_max: i64,
    pub channel_pins_max: i64,
    pub message_user_mentions_max: usize,
    pub message_role_mentions_max: usize,
    pub here_recipients_max: usize,
    pub friends_max: i64,
    pub friend_requests_in_max: i64,
    pub channel_webhooks_max: i64,
    pub server_webhooks_max: i64,
    pub server_outgoing_webhooks_max: i64,
    pub webhook_queue_max: i64,
    pub webhook_workers: usize,
    pub webhook_attempts: i64,
    pub webhook_log_days: i64,
    pub webhook_log_kept: i64,
    pub audit_keep_days: i64,
    pub ping_keep_days: i64,
    pub preview_cache_mib: i64,
    pub preview_cache_rows: i64,
    pub preview_cache_days: i64,
    pub embed_fetches: usize,
    pub embed_queue: usize,
    pub ws_inbox_frames: usize,
    pub ws_out_frames: usize,
    pub ws_send_timeout_secs: u64,
    pub ws_read_buffer_kib: usize,
    pub ws_write_buffer_kib: usize,
    pub ws_max_write_buffer_kib: usize,
    pub ws_paced_users_max: usize,
    pub ws_channel_slots: usize,
    pub hub_aftermath_max: usize,
    pub hub_shown_max: usize,
    pub reconnect_base_ms: u64,
    pub reconnect_cap_ms: u64,
    pub reconnect_floor_ms: u64,
    pub resync_jitter_ms: u64,
    pub catch_up_delay_ms: u64,
    pub servers_per_account: i64,
    pub server_members_max: i64,
    pub signups_per_network_per_day: u32,
    pub servers_per_network_per_day: u32,
    pub ws_sockets_max: usize,
    pub session_max_age_secs: i64,
    pub session_idle_secs: i64,
    /// `P2P_LIMITS`: the names given that the P2P registry has, with their values.
    pub p2p: BTreeMap<String, f64>,
    /// Names in `P2P_LIMITS` the registry doesn't have, left out of `p2p`.
    pub p2p_unknown: Vec<String>,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            rate_limit_per_second: 10,
            rate_limit_burst: 60,
            rate_limit_strict_per_second: 2,
            rate_limit_strict_burst: 30,
            rate_limit_invite_per_second: 2,
            rate_limit_invite_burst: 30,
            argon2_permits: 0,
            argon2_memory_kib: argon2::Params::DEFAULT_M_COST,
            argon2_iterations: argon2::Params::DEFAULT_T_COST,
            argon2_parallelism: argon2::Params::DEFAULT_P_COST,
            server_password_queue_max: crate::api::auth::SERVER_QUEUE_MAX,
            server_password_queue_per_address: crate::api::auth::SERVER_ADDRESS_MAX,
            server_password_queue_per_network: crate::api::auth::SERVER_NETWORK_MAX,
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
            database_index_build_mib: 256,
            database_statement_timeout_secs: 60,
            database_replica_max_connections: 8,
            database_replica_max_lag_ms: 2000,
            upload_max_mib: 25,
            upload_budget_mib: DEFAULT_BUDGET_MIB,
            upload_buffer_mib: DEFAULT_BUFFER_MIB,
            upload_server_kept_mib: 8192,
            upload_owner_kept_mib: 16384,
            message_max_chars: 4000,
            message_rate_per_minute: 2400,
            message_rate_burst: 100,
            guest_grant_days: 30,
            guest_grants_per_password: crate::api::servers::GRANTS_PER_PASSWORD as u32,
            guest_grants_per_network: crate::api::servers::GRANTS_PER_NETWORK as u32,
            guest_grant_mints_per_network: crate::api::servers::GRANT_NETWORK_MINTS_MAX,
            webhook_hook_burst: crate::api::webhooks::HOOK_BURST,
            webhook_channel_per_minute: crate::api::webhooks::CHANNEL_BUDGET,
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
            report_feedback_per_week: 10,
            report_retention_days: 180,
            e2ee_guests_per_group: 500,
            e2ee_key_retention_days: 30,
            sfu_enabled: false,
            sfu_max_participants: 100,
            sfu_max_streams: 2000,
            sfu_user_kib_per_sec: 4096,
            p2p_backup_max_mib: 64,
            p2p_backup_total_mib: 256,
            widget_quick_joins_per_hour: 10,
            widget_viewers_max: 5000,
            widget_bridge_servers_max: 50,
            peerjs_builtin: true,
            peerjs_peers_per_ip: crate::peerjs::DEFAULT_PEERS_PER_IP,
            peerjs_concurrent_limit: crate::peerjs::DEFAULT_CONCURRENT_LIMIT,
            lookup_list_per_minute: 120,
            lookup_typeahead_per_minute: 300,
            lookup_search_per_minute: 30,
            lookup_profile_per_minute: 120,
            lookup_member_search_per_minute: 30,
            lookup_misses_per_hour: 200,
            message_search_per_minute: 30,
            message_search_at_once: 1,
            message_search_concurrent_limit: None,
            rare_requests_per_hour: 20,
            rare_requests_per_day: 100,
            server_channels_max: 500,
            server_categories_max: 100,
            server_roles_max: 250,
            channel_pins_max: 100,
            message_user_mentions_max: 20,
            message_role_mentions_max: 20,
            here_recipients_max: 500,
            friends_max: 1000,
            friend_requests_in_max: 1000,
            channel_webhooks_max: 15,
            server_webhooks_max: 100,
            server_outgoing_webhooks_max: 10,
            webhook_queue_max: 1000,
            webhook_workers: 16,
            webhook_attempts: 6,
            webhook_log_days: 7,
            webhook_log_kept: 100,
            audit_keep_days: 90,
            ping_keep_days: 30,
            preview_cache_mib: 128,
            preview_cache_rows: 20000,
            preview_cache_days: 7,
            embed_fetches: 16,
            embed_queue: 256,
            ws_inbox_frames: 512,
            ws_out_frames: 256,
            ws_send_timeout_secs: 10,
            ws_read_buffer_kib: 128,
            ws_write_buffer_kib: 128,
            ws_max_write_buffer_kib: 0,
            ws_paced_users_max: 10000,
            ws_channel_slots: 100000,
            hub_aftermath_max: 0,
            hub_shown_max: 0,
            reconnect_base_ms: 1000,
            reconnect_cap_ms: 30000,
            reconnect_floor_ms: 250,
            resync_jitter_ms: 10000,
            catch_up_delay_ms: 5000,
            servers_per_account: 1000,
            server_members_max: 0,
            signups_per_network_per_day: 0,
            servers_per_network_per_day: 0,
            ws_sockets_max: 0,
            session_max_age_secs: 0,
            session_idle_secs: 0,
            p2p: BTreeMap::new(),
            p2p_unknown: Vec::new(),
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

    /// `P2P_LIMITS`: a JSON object of P2P limit names to numbers, each in its registry range and
    /// whole where the name takes whole numbers. Names the registry doesn't have come back apart,
    /// in order.
    fn p2p(&self) -> anyhow::Result<(BTreeMap<String, f64>, Vec<String>)> {
        const NAME: &str = "P2P_LIMITS";
        let Some(raw) = self.raw(NAME) else {
            return Ok((BTreeMap::new(), Vec::new()));
        };
        let given = match serde_json::from_str(&raw) {
            Ok(serde_json::Value::Object(given)) => given,
            Ok(_) => anyhow::bail!("{NAME}: expected a JSON object of names to numbers"),
            Err(e) => anyhow::bail!("{NAME}: expected a JSON object of names to numbers ({e})"),
        };
        let ranges = p2p_ranges()?;
        let (mut values, mut unknown) = (BTreeMap::new(), Vec::new());
        for (name, value) in given {
            let Some(&P2pRange {
                default: _,
                lo,
                hi,
                whole,
            }) = ranges.get(&name)
            else {
                unknown.push(name);
                continue;
            };
            let fits = |v: &f64| (lo..=hi).contains(v) && (!whole || v.fract() == 0.0);
            let got = || ascii(&value.to_string());
            match (value.as_f64().filter(fits), whole) {
                (Some(v), _) => values.insert(name, v),
                (None, true) => anyhow::bail!(
                    "{NAME}: {name}: expected a whole number from {lo} to {hi}, got {}",
                    got()
                ),
                (None, false) => {
                    anyhow::bail!("{NAME}: {name}: expected {lo} to {hi}, got {}", got())
                }
            };
        }
        for P2pRefresh {
            refresh,
            expiry,
            times,
            below,
        } in p2p_refresh()?
        {
            let at = |name: &str| match (values.get(name), ranges.get(name)) {
                (Some(&v), _) => Ok((v, format!("{v}"))),
                (
                    None,
                    Some(&P2pRange {
                        default,
                        lo: _,
                        hi: _,
                        whole: _,
                    }),
                ) => Ok((default, format!("{default}, the default"))),
                (None, None) => Err(anyhow::anyhow!("{NAME}: {name} is not in the registry")),
            };
            let (mut sum, mut parts) = (0.0, Vec::new());
            for name in &refresh {
                let (v, shown) = at(name)?;
                sum += v;
                parts.push(format!("{name} ({shown})"));
            }
            let (e, e_shown) = at(&expiry)?;
            let (fits, minimum, maximum) = match (times, below) {
                (1, true) => (sum < e, "greater than", "less than"),
                (1, false) => (sum <= e, "at least", "at most"),
                (2, false) if refresh.len() == 1 => {
                    (2.0 * sum <= e, "at least twice", "at most half of")
                }
                _ => anyhow::bail!("unsupported refresh rule for {expiry} in the P2P registry"),
            };
            if !fits {
                let parts = parts.join(" plus ");
                if values.contains_key(&expiry) && !refresh.iter().any(|n| values.contains_key(n)) {
                    anyhow::bail!("{NAME}: {expiry} ({e_shown}) must be {minimum} {parts}");
                }
                anyhow::bail!("{NAME}: {parts} must be {maximum} {expiry} ({e_shown})");
            }
        }
        Ok((values, unknown))
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
        let (p2p, p2p_unknown) = e.p2p()?;
        let limits = Limits {
            rate_limit_per_second: e.num("RATE_LIMIT_PER_SECOND", d.rate_limit_per_second)?,
            rate_limit_burst: e.num("RATE_LIMIT_BURST", d.rate_limit_burst)?,
            rate_limit_strict_per_second: e.num(
                "RATE_LIMIT_STRICT_PER_SECOND",
                d.rate_limit_strict_per_second,
            )?,
            rate_limit_strict_burst: e.num("RATE_LIMIT_STRICT_BURST", d.rate_limit_strict_burst)?,
            rate_limit_invite_per_second: e.num(
                "RATE_LIMIT_INVITE_PER_SECOND",
                d.rate_limit_invite_per_second,
            )?,
            rate_limit_invite_burst: e.num("RATE_LIMIT_INVITE_BURST", d.rate_limit_invite_burst)?,
            argon2_permits: e.num("ARGON2_PERMITS", d.argon2_permits)?,
            argon2_memory_kib: e.num("ARGON2_MEMORY_KIB", d.argon2_memory_kib)?,
            argon2_iterations: e.num("ARGON2_ITERATIONS", d.argon2_iterations)?,
            argon2_parallelism: e.num("ARGON2_PARALLELISM", d.argon2_parallelism)?,
            server_password_queue_max: e
                .num("SERVER_PASSWORD_QUEUE_MAX", d.server_password_queue_max)?,
            server_password_queue_per_address: e.num(
                "SERVER_PASSWORD_QUEUE_PER_ADDRESS",
                d.server_password_queue_per_address,
            )?,
            server_password_queue_per_network: e.num(
                "SERVER_PASSWORD_QUEUE_PER_NETWORK",
                d.server_password_queue_per_network,
            )?,
            ws_connections_per_user: e.num("WS_CONNECTIONS_PER_USER", d.ws_connections_per_user)?,
            ws_connect_burst: e.num("WS_CONNECT_BURST", d.ws_connect_burst)?,
            ws_connects_per_minute: e.num("WS_CONNECTS_PER_MINUTE", d.ws_connects_per_minute)?,
            ws_sockets_per_ip: e.num("WS_SOCKETS_PER_IP", d.ws_sockets_per_ip)?,
            ws_guest_sockets_per_ip: e.num("WS_GUEST_SOCKETS_PER_IP", d.ws_guest_sockets_per_ip)?,
            ws_guest_sockets_max: e.num("WS_GUEST_SOCKETS_MAX", d.ws_guest_sockets_max)?,
            redis_hub_maxlen: e.num("REDIS_HUB_MAXLEN", d.redis_hub_maxlen)?,
            database_max_connections: e.opt("DATABASE_MAX_CONNECTIONS")?,
            database_replica_max_connections: e.num(
                "DATABASE_REPLICA_MAX_CONNECTIONS",
                d.database_replica_max_connections,
            )?,
            database_replica_max_lag_ms: e
                .num("DATABASE_REPLICA_MAX_LAG_MS", d.database_replica_max_lag_ms)?,
            database_min_connections: e.opt("DATABASE_MIN_CONNECTIONS")?,
            database_acquire_timeout_secs: e.opt("DATABASE_ACQUIRE_TIMEOUT_SECS")?,
            database_read_connections: e.opt("DATABASE_READ_CONNECTIONS")?,
            database_index_build_mib: e
                .num("DATABASE_INDEX_BUILD_MIB", d.database_index_build_mib)?,
            database_statement_timeout_secs: e.num(
                "DATABASE_STATEMENT_TIMEOUT_SECS",
                d.database_statement_timeout_secs,
            )?,
            upload_max_mib: e.num("UPLOAD_MAX_MIB", d.upload_max_mib)?,
            upload_budget_mib: e.num("UPLOAD_BUDGET_MIB", d.upload_budget_mib)?,
            upload_buffer_mib: e.num("UPLOAD_BUFFER_MIB", d.upload_buffer_mib)?,
            upload_server_kept_mib: e.num("UPLOAD_SERVER_KEPT_MIB", d.upload_server_kept_mib)?,
            upload_owner_kept_mib: e.num("UPLOAD_OWNER_KEPT_MIB", d.upload_owner_kept_mib)?,
            message_max_chars: e.num("MESSAGE_MAX_CHARS", d.message_max_chars)?,
            message_rate_per_minute: e.num("MESSAGE_RATE_PER_MINUTE", d.message_rate_per_minute)?,
            message_rate_burst: e.num("MESSAGE_RATE_BURST", d.message_rate_burst)?,
            guest_grant_days: e.num("GUEST_GRANT_DAYS", d.guest_grant_days)?,
            guest_grants_per_password: e
                .num("GUEST_GRANTS_PER_PASSWORD", d.guest_grants_per_password)?,
            guest_grants_per_network: e
                .num("GUEST_GRANTS_PER_NETWORK", d.guest_grants_per_network)?,
            guest_grant_mints_per_network: e.num(
                "GUEST_GRANT_MINTS_PER_NETWORK",
                d.guest_grant_mints_per_network,
            )?,
            webhook_hook_burst: e.num("WEBHOOK_HOOK_BURST", d.webhook_hook_burst)?,
            webhook_channel_per_minute: e
                .num("WEBHOOK_CHANNEL_PER_MINUTE", d.webhook_channel_per_minute)?,
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
            report_feedback_per_week: e
                .num("REPORT_FEEDBACK_PER_WEEK", d.report_feedback_per_week)?,
            report_retention_days: e.num("REPORT_RETENTION_DAYS", d.report_retention_days)?,
            e2ee_guests_per_group: e.num("E2EE_GUESTS_PER_GROUP", d.e2ee_guests_per_group)?,
            e2ee_key_retention_days: e.num("E2EE_KEY_RETENTION_DAYS", d.e2ee_key_retention_days)?,
            sfu_enabled: e.switch("SFU_ENABLED", d.sfu_enabled)?,
            sfu_max_participants: e.num("SFU_MAX_PARTICIPANTS", d.sfu_max_participants)?,
            sfu_max_streams: e.num("SFU_MAX_STREAMS", d.sfu_max_streams)?,
            sfu_user_kib_per_sec: e.num("SFU_USER_KIB_PER_SEC", d.sfu_user_kib_per_sec)?,
            p2p_backup_max_mib: e.num("P2P_BACKUP_MAX_MIB", d.p2p_backup_max_mib)?,
            p2p_backup_total_mib: e.num("P2P_BACKUP_TOTAL_MIB", d.p2p_backup_total_mib)?,
            widget_quick_joins_per_hour: e
                .num("WIDGET_QUICK_JOINS_PER_HOUR", d.widget_quick_joins_per_hour)?,
            widget_viewers_max: e.num("WIDGET_VIEWERS_MAX", d.widget_viewers_max)?,
            widget_bridge_servers_max: e
                .num("WIDGET_BRIDGE_SERVERS_MAX", d.widget_bridge_servers_max)?,
            peerjs_builtin: e.switch("PEERJS_BUILTIN", d.peerjs_builtin)?,
            peerjs_peers_per_ip: e.num("PEERJS_PEERS_PER_IP", d.peerjs_peers_per_ip)?,
            peerjs_concurrent_limit: e.num("PEERJS_CONCURRENT_LIMIT", d.peerjs_concurrent_limit)?,
            lookup_list_per_minute: e.num("LOOKUP_LIST_PER_MINUTE", d.lookup_list_per_minute)?,
            lookup_typeahead_per_minute: e
                .num("LOOKUP_TYPEAHEAD_PER_MINUTE", d.lookup_typeahead_per_minute)?,
            lookup_search_per_minute: e
                .num("LOOKUP_SEARCH_PER_MINUTE", d.lookup_search_per_minute)?,
            lookup_profile_per_minute: e
                .num("LOOKUP_PROFILE_PER_MINUTE", d.lookup_profile_per_minute)?,
            lookup_member_search_per_minute: e.num(
                "LOOKUP_MEMBER_SEARCH_PER_MINUTE",
                d.lookup_member_search_per_minute,
            )?,
            lookup_misses_per_hour: e.num("LOOKUP_MISSES_PER_HOUR", d.lookup_misses_per_hour)?,
            message_search_per_minute: e
                .num("MESSAGE_SEARCH_PER_MINUTE", d.message_search_per_minute)?,
            message_search_at_once: e.num("MESSAGE_SEARCH_AT_ONCE", d.message_search_at_once)?,
            message_search_concurrent_limit: e.opt("MESSAGE_SEARCH_CONCURRENT_LIMIT")?,
            rare_requests_per_hour: e.num("RARE_REQUESTS_PER_HOUR", d.rare_requests_per_hour)?,
            rare_requests_per_day: e.num("RARE_REQUESTS_PER_DAY", d.rare_requests_per_day)?,
            server_channels_max: e.num("SERVER_CHANNELS_MAX", d.server_channels_max)?,
            server_categories_max: e.num("SERVER_CATEGORIES_MAX", d.server_categories_max)?,
            server_roles_max: e.num("SERVER_ROLES_MAX", d.server_roles_max)?,
            channel_pins_max: e.num("CHANNEL_PINS_MAX", d.channel_pins_max)?,
            message_user_mentions_max: e
                .num("MESSAGE_USER_MENTIONS_MAX", d.message_user_mentions_max)?,
            message_role_mentions_max: e
                .num("MESSAGE_ROLE_MENTIONS_MAX", d.message_role_mentions_max)?,
            here_recipients_max: e.num("HERE_RECIPIENTS_MAX", d.here_recipients_max)?,
            friends_max: e.num("FRIENDS_MAX", d.friends_max)?,
            friend_requests_in_max: e.num("FRIEND_REQUESTS_IN_MAX", d.friend_requests_in_max)?,
            channel_webhooks_max: e.num("CHANNEL_WEBHOOKS_MAX", d.channel_webhooks_max)?,
            server_webhooks_max: e.num("SERVER_WEBHOOKS_MAX", d.server_webhooks_max)?,
            server_outgoing_webhooks_max: e.num(
                "SERVER_OUTGOING_WEBHOOKS_MAX",
                d.server_outgoing_webhooks_max,
            )?,
            webhook_queue_max: e.num("WEBHOOK_QUEUE_MAX", d.webhook_queue_max)?,
            webhook_workers: e.num("WEBHOOK_WORKERS", d.webhook_workers)?,
            webhook_attempts: e.num("WEBHOOK_ATTEMPTS", d.webhook_attempts)?,
            webhook_log_days: e.num("WEBHOOK_LOG_DAYS", d.webhook_log_days)?,
            webhook_log_kept: e.num("WEBHOOK_LOG_KEPT", d.webhook_log_kept)?,
            audit_keep_days: e.num("AUDIT_KEEP_DAYS", d.audit_keep_days)?,
            ping_keep_days: e.num("PING_KEEP_DAYS", d.ping_keep_days)?,
            preview_cache_mib: e.num("PREVIEW_CACHE_MIB", d.preview_cache_mib)?,
            preview_cache_rows: e.num("PREVIEW_CACHE_ROWS", d.preview_cache_rows)?,
            preview_cache_days: e.num("PREVIEW_CACHE_DAYS", d.preview_cache_days)?,
            embed_fetches: e.num("EMBED_FETCHES", d.embed_fetches)?,
            embed_queue: e.num("EMBED_QUEUE", d.embed_queue)?,
            ws_inbox_frames: e.num("WS_INBOX_FRAMES", d.ws_inbox_frames)?,
            ws_out_frames: e.num("WS_OUT_FRAMES", d.ws_out_frames)?,
            ws_send_timeout_secs: e.num("WS_SEND_TIMEOUT_SECS", d.ws_send_timeout_secs)?,
            ws_read_buffer_kib: e.num("WS_READ_BUFFER_KIB", d.ws_read_buffer_kib)?,
            ws_write_buffer_kib: e.num("WS_WRITE_BUFFER_KIB", d.ws_write_buffer_kib)?,
            ws_max_write_buffer_kib: e.num("WS_MAX_WRITE_BUFFER_KIB", d.ws_max_write_buffer_kib)?,
            ws_paced_users_max: e.num("WS_PACED_USERS_MAX", d.ws_paced_users_max)?,
            ws_channel_slots: e.num("WS_CHANNEL_SLOTS", d.ws_channel_slots)?,
            hub_aftermath_max: e.num("HUB_AFTERMATH_MAX", d.hub_aftermath_max)?,
            hub_shown_max: e.num("HUB_SHOWN_MAX", d.hub_shown_max)?,
            reconnect_base_ms: e.num("RECONNECT_BASE_MS", d.reconnect_base_ms)?,
            reconnect_cap_ms: e.num("RECONNECT_CAP_MS", d.reconnect_cap_ms)?,
            reconnect_floor_ms: e.num("RECONNECT_FLOOR_MS", d.reconnect_floor_ms)?,
            resync_jitter_ms: e.num("RESYNC_JITTER_MS", d.resync_jitter_ms)?,
            catch_up_delay_ms: e.num("CATCH_UP_DELAY_MS", d.catch_up_delay_ms)?,
            servers_per_account: e.num("SERVERS_PER_ACCOUNT", d.servers_per_account)?,
            server_members_max: e.num("SERVER_MEMBERS_MAX", d.server_members_max)?,
            signups_per_network_per_day: e
                .num("SIGNUPS_PER_NETWORK_PER_DAY", d.signups_per_network_per_day)?,
            servers_per_network_per_day: e
                .num("SERVERS_PER_NETWORK_PER_DAY", d.servers_per_network_per_day)?,
            ws_sockets_max: e.num("WS_SOCKETS_MAX", d.ws_sockets_max)?,
            session_max_age_secs: e.num("SESSION_MAX_AGE_SECS", d.session_max_age_secs)?,
            session_idle_secs: e.num("SESSION_IDLE_SECS", d.session_idle_secs)?,
            p2p,
            p2p_unknown,
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
            rate_limit_strict_per_second,
            rate_limit_strict_burst,
            rate_limit_invite_per_second,
            rate_limit_invite_burst,
            argon2_permits,
            argon2_memory_kib,
            argon2_iterations,
            argon2_parallelism,
            server_password_queue_max,
            server_password_queue_per_address,
            server_password_queue_per_network,
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
            database_index_build_mib,
            database_statement_timeout_secs,
            database_replica_max_connections,
            database_replica_max_lag_ms,
            upload_max_mib,
            upload_budget_mib,
            upload_buffer_mib,
            upload_server_kept_mib,
            upload_owner_kept_mib,
            message_max_chars,
            message_rate_per_minute,
            message_rate_burst,
            guest_grant_days,
            guest_grants_per_password,
            guest_grants_per_network,
            guest_grant_mints_per_network,
            webhook_hook_burst,
            webhook_channel_per_minute,
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
            report_feedback_per_week,
            report_retention_days,
            e2ee_guests_per_group,
            e2ee_key_retention_days,
            sfu_enabled: _,
            sfu_max_participants,
            sfu_max_streams,
            sfu_user_kib_per_sec,
            p2p_backup_max_mib,
            p2p_backup_total_mib,
            widget_quick_joins_per_hour,
            widget_viewers_max,
            widget_bridge_servers_max,
            peerjs_builtin: _,
            peerjs_peers_per_ip,
            peerjs_concurrent_limit,
            lookup_list_per_minute,
            lookup_typeahead_per_minute,
            lookup_search_per_minute,
            lookup_profile_per_minute,
            lookup_member_search_per_minute,
            lookup_misses_per_hour,
            message_search_per_minute,
            message_search_at_once,
            message_search_concurrent_limit,
            rare_requests_per_hour,
            rare_requests_per_day,
            server_channels_max,
            server_categories_max,
            server_roles_max,
            channel_pins_max,
            message_user_mentions_max,
            message_role_mentions_max,
            here_recipients_max,
            friends_max,
            friend_requests_in_max,
            channel_webhooks_max,
            server_webhooks_max,
            server_outgoing_webhooks_max,
            webhook_queue_max,
            webhook_workers,
            webhook_attempts,
            webhook_log_days,
            webhook_log_kept,
            audit_keep_days,
            ping_keep_days,
            preview_cache_mib,
            preview_cache_rows,
            preview_cache_days,
            embed_fetches,
            embed_queue,
            ws_inbox_frames,
            ws_out_frames,
            ws_send_timeout_secs,
            ws_read_buffer_kib,
            ws_write_buffer_kib,
            ws_max_write_buffer_kib,
            ws_paced_users_max,
            ws_channel_slots,
            hub_aftermath_max,
            hub_shown_max,
            reconnect_base_ms,
            reconnect_cap_ms,
            reconnect_floor_ms,
            resync_jitter_ms,
            catch_up_delay_ms,
            servers_per_account,
            server_members_max,
            signups_per_network_per_day,
            servers_per_network_per_day,
            ws_sockets_max,
            session_max_age_secs,
            session_idle_secs,
            p2p: _,
            p2p_unknown: _,
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
            (
                "RATE_LIMIT_STRICT_PER_SECOND",
                set(rate_limit_strict_per_second),
            ),
            ("RATE_LIMIT_STRICT_BURST", set(rate_limit_strict_burst)),
            (
                "RATE_LIMIT_INVITE_PER_SECOND",
                set(rate_limit_invite_per_second),
            ),
            ("RATE_LIMIT_INVITE_BURST", set(rate_limit_invite_burst)),
            ("ARGON2_PERMITS", set(argon2_permits)),
            ("ARGON2_MEMORY_KIB", set(argon2_memory_kib)),
            ("ARGON2_ITERATIONS", set(argon2_iterations)),
            ("ARGON2_PARALLELISM", set(argon2_parallelism)),
            ("SERVER_PASSWORD_QUEUE_MAX", set(server_password_queue_max)),
            (
                "SERVER_PASSWORD_QUEUE_PER_ADDRESS",
                set(server_password_queue_per_address),
            ),
            (
                "SERVER_PASSWORD_QUEUE_PER_NETWORK",
                set(server_password_queue_per_network),
            ),
            ("WS_CONNECTIONS_PER_USER", set(ws_connections_per_user)),
            ("WS_CONNECT_BURST", set(ws_connect_burst)),
            ("WS_CONNECTS_PER_MINUTE", set(ws_connects_per_minute)),
            ("WS_SOCKETS_PER_IP", set(ws_sockets_per_ip)),
            ("WS_GUEST_SOCKETS_PER_IP", set(ws_guest_sockets_per_ip)),
            ("WS_GUEST_SOCKETS_MAX", set(ws_guest_sockets_max)),
            ("REDIS_HUB_MAXLEN", set(redis_hub_maxlen)),
            ("DATABASE_MAX_CONNECTIONS", opt(database_max_connections)),
            (
                "DATABASE_REPLICA_MAX_CONNECTIONS",
                set(database_replica_max_connections),
            ),
            (
                "DATABASE_REPLICA_MAX_LAG_MS",
                set(database_replica_max_lag_ms),
            ),
            ("DATABASE_MIN_CONNECTIONS", opt(database_min_connections)),
            (
                "DATABASE_ACQUIRE_TIMEOUT_SECS",
                opt(database_acquire_timeout_secs),
            ),
            ("DATABASE_READ_CONNECTIONS", opt(database_read_connections)),
            ("DATABASE_INDEX_BUILD_MIB", set(database_index_build_mib)),
            (
                "DATABASE_STATEMENT_TIMEOUT_SECS",
                set(database_statement_timeout_secs),
            ),
            ("UPLOAD_MAX_MIB", set(upload_max_mib)),
            ("UPLOAD_BUDGET_MIB", set(upload_budget_mib)),
            ("UPLOAD_BUFFER_MIB", set(upload_buffer_mib)),
            ("UPLOAD_SERVER_KEPT_MIB", set(upload_server_kept_mib)),
            ("UPLOAD_OWNER_KEPT_MIB", set(upload_owner_kept_mib)),
            ("MESSAGE_MAX_CHARS", set(message_max_chars)),
            ("MESSAGE_RATE_PER_MINUTE", set(message_rate_per_minute)),
            ("MESSAGE_RATE_BURST", set(message_rate_burst)),
            ("GUEST_GRANT_DAYS", set(guest_grant_days)),
            ("GUEST_GRANTS_PER_PASSWORD", set(guest_grants_per_password)),
            ("GUEST_GRANTS_PER_NETWORK", set(guest_grants_per_network)),
            (
                "GUEST_GRANT_MINTS_PER_NETWORK",
                set(guest_grant_mints_per_network),
            ),
            ("WEBHOOK_HOOK_BURST", set(webhook_hook_burst)),
            (
                "WEBHOOK_CHANNEL_PER_MINUTE",
                set(webhook_channel_per_minute),
            ),
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
            ("REPORT_FEEDBACK_PER_WEEK", set(report_feedback_per_week)),
            ("REPORT_RETENTION_DAYS", set(report_retention_days)),
            ("E2EE_GUESTS_PER_GROUP", set(e2ee_guests_per_group)),
            ("E2EE_KEY_RETENTION_DAYS", set(e2ee_key_retention_days)),
            ("SFU_MAX_PARTICIPANTS", set(sfu_max_participants)),
            ("SFU_MAX_STREAMS", set(sfu_max_streams)),
            ("SFU_USER_KIB_PER_SEC", set(sfu_user_kib_per_sec)),
            ("P2P_BACKUP_MAX_MIB", set(p2p_backup_max_mib)),
            ("P2P_BACKUP_TOTAL_MIB", set(p2p_backup_total_mib)),
            (
                "WIDGET_QUICK_JOINS_PER_HOUR",
                set(widget_quick_joins_per_hour),
            ),
            ("WIDGET_VIEWERS_MAX", set(widget_viewers_max)),
            ("WIDGET_BRIDGE_SERVERS_MAX", set(widget_bridge_servers_max)),
            ("PEERJS_PEERS_PER_IP", set(peerjs_peers_per_ip)),
            ("PEERJS_CONCURRENT_LIMIT", set(peerjs_concurrent_limit)),
            ("LOOKUP_LIST_PER_MINUTE", set(lookup_list_per_minute)),
            (
                "LOOKUP_TYPEAHEAD_PER_MINUTE",
                set(lookup_typeahead_per_minute),
            ),
            ("LOOKUP_SEARCH_PER_MINUTE", set(lookup_search_per_minute)),
            ("LOOKUP_PROFILE_PER_MINUTE", set(lookup_profile_per_minute)),
            (
                "LOOKUP_MEMBER_SEARCH_PER_MINUTE",
                set(lookup_member_search_per_minute),
            ),
            ("LOOKUP_MISSES_PER_HOUR", set(lookup_misses_per_hour)),
            ("MESSAGE_SEARCH_PER_MINUTE", set(message_search_per_minute)),
            ("MESSAGE_SEARCH_AT_ONCE", set(message_search_at_once)),
            (
                "MESSAGE_SEARCH_CONCURRENT_LIMIT",
                opt(message_search_concurrent_limit),
            ),
            ("RARE_REQUESTS_PER_HOUR", set(rare_requests_per_hour)),
            ("RARE_REQUESTS_PER_DAY", set(rare_requests_per_day)),
            ("SERVER_CHANNELS_MAX", set(server_channels_max)),
            ("SERVER_CATEGORIES_MAX", set(server_categories_max)),
            ("SERVER_ROLES_MAX", set(server_roles_max)),
            ("CHANNEL_PINS_MAX", set(channel_pins_max)),
            ("MESSAGE_USER_MENTIONS_MAX", set(message_user_mentions_max)),
            ("MESSAGE_ROLE_MENTIONS_MAX", set(message_role_mentions_max)),
            ("HERE_RECIPIENTS_MAX", set(here_recipients_max)),
            ("FRIENDS_MAX", set(friends_max)),
            ("FRIEND_REQUESTS_IN_MAX", set(friend_requests_in_max)),
            ("CHANNEL_WEBHOOKS_MAX", set(channel_webhooks_max)),
            ("SERVER_WEBHOOKS_MAX", set(server_webhooks_max)),
            (
                "SERVER_OUTGOING_WEBHOOKS_MAX",
                set(server_outgoing_webhooks_max),
            ),
            ("WEBHOOK_QUEUE_MAX", set(webhook_queue_max)),
            ("WEBHOOK_WORKERS", set(webhook_workers)),
            ("WEBHOOK_ATTEMPTS", set(webhook_attempts)),
            ("WEBHOOK_LOG_DAYS", set(webhook_log_days)),
            ("WEBHOOK_LOG_KEPT", set(webhook_log_kept)),
            ("AUDIT_KEEP_DAYS", set(audit_keep_days)),
            ("PING_KEEP_DAYS", set(ping_keep_days)),
            ("PREVIEW_CACHE_MIB", set(preview_cache_mib)),
            ("PREVIEW_CACHE_ROWS", set(preview_cache_rows)),
            ("PREVIEW_CACHE_DAYS", set(preview_cache_days)),
            ("EMBED_FETCHES", set(embed_fetches)),
            ("EMBED_QUEUE", set(embed_queue)),
            ("WS_INBOX_FRAMES", set(ws_inbox_frames)),
            ("WS_OUT_FRAMES", set(ws_out_frames)),
            ("WS_SEND_TIMEOUT_SECS", set(ws_send_timeout_secs)),
            ("WS_READ_BUFFER_KIB", set(ws_read_buffer_kib)),
            ("WS_WRITE_BUFFER_KIB", set(ws_write_buffer_kib)),
            ("WS_MAX_WRITE_BUFFER_KIB", set(ws_max_write_buffer_kib)),
            ("WS_PACED_USERS_MAX", set(ws_paced_users_max)),
            ("WS_CHANNEL_SLOTS", set(ws_channel_slots)),
            ("HUB_AFTERMATH_MAX", set(hub_aftermath_max)),
            ("HUB_SHOWN_MAX", set(hub_shown_max)),
            ("RECONNECT_BASE_MS", set(reconnect_base_ms)),
            ("RECONNECT_CAP_MS", set(reconnect_cap_ms)),
            ("RECONNECT_FLOOR_MS", set(reconnect_floor_ms)),
            ("RESYNC_JITTER_MS", set(resync_jitter_ms)),
            ("CATCH_UP_DELAY_MS", set(catch_up_delay_ms)),
            ("SERVERS_PER_ACCOUNT", set(servers_per_account)),
            ("SERVER_MEMBERS_MAX", set(server_members_max)),
            (
                "SIGNUPS_PER_NETWORK_PER_DAY",
                set(signups_per_network_per_day),
            ),
            (
                "SERVERS_PER_NETWORK_PER_DAY",
                set(servers_per_network_per_day),
            ),
            ("WS_SOCKETS_MAX", set(ws_sockets_max)),
            ("SESSION_MAX_AGE_SECS", set(session_max_age_secs)),
            ("SESSION_IDLE_SECS", set(session_idle_secs)),
        ]
    }

    /// The smallest and largest value of the numeric limit `env`.
    pub fn range(env: &str) -> Option<(i64, i64)> {
        RANGES
            .iter()
            .find(|(name, _, _)| *name == env)
            .map(|(_, lo, hi)| (*lo, *hi))
    }

    /// The largest value the numeric limit `env` takes, the bound for reads of what it caps, so
    /// rows kept from before a cap was lowered still count. `i64::MAX` for a name without a range.
    pub fn most(env: &str) -> i64 {
        Limits::range(env).map_or(i64::MAX, |(_, hi)| hi)
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
        if self.reconnect_floor_ms > self.reconnect_base_ms {
            anyhow::bail!(
                "RECONNECT_FLOOR_MS: expected at most RECONNECT_BASE_MS ({}), got {}",
                self.reconnect_base_ms,
                self.reconnect_floor_ms
            );
        }
        if self.reconnect_base_ms > self.reconnect_cap_ms {
            anyhow::bail!(
                "RECONNECT_CAP_MS: expected at least RECONNECT_BASE_MS ({}), got {}",
                self.reconnect_base_ms,
                self.reconnect_cap_ms
            );
        }
        if self.session_idle_secs != 0 && self.session_idle_secs < SESSION_IDLE_MIN {
            anyhow::bail!(
                "SESSION_IDLE_SECS: expected 0 or at least {SESSION_IDLE_MIN}, got {}",
                self.session_idle_secs
            );
        }
        if self.ws_max_write_buffer_kib != 0
            && self.ws_max_write_buffer_kib <= self.ws_write_buffer_kib
        {
            anyhow::bail!(
                "WS_MAX_WRITE_BUFFER_KIB: expected 0 or more than WS_WRITE_BUFFER_KIB ({}), got {}",
                self.ws_write_buffer_kib,
                self.ws_max_write_buffer_kib
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

    /// Seconds a request waits for a free database connection (`DATABASE_ACQUIRE_TIMEOUT_SECS`).
    pub fn acquire_timeout_secs(&self) -> u64 {
        self.database_acquire_timeout_secs
            .unwrap_or(DEFAULT_ACQUIRE_TIMEOUT_SECS)
    }

    /// The warning to log at start when `P2P_BACKUP_MAX_MIB` is over `UPLOAD_BUFFER_MIB`.
    pub fn p2p_backup_buffer_warning(&self) -> Option<String> {
        let (max, buffer) = (u64::from(self.p2p_backup_max_mib), self.upload_buffer_mib);
        match max > buffer {
            true => Some(format!(
                "P2P_BACKUP_MAX_MIB is {max}, over UPLOAD_BUFFER_MIB ({buffer}): backup versions over {buffer} MiB are refused. Set UPLOAD_BUFFER_MIB to at least {max}."
            )),
            false => None,
        }
    }

    /// The warning to log at start when a P2P backup total is set under the largest version.
    pub fn p2p_backup_total_warning(&self) -> Option<String> {
        let (max, total) = (self.p2p_backup_max_mib, self.p2p_backup_total_mib);
        match total > 0 && total < max {
            true => Some(format!(
                "P2P_BACKUP_TOTAL_MIB is {total}, under P2P_BACKUP_MAX_MIB ({max}): backups over {total} MiB are refused as storage full. Keep it at least 35 times the typical backup."
            )),
            false => None,
        }
    }

    /// The bucket of messages each account sends (`MESSAGE_RATE_BURST` at once, then
    /// `MESSAGE_RATE_PER_MINUTE`); `None` when either is 0.
    pub fn message_rate(&self) -> Option<bucket::Policy> {
        match (self.message_rate_burst, self.message_rate_per_minute) {
            (0, _) | (_, 0) => None,
            (burst, per_minute) => Some(bucket::Policy::per_minute(burst, per_minute)),
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
            inbox_frames: self.ws_inbox_frames,
            channel_slots: self.ws_channel_slots,
            paced_users_max: self.ws_paced_users_max,
            aftermath_max: self.hub_aftermath_max,
            shown_max: self.hub_shown_max,
            sockets_max: self.ws_sockets_max,
        }
    }

    /// How long a realtime socket may take to accept a frame (`WS_SEND_TIMEOUT_SECS`).
    pub fn ws_send_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.ws_send_timeout_secs.max(1))
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

    /// Most bytes of one P2P backup version (`P2P_BACKUP_MAX_MIB`, at most `UPLOAD_BUFFER_MIB`); 0
    /// when the instance keeps no P2P backups.
    pub fn p2p_backup_bytes(&self) -> u64 {
        u64::from(self.p2p_backup_max_mib).min(self.upload_buffer_mib) * MIB as u64
    }

    /// Most bytes of P2P backup versions one account keeps over all its identities
    /// (`P2P_BACKUP_TOTAL_MIB`); 0 for no total.
    pub fn p2p_backup_total_bytes(&self) -> u64 {
        u64::from(self.p2p_backup_total_mib) * MIB as u64
    }

    /// The warnings to log at start for names in `P2P_LIMITS` the registry doesn't have.
    pub fn p2p_warnings(&self) -> Vec<String> {
        self.p2p_unknown
            .iter()
            .map(|name| format!("P2P_LIMITS: unknown name {} ignored", ascii(name)))
            .collect()
    }

    /// Seconds an unused guest grant lives (`GUEST_GRANT_DAYS`, at least one day).
    pub fn guest_grant_ttl(&self) -> i64 {
        self.guest_grant_days.max(1) * 86400
    }

    /// Seconds an unreferenced link preview is cached (`EMBED_CACHE_DAYS`, at least one day).
    pub fn embed_cache_ttl(&self) -> i64 {
        self.embed_cache_days.max(1) * 86400
    }

    /// Seconds an audit log entry is kept (`AUDIT_KEEP_DAYS`).
    pub fn audit_keep_secs(&self) -> i64 {
        self.audit_keep_days.max(1) * 86400
    }

    /// The oldest creation time and the oldest last use a session may have at `now` (Unix
    /// seconds): `SESSION_MAX_AGE_SECS` and `SESSION_IDLE_SECS`, `i64::MIN` for no limit.
    pub fn session_cutoffs(&self, now: i64) -> (i64, i64) {
        let cutoff = |secs: i64| match secs {
            0 => i64::MIN,
            secs => now.saturating_sub(secs),
        };
        (
            cutoff(self.session_max_age_secs),
            cutoff(self.session_idle_secs),
        )
    }

    /// Seconds a ping is kept (`PING_KEEP_DAYS`).
    pub fn ping_keep_secs(&self) -> i64 {
        self.ping_keep_days.max(1) * 86400
    }

    /// Seconds a webhook delivery stays in the log (`WEBHOOK_LOG_DAYS`).
    pub fn webhook_log_secs(&self) -> i64 {
        self.webhook_log_days.max(1) * 86400
    }

    /// Seconds a preview image stays cached (`PREVIEW_CACHE_DAYS`).
    pub fn preview_cache_secs(&self) -> i64 {
        self.preview_cache_days.max(1) * 86400
    }

    /// Bytes of preview images the cache keeps (`PREVIEW_CACHE_MIB`).
    pub fn preview_cache_bytes(&self) -> i64 {
        self.preview_cache_mib.saturating_mul(MIB as i64)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::{BTreeSet, HashMap};

    use super::{Limits, P2pRange, P2pRefresh, RANGES, p2p_ranges, p2p_refresh};

    fn load(pairs: &[(&str, String)]) -> anyhow::Result<Limits> {
        let set: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Limits::load(&|name| set.get(name).cloned())
    }

    /// Values of other limits that let `name` take every value of its range.
    fn companions(name: &str) -> Vec<(&'static str, String)> {
        let pairs: &[(&'static str, &str)] = match name {
            "UPLOAD_MAX_MIB" => &[("UPLOAD_BUFFER_MIB", "1048576")],
            "UPLOAD_BUFFER_MIB" => &[("UPLOAD_MAX_MIB", "1")],
            "RECONNECT_FLOOR_MS" => &[
                ("RECONNECT_BASE_MS", "60000"),
                ("RECONNECT_CAP_MS", "3600000"),
            ],
            "RECONNECT_BASE_MS" => &[("RECONNECT_FLOOR_MS", "0"), ("RECONNECT_CAP_MS", "3600000")],
            "RECONNECT_CAP_MS" => &[("RECONNECT_FLOOR_MS", "0"), ("RECONNECT_BASE_MS", "100")],
            "WS_WRITE_BUFFER_KIB" => &[("WS_MAX_WRITE_BUFFER_KIB", "0")],
            _ => &[],
        };
        pairs.iter().map(|(n, v)| (*n, v.to_string())).collect()
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
                pairs.extend(companions(name));
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
            match (numeric, name.as_str()) {
                (true, _) => {
                    let err = load(&[(&name, "1.5".to_string())]).unwrap_err();
                    assert!(err.to_string().starts_with(&format!("{name}: expected ")));
                }
                (false, "P2P_LIMITS") => {
                    let err = load(&[(&name, "on".to_string())]).unwrap_err();
                    assert!(
                        err.to_string()
                            .starts_with("P2P_LIMITS: expected a JSON object")
                    );
                }
                (false, _) => {
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
                "MESSAGE_SEARCH_CONCURRENT_LIMIT",
            ]
        );
        for (name, lo, hi) in RANGES {
            let mut pairs = vec![(name, hi.to_string())];
            pairs.extend(companions(name));
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
    fn the_p2p_backup_limits_bound_a_version_and_an_accounts_total() {
        let d = load(&[]).expect("defaults");
        assert_eq!(
            (d.p2p_backup_bytes(), d.p2p_backup_total_bytes()),
            (64 << 20, 256 << 20)
        );
        assert_eq!(d.p2p_backup_total_warning(), None);
        let off = load(&[
            ("P2P_BACKUP_MAX_MIB", "0".to_string()),
            ("P2P_BACKUP_TOTAL_MIB", "0".to_string()),
        ])
        .expect("off");
        assert_eq!(
            (off.p2p_backup_bytes(), off.p2p_backup_total_bytes()),
            (0, 0)
        );
        let most = load(&[("P2P_BACKUP_TOTAL_MIB", "1048576".to_string())]).expect("most");
        assert_eq!(most.p2p_backup_total_bytes(), 1 << 40);
        for (max, total, warned) in [
            ("512", None, true),
            ("64", Some("63"), true),
            ("64", Some("64"), false),
            ("64", Some("0"), false),
            ("0", Some("1"), false),
        ] {
            let mut pairs = vec![("P2P_BACKUP_MAX_MIB", max.to_string())];
            if let Some(total) = total {
                pairs.push(("P2P_BACKUP_TOTAL_MIB", total.to_string()));
            }
            let l = load(&pairs).unwrap_or_else(|e| panic!("{max}/{total:?} starts: {e}"));
            let warning = l.p2p_backup_total_warning();
            assert_eq!(warning.is_some(), warned, "{max}/{total:?}");
            if let Some(w) = warning {
                assert!(
                    w.starts_with("P2P_BACKUP_TOTAL_MIB is ") && w.is_ascii(),
                    "{w}"
                );
            }
        }
    }

    #[test]
    fn a_p2p_backup_version_fits_the_upload_buffer() {
        let set = |max: &str, buffer: &str| {
            load(&[
                ("P2P_BACKUP_MAX_MIB", max.to_string()),
                ("UPLOAD_BUFFER_MIB", buffer.to_string()),
            ])
            .unwrap_or_else(|e| panic!("{max}/{buffer} starts: {e}"))
        };
        let over = set("512", "256");
        assert_eq!(over.p2p_backup_bytes(), 256 << 20);
        let warning = over.p2p_backup_buffer_warning().expect("a warning");
        assert!(
            warning.starts_with("P2P_BACKUP_MAX_MIB is 512, over UPLOAD_BUFFER_MIB (256)")
                && warning.is_ascii(),
            "{warning}"
        );
        for (max, buffer, bytes) in [("512", "512", 512u64 << 20), ("64", "32", 32 << 20)] {
            let l = set(max, buffer);
            assert_eq!(l.p2p_backup_bytes(), bytes, "{max}/{buffer}");
            assert_eq!(
                l.p2p_backup_buffer_warning().is_some(),
                max != buffer,
                "{max}/{buffer}"
            );
        }
        assert_eq!(set("0", "32").p2p_backup_bytes(), 0);
        assert_eq!(set("0", "32").p2p_backup_buffer_warning(), None);
        assert_eq!(
            load(&[]).expect("defaults").p2p_backup_buffer_warning(),
            None
        );
    }

    #[test]
    fn rare_requests_have_their_defaults_and_ranges_and_0_is_no_limit() {
        let d = load(&[]).expect("defaults");
        assert_eq!(
            (d.rare_requests_per_hour, d.rare_requests_per_day),
            (20, 100)
        );
        let none = load(&[
            ("RARE_REQUESTS_PER_HOUR", "0".to_string()),
            ("RARE_REQUESTS_PER_DAY", "0".to_string()),
        ])
        .expect("0");
        assert_eq!(
            (none.rare_requests_per_hour, none.rare_requests_per_day),
            (0, 0)
        );
        for (name, bad, range) in [
            ("RARE_REQUESTS_PER_HOUR", "10001", "0 to 10000"),
            ("RARE_REQUESTS_PER_HOUR", "-1", "0 to 10000"),
            ("RARE_REQUESTS_PER_DAY", "100001", "0 to 100000"),
            ("RARE_REQUESTS_PER_DAY", "a few", "0 to 100000"),
        ] {
            let err = load(&[(name, bad.to_string())]).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("{name}: expected {range}, got {bad}")
            );
        }
    }

    #[test]
    fn the_message_rate_has_its_defaults_and_0_turns_it_off() {
        let d = load(&[]).expect("defaults");
        assert_eq!(
            (d.message_rate_burst, d.message_rate_per_minute),
            (100, 2400)
        );
        assert_eq!(
            d.message_rate(),
            Some(super::bucket::Policy::per_minute(100, 2400))
        );
        for off in ["MESSAGE_RATE_PER_MINUTE", "MESSAGE_RATE_BURST"] {
            let none = load(&[(off, "0".to_string())]).expect("0");
            assert_eq!(none.message_rate(), None, "{off}=0");
            let err = load(&[(off, "100001".to_string())]).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("{off}: expected 0 to 100000, got 100001")
            );
        }
    }

    #[test]
    fn request_limits_have_their_defaults_and_ranges() {
        let d = load(&[]).expect("defaults");
        assert_eq!(
            (
                d.rate_limit_strict_per_second,
                d.rate_limit_strict_burst,
                d.rate_limit_invite_per_second,
                d.rate_limit_invite_burst
            ),
            (2, 30, 2, 30)
        );
        assert_eq!(
            (
                d.argon2_permits,
                d.argon2_memory_kib,
                d.argon2_iterations,
                d.argon2_parallelism
            ),
            (0, 19456, 2, 1)
        );
        assert_eq!(
            (
                d.server_password_queue_max,
                d.server_password_queue_per_address,
                d.server_password_queue_per_network
            ),
            (64, 16, 32)
        );
        assert_eq!(
            (
                d.guest_grants_per_password,
                d.guest_grants_per_network,
                d.guest_grant_mints_per_network,
                d.webhook_hook_burst,
                d.webhook_channel_per_minute
            ),
            (2000, 50, 60, 5, 30)
        );
        for (name, bad, range) in [
            ("RATE_LIMIT_STRICT_BURST", "0", "1 to 1000000"),
            ("RATE_LIMIT_INVITE_PER_SECOND", "1001", "1 to 1000"),
            ("ARGON2_MEMORY_KIB", "1024", "4096 to 1048576"),
            ("ARGON2_PARALLELISM", "17", "1 to 16"),
            ("SERVER_PASSWORD_QUEUE_MAX", "0", "1 to 100000"),
            ("GUEST_GRANTS_PER_NETWORK", "none", "1 to 1000000"),
            ("WEBHOOK_HOOK_BURST", "-5", "1 to 10000"),
        ] {
            let err = load(&[(name, bad.to_string())]).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("{name}: expected {range}, got {bad}")
            );
        }
        let set = load(&[
            ("ARGON2_PERMITS", "4".to_string()),
            ("RATE_LIMIT_STRICT_BURST", "5".to_string()),
        ])
        .expect("set");
        assert_eq!((set.argon2_permits, set.rate_limit_strict_burst), (4, 5));
    }

    #[test]
    fn product_and_retention_limits_have_their_defaults() {
        let d = load(&[]).expect("defaults");
        assert_eq!(
            (
                d.server_channels_max,
                d.server_categories_max,
                d.server_roles_max,
                d.channel_pins_max,
                d.friends_max,
                d.friend_requests_in_max,
            ),
            (500, 100, 250, 100, 1000, 1000)
        );
        assert_eq!(
            (
                d.message_user_mentions_max,
                d.message_role_mentions_max,
                d.here_recipients_max,
                d.webhook_workers,
                d.embed_fetches,
                d.embed_queue,
            ),
            (20, 20, 500, 16, 16, 256)
        );
        assert_eq!(
            (
                d.channel_webhooks_max,
                d.server_webhooks_max,
                d.server_outgoing_webhooks_max,
                d.webhook_queue_max,
                d.webhook_attempts,
                d.webhook_log_kept,
            ),
            (15, 100, 10, 1000, 6, 100)
        );
        assert_eq!(
            (
                d.audit_keep_secs(),
                d.ping_keep_secs(),
                d.webhook_log_secs(),
                d.preview_cache_secs(),
                d.preview_cache_bytes(),
                d.preview_cache_rows,
            ),
            (
                90 * 86400,
                30 * 86400,
                7 * 86400,
                7 * 86400,
                128 * 1024 * 1024,
                20_000
            )
        );
        let set = load(&[
            ("SERVER_CHANNELS_MAX", "2".to_string()),
            ("AUDIT_KEEP_DAYS", "1".to_string()),
        ])
        .expect("set");
        assert_eq!((set.server_channels_max, set.audit_keep_secs()), (2, 86400));
        let err = load(&[("SERVER_CHANNELS_MAX", "0".to_string())]).unwrap_err();
        assert_eq!(
            err.to_string(),
            "SERVER_CHANNELS_MAX: expected 1 to 10000, got 0"
        );
        assert_eq!(Limits::most("CHANNEL_PINS_MAX"), 1000);
    }

    #[test]
    fn realtime_limits_load_from_env() {
        let d = load(&[]).expect("defaults");
        assert_eq!(
            (
                d.ws_inbox_frames,
                d.ws_out_frames,
                d.ws_send_timeout(),
                d.ws_read_buffer_kib,
                d.ws_write_buffer_kib,
                d.ws_max_write_buffer_kib,
                d.ws_paced_users_max,
                d.ws_channel_slots,
                d.hub_aftermath_max,
                d.hub_shown_max,
            ),
            (
                512,
                256,
                std::time::Duration::from_secs(10),
                128,
                128,
                0,
                10_000,
                100_000,
                0,
                0
            )
        );
        assert_eq!(
            (
                d.reconnect_base_ms,
                d.reconnect_cap_ms,
                d.reconnect_floor_ms,
                d.resync_jitter_ms,
                d.catch_up_delay_ms,
            ),
            (1000, 30000, 250, 10000, 5000)
        );
        let set = load(&[
            ("WS_OUT_FRAMES", "64".to_string()),
            ("WS_SEND_TIMEOUT_SECS", "3".to_string()),
            ("RECONNECT_BASE_MS", "2000".to_string()),
            ("RECONNECT_CAP_MS", "60000".to_string()),
            ("WS_MAX_WRITE_BUFFER_KIB", "1024".to_string()),
        ])
        .expect("set");
        assert_eq!(
            (
                set.ws_out_frames,
                set.ws_send_timeout(),
                set.reconnect_base_ms,
                set.reconnect_cap_ms,
                set.ws_max_write_buffer_kib
            ),
            (64, std::time::Duration::from_secs(3), 2000, 60000, 1024)
        );
        for (pairs, err) in [
            (
                vec![("RECONNECT_FLOOR_MS", "2000")],
                "RECONNECT_FLOOR_MS: expected at most RECONNECT_BASE_MS (1000), got 2000",
            ),
            (
                vec![("RECONNECT_BASE_MS", "40000")],
                "RECONNECT_CAP_MS: expected at least RECONNECT_BASE_MS (40000), got 30000",
            ),
            (
                vec![("WS_MAX_WRITE_BUFFER_KIB", "128")],
                "WS_MAX_WRITE_BUFFER_KIB: expected 0 or more than WS_WRITE_BUFFER_KIB (128), got 128",
            ),
        ] {
            let pairs: Vec<(&str, String)> =
                pairs.into_iter().map(|(k, v)| (k, v.to_string())).collect();
            assert_eq!(load(&pairs).unwrap_err().to_string(), err);
        }
    }

    #[test]
    fn the_p2p_registry_is_the_web_apps() {
        let ranges = p2p_ranges().expect("the registry parses");
        assert!(ranges.len() > 250, "{}", ranges.len());
        assert!(ranges.keys().all(|n| n.starts_with("local.")));
        let range = |default, lo, hi, whole| {
            Some(P2pRange {
                default,
                lo,
                hi,
                whole,
            })
        };
        let of = |name: &str| ranges.get(name).copied();
        assert_eq!(of("local.gossip.perRoom"), range(8.0, 2.0, 32.0, true));
        assert_eq!(of("local.share.room"), range(0.25, 0.015625, 1.0, false));
        assert_eq!(
            of("local.node.backoff.1"),
            range(60_000.0, 10_000.0, 1_800_000.0, true)
        );
        for (
            name,
            P2pRange {
                default,
                lo,
                hi,
                whole: _,
            },
        ) in &ranges
        {
            assert!(lo <= default && default <= hi, "{name}");
        }
        let rule = |refresh: &[&str], expiry: &str, times, below| P2pRefresh {
            refresh: refresh.iter().map(|n| n.to_string()).collect(),
            expiry: expiry.to_string(),
            times,
            below,
        };
        let rules = p2p_refresh().expect("the registry parses");
        assert_eq!(
            rules,
            [
                rule(
                    &["local.gossip.typingRelayMs"],
                    "local.gossip.typingMs",
                    2,
                    false
                ),
                rule(&["local.session.pingMs"], "local.session.deadMs", 2, false),
                rule(
                    &["local.gossip.presenceMs"],
                    "local.gossip.presenceTtl",
                    2,
                    false
                ),
                rule(&["local.voice.refreshMs"], "local.voice.ttlMs", 2, false),
                rule(&["local.voice.relayMs"], "local.voice.ttlMs", 2, false),
                rule(
                    &["local.voice.refreshMs", "local.voice.relayMs"],
                    "local.voice.lostMs",
                    1,
                    false
                ),
                rule(&["local.voice.gapMs"], "local.voice.ttlMs", 2, false),
                rule(
                    &["local.voice.gapMs", "local.voice.refreshMs"],
                    "local.voice.lostMs",
                    1,
                    true
                ),
            ]
        );
        for P2pRefresh {
            refresh,
            expiry,
            times,
            below,
        } in &rules
        {
            let interval =
                refresh.iter().map(|n| ranges[n].default).sum::<f64>() * f64::from(*times);
            let e = ranges[expiry].default;
            assert!(
                if *below { interval < e } else { interval <= e },
                "{refresh:?} {expiry}"
            );
        }
    }

    fn with<'a>(roomy: &[(&'a str, f64)], given: &[(&'a str, f64)]) -> Vec<(&'a str, f64)> {
        [roomy, given].concat()
    }

    #[test]
    fn a_p2p_refresh_that_does_not_fit_its_expiry_stops_the_start() {
        let p2p = |given: &[(&str, f64)]| {
            let json = serde_json::Map::from_iter(
                given
                    .iter()
                    .map(|(name, v)| (name.to_string(), serde_json::json!(v))),
            );
            load(&[("P2P_LIMITS", serde_json::Value::Object(json).to_string())])
        };
        let refused = |given: &[(&str, f64)]| {
            let err = p2p(given).unwrap_err().to_string();
            assert!(err.is_ascii(), "{err}");
            err
        };
        let taken = |given: &[(&str, f64)]| {
            let l = p2p(given).unwrap_or_else(|e| panic!("{given:?}: {e}"));
            for (name, v) in given {
                assert_eq!(l.p2p.get(*name), Some(v), "{given:?}");
            }
        };
        assert_eq!(
            refused(&[("local.gossip.typingMs", 1000.0)]),
            "P2P_LIMITS: local.gossip.typingMs (1000) must be at least twice \
             local.gossip.typingRelayMs (3000, the default)"
        );
        assert_eq!(
            refused(&[("local.voice.lostMs", 10_000.0)]),
            "P2P_LIMITS: local.voice.lostMs (10000) must be at least local.voice.refreshMs \
             (20000, the default) plus local.voice.relayMs (5000, the default)"
        );
        assert_eq!(
            refused(&[("local.gossip.typingRelayMs", 5000.0)]),
            "P2P_LIMITS: local.gossip.typingRelayMs (5000) must be at most half of \
             local.gossip.typingMs (8000, the default)"
        );
        assert_eq!(
            refused(&[
                ("local.voice.refreshMs", 20_000.0),
                ("local.voice.lostMs", 10_000.0)
            ]),
            "P2P_LIMITS: local.voice.refreshMs (20000) plus local.voice.relayMs (5000, the \
             default) must be at most local.voice.lostMs (10000)"
        );
        assert_eq!(
            refused(&[("local.voice.gapMs", 10_000.0)]),
            "P2P_LIMITS: local.voice.gapMs (10000) plus local.voice.refreshMs (20000, the \
             default) must be less than local.voice.lostMs (30000, the default)"
        );
        assert_eq!(
            refused(&[
                ("local.voice.relayMs", 1000.0),
                ("local.voice.lostMs", 21_000.0)
            ]),
            "P2P_LIMITS: local.voice.lostMs (21000) must be greater than local.voice.gapMs \
             (1000, the default) plus local.voice.refreshMs (20000, the default)"
        );
        let ranges = p2p_ranges().expect("the registry parses");
        let rules = p2p_refresh().expect("the registry parses");
        let d = |name: &str| ranges[name].default;
        let in_range = |name: &str, v: f64| (ranges[name].lo..=ranges[name].hi).contains(&v);
        // The first rule `given` breaks, the names it doesn't give at their defaults, and the
        // refusal that names it: the expiry first when it is the only one of the rule given.
        let refusal = |given: &[(&str, f64)]| {
            let value = |name: &str| given.iter().rev().find(|(n, _)| *n == name).map(|g| g.1);
            let at = |name: &str| value(name).unwrap_or(d(name));
            let shown = |name: &str| match value(name) {
                Some(v) => v.to_string(),
                None => format!("{}, the default", d(name)),
            };
            let rule = rules.iter().find(
                |P2pRefresh {
                     refresh,
                     expiry,
                     times,
                     below,
                 }| {
                    let over = refresh.iter().map(|n| at(n)).sum::<f64>() * f64::from(*times);
                    if *below {
                        over >= at(expiry)
                    } else {
                        over > at(expiry)
                    }
                },
            )?;
            let P2pRefresh {
                refresh,
                expiry,
                times,
                below,
            } = rule;
            let parts: Vec<String> = refresh
                .iter()
                .map(|n| format!("{n} ({})", shown(n)))
                .collect();
            let parts = parts.join(" plus ");
            let alone = value(expiry).is_some() && refresh.iter().all(|n| value(n).is_none());
            let e = format!("{expiry} ({})", shown(expiry));
            let said = match (alone, below, times) {
                (true, true, _) => format!("{e} must be greater than {parts}"),
                (true, _, 2) => format!("{e} must be at least twice {parts}"),
                (true, _, _) => format!("{e} must be at least {parts}"),
                (false, true, _) => format!("{parts} must be less than {e}"),
                (false, _, 2) => format!("{parts} must be at most half of {e}"),
                (false, _, _) => format!("{parts} must be at most {e}"),
            };
            Some((rule, format!("P2P_LIMITS: {said}")))
        };
        for rule in &rules {
            let P2pRefresh {
                refresh,
                expiry,
                times,
                below,
            } = rule;
            let (expiry, t) = (expiry.as_str(), f64::from(*times));
            // A rule that keeps the sum below the expiry has its edge a millisecond inside.
            let inside = if *below { 1.0 } else { 0.0 };
            let names: Vec<&str> = refresh.iter().map(String::as_str).chain([expiry]).collect();
            // Every other rule's expiry at its largest, so only this rule decides, unless a
            // name it shares is stricter in another rule.
            let roomy: Vec<(&str, f64)> = rules
                .iter()
                .map(|r| r.expiry.as_str())
                .filter(|e| !names.contains(e))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .map(|e| (e, ranges[e].hi))
                .collect();
            let sum = |of: &dyn Fn(&str) -> f64| refresh.iter().map(|n| of(n)).sum::<f64>();
            // `name` alone at the edge of the rule, the others at their defaults.
            let edge = |name: &str| {
                if name == expiry {
                    sum(&d) * t + inside
                } else {
                    d(expiry) / t - (sum(&d) - d(name)) - inside
                }
            };
            let wider: Vec<(&str, f64)> = refresh
                .iter()
                .map(|n| (n.as_str(), d(n) + 20_000.0))
                .collect();
            let wide = wider.iter().map(|(_, v)| v).sum::<f64>() * t;
            // Past the edge: refused by the first rule broken, this one or one sharing a name.
            for (name, v) in refresh
                .iter()
                .map(|n| (n.as_str(), edge(n) + 1.0))
                .chain([(expiry, edge(expiry) - 1.0)])
                .filter(|(n, v)| in_range(n, *v))
            {
                let given = with(&roomy, &[(name, v)]);
                let (_, said) = refusal(&given).expect("past the edge");
                assert_eq!(refused(&given), said);
            }
            let over = with(
                &roomy,
                &[wider.as_slice(), &[(expiry, wide - 1.0)]].concat(),
            );
            let (first, said) = refusal(&over).expect("past the edge");
            assert_eq!(first, rule);
            assert_eq!(refused(&over), said);
            for name in &names {
                let given = with(&roomy, &[(name, edge(name))]);
                if in_range(name, edge(name)) && refusal(&given).is_none() {
                    taken(&given);
                }
            }
            taken(&with(
                &roomy,
                &[wider.as_slice(), &[(expiry, wide + inside)]].concat(),
            ));
            if *below {
                let at = with(&roomy, &[wider.as_slice(), &[(expiry, wide)]].concat());
                let (first, said) = refusal(&at).expect("at the edge");
                assert_eq!(first, rule);
                assert_eq!(refused(&at), said);
            }
            let inside: Vec<(&str, f64)> = refresh
                .iter()
                .map(|n| (n.as_str(), d(n) - 1.0))
                .chain([(expiry, d(expiry) + 1.0)])
                .collect();
            taken(&with(&roomy, &inside));
        }
    }

    #[test]
    fn a_voice_gap_must_fit_the_loss_timer_and_roster_ttl() {
        let p2p = |given: &[(&str, f64)]| {
            let json = serde_json::Map::from_iter(
                given
                    .iter()
                    .map(|(name, v)| (name.to_string(), serde_json::json!(v))),
            );
            load(&[("P2P_LIMITS", serde_json::Value::Object(json).to_string())])
        };
        let refused = |given: &[(&str, f64)]| p2p(given).unwrap_err().to_string();
        let lost = |gap: &str, refresh: &str, lost: &str| {
            format!(
                "P2P_LIMITS: local.voice.gapMs ({gap}) plus local.voice.refreshMs ({refresh}) \
                 must be less than local.voice.lostMs ({lost})"
            )
        };
        let relayed = [
            ("local.voice.gapMs", 30_000.0),
            ("local.voice.refreshMs", 5000.0),
            ("local.voice.relayMs", 30_000.0),
            ("local.voice.ttlMs", 60_000.0),
        ];
        for (given, said) in [
            (
                vec![("local.voice.gapMs", 10_000.0)],
                lost("10000", "20000, the default", "30000, the default"),
            ),
            (
                vec![("local.voice.gapMs", 25_000.0)],
                lost("25000", "20000, the default", "30000, the default"),
            ),
            (
                vec![
                    ("local.voice.gapMs", 30_000.0),
                    ("local.voice.lostMs", 25_000.0),
                ],
                lost("30000", "20000, the default", "25000"),
            ),
            (
                vec![
                    ("local.voice.gapMs", 30_000.0),
                    ("local.voice.lostMs", 35_000.0),
                ],
                lost("30000", "20000, the default", "35000"),
            ),
            (
                vec![
                    ("local.voice.gapMs", 29_000.0),
                    ("local.voice.relayMs", 1000.0),
                    ("local.voice.lostMs", 30_000.0),
                ],
                lost("29000", "20000, the default", "30000"),
            ),
            (
                vec![
                    ("local.voice.gapMs", 7500.0),
                    ("local.voice.refreshMs", 5000.0),
                    ("local.voice.relayMs", 1000.0),
                    ("local.voice.ttlMs", 15_000.0),
                    ("local.voice.lostMs", 8500.0),
                ],
                lost("7500", "5000", "8500"),
            ),
            (
                [&relayed[..], &[("local.voice.lostMs", 35_000.0)]].concat(),
                lost("30000", "5000", "35000"),
            ),
            (
                vec![
                    ("local.voice.gapMs", 30_000.0),
                    ("local.voice.ttlMs", 59_999.0),
                    ("local.voice.lostMs", 55_000.0),
                ],
                "P2P_LIMITS: local.voice.gapMs (30000) must be at most half of \
                 local.voice.ttlMs (59999)"
                    .to_string(),
            ),
        ] {
            assert_eq!(refused(&given), said, "{given:?}");
        }
        for given in [
            vec![("local.voice.gapMs", 9999.0)],
            vec![
                ("local.voice.gapMs", 25_000.0),
                ("local.voice.lostMs", 45_001.0),
            ],
            vec![
                ("local.voice.gapMs", 7500.0),
                ("local.voice.refreshMs", 5000.0),
                ("local.voice.relayMs", 1000.0),
                ("local.voice.ttlMs", 15_000.0),
                ("local.voice.lostMs", 12_501.0),
            ],
            [&relayed[..], &[("local.voice.lostMs", 35_001.0)]].concat(),
        ] {
            let l = p2p(&given).unwrap_or_else(|e| panic!("{given:?}: {e}"));
            for (name, v) in &given {
                assert_eq!(l.p2p.get(*name), Some(v), "{given:?}");
            }
        }
    }

    #[test]
    fn p2p_limits_validate_against_the_registry() {
        let p2p = |json: &str| load(&[("P2P_LIMITS", json.to_string())]);
        let ranges = p2p_ranges().expect("the registry parses");
        for name in [
            "local.gossip.perRoom",
            "local.share.room",
            "local.node.backoff.1",
        ] {
            let P2pRange {
                default: _,
                lo,
                hi,
                whole,
            } = ranges[name];
            let expected = match whole {
                true => format!("expected a whole number from {lo} to {hi}"),
                false => format!("expected {lo} to {hi}"),
            };
            for edge in [lo, hi] {
                let l = p2p(&format!("{{\"{name}\": {edge}}}"))
                    .unwrap_or_else(|e| panic!("{name}={edge}: {e}"));
                assert_eq!(l.p2p.get(name), Some(&edge), "{name}={edge}");
                assert!(l.p2p_unknown.is_empty());
            }
            for past in [lo - 1.0, hi + 1.0] {
                let err = p2p(&format!("{{\"{name}\": {past}}}")).unwrap_err();
                assert_eq!(
                    err.to_string(),
                    format!("P2P_LIMITS: {name}: {expected}, got {past}")
                );
            }
        }
        for bad in ["\"16\"", "null", "true", "[16]", "{}"] {
            let err = p2p(&format!("{{\"local.gossip.perRoom\": {bad}}}")).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!(
                    "P2P_LIMITS: local.gossip.perRoom: expected a whole number from 2 to 32, got {bad}"
                )
            );
        }
        let both =
            p2p(r#"{"local.gossip.perRoom": 16, "local.sync.horizon": 3000}"#).expect("both");
        assert_eq!(
            both.p2p.into_iter().collect::<Vec<_>>(),
            [
                ("local.gossip.perRoom".to_string(), 16.0),
                ("local.sync.horizon".to_string(), 3000.0)
            ]
        );
        assert_eq!(load(&[]).expect("defaults").p2p, Default::default());
        assert_eq!(p2p(" {} ").expect("empty").p2p, Default::default());
    }

    #[test]
    fn p2p_limits_that_count_take_whole_numbers() {
        let p2p = |json: &str| load(&[("P2P_LIMITS", json.to_string())]);
        let ranges = p2p_ranges().expect("the registry parses");
        for (name, value) in [
            ("local.gossip.perRoom", "4.5"),
            ("local.transfer.kdfDesktopT", "3.5"),
            ("local.node.backoff.1", "60000.25"),
        ] {
            let P2pRange {
                default: _,
                lo,
                hi,
                whole,
            } = ranges[name];
            assert!(whole, "{name}");
            let err = p2p(&format!("{{\"{name}\": {value}}}")).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!(
                    "P2P_LIMITS: {name}: expected a whole number from {lo} to {hi}, got {value}"
                )
            );
        }
        let whole = p2p(r#"{"local.gossip.perRoom": 16.0, "local.dag.roomBytes": 5.36870912e8}"#)
            .expect("whole numbers written with a point or an exponent");
        assert_eq!(whole.p2p.get("local.gossip.perRoom"), Some(&16.0));
        assert_eq!(whole.p2p.get("local.dag.roomBytes"), Some(&536_870_912.0));
        let share = p2p(r#"{"local.share.room": 0.5}"#).expect("a share is a fraction");
        assert_eq!(share.p2p.get("local.share.room"), Some(&0.5));
        let fractions: Vec<&str> = ranges
            .iter()
            .filter(|(_, r)| !r.whole)
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(
            fractions,
            [
                "local.files.qualities.0",
                "local.files.qualities.1",
                "local.files.qualities.2",
                "local.files.qualities.3",
                "local.files.qualities.4",
                "local.share.room",
                "local.share.server"
            ]
        );
    }

    #[test]
    fn unknown_p2p_limit_names_are_dropped() {
        let l = load(&[(
            "P2P_LIMITS",
            r#"{"local.no.such": 3, "sync.horizon": "x", "local.gossip.perRoom": 4}"#.to_string(),
        )])
        .expect("unknown names don't stop the start");
        assert_eq!(
            l.p2p.into_iter().collect::<Vec<_>>(),
            [("local.gossip.perRoom".to_string(), 4.0)]
        );
        assert_eq!(l.p2p_unknown, ["local.no.such", "sync.horizon"]);
        let warnings = Limits {
            p2p_unknown: vec!["local.no.such".to_string(), "sync.horizon".to_string()],
            ..Limits::default()
        }
        .p2p_warnings();
        assert_eq!(
            warnings,
            [
                "P2P_LIMITS: unknown name local.no.such ignored",
                "P2P_LIMITS: unknown name sync.horizon ignored"
            ]
        );
        assert!(Limits::default().p2p_warnings().is_empty());
    }

    #[test]
    fn p2p_limit_messages_are_plain_ascii() {
        let p2p = |json: &str| load(&[("P2P_LIMITS", json.to_string())]);
        let err = p2p("{\"local.gossip.perRoom\": \"zw\u{f6}lf \u{1f600}\"}")
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "P2P_LIMITS: local.gossip.perRoom: expected a whole number from 2 to 32, \
             got \"zw\\u00f6lf \\ud83d\\ude00\""
        );
        let err = p2p("{\"local.share.room\": [\"\u{e9}\"]}")
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "P2P_LIMITS: local.share.room: expected 0.015625 to 1, got [\"\\u00e9\"]"
        );
        for (name, shown) in [
            ("local.gr\u{f6}\u{df}e", "local.gr\\u00f6\\u00dfe"),
            ("local.a\\nb", "local.a\\u000ab"),
            ("local.no such", "local.no such"),
        ] {
            let l = p2p(&format!("{{\"{name}\": 1}}")).expect("unknown names don't stop the start");
            assert_eq!(
                l.p2p_warnings(),
                [format!("P2P_LIMITS: unknown name {shown} ignored")]
            );
        }
    }

    #[test]
    fn message_search_limits_have_their_defaults_and_ranges() {
        let d = load(&[]).expect("defaults");
        assert_eq!(
            (
                d.message_search_per_minute,
                d.message_search_at_once,
                d.message_search_concurrent_limit
            ),
            (30, 1, None)
        );
        let set = load(&[
            ("MESSAGE_SEARCH_PER_MINUTE", "1000".to_string()),
            ("MESSAGE_SEARCH_AT_ONCE", " 4 ".to_string()),
            ("MESSAGE_SEARCH_CONCURRENT_LIMIT", "1".to_string()),
        ])
        .expect("set");
        assert_eq!(
            (
                set.message_search_per_minute,
                set.message_search_at_once,
                set.message_search_concurrent_limit
            ),
            (1000, 4, Some(1))
        );
        for (name, bad, range) in [
            ("MESSAGE_SEARCH_PER_MINUTE", "0", "1 to 1000"),
            ("MESSAGE_SEARCH_PER_MINUTE", "1001", "1 to 1000"),
            ("MESSAGE_SEARCH_AT_ONCE", "0", "1 to 100"),
            ("MESSAGE_SEARCH_AT_ONCE", "101", "1 to 100"),
            ("MESSAGE_SEARCH_CONCURRENT_LIMIT", "0", "1 to 1000"),
            ("MESSAGE_SEARCH_CONCURRENT_LIMIT", "half", "1 to 1000"),
        ] {
            let err = load(&[(name, bad.to_string())]).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("{name}: expected {range}, got {bad}")
            );
        }
    }

    #[test]
    fn bad_p2p_limits_json_stops_the_start() {
        for bad in [
            "{",
            "[]",
            "16",
            "\"local.gossip.perRoom\"",
            "{\"a\": 1,}",
            "on",
            "{\"a\": zw\u{f6}lf}",
            "{\"gr\u{f6}\u{df}e\" 1}",
        ] {
            let err = load(&[("P2P_LIMITS", bad.to_string())])
                .unwrap_err()
                .to_string();
            assert!(
                err.starts_with("P2P_LIMITS: expected a JSON object"),
                "{bad}: {err}"
            );
            assert!(err.is_ascii(), "{err}");
        }
        assert_eq!(
            load(&[("P2P_LIMITS", "  ".to_string())])
                .expect("blank")
                .p2p,
            Default::default()
        );
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
                None if name == "P2P_LIMITS" => {
                    assert!(
                        about.iter().any(|l| l.contains("JSON")),
                        "{name}: the comment above it says JSON"
                    );
                    let example = about
                        .iter()
                        .find_map(|l| l.split('\'').nth(1))
                        .expect("P2P_LIMITS: the comment above it has an example in single quotes");
                    let line = format!("{name}='{example}'");
                    let read: Vec<(String, String)> = dotenvy::from_read_iter(line.as_bytes())
                        .collect::<Result<_, _>>()
                        .expect("the example is a line of an env file");
                    assert_eq!(read, [(name.clone(), example.to_string())]);
                    let shown = load(&[(&name, example.to_string())]).expect("the example loads");
                    assert!(
                        !shown.p2p.is_empty() && shown.p2p_unknown.is_empty(),
                        "{example}"
                    );
                    for P2pRefresh {
                        refresh,
                        expiry,
                        times,
                        below,
                    } in p2p_refresh().expect("the registry parses")
                    {
                        let parts = refresh.join(" plus ");
                        let (said, half) = match (times, below) {
                            (2, _) => (format!("{parts} of {expiry}"), true),
                            (_, true) => (format!("{parts} is less than {expiry}"), false),
                            (_, false) => (format!("{parts} is at most {expiry}"), false),
                        };
                        assert!(
                            about
                                .iter()
                                .any(|l| l.contains(&said) && (!half || l.contains("at most half"))),
                            "{name}: the comment above it says {said}"
                        );
                    }
                }
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
            message_search_concurrent_limit: None,
            ..l
        };
        assert_eq!(
            unset(shown),
            Limits::default(),
            "the documented values are the defaults"
        );
    }
}
