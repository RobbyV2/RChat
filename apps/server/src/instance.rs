use std::net::IpAddr;
use std::sync::Arc;

use axum::http::{HeaderMap, header};
use serde::Serialize;
use sqlx::Row;
use url::Url;
use utoipa::ToSchema;

use crate::db::Db;
use crate::identity::{JWKS_PATH, Keyring, host_of};
use crate::relay::{IceConfig, IceServer};
use crate::server::client_ip::ProxyTrust;

pub const SOFTWARE: &str = "rchat";
pub const API_VERSION: &str = "1.1";
pub const DEFAULT_NAME: &str = "RChat";
pub const DEFAULT_PEERJS_PORT: u16 = 9001;

#[derive(Clone, Default)]
pub struct InstanceConfig {
    pub name: Option<String>,
    pub public_url: Option<String>,
    pub api_url: Option<String>,
    pub ws_url: Option<String>,
    pub peerjs_url: Option<String>,
    pub signing_key: Option<String>,
    pub allowed_hosts: Option<String>,
    pub peerjs_port: Option<u16>,
    pub proxy_trust: ProxyTrust,
    pub ice: IceConfig,
    pub relay_secret: Option<String>,
    pub p2p_secret: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AllowedHost {
    pub(crate) name: String,
    port: Option<u16>,
}

impl AllowedHost {
    fn matches(&self, url: &Url) -> bool {
        url.host_str() == Some(self.name.as_str())
            && self.port.is_none_or(|p| url.port() == Some(p))
    }

    fn label(&self) -> String {
        match self.port {
            Some(port) => format!("{}:{port}", self.name),
            None => self.name.clone(),
        }
    }
}

fn host_url(raw: &str) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains(['/', '?', '#', '@', '\\']) {
        return None;
    }
    Url::parse(&format!("http://{raw}"))
        .ok()
        .filter(|u| u.path() == "/" && u.host().is_some())
}

pub fn parse_allowed_hosts(spec: &str) -> anyhow::Result<Vec<AllowedHost>> {
    spec.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|raw| match host_url(raw) {
            Some(url) => Ok(AllowedHost {
                name: url.host_str().unwrap_or_default().to_string(),
                port: url.port(),
            }),
            None => anyhow::bail!(
                "ALLOWED_HOSTS entry {raw:?} is not a host name (for example chat.example.com or chat.example.com:8443)"
            ),
        })
        .collect()
}

fn loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

pub struct Instance {
    pub id: String,
    pub name: String,
    pub public_url: Option<Url>,
    pub api_url: Option<Url>,
    pub ws_url: Option<Url>,
    pub peerjs_url: Option<Url>,
    pub keys: Keyring,
    pub allowed_hosts: Vec<AllowedHost>,
    pub peerjs_port: u16,
    pub proxy_trust: ProxyTrust,
    pub stun: Vec<String>,
    pub ice: IceConfig,
    pub relay_secret: String,
    pub p2p_secret: String,
}

pub fn origin_url(raw: &str, what: &str, schemes: &[&str]) -> anyhow::Result<Url> {
    let url = Url::parse(raw.trim()).map_err(|e| anyhow::anyhow!("{what} is not a URL: {e}"))?;
    if !schemes.contains(&url.scheme()) || url.host().is_none() {
        anyhow::bail!("{what} must be a {} URL", schemes.join(" or "));
    }
    if url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
        anyhow::bail!("{what} must not carry a query, fragment or credentials");
    }
    Ok(url)
}

fn trimmed(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

async fn setting(db: &Db, key: &str) -> anyhow::Result<String> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await?;
    match row {
        Some(row) => Ok(row.try_get(0)?),
        None => anyhow::bail!("settings.{key} is missing"),
    }
}

impl Instance {
    pub async fn load(db: &Db, config: &InstanceConfig) -> anyhow::Result<Arc<Instance>> {
        let InstanceConfig {
            name,
            public_url,
            api_url,
            ws_url,
            peerjs_url,
            signing_key,
            allowed_hosts,
            peerjs_port,
            proxy_trust,
            ice,
            relay_secret,
            p2p_secret,
        } = config;
        let keys = match signing_key.as_deref().map(str::trim) {
            Some(spec) if !spec.is_empty() => {
                Keyring::parse(spec).map_err(|e| anyhow::anyhow!("INSTANCE_SIGNING_KEY: {e}"))?
            }
            Some(_) | None => Keyring::parse(&setting(db, "instance_signing_key").await?)?,
        };
        let parse = |raw: &Option<String>, what: &str, schemes: &[&str]| {
            raw.as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| origin_url(s, what, schemes))
                .transpose()
        };
        let public_url = parse(public_url, "PUBLIC_URL", &["http", "https"])?;
        if let Some(url) = &public_url
            && !matches!(url.path(), "" | "/")
        {
            anyhow::bail!("PUBLIC_URL must be an origin without a path");
        }
        let id = setting(db, "instance_id").await?;
        Ok(Arc::new(Instance {
            stun: crate::relay::pick_stun(&crate::relay::bundled_stun(), &id, ice.public_stun),
            ice: ice.clone(),
            relay_secret: match relay_secret {
                Some(secret) => secret.clone(),
                None => setting(db, "relay_secret").await?,
            },
            p2p_secret: match p2p_secret {
                Some(secret) => secret.clone(),
                None => setting(db, "p2p_secret").await?,
            },
            id,
            name: name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_NAME)
                .to_string(),
            public_url,
            api_url: parse(api_url, "PUBLIC_API_URL", &["http", "https"])?,
            ws_url: parse(ws_url, "PUBLIC_WS_URL", &["ws", "wss", "http", "https"])?,
            peerjs_url: parse(peerjs_url, "PUBLIC_PEERJS_URL", &["http", "https"])?,
            keys,
            allowed_hosts: parse_allowed_hosts(allowed_hosts.as_deref().unwrap_or_default())?,
            peerjs_port: peerjs_port.unwrap_or(DEFAULT_PEERJS_PORT),
            proxy_trust: proxy_trust.clone(),
        }))
    }

    #[cfg(test)]
    pub fn ephemeral() -> Arc<Instance> {
        Arc::new(Instance {
            id: crate::identity::random_id(),
            name: DEFAULT_NAME.to_string(),
            public_url: None,
            api_url: None,
            ws_url: None,
            peerjs_url: None,
            keys: Keyring::parse(&crate::identity::new_seed()).expect("keyring"),
            allowed_hosts: Vec::new(),
            peerjs_port: DEFAULT_PEERJS_PORT,
            proxy_trust: ProxyTrust::default(),
            stun: Vec::new(),
            ice: IceConfig::default(),
            relay_secret: crate::identity::random_id(),
            p2p_secret: crate::identity::random_id(),
        })
    }

    #[cfg(test)]
    pub fn with_ice(ice: IceConfig) -> Arc<Instance> {
        let base = Instance::ephemeral();
        let mut instance = Arc::into_inner(base).expect("fresh instance");
        instance.stun =
            crate::relay::pick_stun(&crate::relay::bundled_stun(), &instance.id, ice.public_stun);
        instance.ice = ice;
        Arc::new(instance)
    }

    fn relay_host(&self, origin: &str) -> String {
        Url::parse(origin)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .map(|h| h.trim_start_matches('[').trim_end_matches(']').to_string())
            .unwrap_or_else(|| "localhost".to_string())
    }

    /// The STUN URLs anyone may use: the chosen public entries, the built-in relay's STUN
    /// and the STUN entries of `ICE_SERVERS`.
    pub fn stun_urls(&self, origin: &str) -> Vec<String> {
        let relay = self
            .ice
            .relay
            .as_ref()
            .map(|r| format!("stun:{}:{}", r.host_for(&self.relay_host(origin)), r.port));
        let extra = self
            .ice
            .extra
            .iter()
            .filter(|s| !s.is_turn() && s.username.is_none())
            .flat_map(|s| s.urls.iter().cloned());
        let mut urls: Vec<String> = Vec::new();
        for url in self.stun.iter().cloned().chain(relay).chain(extra) {
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
        urls
    }

    pub fn ice_info(&self, origin: &str) -> Ice {
        let relay_turn = self.ice.relay.as_ref().is_some_and(|r| r.turn);
        Ice {
            stun: self.stun_urls(origin),
            turn: relay_turn || self.ice.extra.iter().any(IceServer::is_turn),
            relay: self.ice.relay.is_some(),
        }
    }

    /// ICE servers for a signed-in user: the public STUN entries plus TURN entries, with
    /// short-lived credentials for the built-in relay. Returns them with their expiry.
    pub fn ice_servers(&self, origin: &str, user: &str, now: i64) -> (Vec<IceServer>, i64) {
        let stun = self.stun_urls(origin);
        let mut servers = Vec::new();
        if !stun.is_empty() {
            servers.push(IceServer {
                urls: stun,
                username: None,
                credential: None,
            });
        }
        let cred = crate::relay::issue(&self.relay_secret, user, now);
        if let Some(relay) = self.ice.relay.as_ref().filter(|r| r.turn) {
            servers.push(IceServer {
                urls: vec![format!(
                    "turn:{}:{}?transport=udp",
                    relay.host_for(&self.relay_host(origin)),
                    relay.port
                )],
                username: Some(cred.username.clone()),
                credential: Some(cred.password.clone()),
            });
        }
        servers.extend(
            self.ice
                .extra
                .iter()
                .filter(|s| s.is_turn() || s.username.is_some())
                .cloned(),
        );
        (servers, cred.expires_at)
    }

    /// The URL points at this instance: the `PUBLIC_URL` host and port when it is set, otherwise
    /// a host this instance answers as (loopback or `ALLOWED_HOSTS`), like `origin`.
    pub fn serves(&self, url: &Url) -> bool {
        match &self.public_url {
            Some(own) => {
                own.host() == url.host()
                    && own.port_or_known_default() == url.port_or_known_default()
            }
            None => loopback(url) || self.allowed_hosts.iter().any(|a| a.matches(url)),
        }
    }

    pub fn pinned(&self) -> bool {
        self.public_url.is_some()
    }

    pub fn origin(&self, peer: Option<IpAddr>, headers: &HeaderMap) -> String {
        if let Some(url) = &self.public_url {
            return trimmed(url);
        }
        let proxied = peer.is_some_and(|ip| self.proxy_trust.trusts(ip.to_canonical()));
        let first = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .map(str::trim)
                .filter(|v| !v.is_empty())
        };
        let raw = match proxied {
            true => first("x-forwarded-host").or_else(|| first(header::HOST.as_str())),
            false => first(header::HOST.as_str()),
        };
        let host = raw
            .and_then(host_url)
            .filter(|u| loopback(u) || self.allowed_hosts.iter().any(|a| a.matches(u)))
            .as_ref()
            .and_then(host_of)
            .or_else(|| self.allowed_hosts.first().map(AllowedHost::label))
            .unwrap_or_else(|| "localhost".to_string());
        let proto = match proxied {
            true => first("x-forwarded-proto")
                .filter(|p| p.eq_ignore_ascii_case("https"))
                .map(|_| "https"),
            false => None,
        }
        .unwrap_or("http");
        format!("{proto}://{host}")
    }

    pub fn host(&self, origin: &str) -> String {
        Url::parse(origin)
            .ok()
            .as_ref()
            .and_then(host_of)
            .unwrap_or_else(|| origin.to_string())
    }

    pub fn discovery(
        &self,
        origin: &str,
        features: Features,
        limits: &crate::limits::Limits,
    ) -> InstanceInfo {
        let origin = origin.to_string();
        let site = Url::parse(&origin).ok();
        let secure = site.as_ref().is_some_and(|u| u.scheme() == "https");
        let host = self.host(&origin);
        let api_url = match &self.api_url {
            Some(url) => trimmed(url),
            None => format!("{origin}/api"),
        };
        let ws_url = match &self.ws_url {
            Some(url) => {
                let base = trimmed(url);
                let base = base
                    .replacen("https://", "wss://", 1)
                    .replacen("http://", "ws://", 1);
                match base.ends_with("/api/ws") {
                    true => base,
                    false => format!("{base}/api/ws"),
                }
            }
            None => {
                let api = Url::parse(&api_url).ok();
                let ws_host = api.as_ref().and_then(host_of).unwrap_or(host.clone());
                let scheme = match api.as_ref().map(|u| u.scheme()) {
                    Some("https") => "wss",
                    _ => "ws",
                };
                format!("{scheme}://{ws_host}/api/ws")
            }
        };
        let peerjs_url = match &self.peerjs_url {
            Some(url) => trimmed(url),
            None => {
                let hostname = site
                    .as_ref()
                    .and_then(|u| u.host_str().map(str::to_string))
                    .unwrap_or_else(|| "localhost".to_string());
                let port = self.peerjs_port;
                let scheme = if secure { "https" } else { "http" };
                format!("{scheme}://{hostname}:{port}/peerjs")
            }
        };
        InstanceInfo {
            software: SOFTWARE.to_string(),
            id: self.id.clone(),
            name: self.name.clone(),
            host,
            version: env!("CARGO_PKG_VERSION").to_string(),
            api_version: API_VERSION.to_string(),
            api_versions: crate::server::route_builder::VERSIONS
                .iter()
                .map(|v| v.to_string())
                .collect(),
            public_url: origin.clone(),
            api_url,
            ws_url,
            peerjs_url,
            instance_url: format!("{origin}/api/instance"),
            jwks_uri: format!("{origin}{JWKS_PATH}"),
            ice: self.ice_info(&origin),
            features,
            limits: Limits::of(limits),
            e2ee: false,
            sfu: limits.sfu_enabled,
            widgets: false,
        }
    }
}

/// Optional features and whether they are on right now.
#[derive(Clone, Copy, Serialize, ToSchema)]
pub struct Features {
    /// Guest access (reading servers without an account) is on.
    pub guests: bool,
    /// File uploads through `POST /api/v1/media` are on.
    pub uploads: bool,
    /// Peer-to-peer attachments are on. With `uploads` also off, messages are text only.
    pub p2p_attachments: bool,
    /// Link previews are on.
    pub previews: bool,
    /// `POST /api/v1/identity/assertion` is available.
    pub identity_assertions: bool,
}

/// Limits of this instance.
#[derive(Clone, Copy, Serialize, ToSchema)]
pub struct Limits {
    /// Longest message text, in characters: by default 4000 (`MESSAGE_MAX_CHARS`).
    #[schema(example = 4000)]
    pub message_chars: usize,
    /// Longest username, server, channel or role name, in characters.
    #[schema(example = 100)]
    pub name_chars: usize,
    /// Largest upload, in bytes: by default 25 MiB (`UPLOAD_MAX_MIB`).
    #[schema(example = 26214400)]
    pub upload_bytes: usize,
    /// Seconds an uploaded file is kept before it is deleted.
    #[schema(example = 86400)]
    pub media_retention_secs: i64,
    /// Default page size of list endpoints.
    #[schema(example = 50)]
    pub page_size: i64,
    /// Seconds an identity assertion stays valid.
    #[schema(example = 300)]
    pub assertion_ttl_secs: i64,
}

impl Limits {
    pub fn of(limits: &crate::limits::Limits) -> Limits {
        Limits {
            message_chars: limits.message_max_chars,
            name_chars: crate::api::NAME_MAX,
            upload_bytes: limits.upload_bytes(),
            media_retention_secs: crate::api::media::MEDIA_TTL_SECS,
            page_size: crate::api::LIST_PAGE,
            assertion_ttl_secs: crate::identity::ASSERTION_TTL_SECS,
        }
    }
}

/// Who this instance is and where its services live. URLs come from `PUBLIC_URL` and the
/// related settings when set, otherwise from the request's host (forwarded headers count only
/// from trusted proxies).
#[derive(Clone, Serialize, ToSchema)]
pub struct InstanceInfo {
    /// Always `rchat`.
    #[schema(example = "rchat")]
    pub software: String,
    /// Random id generated once per instance and kept in its database.
    pub id: String,
    /// Display name of the instance (`INSTANCE_NAME`, default `RChat`).
    #[schema(example = "RChat")]
    pub name: String,
    /// Host (with port when not the default) users of this instance belong to, as in
    /// `user@host`.
    #[schema(example = "chat.example.com")]
    pub host: String,
    /// Server software version.
    #[schema(example = "0.2.0")]
    pub version: String,
    /// Version of this API.
    #[schema(example = "1.1")]
    pub api_version: String,
    /// API versions this instance serves, each under `/api/<version>`; `/api/...` without one uses
    /// the latest. Instances from before API versions leave this out and serve only `/api/...`.
    #[schema(example = json!(["v1"]))]
    pub api_versions: Vec<String>,
    /// Origin of the web app, without a trailing slash.
    #[schema(example = "https://chat.example.com")]
    pub public_url: String,
    /// Root URL of the REST API. `<api_url>/v1` is version 1; the root itself uses the latest
    /// version.
    #[schema(example = "https://chat.example.com/api")]
    pub api_url: String,
    /// WebSocket gateway URL on the latest version; `/api/v1/ws` in place of `/api/ws` is
    /// version 1.
    #[schema(example = "wss://chat.example.com/api/ws")]
    pub ws_url: String,
    /// PeerJS signalling server used for peer-to-peer file sharing and calls.
    #[schema(example = "https://chat.example.com:9001/peerjs")]
    pub peerjs_url: String,
    /// URL of this document on this instance (`GET /api/instance`, the latest version).
    #[schema(example = "https://chat.example.com/api/instance")]
    pub instance_url: String,
    /// URL of the instance's JSON Web Key Set.
    #[schema(example = "https://chat.example.com/.well-known/jwks.json")]
    pub jwks_uri: String,
    /// ICE servers for peer-to-peer connections. Empty and off unless the operator enables
    /// them.
    pub ice: Ice,
    /// Optional features and whether they are on.
    pub features: Features,
    /// Limits of this instance.
    pub limits: Limits,
    /// Whether this build supports end-to-end encryption. The `e2ee` switch of
    /// `GET /api/v1/settings` says whether it is on.
    pub e2ee: bool,
    /// The instance runs its media server for calls (`SFU_ENABLED`, off by default). The `sfu`
    /// switch of `GET /api/v1/settings` says whether calls use it.
    pub sfu: bool,
    /// Whether this build supports embeddable widgets. The `widgets` switch of
    /// `GET /api/v1/settings` says whether they are on.
    pub widgets: bool,
}

/// ICE servers for peer-to-peer connections (calls, P2P files). The instance never adds
/// servers on its own: public STUN, the built-in relay and extra servers are all opt-in.
#[derive(Clone, Serialize, ToSchema)]
pub struct Ice {
    /// STUN URLs anyone may use: the chosen public STUN servers, the built-in relay's STUN
    /// address and STUN entries the operator added.
    #[schema(example = json!(["stun:stun.example.org:3478", "stun:chat.example.com:3478"]))]
    pub stun: Vec<String>,
    /// TURN relaying is available: signed-in users get short-lived credentials from
    /// `GET /api/v1/p2p/ice`.
    pub turn: bool,
    /// The instance runs its own relay (STUN, and TURN when `turn` is on).
    pub relay: bool,
}
