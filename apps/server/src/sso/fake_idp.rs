use super::{
    config::{ProviderConfig, TokenAuth},
    jwt::Alg,
};
use crate::db::now;
use crate::{
    config::{Roles, Secret},
    state::AppState,
};
use aws_lc_rs::{
    encoding::{AsDer, Pkcs8V1Der},
    rsa::{KeyPair, KeySize},
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair},
};
use axum::{
    Form, Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ed25519_dalek::{SigningKey, pkcs8::EncodePrivateKey};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode, jwk::Jwk};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, task::JoinHandle};
use url::Url;

fn random_id() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

struct Signer {
    key: EncodingKey,
    header: Header,
    jwk: Jwk,
}
impl Signer {
    fn new(alg: Alg) -> Self {
        let key = match alg {
            Alg::Rs256 => {
                let pair = KeyPair::generate(KeySize::Rsa2048).unwrap();
                let der: Pkcs8V1Der = pair.as_der().unwrap();
                let pem = format!(
                    "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----",
                    STANDARD.encode(der.as_ref())
                );
                EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap()
            }
            Alg::Es256 => {
                let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
                EncodingKey::from_ec_der(pair.to_pkcs8v1().unwrap().as_ref())
            }
            Alg::EdDsa => {
                let pair = SigningKey::from_bytes(&rand::random());
                let mut pair = ed25519_dalek::pkcs8::KeypairBytes::from(pair);
                pair.public_key = None;
                EncodingKey::from_ed_der(pair.to_pkcs8_der().unwrap().as_bytes())
            }
        };
        let mut header = Header::new(alg.into());
        header.kid = Some(random_id());
        let mut jwk = Jwk::from_encoding_key(&key, alg.into()).unwrap();
        jwk.common.key_id.clone_from(&header.kid);
        Self { key, header, jwk }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Tamper {
    None,
    Issuer,
    Audience,
    Azp,
    Nonce,
    Expired,
    FutureIat,
    AlgNone,
    Hs256,
    UnknownKid,
    TokenError,
    IdpError(&'static str),
    NoAuthTime,
    StaleAuthTime,
}

type Shared = Arc<Mutex<Idp>>;
struct Idp {
    config: ProviderConfig,
    subject: String,
    signer: Signer,
    codes: HashMap<String, Authorize>,
    claims: Value,
    tamper: Tamper,
    fetches: u64,
    discoveries: u64,
}

pub(crate) struct FakeIdp {
    pub issuer: String,
    pub client_id: String,
    alg: Alg,
    state: Shared,
    task: JoinHandle<()>,
}
impl Drop for FakeIdp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeIdp {
    pub async fn start(alg: Alg) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let client_id = random_id();
        let config = ProviderConfig {
            id: "fake".into(),
            name: "Fixture provider".into(),
            issuer: issuer.clone(),
            client_id: client_id.clone(),
            client_secret: Some(Secret(random_id())),
            token_auth: TokenAuth::Basic,
            scopes: vec!["openid".into(), "profile".into()],
            username_claim: "preferred_username".into(),
            display_claim: "name".into(),
            groups_claim: "groups".into(),
            allowed_groups: vec![],
            auto_create: true,
            sync_profile: true,
            end_session: false,
        };
        let state = Arc::new(Mutex::new(Idp {
            config,
            subject: random_id(),
            signer: Signer::new(alg),
            codes: HashMap::new(),
            claims: json!({}),
            tamper: Tamper::None,
            fetches: 0,
            discoveries: 0,
        }));
        let app = Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route("/jwks", get(jwks))
            .route("/authorize", get(authorize))
            .route("/token", post(token))
            .route("/end_session", get(end_session))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            issuer,
            client_id,
            alg,
            state,
            task,
        }
    }

    pub fn provider_config(&self, id: &str) -> ProviderConfig {
        ProviderConfig {
            id: id.into(),
            ..self.state.lock().unwrap().config.clone()
        }
    }
    pub fn set_client_auth(&self, auth: TokenAuth, secret: Option<Secret>) {
        let mut state = self.state.lock().unwrap();
        state.config.token_auth = auth;
        state.config.client_secret = secret;
    }
    pub fn set_claims(&self, claims: Value) {
        self.state.lock().unwrap().claims = claims;
    }
    pub fn tamper(&self, tamper: Tamper) {
        self.state.lock().unwrap().tamper = tamper;
    }
    pub fn rotate_key(&self) {
        self.state.lock().unwrap().signer = Signer::new(self.alg);
    }
    pub fn sign(&self, claims: Value) -> String {
        let state = self.state.lock().unwrap();
        encode(&state.signer.header, &claims, &state.signer.key).unwrap()
    }
    pub fn jwks_fetches(&self) -> u64 {
        self.state.lock().unwrap().fetches
    }
    pub fn metadata_fetches(&self) -> u64 {
        self.state.lock().unwrap().discoveries
    }
}

async fn discovery(State(state): State<Shared>) -> Json<Value> {
    let mut s = state.lock().unwrap();
    s.discoveries += 1;
    let url = &s.config.issuer;
    Json(
        json!({"issuer":url,"authorization_endpoint":format!("{url}/authorize"),"token_endpoint":format!("{url}/token"),
        "jwks_uri":format!("{url}/jwks"),"end_session_endpoint":format!("{url}/end_session")}),
    )
}
async fn jwks(State(state): State<Shared>) -> Json<Value> {
    let mut s = state.lock().unwrap();
    s.fetches += 1;
    Json(json!({"keys":[s.signer.jwk]}))
}

fn loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
        && matches!(url.scheme(), "http" | "https")
}

#[derive(Deserialize)]
struct Authorize {
    redirect_uri: Url,
    state: String,
    nonce: String,
    code_challenge: String,
    code_challenge_method: String,
    response_type: String,
    client_id: String,
}
async fn authorize(State(state): State<Shared>, Query(query): Query<Authorize>) -> Response {
    let mut s = state.lock().unwrap();
    if query.client_id != s.config.client_id
        || query.response_type != "code"
        || query.code_challenge_method != "S256"
        || !loopback(&query.redirect_uri)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut callback = query.redirect_uri.clone();
    callback
        .query_pairs_mut()
        .append_pair("state", &query.state);
    if let Tamper::IdpError(error) = s.tamper {
        callback.query_pairs_mut().append_pair("error", error);
    } else {
        let code = random_id();
        callback.query_pairs_mut().append_pair("code", &code);
        s.codes.insert(code, query);
    }
    Redirect::to(callback.as_str()).into_response()
}

#[derive(Deserialize)]
struct Exchange {
    code: String,
    grant_type: String,
    redirect_uri: Url,
    code_verifier: String,
    client_id: Option<String>,
    client_secret: Option<String>,
}
fn client_ok(config: &ProviderConfig, headers: &HeaderMap, form: &Exchange) -> bool {
    let basic = headers.get("authorization");
    let id = form.client_id.as_deref();
    let secret = form.client_secret.as_deref();
    match (&config.client_secret, config.token_auth) {
        (None, _) => basic.is_none() && secret.is_none() && id == Some(&config.client_id),
        (Some(s), TokenAuth::Post) => {
            basic.is_none() && secret == Some(&s.0) && id == Some(&config.client_id)
        }
        (Some(s), TokenAuth::Basic) => {
            let escaped =
                |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
            let expected = format!(
                "Basic {}",
                STANDARD.encode(format!("{}:{}", escaped(&config.client_id), escaped(&s.0)))
            );
            id.is_none_or(|id| id == config.client_id)
                && secret.is_none()
                && basic.is_some_and(|h| h.as_bytes() == expected.as_bytes())
        }
    }
}

async fn token(
    State(state): State<Shared>,
    headers: HeaderMap,
    form: Result<Form<Exchange>, axum::extract::rejection::FormRejection>,
) -> Response {
    let mut s = state.lock().unwrap();
    let invalid = || {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response()
    };
    let Ok(Form(form)) = form else {
        return invalid();
    };
    let Some(auth) = s.codes.remove(&form.code) else {
        return invalid();
    };
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(form.code_verifier.as_bytes()));
    if matches!(s.tamper, Tamper::TokenError)
        || form.grant_type != "authorization_code"
        || auth.redirect_uri != form.redirect_uri
        || auth.code_challenge != challenge
        || !client_ok(&s.config, &headers, &form)
    {
        return invalid();
    }
    let now = now();
    let mut claims = json!({"iss":s.config.issuer,"aud":s.config.client_id,"sub":s.subject,"sid":s.subject,
        "exp":now+300,"iat":now,"auth_time":now,"nonce":auth.nonce,"preferred_username":"river","name":"River"});
    if let Value::Object(extra) = s.claims.take() {
        claims.as_object_mut().unwrap().extend(extra);
    }
    let mut header = s.signer.header.clone();
    match s.tamper {
        Tamper::Issuer => claims["iss"] = json!("another issuer"),
        Tamper::Audience => claims["aud"] = json!("another audience"),
        Tamper::Azp => claims["azp"] = json!("another client"),
        Tamper::Nonce => claims["nonce"] = json!(random_id()),
        Tamper::Expired => claims["exp"] = json!(now - 61),
        Tamper::FutureIat => claims["iat"] = json!(now + 61),
        Tamper::UnknownKid => header.kid = Some(random_id()),
        Tamper::NoAuthTime => {
            claims.as_object_mut().unwrap().remove("auth_time");
        }
        Tamper::StaleAuthTime => claims["auth_time"] = json!(now - 301),
        _ => {}
    }
    let id_token = match s.tamper {
        Tamper::AlgNone => format!(
            "{}.{}.",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        ),
        Tamper::Hs256 => {
            let secret = s.config.client_secret.as_ref().map_or("fixture", |s| &s.0);
            encode(
                &Header::new(Algorithm::HS256),
                &claims,
                &EncodingKey::from_secret(secret.as_bytes()),
            )
            .unwrap()
        }
        _ => encode(&header, &claims, &s.signer.key).unwrap(),
    };
    Json(json!({"id_token":id_token,"access_token":random_id(),"token_type":"Bearer"}))
        .into_response()
}

async fn end_session(Query(query): Query<HashMap<String, String>>) -> Response {
    match query
        .get("post_logout_redirect_uri")
        .and_then(|s| Url::parse(s).ok())
        .filter(loopback)
    {
        Some(url) => Redirect::to(url.as_str()).into_response(),
        None => StatusCode::OK.into_response(),
    }
}

pub(crate) async fn serve(state: AppState) -> (SocketAddr, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    serve_on(state, listener)
}

pub(crate) fn serve_on(state: AppState, listener: TcpListener) -> (SocketAddr, JoinHandle<()>) {
    use crate::server::client_ip::{ClientIp, ProxyTrust};
    let app = crate::api::routes(
        state.clone(),
        &Roles::ALL,
        ClientIp(ProxyTrust::from_config(false, Some("127.0.0.1")).unwrap()),
        None,
    )
    .with_state(state);
    let app = Router::new().nest("/api", app.clone()).merge(app);
    let addr = listener.local_addr().unwrap();
    (
        addr,
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sso::{
        Sso,
        jwt::{Expect, header, verify_id_token},
        provider::{Provider, bounded_json},
    };

    async fn authorize_fixture(
        idp: &FakeIdp,
        http: &reqwest::Client,
        callback: &str,
        verifier: &str,
    ) -> HashMap<String, String> {
        let url = Url::parse_with_params(
            &format!("{}/authorize", idp.issuer),
            [
                ("redirect_uri", callback),
                ("state", "state"),
                ("nonce", "nonce"),
                ("response_type", "code"),
                ("client_id", &idp.client_id),
                ("code_challenge_method", "S256"),
                (
                    "code_challenge",
                    &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
                ),
            ],
        )
        .unwrap();
        let res = http.get(url).send().await.unwrap();
        let redirect = Url::parse(res.headers()["location"].to_str().unwrap()).unwrap();
        redirect.query_pairs().into_owned().collect()
    }
    fn exchange(
        idp: &FakeIdp,
        http: &reqwest::Client,
        code: &str,
        verifier: &str,
        callback: &str,
        config: &ProviderConfig,
    ) -> reqwest::RequestBuilder {
        let mut fields = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", callback),
            ("client_id", &config.client_id),
        ];
        let mut req = http.post(format!("{}/token", idp.issuer));
        if let Some(secret) = &config.client_secret {
            match config.token_auth {
                TokenAuth::Basic => req = req.basic_auth(&config.client_id, Some(&secret.0)),
                TokenAuth::Post => fields.push(("client_secret", &secret.0)),
            }
        }
        req.form(&fields)
    }

    #[tokio::test]
    async fn authorization_codes_bind_verifier_client_and_redirect() {
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let (state, _path) = crate::api::test_util::temp_state("oidc_callback").await;
        let (addr, api) = serve(state).await;
        let callback = format!("http://{addr}/callback");
        let verifier = random_id();
        let sso = Sso::off();
        let http = sso.http();
        for (auth, secret) in [
            (TokenAuth::Basic, Some(Secret(random_id()))),
            (TokenAuth::Post, Some(Secret(random_id()))),
            (TokenAuth::Basic, None),
        ] {
            idp.set_client_auth(auth, secret);
            let config = idp.provider_config("test");
            let provider = Provider::new(config.clone());
            for failure in ["verifier", "client", "callback", "none"] {
                let result = authorize_fixture(&idp, http, &callback, &verifier).await;
                assert_eq!(result["state"], "state");
                let code = &result["code"];
                let mut sent = config.clone();
                if failure == "client" {
                    sent.client_secret = Some(Secret(random_id()));
                }
                let req = exchange(
                    &idp,
                    http,
                    code,
                    if failure == "verifier" {
                        "wrong"
                    } else {
                        &verifier
                    },
                    if failure == "callback" {
                        "http://localhost/different"
                    } else {
                        &callback
                    },
                    &sent,
                );
                let response = req.send().await.unwrap();
                if failure == "none" {
                    let json: Value = bounded_json(response).await.unwrap();
                    let token = json["id_token"].as_str().unwrap();
                    let (alg, kid) = header(token).unwrap();
                    let key = provider.key(http, alg, kid.as_deref()).await.unwrap();
                    verify_id_token(
                        token,
                        &key,
                        alg,
                        &Expect {
                            issuer: &idp.issuer,
                            client_id: &idp.client_id,
                            nonce: "nonce",
                            now: crate::db::now(),
                        },
                    )
                    .unwrap();
                    assert_eq!(
                        exchange(&idp, http, code, &verifier, &callback, &config)
                            .send()
                            .await
                            .unwrap()
                            .status(),
                        StatusCode::BAD_REQUEST
                    );
                } else {
                    assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{failure}");
                    assert_eq!(
                        serde_json::from_slice::<Value>(&response.bytes().await.unwrap()).unwrap()
                            ["error"],
                        "invalid_grant"
                    );
                }
            }
        }
        api.abort();
        api.await.unwrap_err();
    }

    #[tokio::test]
    async fn authorization_fixture_models_provider_failures_and_authentication_times() {
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let sso = Sso::off();
        let http = sso.http();
        let config = idp.provider_config("test");
        let provider = Provider::new(config.clone());
        let callback = "http://localhost/callback";
        let verifier = random_id();
        for tamper in [
            Tamper::IdpError("access_denied"),
            Tamper::TokenError,
            Tamper::Issuer,
            Tamper::Audience,
            Tamper::Azp,
            Tamper::Nonce,
            Tamper::Expired,
            Tamper::FutureIat,
            Tamper::AlgNone,
            Tamper::Hs256,
            Tamper::UnknownKid,
            Tamper::NoAuthTime,
            Tamper::StaleAuthTime,
            Tamper::None,
        ] {
            idp.tamper(tamper);
            idp.set_claims(json!({"preferred_username":"birch"}));
            let res = authorize_fixture(&idp, http, callback, &verifier).await;
            if matches!(tamper, Tamper::IdpError(_)) {
                assert_eq!(res["error"], "access_denied");
                continue;
            }
            let response = exchange(&idp, http, &res["code"], &verifier, callback, &config)
                .send()
                .await
                .unwrap();
            if matches!(tamper, Tamper::TokenError) {
                assert_eq!(response.status(), StatusCode::BAD_REQUEST);
                continue;
            }
            let json: Value = bounded_json(response).await.unwrap();
            let token = json["id_token"].as_str().unwrap();
            if matches!(tamper, Tamper::AlgNone | Tamper::Hs256) {
                assert!(header(token).is_err());
                continue;
            }
            let (alg, kid) = header(token).unwrap();
            let key = provider.key(http, alg, kid.as_deref()).await;
            if matches!(tamper, Tamper::UnknownKid) {
                assert!(key.is_err());
                continue;
            }
            let now = crate::db::now();
            let claims = verify_id_token(
                token,
                &key.unwrap(),
                alg,
                &Expect {
                    issuer: &idp.issuer,
                    client_id: &idp.client_id,
                    nonce: "nonce",
                    now,
                },
            );
            match tamper {
                Tamper::NoAuthTime => assert!(claims.unwrap().auth_time.is_none()),
                Tamper::StaleAuthTime => assert!(claims.unwrap().auth_time.unwrap() <= now - 301),
                Tamper::None => assert_eq!(claims.unwrap().claims["preferred_username"], "birch"),
                _ => assert!(claims.is_err()),
            }
        }
    }
}
