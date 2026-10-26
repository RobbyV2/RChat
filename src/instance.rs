use std::net::IpAddr;
use std::sync::Arc;

use axum::http::{HeaderMap, header};
use serde::Serialize;
use sqlx::Row;
use url::Url;
use utoipa::ToSchema;

use crate::db::Db;
use crate::identity::{JWKS_PATH, Keyring, host_of};
use crate::server::client_ip::ProxyTrust;

pub const SOFTWARE: &str = "rchat";
pub const API_VERSION: &str = "1.0";
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
}

#[derive(Clone, Debug, PartialEq)]
pub struct AllowedHost {
    name: String,
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
        Ok(Arc::new(Instance {
            id: setting(db, "instance_id").await?,
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
        })
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

    pub fn discovery(&self, origin: &str, features: Features) -> InstanceInfo {
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
            public_url: origin.clone(),
            api_url,
            ws_url,
            peerjs_url,
            instance_url: format!("{origin}/api/instance"),
            jwks_uri: format!("{origin}{JWKS_PATH}"),
            features,
            limits: Limits::current(),
        }
    }
}

#[derive(Clone, Copy, Serialize, ToSchema)]
pub struct Features {
    pub guests: bool,
    pub uploads: bool,
    pub previews: bool,
    pub identity_assertions: bool,
}

#[derive(Clone, Copy, Serialize, ToSchema)]
pub struct Limits {
    pub message_chars: usize,
    pub name_chars: usize,
    pub upload_bytes: usize,
    pub media_retention_secs: i64,
    pub page_size: i64,
    pub assertion_ttl_secs: i64,
}

impl Limits {
    pub fn current() -> Limits {
        Limits {
            message_chars: crate::api::MESSAGE_MAX,
            name_chars: crate::api::NAME_MAX,
            upload_bytes: crate::api::media::MAX_SIZE,
            media_retention_secs: crate::api::media::MEDIA_TTL_SECS,
            page_size: crate::api::LIST_PAGE,
            assertion_ttl_secs: crate::identity::ASSERTION_TTL_SECS,
        }
    }
}

#[derive(Clone, Serialize, ToSchema)]
pub struct InstanceInfo {
    pub software: String,
    pub id: String,
    pub name: String,
    pub host: String,
    pub version: String,
    pub api_version: String,
    pub public_url: String,
    pub api_url: String,
    pub ws_url: String,
    pub peerjs_url: String,
    pub instance_url: String,
    pub jwks_uri: String,
    pub features: Features,
    pub limits: Limits,
}
