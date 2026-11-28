//! A root key kept in a key service (the Transit engine of Vault or OpenBao). It wraps and unwraps
//! data keys over HTTP and seals nothing else; this process asks it at start and when it makes a
//! data key, and remembers what each wrapped key gave.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tokio::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use zeroize::Zeroizing;

use super::{CryptError, KEY_LEN, Key, Purpose, dek_aad, random_key};

/// What the id of a key service key starts with, as data keys name it. No configured key id
/// holds a `:`, so none can take it.
pub const PREFIX: &str = "kms:";
const TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT: Duration = Duration::from_secs(5);
/// How long a wrapped key that could not be sent is not sent again.
const RETRY_AFTER: Duration = Duration::from_secs(30);
const KMS_URL: &str = rchat_settings::items::ENCRYPTION_KMS_URL.env();
/// The setting that names the key service key.
pub const KMS_KEY: &str = rchat_settings::items::ENCRYPTION_KMS_KEY.env();
const KMS_TOKEN_FILE: &str = rchat_settings::items::ENCRYPTION_KMS_TOKEN_FILE.env();

/// `ENCRYPTION_KMS_URL`, `ENCRYPTION_KMS_KEY` and `ENCRYPTION_KMS_TOKEN_FILE`.
#[derive(Clone, PartialEq, Eq)]
pub struct KmsConfig {
    /// The Transit mount, such as `https://vault.internal:8200/v1/transit`, without a trailing `/`.
    pub url: String,
    pub key: String,
    pub token_file: PathBuf,
}

impl std::fmt::Debug for KmsConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KmsConfig")
            .field("url", &self.url)
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

/// Whether `host` is this machine, the one place plain `http` may reach.
fn loopback(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => IpAddr::V4(*ip).is_loopback(),
        url::Host::Ipv6(ip) => IpAddr::V6(*ip).is_loopback(),
    }
}

impl KmsConfig {
    /// The three settings, all set or none. A malformed value, a missing one or an unreadable
    /// token file is an error naming the variable.
    pub fn load(get: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<Option<KmsConfig>> {
        use rchat_settings::items as st;
        let e = rchat_settings::Env::new(get);
        let (url, key, token_file) = match (
            e.raw(&st::ENCRYPTION_KMS_URL.setting),
            e.raw(&st::ENCRYPTION_KMS_KEY.setting),
            e.raw(&st::ENCRYPTION_KMS_TOKEN_FILE.setting),
        ) {
            (None, None, None) => return Ok(None),
            (Some(url), Some(key), Some(file)) => (url, key, PathBuf::from(file)),
            (url, key, file) => {
                let missing: Vec<&str> = [(KMS_URL, url), (KMS_KEY, key), (KMS_TOKEN_FILE, file)]
                    .into_iter()
                    .filter(|(_, v)| v.is_none())
                    .map(|(name, _)| name)
                    .collect();
                anyhow::bail!(
                    "{} must be set too: the key service needs {KMS_URL}, {KMS_KEY} and {KMS_TOKEN_FILE}",
                    missing.join(" and ")
                );
            }
        };
        let parsed =
            url::Url::parse(&url).map_err(|e| anyhow::anyhow!("{KMS_URL} is malformed: {e}"))?;
        let scheme = match (parsed.scheme(), parsed.host()) {
            ("https", Some(_)) => true,
            ("http", Some(host)) => loopback(&host),
            (_, _) => false,
        };
        let plain = scheme
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none();
        if !plain {
            anyhow::bail!(
                "{KMS_URL} is an https address of the Transit engine (http only on this machine), without a user, query or fragment"
            );
        }
        let named = !key.is_empty()
            && key.len() <= 128
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
        if !named {
            anyhow::bail!("{KMS_KEY} is 1 to 128 letters, digits, '_', '-' or '.'");
        }
        let config = KmsConfig {
            url: url.trim_end_matches('/').to_owned(),
            key,
            token_file,
        };
        config.token()?;
        Ok(Some(config))
    }

    /// The token, read from its file on every call, so a token the operator renews is used.
    fn token(&self) -> anyhow::Result<Zeroizing<String>> {
        let text = Zeroizing::new(
            std::fs::read_to_string(&self.token_file)
                .map_err(|e| anyhow::anyhow!("{KMS_TOKEN_FILE} cannot be read: {e}"))?,
        );
        let token = Zeroizing::new(text.trim().to_owned());
        if token.is_empty() {
            anyhow::bail!("{KMS_TOKEN_FILE} names an empty file");
        }
        Ok(token)
    }
}

/// The key service could not be reached, or refused the request (a token it does not take, a
/// sealed Vault). Readers treat a data key behind it as not held; a start refuses.
#[derive(Debug)]
pub struct Unreachable(String);

impl std::fmt::Display for Unreachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unreachable {}

/// Why the key service did not answer with a key.
#[derive(Debug)]
enum Refusal {
    /// It answered that it can't open what it was given: another key, or changed bytes.
    Open,
    Unreachable(Unreachable),
}

/// What a wrapped key gave, so it is sent once per process (again after `RETRY_AFTER` when the
/// service could not be reached).
enum Known {
    Opened(Key),
    Refused,
    Unreachable(Instant, String),
}

/// A key service key: it wraps data keys bound to their purpose and generation.
pub struct Kms {
    config: KmsConfig,
    id: String,
    http: reqwest::Client,
    /// What each wrapped key gave here, by its wrapped form, purpose and generation.
    known: Mutex<HashMap<String, Known>>,
}

impl std::fmt::Debug for Kms {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Kms")
            .field("url", &self.config.url)
            .field("key", &self.config.key)
            .finish_non_exhaustive()
    }
}

/// The plaintext the key service seals: the data key behind its purpose, generation and the id
/// of the key that wraps it, so a wrapped key moved to another row does not open.
fn bound(purpose: Purpose, generation: i64, id: &str, dek: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(dek_aad(purpose, generation, id));
    out.push(0);
    out.extend_from_slice(dek);
    out
}

impl Kms {
    pub fn new(config: KmsConfig) -> anyhow::Result<Kms> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(CONNECT)
            .timeout(TIMEOUT)
            .build()?;
        Ok(Kms {
            id: format!("{PREFIX}{}", config.key),
            config,
            http,
            known: Mutex::new(HashMap::new()),
        })
    }

    /// The id data keys it wraps name, `kms:<key>`.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Where it is, as the admin page and `server keys status` show it.
    pub fn shown(&self) -> String {
        format!("{} (key {})", self.config.url, self.config.key)
    }

    fn unreachable(&self, why: impl std::fmt::Display) -> Refusal {
        Refusal::Unreachable(Unreachable(format!(
            "the key service at {} can't be used: {why}",
            self.config.url
        )))
    }

    /// Posts `body` to `<url>/<op>/<key>` and answers the `data` of the reply. A 400 with the
    /// service's list of errors is the key service saying the bytes don't open.
    async fn call(&self, op: &str, body: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let token = self.config.token().map_err(|e| self.unreachable(e))?;
        let body = Zeroizing::new(body.to_string());
        let sent = self
            .http
            .post(format!("{}/{op}/{}", self.config.url, self.config.key))
            .header("X-Vault-Token", token.as_str())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.as_str().to_owned())
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        let status = sent.status();
        let bytes = Zeroizing::new(
            sent.bytes()
                .await
                .map_err(|e| self.unreachable(e))?
                .to_vec(),
        );
        let reply: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let listed = reply["errors"].is_array();
        if status == reqwest::StatusCode::BAD_REQUEST && op == "decrypt" && listed {
            return Err(Refusal::Open);
        }
        if !status.is_success() {
            let said = reply["errors"][0].as_str().unwrap_or("").chars().take(200);
            return Err(self.unreachable(format!(
                "{op} answered {}{}",
                status.as_u16(),
                match said.clone().next() {
                    Some(_) => format!(" ({})", said.collect::<String>()),
                    None => String::new(),
                }
            )));
        }
        match reply.get("data") {
            Some(data) => Ok(data.clone()),
            None => Err(self.unreachable(format!("{op} answered without data"))),
        }
    }

    fn context(purpose: Purpose, generation: i64) -> String {
        STANDARD.encode(format!("{}/{generation}", purpose.name()))
    }

    fn remembered(purpose: Purpose, generation: i64, wrapped: &str) -> String {
        format!("{}/{generation}/{wrapped}", purpose.name())
    }

    fn remember(&self, remembered: String, known: Known) {
        self.known
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(remembered, known);
    }

    /// `dek` wrapped by the key service for `purpose` and `generation`.
    pub async fn wrap(
        &self,
        purpose: Purpose,
        generation: i64,
        dek: &Key,
    ) -> anyhow::Result<String> {
        let wrapped = self.sealed(purpose, generation, dek).await?;
        self.remember(
            Kms::remembered(purpose, generation, &wrapped),
            Known::Opened(dek.clone()),
        );
        Ok(wrapped)
    }

    async fn sealed(&self, purpose: Purpose, generation: i64, dek: &Key) -> anyhow::Result<String> {
        let plaintext =
            Zeroizing::new(STANDARD.encode(&*bound(purpose, generation, &self.id, &dek[..])));
        let data = self
            .call(
                "encrypt",
                serde_json::json!({
                    "plaintext": plaintext.as_str(),
                    "context": Kms::context(purpose, generation),
                }),
            )
            .await
            .map_err(|refusal| match refusal {
                Refusal::Open => anyhow::anyhow!("the key service did not wrap the data key"),
                Refusal::Unreachable(e) => anyhow::Error::new(e),
            })?;
        match data["ciphertext"].as_str().filter(|c| !c.is_empty()) {
            Some(wrapped) => Ok(wrapped.to_owned()),
            None => anyhow::bail!(
                "the key service at {} answered without a ciphertext",
                self.config.url
            ),
        }
    }

    /// The data key of a row the key service wrapped. `Ok(Err(_))` when it does not open: the
    /// key service refuses it, or it opens to a key bound to another row. An `Unreachable` error
    /// when the service can't be used. Each wrapped form is sent once per process, or again
    /// `RETRY_AFTER` after the service could not be used.
    pub async fn unwrap(
        &self,
        purpose: Purpose,
        generation: i64,
        wrapped: &str,
    ) -> anyhow::Result<Result<Key, CryptError>> {
        let remembered = Kms::remembered(purpose, generation, wrapped);
        let known = match self
            .known
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&remembered)
        {
            Some(Known::Opened(key)) => Some(Ok(key.clone())),
            Some(Known::Refused) => Some(Err(None)),
            Some(Known::Unreachable(at, why)) if at.elapsed() < RETRY_AFTER => {
                Some(Err(Some(why.clone())))
            }
            Some(Known::Unreachable(_, _)) | None => None,
        };
        match known {
            Some(Ok(key)) => return Ok(Ok(key)),
            Some(Err(None)) => return Ok(Err(CryptError::Open)),
            Some(Err(Some(why))) => return Err(anyhow::Error::new(Unreachable(why))),
            None => {}
        }
        let data = match self
            .call(
                "decrypt",
                serde_json::json!({
                    "ciphertext": wrapped,
                    "context": Kms::context(purpose, generation),
                }),
            )
            .await
        {
            Ok(data) => data,
            Err(Refusal::Open) => {
                self.remember(remembered, Known::Refused);
                return Ok(Err(CryptError::Open));
            }
            Err(Refusal::Unreachable(e)) => {
                self.remember(remembered, Known::Unreachable(Instant::now(), e.0.clone()));
                return Err(anyhow::Error::new(e));
            }
        };
        let plain = Zeroizing::new(
            data["plaintext"]
                .as_str()
                .and_then(|p| STANDARD.decode(p).ok())
                .unwrap_or_default(),
        );
        let expected = bound(purpose, generation, &self.id, &[]);
        let Some(dek) = plain
            .strip_prefix(&expected[..])
            .filter(|dek| dek.len() == KEY_LEN)
        else {
            self.remember(remembered, Known::Refused);
            return Ok(Err(CryptError::Open));
        };
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(dek);
        self.remember(remembered, Known::Opened(key.clone()));
        Ok(Ok(key))
    }

    /// Forgets what a wrapped key gave here, once its data key is destroyed.
    pub fn forget(&self, purpose: Purpose, generation: i64, wrapped: &str) {
        self.known
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&Kms::remembered(purpose, generation, wrapped));
    }

    /// Wraps and unwraps a throwaway key, so a start learns whether the key service answers.
    pub async fn probe(&self) -> anyhow::Result<()> {
        let key = random_key();
        let wrapped = self.sealed(Purpose::Bus, 0, &key).await?;
        let opened = self.unwrap(Purpose::Bus, 0, &wrapped).await;
        self.forget(Purpose::Bus, 0, &wrapped);
        match opened? {
            Ok(opened) if opened == key => Ok(()),
            Ok(_) | Err(_) => anyhow::bail!(
                "the key service at {} does not open what it wrapped",
                self.config.url
            ),
        }
    }
}

#[cfg(test)]
pub(crate) mod stub;
#[cfg(test)]
mod tests;
