use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use s3::creds::Credentials;
use s3::{Bucket, Region};
use serde::Deserialize;

use crate::api::controls::ControlSeeds;
use crate::db::DbOptions;
use crate::instance::InstanceConfig;
use crate::limits::Limits;
use crate::relay::{Capacity, Cidr, IceConfig, Limits as RelayLimits, RelayAdvert, RelaySettings};
use crate::server::client_ip::ProxyTrust;

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
    pub sfu: bool,
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
        sfu: true,
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
        sfu: false,
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
                "sfu" => roles.sfu = true,
                other => anyhow::bail!(
                    "unknown role {other} (expected all, api, gateway, media, search, embeds, jobs, web, relay, sfu)"
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
            sfu: _,
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
            sfu,
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
            (sfu, "sfu"),
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
    pub s3_endpoint: Option<String>,
    pub s3_bucket: Option<String>,
    pub s3_access_key: Option<String>,
    pub s3_secret_key: Option<String>,
    pub s3_region: Option<String>,
    pub rchat_roles: Option<String>,
    pub redis_url: Option<String>,
    pub redis_prefix: String,
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
    pub ice_servers: Option<String>,
    pub webhook_allowed_hosts: Option<String>,
    pub webhook_allow_http: bool,
    #[serde(skip)]
    pub roles: Roles,
    #[serde(skip)]
    pub proxy_trust: ProxyTrust,
    #[serde(skip)]
    pub limits: Limits,
    #[serde(skip)]
    pub secrets: Secrets,
    #[serde(skip)]
    pub controls: ControlSeeds,
    #[serde(skip)]
    pub swagger_ui: Option<String>,
    /// The PeerJS port the web build dials on the page's host (`NEXT_PUBLIC_PEERJS_PORT` without
    /// `NEXT_PUBLIC_PEERJS_HOST`), when this process is told.
    #[serde(skip)]
    pub web_peerjs_port: Option<u16>,
}

/// Secrets from `NAME` or the file named by `NAME_FILE`, resolved like `env_secret`.
#[derive(Clone, Default)]
pub struct Secrets {
    pub password_pepper: Option<String>,
    pub relay_secret: Option<String>,
    pub p2p_secret: Option<String>,
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secrets").finish_non_exhaustive()
    }
}

fn lookup(env: &Option<HashMap<String, String>>, name: &str) -> Option<String> {
    match env {
        Some(env) => env.get(name).cloned(),
        None => std::env::var(name).ok(),
    }
}

fn secret(env: &Option<HashMap<String, String>>, name: &str) -> Option<String> {
    let direct = lookup(env, name).filter(|v| !v.trim().is_empty());
    let file = lookup(env, &format!("{name}_FILE"))
        .filter(|p| !p.trim().is_empty())
        .and_then(|p| match std::fs::read_to_string(p.trim()) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::error!("{name}_FILE can not be read: {e}");
                None
            }
        });
    direct
        .or(file)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// A secret from the environment: `NAME`, or the contents of the file named by `NAME_FILE`.
/// Blank values count as unset.
pub fn env_secret(name: &str) -> Option<String> {
    secret(&None, name)
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

/// An env for `AppConfig::from_map`: a map, or pairs of name and value.
pub trait EnvPairs {
    fn into_env(self) -> HashMap<String, String>;
}

impl EnvPairs for HashMap<String, String> {
    fn into_env(self) -> HashMap<String, String> {
        self
    }
}

impl EnvPairs for &[(&str, &str)] {
    fn into_env(self) -> HashMap<String, String> {
        self.iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }
}

impl<const N: usize> EnvPairs for &[(&str, &str); N] {
    fn into_env(self) -> HashMap<String, String> {
        self.as_slice().into_env()
    }
}

impl AppConfig {
    pub fn load(cli: &CliOverrides) -> anyhow::Result<Self> {
        Self::load_from(cli, None)
    }

    /// The configuration from `env` (the names of `.env.local.example`) alone, given as a map or
    /// as pairs: the process environment is not read.
    pub fn from_map(env: impl EnvPairs) -> anyhow::Result<Self> {
        let cli = CliOverrides {
            host: None,
            port: None,
            mode: None,
            roles: None,
        };
        Self::load_from(&cli, Some(env.into_env()))
    }

    fn load_from(cli: &CliOverrides, env: Option<HashMap<String, String>>) -> anyhow::Result<Self> {
        let mut builder = config::Config::builder()
            .set_default("app_mode", "full")?
            .set_default("host", "127.0.0.1")?
            .set_default("server_port", 3000_i64)?
            .set_default("port", 3001_i64)?
            .set_default("redis_prefix", "rchat")?
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
            .add_source(config::Environment::default().source(env.clone()));

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
        config.limits = Limits::load(&|name| lookup(&env, name))?;
        config.secrets = Secrets {
            password_pepper: secret(&env, "PASSWORD_PEPPER"),
            relay_secret: secret(&env, "RELAY_SECRET"),
            p2p_secret: secret(&env, "P2P_SECRET"),
        };
        config.controls = ControlSeeds::load(&|name| lookup(&env, name))?;
        config.swagger_ui = lookup(&env, "SWAGGER_UI");
        let set = |name: &str| lookup(&env, name).filter(|v| !v.trim().is_empty());
        config.web_peerjs_port = match set("NEXT_PUBLIC_PEERJS_HOST") {
            Some(_) => None,
            None => set("NEXT_PUBLIC_PEERJS_PORT")
                .and_then(|port| port.trim().parse::<u16>().ok())
                .filter(|port| *port != 0),
        };
        config.roles = config.resolve_roles()?;
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
        Ok(config)
    }

    /// `UPLOAD_BUDGET_MIB` (most MiB of one account's files kept at once, 0 for no limit) and
    /// `UPLOAD_BUFFER_MIB` (most MiB of upload bodies in memory at once).
    pub fn upload_limits(&self) -> crate::api::media::UploadLimits {
        crate::api::media::UploadLimits {
            budget: self.limits.upload_budget_mib.saturating_mul(1024 * 1024),
            buffer: self.limits.upload_buffer_mib.saturating_mul(1024 * 1024),
        }
    }

    /// The warning to log at start when this process serves PeerJS signaling and may be one of
    /// several.
    pub fn peerjs_warning(&self) -> Option<&'static str> {
        (self.limits.peerjs_builtin && self.redis_url.is_some()).then_some(
            "PEERJS_BUILTIN is on and REDIS_URL is set, so this may be one of several processes; built-in PeerJS signaling is per process, so send /peerjs to exactly one of them, or run the separate PeerJS server and set PEERJS_BUILTIN=false",
        )
    }

    /// The PeerJS signaling this process serves at `/peerjs`, unless `PEERJS_BUILTIN` is off, with
    /// `PEERJS_PEERS_PER_IP` and `PEERJS_CONCURRENT_LIMIT`.
    pub fn peerjs(&self) -> Option<crate::peerjs::Settings> {
        self.limits.peerjs_builtin.then(|| crate::peerjs::Settings {
            peers_per_ip: self.limits.peerjs_peers_per_ip,
            concurrent_limit: self.limits.peerjs_concurrent_limit,
            ..crate::peerjs::Settings::default()
        })
    }

    /// What the database layer reads at open: the limits, the pepper and the controls the env
    /// sets and pins.
    pub fn db_options(&self) -> DbOptions {
        DbOptions {
            limits: self.limits.clone(),
            pepper: self.secrets.password_pepper.clone(),
            controls: Some(self.controls.clone()),
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
        let total = self.limits.relay_max_allocations.unwrap_or(ports);
        if total == 0 || total > ports {
            anyhow::bail!(
                "RELAY_MAX_ALLOCATIONS must be 1 to the size of RELAY_MIN_PORT..RELAY_MAX_PORT ({ports}); each allocation takes one port"
            );
        }
        if self.limits.relay_user_allocations == 0 || self.limits.relay_user_allocations > total {
            anyhow::bail!("RELAY_USER_ALLOCATIONS must be 1 to RELAY_MAX_ALLOCATIONS ({total})");
        }
        if self.limits.relay_user_kib_per_sec == 0
            || self.limits.relay_max_kib_per_sec < self.limits.relay_user_kib_per_sec
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
                user_allocations: self.limits.relay_user_allocations as usize,
                total_allocations: total as usize,
                user_bytes_per_sec: self.limits.relay_user_kib_per_sec as f64 * 1024.0,
                total_bytes_per_sec: self.limits.relay_max_kib_per_sec as f64 * 1024.0,
            },
            limits: RelayLimits::default(),
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
            relay_secret: self.secrets.relay_secret.clone(),
            p2p_secret: self.secrets.p2p_secret.clone(),
            allowed_hosts: self.allowed_hosts.clone(),
            peerjs_port: self.peerjs_port.or(self.web_peerjs_port),
            proxy_trust: self.proxy_trust.clone(),
            ice: self.ice().unwrap_or_default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn defaults() -> AppConfig {
        AppConfig::from_map(HashMap::new()).expect("default config")
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
        help = "Service roles: all, or a comma list of api, gateway, media, search, embeds, jobs, web, relay, sfu"
    )]
    pub roles: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::api::controls::ControlSeeds;
    use crate::hub::Limits as WsLimits;

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
        assert_eq!(config.limits.ws_limits(), WsLimits::default());
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
            .limits
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
                voice_room_max: crate::ws::VOICE_ROOM_MAX,
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
        assert_eq!(
            config.limits.redis_hub_maxlen,
            crate::bus::DEFAULT_HUB_MAXLEN
        );
        let set = env(&[("REDIS_HUB_MAXLEN", "250000")]);
        let config = AppConfig::load_from(&cli(None, None), set).unwrap();
        assert_eq!(config.limits.redis_hub_maxlen, 250_000);
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
    fn a_map_is_the_whole_configuration() {
        let map = |pairs: &[(&str, &str)]| AppConfig::from_map(env(pairs).unwrap_or_default());
        let config = map(&[
            ("APP_MODE", "api-only"),
            ("HOST", "0.0.0.0"),
            ("SERVER_PORT", "3470"),
            ("DATABASE_URL", "sqlite:///data/rchat.db?mode=rwc"),
            ("INSTANCE_NAME", "My server"),
            ("UPLOAD_BUDGET_MIB", "64"),
            ("PASSWORD_PEPPER", "pepper"),
        ])
        .unwrap();
        assert_eq!(config.addr(), "0.0.0.0:3470");
        assert!(!config.roles.web && config.roles.api);
        assert_eq!(config.proxy_url(), None);
        assert_eq!(
            config.database_url.as_deref(),
            Some("sqlite:///data/rchat.db?mode=rwc")
        );
        assert_eq!(config.instance_name.as_deref(), Some("My server"));
        assert_eq!(config.limits.upload_budget_mib, 64);
        assert_eq!(config.secrets.password_pepper.as_deref(), Some("pepper"));
        let unset = map(&[]).unwrap();
        assert_eq!(unset.addr(), "127.0.0.1:3000");
        assert_eq!(unset.roles, Roles::ALL);
        assert_eq!(unset.limits, Limits::default());
        let refused = map(&[("UPLOAD_BUDGET_MIB", "-1")]).unwrap_err().to_string();
        assert!(
            refused.starts_with("UPLOAD_BUDGET_MIB: expected "),
            "{refused}"
        );
        assert!(refused.is_ascii());
        assert!(map(&[("SERVER_PORT", "70000")]).is_err());
    }

    #[test]
    fn built_in_peerjs_is_on_by_default_and_takes_the_peerjs_limits() {
        let load = |pairs: &[(&str, &str)]| AppConfig::load_from(&cli(None, None), env(pairs));
        let default = load(&[]).unwrap();
        assert_eq!(default.peerjs(), Some(crate::peerjs::Settings::default()));
        assert_eq!(default.instance().peerjs_port, None);
        assert_eq!(default.peerjs_warning(), None);
        for off in ["off", "false", "0"] {
            assert_eq!(load(&[("PEERJS_BUILTIN", off)]).unwrap().peerjs(), None);
        }
        let on = load(&[("PEERJS_BUILTIN", "on"), ("PEERJS_PORT", "9100")]).unwrap();
        assert_eq!(on.peerjs(), Some(crate::peerjs::Settings::default()));
        assert_eq!(on.instance().peerjs_port, Some(9100));
        // A web build that was given its own PeerJS port dials it: the instance names it too.
        let port = |pairs: &[(&str, &str)]| load(pairs).unwrap().instance().peerjs_port;
        assert_eq!(port(&[("NEXT_PUBLIC_PEERJS_PORT", "9443")]), Some(9443));
        assert_eq!(
            port(&[("NEXT_PUBLIC_PEERJS_PORT", "9443"), ("PEERJS_PORT", "9100")]),
            Some(9100)
        );
        for unusable in [
            vec![("NEXT_PUBLIC_PEERJS_PORT", "")],
            vec![("NEXT_PUBLIC_PEERJS_PORT", " ")],
            vec![("NEXT_PUBLIC_PEERJS_PORT", "0")],
            vec![("NEXT_PUBLIC_PEERJS_PORT", "peer")],
            vec![("NEXT_PUBLIC_PEERJS_PORT", "70000")],
            vec![
                ("NEXT_PUBLIC_PEERJS_PORT", "9443"),
                ("NEXT_PUBLIC_PEERJS_HOST", "peer.example.com"),
            ],
            vec![("NEXT_PUBLIC_PEERJS_HOST", "peer.example.com")],
            vec![("NEXT_PUBLIC_PEERJS_HOST", "")],
        ] {
            assert_eq!(port(&unusable), None, "{unusable:?}");
        }
        let shared = [
            ("DATABASE_URL", "postgres://u:p@db/x"),
            ("REDIS_URL", "redis://r:6379"),
        ];
        let several = load(&shared).unwrap();
        let warning = several.peerjs_warning().expect("a warning");
        assert!(warning.contains("PEERJS_BUILTIN=false"), "{warning}");
        assert!(warning.is_ascii());
        let separate = load(&[shared[0], shared[1], ("PEERJS_BUILTIN", "false")]).unwrap();
        assert_eq!(separate.peerjs_warning(), None);
        let set = load(&[
            ("PEERJS_BUILTIN", "true"),
            ("PEERJS_PEERS_PER_IP", "0"),
            ("PEERJS_CONCURRENT_LIMIT", "12"),
        ])
        .unwrap();
        assert_eq!(
            set.peerjs(),
            Some(crate::peerjs::Settings {
                peers_per_ip: 0,
                concurrent_limit: 12,
                ..crate::peerjs::Settings::default()
            })
        );
        let stock = crate::peerjs::Settings::default();
        assert_eq!((stock.peers_per_ip, stock.concurrent_limit), (50, 5000));
        assert_eq!(
            (stock.expire, stock.alive),
            (Duration::from_secs(5), Duration::from_secs(90))
        );
        for (name, bad, expected) in [
            (
                "PEERJS_BUILTIN",
                "maybe",
                "PEERJS_BUILTIN: expected on or off, got maybe",
            ),
            (
                "PEERJS_PEERS_PER_IP",
                "-1",
                "PEERJS_PEERS_PER_IP: expected 0 to 1000000, got -1",
            ),
            (
                "PEERJS_CONCURRENT_LIMIT",
                "0",
                "PEERJS_CONCURRENT_LIMIT: expected 1 to 1000000, got 0",
            ),
        ] {
            assert_eq!(load(&[(name, bad)]).unwrap_err().to_string(), expected);
        }
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
            (64, 256)
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

    #[test]
    fn limits_default_to_todays_values() {
        let l = AppConfig::defaults().limits;
        assert_eq!(l, Limits::default());
        assert_eq!(
            (
                l.voice_room_max,
                l.voice_idle_secs,
                l.guest_grant_days,
                l.embed_cache_days
            ),
            (25, 60, 30, 30)
        );
        assert_eq!(l.database_max_connections, None);
        assert_eq!((l.rate_limit_per_second, l.rate_limit_burst), (10, 60));
    }

    #[test]
    fn limits_load_from_env() {
        let set = [
            ("VOICE_ROOM_MAX", "7"),
            ("GUEST_GRANT_DAYS", "2"),
            ("DATABASE_MAX_CONNECTIONS", "16"),
            ("RATE_LIMIT_PER_SECOND", "3"),
            ("RELAY_USER_KIB_PER_SEC", "9"),
        ];
        let l = AppConfig::load_from(&cli(None, None), env(&set))
            .unwrap()
            .limits;
        assert_eq!(
            (
                l.voice_room_max,
                l.guest_grant_days,
                l.database_max_connections,
                l.rate_limit_per_second,
                l.relay_user_kib_per_sec
            ),
            (7, 2, Some(16), 3, 9)
        );
        assert_eq!(l.guest_grant_ttl(), 2 * 86400);
        let bad = env(&[("RATE_LIMIT_PER_SECOND", "fast")]);
        assert!(AppConfig::load_from(&cli(None, None), bad).is_err());
    }

    #[test]
    fn bad_limit_values_name_the_variable() {
        let load = |pairs: &[(&str, &str)]| AppConfig::load_from(&cli(None, None), env(pairs));
        for (k, v, range) in [
            ("UPLOAD_MAX_MIB", "abc", "1 to 512"),
            ("UPLOAD_MAX_MIB", "0", "1 to 512"),
            ("MESSAGE_MAX_CHARS", "-1", "1 to 100000"),
            ("MESSAGE_MAX_CHARS", "100001", "1 to 100000"),
            ("VOICE_ROOM_MAX", "abc", "0 to 10000"),
            ("VOICE_IDLE_SECS", "9s", "5 to 86400"),
            ("DATABASE_MAX_CONNECTIONS", "x", "1 to 1000"),
            ("GUEST_GRANT_DAYS", "0", "1 to 3650"),
            ("EMBED_CACHE_DAYS", "-4", "1 to 3650"),
            ("RATE_LIMIT_PER_SECOND", "fast", "1 to 1000"),
            ("REPORT_RETENTION_DAYS", "-1", "0 to 3650"),
            ("E2EE_KEY_RETENTION_DAYS", "70", "1 to 69"),
            ("E2EE", "maybe", "on or off"),
            ("SFU_ENABLED", "2", "on or off"),
            ("FEATURE_P2P", "maybe", "on or off"),
            ("AUTH_PASSWORD_LOGIN", "2", "on or off"),
            ("AUTH_REGISTRATION", "invite", "open, sso or closed"),
        ] {
            let err = load(&[(k, v)]).unwrap_err().to_string();
            assert_eq!(err, format!("{k}: expected {range}, got {v}"));
        }
        for (max, buffer) in [("64", "32"), ("64", "63"), ("512", "256")] {
            let err = load(&[("UPLOAD_MAX_MIB", max), ("UPLOAD_BUFFER_MIB", buffer)])
                .unwrap_err()
                .to_string();
            assert_eq!(
                err,
                format!(
                    "UPLOAD_BUFFER_MIB: expected at least UPLOAD_MAX_MIB ({max}), got {buffer}"
                )
            );
        }
        for (max, buffer, warned) in [
            ("25", "32", true),
            ("25", "49", true),
            ("25", "50", false),
            ("64", "64", true),
            ("64", "128", false),
        ] {
            let l = load(&[("UPLOAD_MAX_MIB", max), ("UPLOAD_BUFFER_MIB", buffer)])
                .unwrap_or_else(|e| panic!("{max}/{buffer}: {e}"))
                .limits;
            let warning = l.upload_buffer_warning();
            assert_eq!(warning.is_some(), warned, "{max}/{buffer}");
            if let Some(w) = warning {
                assert!(
                    w.starts_with("UPLOAD_BUFFER_MIB is ") && w.is_ascii(),
                    "{w}"
                );
                assert!(w.contains(&format!(
                    "at least {}",
                    2 * max.parse::<u64>().expect("max")
                )));
            }
        }
        assert_eq!(load(&[]).unwrap().limits.upload_buffer_warning(), None);
        let l = load(&[
            ("UPLOAD_MAX_MIB", "64"),
            ("UPLOAD_BUFFER_MIB", "128"),
            ("VOICE_IDLE_SECS", " 9 "),
            ("DATABASE_MIN_CONNECTIONS", " 3 "),
            ("DATABASE_MAX_CONNECTIONS", ""),
        ])
        .unwrap()
        .limits;
        assert_eq!(
            (
                l.upload_max_mib,
                l.voice_idle_secs,
                l.database_min_connections,
                l.database_max_connections
            ),
            (64, 9, Some(3), None)
        );
        for none in [
            "REPORT_SAME_TARGET_HOURS",
            "REPORT_TARGETS_PER_DAY",
            "REPORT_MAX_PER_WEEK",
            "REPORT_RETENTION_DAYS",
            "P2P_BACKUP_MAX_MIB",
            "WIDGET_VIEWERS_MAX",
            "E2EE_GUESTS_PER_GROUP",
            "VOICE_ROOM_MAX",
            "UPLOAD_BUDGET_MIB",
        ] {
            assert!(load(&[(none, "0")]).is_ok(), "{none}=0 means none");
        }
    }

    #[test]
    fn plan_owned_limits_have_their_defaults() {
        let l = AppConfig::defaults().limits;
        assert_eq!(
            (
                l.report_same_target_hours,
                l.report_targets_per_day,
                l.report_max_per_week,
                l.report_retention_days
            ),
            (72, 3, 10, 180)
        );
        assert_eq!(
            (l.e2ee_guests_per_group, l.e2ee_key_retention_days),
            (500, 30)
        );
        assert_eq!(
            (
                l.sfu_enabled,
                l.sfu_max_participants,
                l.sfu_max_streams,
                l.sfu_user_kib_per_sec
            ),
            (false, 100, 2000, 4096)
        );
        assert_eq!(l.p2p_backup_max_mib, 64);
        assert_eq!(
            (
                l.widget_quick_joins_per_hour,
                l.widget_viewers_max,
                l.widget_bridge_servers_max
            ),
            (10, 5000, 50)
        );
        assert_eq!(
            (l.upload_max_mib, l.message_max_chars, l.upload_bytes()),
            (25, 4000, 25 * 1024 * 1024)
        );
        let set = [
            ("REPORT_TARGETS_PER_DAY", "0"),
            ("E2EE", "on"),
            ("E2EE_COMPLIANCE", "true"),
            ("SFU_ENABLED", "yes"),
            ("SFU_MAX_STREAMS", "9000"),
            ("P2P_BACKUP_MAX_MIB", "0"),
            ("WIDGETS", "off"),
            ("WIDGET_BRIDGE_SERVERS_MAX", "7"),
            ("MESSAGE_MAX_CHARS", "500"),
            ("UPLOAD_MAX_MIB", "10"),
        ];
        let config = AppConfig::load_from(&cli(None, None), env(&set)).unwrap();
        let l = config.limits;
        assert_eq!(
            (
                l.report_targets_per_day,
                l.sfu_enabled,
                l.sfu_max_streams,
                l.p2p_backup_max_mib,
                l.widget_bridge_servers_max,
                l.message_max_chars,
                l.upload_bytes()
            ),
            (0, true, 9000, 0, 7, 500, 10 * 1024 * 1024)
        );
        let c = &config.controls;
        assert_eq!(
            (
                c.value("e2ee"),
                c.value("e2ee_compliance"),
                c.value("widgets"),
                c.value("widget_bridge"),
                c.value("sfu")
            ),
            (Some("1"), Some("1"), Some("0"), None, None),
            "the switch booleans set Settings; SFU_ENABLED stays a limit"
        );
    }

    #[test]
    fn sfu_is_a_role() {
        let roles = Roles::parse("api,sfu").unwrap();
        assert!(roles.sfu && roles.api && !roles.gateway);
        const { assert!(Roles::ALL.sfu && !Roles::NONE.sfu) };
        assert_eq!(Roles::parse("SFU").unwrap().names(), vec!["sfu"]);
        assert!(
            !Roles::parse("api,gateway,media,search,embeds,jobs,sfu")
                .unwrap()
                .splits_backend()
        );
        let err = Roles::parse("nope").unwrap_err().to_string();
        assert!(err.contains("relay, sfu)"), "{err}");
        let mut set = env(&SHARED).unwrap();
        set.insert("RCHAT_ROLES".to_string(), "sfu".to_string());
        let config = AppConfig::load_from(&cli(None, None), Some(set)).unwrap();
        assert_eq!(config.roles.names(), vec!["sfu"]);
    }

    #[test]
    fn secrets_and_seeds_come_from_config() {
        let file = std::env::temp_dir().join(format!("rchat_pepper_{}", std::process::id()));
        std::fs::write(&file, "from-file\n").expect("write");
        let set = [
            ("PASSWORD_PEPPER_FILE", file.to_str().expect("path")),
            ("RELAY_SECRET", " relay "),
            ("P2P_SECRET", " "),
            ("GUESTS_ENABLED", "off"),
            ("PROFANITY_TARGETS", "usernames"),
            ("OUTGOING_WEBHOOKS", "on"),
            ("SWAGGER_UI", "no"),
            ("FEATURE_P2P", "off"),
            ("AUTH_REGISTRATION", "closed"),
            ("SETTINGS_PINNED", "AUTH_REGISTRATION"),
        ];
        let config = AppConfig::load_from(&cli(None, None), env(&set)).unwrap();
        let Secrets {
            password_pepper,
            relay_secret,
            p2p_secret,
        } = &config.secrets;
        assert_eq!(password_pepper.as_deref(), Some("from-file"));
        assert_eq!(relay_secret.as_deref(), Some("relay"));
        assert_eq!(p2p_secret.as_deref(), None);
        assert_eq!(
            config.controls,
            ControlSeeds {
                set: vec![
                    ("profanity_targets", "usernames".into()),
                    ("guests_enabled", "0".into()),
                    ("outgoing_webhooks", "1".into()),
                    ("p2p", "0".into()),
                    ("registration", "closed".into()),
                ],
                pinned: vec!["registration"],
            }
        );
        assert_eq!(config.swagger_ui.as_deref(), Some("no"));
        let opts = config.db_options();
        assert_eq!(opts.pepper.as_deref(), Some("from-file"));
        assert_eq!(
            (opts.limits, opts.controls),
            (config.limits.clone(), Some(config.controls.clone()))
        );
        assert!(!format!("{:?}", config.db_options()).contains("from-file"));
        let _ = std::fs::remove_file(file);
        let defaults = AppConfig::defaults();
        assert_eq!(defaults.controls, ControlSeeds::default());
        for (pairs, error) in [
            (
                [("SETTINGS_PINNED", "FEATURE_P2P"), ("E2EE", "on")],
                "SETTINGS_PINNED names FEATURE_P2P, but it is not set",
            ),
            (
                [("SETTINGS_PINNED", "all"), ("GUESTS_ENABLED", "maybe")],
                "GUESTS_ENABLED: expected on or off, got maybe",
            ),
            (
                [("SETTINGS_PINNED", "E2EE"), ("PROFANITY_TARGETS", "names")],
                "PROFANITY_TARGETS: expected all, none or a list of messages, links, usernames, server_names, channel_names, role_names, file_names, bios, channel_topics, category_names, got names",
            ),
        ] {
            let stopped = AppConfig::from_map(&pairs).unwrap_err().to_string();
            assert_eq!(stopped, error, "a bad control stops the start");
        }
        assert_eq!(defaults.secrets.password_pepper, None);
        assert_eq!(defaults.swagger_ui, None);
    }

    #[test]
    fn env_secrets_come_from_the_variable_or_a_file() {
        let name = format!("RCHAT_TEST_SECRET_{}", std::process::id());
        assert_eq!(env_secret(&name), None);
        let file = std::env::temp_dir().join(format!("rchat_secret_{}", std::process::id()));
        std::fs::write(&file, "from-file\n").expect("write");
        unsafe {
            std::env::set_var(format!("{name}_FILE"), &file);
        }
        assert_eq!(env_secret(&name).as_deref(), Some("from-file"));
        unsafe {
            std::env::set_var(&name, "  direct ");
        }
        assert_eq!(env_secret(&name).as_deref(), Some("direct"));
        unsafe {
            std::env::set_var(&name, " ");
            std::env::remove_var(format!("{name}_FILE"));
        }
        assert_eq!(env_secret(&name), None, "blank counts as unset");
        unsafe {
            std::env::remove_var(&name);
        }
        let _ = std::fs::remove_file(file);
    }
}
