use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::access::not_found;
use super::{ApiError, ApiErrorBody, Authed, Settings};
use crate::db::now;
use crate::identity::{
    ASSERTION_TTL_SECS, BINDING_AUD, BINDING_SKEW_SECS, BINDING_TTL_SECS, BindingClaims, Claims,
    binding_proof_ok, p2p_key, random_id,
};
use crate::instance::{Features, InstanceInfo};
use crate::relay::IceServer;
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
        p2p_attachments,
        profanity_filter: _,
        profanity_targets: _,
        outgoing_webhooks: _,
        server_reports: _,
        instance_reports: _,
        widgets: _,
        widget_chat: _,
        widget_read_links: _,
        widget_bridge: _,
        e2ee: _,
        e2ee_compliance: _,
        backup_phrase: _,
        p2p_backup: _,
        display_names: _,
        onboarding: _,
        password_login: _,
        sfu: _,
        p2p: _,
        client_other_instances: _,
        registration: _,
        upload_expiry_max_days: _,
        server_creation: _,
        server_joining: _,
        server_search: _,
        dm_creation: _,
        friend_requests: _,
    } = Settings::cached(&state.read()).await;
    state.instance.discovery(
        &state.instance.origin(peer, headers),
        Features {
            guests: guests_enabled,
            uploads: asset_uploads,
            p2p_attachments,
            previews: asset_previews,
            identity_assertions: true,
            backup_phrase: true,
        },
        &state.limits,
    )
}

/// Describe this instance
///
/// Who this instance is: id, name, host, versions, the URLs of its API, WebSocket gateway and
/// PeerJS server, which optional features are on, and its limits. No authentication.
/// Cached for 60 seconds (`Cache-Control: public` when `PUBLIC_URL` is set, `private` when
/// the URLs are derived from the request host). General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/instance", tag = "Instance", responses((status = 200, description = "Who this instance is: id, name, URLs, versions, features and limits", body = InstanceInfo), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn instance(
    State(state): State<AppState>,
    Peer(peer): Peer,
    headers: HeaderMap,
) -> Response {
    let body = info(&state, peer, &headers).await;
    discovery_response(&state, body, 60)
}

/// Discover this instance
///
/// The well-known discovery document for other instances and clients: the same body and
/// caching as `GET /api/v1/instance`, whose URL it carries in `instance_url`, along with the
/// JWKS URL in `jwks_uri`. No authentication. General rate-limit bucket.
#[utoipa::path(get, path = "/.well-known/rchat", tag = "Instance", responses((status = 200, description = "Discovery document, the same as GET /api/v1/instance, with links to it and to the JWKS", body = InstanceInfo), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn well_known(state: State<AppState>, peer: Peer, headers: HeaderMap) -> Response {
    instance(state, peer, headers).await
}

/// Get the instance signing keys
///
/// The public Ed25519 keys this instance signs identity assertions and P2P bindings with, as a
/// JSON Web Key Set. Verify a token from `POST /api/v1/identity/assertion` or
/// `POST /api/v1/identity/p2p_binding` against the key whose `kid` matches the JWT header. No
/// authentication. Cached for 300 seconds. General rate-limit bucket.
#[utoipa::path(get, path = "/.well-known/jwks.json", tag = "Instance", responses((status = 200, description = "Public signing keys of this instance as a JSON Web Key Set (RFC 7517); kid is the RFC 7638 thumbprint, the first key signs", body = Object), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn jwks(State(state): State<AppState>) -> Response {
    discovery_response(&state, state.instance.keys.jwks(), 300)
}

/// Request for an identity assertion.
#[derive(Deserialize, ToSchema)]
pub struct AssertionRequest {
    /// Who the assertion is for, usually the origin of the other instance; 1 to 512 bytes
    /// after trimming. Becomes the JWT `aud` claim.
    #[schema(example = "https://other.example.org")]
    pub aud: String,
    /// Optional challenge from the audience, 1 to 256 bytes, copied into the JWT `nonce`
    /// claim. Omit it when there is none.
    pub nonce: Option<String>,
}

/// A signed identity assertion.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Assertion {
    /// Compact EdDSA JWT with claims `iss`, `sub`, `aud`, `iat`, `exp`, `jti` and the
    /// optional `nonce`.
    pub token: String,
    /// Issuer: this instance's origin.
    #[schema(example = "https://chat.example.com")]
    pub iss: String,
    /// Subject: the caller as `username@host`.
    #[schema(example = "alice@chat.example.com")]
    pub sub: String,
    /// Unix seconds when the token expires, 300 seconds after issue.
    pub expires_at: i64,
}

/// Prove your identity to another instance
///
/// Signs a short-lived JWT (300 seconds) stating that the caller is `username@host` on this
/// instance, for the audience named in `aud`. The audience verifies it with the keys at
/// `/.well-known/jwks.json` of the issuer. Requires a bearer token; guests can't call it. No
/// side effects. General rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/identity/assertion", tag = "Instance", request_body = AssertionRequest, responses((status = 200, description = "Short-lived EdDSA JWT proving the caller is sub = user@host on this instance", body = Assertion), (status = 400, description = "Missing or oversized aud or nonce", body = ApiErrorBody), (status = 401, description = "Not signed in", body = ApiErrorBody), (status = 403, description = "The username contains '@' (allowed for older accounts) and so has no unambiguous user@host form", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn assertion(
    State(state): State<AppState>,
    Authed(user): Authed,
    Peer(peer): Peer,
    headers: HeaderMap,
    Json(req): Json<AssertionRequest>,
) -> Result<Json<Assertion>, ApiError> {
    let AssertionRequest { aud, nonce } = req;
    if user.username.contains('@') {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "This username can't be used across instances".to_string(),
        ));
    }
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

/// Request for a P2P identity binding.
#[derive(Deserialize, ToSchema)]
pub struct BindingRequest {
    /// The P2P identity key: an Ed25519 public key, base64url without padding (43 characters).
    #[schema(example = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")]
    pub ik: String,
    /// Unix seconds when the proof was made. It must be within 5 minutes of the server clock.
    pub ts: i64,
    /// Ed25519 signature by `ik`, base64url without padding (86 characters), over the bytes
    /// `rchat-p2p-bind1`, a zero byte, `sub`, a zero byte and `ts` in decimal. `sub` is the
    /// caller as `username@host`, with `host` from `GET /api/v1/instance`.
    pub proof: String,
}

/// A signed P2P identity binding.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Binding {
    /// Compact EdDSA JWT with claims `iss`, `sub`, `aud` (`rchat-p2p-bind`), `ik`, `iat` and
    /// `exp`.
    pub token: String,
    /// Issuer: this instance's origin.
    #[schema(example = "https://chat.example.com")]
    pub iss: String,
    /// Subject: the caller as `username@host`.
    #[schema(example = "alice@chat.example.com")]
    pub sub: String,
    /// The P2P identity key the binding is for, as sent.
    pub ik: String,
    /// Unix seconds when the token expires, 7 days after issue.
    pub expires_at: i64,
}

/// Bind a P2P identity key to your account
///
/// Signs a JWT (7 days) stating that the caller, `username@host` on this instance, holds the P2P
/// identity key `ik`. Peers show it as an account badge after checking it against the keys at
/// `/.well-known/jwks.json`. The proof is a signature by `ik` itself, so nobody can bind a key
/// they don't hold. Stateless: nothing is stored, and a binding can't be revoked before it
/// expires (clients ask for a new one every day while the badge is on). Requires a bearer token;
/// guests can't call it. Answers 404 while the `p2p` switch of `GET /api/v1/settings` is off.
/// Strict rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/identity/p2p_binding", tag = "Instance", request_body = BindingRequest, responses((status = 200, description = "EdDSA JWT binding ik to sub = user@host for 7 days", body = Binding), (status = 400, description = "ik is not a valid Ed25519 key, ts is more than 5 minutes from the server clock, or proof is not a signature by ik over this account and ts", body = ApiErrorBody), (status = 401, description = "Not signed in (guests included)", body = ApiErrorBody), (status = 403, description = "The username contains '@' (allowed for older accounts) and so has no unambiguous user@host form", body = ApiErrorBody), (status = 404, description = "`Not found`: the `p2p` switch is off", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the strict bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn p2p_binding(
    State(state): State<AppState>,
    Authed(user): Authed,
    Peer(peer): Peer,
    headers: HeaderMap,
    Json(req): Json<BindingRequest>,
) -> Result<Json<Binding>, ApiError> {
    let BindingRequest { ik, ts, proof } = req;
    if !Settings::cached(&state.db).await.p2p {
        return Err(not_found());
    }
    if user.username.contains('@') {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "The badge isn't available for usernames with @".to_string(),
        ));
    }
    let bad = |m: &str| ApiError(StatusCode::BAD_REQUEST, m.to_string());
    let key = p2p_key(&ik).ok_or_else(|| bad("ik must be a base64url Ed25519 public key"))?;
    let iat = now();
    if ts.abs_diff(iat) > BINDING_SKEW_SECS {
        return Err(bad("ts must be within 5 minutes of the server clock"));
    }
    let iss = state.instance.origin(peer, &headers);
    let sub = format!("{}@{}", user.username, state.instance.host(&iss));
    if !binding_proof_ok(&key, &sub, ts, &proof) {
        return Err(bad(
            "proof is not a signature by ik over this account and ts",
        ));
    }
    let claims = BindingClaims {
        iss: iss.clone(),
        sub: sub.clone(),
        aud: BINDING_AUD.to_string(),
        ik: ik.clone(),
        iat,
        exp: iat + BINDING_TTL_SECS,
    };
    let token = state.instance.keys.sign(&claims)?;
    Ok(Json(Binding {
        token,
        iss,
        sub,
        ik,
        expires_at: claims.exp,
    }))
}

/// ICE servers with short-lived TURN credentials.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct IceServers {
    /// Pass these as `iceServers` of an `RTCPeerConnection`. STUN entries come first, then
    /// the built-in relay's TURN entry with credentials, then the operator's TURN servers.
    pub ice_servers: Vec<IceServer>,
    /// Unix seconds when the built-in relay's TURN credentials expire, one hour after issue.
    /// Fetch new ones before then.
    pub expires_at: i64,
}

/// Get ICE servers for peer-to-peer connections
///
/// The STUN servers from `ice` in `GET /api/v1/instance` plus TURN relays with credentials.
/// Credentials for the built-in relay follow the TURN REST convention: username
/// `{expiry}:{opaque}`, where `opaque` is a hash of the account (never the username), and
/// a one-hour lifetime. Without TURN on the instance this returns only the STUN entries
/// (possibly none). Requires a bearer token; guests can't call it. No side effects. General
/// rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/p2p/ice", tag = "Instance", responses((status = 200, description = "ICE servers with TURN credentials and their expiry", body = IceServers), (status = 401, description = "Not signed in (guests included)", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn ice(
    State(state): State<AppState>,
    Authed(user): Authed,
    Peer(peer): Peer,
    headers: HeaderMap,
) -> Json<IceServers> {
    let origin = state.instance.origin(peer, &headers);
    let (ice_servers, expires_at) = state.instance.ice_servers(&origin, &user.username, now());
    Json(IceServers {
        ice_servers,
        expires_at,
    })
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
        let app = crate::server::build_router(None, None, &config, state);
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
        let reopened = crate::db::open_started(path.to_str())
            .await
            .expect("reopen");
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
    async fn instance_reports_configured_limits() {
        let (state, path) = temp_state("instance_limits").await;
        let (addr, server) = serve(state.clone()).await;
        let info = json(
            reqwest::get(format!("http://{addr}/api/instance"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(info["limits"]["upload_bytes"], 25 * 1024 * 1024);
        assert_eq!(info["limits"]["message_chars"], 4000);
        assert_eq!(
            (&info["e2ee"], &info["sfu"], &info["widgets"]),
            (
                &serde_json::json!(false),
                &serde_json::json!(false),
                &serde_json::json!(false)
            )
        );
        server.abort();
        let state = state.with_limits(std::sync::Arc::new(crate::limits::Limits {
            upload_max_mib: 10,
            message_max_chars: 500,
            sfu_enabled: true,
            ..Default::default()
        }));
        let (addr, server) = serve(state.clone()).await;
        let info = json(
            reqwest::get(format!("http://{addr}/api/instance"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(info["limits"]["upload_bytes"], 10_485_760);
        assert_eq!(info["limits"]["message_chars"], 500);
        assert_eq!(info["limits"]["name_chars"], 100);
        assert_eq!(
            (&info["e2ee"], &info["sfu"], &info["widgets"]),
            (
                &serde_json::json!(false),
                &serde_json::json!(true),
                &serde_json::json!(false)
            )
        );
        server.abort();
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
        assert_eq!(
            info["api_versions"],
            serde_json::json!(crate::server::route_builder::VERSIONS)
        );
        assert_eq!(info["api_versions"], serde_json::json!(["v1"]));
        assert_eq!(info["public_url"], base);
        assert_eq!(info["api_url"], format!("{base}/api"));
        assert_eq!(info["ws_url"], format!("ws://{addr}/api/ws"));
        assert_eq!(info["jwks_uri"], format!("{base}/.well-known/jwks.json"));
        assert_eq!(info["features"]["guests"], true);
        assert_eq!(info["features"]["p2p_attachments"], true);
        assert_eq!(info["features"]["backup_phrase"], true);
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
        crate::db::NewUser::plain("old@name")
            .hash("x")
            .add(&state.db)
            .await;
        sqlx::query(
            "INSERT INTO tokens(token, username, created_at) VALUES('h:c49fea7425fa7f8699897a97c159c6690267d9003bb78c53fafa8fc15c325d84', 'old@name', 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let legacy = client
            .post(format!("{base}/api/identity/assertion"))
            .bearer_auth("legacy")
            .header("content-type", "application/json")
            .body(r#"{"aud":"https://b.example"}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(legacy.status(), StatusCode::FORBIDDEN);
        server.abort();
        done(state, path).await;
    }

    fn b64url(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    fn unb64url(text: &str) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(text)
            .unwrap()
    }

    fn bind_body(signer: &ed25519_dalek::SigningKey, ik: &str, sub: &str, ts: i64) -> String {
        use ed25519_dalek::Signer;
        let proof = signer.sign(&crate::identity::binding_message(sub, ts));
        serde_json::json!({"ik": ik, "ts": ts, "proof": b64url(&proof.to_bytes())}).to_string()
    }

    // Checks the JWT against the instance's published JWKS by hand: header, kid, signature.
    fn verified_payload(jwt: &str, jwks: &serde_json::Value) -> serde_json::Value {
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value = serde_json::from_slice(&unb64url(parts[0])).unwrap();
        assert_eq!(header["alg"], "EdDSA");
        assert_eq!(header["typ"], "JWT");
        let key = jwks["keys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["kid"] == header["kid"])
            .expect("kid in the JWKS");
        let x: [u8; 32] = unb64url(key["x"].as_str().unwrap()).try_into().unwrap();
        let sig: [u8; 64] = unb64url(parts[2]).try_into().unwrap();
        ed25519_dalek::VerifyingKey::from_bytes(&x)
            .unwrap()
            .verify_strict(
                format!("{}.{}", parts[0], parts[1]).as_bytes(),
                &ed25519_dalek::Signature::from_bytes(&sig),
            )
            .expect("signed by the instance key");
        serde_json::from_slice(&unb64url(parts[1])).unwrap()
    }

    #[tokio::test]
    async fn switched_off_p2p_answers_404_and_capabilities_ignore_the_switches() {
        let (state, path) = temp_state("instance_p2p_switch").await;
        let (addr, server) = serve(state.clone()).await;
        let base = format!("http://{addr}");
        let client = reqwest::Client::new();
        let root = register(&client, &base, "root").await;
        let token = register(&client, &base, "alice").await;
        let sub = format!("alice@{addr}");
        let signer = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let ik = b64url(signer.verifying_key().as_bytes());
        let bind = || {
            client
                .post(format!("{base}/api/identity/p2p_binding"))
                .header("content-type", "application/json")
                .bearer_auth(&token)
                .body(bind_body(&signer, &ik, &sub, now()))
                .send()
        };
        let switch = |body: &'static str| {
            client
                .patch(format!("{base}/api/admin/settings"))
                .header("content-type", "application/json")
                .bearer_auth(&root)
                .body(body)
                .send()
        };
        assert_eq!(bind().await.unwrap().status(), StatusCode::OK);
        let off = switch(r#"{"p2p": false, "e2ee": true, "widgets": true}"#)
            .await
            .unwrap();
        assert_eq!(off.status(), StatusCode::OK);
        let res = bind().await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(json(res).await, serde_json::json!({"error": "Not found"}));
        let settings = json(
            client
                .get(format!("{base}/api/settings"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(settings["p2p"], serde_json::json!(false));
        let info = json(
            client
                .get(format!("{base}/api/instance"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            (&info["e2ee"], &info["widgets"]),
            (&serde_json::json!(false), &serde_json::json!(false)),
            "what this build supports, not the switches"
        );
        assert_eq!(
            switch(r#"{"p2p": true}"#).await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(bind().await.unwrap().status(), StatusCode::OK);
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn p2p_binding_needs_the_identity_key_a_fresh_ts_and_an_account() {
        let (state, path) = temp_state("instance_binding").await;
        let (addr, server) = serve(state.clone()).await;
        let base = format!("http://{addr}");
        let client = reqwest::Client::new();
        let token = register(&client, &base, "Alice").await;
        let sub = format!("alice@{addr}");
        let signer = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let ik = b64url(signer.verifying_key().as_bytes());
        let bind = |body: String, bearer: Option<&str>| {
            let mut req = client
                .post(format!("{base}/api/identity/p2p_binding"))
                .header("content-type", "application/json")
                .body(body);
            if let Some(t) = bearer {
                req = req.bearer_auth(t);
            }
            req.send()
        };

        let before = now();
        let res = bind(bind_body(&signer, &ik, &sub, now()), Some(&token))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let Binding {
            token: jwt,
            iss,
            sub: got,
            ik: bound,
            expires_at,
        } = serde_json::from_slice(&res.bytes().await.unwrap()).unwrap();
        assert_eq!(
            (iss.as_str(), got.as_str(), bound.as_str()),
            (base.as_str(), sub.as_str(), ik.as_str())
        );
        let jwks = json(
            client
                .get(format!("{base}/.well-known/jwks.json"))
                .send()
                .await
                .unwrap(),
        )
        .await;
        let claims = verified_payload(&jwt, &jwks);
        let iat = claims["iat"].as_i64().unwrap();
        assert!((before..=now()).contains(&iat));
        assert_eq!(
            claims,
            serde_json::json!({
                "iss": base,
                "sub": sub,
                "aud": "rchat-p2p-bind",
                "ik": ik,
                "iat": iat,
                "exp": iat + 7 * 24 * 60 * 60,
            })
        );
        assert_eq!(expires_at, iat + 7 * 24 * 60 * 60);
        let rotated = crate::identity::Keyring::parse(&crate::identity::new_seed()).unwrap();
        let other = serde_json::to_value(rotated.jwks()).unwrap();
        assert!(
            std::panic::catch_unwind(|| verified_payload(&jwt, &other)).is_err(),
            "another instance's keys don't verify it"
        );

        let refused = |res: reqwest::Response, status: StatusCode, what: &'static str| async move {
            assert_eq!(res.status(), status, "{what}");
            if status == StatusCode::BAD_REQUEST {
                let body = json(res).await;
                assert!(
                    body["error"].as_str().is_some_and(|e| e.is_ascii()),
                    "{what}"
                );
            }
        };
        let intruder = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        refused(
            bind(bind_body(&intruder, &ik, &sub, now()), Some(&token))
                .await
                .unwrap(),
            StatusCode::BAD_REQUEST,
            "a proof by another key than ik",
        )
        .await;
        refused(
            bind(
                bind_body(&signer, &ik, &format!("bob@{addr}"), now()),
                Some(&token),
            )
            .await
            .unwrap(),
            StatusCode::BAD_REQUEST,
            "a proof for another account",
        )
        .await;
        let t = now();
        let mut shifted: serde_json::Value =
            serde_json::from_str(&bind_body(&signer, &ik, &sub, t)).unwrap();
        shifted["ts"] = serde_json::json!(t - 1);
        refused(
            bind(shifted.to_string(), Some(&token)).await.unwrap(),
            StatusCode::BAD_REQUEST,
            "a proof made for another ts",
        )
        .await;
        for ts in [now() - 301, now() + 360, i64::MIN, i64::MAX] {
            refused(
                bind(bind_body(&signer, &ik, &sub, ts), Some(&token))
                    .await
                    .unwrap(),
                StatusCode::BAD_REQUEST,
                "a stale or future ts",
            )
            .await;
        }
        assert_eq!(
            bind(bind_body(&signer, &ik, &sub, now() - 290), Some(&token))
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "a clock a little behind is fine"
        );
        let zero = ed25519_dalek::SigningKey::from_bytes(&[0u8; 32]);
        for bad_ik in [
            String::new(),
            "not a key".to_string(),
            b64url(&[0u8; 32]),
            b64url(&[[1u8].as_slice(), &[0u8; 31]].concat()),
            format!("{ik}="),
        ] {
            refused(
                bind(bind_body(&zero, &bad_ik, &sub, now()), Some(&token))
                    .await
                    .unwrap(),
                StatusCode::BAD_REQUEST,
                "an invalid or weak ik",
            )
            .await;
        }
        let mut short: serde_json::Value =
            serde_json::from_str(&bind_body(&signer, &ik, &sub, now())).unwrap();
        short["proof"] = serde_json::json!("AAAA");
        refused(
            bind(short.to_string(), Some(&token)).await.unwrap(),
            StatusCode::BAD_REQUEST,
            "a proof that isn't a signature",
        )
        .await;

        refused(
            bind(bind_body(&signer, &ik, &sub, now()), None)
                .await
                .unwrap(),
            StatusCode::UNAUTHORIZED,
            "no token",
        )
        .await;
        sqlx::query(
            "INSERT INTO servers(name, display_name, created_at) VALUES('lobby', 'Lobby', 1)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'lobby', 0, 4000000000)")
            .bind(crate::db::secret_key(&crate::api::test_util::test_grant("g1")))
            .execute(&state.db)
            .await
            .unwrap();
        let reads = client
            .get(format!("{base}/api/servers/lobby"))
            .header("x-guest-grant", crate::api::test_util::test_grant("g1"))
            .send()
            .await
            .unwrap();
        assert_eq!(reads.status(), StatusCode::OK, "the guest grant is live");
        let guest = client
            .post(format!("{base}/api/identity/p2p_binding"))
            .header("content-type", "application/json")
            .header("x-guest-grant", crate::api::test_util::test_grant("g1"))
            .body(bind_body(&signer, &ik, &sub, now()))
            .send()
            .await
            .unwrap();
        refused(guest, StatusCode::UNAUTHORIZED, "a guest").await;
        refused(
            bind(bind_body(&signer, &ik, &sub, now()), Some("not-a-token"))
                .await
                .unwrap(),
            StatusCode::UNAUTHORIZED,
            "an unknown token",
        )
        .await;

        crate::db::NewUser::plain("old@name")
            .hash("x")
            .add(&state.db)
            .await;
        sqlx::query(
            "INSERT INTO tokens(token, username, created_at) VALUES('h:c49fea7425fa7f8699897a97c159c6690267d9003bb78c53fafa8fc15c325d84', 'old@name', 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        refused(
            bind(
                bind_body(&signer, &ik, &format!("old@name@{addr}"), now()),
                Some("legacy"),
            )
            .await
            .unwrap(),
            StatusCode::FORBIDDEN,
            "a username with @",
        )
        .await;
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
        assert_eq!(info.peerjs_url, "https://chat.example/peerjs");
        done(state, path).await;
    }

    #[tokio::test]
    async fn peerjs_is_advertised_on_the_instance_origin_unless_set_elsewhere() {
        let (state, path) = temp_state("instance_peerjs").await;
        let features = Features {
            guests: true,
            uploads: true,
            p2p_attachments: true,
            previews: true,
            identity_assertions: true,
            backup_phrase: true,
        };
        let advertised = |config: InstanceConfig, origin: &'static str| {
            let (db, limits) = (state.db.clone(), state.limits.clone());
            async move {
                let instance = Instance::load(&db, &config).await.expect("instance");
                instance.discovery(origin, features, &limits).peerjs_url
            }
        };
        for (origin, same, ported) in [
            (
                "https://chat.example",
                "https://chat.example/peerjs",
                "https://chat.example:9443/peerjs",
            ),
            (
                "http://127.0.0.1:3000",
                "http://127.0.0.1:3000/peerjs",
                "http://127.0.0.1:9443/peerjs",
            ),
            (
                "https://chat.example:8443",
                "https://chat.example:8443/peerjs",
                "https://chat.example:9443/peerjs",
            ),
        ] {
            assert_eq!(advertised(InstanceConfig::default(), origin).await, same);
            let port = InstanceConfig {
                peerjs_port: Some(9443),
                ..Default::default()
            };
            assert_eq!(
                advertised(port, origin).await,
                ported,
                "PEERJS_PORT names the separate PeerJS server"
            );
        }
        let elsewhere = InstanceConfig {
            peerjs_url: Some("https://peer.example/peerjs/".to_string()),
            peerjs_port: Some(9443),
            ..Default::default()
        };
        assert_eq!(
            advertised(elsewhere, "https://chat.example").await,
            "https://peer.example/peerjs"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_default_instance_names_only_its_one_address() {
        let (state, path) = temp_state("instance_one_address").await;
        let features = Features {
            guests: true,
            uploads: true,
            p2p_attachments: true,
            previews: true,
            identity_assertions: true,
            backup_phrase: true,
        };
        let instance = Instance::load(&state.db, &InstanceConfig::default())
            .await
            .expect("instance");
        for origin in [
            "https://chat.example",
            "https://chat.example:8443",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            let site = url::Url::parse(origin).expect("origin");
            let schemes = match site.scheme() {
                "https" => ["https", "wss"],
                _ => ["http", "ws"],
            };
            let info = instance.discovery(origin, features, &state.limits);
            assert_eq!(info.public_url, origin);
            for (what, address) in [
                ("api_url", &info.api_url),
                ("ws_url", &info.ws_url),
                ("peerjs_url", &info.peerjs_url),
                ("instance_url", &info.instance_url),
                ("jwks_uri", &info.jwks_uri),
            ] {
                let url = url::Url::parse(address).expect(what);
                assert_eq!(
                    (url.host_str(), url.port_or_known_default()),
                    (site.host_str(), site.port_or_known_default()),
                    "{what} of {origin}: {address}"
                );
                assert!(
                    schemes.contains(&url.scheme()),
                    "{what} of {origin}: {address}"
                );
            }
            assert!(info.ice.stun.is_empty(), "{:?}", info.ice.stun);
            assert!(!info.ice.turn && !info.ice.relay);
        }
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
                p2p_attachments: true,
                previews: true,
                identity_assertions: true,
                backup_phrase: true,
            },
            &state.limits,
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

    fn turn_relay(host: Option<&str>, turn: bool) -> crate::relay::RelayAdvert {
        crate::relay::RelayAdvert {
            host: host.map(str::to_string),
            port: 3478,
            turn,
        }
    }

    #[test]
    fn discovery_ice_follows_the_config() {
        use crate::relay::{IceConfig, IceServer, bundled_stun};
        let origin = "https://chat.example.com";
        let ice = |config: IceConfig| {
            let instance = Instance::with_ice(config);
            let info = instance.ice_info(origin);
            serde_json::to_value(info).unwrap()
        };
        assert_eq!(
            ice(IceConfig::default()),
            serde_json::json!({"stun": [], "turn": false, "relay": false})
        );
        let public = ice(IceConfig {
            public_stun: 3,
            ..Default::default()
        });
        let list = bundled_stun();
        let urls: Vec<String> = serde_json::from_value(public["stun"].clone()).unwrap();
        assert_eq!(urls.len(), 3);
        assert!(urls.iter().all(|u| list.contains(u)));
        assert_eq!(public["turn"], false);
        assert_eq!(
            ice(IceConfig {
                relay: Some(turn_relay(None, true)),
                ..Default::default()
            }),
            serde_json::json!({"stun": ["stun:chat.example.com:3478"], "turn": true, "relay": true})
        );
        assert_eq!(
            ice(IceConfig {
                relay: Some(turn_relay(Some("relay.example.net"), false)),
                ..Default::default()
            }),
            serde_json::json!({"stun": ["stun:relay.example.net:3478"], "turn": false, "relay": true})
        );
        assert_eq!(
            ice(IceConfig {
                relay: Some(turn_relay(Some("2001:db8::7"), false)),
                ..Default::default()
            })["stun"],
            serde_json::json!(["stun:[2001:db8::7]:3478"])
        );
        let extra = crate::relay::parse_ice_servers(
            r#"[{"urls":"stun:stun.example.org:3478"},{"urls":["turn:turn.example.org:3478?transport=udp","turns:turn.example.org:5349"],"username":"u","credential":"p"}]"#,
        )
        .unwrap();
        let both = ice(IceConfig {
            public_stun: 2,
            relay: None,
            extra: extra.clone(),
        });
        let urls: Vec<String> = serde_json::from_value(both["stun"].clone()).unwrap();
        assert_eq!(urls.len(), 3);
        assert_eq!(urls[2], "stun:stun.example.org:3478");
        assert_eq!(both["turn"], true);
        assert_eq!(both["relay"], false);
        let instance = Instance::with_ice(IceConfig {
            public_stun: 0,
            relay: Some(turn_relay(None, true)),
            extra,
        });
        let (servers, expires_at) = instance.ice_servers(origin, "Alice", 1000);
        assert_eq!(expires_at, 1000 + crate::relay::CREDENTIAL_TTL_SECS);
        assert_eq!(
            servers[0],
            IceServer {
                urls: vec![
                    "stun:chat.example.com:3478".to_string(),
                    "stun:stun.example.org:3478".to_string()
                ],
                username: None,
                credential: None,
            }
        );
        assert_eq!(
            servers[1].urls,
            vec!["turn:chat.example.com:3478?transport=udp"]
        );
        assert_eq!(servers[2].username.as_deref(), Some("u"));
        assert_eq!(servers.len(), 3);
        for bad in [
            "{}",
            "[{\"urls\":\"http://x\"}]",
            "[{\"urls\":[]}]",
            "[{\"url\":\"stun:x\"}]",
        ] {
            assert!(crate::relay::parse_ice_servers(bad).is_err(), "{bad}");
        }
        assert!(crate::relay::parse_ice_servers(" ").unwrap().is_empty());
    }

    #[tokio::test]
    async fn p2p_ice_gives_turn_credentials_to_signed_in_users_only() {
        let (mut state, path) = temp_state("instance_ice").await;
        let config = InstanceConfig {
            ice: crate::relay::IceConfig {
                public_stun: 0,
                relay: Some(turn_relay(Some("relay.example.net"), true)),
                extra: Vec::new(),
            },
            ..Default::default()
        };
        state.instance = Instance::load(&state.db, &config).await.expect("load");
        let secret = state.instance.relay_secret.clone();
        assert_eq!(secret.len(), 64);
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
        assert_eq!(info["api_version"], "1.1");
        assert_eq!(
            info["ice"],
            serde_json::json!({"stun": ["stun:relay.example.net:3478"], "turn": true, "relay": true})
        );
        let anonymous = client
            .get(format!("{base}/api/p2p/ice"))
            .send()
            .await
            .unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        let guest = client
            .get(format!("{base}/api/p2p/ice"))
            .header("x-guest-grant", "anything")
            .send()
            .await
            .unwrap();
        assert_eq!(guest.status(), StatusCode::UNAUTHORIZED);
        let token = register(&client, &base, "Alice").await;
        let before = now();
        let body = json(
            client
                .get(format!("{base}/api/p2p/ice"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap(),
        )
        .await;
        let expires_at = body["expires_at"].as_i64().unwrap();
        assert!((before + 3600..=now() + 3600).contains(&expires_at));
        assert_eq!(
            body["ice_servers"][0],
            serde_json::json!({"urls": ["stun:relay.example.net:3478"]})
        );
        let turn = &body["ice_servers"][1];
        assert_eq!(
            turn["urls"],
            serde_json::json!(["turn:relay.example.net:3478?transport=udp"])
        );
        let username = turn["username"].as_str().unwrap();
        assert_eq!(
            username,
            format!("{expires_at}:{}", crate::relay::opaque(&secret, "alice"))
        );
        assert!(!username.contains("alice"));
        assert_eq!(
            turn["credential"].as_str().unwrap(),
            crate::relay::password(&secret, username)
        );

        let stun_only = InstanceConfig {
            ice: crate::relay::IceConfig {
                public_stun: 0,
                relay: Some(turn_relay(Some("relay.example.net"), false)),
                extra: Vec::new(),
            },
            ..Default::default()
        };
        let reloaded = Instance::load(&state.db, &stun_only).await.expect("reload");
        assert_eq!(reloaded.relay_secret, secret, "the secret row is kept");
        let (servers, _) = reloaded.ice_servers(&base, "alice", now());
        assert_eq!(servers.len(), 1);
        assert!(servers[0].username.is_none() && servers[0].credential.is_none());
        let none = Instance::load(&state.db, &InstanceConfig::default())
            .await
            .expect("reload");
        assert!(none.ice_servers(&base, "alice", now()).0.is_empty());
        server.abort();
        let reopened = crate::db::open_started(path.to_str())
            .await
            .expect("reopen");
        let again = Instance::load(&reopened, &InstanceConfig::default())
            .await
            .expect("load");
        assert_eq!(again.relay_secret, secret, "the secret survives a restart");
        crate::db::close(&reopened).await;
        done(state, path).await;
    }
}
