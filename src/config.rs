use std::collections::HashMap;
use std::sync::Arc;

use s3::creds::Credentials;
use s3::{Bucket, Region};
use serde::Deserialize;

use crate::bus::DEFAULT_HUB_MAXLEN;
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
    };

    pub const NONE: Roles = Roles {
        api: false,
        gateway: false,
        media: false,
        search: false,
        embeds: false,
        jobs: false,
        web: false,
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
                other => anyhow::bail!(
                    "unknown role {other} (expected all, api, gateway, media, search, embeds, jobs, web)"
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
        } = *self;
        [
            (api, "api"),
            (gateway, "gateway"),
            (media, "media"),
            (search, "search"),
            (embeds, "embeds"),
            (jobs, "jobs"),
            (web, "web"),
        ]
        .into_iter()
        .filter_map(|(on, name)| on.then_some(name))
        .collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub app_mode: AppMode,
    pub host: String,
    pub server_port: u16,
    pub port: u16,
    pub server_proxy_url: Option<String>,
    pub database_url: Option<String>,
    pub rate_limit_per_second: u64,
    pub rate_limit_burst: u32,
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
    #[serde(skip)]
    pub roles: Roles,
    #[serde(skip)]
    pub proxy_trust: ProxyTrust,
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
            .set_default("redis_prefix", "rchat")?
            .set_default("redis_hub_maxlen", DEFAULT_HUB_MAXLEN as i64)?
            .set_default("trust_proxy", false)?
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
        if config.redis_hub_maxlen < MIN_HUB_MAXLEN {
            anyhow::bail!("REDIS_HUB_MAXLEN must be at least {MIN_HUB_MAXLEN}");
        }
        config.check_shared_state()?;
        config.proxy_trust =
            ProxyTrust::from_config(config.trust_proxy, config.trusted_proxies.as_deref())?;
        Ok(config)
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
        if !self.roles.splits_backend() {
            return Ok(());
        }
        let roles = self.roles.names().join(",");
        let postgres = self
            .database_url
            .as_deref()
            .map(str::trim)
            .is_some_and(|u| u.starts_with("postgres://") || u.starts_with("postgresql://"));
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
        help = "Service roles: all, or a comma list of api, gateway, media, search, embeds, jobs, web"
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
}
