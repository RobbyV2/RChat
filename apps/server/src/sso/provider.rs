use super::config::ProviderConfig;
use super::jwt::{Alg, SsoError};
use jsonwebtoken::DecodingKey;
use jsonwebtoken::jwk::{AlgorithmParameters, EllipticCurve, Jwk, KeyOperations, PublicKeyUse};
use reqwest::{Client, Response};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Mutex, time::Instant};
use url::Url;

pub const METADATA_TTL: Duration = Duration::from_secs(3600);
pub const JWKS_TTL: Duration = Duration::from_secs(3600);
pub const JWKS_REFRESH_MIN: Duration = Duration::from_secs(60);
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
pub const BODY_MAX: usize = 1024 * 1024;

#[derive(Clone, Deserialize)]
pub struct Metadata {
    pub issuer: String,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub jwks_uri: Url,
    pub end_session_endpoint: Option<Url>,
}

impl Metadata {
    fn validate(&self, configured: &str) -> Result<(), SsoError> {
        if self.issuer != configured {
            return Err(SsoError::Invalid("discovery issuer mismatch"));
        }
        for url in [
            Some(&self.authorization_endpoint),
            Some(&self.token_endpoint),
            Some(&self.jwks_uri),
            self.end_session_endpoint.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            let local_http = configured.starts_with("http://")
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
            if !url.has_host()
                || (!local_http && url.scheme() != "https")
                || url.fragment().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(SsoError::Invalid("invalid discovery endpoint"));
            }
        }
        Ok(())
    }
}

pub async fn bounded_json<T: DeserializeOwned>(mut response: Response) -> Result<T, SsoError> {
    if !response.status().is_success() {
        return Err(SsoError::Unavailable);
    }
    if response
        .content_length()
        .is_some_and(|n| n > BODY_MAX as u64)
    {
        return Err(SsoError::Invalid("provider response too large"));
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| SsoError::Unavailable)? {
        if chunk.len() > BODY_MAX - data.len() {
            return Err(SsoError::Invalid("provider response too large"));
        }
        data.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&data).map_err(|_| SsoError::Invalid("invalid provider document"))
}

async fn fetch<T: DeserializeOwned>(http: &Client, url: &str) -> Result<T, SsoError> {
    let response = http
        .get(url)
        .header("accept", "application/json")
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|_| SsoError::Unavailable)?;
    bounded_json(response).await
}

struct SigningKey {
    alg: Alg,
    kid: Option<String>,
    key: DecodingKey,
}
impl SigningKey {
    fn from_jwk(value: Value) -> Option<Self> {
        let jwk: Jwk = serde_json::from_value(value).ok()?;
        let alg = match &jwk.algorithm {
            AlgorithmParameters::RSA(_) => Alg::Rs256,
            AlgorithmParameters::EllipticCurve(p) if p.curve == EllipticCurve::P256 => Alg::Es256,
            AlgorithmParameters::OctetKeyPair(p) if p.curve == EllipticCurve::Ed25519 => Alg::EdDsa,
            _ => return None,
        };
        if jwk
            .common
            .key_algorithm
            .is_some_and(|a| a != jsonwebtoken::Algorithm::from(alg).into())
            || jwk
                .common
                .public_key_use
                .as_ref()
                .is_some_and(|u| *u != PublicKeyUse::Signature)
            || jwk
                .common
                .key_operations
                .as_ref()
                .is_some_and(|ops| !ops.contains(&KeyOperations::Verify))
        {
            return None;
        }
        let key = DecodingKey::from_jwk(&jwk).ok()?;
        Some(Self {
            alg,
            kid: jwk.common.key_id,
            key,
        })
    }
}

#[derive(Default)]
struct KeyCache {
    uri: Option<Url>,
    loaded: Option<Instant>,
    retry_after: Option<Instant>,
    keys: Vec<SigningKey>,
}

impl KeyCache {
    fn select(&self, alg: Alg, kid: Option<&str>) -> Result<Option<DecodingKey>, SsoError> {
        let mut matching = self.keys.iter().filter(|entry| {
            entry.alg == alg && kid.is_none_or(|id| entry.kid.as_deref() == Some(id))
        });
        match (matching.next(), matching.next()) {
            (Some(entry), None) => Ok(Some(entry.key.clone())),
            (None, _) => Ok(None),
            _ => Err(SsoError::Invalid("ambiguous signing key")),
        }
    }
}

type MetadataResult = Result<Arc<Metadata>, SsoError>;
pub struct Provider {
    pub config: ProviderConfig,
    discovery: Mutex<Option<(Instant, MetadataResult)>>,
    keys: Mutex<KeyCache>,
    fetches: AtomicU64,
}

impl Provider {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            config,
            discovery: Mutex::default(),
            keys: Mutex::default(),
            fetches: AtomicU64::default(),
        }
    }

    pub async fn metadata(&self, http: &Client) -> MetadataResult {
        let mut cached = self.discovery.lock().await;
        if let Some((until, res)) = cached.as_ref()
            && *until > Instant::now()
        {
            return res.clone();
        }
        let issuer = &self.config.issuer;
        let url = format!(
            "{}/.well-known/openid-configuration",
            issuer.strip_suffix('/').unwrap_or(issuer)
        );
        let result = fetch::<Metadata>(http, &url).await.and_then(|doc| {
            doc.validate(issuer)?;
            Ok(Arc::new(doc))
        });
        let ttl = if result.is_ok() {
            METADATA_TTL
        } else {
            FETCH_TIMEOUT
        };
        *cached = Some((Instant::now() + ttl, result.clone()));
        result
    }

    pub async fn key(
        &self,
        http: &Client,
        alg: Alg,
        kid: Option<&str>,
    ) -> Result<DecodingKey, SsoError> {
        #[derive(Deserialize)]
        struct Keys {
            keys: Vec<Value>,
        }
        let mut cache = self.keys.lock().await;
        let metadata = self.metadata(http).await?;
        if cache.uri.as_ref() != Some(&metadata.jwks_uri) {
            *cache = KeyCache {
                uri: Some(metadata.jwks_uri.clone()),
                ..Default::default()
            };
        }
        let fresh = cache.loaded.is_some_and(|t| t.elapsed() < JWKS_TTL);
        if fresh {
            if let Some(key) = cache.select(alg, kid)? {
                return Ok(key);
            }
            if kid.is_none() {
                return Err(SsoError::Invalid("missing signing key"));
            }
        }
        if cache.retry_after.is_some_and(|t| t > Instant::now()) {
            return Err(if fresh {
                SsoError::Invalid("unknown signing key")
            } else {
                SsoError::Unavailable
            });
        }
        cache.retry_after = Some(Instant::now() + JWKS_REFRESH_MIN);
        self.fetches.fetch_add(1, Ordering::Relaxed);
        let doc: Keys = fetch(http, metadata.jwks_uri.as_str()).await?;
        cache.keys = doc
            .keys
            .into_iter()
            .filter_map(SigningKey::from_jwk)
            .collect();
        cache.loaded = Some(Instant::now());
        let key = cache.select(alg, kid)?;
        // A successful scheduled load can immediately be followed by a rotation.
        if !fresh && key.is_some() {
            cache.retry_after = None;
        }
        key.ok_or(SsoError::Invalid("unknown signing key"))
    }
    pub fn jwks_fetches(&self) -> u64 {
        self.fetches.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sso::{Sso, config::SsoConfig, fake_idp::FakeIdp, jwt};
    use axum::{Router, routing::get};
    use serde_json::json;
    use tokio::net::TcpListener;

    fn configured(idp: &FakeIdp) -> Sso {
        Sso::new(SsoConfig {
            providers: vec![idp.provider_config("test")],
            ..Default::default()
        })
        .unwrap()
    }

    #[tokio::test]
    async fn unknown_kid_refreshes_once() {
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let sso = configured(&idp);
        let provider = sso.provider("test").unwrap();
        let now = crate::db::now();
        let claims = json!({"iss":idp.issuer,"aud":idp.client_id,"sub":"test","exp":now+60,"iat":now,"nonce":"test"});
        for expected in [1, 2] {
            let token = idp.sign(claims.clone());
            let (alg, kid) = jwt::header(&token).unwrap();
            let key = provider.key(sso.http(), alg, kid.as_deref()).await.unwrap();
            jwt::verify_id_token(
                &token,
                &key,
                alg,
                &jwt::Expect {
                    issuer: &idp.issuer,
                    client_id: &idp.client_id,
                    nonce: "test",
                    now,
                },
            )
            .unwrap();
            assert_eq!(idp.jwks_fetches(), expected);
            if expected == 1 {
                idp.rotate_key();
            }
        }
        let mut attempts = tokio::task::JoinSet::new();
        for _ in 0..50 {
            let p = provider.clone();
            let http = sso.http().clone();
            attempts.spawn(async move {
                p.key(&http, Alg::EdDsa, Some(&rand::random::<u64>().to_string()))
                    .await
                    .is_err()
            });
        }
        while let Some(r) = attempts.join_next().await {
            assert!(r.unwrap());
        }
        assert_eq!(idp.jwks_fetches(), 2);
        tokio::time::pause();
        tokio::time::advance(JWKS_REFRESH_MIN).await;
        tokio::time::resume();
        idp.rotate_key();
        let (alg, kid) = jwt::header(&idp.sign(claims)).unwrap();
        provider.key(sso.http(), alg, kid.as_deref()).await.unwrap();
        assert_eq!(idp.jwks_fetches(), 3);
    }
    #[tokio::test]
    async fn metadata_is_cached() {
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let sso = configured(&idp);
        let p = sso.provider("test").unwrap();
        let (first, second) = tokio::join!(p.metadata(sso.http()), p.metadata(sso.http()));
        assert!(Arc::ptr_eq(&first.unwrap(), &second.unwrap()));
        assert_eq!(idp.metadata_fetches(), 1);
        assert!(sso.provider("unknown").is_none());
        tokio::time::pause();
        tokio::time::advance(METADATA_TTL).await;
        tokio::time::resume();
        p.metadata(sso.http()).await.unwrap();
        assert_eq!(idp.metadata_fetches(), 2);
    }
    #[tokio::test]
    async fn metadata_must_match_the_issuer() {
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let sso = configured(&idp);
        let mut config = idp.provider_config("test");
        config.issuer.push('/');
        let p = Provider::new(config);
        assert!(p.metadata(sso.http()).await.is_err());
        let mut metadata = sso
            .provider("test")
            .unwrap()
            .metadata(sso.http())
            .await
            .unwrap();
        assert_eq!(metadata.issuer, idp.issuer);
        Arc::make_mut(&mut metadata).issuer.push('/');
        metadata.validate(&format!("{}/", idp.issuer)).unwrap();
        assert!(metadata.validate(&idp.issuer).is_err());
        assert!(metadata.validate("https://other.example").is_err());
        let mut doc:Metadata = serde_json::from_value(json!({"issuer":idp.issuer,"authorization_endpoint":"http://remote.invalid/auth",
            "token_endpoint":"https://provider.invalid/token","jwks_uri":"https://provider.invalid/jwks"})).unwrap();
        assert!(doc.validate(&idp.issuer).is_err());
        doc.authorization_endpoint = Url::parse("https://provider.invalid/auth").unwrap();
        doc.token_endpoint = Url::parse("https://user@provider.invalid/token").unwrap();
        assert!(doc.validate(&idp.issuer).is_err());
    }

    #[tokio::test]
    async fn idp_unreachable_is_an_error_not_a_panic() {
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let sso = configured(&idp);
        drop(idp);
        tokio::task::yield_now().await;
        let p = sso.provider("test").unwrap();
        assert!(matches!(
            tokio::time::timeout(FETCH_TIMEOUT, p.metadata(sso.http()))
                .await
                .unwrap(),
            Err(SsoError::Unavailable)
        ));
    }

    #[tokio::test]
    async fn oversized_documents_and_redirects_are_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route(
                "/.well-known/openid-configuration",
                get(|| async { " ".repeat(2 * BODY_MAX) }),
            )
            .route(
                "/redirect",
                get(|| async { axum::response::Redirect::to("/target") }),
            )
            .route(
                "/stream",
                get(|| async {
                    let chunks = (0..2).map(|_| Ok::<_, std::io::Error>(vec![b' '; BODY_MAX]));
                    axum::body::Body::from_stream(futures_util::stream::iter(chunks))
                }),
            )
            .route("/target", get(|| async { "true" }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let mut config = idp.provider_config("test");
        config.issuer.clone_from(&issuer);
        let p = Provider::new(config);
        let sso = configured(&idp);
        assert!(matches!(
            p.metadata(sso.http()).await,
            Err(SsoError::Invalid("provider response too large"))
        ));
        assert!(
            fetch::<bool>(sso.http(), &format!("{issuer}/redirect"))
                .await
                .is_err()
        );
        assert!(matches!(
            fetch::<Value>(sso.http(), &format!("{issuer}/stream")).await,
            Err(SsoError::Invalid("provider response too large"))
        ));
        server.abort();
    }

    #[test]
    fn signing_keys_match_algorithm_curve_and_usage() {
        let base = json!({"kty":"OKP","crv":"Ed25519","x":"AA","kid":"id","alg":"EdDSA"});
        let key = SigningKey::from_jwk(base.clone()).unwrap();
        assert_eq!(key.alg, Alg::EdDsa);
        for (name, value) in [
            ("crv", json!("P-256")),
            ("alg", json!("RS256")),
            ("use", json!("enc")),
            ("key_ops", json!(["sign"])),
        ] {
            let mut v = base.clone();
            v[name] = value;
            assert!(SigningKey::from_jwk(v).is_none(), "{name}");
        }
    }
}
