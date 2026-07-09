use std::sync::Arc;

use s3::creds::Credentials;
use s3::{Bucket, Region};
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppMode {
    Full,
    ApiOnly,
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
}

impl AppConfig {
    pub fn load(cli: &CliOverrides) -> anyhow::Result<Self> {
        let mut builder = config::Config::builder()
            .set_default("app_mode", "full")?
            .set_default("host", "127.0.0.1")?
            .set_default("server_port", 3000_i64)?
            .set_default("port", 3001_i64)?
            .set_default("rate_limit_per_second", 10_i64)?
            .set_default("rate_limit_burst", 60_i64)?
            .add_source(config::Environment::default());

        if let Some(ref host) = cli.host {
            builder = builder.set_override("host", host.as_str())?;
        }
        if let Some(port) = cli.port {
            builder = builder.set_override("server_port", port as i64)?;
        }
        if let Some(ref mode) = cli.mode {
            builder = builder.set_override("app_mode", mode.as_str())?;
        }

        Ok(builder.build()?.try_deserialize()?)
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
        match self.app_mode {
            AppMode::Full => {
                let url = self
                    .server_proxy_url
                    .clone()
                    .unwrap_or_else(|| format!("http://127.0.0.1:{}", self.port));
                Some(Arc::from(url.as_str()))
            }
            AppMode::ApiOnly => None,
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
}
