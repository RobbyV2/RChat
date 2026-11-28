use std::collections::BTreeMap;

use serde::Deserialize;

use rchat_settings::{Env, items as st};

pub mod bucket;
pub mod http;
pub mod shared;

const MIB: usize = 1024 * 1024;

/// Seconds a request waits for a free database connection when the operator sets nothing.
pub const DEFAULT_ACQUIRE_TIMEOUT_SECS: u64 = 10;

/// The shortest idle timeout: sessions are marked used once a minute.
pub const SESSION_IDLE_MIN: i64 = 300;

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
    pub avatar_upload_max_mib: u64,
    pub avatar_animation_max_frames: u64,
    pub avatar_animation_max_secs: u64,
    pub avatar_animation_max_megapixels: u64,
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
    pub server_separators_max: i64,
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
    pub scheduled_per_account: i64,
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
        Limits::load(&|_| None).expect("the defaults load")
    }
}

/// `P2P_LIMITS`: a JSON object of P2P limit names to numbers, each in its registry range and
/// whole where the name takes whole numbers. Names the registry doesn't have come back apart,
/// in order.
fn p2p(e: &Env) -> anyhow::Result<(BTreeMap<String, f64>, Vec<String>)> {
    const NAME: &str = st::P2P_LIMITS.env();
    let Some(raw) = e.raw(&st::P2P_LIMITS.setting) else {
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

impl Limits {
    /// Every limit from `env` (the value of an env name, if set). A value that is not a number
    /// in its range, or not on or off, is an error naming the variable and the range.
    pub fn load(env: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<Limits> {
        let e = Env::new(env);
        let (p2p, p2p_unknown) = p2p(&e)?;
        let limits = Limits {
            rate_limit_per_second: e.get(&st::RATE_LIMIT_PER_SECOND)?,
            rate_limit_burst: e.get(&st::RATE_LIMIT_BURST)?,
            rate_limit_strict_per_second: e.get(&st::RATE_LIMIT_STRICT_PER_SECOND)?,
            rate_limit_strict_burst: e.get(&st::RATE_LIMIT_STRICT_BURST)?,
            rate_limit_invite_per_second: e.get(&st::RATE_LIMIT_INVITE_PER_SECOND)?,
            rate_limit_invite_burst: e.get(&st::RATE_LIMIT_INVITE_BURST)?,
            argon2_permits: e.get(&st::ARGON2_PERMITS)?,
            argon2_memory_kib: e.get(&st::ARGON2_MEMORY_KIB)?,
            argon2_iterations: e.get(&st::ARGON2_ITERATIONS)?,
            argon2_parallelism: e.get(&st::ARGON2_PARALLELISM)?,
            server_password_queue_max: e.get(&st::SERVER_PASSWORD_QUEUE_MAX)?,
            server_password_queue_per_address: e.get(&st::SERVER_PASSWORD_QUEUE_PER_ADDRESS)?,
            server_password_queue_per_network: e.get(&st::SERVER_PASSWORD_QUEUE_PER_NETWORK)?,
            ws_connections_per_user: e.get(&st::WS_CONNECTIONS_PER_USER)?,
            ws_connect_burst: e.get(&st::WS_CONNECT_BURST)?,
            ws_connects_per_minute: e.get(&st::WS_CONNECTS_PER_MINUTE)?,
            ws_sockets_per_ip: e.get(&st::WS_SOCKETS_PER_IP)?,
            ws_guest_sockets_per_ip: e.get(&st::WS_GUEST_SOCKETS_PER_IP)?,
            ws_guest_sockets_max: e.get(&st::WS_GUEST_SOCKETS_MAX)?,
            redis_hub_maxlen: e.get(&st::REDIS_HUB_MAXLEN)?,
            database_max_connections: e.opt(&st::DATABASE_MAX_CONNECTIONS)?,
            database_replica_max_connections: e.get(&st::DATABASE_REPLICA_MAX_CONNECTIONS)?,
            database_replica_max_lag_ms: e.get(&st::DATABASE_REPLICA_MAX_LAG_MS)?,
            database_min_connections: e.opt(&st::DATABASE_MIN_CONNECTIONS)?,
            database_acquire_timeout_secs: e.opt(&st::DATABASE_ACQUIRE_TIMEOUT_SECS)?,
            database_read_connections: e.opt(&st::DATABASE_READ_CONNECTIONS)?,
            database_index_build_mib: e.get(&st::DATABASE_INDEX_BUILD_MIB)?,
            database_statement_timeout_secs: e.get(&st::DATABASE_STATEMENT_TIMEOUT_SECS)?,
            upload_max_mib: e.get(&st::UPLOAD_MAX_MIB)?,
            upload_budget_mib: e.get(&st::UPLOAD_BUDGET_MIB)?,
            upload_buffer_mib: e.get(&st::UPLOAD_BUFFER_MIB)?,
            upload_server_kept_mib: e.get(&st::UPLOAD_SERVER_KEPT_MIB)?,
            upload_owner_kept_mib: e.get(&st::UPLOAD_OWNER_KEPT_MIB)?,
            avatar_upload_max_mib: e.get(&st::AVATAR_UPLOAD_MAX_MIB)?,
            avatar_animation_max_frames: e.get(&st::AVATAR_ANIMATION_MAX_FRAMES)?,
            avatar_animation_max_secs: e.get(&st::AVATAR_ANIMATION_MAX_SECS)?,
            avatar_animation_max_megapixels: e.get(&st::AVATAR_ANIMATION_MAX_MEGAPIXELS)?,
            message_max_chars: e.get(&st::MESSAGE_MAX_CHARS)?,
            message_rate_per_minute: e.get(&st::MESSAGE_RATE_PER_MINUTE)?,
            message_rate_burst: e.get(&st::MESSAGE_RATE_BURST)?,
            guest_grant_days: e.get(&st::GUEST_GRANT_DAYS)?,
            guest_grants_per_password: e.get(&st::GUEST_GRANTS_PER_PASSWORD)?,
            guest_grants_per_network: e.get(&st::GUEST_GRANTS_PER_NETWORK)?,
            guest_grant_mints_per_network: e.get(&st::GUEST_GRANT_MINTS_PER_NETWORK)?,
            webhook_hook_burst: e.get(&st::WEBHOOK_HOOK_BURST)?,
            webhook_channel_per_minute: e.get(&st::WEBHOOK_CHANNEL_PER_MINUTE)?,
            embed_cache_days: e.get(&st::EMBED_CACHE_DAYS)?,
            voice_idle_secs: e.get(&st::VOICE_IDLE_SECS)?,
            voice_room_max: e.get(&st::VOICE_ROOM_MAX)?,
            relay_user_allocations: e.get(&st::RELAY_USER_ALLOCATIONS)?,
            relay_max_allocations: e.opt(&st::RELAY_MAX_ALLOCATIONS)?,
            relay_user_kib_per_sec: e.get(&st::RELAY_USER_KIB_PER_SEC)?,
            relay_max_kib_per_sec: e.get(&st::RELAY_MAX_KIB_PER_SEC)?,
            report_same_target_hours: e.get(&st::REPORT_SAME_TARGET_HOURS)?,
            report_targets_per_day: e.get(&st::REPORT_TARGETS_PER_DAY)?,
            report_max_per_week: e.get(&st::REPORT_MAX_PER_WEEK)?,
            report_feedback_per_week: e.get(&st::REPORT_FEEDBACK_PER_WEEK)?,
            report_retention_days: e.get(&st::REPORT_RETENTION_DAYS)?,
            e2ee_guests_per_group: e.get(&st::E2EE_GUESTS_PER_GROUP)?,
            e2ee_key_retention_days: e.get(&st::E2EE_KEY_RETENTION_DAYS)?,
            sfu_enabled: e.switch(&st::SFU_ENABLED)?,
            sfu_max_participants: e.get(&st::SFU_MAX_PARTICIPANTS)?,
            sfu_max_streams: e.get(&st::SFU_MAX_STREAMS)?,
            sfu_user_kib_per_sec: e.get(&st::SFU_USER_KIB_PER_SEC)?,
            p2p_backup_max_mib: e.get(&st::P2P_BACKUP_MAX_MIB)?,
            p2p_backup_total_mib: e.get(&st::P2P_BACKUP_TOTAL_MIB)?,
            widget_quick_joins_per_hour: e.get(&st::WIDGET_QUICK_JOINS_PER_HOUR)?,
            widget_viewers_max: e.get(&st::WIDGET_VIEWERS_MAX)?,
            widget_bridge_servers_max: e.get(&st::WIDGET_BRIDGE_SERVERS_MAX)?,
            peerjs_builtin: e.switch(&st::PEERJS_BUILTIN)?,
            peerjs_peers_per_ip: e.get(&st::PEERJS_PEERS_PER_IP)?,
            peerjs_concurrent_limit: e.get(&st::PEERJS_CONCURRENT_LIMIT)?,
            lookup_list_per_minute: e.get(&st::LOOKUP_LIST_PER_MINUTE)?,
            lookup_typeahead_per_minute: e.get(&st::LOOKUP_TYPEAHEAD_PER_MINUTE)?,
            lookup_search_per_minute: e.get(&st::LOOKUP_SEARCH_PER_MINUTE)?,
            lookup_profile_per_minute: e.get(&st::LOOKUP_PROFILE_PER_MINUTE)?,
            lookup_member_search_per_minute: e.get(&st::LOOKUP_MEMBER_SEARCH_PER_MINUTE)?,
            lookup_misses_per_hour: e.get(&st::LOOKUP_MISSES_PER_HOUR)?,
            message_search_per_minute: e.get(&st::MESSAGE_SEARCH_PER_MINUTE)?,
            message_search_at_once: e.get(&st::MESSAGE_SEARCH_AT_ONCE)?,
            message_search_concurrent_limit: e.opt(&st::MESSAGE_SEARCH_CONCURRENT_LIMIT)?,
            rare_requests_per_hour: e.get(&st::RARE_REQUESTS_PER_HOUR)?,
            rare_requests_per_day: e.get(&st::RARE_REQUESTS_PER_DAY)?,
            server_channels_max: e.get(&st::SERVER_CHANNELS_MAX)?,
            server_categories_max: e.get(&st::SERVER_CATEGORIES_MAX)?,
            server_separators_max: e.get(&st::SERVER_SEPARATORS_MAX)?,
            server_roles_max: e.get(&st::SERVER_ROLES_MAX)?,
            channel_pins_max: e.get(&st::CHANNEL_PINS_MAX)?,
            message_user_mentions_max: e.get(&st::MESSAGE_USER_MENTIONS_MAX)?,
            message_role_mentions_max: e.get(&st::MESSAGE_ROLE_MENTIONS_MAX)?,
            here_recipients_max: e.get(&st::HERE_RECIPIENTS_MAX)?,
            friends_max: e.get(&st::FRIENDS_MAX)?,
            friend_requests_in_max: e.get(&st::FRIEND_REQUESTS_IN_MAX)?,
            channel_webhooks_max: e.get(&st::CHANNEL_WEBHOOKS_MAX)?,
            server_webhooks_max: e.get(&st::SERVER_WEBHOOKS_MAX)?,
            server_outgoing_webhooks_max: e.get(&st::SERVER_OUTGOING_WEBHOOKS_MAX)?,
            webhook_queue_max: e.get(&st::WEBHOOK_QUEUE_MAX)?,
            webhook_workers: e.get(&st::WEBHOOK_WORKERS)?,
            webhook_attempts: e.get(&st::WEBHOOK_ATTEMPTS)?,
            webhook_log_days: e.get(&st::WEBHOOK_LOG_DAYS)?,
            webhook_log_kept: e.get(&st::WEBHOOK_LOG_KEPT)?,
            audit_keep_days: e.get(&st::AUDIT_KEEP_DAYS)?,
            ping_keep_days: e.get(&st::PING_KEEP_DAYS)?,
            preview_cache_mib: e.get(&st::PREVIEW_CACHE_MIB)?,
            preview_cache_rows: e.get(&st::PREVIEW_CACHE_ROWS)?,
            preview_cache_days: e.get(&st::PREVIEW_CACHE_DAYS)?,
            embed_fetches: e.get(&st::EMBED_FETCHES)?,
            embed_queue: e.get(&st::EMBED_QUEUE)?,
            ws_inbox_frames: e.get(&st::WS_INBOX_FRAMES)?,
            ws_out_frames: e.get(&st::WS_OUT_FRAMES)?,
            ws_send_timeout_secs: e.get(&st::WS_SEND_TIMEOUT_SECS)?,
            ws_read_buffer_kib: e.get(&st::WS_READ_BUFFER_KIB)?,
            ws_write_buffer_kib: e.get(&st::WS_WRITE_BUFFER_KIB)?,
            ws_max_write_buffer_kib: e.get(&st::WS_MAX_WRITE_BUFFER_KIB)?,
            ws_paced_users_max: e.get(&st::WS_PACED_USERS_MAX)?,
            ws_channel_slots: e.get(&st::WS_CHANNEL_SLOTS)?,
            hub_aftermath_max: e.get(&st::HUB_AFTERMATH_MAX)?,
            hub_shown_max: e.get(&st::HUB_SHOWN_MAX)?,
            reconnect_base_ms: e.get(&st::RECONNECT_BASE_MS)?,
            reconnect_cap_ms: e.get(&st::RECONNECT_CAP_MS)?,
            reconnect_floor_ms: e.get(&st::RECONNECT_FLOOR_MS)?,
            resync_jitter_ms: e.get(&st::RESYNC_JITTER_MS)?,
            catch_up_delay_ms: e.get(&st::CATCH_UP_DELAY_MS)?,
            servers_per_account: e.get(&st::SERVERS_PER_ACCOUNT)?,
            scheduled_per_account: e.get(&st::SCHEDULED_PER_ACCOUNT)?,
            server_members_max: e.get(&st::SERVER_MEMBERS_MAX)?,
            signups_per_network_per_day: e.get(&st::SIGNUPS_PER_NETWORK_PER_DAY)?,
            servers_per_network_per_day: e.get(&st::SERVERS_PER_NETWORK_PER_DAY)?,
            ws_sockets_max: e.get(&st::WS_SOCKETS_MAX)?,
            session_max_age_secs: e.get(&st::SESSION_MAX_AGE_SECS)?,
            session_idle_secs: e.get(&st::SESSION_IDLE_SECS)?,
            p2p,
            p2p_unknown,
        };
        limits.validate()?;
        Ok(limits)
    }

    /// Every numeric limit with its value, in the order the admin page lists them. `None`: unset,
    /// and the process picks its own value.
    pub fn rows(&self) -> Vec<(&'static rchat_settings::Setting, Option<i64>)> {
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
            avatar_upload_max_mib,
            avatar_animation_max_frames,
            avatar_animation_max_secs,
            avatar_animation_max_megapixels,
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
            server_separators_max,
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
            scheduled_per_account,
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
            (
                &st::RATE_LIMIT_PER_SECOND.setting,
                set(rate_limit_per_second),
            ),
            (&st::RATE_LIMIT_BURST.setting, set(rate_limit_burst)),
            (
                &st::RATE_LIMIT_STRICT_PER_SECOND.setting,
                set(rate_limit_strict_per_second),
            ),
            (
                &st::RATE_LIMIT_STRICT_BURST.setting,
                set(rate_limit_strict_burst),
            ),
            (
                &st::RATE_LIMIT_INVITE_PER_SECOND.setting,
                set(rate_limit_invite_per_second),
            ),
            (
                &st::RATE_LIMIT_INVITE_BURST.setting,
                set(rate_limit_invite_burst),
            ),
            (&st::ARGON2_PERMITS.setting, set(argon2_permits)),
            (&st::ARGON2_MEMORY_KIB.setting, set(argon2_memory_kib)),
            (&st::ARGON2_ITERATIONS.setting, set(argon2_iterations)),
            (&st::ARGON2_PARALLELISM.setting, set(argon2_parallelism)),
            (
                &st::SERVER_PASSWORD_QUEUE_MAX.setting,
                set(server_password_queue_max),
            ),
            (
                &st::SERVER_PASSWORD_QUEUE_PER_ADDRESS.setting,
                set(server_password_queue_per_address),
            ),
            (
                &st::SERVER_PASSWORD_QUEUE_PER_NETWORK.setting,
                set(server_password_queue_per_network),
            ),
            (
                &st::WS_CONNECTIONS_PER_USER.setting,
                set(ws_connections_per_user),
            ),
            (&st::WS_CONNECT_BURST.setting, set(ws_connect_burst)),
            (
                &st::WS_CONNECTS_PER_MINUTE.setting,
                set(ws_connects_per_minute),
            ),
            (&st::WS_SOCKETS_PER_IP.setting, set(ws_sockets_per_ip)),
            (
                &st::WS_GUEST_SOCKETS_PER_IP.setting,
                set(ws_guest_sockets_per_ip),
            ),
            (&st::WS_GUEST_SOCKETS_MAX.setting, set(ws_guest_sockets_max)),
            (&st::REDIS_HUB_MAXLEN.setting, set(redis_hub_maxlen)),
            (
                &st::DATABASE_MAX_CONNECTIONS.setting,
                opt(database_max_connections),
            ),
            (
                &st::DATABASE_REPLICA_MAX_CONNECTIONS.setting,
                set(database_replica_max_connections),
            ),
            (
                &st::DATABASE_REPLICA_MAX_LAG_MS.setting,
                set(database_replica_max_lag_ms),
            ),
            (
                &st::DATABASE_MIN_CONNECTIONS.setting,
                opt(database_min_connections),
            ),
            (
                &st::DATABASE_ACQUIRE_TIMEOUT_SECS.setting,
                opt(database_acquire_timeout_secs),
            ),
            (
                &st::DATABASE_READ_CONNECTIONS.setting,
                opt(database_read_connections),
            ),
            (
                &st::DATABASE_INDEX_BUILD_MIB.setting,
                set(database_index_build_mib),
            ),
            (
                &st::DATABASE_STATEMENT_TIMEOUT_SECS.setting,
                set(database_statement_timeout_secs),
            ),
            (&st::UPLOAD_MAX_MIB.setting, set(upload_max_mib)),
            (&st::UPLOAD_BUDGET_MIB.setting, set(upload_budget_mib)),
            (&st::UPLOAD_BUFFER_MIB.setting, set(upload_buffer_mib)),
            (
                &st::UPLOAD_SERVER_KEPT_MIB.setting,
                set(upload_server_kept_mib),
            ),
            (
                &st::UPLOAD_OWNER_KEPT_MIB.setting,
                set(upload_owner_kept_mib),
            ),
            (
                &st::AVATAR_UPLOAD_MAX_MIB.setting,
                set(avatar_upload_max_mib),
            ),
            (
                &st::AVATAR_ANIMATION_MAX_FRAMES.setting,
                set(avatar_animation_max_frames),
            ),
            (
                &st::AVATAR_ANIMATION_MAX_SECS.setting,
                set(avatar_animation_max_secs),
            ),
            (
                &st::AVATAR_ANIMATION_MAX_MEGAPIXELS.setting,
                set(avatar_animation_max_megapixels),
            ),
            (&st::MESSAGE_MAX_CHARS.setting, set(message_max_chars)),
            (
                &st::MESSAGE_RATE_PER_MINUTE.setting,
                set(message_rate_per_minute),
            ),
            (&st::MESSAGE_RATE_BURST.setting, set(message_rate_burst)),
            (&st::GUEST_GRANT_DAYS.setting, set(guest_grant_days)),
            (
                &st::GUEST_GRANTS_PER_PASSWORD.setting,
                set(guest_grants_per_password),
            ),
            (
                &st::GUEST_GRANTS_PER_NETWORK.setting,
                set(guest_grants_per_network),
            ),
            (
                &st::GUEST_GRANT_MINTS_PER_NETWORK.setting,
                set(guest_grant_mints_per_network),
            ),
            (&st::WEBHOOK_HOOK_BURST.setting, set(webhook_hook_burst)),
            (
                &st::WEBHOOK_CHANNEL_PER_MINUTE.setting,
                set(webhook_channel_per_minute),
            ),
            (&st::EMBED_CACHE_DAYS.setting, set(embed_cache_days)),
            (&st::VOICE_IDLE_SECS.setting, set(voice_idle_secs)),
            (&st::VOICE_ROOM_MAX.setting, set(voice_room_max)),
            (
                &st::RELAY_USER_ALLOCATIONS.setting,
                set(relay_user_allocations),
            ),
            (
                &st::RELAY_MAX_ALLOCATIONS.setting,
                opt(relay_max_allocations),
            ),
            (
                &st::RELAY_USER_KIB_PER_SEC.setting,
                set(relay_user_kib_per_sec),
            ),
            (
                &st::RELAY_MAX_KIB_PER_SEC.setting,
                set(relay_max_kib_per_sec),
            ),
            (
                &st::REPORT_SAME_TARGET_HOURS.setting,
                set(report_same_target_hours),
            ),
            (
                &st::REPORT_TARGETS_PER_DAY.setting,
                set(report_targets_per_day),
            ),
            (&st::REPORT_MAX_PER_WEEK.setting, set(report_max_per_week)),
            (
                &st::REPORT_FEEDBACK_PER_WEEK.setting,
                set(report_feedback_per_week),
            ),
            (
                &st::REPORT_RETENTION_DAYS.setting,
                set(report_retention_days),
            ),
            (
                &st::E2EE_GUESTS_PER_GROUP.setting,
                set(e2ee_guests_per_group),
            ),
            (
                &st::E2EE_KEY_RETENTION_DAYS.setting,
                set(e2ee_key_retention_days),
            ),
            (&st::SFU_MAX_PARTICIPANTS.setting, set(sfu_max_participants)),
            (&st::SFU_MAX_STREAMS.setting, set(sfu_max_streams)),
            (&st::SFU_USER_KIB_PER_SEC.setting, set(sfu_user_kib_per_sec)),
            (&st::P2P_BACKUP_MAX_MIB.setting, set(p2p_backup_max_mib)),
            (&st::P2P_BACKUP_TOTAL_MIB.setting, set(p2p_backup_total_mib)),
            (
                &st::WIDGET_QUICK_JOINS_PER_HOUR.setting,
                set(widget_quick_joins_per_hour),
            ),
            (&st::WIDGET_VIEWERS_MAX.setting, set(widget_viewers_max)),
            (
                &st::WIDGET_BRIDGE_SERVERS_MAX.setting,
                set(widget_bridge_servers_max),
            ),
            (&st::PEERJS_PEERS_PER_IP.setting, set(peerjs_peers_per_ip)),
            (
                &st::PEERJS_CONCURRENT_LIMIT.setting,
                set(peerjs_concurrent_limit),
            ),
            (
                &st::LOOKUP_LIST_PER_MINUTE.setting,
                set(lookup_list_per_minute),
            ),
            (
                &st::LOOKUP_TYPEAHEAD_PER_MINUTE.setting,
                set(lookup_typeahead_per_minute),
            ),
            (
                &st::LOOKUP_SEARCH_PER_MINUTE.setting,
                set(lookup_search_per_minute),
            ),
            (
                &st::LOOKUP_PROFILE_PER_MINUTE.setting,
                set(lookup_profile_per_minute),
            ),
            (
                &st::LOOKUP_MEMBER_SEARCH_PER_MINUTE.setting,
                set(lookup_member_search_per_minute),
            ),
            (
                &st::LOOKUP_MISSES_PER_HOUR.setting,
                set(lookup_misses_per_hour),
            ),
            (
                &st::MESSAGE_SEARCH_PER_MINUTE.setting,
                set(message_search_per_minute),
            ),
            (
                &st::MESSAGE_SEARCH_AT_ONCE.setting,
                set(message_search_at_once),
            ),
            (
                &st::MESSAGE_SEARCH_CONCURRENT_LIMIT.setting,
                opt(message_search_concurrent_limit),
            ),
            (
                &st::RARE_REQUESTS_PER_HOUR.setting,
                set(rare_requests_per_hour),
            ),
            (
                &st::RARE_REQUESTS_PER_DAY.setting,
                set(rare_requests_per_day),
            ),
            (&st::SERVER_CHANNELS_MAX.setting, set(server_channels_max)),
            (
                &st::SERVER_CATEGORIES_MAX.setting,
                set(server_categories_max),
            ),
            (
                &st::SERVER_SEPARATORS_MAX.setting,
                set(server_separators_max),
            ),
            (&st::SERVER_ROLES_MAX.setting, set(server_roles_max)),
            (&st::CHANNEL_PINS_MAX.setting, set(channel_pins_max)),
            (
                &st::MESSAGE_USER_MENTIONS_MAX.setting,
                set(message_user_mentions_max),
            ),
            (
                &st::MESSAGE_ROLE_MENTIONS_MAX.setting,
                set(message_role_mentions_max),
            ),
            (&st::HERE_RECIPIENTS_MAX.setting, set(here_recipients_max)),
            (&st::FRIENDS_MAX.setting, set(friends_max)),
            (
                &st::FRIEND_REQUESTS_IN_MAX.setting,
                set(friend_requests_in_max),
            ),
            (&st::CHANNEL_WEBHOOKS_MAX.setting, set(channel_webhooks_max)),
            (&st::SERVER_WEBHOOKS_MAX.setting, set(server_webhooks_max)),
            (
                &st::SERVER_OUTGOING_WEBHOOKS_MAX.setting,
                set(server_outgoing_webhooks_max),
            ),
            (&st::WEBHOOK_QUEUE_MAX.setting, set(webhook_queue_max)),
            (&st::WEBHOOK_WORKERS.setting, set(webhook_workers)),
            (&st::WEBHOOK_ATTEMPTS.setting, set(webhook_attempts)),
            (&st::WEBHOOK_LOG_DAYS.setting, set(webhook_log_days)),
            (&st::WEBHOOK_LOG_KEPT.setting, set(webhook_log_kept)),
            (&st::AUDIT_KEEP_DAYS.setting, set(audit_keep_days)),
            (&st::PING_KEEP_DAYS.setting, set(ping_keep_days)),
            (&st::PREVIEW_CACHE_MIB.setting, set(preview_cache_mib)),
            (&st::PREVIEW_CACHE_ROWS.setting, set(preview_cache_rows)),
            (&st::PREVIEW_CACHE_DAYS.setting, set(preview_cache_days)),
            (&st::EMBED_FETCHES.setting, set(embed_fetches)),
            (&st::EMBED_QUEUE.setting, set(embed_queue)),
            (&st::WS_INBOX_FRAMES.setting, set(ws_inbox_frames)),
            (&st::WS_OUT_FRAMES.setting, set(ws_out_frames)),
            (&st::WS_SEND_TIMEOUT_SECS.setting, set(ws_send_timeout_secs)),
            (&st::WS_READ_BUFFER_KIB.setting, set(ws_read_buffer_kib)),
            (&st::WS_WRITE_BUFFER_KIB.setting, set(ws_write_buffer_kib)),
            (
                &st::WS_MAX_WRITE_BUFFER_KIB.setting,
                set(ws_max_write_buffer_kib),
            ),
            (&st::WS_PACED_USERS_MAX.setting, set(ws_paced_users_max)),
            (&st::WS_CHANNEL_SLOTS.setting, set(ws_channel_slots)),
            (&st::HUB_AFTERMATH_MAX.setting, set(hub_aftermath_max)),
            (&st::HUB_SHOWN_MAX.setting, set(hub_shown_max)),
            (&st::RECONNECT_BASE_MS.setting, set(reconnect_base_ms)),
            (&st::RECONNECT_CAP_MS.setting, set(reconnect_cap_ms)),
            (&st::RECONNECT_FLOOR_MS.setting, set(reconnect_floor_ms)),
            (&st::RESYNC_JITTER_MS.setting, set(resync_jitter_ms)),
            (&st::CATCH_UP_DELAY_MS.setting, set(catch_up_delay_ms)),
            (&st::SERVERS_PER_ACCOUNT.setting, set(servers_per_account)),
            (
                &st::SCHEDULED_PER_ACCOUNT.setting,
                set(scheduled_per_account),
            ),
            (&st::SERVER_MEMBERS_MAX.setting, set(server_members_max)),
            (
                &st::SIGNUPS_PER_NETWORK_PER_DAY.setting,
                set(signups_per_network_per_day),
            ),
            (
                &st::SERVERS_PER_NETWORK_PER_DAY.setting,
                set(servers_per_network_per_day),
            ),
            (&st::WS_SOCKETS_MAX.setting, set(ws_sockets_max)),
            (&st::SESSION_MAX_AGE_SECS.setting, set(session_max_age_secs)),
            (&st::SESSION_IDLE_SECS.setting, set(session_idle_secs)),
        ]
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

    /// The largest profile picture upload in bytes (`AVATAR_UPLOAD_MAX_MIB`).
    pub fn avatar_upload_bytes(&self) -> usize {
        self.avatar_upload_max_mib as usize * MIB
    }

    /// The bounds of an animated picture: frames (`AVATAR_ANIMATION_MAX_FRAMES`), duration
    /// (`AVATAR_ANIMATION_MAX_SECS`), decoded pixels over all frames
    /// (`AVATAR_ANIMATION_MAX_MEGAPIXELS`), and for each stored animation the bytes of an upload.
    pub fn avatar_animation_bounds(&self) -> rchat_avatar::Bounds {
        rchat_avatar::Bounds {
            frames: u32::try_from(self.avatar_animation_max_frames).unwrap_or(u32::MAX),
            millis: self.avatar_animation_max_secs.saturating_mul(1000),
            pixels: self
                .avatar_animation_max_megapixels
                .saturating_mul(1_000_000),
            bytes: self.avatar_upload_bytes(),
        }
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

    use super::{Limits, P2pRange, P2pRefresh, p2p_ranges, p2p_refresh};

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

    /// The numeric limits `Limits::load` reads: the env name, smallest and largest value.
    fn ranges() -> Vec<(&'static str, i64, i64)> {
        names()
            .iter()
            .filter_map(|name| {
                let setting = rchat_settings::by_env(name).expect("a setting");
                let (lo, hi) = setting.range()?;
                Some((setting.env, lo, hi))
            })
            .collect()
    }

    #[test]
    fn every_range_loads_at_its_edges_and_refuses_past_them() {
        let read = names();
        assert_eq!(ranges().len(), 129);
        for (name, lo, hi) in ranges() {
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
            let numeric = ranges().iter().any(|(n, _, _)| *n == name);
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
    fn the_defaults_are_the_registry_items_and_match_what_they_name() {
        let d = Limits::default();
        assert_eq!(
            (
                d.argon2_memory_kib,
                d.argon2_iterations,
                d.argon2_parallelism
            ),
            (
                argon2::Params::DEFAULT_M_COST,
                argon2::Params::DEFAULT_T_COST,
                argon2::Params::DEFAULT_P_COST
            )
        );
        for (setting, value) in d.rows() {
            match setting.default {
                rchat_settings::Preset::Number(n) => assert_eq!(value, Some(n), "{}", setting.env),
                rchat_settings::Preset::Picked(_) => assert_eq!(value, None, "{}", setting.env),
                other => panic!("{}: {other:?}", setting.env),
            }
        }
        assert_eq!(
            rchat_settings::items::DEFAULT_SERVERS.setting.default,
            rchat_settings::Preset::Text(crate::db::BUILTIN_SERVER)
        );
    }

    #[test]
    fn every_ranged_limit_is_listed_with_its_value() {
        let default = Limits::default().rows();
        let names: BTreeSet<&str> = default.iter().map(|(s, _)| s.env).collect();
        let ranged: BTreeSet<&str> = ranges().iter().map(|(name, _, _)| *name).collect();
        assert_eq!(names, ranged);
        assert_eq!(default.len(), ranged.len());
        let unset: Vec<&str> = default
            .iter()
            .filter(|(_, value)| value.is_none())
            .map(|(s, _)| s.env)
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
        for (name, _, hi) in ranges() {
            let mut pairs = vec![(name, hi.to_string())];
            pairs.extend(companions(name));
            let rows = load(&pairs).expect("loads").rows();
            let value = rows.iter().find(|(s, _)| s.env == name).map(|(_, v)| *v);
            assert_eq!(value, Some(Some(hi)), "{name}");
        }
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
                d.server_separators_max,
                d.server_roles_max,
                d.channel_pins_max,
                d.friends_max,
                d.friend_requests_in_max,
            ),
            (500, 100, 50, 250, 100, 1000, 1000)
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
            match ranges().iter().find(|(n, _, _)| *n == name) {
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
