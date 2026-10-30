use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use s3::creds::Credentials;
use s3::{Bucket, Region};
use serde::Deserialize;

use crate::bus::DEFAULT_HUB_MAXLEN;
use crate::hub::{
    CONNECT_BURST, CONNECTS_PER_MINUTE, CONNS_PER_USER, GUESTS_MAX, GUESTS_PER_IP,
    Limits as WsLimits, SOCKETS_PER_IP,
};
use crate::instance::InstanceConfig;
use crate::relay::{Capacity, Cidr, IceConfig, Limits, RelayAdvert, RelaySettings};
use crate::server::client_ip::ProxyTrust;

const MIN_HUB_MAXLEN: u64 = 1_000;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppMode {
    Full,
    ApiOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Roles {
    pub api: bool,
    pub gateway: bool,
    pub media: bool,
    pub search: bool,
    pub embeds: bool,
    pub jobs: bool,
    pub web: bool,
    pub relay: bool,
}

impl Default for Roles {
    fn default() -> Self {
        Roles::ALL
    }
}

impl Roles {
    pub const ALL: Roles = Roles {
        api: true,
        gateway: true,
        media: true,
        search: true,
        embeds: true,
        jobs: true,
        web: true,
        relay: true,
    };

    pub const NONE: Roles = Roles {
        api: false,
        gateway: false,
        media: false,
        search: false,
        embeds: false,
        jobs: false,
        web: false,
        relay: false,
    };

    pub fn parse(spec: &str) -> anyhow::Result<Roles> {
        let mut roles = Roles::NONE;
        for name in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            match name.to_lowercase().as_str() {
                "all" => roles = Roles::ALL,
                "api" => roles.api = true,
                "gateway" => roles.gateway = true,
                "media" => roles.media = true,
                "search" => roles.search = true,
                "embeds" => roles.embeds = true,
                "jobs" => roles.jobs = true,
                "web" => roles.web = true,
                "relay" => roles.relay = true,
                other => anyhow::bail!(
                    "unknown role {other} (expected all, api, gateway, media, search, embeds, jobs, web, relay)"
                ),
            }
        }
        match roles == Roles::NONE {
            true => anyhow::bail!("no roles given"),
            false => Ok(roles),
        }
    }

    pub fn splits_backend(&self) -> bool {
        let Roles {
            api,
            gateway,
            media,
            search,
            embeds,
            jobs,
            web: _,
            relay: _,
        } = *self;
        let backend = [api, gateway, media, search, embeds, jobs];
        backend.contains(&true) && backend.contains(&false)
    }

    pub fn names(&self) -> Vec<&'static str> {
        let Roles {
            api,
            gateway,
            media,
            search,
            embeds,
            jobs,
            web,
            relay,
        } = *self;
        [
            (api, "api"),
            (gateway, "gateway"),
            (media, "media"),
            (search, "search"),
            (embeds, "embeds"),
            (jobs, "jobs"),
            (web, "web"),
            (relay, "relay"),
        ]
        .into_iter()
        .filter_map(|(on, name)| on.then_some(name))
        .collect()
    }
}

#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct Secret(pub String);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret(..)")
    }
}

#[derive(Clone, Deserialize)]
pub struct AppConfig {
    pub app_mode: AppMode,
    pub host: String,
    pub server_port: u16,
    pub port: u16,
    pub server_proxy_url: Option<String>,
    pub database_url: Option<String>,
    pub rate_limit_per_second: u64,
    pub rate_limit_burst: u32,
    pub ws_connections_per_user: usize,
    pub ws_connect_burst: u32,
    pub ws_connects_per_minute: u32,
    pub ws_sockets_per_ip: usize,
    pub ws_guest_sockets_per_ip: usize,
    pub ws_guest_sockets_max: usize,
    pub s3_endpoint: Option<String>,
    pub s3_bucket: Option<String>,
    pub s3_access_key: Option<String>,
    pub s3_secret_key: Option<String>,
    pub s3_region: Option<String>,
    pub rchat_roles: Option<String>,
    pub redis_url: Option<String>,
    pub redis_prefix: String,
    pub redis_hub_maxlen: u64,
    pub trust_proxy: bool,
    pub trusted_proxies: Option<String>,
    pub instance_name: Option<String>,
    pub public_url: Option<String>,
    pub public_api_url: Option<String>,
    pub public_ws_url: Option<String>,
    pub public_peerjs_url: Option<String>,
    pub instance_signing_key: Option<Secret>,
    pub allowed_hosts: Option<String>,
    pub peerjs_port: Option<u16>,
    pub public_stun: bool,
    pub public_stun_count: u8,
    pub relay_enabled: bool,
    pub relay_turn: bool,
    pub relay_host: Option<String>,
    pub relay_port: u16,
    pub relay_public_ip: Option<String>,
    pub relay_min_port: u16,
    pub relay_max_port: u16,
    pub relay_allow_private: bool,
    pub relay_denied_peers: Option<String>,
    pub relay_user_allocations: u32,
    pub relay_max_allocations: Option<u32>,
    pub relay_user_kib_per_sec: u64,
    pub relay_max_kib_per_sec: u64,
    pub ice_servers: Option<String>,
    pub webhook_allowed_hosts: Option<String>,
    pub webhook_allow_http: bool,
    pub upload_budget_mib: u64,
    pub upload_buffer_mib: u64,
    #[serde(skip)]
    pub roles: Roles,
    #[serde(skip)]
    pub proxy_trust: ProxyTrust,
}

/// Prints no secrets: the S3 key, database and Redis URLs (passwords) and fixed ICE servers
/// (TURN credentials) are left out along with everything else.
impl std::fmt::Debug for AppConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppConfig")
            .field("app_mode", &self.app_mode)
            .field("host", &self.host)
            .field("server_port", &self.server_port)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl AppConfig {
    pub fn load(cli: &CliOverrides) -> anyhow::Result<Self> {
        Self::load_from(cli, None)
    }

    fn load_from(cli: &CliOverrides, env: Option<HashMap<String, String>>) -> anyhow::Result<Self> {
        let mut builder = config::Config::builder()
            .set_default("app_mode", "full")?
            .set_default("host", "127.0.0.1")?
            .set_default("server_port", 3000_i64)?
            .set_default("port", 3001_i64)?
            .set_default("rate_limit_per_second", 10_i64)?
            .set_default("rate_limit_burst", 60_i64)?
            .set_default("ws_connections_per_user", CONNS_PER_USER as i64)?
            .set_default("ws_connect_burst", i64::from(CONNECT_BURST))?
            .set_default("ws_connects_per_minute", i64::from(CONNECTS_PER_MINUTE))?
            .set_default("ws_sockets_per_ip", SOCKETS_PER_IP as i64)?
            .set_default("ws_guest_sockets_per_ip", GUESTS_PER_IP as i64)?
            .set_default("ws_guest_sockets_max", GUESTS_MAX as i64)?
            .set_default("redis_prefix", "rchat")?
            .set_default("redis_hub_maxlen", DEFAULT_HUB_MAXLEN as i64)?
            .set_default("trust_proxy", false)?
            .set_default("public_stun", false)?
            .set_default("public_stun_count", 3_i64)?
            .set_default("relay_enabled", false)?
            .set_default("relay_turn", true)?
            .set_default("relay_port", i64::from(crate::relay::DEFAULT_PORT))?
            .set_default("relay_min_port", i64::from(crate::relay::DEFAULT_MIN_PORT))?
            .set_default("relay_max_port", i64::from(crate::relay::DEFAULT_MAX_PORT))?
            .set_default("relay_allow_private", false)?
            .set_default("webhook_allow_http", false)?
            .set_default(
                "upload_budget_mib",
                crate::api::media::DEFAULT_BUDGET_MIB as i64,
            )?
            .set_default(
                "upload_buffer_mib",
                crate::api::media::DEFAULT_BUFFER_MIB as i64,
            )?
            .set_default(
                "relay_user_allocations",
                crate::relay::DEFAULT_USER_ALLOCATIONS as i64,
            )?
            .set_default(
                "relay_user_kib_per_sec",
                crate::relay::DEFAULT_USER_KIB_PER_SEC as i64,
            )?
            .set_default(
                "relay_max_kib_per_sec",
                crate::relay::DEFAULT_TOTAL_KIB_PER_SEC as i64,
            )?
            .add_source(config::Environment::default().source(env));

        if let Some(ref host) = cli.host {
            builder = builder.set_override("host", host.as_str())?;
        }
        if let Some(port) = cli.port {
            builder = builder.set_override("server_port", port as i64)?;
        }
        if let Some(ref mode) = cli.mode {
            builder = builder.set_override("app_mode", mode.as_str())?;
        }
        if let Some(ref roles) = cli.roles {
            builder = builder.set_override("rchat_roles", roles.as_str())?;
        }

        let mut config: AppConfig = builder.build()?.try_deserialize()?;
        config.roles = config.resolve_roles()?;
        if config.ws_connections_per_user == 0
            || config.ws_connect_burst == 0
            || config.ws_connects_per_minute == 0
            || config.ws_sockets_per_ip == 0
        {
            anyhow::bail!(
                "WS_CONNECTIONS_PER_USER, WS_CONNECT_BURST, WS_CONNECTS_PER_MINUTE and WS_SOCKETS_PER_IP must be at least 1"
            );
        }
        if config.redis_hub_maxlen < MIN_HUB_MAXLEN {
            anyhow::bail!("REDIS_HUB_MAXLEN must be at least {MIN_HUB_MAXLEN}");
        }
        config.check_shared_state()?;
        config.proxy_trust =
            ProxyTrust::from_config(config.trust_proxy, config.trusted_proxies.as_deref())?;
        if let Some(Secret(spec)) = &config.instance_signing_key
            && !spec.trim().is_empty()
        {
            crate::identity::Keyring::parse(spec)
                .map_err(|e| anyhow::anyhow!("INSTANCE_SIGNING_KEY: {e}"))?;
        }
        crate::instance::parse_allowed_hosts(config.allowed_hosts.as_deref().unwrap_or_default())?;
        config.ice()?;
        config.relay()?;
        config.outbound()?;
        if config.upload_buffer_mib < 32 {
            anyhow::bail!("UPLOAD_BUFFER_MIB must be at least 32");
        }
        Ok(config)
    }

    /// `UPLOAD_BUDGET_MIB` (most MiB of one account's files kept at once, 0 for no limit) and
    /// `UPLOAD_BUFFER_MIB` (most MiB of upload bodies in memory at once).
    pub fn upload_limits(&self) -> crate::api::media::UploadLimits {
        crate::api::media::UploadLimits {
            budget: self.upload_budget_mib.saturating_mul(1024 * 1024),
            buffer: self.upload_buffer_mib.saturating_mul(1024 * 1024),
        }
    }

    /// The rules for outgoing webhook requests: `WEBHOOK_ALLOWED_HOSTS` (comma-separated
    /// `host` or `host:port` that may be private addresses), `WEBHOOK_ALLOW_HTTP` (plain http
    /// for those hosts only), and the instance's own addresses and host names (`PUBLIC_URL`,
    /// `PUBLIC_API_URL`, `PUBLIC_WS_URL`, `PUBLIC_PEERJS_URL`, `ALLOWED_HOSTS`, `RELAY_HOST`,
    /// `RELAY_PUBLIC_IP`) refused like private ones. Link previews refuse the same addresses.
    ///
    /// Prefer `host:port` entries: a bare `host` opens every port of it, and an allowlisted
    /// domain skips the address check for whatever it resolves to, so whoever controls its DNS
    /// decides where requests go.
    pub fn outbound(&self) -> anyhow::Result<crate::api::webhooks::Outbound> {
        let mut own: Vec<IpAddr> = Vec::new();
        let mut own_hosts: Vec<String> = Vec::new();
        if let Some(ip) = self
            .relay_public_ip
            .as_deref()
            .and_then(|r| r.trim().parse::<IpAddr>().ok())
        {
            own.push(ip);
        }
        if let Ok(Some(host)) = self.relay_host() {
            match host.parse::<IpAddr>() {
                Ok(ip) => own.push(ip),
                Err(_) => own_hosts.push(host),
            }
        }
        if let Ok(hosts) =
            crate::instance::parse_allowed_hosts(self.allowed_hosts.as_deref().unwrap_or_default())
        {
            own_hosts.extend(hosts.into_iter().map(|h| h.name));
        }
        for raw in [
            &self.public_url,
            &self.public_api_url,
            &self.public_ws_url,
            &self.public_peerjs_url,
        ]
        .into_iter()
        .flatten()
        {
            if let Some(ip) = url::Url::parse(raw.trim())
                .ok()
                .and_then(|u| match u.host() {
                    Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
                    Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
                    Some(url::Host::Domain(d)) => {
                        own_hosts.push(d.to_string());
                        None
                    }
                    None => None,
                })
            {
                own.push(ip);
            }
        }
        crate::api::webhooks::Outbound::parse(
            self.webhook_allowed_hosts.as_deref().unwrap_or_default(),
            self.webhook_allow_http,
            own,
            own_hosts,
        )
    }

    fn relay_host(&self) -> anyhow::Result<Option<String>> {
        let Some(raw) = self
            .relay_host
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return Ok(None);
        };
        let bare = raw.trim_start_matches('[').trim_end_matches(']');
        let valid = bare.parse::<IpAddr>().is_ok()
            || url::Host::parse(bare).is_ok_and(|h| matches!(h, url::Host::Domain(_)))
                && !bare.contains(['/', ':', '@', '?', '#']);
        match valid {
            true => Ok(Some(bare.to_string())),
            false => anyhow::bail!("RELAY_HOST must be a host name or IP address, without a port"),
        }
    }

    /// The ICE servers this instance advertises.
    pub fn ice(&self) -> anyhow::Result<IceConfig> {
        let public_stun = match (self.public_stun, self.public_stun_count) {
            (false, _) => 0,
            (true, n @ 1..=4) => usize::from(n),
            (true, _) => anyhow::bail!("PUBLIC_STUN_COUNT must be 1 to 4"),
        };
        let relay = match self.relay_enabled {
            true => Some(RelayAdvert {
                host: self.relay_host()?,
                port: self.relay_port,
                turn: self.relay_turn,
            }),
            false => None,
        };
        Ok(IceConfig {
            public_stun,
            relay,
            extra: crate::relay::parse_ice_servers(
                self.ice_servers.as_deref().unwrap_or_default(),
            )?,
        })
    }

    /// The built-in relay to run in this process, when `RELAY_ENABLED` is on and this process
    /// has the `relay` role.
    pub fn relay(&self) -> anyhow::Result<Option<RelaySettings>> {
        if !self.relay_enabled {
            return Ok(None);
        }
        let public_ip = match self.relay_public_ip.as_deref().map(str::trim) {
            Some(raw) if !raw.is_empty() => Some(
                raw.parse::<IpAddr>()
                    .map_err(|_| anyhow::anyhow!("RELAY_PUBLIC_IP must be an IP address"))?,
            ),
            Some(_) | None => None,
        };
        if self.relay_turn && public_ip.is_none() {
            anyhow::bail!(
                "RELAY_TURN needs RELAY_PUBLIC_IP, the address clients reach the relay on; set it or set RELAY_TURN=false for STUN only"
            );
        }
        if self.relay_port == 0
            || self.relay_min_port == 0
            || self.relay_min_port > self.relay_max_port
        {
            anyhow::bail!("RELAY_PORT must be set and RELAY_MIN_PORT..RELAY_MAX_PORT a port range");
        }
        if (self.relay_min_port..=self.relay_max_port).contains(&self.relay_port) {
            anyhow::bail!("RELAY_PORT must be outside RELAY_MIN_PORT..RELAY_MAX_PORT");
        }
        let ports = u32::from(self.relay_max_port - self.relay_min_port) + 1;
        let total = self.relay_max_allocations.unwrap_or(ports);
        if total == 0 || total > ports {
            anyhow::bail!(
                "RELAY_MAX_ALLOCATIONS must be 1 to the size of RELAY_MIN_PORT..RELAY_MAX_PORT ({ports}); each allocation takes one port"
            );
        }
        if self.relay_user_allocations == 0 || self.relay_user_allocations > total {
            anyhow::bail!("RELAY_USER_ALLOCATIONS must be 1 to RELAY_MAX_ALLOCATIONS ({total})");
        }
        if self.relay_user_kib_per_sec == 0
            || self.relay_max_kib_per_sec < self.relay_user_kib_per_sec
        {
            anyhow::bail!(
                "RELAY_USER_KIB_PER_SEC must be at least 1 and RELAY_MAX_KIB_PER_SEC at least RELAY_USER_KIB_PER_SEC"
            );
        }
        let denied = self
            .relay_denied_peers
            .as_deref()
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|spec| {
                Cidr::parse(spec).ok_or_else(|| {
                    anyhow::anyhow!(
                        "RELAY_DENIED_PEERS entry {spec:?} is not an IP address or CIDR range (for example 198.51.100.0/24)"
                    )
                })
            })
            .collect::<anyhow::Result<Vec<Cidr>>>()?;
        if !self.roles.relay {
            return Ok(None);
        }
        let any: IpAddr = match public_ip {
            Some(IpAddr::V6(_)) => std::net::Ipv6Addr::UNSPECIFIED.into(),
            Some(IpAddr::V4(_)) | None => std::net::Ipv4Addr::UNSPECIFIED.into(),
        };
        Ok(Some(RelaySettings {
            bind: SocketAddr::new(any, self.relay_port),
            turn: self.relay_turn,
            public_ip,
            min_port: self.relay_min_port,
            max_port: self.relay_max_port,
            allow_private: self.relay_allow_private,
            denied,
            capacity: Capacity {
                user_allocations: self.relay_user_allocations as usize,
                total_allocations: total as usize,
                user_bytes_per_sec: self.relay_user_kib_per_sec as f64 * 1024.0,
                total_bytes_per_sec: self.relay_max_kib_per_sec as f64 * 1024.0,
            },
            limits: Limits::default(),
        }))
    }

    fn check_shared_state(&self) -> anyhow::Result<()> {
        let shared = [
            ("DATABASE_URL", &self.database_url),
            ("REDIS_URL", &self.redis_url),
        ];
        for (name, value) in shared {
            if value.as_deref().is_some_and(|v| v.trim().is_empty()) {
                anyhow::bail!("{name} is set but empty: give it a value or unset it");
            }
        }
        let postgres = self
            .database_url
            .as_deref()
            .map(str::trim)
            .is_some_and(|u| u.starts_with("postgres://") || u.starts_with("postgresql://"));
        if self.relay_enabled && self.roles.relay && !self.roles.api && !postgres {
            anyhow::bail!(
                "RCHAT_ROLES={} runs the relay without the api role, so it must share the relay secret with the api processes through one Postgres (DATABASE_URL=postgres://...)",
                self.roles.names().join(",")
            );
        }
        if self.relay_enabled && self.roles.relay && !self.roles.api && self.redis_url.is_none() {
            anyhow::bail!(
                "RCHAT_ROLES={} runs the relay without the api role, so it learns about site bans and account deletions only through the shared Redis bus; set REDIS_URL to the one the api processes use",
                self.roles.names().join(",")
            );
        }
        if !self.roles.splits_backend() {
            return Ok(());
        }
        let roles = self.roles.names().join(",");
        match (postgres, &self.redis_url) {
            (true, Some(_)) => Ok(()),
            (_, _) => anyhow::bail!(
                "RCHAT_ROLES={roles} runs only part of the backend, so the other roles run in other processes that must share one Postgres (DATABASE_URL=postgres://...) and one Redis (REDIS_URL); set both, or run RCHAT_ROLES=all"
            ),
        }
    }

    fn resolve_roles(&self) -> anyhow::Result<Roles> {
        match self.rchat_roles.as_deref().map(str::trim) {
            Some(spec) if !spec.is_empty() => Roles::parse(spec),
            Some(_) | None => Ok(match self.app_mode {
                AppMode::Full => Roles::ALL,
                AppMode::ApiOnly => Roles {
                    web: false,
                    ..Roles::ALL
                },
            }),
        }
    }

    pub fn instance(&self) -> InstanceConfig {
        InstanceConfig {
            name: self.instance_name.clone(),
            public_url: self.public_url.clone(),
            api_url: self.public_api_url.clone(),
            ws_url: self.public_ws_url.clone(),
            peerjs_url: self.public_peerjs_url.clone(),
            signing_key: self
                .instance_signing_key
                .as_ref()
                .map(|Secret(s)| s.clone()),
            allowed_hosts: self.allowed_hosts.clone(),
            peerjs_port: self.peerjs_port,
            proxy_trust: self.proxy_trust.clone(),
            ice: self.ice().unwrap_or_default(),
        }
    }

    /// Per-user realtime connection limits.
    pub fn ws_limits(&self) -> WsLimits {
        WsLimits {
            conns_per_user: self.ws_connections_per_user,
            connect_burst: self.ws_connect_burst,
            connect_every: Duration::from_secs(60) / self.ws_connects_per_minute,
            sockets_per_ip: self.ws_sockets_per_ip,
            guests_per_ip: self.ws_guest_sockets_per_ip,
            guests_max: self.ws_guest_sockets_max,
        }
    }

    #[cfg(test)]
    pub(crate) fn defaults() -> AppConfig {
        let cli = CliOverrides {
            host: None,
            port: None,
            mode: None,
            roles: None,
        };
        AppConfig::load_from(&cli, Some(HashMap::new())).expect("default config")
    }

    pub fn s3(&self) -> anyhow::Result<Option<Arc<Bucket>>> {
        match (
            &self.s3_endpoint,
            &self.s3_bucket,
            &self.s3_access_key,
            &self.s3_secret_key,
        ) {
            (Some(endpoint), Some(bucket), Some(access), Some(secret)) => {
                let region = Region::Custom {
                    region: self.s3_region.clone().unwrap_or_else(|| "us-east-1".into()),
                    endpoint: endpoint.clone(),
                };
                let creds = Credentials::new(Some(access), Some(secret), None, None, None)?;
                Ok(Some(Arc::from(
                    Bucket::new(bucket, region, creds)?.with_path_style(),
                )))
            }
            (None, None, None, None) => Ok(None),
            _ => anyhow::bail!(
                "S3 requires all of S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY"
            ),
        }
    }

    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.server_port)
    }

    pub fn proxy_url(&self) -> Option<Arc<str>> {
        match self.roles.web {
            true => {
                let url = self
                    .server_proxy_url
                    .clone()
                    .unwrap_or_else(|| format!("http://127.0.0.1:{}", self.port));
                Some(Arc::from(url.as_str()))
            }
            false => None,
        }
    }
}

#[derive(Debug, clap::Parser)]
#[command(name = "rust-next", about = "Rust + Next.js server")]
pub struct CliOverrides {
    #[arg(long, short = 'H', help = "Server host")]
    pub host: Option<String>,

    #[arg(long, short = 'p', help = "Server port")]
    pub port: Option<u16>,

    #[arg(long, short = 'm', help = "App mode (full, api-only)")]
    pub mode: Option<String>,

    #[arg(
        long,
        help = "Service roles: all, or a comma list of api, gateway, media, search, embeds, jobs, web, relay"
    )]
    pub roles: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_parse() {
        assert_eq!(Roles::parse("all").unwrap(), Roles::ALL);
        assert_eq!(Roles::parse("api, web,all").unwrap(), Roles::ALL);
        let split = Roles::parse("Gateway,embeds").unwrap();
        assert_eq!(split.names(), vec!["gateway", "embeds"]);
        assert!(Roles::parse("api,nope").is_err());
        assert!(Roles::parse(" , ").is_err());
    }

    fn cli(mode: Option<&str>, roles: Option<&str>) -> CliOverrides {
        CliOverrides {
            host: None,
            port: None,
            mode: mode.map(str::to_string),
            roles: roles.map(str::to_string),
        }
    }

    fn env(pairs: &[(&str, &str)]) -> Option<HashMap<String, String>> {
        Some(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    const SHARED: [(&str, &str); 2] = [
        ("DATABASE_URL", "postgres://rchat:pw@db:5432/rchat"),
        ("REDIS_URL", "redis://:pw@valkey:6379"),
    ];

    #[test]
    fn ws_limits_default_and_load_from_env() {
        let config = AppConfig::load_from(&cli(None, None), env(&[])).unwrap();
        assert_eq!(config.ws_limits(), WsLimits::default());
        let set = [
            ("WS_CONNECTIONS_PER_USER", "5"),
            ("WS_CONNECT_BURST", "4"),
            ("WS_CONNECTS_PER_MINUTE", "12"),
            ("WS_SOCKETS_PER_IP", "30"),
            ("WS_GUEST_SOCKETS_PER_IP", "0"),
            ("WS_GUEST_SOCKETS_MAX", "7"),
        ];
        let limits = AppConfig::load_from(&cli(None, None), env(&set))
            .unwrap()
            .ws_limits();
        assert_eq!(
            limits,
            WsLimits {
                conns_per_user: 5,
                connect_burst: 4,
                connect_every: Duration::from_secs(5),
                sockets_per_ip: 30,
                guests_per_ip: 0,
                guests_max: 7,
            }
        );
        assert!(
            AppConfig::load_from(&cli(None, None), env(&[("WS_CONNECTIONS_PER_USER", "0")]))
                .is_err()
        );
    }

    #[test]
    fn roles_fallback_to_app_mode() {
        let config = AppConfig::load_from(&cli(Some("api-only"), None), env(&[])).unwrap();
        assert!(!config.roles.web && config.roles.api && config.roles.jobs);
        assert!(config.proxy_url().is_none());
        let config = AppConfig::load_from(&cli(None, None), env(&[])).unwrap();
        assert_eq!(config.roles, Roles::ALL);
        let config =
            AppConfig::load_from(&cli(Some("api-only"), Some("web,gateway")), env(&SHARED))
                .unwrap();
        assert_eq!(config.roles.names(), vec!["gateway", "web"]);
        assert!(config.proxy_url().is_some());
        let mut set = env(&SHARED).unwrap();
        set.insert("RCHAT_ROLES".to_string(), "search".to_string());
        set.insert("APP_MODE".to_string(), "api-only".to_string());
        let config = AppConfig::load_from(&cli(None, None), Some(set.clone())).unwrap();
        assert_eq!(config.roles.names(), vec!["search"]);
        let config = AppConfig::load_from(&cli(None, Some("jobs")), Some(set)).unwrap();
        assert_eq!(config.roles.names(), vec!["jobs"]);
    }

    #[test]
    fn split_backends_need_shared_state() {
        let load = |roles: &str, pairs: &[(&str, &str)]| {
            let mut set = env(pairs).unwrap();
            set.insert("RCHAT_ROLES".to_string(), roles.to_string());
            AppConfig::load_from(&cli(None, None), Some(set))
        };
        for roles in [
            "api",
            "gateway,embeds",
            "web,jobs",
            "api,gateway,media,search,embeds",
        ] {
            assert!(load(roles, &[]).is_err(), "{roles}");
            assert!(
                load(roles, &SHARED[1..]).is_err(),
                "{roles} without DATABASE_URL"
            );
            assert!(
                load(roles, &SHARED[..1]).is_err(),
                "{roles} without REDIS_URL"
            );
            let sqlite = [("DATABASE_URL", "/data/rchat.db"), SHARED[1]];
            assert!(load(roles, &sqlite).is_err(), "{roles} on sqlite");
            assert!(load(roles, &SHARED).is_ok(), "{roles}");
        }
        for roles in [
            "all",
            "web",
            "api,gateway,media,search,embeds,jobs",
            "web,api,gateway,media,search,embeds,jobs",
        ] {
            assert!(load(roles, &[]).is_ok(), "{roles}");
        }
        let err = load("api", &[]).unwrap_err().to_string();
        assert!(
            err.contains("RCHAT_ROLES=api") && err.contains("REDIS_URL"),
            "{err}"
        );
    }

    #[test]
    fn empty_shared_urls_fail() {
        for name in ["DATABASE_URL", "REDIS_URL"] {
            for value in ["", "  "] {
                let err = AppConfig::load_from(&cli(None, None), env(&[(name, value)]))
                    .unwrap_err()
                    .to_string();
                assert!(err.contains(name) && err.contains("empty"), "{err}");
            }
        }
    }

    #[test]
    fn proxy_trust_is_resolved() {
        let load = |pairs: &[(&str, &str)]| AppConfig::load_from(&cli(None, None), env(pairs));
        assert_eq!(load(&[]).unwrap().proxy_trust, ProxyTrust::Peer);
        assert_eq!(
            load(&[("TRUST_PROXY", "true")]).unwrap().proxy_trust,
            ProxyTrust::Any
        );
        let listed = load(&[("TRUST_PROXY", "true"), ("TRUSTED_PROXIES", "10.0.0.0/8")]).unwrap();
        assert!(matches!(listed.proxy_trust, ProxyTrust::Listed(_)));
        assert!(load(&[("TRUSTED_PROXIES", "REPLACE-ME")]).is_err());
    }

    #[test]
    fn hub_maxlen_is_configurable() {
        let config = AppConfig::load_from(&cli(None, None), env(&[])).unwrap();
        assert_eq!(config.redis_hub_maxlen, DEFAULT_HUB_MAXLEN);
        let set = env(&[("REDIS_HUB_MAXLEN", "250000")]);
        let config = AppConfig::load_from(&cli(None, None), set).unwrap();
        assert_eq!(config.redis_hub_maxlen, 250_000);
        let low = env(&[("REDIS_HUB_MAXLEN", "10")]);
        assert!(AppConfig::load_from(&cli(None, None), low).is_err());
    }

    #[test]
    fn upload_limits_default_and_parse() {
        let load = |pairs: &[(&str, &str)]| AppConfig::load_from(&cli(None, None), env(pairs));
        let limits = load(&[]).unwrap().upload_limits();
        assert_eq!(limits.budget, 2048 * 1024 * 1024);
        assert_eq!(limits.buffer, 256 * 1024 * 1024);
        let set = load(&[("UPLOAD_BUDGET_MIB", "0"), ("UPLOAD_BUFFER_MIB", "64")])
            .unwrap()
            .upload_limits();
        assert_eq!((set.budget, set.buffer), (0, 64 * 1024 * 1024));
        assert!(load(&[("UPLOAD_BUFFER_MIB", "8")]).is_err());
        let config = load(&[
            ("S3_SECRET_KEY", "s3-hunter2"),
            ("DATABASE_URL", "postgres://u:pg-hunter2@db/x"),
            ("REDIS_URL", "redis://:redis-hunter2@r:6379"),
        ])
        .unwrap();
        assert!(!format!("{config:?}").contains("hunter2"));
    }

    #[test]
    fn previews_and_webhooks_refuse_every_own_host() {
        let load = |pairs: &[(&str, &str)]| AppConfig::load_from(&cli(None, None), env(pairs));
        let outbound = load(&[
            ("PUBLIC_URL", "https://chat.example.org"),
            ("PUBLIC_WS_URL", "wss://ws.example.org"),
            ("PUBLIC_PEERJS_URL", "https://peer.example.org"),
            ("ALLOWED_HOSTS", "alt.example.org:8443"),
            ("RELAY_HOST", "relay.example.org"),
            ("RELAY_PUBLIC_IP", "203.0.113.10"),
        ])
        .unwrap()
        .outbound()
        .unwrap();
        for host in [
            "chat.example.org",
            "ws.example.org",
            "peer.example.org",
            "alt.example.org",
            "relay.example.org",
        ] {
            assert!(outbound.own_hosts.iter().any(|h| h == host), "{host}");
        }
        assert!(outbound.own.contains(&"203.0.113.10".parse().unwrap()));
    }

    #[test]
    fn relays_are_off_by_default_and_validated() {
        let load = |pairs: &[(&str, &str)]| AppConfig::load_from(&cli(None, None), env(pairs));
        let config = load(&[]).unwrap();
        assert_eq!(config.ice().unwrap(), IceConfig::default());
        assert_eq!(config.relay().unwrap(), None);
        let public = load(&[("PUBLIC_STUN", "true")]).unwrap();
        assert_eq!(public.ice().unwrap().public_stun, 3);
        for bad in ["0", "5"] {
            assert!(load(&[("PUBLIC_STUN", "true"), ("PUBLIC_STUN_COUNT", bad)]).is_err());
        }
        assert_eq!(
            load(&[("PUBLIC_STUN_COUNT", "9")])
                .unwrap()
                .ice()
                .unwrap()
                .public_stun,
            0
        );
        let err = load(&[("RELAY_ENABLED", "true")]).unwrap_err().to_string();
        assert!(err.contains("RELAY_PUBLIC_IP"), "{err}");
        let stun_only = load(&[("RELAY_ENABLED", "true"), ("RELAY_TURN", "false")]).unwrap();
        let settings = stun_only.relay().unwrap().expect("relay runs");
        assert!(!settings.turn && settings.public_ip.is_none());
        assert_eq!(settings.bind.port(), crate::relay::DEFAULT_PORT);
        let relay = load(&[
            ("RELAY_ENABLED", "true"),
            ("RELAY_PUBLIC_IP", "203.0.113.7"),
            ("RELAY_HOST", "relay.example.com"),
        ])
        .unwrap();
        let settings = relay.relay().unwrap().expect("relay runs");
        assert_eq!(settings.public_ip, Some("203.0.113.7".parse().unwrap()));
        assert_eq!((settings.min_port, settings.max_port), (49160, 49415));
        assert_eq!(
            (
                settings.capacity.user_allocations,
                settings.capacity.total_allocations
            ),
            (16, 256)
        );
        assert!(settings.denied.is_empty());
        assert!(!settings.allow_private);
        let advert = relay.ice().unwrap().relay.expect("advertised");
        assert_eq!(advert.host.as_deref(), Some("relay.example.com"));
        assert!(advert.turn);
        for (key, value) in [
            ("RELAY_PUBLIC_IP", "relay.example.com"),
            ("RELAY_HOST", "https://relay.example.com"),
            ("RELAY_HOST", "relay.example.com:3478"),
            ("RELAY_MIN_PORT", "50000"),
            ("RELAY_PORT", "49170"),
            ("ICE_SERVERS", "not json"),
            ("ICE_SERVERS", r#"[{"urls":"https://x"}]"#),
            ("RELAY_DENIED_PEERS", "203.0.113.0/40"),
            ("RELAY_DENIED_PEERS", "::ffff:0:0/95"),
            ("RELAY_DENIED_PEERS", "node.example.com"),
            ("RELAY_MAX_ALLOCATIONS", "0"),
            ("RELAY_MAX_ALLOCATIONS", "257"),
            ("RELAY_USER_ALLOCATIONS", "0"),
            ("RELAY_USER_ALLOCATIONS", "300"),
            ("RELAY_USER_KIB_PER_SEC", "0"),
            ("RELAY_MAX_KIB_PER_SEC", "10"),
        ] {
            let mut pairs = vec![
                ("RELAY_ENABLED", "true"),
                ("RELAY_PUBLIC_IP", "203.0.113.7"),
            ];
            pairs.retain(|(k, _)| *k != key);
            pairs.push((key, value));
            assert!(load(&pairs).is_err(), "{key}={value}");
        }
        let sized = load(&[
            ("RELAY_ENABLED", "true"),
            ("RELAY_PUBLIC_IP", "203.0.113.7"),
            ("RELAY_MIN_PORT", "50000"),
            ("RELAY_MAX_PORT", "50999"),
            ("RELAY_MAX_ALLOCATIONS", "600"),
            ("RELAY_USER_ALLOCATIONS", "24"),
            ("RELAY_USER_KIB_PER_SEC", "512"),
            ("RELAY_MAX_KIB_PER_SEC", "4096"),
            (
                "RELAY_DENIED_PEERS",
                " 198.51.100.0/24, 2001:db8::/32 ,203.0.113.99",
            ),
        ])
        .unwrap()
        .relay()
        .unwrap()
        .expect("relay runs");
        assert_eq!(
            sized.capacity,
            crate::relay::Capacity {
                user_allocations: 24,
                total_allocations: 600,
                user_bytes_per_sec: 512.0 * 1024.0,
                total_bytes_per_sec: 4096.0 * 1024.0,
            }
        );
        assert_eq!(sized.denied.len(), 3);
        let mapped = load(&[
            ("RELAY_ENABLED", "true"),
            ("RELAY_PUBLIC_IP", "203.0.113.7"),
            (
                "RELAY_DENIED_PEERS",
                "::ffff:198.51.100.0/120,::FFFF:203.0.113.5",
            ),
        ])
        .unwrap()
        .relay()
        .unwrap()
        .expect("relay runs");
        assert_eq!(
            mapped.denied,
            vec![
                Cidr::parse("198.51.100.0/24").unwrap(),
                Cidr::parse("203.0.113.5/32").unwrap()
            ],
            "IPv4-mapped entries become IPv4 ranges"
        );
        assert!(mapped.denied[0].contains("198.51.100.200".parse().unwrap()));
        assert!(mapped.denied[0].contains("::ffff:198.51.100.200".parse().unwrap()));
        assert!(!mapped.denied[0].contains("198.51.101.1".parse().unwrap()));
        assert!(sized.denied[2].contains("203.0.113.99".parse().unwrap()));
        assert!(!sized.denied[2].contains("203.0.113.98".parse().unwrap()));
        let extra = load(&[("ICE_SERVERS", r#"[{"urls":"stun:stun.example.org"}]"#)]).unwrap();
        assert_eq!(extra.ice().unwrap().extra.len(), 1);
    }

    #[test]
    fn relay_role_runs_the_relay() {
        let load = |roles: &str, pairs: &[(&str, &str)]| {
            let mut set = env(pairs).unwrap();
            set.insert("RCHAT_ROLES".to_string(), roles.to_string());
            set.insert("RELAY_ENABLED".to_string(), "true".to_string());
            set.insert("RELAY_TURN".to_string(), "false".to_string());
            AppConfig::load_from(&cli(None, None), Some(set))
        };
        assert!(Roles::parse("relay").unwrap().relay);
        assert!(Roles::ALL.relay && !Roles::ALL.splits_backend());
        assert!(
            !Roles::parse("api,gateway,media,search,embeds,jobs")
                .unwrap()
                .splits_backend()
        );
        assert!(load("all", &[]).unwrap().relay().unwrap().is_some());
        let err = load("relay", &[]).unwrap_err().to_string();
        assert!(err.contains("Postgres"), "{err}");
        let err = load("relay", &SHARED[..1]).unwrap_err().to_string();
        assert!(err.contains("REDIS_URL"), "{err}");
        let alone = load("relay", &SHARED).unwrap();
        assert!(alone.relay().unwrap().is_some());
        assert!(
            load("relay", &SHARED[1..]).is_err(),
            "still needs the Postgres"
        );
        assert!(
            load("api,gateway,media,search,embeds,jobs,relay", &SHARED[..1]).is_ok(),
            "with the api role the bans happen in-process"
        );
        let without = load("api,gateway,media,search,embeds,jobs,web", &[]).unwrap();
        assert!(
            without.relay().unwrap().is_none(),
            "no relay role, no relay"
        );
        assert!(without.ice().unwrap().relay.is_some(), "still advertised");
    }
}
