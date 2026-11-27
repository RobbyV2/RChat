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
use std::sync::Arc;
use tokio::{net::TcpListener, task::JoinHandle};
use url::Url;

struct Fixture {
    idp: FakeIdp,
    second: FakeIdp,
    state: AppState,
    client: Client,
    origin: String,
    verifier: String,
    name: String,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new(configure: impl FnOnce(&FakeIdp, &mut ProviderConfig)) -> Self {
        Self::configured(configure, |_| {}, None).await
    }
    async fn configured(
        configure: impl FnOnce(&FakeIdp, &mut ProviderConfig),
        policy: impl FnOnce(&mut SsoConfig),
        web: Option<&std::path::Path>,
    ) -> Self {
        let (state, _path) = crate::api::test_util::temp_state("oidc_sign_in").await;
        Self::with_state(state, configure, policy, web).await
    }
    async fn with_state(
        state: AppState,
        configure: impl FnOnce(&FakeIdp, &mut ProviderConfig),
        policy: impl FnOnce(&mut SsoConfig),
        web: Option<&std::path::Path>,
    ) -> Self {
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let name = format!("u{}", &new_token()[..14]);
        idp.set_claims(json!({"preferred_username":name,"name":name,"groups":["staff"]}));
        let mut provider = idp.provider_config("fake");
        configure(&idp, &mut provider);
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
        let second = FakeIdp::start(Alg::EdDsa).await;
        let mut config = SsoConfig {
            providers: vec![
                provider,
                ProviderConfig {
                    name: "Second fixture provider".into(),
                    ..second.provider_config("second")
                },
            ],
            ..Default::default()
        };
        policy(&mut config);
        let state = state
            .with_instance(instance)
            .with_sso(Arc::new(Sso::new(config).unwrap()));
        let task = if let Some(web) = web {
            use crate::{
                config::Roles,
                server::client_ip::{ClientIp, ProxyTrust},
            };
            let api = crate::api::routes(
                state.clone(),
                &Roles::ALL,
                ClientIp(ProxyTrust::from_config(false, Some("127.0.0.1")).unwrap()),
                None,
            )
            .with_state(state.clone());
            let router = axum::Router::new()
                .nest("/api/v1", api.clone())
                .nest("/api", api)
                .fallback_service(tower_http::services::ServeDir::new(web))
                .layer(crate::server::cors_layer());
            tokio::spawn(async move {
                axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
                )
                .await
                .unwrap()
            })
        } else {
            serve_on(state.clone(), listener).1
        };
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        Self {
            idp,
            second,
            client,
            state,
            origin,
            verifier: new_token(),
            name,
            task,
        }
    }
    async fn get(&self, url: &str) -> Response {
        self.client.get(url).send().await.unwrap()
    }
    async fn start(&self, provider: &str, ret: &str) -> Url {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(&self.verifier));
        let res = self
            .get(&format!(
                "{}/api/auth/oidc/{provider}/start?return={ret}&challenge={challenge}",
                self.origin
            ))
            .await;
        assert_eq!(res.status(), 302);
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
        location(res)
    }
    async fn callback(&self, provider: &str, ret: &str) -> Url {
        let authorize = self.start(provider, ret).await;
        assert_eq!(
            authorize.as_str().split('?').next().unwrap(),
            format!("{}/authorize", self.idp.issuer)
        );
        assert_eq!(param(&authorize, "code_challenge_method"), "S256");
        assert!(!param(&authorize, "nonce").is_empty());
        assert!(!param(&authorize, "state").is_empty());
        assert_eq!(
            param(&authorize, "redirect_uri"),
            format!("{}/api/auth/oidc/{provider}/callback", self.origin)
        );
        location(self.get(authorize.as_str()).await)
    }
    async fn returned(&self, ret: &str) -> Url {
        let cb = self.callback("fake", ret).await;
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
    let cb = f.callback("fake", "web").await;
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
    assert!(session.get("confirmation").is_none());
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

    let f = Fixture::configured(
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
        None,
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
    let pending = || async {
        let (data, sealed): (String, Option<Vec<u8>>) =
            sqlx::query_as("SELECT data, data_sealed FROM sso_pending WHERE id=$1 AND kind='code'")
                .bind(&key)
                .fetch_one(&f.state.db)
                .await?;
        assert!(data.is_empty() && sealed.is_some(), "stored sealed");
        let opened =
            crate::crypt::secrets::open_or(&f.state.db, "sso_pending", "data", &key, sealed, data)
                .await
                .expect("opens");
        Ok::<_, sqlx::Error>(opened.to_string())
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
    assert_eq!(
        down.start("fake", "web").await.query(),
        Some("error=unavailable")
    );
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
    let mut cb = f.callback("fake", "app").await;
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
    let cb = f.callback("fake", "app").await;
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

impl Fixture {
    async fn session(&self) -> crate::api::reauth::Session {
        let code = param(&self.returned("web").await, "code");
        let response = body(self.exchange(&code, &self.verifier, None).await).await;
        crate::api::reauth::Session {
            user: crate::db::get_user(&self.state.db, &self.name)
                .await
                .unwrap()
                .unwrap(),
            token: response["token"].as_str().unwrap().into(),
            created_at: crate::db::now(),
        }
    }

    async fn ticket(&self, token: &str, purpose: &str, provider: &str) -> Response {
        self.client
            .post(format!("{}/api/me/sso/ticket", self.origin))
            .bearer_auth(token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"provider":provider,"purpose":purpose}).to_string())
            .send()
            .await
            .unwrap()
    }

    async fn fresh_return(&self, token: &str) -> Url {
        let response = self.ticket(token, "reauth", "fake").await;
        assert_eq!(response.status(), 200);
        let ticket = body(response).await["ticket"].as_str().unwrap().to_owned();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(&self.verifier));
        let start = format!(
            "{}/api/auth/oidc/fake/start?return=web&challenge={challenge}&ticket={ticket}",
            self.origin
        );
        let client = start.replace(
            "return=web",
            "return=client&origin=https%3A%2F%2Fapp.example",
        );
        assert_eq!(self.get(&client).await.status(), 400);
        let auth = location(self.get(&start).await);
        assert_eq!(param(&auth, "prompt"), "login");
        assert_eq!(param(&auth, "max_age"), "0");
        assert_eq!(
            location(self.get(&start).await).query(),
            Some("error=expired")
        );
        let cb = location(self.get(auth.as_str()).await);
        location(self.get(cb.as_str()).await)
    }
}

#[tokio::test]
async fn fresh_idp_reauth_round_trip() {
    for (state, db) in crate::api::test_util::each_db("oidc_fresh_reauth").await {
        let fixture = Fixture::with_state(state.clone(), |_, _| {}, |_| {}, None).await;
        exercise_fresh(&fixture).await;
        drop(fixture);
        db.done(state).await;
    }
}

async fn exercise_fresh(f: &Fixture) {
    use crate::api::reauth::{Purpose, ReAuth, check};
    let session = f.session().await;
    let code = param(&f.fresh_return(&session.token).await, "code");
    let proof = || ReAuth::FreshIdp {
        provider: "fake".into(),
        code: code.clone(),
    };
    check(&f.state, &session, proof(), Purpose::RemovePhrase)
        .await
        .unwrap();
    let err = check(&f.state, &session, proof(), Purpose::RemovePhrase)
        .await
        .unwrap_err();
    assert_eq!(
        (err.0.as_u16(), err.1.as_str()),
        (401, "Sign in again to continue")
    );
    let code = param(&f.fresh_return(&session.token).await, "code");
    let mut config = f.state.sso.config.clone();
    config.providers[0].allowed_groups = vec!["changed-group".into()];
    let restarted = f
        .state
        .clone()
        .with_sso(Arc::new(Sso::new(config).unwrap()));
    let error = check(
        &restarted,
        &session,
        ReAuth::FreshIdp {
            provider: "fake".into(),
            code,
        },
        Purpose::RemovePhrase,
    )
    .await
    .unwrap_err();
    assert_eq!(error.0, StatusCode::UNAUTHORIZED);
    let other = f.session().await;
    let code = param(&f.fresh_return(&session.token).await, "code");
    assert_eq!(
        check(
            &f.state,
            &other,
            ReAuth::FreshIdp {
                provider: "fake".into(),
                code
            },
            Purpose::RemovePhrase
        )
        .await
        .unwrap_err()
        .0,
        401
    );
    let code = param(&f.fresh_return(&session.token).await, "code");
    assert_eq!(f.exchange(&code, &f.verifier, None).await.status(), 400);
}

#[tokio::test]
async fn stale_or_missing_auth_time_is_refused() {
    let f = Fixture::new(|_, _| {}).await;
    let session = f.session().await;
    for mode in [Tamper::StaleAuthTime, Tamper::NoAuthTime] {
        f.idp.tamper(mode);
        assert_eq!(
            f.fresh_return(&session.token).await.query(),
            Some("error=failed")
        );
    }
    f.idp.tamper(Tamper::None);
    f.idp
        .set_claims(json!({"sub":"other-subject","preferred_username":"bob"}));
    let code = param(&f.returned("web").await, "code");
    let bob = body(f.exchange(&code, &f.verifier, None).await).await;
    assert_eq!(bob["user"]["username"], "bob");
    f.idp.set_claims(json!({"sub":"other-subject"}));
    assert_eq!(
        f.fresh_return(&session.token).await.query(),
        Some("error=failed")
    );
    assert_eq!(f.ticket(&session.token, "link", "fake").await.status(), 400);
    assert_eq!(
        f.ticket(&session.token, "reauth", "missing").await.status(),
        400
    );
    assert_eq!(f.ticket("guest", "reauth", "fake").await.status(), 401);
}

#[tokio::test]
async fn tickets_are_bound_to_provider_and_expiry() {
    let f = Fixture::new(|_, _| {}).await;
    let session = f.session().await;
    let ticket = body(f.ticket(&session.token, "reauth", "fake").await).await["ticket"]
        .as_str()
        .unwrap()
        .to_owned();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(&f.verifier));
    let start = |provider: &str| {
        format!(
            "{}/api/auth/oidc/{provider}/start?return=web&challenge={challenge}&ticket={ticket}",
            f.origin
        )
    };
    assert_eq!(
        location(f.get(&start("second")).await).query(),
        Some("error=expired")
    );
    sqlx::query("UPDATE sso_pending SET expires_at=0 WHERE kind='ticket' AND id=$1")
        .bind(crate::db::secret_key(&ticket))
        .execute(&f.state.db)
        .await
        .unwrap();
    assert_eq!(
        location(f.get(&start("fake")).await).query(),
        Some("error=expired")
    );
}

impl Fixture {
    async fn post_account(&self, token: &str, path: &str, value: Value) -> Response {
        self.client
            .post(format!("{}/api/me/{path}", self.origin))
            .bearer_auth(token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(value.to_string())
            .send()
            .await
            .unwrap()
    }

    async fn password_account(&self, name: &str) -> String {
        crate::api::auth::register(
            axum::extract::State(self.state.clone()),
            axum::Json(
                serde_json::from_value(
                    json!({"username":name,"password":"test","avatar_kind":"identicon"}),
                )
                .unwrap(),
            ),
        )
        .await
        .unwrap()
        .0
        .token
    }

    async fn link_exchange(&self, token: &str, provider: &str, proof: Value) -> Response {
        let ticket = body(
            self.post_account(
                token,
                "sso/ticket",
                json!({"purpose":"link","provider":provider,"reauth":proof}),
            )
            .await,
        )
        .await;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(&self.verifier));
        let start = format!(
            "{}/api/auth/oidc/{provider}/start?return=web&challenge={challenge}&ticket={}",
            self.origin,
            ticket["ticket"].as_str().unwrap()
        );
        let authorize = location(self.get(&start).await);
        let callback = location(self.get(authorize.as_str()).await);
        let ret = location(self.get(callback.as_str()).await);
        self.exchange(&param(&ret, "code"), &self.verifier, None)
            .await
    }
    async fn links(&self, token: &str) -> Value {
        body(
            self.client
                .get(format!("{}/api/me/sso", self.origin))
                .bearer_auth(token)
                .send()
                .await
                .unwrap(),
        )
        .await
    }

    async fn remove(&self, token: &str, provider: &str) -> Response {
        self.client
            .delete(format!("{}/api/me/sso/{provider}", self.origin))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn linking_needs_reauth_and_a_free_subject() {
    let f = Fixture::new(|_, p| p.name = "Example".into()).await;
    let token = f.password_account("alice").await;
    assert_eq!(f.ticket(&token, "link", "fake").await.status(), 400);
    let wrong = f.password_account("bob").await;
    let response = f
        .post_account(
            &wrong,
            "sso/ticket",
            json!({"purpose":"link","provider":"fake","reauth":{"password":"other"}}),
        )
        .await;
    assert_eq!(response.status(), 401);
    assert_eq!(body(response).await["error"], "Wrong password");
    assert_eq!(
        body(
            f.link_exchange(&token, "fake", json!({"password":"test"}))
                .await
        )
        .await,
        json!({"kind":"linked","provider":"fake"})
    );
    let list = f.links(&token).await;
    assert_eq!(list[0]["can_unlink"], true);
    assert_eq!(list[0]["name"], "Example");
    assert_eq!(list[0]["provider"], "fake");
    assert!(list[0]["linked_at"].is_i64());
    let other = f.password_account("carol").await;
    let response = f
        .link_exchange(&other, "fake", json!({"password":"test"}))
        .await;
    assert_eq!(response.status(), 400);
    assert_eq!(
        body(response).await["error"],
        "That sign-in belongs to another account"
    );
    let code = param(&f.returned("web").await, "code");
    let login = body(f.exchange(&code, &f.verifier, None).await).await;
    assert_eq!(login["user"]["username"], "alice");
    assert_eq!(login["user"]["has_password"], true);
    assert_eq!(f.remove(&token, "fake").await.status(), 200);
    assert_eq!(f.remove(&token, "fake").await.status(), 404);
    let actions: Vec<String> = sqlx::query_scalar("SELECT action FROM instance_audit WHERE actor='alice' AND action IN ('sso.link','sso.unlink') ORDER BY action")
        .fetch_all(&f.state.db).await.unwrap();
    assert_eq!(actions, ["sso.link", "sso.unlink"]);
    assert!(
        crate::api::user_for_token(&f.state, login["token"].as_str().unwrap())
            .await
            .unwrap()
            .is_some()
    );
    crate::api::test_util::site_sets(&f.state, json!({"password_login":false})).await;
    let changed = f
        .post_account(
            login["token"].as_str().unwrap(),
            "password",
            json!({"current":{"password":"test"},"new":{"password":"changed"}}),
        )
        .await;
    assert_eq!(changed.status(), 200);
}

#[tokio::test]
async fn passwordless_accounts_set_a_first_password() {
    let f = Fixture::new(|_, _| {}).await;
    let session = f.session().await;
    let other = f.session().await;
    let token = &session.token;
    let me = |token: &str| {
        f.client
            .get(format!("{}/api/me", f.origin))
            .bearer_auth(token)
            .send()
    };
    assert_eq!(body(me(token).await.unwrap()).await["has_password"], false);
    assert_eq!(
        body(f.remove(token, "fake").await).await["error"],
        "Add a password or another sign-in first"
    );
    let change = |proof: Value| {
        f.post_account(
            token,
            "password",
            json!({"new":{"password":"pw-new-123"},"reauth":proof}),
        )
    };
    assert_eq!(
        f.post_account(
            token,
            "password",
            json!({"new":{"password":"new"},"current":{"password":"test"}})
        )
        .await
        .status(),
        400
    );
    assert_eq!(change(json!({"fresh_session":true})).await.status(), 401);
    crate::api::test_util::site_sets(&f.state, json!({"password_login":false})).await;
    let disabled = change(json!({"fresh_session":true})).await;
    assert_eq!(disabled.status(), 403);
    assert_eq!(body(disabled).await["error"], "Password sign-in is off");
    crate::api::test_util::site_sets(&f.state, json!({"password_login":true})).await;
    let code = param(&f.fresh_return(token).await, "code");
    assert_eq!(
        change(json!({"idp":{"provider":"fake","code":code}}))
            .await
            .status(),
        200
    );
    assert_eq!(me(&other.token).await.unwrap().status(), 401);
    assert_eq!(body(me(token).await.unwrap()).await["has_password"], true);
}

#[tokio::test]
async fn concurrent_unlinks_keep_one_method_and_sessions() {
    let f = Fixture::new(|_, _| {}).await;
    let session = f.session().await;
    f.second.set_claims(json!({"sub":"second-subject"}));
    sqlx::query("INSERT INTO sso_links(issuer,subject,provider,username,linked_at,last_login_at) VALUES($2,'second-subject','second',$1,1,1)")
        .bind(&f.name).bind(f.second.provider_config("second").issuer).execute(&f.state.db).await.unwrap();
    let list = f.links(&session.token).await;
    assert_eq!(list[0]["can_unlink"], true);
    assert_eq!(list[1]["can_unlink"], true);
    let (a, b) = tokio::join!(
        f.remove(&session.token, "fake"),
        f.remove(&session.token, "second")
    );
    let mut statuses = [a.status().as_u16(), b.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 400]);
    assert!(
        crate::api::user_for_token(&f.state, &session.token)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn client_login_requires_instance_consent_and_bound_verifier() {
    for (state, db) in crate::api::test_util::each_db("oidc_client_consent").await {
        let fixture = Fixture::with_state(state.clone(), |_, _| {}, |_| {}, None).await;
        exercise_client_consent(&fixture).await;
        drop(fixture);
        db.done(state).await;
    }
}

async fn exercise_client_consent(f: &Fixture) {
    let client_origin = "https://app.example";
    let endpoint = format!("{}/api/auth/oidc/client-consent", f.origin);
    for (allow, valid_verifier) in [(false, false), (true, false), (true, true)] {
        let ret = f.returned("client&origin=https%3A%2F%2Fapp.example").await;
        assert_eq!(ret.origin().ascii_serialization(), f.origin);
        assert!(ret.query().is_none());
        let receipt = ret.fragment().unwrap().strip_prefix("consent=").unwrap();
        let decision = |origin: &str, action: &str| {
            f.client
                .post(&endpoint)
                .header(header::ORIGIN, origin)
                .header(header::CONTENT_TYPE, "application/json")
                .body(json!({"receipt":receipt,"action":action}).to_string())
                .send()
        };
        assert_eq!(f.exchange(receipt, &f.verifier, None).await.status(), 400);
        assert_eq!(
            decision(client_origin, "allow").await.unwrap().status(),
            403
        );
        let description = body(decision(&f.origin, "describe").await.unwrap()).await;
        assert_eq!(description["origin"], client_origin);
        assert!(description.get("code").is_none());
        let deadline = crate::db::now() + 20;
        sqlx::query("UPDATE sso_pending SET expires_at=$1 WHERE id=$2")
            .bind(deadline)
            .bind(crate::db::secret_key(receipt))
            .execute(&f.state.db)
            .await
            .unwrap();
        let accepted = body(
            decision(&f.origin, if allow { "allow" } else { "cancel" })
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(decision(&f.origin, "allow").await.unwrap().status(), 400);
        if allow {
            let code = accepted["code"].as_str().unwrap();
            assert_ne!(code, receipt);
            let expires_at: i64 =
                sqlx::query_scalar("SELECT expires_at FROM sso_pending WHERE id=$1")
                    .bind(crate::db::secret_key(code))
                    .fetch_one(&f.state.db)
                    .await
                    .unwrap();
            assert_eq!(expires_at, deadline);
            assert_eq!(
                f.exchange(
                    code,
                    if valid_verifier {
                        &f.verifier
                    } else {
                        "incorrect-verifier-for-this-disposable-test-flow"
                    },
                    None
                )
                .await
                .status(),
                if valid_verifier { 200 } else { 400 }
            );
            assert_eq!(f.exchange(code, &f.verifier, None).await.status(), 400);
        } else {
            assert!(accepted.get("code").is_none())
        }
    }
    for origin in [
        "http://other.test",
        "https://app.example/path",
        "https://user@app.example",
        "null",
    ] {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(&f.verifier));
        assert_eq!(
            f.client
                .get(
                    Url::parse_with_params(
                        &format!("{}/api/auth/oidc/fake/start", f.origin),
                        [
                            ("return", "client"),
                            ("origin", origin),
                            ("challenge", challenge.as_str())
                        ]
                    )
                    .unwrap()
                )
                .send()
                .await
                .unwrap()
                .status(),
            400
        )
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an exported web client and Chromium"]
async fn client_login_chromium() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let web = std::path::PathBuf::from(
        std::env::var_os("RCHAT_SSO_WEB_EXPORT")
            .expect("set RCHAT_SSO_WEB_EXPORT to the built static web directory"),
    );
    assert!(web.join("sso/index.html").is_file());
    let f = Fixture::configured(|_, _| {}, |_| {}, Some(&web)).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client_origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    // The exported client has one app shell for all account-prefixed routes.
    let router = axum::Router::new().fallback_service(
        tower_http::services::ServeDir::new(&web)
            .fallback(tower_http::services::ServeFile::new(web.join("index.html"))),
    );
    let static_server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let status = tokio::process::Command::new("node")
        .arg(root.join("scripts/sso/client_return_browser.mjs"))
        .args([&client_origin, &f.origin, &f.name])
        .status()
        .await
        .unwrap();
    static_server.abort();
    assert!(status.success())
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
        confirm_as: None,
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
async fn obsolete_links_cannot_replace_a_configured_sign_in() {
    let f = Fixture::new(|_, _| {}).await;
    let session = f.session().await;
    for (provider, issuer) in [
        ("ticket", f.second.provider_config("second").issuer),
        ("second", "old-issuer".into()),
    ] {
        sqlx::query("INSERT INTO sso_links(issuer,subject,provider,username,linked_at,last_login_at) VALUES($1,'old-subject',$2,$3,1,1)")
            .bind(issuer).bind(provider).bind(&f.name).execute(&f.state.db).await.unwrap();
        let list = f.links(&session.token).await;
        assert_eq!(list[0]["provider"], "fake");
        assert_eq!(list[0]["can_unlink"], false);
        assert_eq!(list[1]["provider"], provider);
        assert_eq!(list[1]["can_unlink"], true);
        if provider == "ticket" {
            assert_eq!(list[1]["name"], "ticket");
        }
        assert_eq!(f.remove(&session.token, "fake").await.status(), 400);
        assert_eq!(f.remove(&session.token, provider).await.status(), 200);
    }
}

#[tokio::test]
async fn phrase_authorizes_link_ticket_and_first_password() {
    let f = Fixture::new(|_, _| {}).await;
    let link_session = f.session().await;
    let password_session = f.session().await;
    sqlx::query("UPDATE users SET recovery_pub=$1 WHERE username=$2")
        .bind(crate::api::test_util::PHRASE_KEY)
        .bind(&f.name)
        .execute(&f.state.db)
        .await
        .unwrap();
    let phrase = async |purpose: &str, context: &str| {
        let response = f
            .client
            .post(format!("{}/api/auth/recovery/challenge", f.origin))
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"username": f.name}).to_string())
            .send()
            .await
            .unwrap();
        let challenge = body(response).await;
        let nonce = challenge["nonce"].as_str().unwrap();
        let sig = crate::api::test_util::phrase_sign(purpose, &f.name, nonce, context);
        json!({"phrase":{"nonce":nonce,"sig":sig}})
    };
    let linked = f
        .link_exchange(
            &link_session.token,
            "second",
            phrase("link_idp", "second").await,
        )
        .await;
    assert_eq!(
        body(linked).await,
        json!({"kind":"linked","provider":"second"})
    );
    let changed = f
        .post_account(
            &password_session.token,
            "password",
            json!({"new":{"password":"new-password"},"reauth":phrase("set_password", "").await}),
        )
        .await;
    assert_eq!(changed.status(), 200);
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

impl Fixture {
    async fn login_session(&self, provider: &str, sid: &str) -> String {
        self.idp
            .set_claims(json!({"sub":"Subject:A","sid":sid,"preferred_username":self.name}));
        let callback = self.callback(provider, "web").await;
        let code = param(&location(self.get(callback.as_str()).await), "code");
        let session = body(self.exchange(&code, &self.verifier, None).await).await;
        assert_eq!(session["user"]["username"], self.name);
        session["token"].as_str().unwrap().to_owned()
    }

    async fn backchannel(&self, provider: &str, claim: &str, value: &str) -> Response {
        let now = crate::db::now();
        let token = self.idp.sign(json!({
            "iss":self.idp.issuer,"aud":self.idp.client_id,"iat":now,"exp":now+60,"jti":new_token(),
            "events":{(crate::sso::jwt::LOGOUT_EVENT):{}}, (claim):value
        }));
        self.client
            .post(format!(
                "{}/api/auth/oidc/{provider}/backchannel_logout",
                self.origin
            ))
            .form(&[("logout_token", token)])
            .send()
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn ordinary_and_confirmation_login_codes_require_their_own_exchange_route() {
    let f = Fixture::new(|_, _| {}).await;
    let _session = f.session().await;
    for (ret, path) in [
        ("web", "exchange/confirmation"),
        ("web&confirm=1", "exchange"),
    ] {
        let code = param(&f.returned(ret).await, "code");
        let response = f
            .client
            .post(format!("{}/api/auth/oidc/{path}", f.origin))
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"code":code,"verifier":f.verifier,"confirm_as":f.name}).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn saved_account_confirmation_survives_session_rotation() {
    use crate::api::reauth::{Purpose, ReAuth, Session, check};
    for (state, db) in crate::api::test_util::each_db("oidc_confirm").await {
        let f = Fixture::with_state(state.clone(), |_, _| {}, |_| {}, None).await;
        let old = f.login_session("fake", "first").await;
        let auth_time = crate::db::now() - 30;
        f.idp
            .set_claims(json!({"sub":"Subject:A","sid":"second","auth_time":auth_time}));
        let auth = f.start("fake", "web&confirm=1").await;
        assert_eq!(param(&auth, "prompt"), "login");
        assert_eq!(param(&auth, "max_age"), "0");
        let callback = location(f.get(auth.as_str()).await);
        assert_eq!(f.backchannel("fake", "sid", "first").await.status(), 200);
        let code = param(&location(f.get(callback.as_str()).await), "code");
        let response = f
            .client
            .post(format!("{}/api/auth/oidc/exchange/confirmation", f.origin))
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"code":code,"verifier":f.verifier,"confirm_as":f.name}).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let result = body(response).await;
        let token = result["token"].as_str().unwrap();
        assert_ne!(token, old);
        assert!(
            crate::api::user_for_token(&f.state, &old)
                .await
                .unwrap()
                .is_none()
        );
        let user = crate::api::user_for_token(&f.state, token)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(user.username, f.name);
        let session = Session {
            user,
            token: token.to_owned(),
            created_at: crate::db::now(),
        };
        let confirmation = &result["confirmation"];
        assert_eq!(
            confirmation["expires_at"],
            auth_time + crate::sso::flow::FRESH_SECS
        );
        let proof = || ReAuth::FreshIdp {
            provider: confirmation["provider"].as_str().unwrap().into(),
            code: confirmation["code"].as_str().unwrap().into(),
        };
        check(&f.state, &session, proof(), Purpose::RemovePhrase)
            .await
            .unwrap();
        assert_eq!(
            check(&f.state, &session, proof(), Purpose::RemovePhrase)
                .await
                .unwrap_err()
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert!(
            crate::api::user_for_token(&f.state, token)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(f.backchannel("fake", "sid", "second").await.status(), 200);
        assert!(
            crate::api::user_for_token(&f.state, token)
                .await
                .unwrap()
                .is_none()
        );
        drop(f);
        db.done(state).await;
    }
}

#[tokio::test]
async fn backchannel_logout_by_sid_and_sub_revokes_matching_sessions() {
    let f = Fixture::new(|_, _| {}).await;
    let one = f.login_session("fake", "Session:One").await;
    let two = f.login_session("fake", "Session:Two").await;
    for (token, provider) in [("password", None), ("other", Some("other-provider"))] {
        sqlx::query("INSERT INTO tokens (token, username, created_at, sso_provider, sso_sid) VALUES ($1,$2,$3,$4,$5)")
            .bind(crate::db::secret_key(token)).bind(&f.name).bind(crate::db::now())
            .bind(provider).bind(crate::sso::accounts::oidc_key("Session:One").as_str()).execute(&f.state.db).await.unwrap();
    }
    let mut rx = f.state.hub.subscribe();
    for (claim, value, survivor) in [("sid", "Session:One", true), ("sub", "Subject:A", false)] {
        let response = f.backchannel("fake", claim, value).await;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(response.bytes().await.unwrap().is_empty());
        assert!(
            matches!(rx.try_recv(), Ok(crate::ws::WsEvent::TokensRevoked{username}) if username == f.name)
        );
        for (token, expected) in [
            (one.as_str(), false),
            (two.as_str(), survivor),
            ("password", true),
            ("other", true),
        ] {
            assert_eq!(
                crate::api::user_for_token(&f.state, token)
                    .await
                    .unwrap()
                    .is_some(),
                expected
            );
        }
    }
    let audit_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM instance_audit WHERE actor='sso' AND action='sso.backchannel_logout' AND target='fake'")
        .fetch_one(&f.state.db).await.unwrap();
    assert_eq!(audit_count, 2);
}

#[tokio::test]
async fn subject_logout_scopes_shared_identity_to_the_session_provider() {
    for (state, db) in crate::api::test_util::each_db("oidc_shared_issuer").await {
        let f = Fixture::with_state(
            state.clone(),
            |_, provider| provider.id = "first".into(),
            |config| {
                config.providers[1] = ProviderConfig {
                    id: "second".into(),
                    ..config.providers[0].clone()
                };
            },
            None,
        )
        .await;
        let first = f.login_session("first", "Session:One").await;
        let second_one = f.login_session("second", "Session:One").await;
        let second_two = f.login_session("second", "Session:Two").await;

        let password = "test-password";
        sqlx::query("UPDATE users SET password_hash=$1 WHERE username=$2")
            .bind(crate::api::auth::hash_password(password).await.unwrap())
            .bind(&f.name)
            .execute(&f.state.db)
            .await
            .unwrap();
        let login = f
            .client
            .post(format!("{}/api/auth/login", f.origin))
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"username":f.name,"password":password}).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(login.status(), 200);
        let password_session = body(login).await;
        let password_token = password_session["token"].as_str().unwrap();

        assert_eq!(
            f.backchannel("second", "sub", "Subject:A").await.status(),
            200
        );
        for (token, status) in [
            (password_token, 200),
            (first.as_str(), 200),
            (second_one.as_str(), 401),
            (second_two.as_str(), 401),
        ] {
            let me = f
                .client
                .get(format!("{}/api/me", f.origin))
                .bearer_auth(token)
                .send()
                .await
                .unwrap();
            assert_eq!(me.status(), status);
            if status == 200 {
                assert_eq!(body(me).await["username"], f.name);
            }
        }
        drop(f);
        db.done(state).await;
    }
}

#[tokio::test]
async fn logout_returns_end_session_url_only_when_allowed() {
    for enabled in [false, true] {
        let f = Fixture::new(|_, p| p.end_session = enabled).await;
        let token = f.login_session("fake", "Session").await;
        let response = f
            .client
            .post(format!("{}/api/auth/logout", f.origin))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let payload = body(response).await;
        assert_eq!(payload["ok"], true);
        if enabled {
            let url = Url::parse(payload["end_session_url"].as_str().unwrap()).unwrap();
            assert_eq!(
                url.as_str().split('?').next().unwrap(),
                format!("{}/end_session", f.idp.issuer)
            );
            assert_eq!(param(&url, "client_id"), f.idp.client_id);
            assert_eq!(
                param(&url, "post_logout_redirect_uri"),
                format!("{}/login", f.origin)
            );
            assert_eq!(url.query_pairs().count(), 2);
        } else {
            assert!(payload["end_session_url"].is_null());
        }
    }
}

#[tokio::test]
async fn backchannel_logout_requires_a_valid_form_and_known_provider() {
    let f = Fixture::new(|_, _| {}).await;
    let token = f.login_session("fake", "Session").await;
    let endpoint = format!("{}/api/auth/oidc", f.origin);
    for form in [
        "missing=field".to_owned(),
        "logout_token=".to_owned() + &"x".repeat(17 * 1024),
    ] {
        let res = f
            .client
            .post(format!("{endpoint}/fake/backchannel_logout"))
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        assert_eq!(body(res).await, json!({"error":"invalid_request"}));
    }
    let res = f
        .client
        .post(format!("{endpoint}/unknown/backchannel_logout"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    assert!(
        crate::api::user_for_token(&f.state, &token)
            .await
            .unwrap()
            .is_some()
    );
}
