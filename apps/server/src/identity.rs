use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;
use tokio::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use url::{Host, Url};

use crate::p2p_chain::{Head, canonical};

pub const ASSERTION_TTL_SECS: i64 = 300;
pub const BINDING_AUD: &str = "rchat-p2p-bind";
pub const BINDING_TTL_SECS: i64 = 7 * 24 * 60 * 60;
pub const BINDING_SKEW_SECS: u64 = 300;
const BINDING_TAG: &[u8] = b"rchat-p2p-bind1\0";
const BINDING2_TAG: &[u8] = b"rchat-p2p-bind2\0";
pub const JWKS_PATH: &str = "/.well-known/jwks.json";
pub const ALG: &str = "EdDSA";
const TYP: &str = "JWT";
pub const JWKS_TTL: Duration = Duration::from_secs(600);
const REFETCH_EVERY: Duration = Duration::from_secs(30);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const JWKS_MAX_BYTES: usize = 64 * 1024;
const LEEWAY_SECS: i64 = 30;
const CACHE_MAX: usize = 1024;
const JTI_MAX: usize = 128;
const SEEN_MAX: usize = 10_000;
const SEEN_PER_ISSUER: usize = 2_000;

pub fn new_seed() -> String {
    let mut seed = [0u8; 32];
    rand::rng().fill_bytes(&mut seed);
    URL_SAFE_NO_PAD.encode(seed)
}

pub fn random_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Jwk {
    #[serde(default)]
    pub kty: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub crv: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub x: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alg: Option<String>,
    #[serde(rename = "use", default, skip_serializing_if = "Option::is_none")]
    pub key_use: Option<String>,
}

impl Jwk {
    fn verifying_key(&self) -> Option<VerifyingKey> {
        let Jwk {
            kty,
            crv,
            x,
            kid: _,
            alg,
            key_use,
        } = self;
        let usable = kty == "OKP"
            && crv == "Ed25519"
            && alg.as_deref().is_none_or(|a| a == ALG)
            && key_use.as_deref().is_none_or(|u| u == "sig");
        if !usable {
            return None;
        }
        let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(x).ok()?.try_into().ok()?;
        VerifyingKey::from_bytes(&bytes).ok()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct JwkSet {
    pub keys: Vec<Jwk>,
}

impl JwkSet {
    fn find(&self, kid: &str) -> Option<&Jwk> {
        let mut found = self.keys.iter().filter(|k| k.kid.as_deref() == Some(kid));
        match (found.next(), found.next()) {
            (Some(key), None) => Some(key),
            (_, _) => None,
        }
    }
}

pub fn thumbprint(x: &str) -> String {
    let canonical = format!(r#"{{"crv":"Ed25519","kty":"OKP","x":"{x}"}}"#);
    URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()))
}

pub struct InstanceKey {
    pub kid: String,
    signing: SigningKey,
    pub jwk: Jwk,
}

impl InstanceKey {
    fn from_signing(signing: SigningKey) -> InstanceKey {
        let x = URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes());
        let kid = thumbprint(&x);
        InstanceKey {
            jwk: Jwk {
                kty: "OKP".to_string(),
                crv: "Ed25519".to_string(),
                x,
                kid: Some(kid.clone()),
                alg: Some(ALG.to_string()),
                key_use: Some("sig".to_string()),
            },
            kid,
            signing,
        }
    }

    pub fn from_seed(seed: &str) -> anyhow::Result<InstanceKey> {
        let bytes = URL_SAFE_NO_PAD
            .decode(seed.trim().trim_end_matches('='))
            .map_err(|_| anyhow::anyhow!("signing key is not base64url"))?;
        let seed: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("signing key seed must be 32 bytes"))?;
        Ok(InstanceKey::from_signing(SigningKey::from_bytes(&seed)))
    }

    pub fn from_pem(pem: &str) -> anyhow::Result<InstanceKey> {
        let signing = SigningKey::from_pkcs8_pem(pem)
            .map_err(|e| anyhow::anyhow!("signing key is not an Ed25519 PKCS#8 PEM: {e}"))?;
        Ok(InstanceKey::from_signing(signing))
    }
}

pub struct Keyring {
    keys: Vec<InstanceKey>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    kid: String,
    typ: String,
}

fn b64_json<T: Serialize>(value: &T) -> anyhow::Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(value)?))
}

impl Keyring {
    pub fn new(keys: Vec<InstanceKey>) -> anyhow::Result<Keyring> {
        if keys.is_empty() {
            anyhow::bail!("no signing key");
        }
        let mut seen = HashSet::new();
        if let Some(dup) = keys.iter().find(|k| !seen.insert(k.kid.as_str())) {
            anyhow::bail!("the same signing key is listed twice (kid {})", dup.kid);
        }
        Ok(Keyring { keys })
    }

    pub fn parse(spec: &str) -> anyhow::Result<Keyring> {
        const END: &str = "-----END PRIVATE KEY-----";
        let keys = match spec.contains("-----BEGIN") {
            true => spec
                .split_inclusive(END)
                .map(str::trim)
                .filter(|block| block.contains("-----BEGIN"))
                .map(InstanceKey::from_pem)
                .collect::<anyhow::Result<Vec<_>>>()?,
            false => spec
                .split(|c: char| c == ',' || c.is_whitespace())
                .filter(|s| !s.is_empty())
                .map(InstanceKey::from_seed)
                .collect::<anyhow::Result<Vec<_>>>()?,
        };
        Keyring::new(keys)
    }

    pub fn active(&self) -> &InstanceKey {
        &self.keys[0]
    }

    pub fn jwks(&self) -> JwkSet {
        JwkSet {
            keys: self.keys.iter().map(|k| k.jwk.clone()).collect(),
        }
    }

    /// The claims of `token` when one of these keys signed it.
    pub fn signed<T: serde::de::DeserializeOwned>(&self, token: &str) -> Option<T> {
        let Parts {
            input,
            header,
            payload,
            signature,
        } = split_token(token).ok()?;
        let kid = parse_header(header).ok()?;
        let key = self.keys.iter().find(|k| k.kid == kid)?;
        let signature: [u8; 64] = decode_part(signature).ok()?.try_into().ok()?;
        key.signing
            .verifying_key()
            .verify_strict(input.as_bytes(), &Signature::from_bytes(&signature))
            .ok()?;
        serde_json::from_slice(&decode_part(payload).ok()?).ok()
    }

    pub fn sign<T: Serialize>(&self, claims: &T) -> anyhow::Result<String> {
        let key = self.active();
        let header = Header {
            alg: ALG.to_string(),
            kid: key.kid.clone(),
            typ: TYP.to_string(),
        };
        let input = format!("{}.{}", b64_json(&header)?, b64_json(claims)?);
        let signature = key.signing.sign(input.as_bytes());
        Ok(format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Claims {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

/// Claims of a P2P identity binding: the instance vouches that the account `sub` holds the P2P
/// identity key `ik`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindingClaims {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub ik: String,
    pub iat: i64,
    pub exp: i64,
    /// The record of the identity's key chain the binding was issued for. None for an identity
    /// without a chain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<Head>,
}

/// What a binding proof signs: the domain tag, the account, a zero byte and the time in decimal.
pub fn binding_message(sub: &str, ts: i64) -> Vec<u8> {
    [
        BINDING_TAG,
        sub.as_bytes(),
        b"\0",
        ts.to_string().as_bytes(),
    ]
    .concat()
}

/// What the binding proof of an identity with a key chain signs: the domain tag and the
/// canonical JSON of `{sub, ik, head: {n, d}, ts}`. `None` when `sub` has no canonical form.
pub fn binding2_message(sub: &str, ik: &str, head: &Head, ts: u64) -> Option<Vec<u8>> {
    let Head { n, d } = head;
    let body = canonical(&json!({"sub": sub, "ik": ik, "head": {"n": n, "d": d}, "ts": ts}))?;
    Some([BINDING2_TAG, body.as_bytes()].concat())
}

/// A P2P identity key: base64url Ed25519, a canonical encoding and not of small order.
pub fn p2p_key(ik: &str) -> Option<VerifyingKey> {
    let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(ik).ok()?.try_into().ok()?;
    let key = VerifyingKey::from_bytes(&bytes).ok()?;
    match key.is_weak() || URL_SAFE_NO_PAD.encode(key.to_bytes()) != ik {
        true => None,
        false => Some(key),
    }
}

/// Whether `sig` (base64url, 64 bytes) is a strict Ed25519 signature by `key` over `msg`.
pub fn sig_ok(key: &VerifyingKey, msg: &[u8], sig: &str) -> bool {
    let Some(sig) = URL_SAFE_NO_PAD
        .decode(sig)
        .ok()
        .and_then(|b| <[u8; 64]>::try_from(b).ok())
    else {
        return false;
    };
    key.verify_strict(msg, &Signature::from_bytes(&sig)).is_ok()
}

/// Whether `proof` is a signature by the key `ik` over the binding of `sub` at `ts`.
pub fn binding_proof_ok(key: &VerifyingKey, sub: &str, ts: i64, proof: &str) -> bool {
    sig_ok(key, &binding_message(sub, ts), proof)
}

/// Whether `proof` is a signature by `key`, the primary after the record `head` of the chain of
/// `ik`, over the binding of `sub` to `ik` at that head and `ts`.
pub fn binding2_proof_ok(
    key: &VerifyingKey,
    sub: &str,
    ik: &str,
    head: &Head,
    ts: u64,
    proof: &str,
) -> bool {
    binding2_message(sub, ik, head, ts).is_some_and(|msg| sig_ok(key, &msg, proof))
}

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    Malformed,
    Algorithm,
    Issuer,
    UnknownKey,
    Signature,
    Expired,
    Audience,
    Nonce,
    Subject,
    Lifetime,
    Replay,
    Port,
    Fetch(String),
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::Malformed => write!(f, "malformed assertion"),
            VerifyError::Algorithm => write!(f, "assertion is not signed with EdDSA"),
            VerifyError::Issuer => write!(f, "issuer is not an RChat origin"),
            VerifyError::UnknownKey => write!(f, "unknown signing key"),
            VerifyError::Signature => write!(f, "bad signature"),
            VerifyError::Expired => write!(f, "assertion expired"),
            VerifyError::Audience => write!(f, "wrong audience"),
            VerifyError::Nonce => write!(f, "wrong nonce"),
            VerifyError::Subject => write!(f, "subject is not on the issuer's host"),
            VerifyError::Lifetime => write!(f, "assertion lifetime too long"),
            VerifyError::Replay => write!(f, "assertion already used"),
            VerifyError::Port => write!(f, "issuer port is not accepted here"),
            VerifyError::Fetch(e) => write!(f, "could not fetch issuer keys: {e}"),
        }
    }
}

impl std::error::Error for VerifyError {}

pub fn host_of(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn local_name(domain: &str) -> bool {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    domain == "localhost" || domain.ends_with(".localhost") || domain.ends_with(".local")
}

/// The ports other instances may sign identities from (`OTHER_INSTANCE_PORTS`): any, or only
/// the listed ones.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum IssuerPorts {
    #[default]
    Any,
    Only(BTreeSet<u16>),
}

impl IssuerPorts {
    /// Comma-separated ports from 1 to 65535; empty means any port.
    pub fn parse(spec: &str) -> anyhow::Result<IssuerPorts> {
        let ports = spec
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|raw| {
                match raw.bytes().all(|b| b.is_ascii_digit()) {
                    true => raw.parse::<u16>().ok().filter(|port| *port != 0),
                    false => None,
                }
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "OTHER_INSTANCE_PORTS entry {raw:?} is not a port from 1 to 65535"
                    )
                })
            })
            .collect::<anyhow::Result<BTreeSet<u16>>>()?;
        Ok(match ports.is_empty() {
            true => IssuerPorts::Any,
            false => IssuerPorts::Only(ports),
        })
    }

    fn allows(&self, port: u16) -> bool {
        match self {
            IssuerPorts::Any => true,
            IssuerPorts::Only(ports) => ports.contains(&port),
        }
    }
}

/// Which issuers identities are accepted from: https on a public host, on the allowed ports, and
/// with local testing also http and https on local names and addresses.
#[derive(Clone, Debug, Default)]
pub struct IssuerRules {
    ports: IssuerPorts,
    allow_local: bool,
}

/// An issuer the rules accepted. Only `IssuerRules::accept` makes one, and fetching and trusting
/// an issuer's keys take one, so no issuer reaches them unchecked. Its origin (scheme, host and
/// port) is the instance: another port of the same host is another issuer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issuer {
    iss: String,
    origin: String,
    host: String,
    keys: Url,
}

impl Issuer {
    /// The issuer as it was named.
    pub fn iss(&self) -> &str {
        &self.iss
    }

    /// Its origin in one spelling (`https://chat.example:8443`, no default port), the `iss` of
    /// the claims it verifies.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// The host its qualified names carry: `host`, or `host:port` off the scheme's default port.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// Its key set, `/.well-known/jwks.json` on its origin.
    pub fn keys_url(&self) -> &Url {
        &self.keys
    }
}

impl IssuerRules {
    pub fn new(ports: IssuerPorts) -> IssuerRules {
        IssuerRules {
            ports,
            allow_local: false,
        }
    }

    pub fn allow_local(self) -> IssuerRules {
        IssuerRules {
            allow_local: true,
            ..self
        }
    }

    pub fn accept(&self, iss: &str) -> Result<Issuer, VerifyError> {
        let IssuerRules { ports, allow_local } = self;
        let url = Url::parse(iss).map_err(|_| VerifyError::Issuer)?;
        let public = match url.host() {
            Some(Host::Domain(d)) => !local_name(d),
            Some(Host::Ipv4(ip)) => crate::api::embeds::ip_ok(IpAddr::V4(ip)),
            Some(Host::Ipv6(ip)) => crate::api::embeds::ip_ok(IpAddr::V6(ip)),
            None => return Err(VerifyError::Issuer),
        };
        let scheme = match url.scheme() {
            "https" => true,
            "http" => *allow_local && !public,
            _ => false,
        };
        let bare = matches!(url.path(), "" | "/")
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
            && url.password().is_none();
        let port = url.port_or_known_default().filter(|port| *port != 0);
        let (Some(port), true) = (port, scheme && bare && (public || *allow_local)) else {
            return Err(VerifyError::Issuer);
        };
        if !ports.allows(port) {
            return Err(VerifyError::Port);
        }
        Ok(Issuer {
            iss: iss.to_string(),
            origin: url.origin().ascii_serialization(),
            host: host_of(&url).ok_or(VerifyError::Issuer)?,
            keys: url.join(JWKS_PATH).map_err(|_| VerifyError::Issuer)?,
        })
    }
}

pub fn split_qualified(id: &str) -> Option<(&str, &str)> {
    let (name, host) = id.rsplit_once('@')?;
    match name.is_empty() || host.is_empty() {
        true => None,
        false => Some((name, host)),
    }
}

fn decode_part(part: &str) -> Result<Vec<u8>, VerifyError> {
    URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_| VerifyError::Malformed)
}

struct Parts<'a> {
    input: &'a str,
    header: &'a str,
    payload: &'a str,
    signature: &'a str,
}

fn split_token(token: &str) -> Result<Parts<'_>, VerifyError> {
    let mut parts = token.split('.');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(header), Some(payload), Some(signature), None)
            if !header.is_empty() && !payload.is_empty() && !signature.is_empty() =>
        {
            Ok(Parts {
                input: &token[..header.len() + 1 + payload.len()],
                header,
                payload,
                signature,
            })
        }
        (_, _, _, _) => Err(VerifyError::Malformed),
    }
}

fn parse_header(raw: &str) -> Result<String, VerifyError> {
    let value: serde_json::Value =
        serde_json::from_slice(&decode_part(raw)?).map_err(|_| VerifyError::Malformed)?;
    if value.get("alg").and_then(|a| a.as_str()) != Some(ALG) {
        return Err(VerifyError::Algorithm);
    }
    match value.get("kid") {
        Some(serde_json::Value::String(_)) => {}
        Some(_) | None => return Err(VerifyError::UnknownKey),
    }
    let Header { alg: _, kid, typ } =
        serde_json::from_value(value).map_err(|_| VerifyError::Malformed)?;
    match typ == TYP && !kid.is_empty() {
        true => Ok(kid),
        false => Err(VerifyError::Malformed),
    }
}

pub fn verify_with(
    token: &str,
    keys: &JwkSet,
    issuer: &Issuer,
    aud: &str,
    nonce: Option<&str>,
) -> Result<Claims, VerifyError> {
    let Parts {
        input,
        header,
        payload,
        signature,
    } = split_token(token)?;
    let kid = parse_header(header)?;
    let key = keys
        .find(&kid)
        .and_then(Jwk::verifying_key)
        .ok_or(VerifyError::UnknownKey)?;
    let signature: [u8; 64] = decode_part(signature)?
        .try_into()
        .map_err(|_| VerifyError::Malformed)?;
    key.verify_strict(input.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| VerifyError::Signature)?;
    let claims: Claims =
        serde_json::from_slice(&decode_part(payload)?).map_err(|_| VerifyError::Malformed)?;
    if claims.jti.is_empty() || claims.jti.len() > JTI_MAX {
        return Err(VerifyError::Malformed);
    }
    if claims.iss != issuer.iss {
        return Err(VerifyError::Issuer);
    }
    if claims.aud != aud {
        return Err(VerifyError::Audience);
    }
    let now = crate::db::now();
    if claims.exp + LEEWAY_SECS < now {
        return Err(VerifyError::Expired);
    }
    if claims.iat > now + LEEWAY_SECS
        || claims.exp < claims.iat
        || claims.exp - claims.iat > ASSERTION_TTL_SECS
    {
        return Err(VerifyError::Lifetime);
    }
    if nonce.is_some() && claims.nonce.as_deref() != nonce {
        return Err(VerifyError::Nonce);
    }
    match split_qualified(&claims.sub) {
        Some((name, host)) if !name.contains('@') && host.eq_ignore_ascii_case(&issuer.host) => {
            Ok(Claims {
                iss: issuer.origin.clone(),
                ..claims
            })
        }
        _ => Err(VerifyError::Subject),
    }
}

struct Cached {
    at: Instant,
    used: Instant,
    keys: Result<JwkSet, String>,
}

impl Cached {
    fn fresh(&self, ttl: Duration) -> bool {
        let max_age = match &self.keys {
            Ok(_) => ttl,
            Err(_) => REFETCH_EVERY,
        };
        self.at.elapsed() < max_age
    }
}

pub struct Verifier {
    ttl: Duration,
    rules: IssuerRules,
    cache: Mutex<HashMap<String, Cached>>,
    seen: Mutex<HashMap<String, HashMap<String, i64>>>,
}

impl Default for Verifier {
    fn default() -> Verifier {
        Verifier::new(JWKS_TTL, IssuerRules::default())
    }
}

async fn resolve(url: &Url, allow_local: bool) -> Result<Vec<SocketAddr>, String> {
    let Some(Host::Domain(domain)) = url.host() else {
        return Ok(Vec::new());
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((domain, port))
        .await
        .map_err(|e| e.to_string())?
        .collect();
    let routable = addrs
        .iter()
        .all(|a| allow_local || crate::api::embeds::ip_ok(a.ip()));
    match !addrs.is_empty() && routable {
        true => Ok(addrs),
        false => Err(format!("{domain} does not resolve to a public address")),
    }
}

impl Verifier {
    pub fn new(ttl: Duration, rules: IssuerRules) -> Verifier {
        Verifier {
            ttl,
            rules,
            cache: Mutex::new(HashMap::new()),
            seen: Mutex::new(HashMap::new()),
        }
    }

    /// `iss` as an issuer this verifier accepts.
    pub fn accept(&self, iss: &str) -> Result<Issuer, VerifyError> {
        self.rules.accept(iss)
    }

    fn cached(&self, issuer: &Issuer, max_age: Duration) -> Option<Result<JwkSet, VerifyError>> {
        let mut cache = self.cache.lock().ok()?;
        let entry = cache
            .get_mut(issuer.keys.as_str())
            .filter(|c| c.fresh(max_age.min(self.ttl)))?;
        entry.used = Instant::now();
        Some(entry.keys.clone().map_err(VerifyError::Fetch))
    }

    fn remember(&self, issuer: &Issuer, keys: &Result<JwkSet, String>) {
        let Ok(mut cache) = self.cache.lock() else {
            return;
        };
        let url = issuer.keys.as_str();
        if cache.len() >= CACHE_MAX && !cache.contains_key(url) {
            cache.retain(|_, c| c.fresh(self.ttl));
            while cache.len() >= CACHE_MAX {
                let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, c)| c.used)
                    .map(|(k, _)| k.clone())
                else {
                    break;
                };
                cache.remove(&oldest);
            }
        }
        let now = Instant::now();
        cache.insert(
            url.to_string(),
            Cached {
                at: now,
                used: now,
                keys: keys.clone(),
            },
        );
    }

    async fn download(&self, issuer: &Issuer) -> Result<JwkSet, String> {
        let url = &issuer.keys;
        let addrs = resolve(url, self.rules.allow_local).await?;
        let mut builder = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .connect_timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy();
        if let Some(Host::Domain(domain)) = url.host() {
            builder = builder.resolve_to_addrs(domain, &addrs);
        }
        let client = builder.build().map_err(|e| e.to_string())?;
        let mut res = client
            .get(url.clone())
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(res.status().to_string());
        }
        if res
            .content_length()
            .is_some_and(|n| n > JWKS_MAX_BYTES as u64)
        {
            return Err("key set too large".to_string());
        }
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            body.extend_from_slice(&chunk);
            if body.len() > JWKS_MAX_BYTES {
                return Err("key set too large".to_string());
            }
        }
        serde_json::from_slice(&body).map_err(|e| e.to_string())
    }

    async fn fetch(&self, issuer: &Issuer) -> Result<JwkSet, VerifyError> {
        let keys = self.download(issuer).await;
        self.remember(issuer, &keys);
        keys.map_err(VerifyError::Fetch)
    }

    async fn keys_of(&self, issuer: &Issuer) -> Result<JwkSet, VerifyError> {
        match self.cached(issuer, self.ttl) {
            Some(keys) => keys,
            None => self.fetch(issuer).await,
        }
    }

    pub async fn keys(&self, iss: &str) -> Result<JwkSet, VerifyError> {
        self.keys_of(&self.accept(iss)?).await
    }

    fn first_use(&self, claims: &Claims, now: i64) -> Result<(), VerifyError> {
        let mut seen = self.seen.lock().map_err(|_| VerifyError::Replay)?;
        let live = |exp: &i64| *exp + LEEWAY_SECS >= now;
        if seen
            .get(&claims.iss)
            .and_then(|jtis| jtis.get(&claims.jti))
            .is_some_and(live)
        {
            return Err(VerifyError::Replay);
        }
        let full = |seen: &HashMap<String, HashMap<String, i64>>| {
            seen.values().map(HashMap::len).sum::<usize>() >= SEEN_MAX
                || seen
                    .get(&claims.iss)
                    .is_some_and(|jtis| jtis.len() >= SEEN_PER_ISSUER)
        };
        if full(&seen) {
            for jtis in seen.values_mut() {
                jtis.retain(|_, exp| live(exp));
            }
            seen.retain(|_, jtis| !jtis.is_empty());
        }
        if full(&seen) {
            return Err(VerifyError::Replay);
        }
        seen.entry(claims.iss.clone())
            .or_default()
            .insert(claims.jti.clone(), claims.exp);
        Ok(())
    }

    pub async fn verify(
        &self,
        token: &str,
        aud: &str,
        nonce: Option<&str>,
    ) -> Result<Claims, VerifyError> {
        let claims = self.verify_signed(token, aud, nonce).await?;
        self.first_use(&claims, crate::db::now())?;
        Ok(claims)
    }

    async fn verify_signed(
        &self,
        token: &str,
        aud: &str,
        nonce: Option<&str>,
    ) -> Result<Claims, VerifyError> {
        let issuer = self.accept(&unverified_issuer(token)?)?;
        let keys = self.keys_of(&issuer).await?;
        match verify_with(token, &keys, &issuer, aud, nonce) {
            Err(VerifyError::UnknownKey) => {
                if self.cached(&issuer, REFETCH_EVERY).is_some() {
                    return Err(VerifyError::UnknownKey);
                }
                let keys = self.fetch(&issuer).await?;
                verify_with(token, &keys, &issuer, aud, nonce)
            }
            other => other,
        }
    }

    #[cfg(test)]
    fn cache_len(&self) -> usize {
        self.cache.lock().map(|c| c.len()).unwrap_or(0)
    }
}

fn unverified_issuer(token: &str) -> Result<String, VerifyError> {
    #[derive(Deserialize)]
    struct Iss {
        iss: String,
    }
    let Parts { payload, .. } = split_token(token)?;
    let Iss { iss } =
        serde_json::from_slice(&decode_part(payload)?).map_err(|_| VerifyError::Malformed)?;
    Ok(iss)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(iss: &str, sub: &str, aud: &str, ttl: i64, nonce: Option<&str>) -> Claims {
        let iat = crate::db::now();
        Claims {
            iss: iss.to_string(),
            sub: sub.to_string(),
            aud: aud.to_string(),
            iat,
            exp: iat + ttl,
            jti: random_id(),
            nonce: nonce.map(str::to_string),
        }
    }

    const ISS: &str = "https://chat.example";
    const AUD: &str = "https://b.example";
    const SUB: &str = "alice@chat.example";

    fn issuer(iss: &str) -> Issuer {
        IssuerRules::default().accept(iss).unwrap()
    }

    fn b64(value: &serde_json::Value) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap())
    }

    fn with_header(ring: &Keyring, header: serde_json::Value, claims: &Claims) -> String {
        let input = format!(
            "{}.{}",
            b64(&header),
            b64(&serde_json::to_value(claims).unwrap())
        );
        let sig = ring.active().signing.sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    #[test]
    fn jwks_shape_and_thumbprint() {
        let ring = Keyring::parse("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A").unwrap();
        let jwks = serde_json::to_value(ring.jwks()).unwrap();
        let key = &jwks["keys"][0];
        assert_eq!(key["kty"], "OKP");
        assert_eq!(key["crv"], "Ed25519");
        assert_eq!(key["alg"], "EdDSA");
        assert_eq!(key["use"], "sig");
        assert_eq!(key["x"], "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo");
        assert_eq!(key["kid"], "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
        assert!(key.get("d").is_none(), "{key}");
        let two = Keyring::parse(&format!("{},{}", new_seed(), new_seed())).unwrap();
        assert_eq!(two.jwks().keys.len(), 2);
        assert!(Keyring::parse("").is_err());
        assert!(Keyring::parse("short").is_err());
    }

    #[test]
    fn pem_keys_parse_and_duplicate_kids_are_rejected() {
        let pem = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----\n";
        let ring = Keyring::parse(pem).unwrap();
        assert_eq!(
            ring.active().kid,
            "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"
        );
        let err = Keyring::parse(&format!("{pem}{pem}")).err().unwrap();
        assert!(err.to_string().contains("twice"), "{err}");
        let seed = new_seed();
        assert!(Keyring::parse(&format!("{seed},{seed}")).is_err());
    }

    #[test]
    fn signs_a_strict_eddsa_header() {
        let ring = Keyring::parse(&new_seed()).unwrap();
        let token = ring.sign(&claims(ISS, SUB, AUD, 300, None)).unwrap();
        let header: serde_json::Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(token.split('.').next().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            header,
            serde_json::json!({"alg": "EdDSA", "kid": ring.active().kid, "typ": "JWT"})
        );
    }

    // The same vectors are in the TS tests (identity.test.ts, p2p_badge.test.ts): the proof
    // format and the binding token agree across the two implementations.
    const BIND_IK: &str = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
    const BIND_PROOF: &str =
        "8U4Mtq2GXpao_qppPrPJ0hRcVcGtMYUcmpNk-KubIef9gx8k0kdgWwhUw8QN60CtMhcnbNL09X7RJ3TLJn0xAA";
    const BIND_TOKEN: &str = "eyJhbGciOiJFZERTQSIsImtpZCI6ImtQcktfcW14VldhWVZBOXd3QkY2SXVvM3ZWeno3VHhIQ1R3WEJ5Z3JTNGsiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwOi8vMTI3LjAuMC4xOjM4MjEiLCJzdWIiOiJhbGljZUAxMjcuMC4wLjE6MzgyMSIsImF1ZCI6InJjaGF0LXAycC1iaW5kIiwiaWsiOiI2a3BzWS1LY1VncS05VkI3RXk3Ri1aVkhkcTYtdm51U1FoN3FhUlJHMGl3IiwiaWF0IjoxNzkzMDU2MzA2LCJleHAiOjE3OTM2NjExMDZ9.fc47iS6ATl5Vb9s-ZMHAemFri8l87vnGKjCsw7yWG5kR5S892h3A9LFLEUczeCC1xQ6LqPJ8_qHxznRAHMi7AA";

    #[test]
    fn binding_proofs_and_tokens_match_the_fixed_vectors() {
        let signer = SigningKey::from_bytes(&[7u8; 32]);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(signer.verifying_key().to_bytes()),
            BIND_IK
        );
        assert_eq!(
            binding_message("alice@chat.example", 1793056306),
            b"rchat-p2p-bind1\0alice@chat.example\x001793056306"
        );
        let key = p2p_key(BIND_IK).unwrap();
        assert!(binding_proof_ok(
            &key,
            "alice@chat.example",
            1793056306,
            BIND_PROOF
        ));
        assert!(!binding_proof_ok(
            &key,
            "alice@chat.example",
            1793056307,
            BIND_PROOF
        ));
        assert!(!binding_proof_ok(
            &key,
            "bob@chat.example",
            1793056306,
            BIND_PROOF
        ));
        let other = p2p_key(
            &URL_SAFE_NO_PAD.encode(
                SigningKey::from_bytes(&[9u8; 32])
                    .verifying_key()
                    .to_bytes(),
            ),
        )
        .unwrap();
        assert!(!binding_proof_ok(
            &other,
            "alice@chat.example",
            1793056306,
            BIND_PROOF
        ));
        assert!(!binding_proof_ok(
            &key,
            "alice@chat.example",
            1793056306,
            "AAAA"
        ));
        let mut identity = [0u8; 32];
        identity[0] = 1;
        let mut order_two = [0xffu8; 32];
        order_two[0] = 0xec;
        order_two[31] = 0x7f;
        for weak in [[0u8; 32], identity, order_two] {
            assert!(p2p_key(&URL_SAFE_NO_PAD.encode(weak)).is_none());
        }
        assert!(p2p_key("short").is_none());
        let ring = Keyring::parse("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A").unwrap();
        let token = ring
            .sign(&BindingClaims {
                iss: "http://127.0.0.1:3821".to_string(),
                sub: "alice@127.0.0.1:3821".to_string(),
                aud: BINDING_AUD.to_string(),
                ik: BIND_IK.to_string(),
                iat: 1793056306,
                exp: 1793056306 + BINDING_TTL_SECS,
                head: None,
            })
            .unwrap();
        assert_eq!(token, BIND_TOKEN);
    }

    // The bytes are the client's: `rchat-p2p-bind2`, a zero byte and the canonical JSON of
    // `bindingBody2` in p2p/chain.ts.
    #[test]
    fn a_binding_with_a_chain_signs_the_head_and_its_token_names_it() {
        let head = Head {
            n: 1,
            d: "QI2KH0aQi2-Q1L1kGhuL_qF3WTTIrmat336pAzcJIlI".to_string(),
        };
        assert_eq!(
            binding2_message("vera@chat.example.org", BIND_IK, &head, 5).unwrap(),
            format!(
                "rchat-p2p-bind2\0{{\"head\":{{\"d\":\"{}\",\"n\":1}},\"ik\":\"{BIND_IK}\",\"sub\":\"vera@chat.example.org\",\"ts\":5}}",
                head.d
            )
            .into_bytes()
        );
        assert_eq!(binding2_message("e\u{301}@x", BIND_IK, &head, 5), None);
        let claims = BindingClaims {
            iss: "http://127.0.0.1:3821".to_string(),
            sub: "alice@127.0.0.1:3821".to_string(),
            aud: BINDING_AUD.to_string(),
            ik: BIND_IK.to_string(),
            iat: 7,
            exp: 8,
            head: Some(head.clone()),
        };
        let text = serde_json::to_value(&claims).unwrap();
        assert_eq!(text["head"], serde_json::json!({"n": 1, "d": head.d}));
        let old =
            serde_json::json!({"iss": "i", "sub": "s", "aud": "a", "ik": "k", "iat": 1, "exp": 2});
        let read: BindingClaims = serde_json::from_value(old.clone()).unwrap();
        assert_eq!(read.head, None);
        assert_eq!(serde_json::to_value(&read).unwrap(), old);
    }

    #[test]
    fn sign_verify_and_rejections() {
        let ring = Keyring::parse(&new_seed()).unwrap();
        let jwks = ring.jwks();
        let token = ring.sign(&claims(ISS, SUB, AUD, 300, Some("n1"))).unwrap();
        let ok = verify_with(&token, &jwks, &issuer(ISS), AUD, Some("n1")).unwrap();
        assert_eq!(ok.sub, SUB);
        assert_eq!(
            verify_with(&token, &jwks, &issuer(ISS), AUD, None)
                .unwrap()
                .nonce
                .as_deref(),
            Some("n1")
        );
        assert_eq!(
            verify_with(&token, &jwks, &issuer(ISS), "https://c.example", Some("n1")),
            Err(VerifyError::Audience)
        );
        assert_eq!(
            verify_with(&token, &jwks, &issuer(ISS), AUD, Some("n2")),
            Err(VerifyError::Nonce)
        );
        let bare = ring.sign(&claims(ISS, SUB, AUD, 300, None)).unwrap();
        assert_eq!(
            verify_with(&bare, &jwks, &issuer(ISS), AUD, Some("n1")),
            Err(VerifyError::Nonce)
        );
        assert_eq!(
            verify_with(&token, &jwks, &issuer("https://other.example"), AUD, None),
            Err(VerifyError::Issuer)
        );
        let other = Keyring::parse(&new_seed()).unwrap();
        assert_eq!(
            verify_with(&token, &other.jwks(), &issuer(ISS), AUD, None),
            Err(VerifyError::UnknownKey)
        );
        let mut forged = other.jwks();
        forged.keys[0].kid = Some(ring.active().kid.clone());
        assert_eq!(
            verify_with(&token, &forged, &issuer(ISS), AUD, None),
            Err(VerifyError::Signature)
        );
        let mut twice = jwks.clone();
        twice.keys.push(forged.keys[0].clone());
        assert_eq!(
            verify_with(&token, &twice, &issuer(ISS), AUD, None),
            Err(VerifyError::UnknownKey)
        );
        let mut rsa = jwks.clone();
        rsa.keys[0].kty = "RSA".to_string();
        assert_eq!(
            verify_with(&token, &rsa, &issuer(ISS), AUD, None),
            Err(VerifyError::UnknownKey)
        );
        let mut old = claims(ISS, SUB, AUD, 300, None);
        old.iat -= 1000;
        old.exp -= 1000;
        assert_eq!(
            verify_with(&ring.sign(&old).unwrap(), &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Expired)
        );
        let mut skewed = claims(ISS, SUB, AUD, 300, None);
        skewed.iat -= 310;
        skewed.exp -= 310;
        assert!(verify_with(&ring.sign(&skewed).unwrap(), &jwks, &issuer(ISS), AUD, None).is_ok());
        let mut future = claims(ISS, SUB, AUD, 60, None);
        future.iat += 600;
        future.exp += 600;
        assert_eq!(
            verify_with(&ring.sign(&future).unwrap(), &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Lifetime)
        );
        let long = ring.sign(&claims(ISS, SUB, AUD, 3600, None)).unwrap();
        assert_eq!(
            verify_with(&long, &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Lifetime)
        );
        let mut no_jti = claims(ISS, SUB, AUD, 60, None);
        no_jti.jti.clear();
        assert_eq!(
            verify_with(&ring.sign(&no_jti).unwrap(), &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Malformed)
        );
        let doubled = ring
            .sign(&claims(ISS, "a@b@chat.example", AUD, 60, None))
            .unwrap();
        assert_eq!(
            verify_with(&doubled, &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Subject)
        );
        let foreign = ring
            .sign(&claims(ISS, "alice@evil.example", AUD, 60, None))
            .unwrap();
        assert_eq!(
            verify_with(&foreign, &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Subject)
        );
        let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
        parts[1] =
            b64(&serde_json::to_value(claims(ISS, "root@chat.example", AUD, 60, None)).unwrap());
        assert_eq!(
            verify_with(&parts.join("."), &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Signature)
        );
    }

    #[test]
    fn forged_headers_and_shapes_are_rejected() {
        let ring = Keyring::parse(&new_seed()).unwrap();
        let jwks = ring.jwks();
        let kid = ring.active().kid.clone();
        let body = claims(ISS, SUB, AUD, 60, None);
        let good = with_header(
            &ring,
            serde_json::json!({"alg": "EdDSA", "kid": kid, "typ": "JWT"}),
            &body,
        );
        assert!(verify_with(&good, &jwks, &issuer(ISS), AUD, None).is_ok());
        let payload = good.split('.').nth(1).unwrap().to_string();
        let none = format!(
            "{}.{payload}.",
            b64(&serde_json::json!({"alg": "none", "kid": kid, "typ": "JWT"}))
        );
        assert_eq!(
            verify_with(&none, &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Malformed)
        );
        let none_signed = with_header(
            &ring,
            serde_json::json!({"alg": "none", "kid": kid, "typ": "JWT"}),
            &body,
        );
        assert_eq!(
            verify_with(&none_signed, &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Algorithm)
        );
        for alg in [
            serde_json::json!("HS256"),
            serde_json::json!("eddsa"),
            serde_json::json!("ES256"),
            serde_json::json!(null),
        ] {
            let token = with_header(
                &ring,
                serde_json::json!({"alg": alg, "kid": kid, "typ": "JWT"}),
                &body,
            );
            assert_eq!(
                verify_with(&token, &jwks, &issuer(ISS), AUD, None),
                Err(VerifyError::Algorithm),
                "{alg}"
            );
        }
        let hs = format!(
            "{}.{payload}.{}",
            b64(&serde_json::json!({"alg": "HS256", "kid": kid, "typ": "JWT"})),
            URL_SAFE_NO_PAD.encode([0u8; 32])
        );
        assert_eq!(
            verify_with(&hs, &jwks, &issuer(ISS), AUD, None),
            Err(VerifyError::Algorithm)
        );
        for header in [
            serde_json::json!({"alg": "EdDSA", "typ": "JWT"}),
            serde_json::json!({"alg": "EdDSA", "kid": 7, "typ": "JWT"}),
            serde_json::json!({"alg": "EdDSA", "kid": "other", "typ": "JWT"}),
        ] {
            let token = with_header(&ring, header.clone(), &body);
            assert_eq!(
                verify_with(&token, &jwks, &issuer(ISS), AUD, None),
                Err(VerifyError::UnknownKey),
                "{header}"
            );
        }
        for header in [
            serde_json::json!({"alg": "EdDSA", "kid": kid}),
            serde_json::json!({"alg": "EdDSA", "kid": kid, "typ": "at+jwt"}),
            serde_json::json!({"alg": "EdDSA", "kid": "", "typ": "JWT"}),
            serde_json::json!({"alg": "EdDSA", "kid": kid, "typ": "JWT", "crit": ["exp"]}),
            serde_json::json!({"alg": "EdDSA", "kid": kid, "typ": "JWT", "jku": "https://evil.example/k"}),
        ] {
            let token = with_header(&ring, header.clone(), &body);
            assert_eq!(
                verify_with(&token, &jwks, &issuer(ISS), AUD, None),
                Err(VerifyError::Malformed),
                "{header}"
            );
        }
        let parts: Vec<&str> = good.split('.').collect();
        for bad in [
            "nope".to_string(),
            format!("{}.{}", parts[0], parts[1]),
            format!("{good}.{}", parts[2]),
            format!("{}.{}.{}=", parts[0], parts[1], parts[2]),
            format!("{}..{}", parts[0], parts[2]),
            format!("{}.{}.{}", parts[0], parts[1], &parts[2][..10]),
        ] {
            assert_eq!(
                verify_with(&bad, &jwks, &issuer(ISS), AUD, None),
                Err(VerifyError::Malformed),
                "{bad}"
            );
        }
    }

    type Accepted = Result<(String, String), VerifyError>;

    fn accepted(rules: &IssuerRules, iss: &str) -> Accepted {
        rules
            .accept(iss)
            .map(|i| (i.host().to_string(), i.keys_url().to_string()))
    }

    fn at(host: &str, keys: &str) -> Accepted {
        Ok((host.to_string(), keys.to_string()))
    }

    #[test]
    fn issuers_need_https_a_public_host_and_an_allowed_port() {
        let any = IssuerRules::default();
        assert_eq!(
            accepted(&any, "https://chat.example"),
            at("chat.example", "https://chat.example/.well-known/jwks.json")
        );
        assert_eq!(
            accepted(&any, "https://chat.example:443/"),
            at("chat.example", "https://chat.example/.well-known/jwks.json")
        );
        assert_eq!(
            accepted(&any, "https://chat.example:8443"),
            at(
                "chat.example:8443",
                "https://chat.example:8443/.well-known/jwks.json"
            )
        );
        assert_eq!(
            accepted(&any, "https://Chat.Example:80/"),
            at(
                "chat.example:80",
                "https://chat.example:80/.well-known/jwks.json"
            )
        );
        assert_eq!(
            accepted(&any, "https://93.184.216.34:8443"),
            at(
                "93.184.216.34:8443",
                "https://93.184.216.34:8443/.well-known/jwks.json"
            )
        );
        assert_eq!(
            accepted(&any, "https://[2606:4700::1111]:8443"),
            at(
                "[2606:4700::1111]:8443",
                "https://[2606:4700::1111]:8443/.well-known/jwks.json"
            )
        );
        for bad in [
            "http://chat.example",
            "http://chat.example:8443",
            "https://chat.example:0",
            "http://127.0.0.1:3000",
            "https://127.0.0.1:3000",
            "https://localhost",
            "https://localhost:8443",
            "https://app.localhost",
            "https://printer.local:8443",
            "https://10.0.0.5:8443",
            "https://172.16.0.1",
            "https://192.168.1.10:8443",
            "https://169.254.169.254",
            "https://100.64.0.1",
            "https://0.0.0.0",
            "https://[::1]:8443",
            "https://[fd00::1]",
            "https://[fe80::1]",
            "https://[::ffff:10.0.0.1]",
            "https://chat.example/sub",
            "https://chat.example:8443/sub",
            "https://chat.example:8443/?x",
            "https://u:p@chat.example:8443",
            "ftp://chat.example",
            "not a url",
        ] {
            assert_eq!(accepted(&any, bad), Err(VerifyError::Issuer), "{bad}");
        }
        let local = IssuerRules::default().allow_local();
        assert_eq!(
            accepted(&local, "http://127.0.0.1:3000"),
            at(
                "127.0.0.1:3000",
                "http://127.0.0.1:3000/.well-known/jwks.json"
            )
        );
        assert!(accepted(&local, "http://localhost:3000/").is_ok());
        assert!(accepted(&local, "https://chat.example:8443").is_ok());
        for bad in ["http://chat.example", "http://localhost:0"] {
            assert_eq!(accepted(&local, bad), Err(VerifyError::Issuer), "{bad}");
        }
        let only = IssuerRules::new(IssuerPorts::parse("443").unwrap());
        assert!(accepted(&only, "https://chat.example").is_ok());
        assert!(accepted(&only, "https://chat.example:443").is_ok());
        for refused in ["https://chat.example:8443", "https://93.184.216.34:22"] {
            assert_eq!(
                accepted(&only, refused),
                Err(VerifyError::Port),
                "{refused}"
            );
        }
        for bad in ["http://chat.example:8443", "https://10.0.0.5:8443"] {
            assert_eq!(accepted(&only, bad), Err(VerifyError::Issuer), "{bad}");
        }
        let two = IssuerRules::new(IssuerPorts::parse(" 443, 8443 ").unwrap()).allow_local();
        assert!(accepted(&two, "https://chat.example:8443").is_ok());
        assert_eq!(
            accepted(&two, "https://chat.example:9443"),
            Err(VerifyError::Port)
        );
        assert_eq!(
            accepted(&two, "http://127.0.0.1:3000"),
            Err(VerifyError::Port)
        );
        assert_eq!(split_qualified("a@b@host:3000"), Some(("a@b", "host:3000")));
        assert_eq!(split_qualified("@host"), None);
        assert_eq!(split_qualified("alice"), None);
    }

    #[test]
    fn issuer_ports_are_a_list_or_any() {
        assert_eq!(IssuerPorts::parse("").unwrap(), IssuerPorts::Any);
        assert_eq!(IssuerPorts::parse(" , ").unwrap(), IssuerPorts::Any);
        assert_eq!(
            IssuerPorts::parse("443").unwrap(),
            IssuerPorts::Only(BTreeSet::from([443]))
        );
        assert_eq!(
            IssuerPorts::parse("8443, 443,443").unwrap(),
            IssuerPorts::Only(BTreeSet::from([443, 8443]))
        );
        assert_eq!(
            IssuerPorts::parse("65535").unwrap(),
            IssuerPorts::Only(BTreeSet::from([65535]))
        );
        for bad in [
            "0", "65536", "-1", "+443", "443x", "4 43", "https", "443;8443",
        ] {
            let err = IssuerPorts::parse(bad).err().unwrap().to_string();
            assert!(err.contains("OTHER_INSTANCE_PORTS"), "{bad}: {err}");
        }
    }

    #[tokio::test]
    async fn another_port_of_the_host_is_another_issuer() {
        const SIDE: &str = "https://chat.example:8443";
        let main = Keyring::parse(&new_seed()).unwrap();
        let side = Keyring::parse(&new_seed()).unwrap();
        let verifier = Verifier::default();
        let (home, other) = (issuer(ISS), issuer(SIDE));
        assert_ne!(home.keys_url(), other.keys_url());
        verifier.remember(&home, &Ok(main.jwks()));
        verifier.remember(&other, &Ok(side.jwks()));
        let sub = |c: Result<Claims, VerifyError>| c.map(|c| c.sub);
        let own = side
            .sign(&claims(SIDE, "alice@chat.example:8443", AUD, 60, None))
            .unwrap();
        assert_eq!(
            sub(verifier.verify(&own, AUD, None).await),
            Ok("alice@chat.example:8443".to_string())
        );
        let posing = side.sign(&claims(ISS, SUB, AUD, 60, None)).unwrap();
        assert_eq!(
            verifier.verify(&posing, AUD, None).await,
            Err(VerifyError::UnknownKey)
        );
        let naming = side.sign(&claims(SIDE, SUB, AUD, 60, None)).unwrap();
        assert_eq!(
            verifier.verify(&naming, AUD, None).await,
            Err(VerifyError::Subject)
        );
        let down = main
            .sign(&claims(SIDE, "alice@chat.example:8443", AUD, 60, None))
            .unwrap();
        assert_eq!(
            verifier.verify(&down, AUD, None).await,
            Err(VerifyError::UnknownKey)
        );
        let real = main.sign(&claims(ISS, SUB, AUD, 60, None)).unwrap();
        assert_eq!(
            sub(verifier.verify(&real, AUD, None).await),
            Ok(SUB.to_string())
        );
        let closed = issuer("https://chat.example:9443");
        verifier.remember(&closed, &Err("connection refused".to_string()));
        assert!(matches!(
            verifier.cached(&closed, JWKS_TTL),
            Some(Err(VerifyError::Fetch(_)))
        ));
        assert_eq!(verifier.cached(&home, JWKS_TTL), Some(Ok(main.jwks())));
        assert_eq!(verifier.cached(&other, JWKS_TTL), Some(Ok(side.jwks())));
        assert_eq!(verifier.cache_len(), 3);
    }

    #[tokio::test]
    async fn every_spelling_of_an_origin_verifies_as_its_one_origin() {
        let ring = Keyring::parse(&new_seed()).unwrap();
        let verifier = Verifier::default();
        verifier.remember(&issuer(ISS), &Ok(ring.jwks()));
        let spelled = |iss: &str, jti: &str| {
            let mut c = claims(iss, SUB, AUD, 60, None);
            c.jti = jti.to_string();
            ring.sign(&c).unwrap()
        };
        for (iss, jti) in [
            ("https://chat.example:443", "j1"),
            ("https://CHAT.example/", "j2"),
            (ISS, "j3"),
        ] {
            assert_eq!(issuer(iss).origin(), ISS, "{iss}");
            assert_eq!(
                verifier
                    .verify(&spelled(iss, jti), AUD, None)
                    .await
                    .map(|c| c.iss),
                Ok(ISS.to_string()),
                "{iss}"
            );
        }
        assert_eq!(verifier.cache_len(), 1);
        assert_eq!(
            verifier
                .verify(&spelled("https://chat.example:443", "j3"), AUD, None)
                .await,
            Err(VerifyError::Replay)
        );
        assert_eq!(
            issuer("https://chat.example:8443").origin(),
            "https://chat.example:8443"
        );
    }

    #[tokio::test]
    async fn a_narrowed_port_list_refuses_before_any_fetch() {
        let ring = Keyring::parse(&new_seed()).unwrap();
        let verifier = Verifier::new(
            JWKS_TTL,
            IssuerRules::new(IssuerPorts::parse("443").unwrap()),
        );
        let token = ring
            .sign(&claims(
                "https://chat.example:8443",
                "alice@chat.example:8443",
                AUD,
                60,
                None,
            ))
            .unwrap();
        assert_eq!(
            verifier.verify(&token, AUD, None).await,
            Err(VerifyError::Port)
        );
        assert_eq!(
            verifier.keys("https://chat.example:8443").await,
            Err(VerifyError::Port)
        );
        assert_eq!(verifier.cache_len(), 0);
        assert_eq!(
            VerifyError::Port.to_string(),
            "issuer port is not accepted here"
        );
        verifier.remember(&verifier.accept(ISS).unwrap(), &Ok(ring.jwks()));
        let fine = ring.sign(&claims(ISS, SUB, AUD, 60, None)).unwrap();
        assert!(verifier.verify(&fine, AUD, None).await.is_ok());
    }

    #[tokio::test]
    async fn verifier_refuses_private_issuers_and_caches_failures() {
        let ring = Keyring::parse(&new_seed()).unwrap();
        let verifier = Verifier::default();
        for iss in [
            "https://127.0.0.1:1",
            "https://10.0.0.5",
            "https://10.0.0.5:8443",
            "https://[::1]:1",
            "https://localhost:1",
            "https://localhost:8443",
            "http://127.0.0.1:1",
        ] {
            let sub = format!(
                "a@{}",
                Url::parse(iss).ok().as_ref().and_then(host_of).unwrap()
            );
            let token = ring.sign(&claims(iss, &sub, AUD, 60, None)).unwrap();
            assert_eq!(
                verifier.verify(&token, AUD, None).await,
                Err(VerifyError::Issuer),
                "{iss}"
            );
        }
        assert_eq!(verifier.cache_len(), 0);
        for port in [1, 8443] {
            let origin = format!("https://localhost.:{port}");
            let slipped = Issuer {
                iss: origin.clone(),
                origin: origin.clone(),
                host: format!("localhost.:{port}"),
                keys: Url::parse(&origin).unwrap().join(JWKS_PATH).unwrap(),
            };
            let first = verifier.fetch(&slipped).await;
            assert!(matches!(first, Err(VerifyError::Fetch(_))), "{first:?}");
            assert!(matches!(
                verifier.cached(&slipped, JWKS_TTL),
                Some(Err(VerifyError::Fetch(_)))
            ));
        }
    }

    #[tokio::test]
    async fn verifier_rejects_replayed_assertions() {
        let ring = Keyring::parse(&new_seed()).unwrap();
        let verifier = Verifier::default();
        verifier.remember(&issuer(ISS), &Ok(ring.jwks()));
        let token = ring.sign(&claims(ISS, SUB, AUD, 60, None)).unwrap();
        assert!(verifier.verify(&token, AUD, None).await.is_ok());
        assert_eq!(
            verifier.verify(&token, AUD, None).await,
            Err(VerifyError::Replay)
        );
        let fresh = ring.sign(&claims(ISS, SUB, AUD, 60, None)).unwrap();
        assert!(verifier.verify(&fresh, AUD, None).await.is_ok());
        let now = crate::db::now();
        let first = claims(ISS, SUB, AUD, 60, None);
        let other = |n: usize, iss: &str| {
            let mut c = claims(iss, SUB, AUD, 60, None);
            c.jti = format!("j{n}");
            c.iat = now;
            c.exp = now + 60;
            c
        };
        for n in 0..SEEN_PER_ISSUER - 2 {
            assert!(verifier.first_use(&other(n, ISS), now).is_ok());
        }
        assert_eq!(
            verifier.first_use(&other(SEEN_PER_ISSUER, ISS), now),
            Err(VerifyError::Replay),
            "a full issuer fails closed"
        );
        assert_eq!(
            verifier.first_use(&first, now),
            Err(VerifyError::Replay),
            "old entries are never evicted while live"
        );
        let elsewhere = "https://b.example";
        assert!(verifier.first_use(&other(0, elsewhere), now).is_ok());
        let later = now + 60 + LEEWAY_SECS + 1;
        assert!(
            verifier
                .first_use(&other(SEEN_PER_ISSUER, ISS), later)
                .is_ok()
        );
        let left: usize = verifier
            .seen
            .lock()
            .unwrap()
            .values()
            .map(HashMap::len)
            .sum();
        assert_eq!(left, 1, "expired entries are dropped once full");
        let busy = Verifier::default();
        for i in 0..SEEN_MAX / SEEN_PER_ISSUER {
            let iss = format!("https://i{i}.example");
            for n in 0..SEEN_PER_ISSUER {
                assert!(busy.first_use(&other(n, &iss), now).is_ok());
            }
        }
        assert_eq!(
            busy.first_use(&other(0, elsewhere), now),
            Err(VerifyError::Replay)
        );
    }

    #[test]
    fn key_cache_is_capped() {
        let verifier = Verifier::default();
        let issuers: Vec<Issuer> = (0..CACHE_MAX + 50)
            .map(|n| issuer(&format!("https://h{n}.example")))
            .collect();
        for one in &issuers {
            verifier.remember(one, &Ok(JwkSet::default()));
        }
        assert_eq!(verifier.cache_len(), CACHE_MAX);
        assert!(verifier.cached(&issuers[0], JWKS_TTL).is_none());
        assert!(
            verifier
                .cached(&issuers[CACHE_MAX + 49], JWKS_TTL)
                .is_some()
        );
    }
}
