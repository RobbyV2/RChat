use crate::{
    api::auth::new_token,
    instance::{Instance, InstanceConfig},
    sso::{
        Sso,
        accounts::suspend,
        config::{ProviderConfig, SsoConfig, TokenAuth},
        fake_idp::{FakeIdp, Tamper, serve_on},
        jwt::Alg,
    },
    state::AppState,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, Response, StatusCode, header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use tokio::{net::TcpListener, task::JoinHandle};
use url::Url;

struct Fixture {
    idp: FakeIdp,
    state: AppState,
    client: Client,
    origin: String,
    verifier: String,
    name: String,
    task: JoinHandle<()>,
    path: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.path);
    }
}
impl Fixture {
    async fn new(configure: impl FnOnce(&FakeIdp, &mut ProviderConfig)) -> Self {
        Self::with_policy(configure, |_| {}).await
    }
    async fn with_policy(
        configure: impl FnOnce(&FakeIdp, &mut ProviderConfig),
        policy: impl FnOnce(&mut SsoConfig),
    ) -> Self {
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let name = format!("u{}", &new_token()[..14]);
        idp.set_claims(json!({"preferred_username":name,"name":name,"groups":["staff"]}));
        let mut provider = idp.provider_config("fake");
        configure(&idp, &mut provider);
        let (state, path) = crate::api::test_util::temp_state("oidc_sign_in").await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://localhost:{}", listener.local_addr().unwrap().port());
        let instance = Instance::load(
            &state.db,
            &InstanceConfig {
                public_url: Some(origin.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut config = SsoConfig {
            providers: vec![provider],
            ..Default::default()
        };
        policy(&mut config);
        let state = state
            .with_instance(instance)
            .with_sso(Arc::new(Sso::new(config).unwrap()));
        let (_, task) = serve_on(state.clone(), listener);
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        Self {
            idp,
            client,
            state,
            origin,
            verifier: new_token(),
            name,
            task,
            path,
        }
    }
    async fn get(&self, url: &str) -> Response {
        self.client.get(url).send().await.unwrap()
    }
    async fn start(&self, ret: &str) -> Url {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(&self.verifier));
        let res = self
            .get(&format!(
                "{}/api/auth/oidc/fake/start?return={ret}&challenge={challenge}",
                self.origin
            ))
            .await;
        assert_eq!(res.status(), 302);
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
        location(res)
    }
    async fn callback(&self, ret: &str) -> Url {
        let authorize = self.start(ret).await;
        assert_eq!(
            authorize.as_str().split('?').next().unwrap(),
            format!("{}/authorize", self.idp.issuer)
        );
        assert_eq!(param(&authorize, "code_challenge_method"), "S256");
        assert!(!param(&authorize, "nonce").is_empty());
        assert!(!param(&authorize, "state").is_empty());
        assert_eq!(
            param(&authorize, "redirect_uri"),
            format!("{}/api/auth/oidc/fake/callback", self.origin)
        );
        location(self.get(authorize.as_str()).await)
    }
    async fn returned(&self, ret: &str) -> Url {
        let cb = self.callback(ret).await;
        location(self.get(cb.as_str()).await)
    }
    async fn exchange(&self, code: &str, verifier: &str, name: Option<&str>) -> Response {
        self.client
            .post(format!("{}/api/auth/oidc/exchange", self.origin))
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"code":code,"verifier":verifier,"username":name}).to_string())
            .send()
            .await
            .unwrap()
    }
}
async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}
fn location(resp: Response) -> Url {
    assert!(resp.status().is_redirection(), "{}", resp.status());
    Url::parse(resp.headers()[header::LOCATION].to_str().unwrap()).unwrap()
}
fn param(url: &Url, key: &str) -> String {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .unwrap()
        .1
        .into_owned()
}

#[tokio::test]
async fn sign_in_round_trip_web_and_replays() {
    let f = Fixture::new(|_, p| p.end_session = true).await;
    let cb = f.callback("web").await;
    let ret = location(f.get(cb.as_str()).await);
    let code = param(&ret, "code");
    assert_eq!(code.len(), 64);
    assert!(code.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(ret.as_str(), format!("{}/sso?code={code}", f.origin));
    assert_eq!(
        location(f.get(cb.as_str()).await).query(),
        Some("error=expired")
    );
    let (a, b) = tokio::join!(
        f.exchange(&code, &f.verifier, None),
        f.exchange(&code, &f.verifier, None)
    );
    let (ok, used) = if a.status().is_success() {
        (a, b)
    } else {
        (b, a)
    };
    assert_eq!(used.status(), StatusCode::BAD_REQUEST);
    let session = body(ok).await;
    assert_eq!(session["kind"], "session");
    assert_eq!(session["end_session"], true);
    let token = session["token"].as_str().unwrap();
    assert!(!ret.as_str().contains(token) && !cb.as_str().contains(token));
    let (username,provider,sid,subject):(String,String,String,String)=sqlx::query_as(
        "SELECT t.username, t.sso_provider, t.sso_sid, l.subject FROM tokens t JOIN sso_links l ON l.username=t.username AND l.provider=t.sso_provider WHERE t.token=$1"
    )
    .bind(crate::db::secret_key(token))
    .fetch_one(&f.state.db).await.unwrap();
    assert_eq!(username, f.name);
    assert_eq!(provider, "fake");
    assert_eq!(sid, subject);
    let me = f
        .client
        .get(format!("{}/api/me", f.origin))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(body(me).await["username"], f.name);
}

#[tokio::test]
async fn pending_identity_retains_only_the_fields_used_at_exchange() {
    use crate::sso::{
        accounts::{oidc_key, user_name_key},
        config::{GroupGrant, ScimConfig, ScimDelete},
    };

    let f = Fixture::with_policy(
        |_, provider| {
            provider.sync_profile = true;
            provider.allowed_groups = vec!["admitted".into()];
        },
        |config| {
            config.scim = Some(ScimConfig {
                token_sha256: [0; 32],
                provider: Some("fake".into()),
                delete: ScimDelete::Deactivate,
            });
            config.group_map.0.insert(
                "Mapped".into(),
                vec![GroupGrant {
                    server: "lobby".into(),
                    role: None,
                }],
            );
        },
    )
    .await;
    let _registered = crate::api::auth::register(
        axum::extract::State(f.state.clone()),
        axum::Json(
            serde_json::from_value(json!({
                "username": f.name, "password": "test", "avatar_kind": "identicon"
            }))
            .unwrap(),
        ),
    )
    .await
    .unwrap();
    let name_claim = format!("{}@accounts.example", f.name);
    let subject = "Person@subject.example";
    let sid = "Browser@session.example";
    f.idp.set_claims(json!({
        "sub":subject, "sid":sid, "preferred_username":name_claim,
        "name":"Display@profile.example", "groups":["admitted","Mapped","unmapped-private"],
        "email":"Private@contact.example"
    }));
    let code = param(&f.returned("web").await, "code");
    let key = crate::db::secret_key(&code);
    let pending = || {
        sqlx::query_scalar::<_, String>("SELECT data FROM sso_pending WHERE id=$1 AND kind='code'")
            .bind(&key)
            .fetch_one(&f.state.db)
    };
    let data = pending().await.unwrap();
    for private in [
        &name_claim[..],
        subject,
        sid,
        "Display@profile.example",
        "Private@contact.example",
        "unmapped-private",
        "admitted",
    ] {
        assert!(!data.contains(private));
    }
    let stored: Value = serde_json::from_str(&data).unwrap();
    let identity = &stored["identity"];
    assert_eq!(identity["subject"], oidc_key(subject).as_str());
    assert_eq!(identity["sid"], oidc_key(sid).as_str());
    assert_eq!(identity["scim_key"], user_name_key(&name_claim));
    assert_eq!(identity["username_claim"], f.name);
    assert!(identity["display"].is_null());
    assert_eq!(identity["groups"], json!(["Mapped"]));
    let picker = body(f.exchange(&code, &f.verifier, None).await).await;
    assert_eq!(picker["kind"], "pick_username");
    assert_eq!(picker["suggestion"], f.name);
    assert_eq!(pending().await.unwrap(), data);
    let taken = f.exchange(&code, &f.verifier, Some(&f.name)).await;
    assert_eq!(taken.status(), StatusCode::BAD_REQUEST);
    assert_eq!(pending().await.unwrap(), data);

    // Provision the matching account before retry. Only the original email's lookup key
    // can resolve it. The cleaned suggestion alone still collides with the local account.
    sqlx::query("INSERT INTO scim_users(id,username,user_name_key,created_at,updated_at) VALUES($1,$2,$3,0,0)")
        .bind(new_token()).bind(&f.name).bind(user_name_key(&name_claim))
        .execute(&f.state.db).await.unwrap();
    let session = body(f.exchange(&code, &f.verifier, None).await).await;
    assert_eq!(session["kind"], "session");
    let me = f
        .client
        .get(format!("{}/api/me", f.origin))
        .bearer_auth(session["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(body(me).await["username"], f.name);
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT COALESCE(actor,'') || action || COALESCE(target,'') || detail FROM instance_audit",
    )
    .fetch_all(&f.state.db)
    .await
    .unwrap();
    assert!(audit.iter().any(|row| row.contains("sso.sign_in")));
    for row in audit {
        assert!(!row.contains('@') && !row.contains("unmapped-private"));
    }
}

#[tokio::test]
async fn app_return_and_wrong_verifier() {
    let f = Fixture::new(|_, _| {}).await;
    let ret = f.returned("app").await;
    let code = param(&ret, "code");
    assert_eq!(
        ret.as_str(),
        format!(
            "rchat://{}/sso?code={code}",
            f.origin.trim_start_matches("http://")
        )
    );
    for (c, v) in [
        (&code, new_token()),
        (&code, f.verifier.clone()),
        (&new_token(), f.verifier.clone()),
    ] {
        let res = f.exchange(c, &v, None).await;
        assert_eq!(res.status(), 400);
        assert_eq!(
            body(res).await,
            json!({"error":"Sign-in expired. Try again"})
        );
    }
}

#[tokio::test]
async fn idp_errors_redirect_plainly() {
    let f = Fixture::new(|_, _| {}).await;
    for (tamper, expected) in [
        (Tamper::IdpError("access_denied"), "denied"),
        (Tamper::TokenError, "failed"),
        (Tamper::Nonce, "failed"),
    ] {
        f.idp.tamper(tamper);
        assert_eq!(
            f.returned("web").await.as_str(),
            format!("{}/sso?error={expected}", f.origin)
        );
    }
    let down = Fixture::new(|_, p| p.issuer = "http://127.0.0.1:0".into()).await;
    assert_eq!(down.start("web").await.query(), Some("error=unavailable"));
}

#[tokio::test]
async fn allowed_groups_gate_sign_in() {
    let f = Fixture::new(|_, p| p.allowed_groups = vec!["staff".into()]).await;
    assert_eq!(param(&f.returned("web").await, "code").len(), 64);
    f.idp.set_claims(json!({"groups":["other"]}));
    assert_eq!(f.returned("web").await.query(), Some("error=not_allowed"));
}

#[tokio::test]
async fn token_auth_follows_config() {
    for (mode, confidential) in [
        (TokenAuth::Basic, true),
        (TokenAuth::Post, true),
        (TokenAuth::Basic, false),
    ] {
        let f = Fixture::new(|idp, p| {
            p.token_auth = mode;
            p.client_secret = confidential.then(|| crate::config::Secret("test: +/secret".into()));
            idp.set_client_auth(mode, p.client_secret.clone());
        })
        .await;
        assert_eq!(param(&f.returned("web").await, "code").len(), 64);
    }
}

#[tokio::test]
async fn bad_parameters_and_unknown_provider() {
    let f = Fixture::new(|_, _| {}).await;
    for (suffix, status) in [
        ("unknown/start", 404),
        ("fake/start", 400),
        ("fake/start?return=foo", 400),
        ("fake/start?return=web&challenge=x", 400),
    ] {
        assert_eq!(
            f.get(&format!("{}/api/auth/oidc/{suffix}", f.origin))
                .await
                .status(),
            status
        );
    }
    assert_eq!(
        f.exchange(&"1".repeat(10000), &f.verifier, None)
            .await
            .status(),
        400
    );
    assert_eq!(
        f.exchange("x", &f.verifier, Some(&"u".repeat(101)))
            .await
            .status(),
        400
    );
}

#[tokio::test]
async fn pick_username_keeps_code_and_suspension_blocks_session() {
    let f = Fixture::new(|_, _| {}).await;
    // Create a different account with the generated claim name to force the picker.
    let _registered = crate::api::auth::register(
        axum::extract::State(f.state.clone()),
        axum::Json(
            serde_json::from_value(
                json!({"username":f.name,"password":"test","avatar_kind":"identicon"}),
            )
            .unwrap(),
        ),
    )
    .await
    .unwrap();
    let code = param(&f.returned("web").await, "code");
    assert_eq!(
        body(f.exchange(&code, &f.verifier, None).await).await["kind"],
        "pick_username"
    );
    assert_eq!(
        f.exchange(&code, &f.verifier, Some(&f.name)).await.status(),
        400
    );
    let fresh = format!("v{}", &new_token()[..14]);
    assert_eq!(
        body(f.exchange(&code, &f.verifier, Some(&fresh)).await).await["kind"],
        "session"
    );
    let code = param(&f.returned("web").await, "code");
    suspend(&f.state, &fresh).await.unwrap();
    assert_eq!(f.exchange(&code, &f.verifier, None).await.status(), 403);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tokens WHERE username=$1")
        .bind(fresh)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn expiry_and_issuer_checks_consume_no_identity() {
    let f = Fixture::new(|_, _| {}).await;
    let mut cb = f.callback("app").await;
    cb.query_pairs_mut()
        .append_pair("iss", "https://unexpected.invalid");
    assert_eq!(
        location(f.get(cb.as_str()).await).query(),
        Some("error=failed")
    );
    assert_eq!(
        location(f.get(cb.as_str()).await).query(),
        Some("error=expired")
    );
    let cb = f.callback("app").await;
    let state = param(&cb, "state");
    sqlx::query("UPDATE sso_pending SET expires_at=$1 WHERE id=$2")
        .bind(crate::db::now())
        .bind(crate::db::secret_key(&state))
        .execute(&f.state.db)
        .await
        .unwrap();
    assert_eq!(
        location(f.get(cb.as_str()).await).as_str(),
        format!("{}/sso?error=expired", f.origin)
    );
    let code = param(&f.returned("app").await, "code");
    sqlx::query("UPDATE sso_pending SET expires_at=$1 WHERE id=$2")
        .bind(crate::db::now())
        .bind(crate::db::secret_key(&code))
        .execute(&f.state.db)
        .await
        .unwrap();
    assert_eq!(f.exchange(&code, &f.verifier, None).await.status(), 400);
}

#[tokio::test]
async fn exchange_rejects_codes_for_other_purposes_and_actors() {
    use crate::sso::flow::{self, FlowKind};
    let f = Fixture::new(|_, _| {}).await;
    for (kind, actor) in [
        (FlowKind::Link, Some(f.name.clone())),
        (FlowKind::Reauth, Some(f.name.clone())),
        (FlowKind::Login, Some(f.name.clone())),
    ] {
        let code = param(&f.returned("web").await, "code");
        let mut app = flow::take_code(&f.state.db, &code).await.unwrap();
        app.kind = kind;
        app.user = actor;
        flow::put_back(&f.state.db, &code, &app, app.expires_at)
            .await
            .unwrap();
        let response = f.exchange(&code, &f.verifier, None).await;
        assert_eq!(response.status(), 400);
        assert_eq!(body(response).await["error"], "Sign-in expired. Try again");
    }
}

#[tokio::test]
async fn changed_provider_membership_policy_requires_fresh_sign_in() {
    use super::{ExchangeReq, exchange};
    use axum::{Json, extract::State};
    let f = Fixture::new(|_, cfg| cfg.allowed_groups = vec!["staff".into()]).await;
    let code = param(&f.returned("web").await, "code");
    let mut config = f.state.sso.config.clone();
    config.providers[0].allowed_groups = vec!["engineering".into()];
    let restarted = f
        .state
        .clone()
        .with_sso(Arc::new(Sso::new(config).unwrap()));
    let request = ExchangeReq {
        code,
        verifier: f.verifier.clone(),
        username: None,
    };
    let err = exchange(State(restarted), Json(request)).await.unwrap_err();
    assert_eq!(err.0, StatusCode::BAD_REQUEST);
    assert_eq!(err.1, "Sign-in expired. Try again");
    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username=$1")
        .bind(&f.name)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    assert_eq!(accounts, 0);
}

#[tokio::test]
async fn start_accepts_only_canonical_sha256_challenges() {
    let f = Fixture::new(|_, _| {}).await;
    let mut challenge = URL_SAFE_NO_PAD.encode([0; 32]);
    let url = |value: &str| {
        format!(
            "{}/api/auth/oidc/fake/start?return=web&challenge={value}",
            f.origin
        )
    };
    assert_eq!(f.get(&url(&challenge)).await.status(), StatusCode::FOUND);
    challenge.push('A');
    assert_eq!(
        f.get(&url(&challenge)).await.status(),
        StatusCode::BAD_REQUEST
    );
    challenge.truncate(42);
    challenge.push('B');
    assert_eq!(
        f.get(&url(&challenge)).await.status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn a_correctable_picker_error_keeps_the_original_expiration() {
    let f = Fixture::new(|_, _| {}).await;
    let code = param(&f.returned("web").await, "code");
    let key = crate::db::secret_key(&code);
    let expires = crate::db::now() + 120;
    let deadline = |value| {
        sqlx::query("UPDATE sso_pending SET expires_at=$1 WHERE id=$2")
            .bind(value)
            .bind(&key)
    };
    deadline(expires).execute(&f.state.db).await.unwrap();
    let name = "x".repeat(crate::api::NAME_MAX + 1);
    let live = f.exchange(&code, &f.verifier, Some(&name)).await;
    assert_eq!(live.status(), StatusCode::BAD_REQUEST);
    assert_ne!(body(live).await["error"], "Sign-in expired. Try again");
    let saved: i64 = sqlx::query_scalar("SELECT expires_at FROM sso_pending WHERE id=$1")
        .bind(&key)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
    assert_eq!(saved, expires);
    deadline(crate::db::now() - 1)
        .execute(&f.state.db)
        .await
        .unwrap();
    let expired = f.exchange(&code, &f.verifier, Some(&name)).await;
    assert_eq!(expired.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body(expired).await["error"], "Sign-in expired. Try again");
}
