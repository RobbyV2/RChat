use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::{Host, Url};

pub const ASSERTION_TTL_SECS: i64 = 300;
pub const JWKS_PATH: &str = "/.well-known/jwks.json";
pub const ALG: &str = "EdDSA";
const TYP: &str = "JWT";
const JWKS_TTL: Duration = Duration::from_secs(600);
const REFETCH_EVERY: Duration = Duration::from_secs(30);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const JWKS_MAX_BYTES: usize = 64 * 1024;
const LEEWAY_SECS: i64 = 30;
const CACHE_MAX: usize = 1024;
const JTI_MAX: usize = 128;

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

    pub fn sign(&self, claims: &Claims) -> anyhow::Result<String> {
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

pub fn jwks_url(iss: &str, allow_local: bool) -> Result<Url, VerifyError> {
    let url = Url::parse(iss).map_err(|_| VerifyError::Issuer)?;
    let public = match url.host() {
        Some(Host::Domain(d)) => !local_name(d),
        Some(Host::Ipv4(ip)) => crate::api::embeds::ip_ok(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => crate::api::embeds::ip_ok(IpAddr::V6(ip)),
        None => return Err(VerifyError::Issuer),
    };
    let scheme = match url.scheme() {
        "https" => true,
        "http" => allow_local && !public,
        _ => false,
    };
    let port = !public || url.port_or_known_default() == Some(443);
    let bare = matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    match scheme && port && bare && (public || allow_local) {
        true => url.join(JWKS_PATH).map_err(|_| VerifyError::Issuer),
        false => Err(VerifyError::Issuer),
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
    iss: &str,
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
    if claims.iss != iss {
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
    let issuer_host = Url::parse(iss)
        .ok()
        .as_ref()
        .and_then(host_of)
        .ok_or(VerifyError::Issuer)?;
    match split_qualified(&claims.sub) {
        Some((_, host)) if host.eq_ignore_ascii_case(&issuer_host) => Ok(claims),
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
    allow_local: bool,
    cache: Mutex<HashMap<String, Cached>>,
}

impl Default for Verifier {
    fn default() -> Verifier {
        Verifier::new(JWKS_TTL)
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
    pub fn new(ttl: Duration) -> Verifier {
        Verifier {
            ttl,
            allow_local: false,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn allow_local(self) -> Verifier {
        Verifier {
            allow_local: true,
            ..self
        }
    }

    fn cached(&self, url: &str, max_age: Duration) -> Option<Result<JwkSet, VerifyError>> {
        let mut cache = self.cache.lock().ok()?;
        let entry = cache
            .get_mut(url)
            .filter(|c| c.fresh(max_age.min(self.ttl)))?;
        entry.used = Instant::now();
        Some(entry.keys.clone().map_err(VerifyError::Fetch))
    }

    fn remember(&self, url: &Url, keys: &Result<JwkSet, String>) {
        let Ok(mut cache) = self.cache.lock() else {
            return;
        };
        if cache.len() >= CACHE_MAX && !cache.contains_key(url.as_str()) {
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

    async fn download(&self, url: &Url) -> Result<JwkSet, String> {
        let addrs = resolve(url, self.allow_local).await?;
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

    async fn fetch(&self, url: &Url) -> Result<JwkSet, VerifyError> {
        let keys = self.download(url).await;
        self.remember(url, &keys);
        keys.map_err(VerifyError::Fetch)
    }

    pub async fn keys(&self, iss: &str) -> Result<JwkSet, VerifyError> {
        let url = jwks_url(iss, self.allow_local)?;
        match self.cached(url.as_str(), self.ttl) {
            Some(keys) => keys,
            None => self.fetch(&url).await,
        }
    }

    pub async fn verify(
        &self,
        token: &str,
        aud: &str,
        nonce: Option<&str>,
    ) -> Result<Claims, VerifyError> {
        let iss = unverified_issuer(token)?;
        let keys = self.keys(&iss).await?;
        match verify_with(token, &keys, &iss, aud, nonce) {
            Err(VerifyError::UnknownKey) => {
                let url = jwks_url(&iss, self.allow_local)?;
                if self.cached(url.as_str(), REFETCH_EVERY).is_some() {
                    return Err(VerifyError::UnknownKey);
                }
                let keys = self.fetch(&url).await?;
                verify_with(token, &keys, &iss, aud, nonce)
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

    #[test]
    fn sign_verify_and_rejections() {
        let ring = Keyring::parse(&new_seed()).unwrap();
        let jwks = ring.jwks();
        let token = ring.sign(&claims(ISS, SUB, AUD, 300, Some("n1"))).unwrap();
        let ok = verify_with(&token, &jwks, ISS, AUD, Some("n1")).unwrap();
        assert_eq!(ok.sub, SUB);
        assert_eq!(
            verify_with(&token, &jwks, ISS, AUD, None)
                .unwrap()
                .nonce
                .as_deref(),
            Some("n1")
        );
        assert_eq!(
            verify_with(&token, &jwks, ISS, "https://c.example", Some("n1")),
            Err(VerifyError::Audience)
        );
        assert_eq!(
            verify_with(&token, &jwks, ISS, AUD, Some("n2")),
            Err(VerifyError::Nonce)
        );
        let bare = ring.sign(&claims(ISS, SUB, AUD, 300, None)).unwrap();
        assert_eq!(
            verify_with(&bare, &jwks, ISS, AUD, Some("n1")),
            Err(VerifyError::Nonce)
        );
        assert_eq!(
            verify_with(&token, &jwks, "https://other.example", AUD, None),
            Err(VerifyError::Issuer)
        );
        let other = Keyring::parse(&new_seed()).unwrap();
        assert_eq!(
            verify_with(&token, &other.jwks(), ISS, AUD, None),
            Err(VerifyError::UnknownKey)
        );
        let mut forged = other.jwks();
        forged.keys[0].kid = Some(ring.active().kid.clone());
        assert_eq!(
            verify_with(&token, &forged, ISS, AUD, None),
            Err(VerifyError::Signature)
        );
        let mut twice = jwks.clone();
        twice.keys.push(forged.keys[0].clone());
        assert_eq!(
            verify_with(&token, &twice, ISS, AUD, None),
            Err(VerifyError::UnknownKey)
        );
        let mut rsa = jwks.clone();
        rsa.keys[0].kty = "RSA".to_string();
        assert_eq!(
            verify_with(&token, &rsa, ISS, AUD, None),
            Err(VerifyError::UnknownKey)
        );
        let mut old = claims(ISS, SUB, AUD, 300, None);
        old.iat -= 1000;
        old.exp -= 1000;
        assert_eq!(
            verify_with(&ring.sign(&old).unwrap(), &jwks, ISS, AUD, None),
            Err(VerifyError::Expired)
        );
        let mut skewed = claims(ISS, SUB, AUD, 300, None);
        skewed.iat -= 310;
        skewed.exp -= 310;
        assert!(verify_with(&ring.sign(&skewed).unwrap(), &jwks, ISS, AUD, None).is_ok());
        let mut future = claims(ISS, SUB, AUD, 60, None);
        future.iat += 600;
        future.exp += 600;
        assert_eq!(
            verify_with(&ring.sign(&future).unwrap(), &jwks, ISS, AUD, None),
            Err(VerifyError::Lifetime)
        );
        let long = ring.sign(&claims(ISS, SUB, AUD, 3600, None)).unwrap();
        assert_eq!(
            verify_with(&long, &jwks, ISS, AUD, None),
            Err(VerifyError::Lifetime)
        );
        let mut no_jti = claims(ISS, SUB, AUD, 60, None);
        no_jti.jti.clear();
        assert_eq!(
            verify_with(&ring.sign(&no_jti).unwrap(), &jwks, ISS, AUD, None),
            Err(VerifyError::Malformed)
        );
        let foreign = ring
            .sign(&claims(ISS, "alice@evil.example", AUD, 60, None))
            .unwrap();
        assert_eq!(
            verify_with(&foreign, &jwks, ISS, AUD, None),
            Err(VerifyError::Subject)
        );
        let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
        parts[1] =
            b64(&serde_json::to_value(claims(ISS, "root@chat.example", AUD, 60, None)).unwrap());
        assert_eq!(
            verify_with(&parts.join("."), &jwks, ISS, AUD, None),
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
        assert!(verify_with(&good, &jwks, ISS, AUD, None).is_ok());
        let payload = good.split('.').nth(1).unwrap().to_string();
        let none = format!(
            "{}.{payload}.",
            b64(&serde_json::json!({"alg": "none", "kid": kid, "typ": "JWT"}))
        );
        assert_eq!(
            verify_with(&none, &jwks, ISS, AUD, None),
            Err(VerifyError::Malformed)
        );
        let none_signed = with_header(
            &ring,
            serde_json::json!({"alg": "none", "kid": kid, "typ": "JWT"}),
            &body,
        );
        assert_eq!(
            verify_with(&none_signed, &jwks, ISS, AUD, None),
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
                verify_with(&token, &jwks, ISS, AUD, None),
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
            verify_with(&hs, &jwks, ISS, AUD, None),
            Err(VerifyError::Algorithm)
        );
        for header in [
            serde_json::json!({"alg": "EdDSA", "typ": "JWT"}),
            serde_json::json!({"alg": "EdDSA", "kid": 7, "typ": "JWT"}),
            serde_json::json!({"alg": "EdDSA", "kid": "other", "typ": "JWT"}),
        ] {
            let token = with_header(&ring, header.clone(), &body);
            assert_eq!(
                verify_with(&token, &jwks, ISS, AUD, None),
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
                verify_with(&token, &jwks, ISS, AUD, None),
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
                verify_with(&bad, &jwks, ISS, AUD, None),
                Err(VerifyError::Malformed),
                "{bad}"
            );
        }
    }

    #[test]
    fn jwks_urls_need_https_and_a_public_host() {
        assert_eq!(
            jwks_url("https://chat.example", false).unwrap().as_str(),
            "https://chat.example/.well-known/jwks.json"
        );
        assert!(jwks_url("https://chat.example:443/", false).is_ok());
        assert!(jwks_url("https://93.184.216.34", false).is_ok());
        for bad in [
            "https://chat.example:8443/",
            "https://chat.example:80",
            "https://93.184.216.34:22",
            "http://chat.example",
            "http://127.0.0.1:3000",
            "https://127.0.0.1:3000",
            "https://localhost",
            "https://app.localhost",
            "https://printer.local",
            "https://10.0.0.5:8443",
            "https://172.16.0.1",
            "https://192.168.1.10",
            "https://169.254.169.254",
            "https://100.64.0.1",
            "https://0.0.0.0",
            "https://[::1]",
            "https://[fd00::1]",
            "https://[fe80::1]",
            "https://[::ffff:10.0.0.1]",
            "https://chat.example/sub",
            "https://u:p@chat.example",
            "ftp://chat.example",
            "not a url",
        ] {
            assert_eq!(jwks_url(bad, false), Err(VerifyError::Issuer), "{bad}");
        }
        assert!(jwks_url("http://127.0.0.1:3000", true).is_ok());
        assert!(jwks_url("http://localhost:3000/", true).is_ok());
        assert_eq!(
            jwks_url("https://chat.example:8443", true),
            Err(VerifyError::Issuer)
        );
        assert_eq!(
            jwks_url("http://chat.example", true),
            Err(VerifyError::Issuer)
        );
        assert_eq!(split_qualified("a@b@host:3000"), Some(("a@b", "host:3000")));
        assert_eq!(split_qualified("@host"), None);
        assert_eq!(split_qualified("alice"), None);
    }

    #[tokio::test]
    async fn verifier_refuses_private_issuers_and_caches_failures() {
        let ring = Keyring::parse(&new_seed()).unwrap();
        let verifier = Verifier::default();
        for iss in [
            "https://127.0.0.1:1",
            "https://10.0.0.5",
            "https://[::1]:1",
            "https://localhost:1",
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
        let url = Url::parse("https://localhost.:1/.well-known/jwks.json").unwrap();
        let first = verifier.fetch(&url).await;
        assert!(matches!(first, Err(VerifyError::Fetch(_))), "{first:?}");
        assert!(matches!(
            verifier.cached(url.as_str(), JWKS_TTL),
            Some(Err(VerifyError::Fetch(_)))
        ));
    }

    #[test]
    fn key_cache_is_capped() {
        let verifier = Verifier::default();
        for n in 0..CACHE_MAX + 50 {
            let url = Url::parse(&format!("https://h{n}.example/.well-known/jwks.json")).unwrap();
            verifier.remember(&url, &Ok(JwkSet::default()));
        }
        assert_eq!(verifier.cache_len(), CACHE_MAX);
        assert!(
            verifier
                .cached("https://h0.example/.well-known/jwks.json", JWKS_TTL)
                .is_none()
        );
        assert!(
            verifier
                .cached(
                    &format!("https://h{}.example/.well-known/jwks.json", CACHE_MAX + 49),
                    JWKS_TTL
                )
                .is_some()
        );
    }
}
