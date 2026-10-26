use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{ApiError, Authed, Settings};
use crate::db::now;
use crate::identity::{ASSERTION_TTL_SECS, Claims, random_id};
use crate::instance::{Features, InstanceInfo};
use crate::state::AppState;

const AUD_MAX: usize = 512;
const NONCE_MAX: usize = 256;

pub struct Peer(pub Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for Peer {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Peer, Self::Rejection> {
        Ok(Peer(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0.ip()),
        ))
    }
}

const VARY: &str = "Host, X-Forwarded-Host, X-Forwarded-Proto";

fn discovery_response(state: &AppState, body: impl Serialize, max_age: u32) -> Response {
    let mut res = Json(body).into_response();
    let scope = match state.instance.pinned() {
        true => "public",
        false => "private",
    };
    let headers = res.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&format!("{scope}, max-age={max_age}")) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    headers.insert(header::VARY, HeaderValue::from_static(VARY));
    res
}

async fn info(state: &AppState, peer: Option<IpAddr>, headers: &HeaderMap) -> InstanceInfo {
    let Settings {
        guests_enabled,
        asset_uploads,
        asset_previews,
        profanity_filter: _,
    } = Settings::cached(&state.read()).await;
    state.instance.discovery(
        &state.instance.origin(peer, headers),
        Features {
            guests: guests_enabled,
            uploads: asset_uploads,
            previews: asset_previews,
            identity_assertions: true,
        },
    )
}

#[utoipa::path(get, path = "/api/instance", responses((status = 200, description = "Who this instance is: id, name, URLs, versions, features and limits", body = InstanceInfo)))]
pub(crate) async fn instance(
    State(state): State<AppState>,
    Peer(peer): Peer,
    headers: HeaderMap,
) -> Response {
    let body = info(&state, peer, &headers).await;
    discovery_response(&state, body, 60)
}

#[utoipa::path(get, path = "/.well-known/rchat", responses((status = 200, description = "Discovery document, the same as GET /api/instance, with links to it and to the JWKS", body = InstanceInfo)))]
pub(crate) async fn well_known(state: State<AppState>, peer: Peer, headers: HeaderMap) -> Response {
    instance(state, peer, headers).await
}

#[utoipa::path(get, path = "/.well-known/jwks.json", responses((status = 200, description = "Public signing keys of this instance as a JSON Web Key Set (RFC 7517); kid is the RFC 7638 thumbprint, the first key signs", body = Object)))]
pub(crate) async fn jwks(State(state): State<AppState>) -> Response {
    discovery_response(&state, state.instance.keys.jwks(), 300)
}

#[derive(Deserialize, ToSchema)]
pub struct AssertionRequest {
    pub aud: String,
    pub nonce: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct Assertion {
    pub token: String,
    pub iss: String,
    pub sub: String,
    pub expires_at: i64,
}

#[utoipa::path(post, path = "/api/identity/assertion", request_body = AssertionRequest, responses((status = 200, description = "Short-lived EdDSA JWT proving the caller is sub = user@host on this instance", body = Assertion), (status = 400, description = "Missing or oversized aud or nonce"), (status = 401, description = "Not signed in")), security(("bearer" = [])))]
pub(crate) async fn assertion(
    State(state): State<AppState>,
    Authed(user): Authed,
    Peer(peer): Peer,
    headers: HeaderMap,
    Json(req): Json<AssertionRequest>,
) -> Result<Json<Assertion>, ApiError> {
    let AssertionRequest { aud, nonce } = req;
    let aud = aud.trim().to_string();
    let bad = |m: &str| ApiError(StatusCode::BAD_REQUEST, m.to_string());
    if aud.is_empty() || aud.len() > AUD_MAX {
        return Err(bad("aud must be 1 to 512 bytes"));
    }
    if nonce
        .as_ref()
        .is_some_and(|n| n.is_empty() || n.len() > NONCE_MAX)
    {
        return Err(bad("nonce must be 1 to 256 bytes"));
    }
    let iss = state.instance.origin(peer, &headers);
    let sub = format!("{}@{}", user.username, state.instance.host(&iss));
    let iat = now();
    let claims = Claims {
        iss: iss.clone(),
        sub: sub.clone(),
        aud,
        iat,
        exp: iat + ASSERTION_TTL_SECS,
        jti: random_id(),
        nonce,
    };
    let token = state.instance.keys.sign(&claims)?;
    Ok(Json(Assertion {
        token,
        iss,
        sub,
        expires_at: claims.exp,
    }))
}

pub fn well_known_routes() -> Router<AppState> {
    Router::new()
        .route("/.well-known/rchat", get(well_known))
        .route("/.well-known/jwks.json", get(jwks))
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::time::Duration;

    use super::*;
    use crate::api::test_util::{done, temp_state};
    use crate::config::{AppConfig, Roles};
    use crate::identity::{Verifier, VerifyError, verify_with};
    use crate::instance::{Instance, InstanceConfig};

    async fn serve(state: AppState) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let config = AppConfig {
            roles: Roles {
                web: false,
                ..Roles::ALL
            },
            ..AppConfig::defaults()
        };
        let app = crate::server::build_router(None, &config, state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        (addr, server)
    }

    async fn register(client: &reqwest::Client, base: &str, name: &str) -> String {
        let res = client
            .post(format!("{base}/api/auth/register"))
            .header("content-type", "application/json")
            .body(format!(
                r#"{{"username":"{name}","password":"pw","avatar_kind":"identicon"}}"#
            ))
            .send()
            .await
            .expect("register");
        let body: serde_json::Value =
            serde_json::from_slice(&res.bytes().await.expect("body")).expect("json");
        body["token"].as_str().expect("token").to_string()
    }

    async fn json(res: reqwest::Response) -> serde_json::Value {
        serde_json::from_slice(&res.bytes().await.expect("body")).expect("json")
    }

    #[tokio::test]
    async fn instance_id_and_key_are_generated_once_and_shared() {
        let (state, path) = temp_state("instance_once").await;
        let reopened = crate::db::open(path.to_str()).await.expect("reopen");
        let again = Instance::load(&reopened, &InstanceConfig::default())
            .await
            .expect("load");
        assert_eq!(again.id, state.instance.id);
        assert_eq!(again.id.len(), 32);
        assert_eq!(again.keys.active().kid, state.instance.keys.active().kid);
        let custom = Instance::load(
            &reopened,
            &InstanceConfig {
                signing_key: Some(crate::identity::new_seed()),
                ..Default::default()
            },
        )
        .await
        .expect("load custom");
        assert_eq!(custom.id, state.instance.id);
        assert_ne!(custom.keys.active().kid, state.instance.keys.active().kid);
        for bad in ["nope", "https://x.example/path", "ftp://x.example"] {
            let config = InstanceConfig {
                public_url: Some(bad.to_string()),
                ..Default::default()
            };
            assert!(Instance::load(&reopened, &config).await.is_err(), "{bad}");
        }
        let config = InstanceConfig {
            signing_key: Some("not-a-key".to_string()),
            ..Default::default()
        };
        assert!(Instance::load(&reopened, &config).await.is_err());
        crate::db::close(&reopened).await;
        done(state, path).await;
    }

    #[tokio::test]
    async fn discovery_jwks_and_assertion_round_trip() {
        let (state, path) = temp_state("instance_http").await;
        let (addr, server) = serve(state.clone()).await;
        let base = format!("http://{addr}");
        let client = reqwest::Client::new();

        let info = json(
            client
                .get(format!("{base}/api/instance"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(info["software"], "rchat");
        assert_eq!(info["id"], state.instance.id);
        assert_eq!(info["name"], "RChat");
        assert_eq!(info["host"], addr.to_string());
        assert_eq!(info["api_version"], crate::instance::API_VERSION);
        assert_eq!(info["public_url"], base);
        assert_eq!(info["api_url"], format!("{base}/api"));
        assert_eq!(info["ws_url"], format!("ws://{addr}/api/ws"));
        assert_eq!(info["jwks_uri"], format!("{base}/.well-known/jwks.json"));
        assert_eq!(info["features"]["guests"], true);
        assert_eq!(info["limits"]["page_size"], 50);
        let res = client
            .get(format!("{base}/.well-known/rchat"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, max-age=60");
        assert_eq!(
            res.headers()[header::VARY],
            "Host, X-Forwarded-Host, X-Forwarded-Proto"
        );
        let well_known = json(res).await;
        assert_eq!(well_known, info);
        let res = client
            .get(format!("{base}/.well-known/jwks.json"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, max-age=300");
        assert!(res.headers().contains_key(header::VARY));
        let jwks = json(res).await;
        let spoofed = json(
            client
                .get(format!("{base}/api/instance"))
                .header(header::HOST, "evil.example")
                .header("x-forwarded-proto", "https")
                .header("x-forwarded-host", "evil.example")
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(spoofed["public_url"], "http://localhost");
        assert_eq!(jwks["keys"][0]["kid"], state.instance.keys.active().kid);
        assert_eq!(jwks["keys"][0]["kty"], "OKP");
        assert!(jwks["keys"][0].get("d").is_none());

        let unauthed = client
            .post(format!("{base}/api/identity/assertion"))
            .header("content-type", "application/json")
            .body(r#"{"aud":"https://b.example"}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(unauthed.status(), StatusCode::UNAUTHORIZED);
        let token = register(&client, &base, "Alice").await;
        let ask = |body: &'static str| {
            client
                .post(format!("{base}/api/identity/assertion"))
                .bearer_auth(&token)
                .header("content-type", "application/json")
                .body(body)
                .send()
        };
        assert_eq!(
            ask(r#"{"aud":" "}"#).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            ask(r#"{"aud":"x","nonce":""}"#).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        let res = ask(r#"{"aud":"https://b.example","nonce":"n-1"}"#)
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let Assertion {
            token: jwt,
            iss,
            sub,
            expires_at,
        } = serde_json::from_slice(&res.bytes().await.unwrap()).unwrap();
        assert_eq!(iss, base);
        assert_eq!(sub, format!("alice@{addr}"));
        assert!(expires_at - now() <= ASSERTION_TTL_SECS);

        assert!(
            Verifier::new(Duration::from_secs(60))
                .verify(&jwt, "https://b.example", Some("n-1"))
                .await
                .is_err()
        );
        let verifier = Verifier::new(Duration::from_secs(60)).allow_local();
        let claims = verifier
            .verify(&jwt, "https://b.example", Some("n-1"))
            .await
            .expect("verify");
        assert_eq!(claims.sub, sub);
        assert_eq!(claims.iss, base);
        assert_eq!(
            verifier.verify(&jwt, "https://c.example", None).await,
            Err(VerifyError::Audience)
        );
        assert_eq!(
            verifier
                .verify(&jwt, "https://b.example", Some("n-2"))
                .await,
            Err(VerifyError::Nonce)
        );
        let keys = verifier.keys(&base).await.unwrap();
        assert!(verify_with(&jwt, &keys, &base, "https://b.example", None).is_ok());

        let rotated = crate::identity::Keyring::parse(&crate::identity::new_seed()).unwrap();
        let foreign = rotated
            .sign(&Claims {
                iss: base.clone(),
                sub: sub.clone(),
                aud: "https://b.example".to_string(),
                iat: now(),
                exp: now() + 60,
                jti: random_id(),
                nonce: None,
            })
            .unwrap();
        assert_eq!(
            verifier.verify(&foreign, "https://b.example", None).await,
            Err(VerifyError::UnknownKey)
        );
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn public_url_sets_issuer_and_urls() {
        let (mut state, path) = temp_state("instance_public").await;
        state.instance = Instance::load(
            &state.db,
            &InstanceConfig {
                name: Some("Lobby".to_string()),
                public_url: Some("https://chat.example/".to_string()),
                ws_url: Some("https://gw.example".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let headers = HeaderMap::new();
        let info = info(&state, None, &headers).await;
        assert_eq!(info.name, "Lobby");
        assert_eq!(info.public_url, "https://chat.example");
        assert_eq!(info.host, "chat.example");
        assert_eq!(info.api_url, "https://chat.example/api");
        assert_eq!(info.ws_url, "wss://gw.example/api/ws");
        assert_eq!(info.peerjs_url, "https://chat.example:9001/peerjs");
        done(state, path).await;
    }

    fn host_headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[tokio::test]
    async fn issuer_host_is_checked_and_forwarded_headers_need_a_trusted_proxy() {
        let (mut state, path) = temp_state("instance_hosts").await;
        let proxy: IpAddr = "10.0.0.2".parse().unwrap();
        let stranger: IpAddr = "203.0.113.9".parse().unwrap();
        state.instance = Instance::load(
            &state.db,
            &InstanceConfig {
                allowed_hosts: Some("chat.example, alt.example:8443".to_string()),
                peerjs_port: Some(9443),
                proxy_trust: crate::server::client_ip::ProxyTrust::from_config(
                    false,
                    Some("10.0.0.0/8"),
                )
                .unwrap(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let origin = |peer: IpAddr, pairs: &[(&'static str, &str)]| {
            state.instance.origin(Some(peer), &host_headers(pairs))
        };
        assert_eq!(
            origin(stranger, &[("host", "chat.example")]),
            "http://chat.example"
        );
        assert_eq!(
            origin(stranger, &[("host", "CHAT.example:3000")]),
            "http://chat.example:3000"
        );
        assert_eq!(
            origin(stranger, &[("host", "alt.example:8443")]),
            "http://alt.example:8443"
        );
        assert_eq!(
            origin(stranger, &[("host", "alt.example:9999")]),
            "http://chat.example"
        );
        assert_eq!(
            origin(stranger, &[("host", "evil.example")]),
            "http://chat.example"
        );
        assert_eq!(
            origin(stranger, &[("host", "a@evil.example")]),
            "http://chat.example"
        );
        assert_eq!(
            origin(stranger, &[("host", "127.0.0.1:3000")]),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            origin(
                stranger,
                &[
                    ("host", "chat.example"),
                    ("x-forwarded-proto", "https"),
                    ("x-forwarded-host", "alt.example:8443")
                ]
            ),
            "http://chat.example"
        );
        assert_eq!(
            origin(
                proxy,
                &[
                    ("host", "rchat-api:3000"),
                    ("x-forwarded-proto", "https, http"),
                    ("x-forwarded-host", "chat.example")
                ]
            ),
            "https://chat.example"
        );
        assert_eq!(
            origin(
                proxy,
                &[
                    ("host", "chat.example"),
                    ("x-forwarded-host", "evil.example")
                ]
            ),
            "http://chat.example"
        );
        let info = state.instance.discovery(
            "https://chat.example",
            Features {
                guests: true,
                uploads: true,
                previews: true,
                identity_assertions: true,
            },
        );
        assert_eq!(info.peerjs_url, "https://chat.example:9443/peerjs");
        assert!(!state.instance.pinned());
        for bad in ["chat.example/path", "a@b", "http://chat.example"] {
            let config = InstanceConfig {
                allowed_hosts: Some(bad.to_string()),
                ..Default::default()
            };
            assert!(Instance::load(&state.db, &config).await.is_err(), "{bad}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn pinned_discovery_is_publicly_cacheable() {
        let (mut state, path) = temp_state("instance_pinned").await;
        state.instance = Instance::load(
            &state.db,
            &InstanceConfig {
                public_url: Some("https://chat.example".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (addr, server) = serve(state.clone()).await;
        let client = reqwest::Client::new();
        for (path, cache) in [
            ("/api/instance", "public, max-age=60"),
            ("/.well-known/rchat", "public, max-age=60"),
            ("/.well-known/jwks.json", "public, max-age=300"),
        ] {
            let res = client
                .get(format!("http://{addr}{path}"))
                .header(header::HOST, "evil.example")
                .send()
                .await
                .unwrap();
            assert_eq!(res.headers()[header::CACHE_CONTROL], cache, "{path}");
            assert_eq!(
                res.headers()[header::VARY],
                "Host, X-Forwarded-Host, X-Forwarded-Proto"
            );
            if path != "/.well-known/jwks.json" {
                assert_eq!(json(res).await["public_url"], "https://chat.example");
            }
        }
        server.abort();
        done(state, path).await;
    }
}
