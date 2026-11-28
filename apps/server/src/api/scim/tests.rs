use super::*;
use crate::db::now;
use crate::{
    api::test_util::{done, each_db, temp_state},
    config::AppConfig,
    server::route_builder::register_routes,
    sso::{
        Sso,
        config::{ScimConfig, SsoConfig},
    },
};
use futures_util::{SinkExt, StreamExt, future::join_all};
use reqwest::{Client, Method};
use std::{net::SocketAddr, sync::Arc, time::Duration};

fn configured(state: AppState, delete: ScimDelete) -> AppState {
    state.with_sso(Arc::new(
        Sso::new(SsoConfig {
            scim: Some(ScimConfig {
                token_sha256: Sha256::digest("fixture").into(),
                provider: None,
                delete,
            }),
            ..Default::default()
        })
        .unwrap(),
    ))
}
struct Server {
    addr: SocketAddr,
    http: Client,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn start(state: AppState, api: bool) -> Self {
        let mut cfg = AppConfig::defaults();
        cfg.roles.api = api;
        cfg.roles.gateway = true;
        let router = register_routes(None, None, &cfg, state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap()
        });
        Self {
            addr,
            http: Client::new(),
            task,
        }
    }
    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("http://{}/scim/v2/{path}", self.addr))
            .bearer_auth("fixture")
    }
    async fn ask(&self, method: Method, path: &str, v: Value, status: u16) -> Value {
        let r = self
            .request(method, path)
            .header(header::CONTENT_TYPE, MEDIA)
            .body(v.to_string())
            .send()
            .await
            .unwrap();
        let code = r.status().as_u16();
        if code == 204 {
            assert_eq!(status, 204);
            return Value::Null;
        }
        assert_eq!(r.headers()[header::CONTENT_TYPE], MEDIA);
        let location = r.headers().get(header::LOCATION).cloned();
        let body = r.text().await.unwrap();
        assert_eq!(code, status, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        if status == 201 {
            assert_eq!(location.unwrap().to_str().unwrap(), v["meta"]["location"]);
        }
        v
    }
}
#[tokio::test]
async fn token_role_discovery_and_limits() {
    let (state, path) = temp_state("scim_token").await;
    for (configured_state, role) in [
        (state.clone(), true),
        (configured(state.clone(), ScimDelete::Deactivate), false),
    ] {
        let server = Server::start(configured_state, role).await;
        server.ask(Method::GET, "Users", Value::Null, 404).await;
    }
    let server = Server::start(configured(state.clone(), ScimDelete::Deactivate), true).await;
    let url = format!("http://{}/scim/v2/Users", server.addr);
    let mut limited = false;
    for i in 0..45 {
        let res = server
            .http
            .get(&url)
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap();
        if i == 0 {
            assert_eq!(res.status(), 401);
            assert!(res.text().await.unwrap().contains("2.0:Error"))
        } else {
            limited |= res.status() == 429
        }
    }
    assert!(limited);
    for _ in 0..200 {
        let cfg = server
            .ask(Method::GET, "ServiceProviderConfig", Value::Null, 200)
            .await;
        assert_eq!(cfg["patch"]["supported"], true);
        assert_eq!(cfg["bulk"]["supported"], false);
    }
    for path in ["Schemas", "ResourceTypes"] {
        assert_eq!(
            server.ask(Method::GET, path, Value::Null, 200).await["Resources"]
                .as_array()
                .unwrap()
                .len(),
            2
        )
    }
    let r = server
        .request(Method::POST, "Users")
        .header(header::CONTENT_TYPE, MEDIA)
        .body("x".repeat(BODY_MAX + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 413);
    drop(server);
    done(state, path).await;
}

#[tokio::test]
async fn provisioning_lifecycle() {
    for (state, db) in each_db("scim_lifecycle").await {
        let state = configured(state, ScimDelete::Deactivate);
        crate::api::test_util::site_sets(&state, json!({"registration": "closed"})).await;
        let server = Server::start(state.clone(), true).await;
        db::NewUser::plain("local")
            .shown("Local")
            .hash("fixture-hash")
            .at(1)
            .add(&state.db)
            .await;
        server
            .ask(Method::POST, "Users", json!({"userName":"local"}), 409)
            .await;
        assert_eq!(
            db::user_row(&state.db, "local")
                .await
                .unwrap()
                .unwrap()
                .password_hash,
            "fixture-hash"
        );
        let assigned: i64 =
            sqlx::query_scalar("SELECT count(*) FROM scim_users WHERE username='local'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(assigned, 0);
        let create = json!({"USERNAME":"alice@corp.example","NaMe":{"FORMATTED":"Alice Smith"},"EXTERNALID":"employee1","emails":[{"value":"ignored@corp.example"}]});
        let responses = join_all((0..20).map(|_| {
            server
                .request(Method::POST, "Users")
                .header(header::CONTENT_TYPE, MEDIA)
                .body(create.to_string())
                .send()
        }))
        .await;
        let mut created = None;
        for r in responses {
            let r = r.unwrap();
            let status = r.status();
            let v: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
            if status == 201 {
                assert!(created.replace(v).is_none());
            } else {
                assert_eq!(status, 409, "{v}");
                assert_eq!(v["scimType"], "uniqueness");
            }
        }
        let v = created.unwrap();
        assert_eq!(v["userName"], "alice");
        assert_eq!(v["displayName"], "Alice Smith");
        assert_eq!(v["externalId"], "employee1");
        assert_eq!(v["active"], true);
        assert!(v.get("emails").is_none());
        let id = v["id"].as_str().unwrap();
        assert_eq!(id.len(), 32);
        assert!(hex::decode(id).is_ok());
        let path = format!("Users/{id}");
        let result = server
            .ask(
                Method::GET,
                "Users?filter=userName%20eq%20%22Alice%40Corp.example%22",
                Value::Null,
                200,
            )
            .await;
        assert_eq!(result["totalResults"], 1);
        let stored: String = sqlx::query_scalar("SELECT user_name_key FROM scim_users WHERE id=$1")
            .bind(id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(stored, accounts::user_name_key("alice@corp.example"));
        let token = "fixture-session";
        sqlx::query("INSERT INTO tokens(token,username,created_at) VALUES($1,'alice',$2)")
            .bind(db::secret_key(token))
            .bind(now())
            .execute(&state.db)
            .await
            .unwrap();
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{}/api/v1/ws", server.addr))
                .await
                .unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::text(
                json!({"type":"auth","token":token}).to_string(),
            ))
            .await
            .unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Ping(
                vec![1].into(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if socket.next().await.unwrap().unwrap().is_pong() {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let op = |v: Value| json!({"Operations":[v]});
        server
            .ask(
                Method::PATCH,
                &path,
                op(json!({"op":"replace","value":{"active":false}})),
                200,
            )
            .await;
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(Ok(frame)) = socket.next().await {
                if frame.is_close() {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            server
                .http
                .get(format!("http://{}/api/v1/me", server.addr))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        for val in ["False", "True"] {
            let v = server
                .ask(
                    Method::PATCH,
                    &path,
                    op(json!({"op":"Replace","path":"active","value":val})),
                    200,
                )
                .await;
            assert_eq!(v["active"], val == "True");
        }
        assert_eq!(
            server
                .ask(
                    Method::PATCH,
                    &path,
                    op(json!({"op":"Add","path":"displayName","value":"Ali"})),
                    200
                )
                .await["displayName"],
            "Ali"
        );
        assert_eq!(
            server
                .ask(
                    Method::PATCH,
                    &path,
                    op(json!({"op":"remove","path":"displayName"})),
                    200
                )
                .await["displayName"],
            "alice"
        );
        sqlx::query("INSERT INTO messages(dm_id,author,content,created_at) SELECT id,'alice','synthetic',1 FROM dms WHERE user_a='alice' AND user_b='alice'").execute(&state.db).await.unwrap();
        server.ask(Method::DELETE, &path, Value::Null, 204).await;
        assert!(
            db::user_row(&state.db, "alice")
                .await
                .unwrap()
                .unwrap()
                .suspended_at
                .is_some()
        );
        let preserved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages WHERE author='alice' AND content='synthetic'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(preserved, 1);
        server.ask(Method::GET, &path, Value::Null, 404).await;
        server
            .ask(
                Method::POST,
                "Users",
                json!({"userName":"alice@corp.example","externalId":"different"}),
                409,
            )
            .await;
        assert_eq!(
            server.ask(Method::POST, "Users", create, 201).await["id"],
            id
        );
        let prior = server.ask(Method::GET, &path, Value::Null, 200).await;
        let ignored = server.ask(Method::PATCH, &path, op(json!({"op":"replace","path":"emails[type eq \"work\"].value","value":"ignored"})), 200).await;
        assert_eq!(prior, ignored);
        for (body, kind) in [
            (json!({"Operations":{}}), "invalidSyntax"),
            (op(json!({"op":"move"})), "invalidSyntax"),
            (
                op(json!({"op":"replace","path":"active","value":"maybe"})),
                "invalidValue",
            ),
        ] {
            assert_eq!(
                server.ask(Method::PATCH, &path, body, 400).await["scimType"],
                kind
            );
        }
        let replaced = server
            .ask(
                Method::PUT,
                &path,
                json!({"UserName":"different@example.test","DisplayNAME":"New Display","Active":false}),
                200,
            )
            .await;
        assert_eq!(replaced["userName"], "alice");
        assert_eq!(replaced["displayName"], "New Display");
        assert!(replaced["externalId"].is_null());
        assert_eq!(replaced["active"], false);
        server.ask(Method::PUT, &path, replaced, 200).await;
        let lookup = "Users?filter=userName%20eq%20%22different%40example.test%22";
        let local = "Users?filter=userName%20eq%20%22alice%22";
        assert_eq!(
            server.ask(Method::GET, lookup, Value::Null, 200).await["Resources"][0]["id"],
            id
        );
        server
            .ask(
                Method::PATCH,
                &path,
                op(json!({"op":"replace","path":"userName","value":"alice"})),
                200,
            )
            .await;
        let stale = server.ask(Method::GET, lookup, Value::Null, 200).await;
        assert_eq!(stale["totalResults"], 0);
        assert_eq!(stale["Resources"], json!([]));
        assert_eq!(
            server.ask(Method::GET, local, Value::Null, 200).await["Resources"][0]["id"],
            id
        );
        for name in ["bob", "tom", "jane", "eve"] {
            server
                .ask(Method::POST, "Users", json!({"userName":name}), 201)
                .await;
        }
        let page = server
            .ask(Method::GET, "Users?count=2&startIndex=3", Value::Null, 200)
            .await;
        assert_eq!(page["totalResults"], 5);
        assert_eq!(page["itemsPerPage"], 2);
        let full = server
            .ask(Method::GET, "Users?count=1000", Value::Null, 200)
            .await;
        assert_eq!(
            page["Resources"].as_array().unwrap(),
            &full["Resources"].as_array().unwrap()[2..4]
        );
        for i in 1..=200 {
            db::NewUser::plain(&format!("fixture-{i}"))
                .shown("Fixture")
                .hash("!test")
                .at(i)
                .add(&state.db)
                .await;
        }
        sqlx::query("INSERT INTO scim_users(id,username,user_name_key,created_at,updated_at) SELECT username,username,username,created_at,created_at FROM users WHERE username LIKE 'fixture-%'").execute(&state.db).await.unwrap();
        for (query, size) in [
            ("Users?count=1000", 200),
            ("Users", 100),
            ("Users?count=0", 0),
            ("Users?startIndex=206", 0),
        ] {
            let v = server.ask(Method::GET, query, Value::Null, 200).await;
            assert_eq!(v["totalResults"], 205);
            assert_eq!(v["Resources"].as_array().unwrap().len(), size);
        }
        drop(server);
        let server = Server::start(configured(state.clone(), ScimDelete::Delete), true).await;
        server.ask(Method::DELETE, &path, Value::Null, 204).await;
        tokio::time::timeout(Duration::from_secs(15), async {
            while db::user_row(&state.db, "alice").await.unwrap().is_some() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        drop(server);
        db.done(state).await;
    }
}

#[tokio::test]
async fn scim_group_provisioning() {
    for (state, db) in each_db("scim_group_provisioning").await {
        let state = configured(state, ScimDelete::Deactivate);
        let server = Server::start(state.clone(), true).await;
        let user = server
            .ask(Method::POST, "Users", json!({"userName":"alice"}), 201)
            .await;
        let member = json!({"value":user["id"]});
        let group = server
            .ask(
                Method::POST,
                "Groups",
                json!({"DisplayName":"Engineering","ExternalID":"dept","Members":[{"VALUE":user["id"]},{"value":"unknown"}]}),
                201,
            )
            .await;
        let path = format!("Groups/{}", group["id"].as_str().unwrap());
        assert_eq!(group["members"][0]["value"], user["id"]);
        assert_eq!(group["externalId"], "dept");
        assert_eq!(group["members"].as_array().unwrap().len(), 1);
        assert_eq!(
            server
                .ask(
                    Method::POST,
                    "Groups",
                    json!({"displayName":"Engineering"}),
                    409
                )
                .await["scimType"],
            "uniqueness"
        );
        server
            .ask(
                Method::POST,
                "Groups",
                json!({"displayName":"Occupied"}),
                201,
            )
            .await;
        server
            .ask(
                Method::PATCH,
                &path,
                json!({"Operations":[
                    {"op":"Remove","path":"members","value":[member]},
                    {"op":"Replace","path":"displayName","value":"Occupied"}
                ]}),
                409,
            )
            .await;
        assert_eq!(
            server.ask(Method::GET, &path, Value::Null, 200).await["members"],
            group["members"]
        );
        let filtered = format!("members[value eq {}]", user["id"]);
        let updated = server
            .ask(
                Method::PATCH,
                &path,
                json!({"Operations":[
                    {"op":"Remove","path":"members","value":[member]},
                    {"op":"Add","value":{"members":[member]}},
                    {"op":"replace","path":"members","value":[]},
                    {"op":"Add","path":"members","value":[member]},
                    {"op":"remove","path":filtered}
                ]}),
                200,
            )
            .await;
        assert_eq!(updated["members"], json!([]));
        assert_eq!(
            server
                .ask(
                    Method::PATCH,
                    &path,
                    json!({"Operations":[{"op":"Copy"}]}),
                    400
                )
                .await["scimType"],
            "invalidSyntax"
        );
        let bob = server
            .ask(Method::POST, "Users", json!({"userName":"bob"}), 201)
            .await;
        let replaced = server.ask(Method::PUT, &path,
            json!({"DISPLAYname":"Renamed","ExternalId":"updated","Members":[member,{"Value":bob["id"]}]}), 200).await;
        assert_eq!(replaced["externalId"], "updated");
        assert_eq!(replaced["members"].as_array().unwrap().len(), 2);
        assert_eq!(
            server.ask(Method::GET, &path, Value::Null, 200).await,
            replaced
        );
        let limited = server
            .ask(
                Method::GET,
                "Groups?filter=displayName%20eq%20%22Renamed%22&count=1",
                Value::Null,
                200,
            )
            .await;
        assert_eq!(limited["Resources"], json!([replaced]));
        for query in ["Groups?count=0", "Groups?startIndex=3&count=1"] {
            let empty = server.ask(Method::GET, query, Value::Null, 200).await;
            assert_eq!(empty["totalResults"], 2);
            assert_eq!(empty["Resources"], json!([]));
        }
        let page = server
            .ask(
                Method::GET,
                "Groups?filter=displayName%20eq%20%22Renamed%22&excludedAttributes=members",
                Value::Null,
                200,
            )
            .await;
        assert_eq!(page["totalResults"], 1);
        assert!(page["Resources"][0].get("members").is_none());
        let deleted_path = format!("Users/{}", user["id"].as_str().unwrap());
        server
            .ask(Method::DELETE, &deleted_path, Value::Null, 204)
            .await;
        let replaced = server
            .ask(
                Method::PUT,
                &path,
                json!({"displayName":"Renamed","members":[member]}),
                200,
            )
            .await;
        assert_eq!(replaced["members"], json!([]));
        let stored: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM scim_group_members WHERE group_id=$1")
                .bind(group["id"].as_str().unwrap())
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(stored, 0);
        server.ask(Method::DELETE, &path, Value::Null, 204).await;
        server.ask(Method::GET, &path, Value::Null, 404).await;
        drop(server);
        db.done(state).await;
    }
}

async fn expect_dev_role(state: &AppState, expected: bool) {
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM user_roles u JOIN roles r ON r.id=u.role_id WHERE u.server='eng' AND u.username='alice' AND r.name='Dev'",
            )
            .fetch_one(&state.db)
            .await
            .unwrap();
            if (count == 1) == expected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("group reconcile completed");
}

#[tokio::test]
async fn scim_group_push_drives_the_map() {
    for (state, db) in each_db("scim_group_map").await {
        let mut state = configured(state, ScimDelete::Deactivate);
        let map = &mut Arc::get_mut(&mut state.sso).unwrap().config.group_map.0;
        for key in ["Engineering", "6F1C-guid"] {
            map.insert(
                key.into(),
                vec![crate::sso::config::GroupGrant {
                    server: "eng".into(),
                    role: Some("Dev".into()),
                }],
            );
        }
        sqlx::query("INSERT INTO servers(name,display_name,password_hash,created_at) VALUES('eng','Engineering','protected',1)").execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO roles(server,name,color) VALUES('eng','Dev','blue'),('eng','Support','red')").execute(&state.db).await.unwrap();
        let server = Server::start(state.clone(), true).await;
        let user = server
            .ask(Method::POST, "Users", json!({"userName":"alice"}), 201)
            .await;
        let user_path = format!("Users/{}", user["id"].as_str().unwrap());
        let member = json!({"value":user["id"]});
        let group = server
            .ask(
                Method::POST,
                "Groups",
                json!({"displayName":"Engineering","members":[member]}),
                201,
            )
            .await;
        let path = format!("Groups/{}", group["id"].as_str().unwrap());
        expect_dev_role(&state, true).await;
        sqlx::query("INSERT INTO user_roles(server,username,role_id) SELECT server,'alice',id FROM roles WHERE name='Support'").execute(&state.db).await.unwrap();
        for (attrs, expected) in [
            (json!({"displayName":"engineering"}), false),
            (json!({"externalId":"6F1C-guid"}), true),
            (json!({"externalId":"6f1c-guid"}), false),
        ] {
            server
                .ask(
                    Method::PATCH,
                    &path,
                    json!({"Operations":[{"op":"replace","value":attrs}]}),
                    200,
                )
                .await;
            expect_dev_role(&state, expected).await;
        }
        server
            .ask(
                Method::PATCH,
                &user_path,
                json!({"Operations":[{"op":"Replace","path":"active","value":"False"}]}),
                200,
            )
            .await;
        // Seed desired membership directly so only the Users PUT can schedule its grant.
        let seeded_id = "unsuspend-group";
        sqlx::query("INSERT INTO scim_groups(id,display_name,created_at,updated_at) VALUES($1,'Engineering',1,1)")
            .bind(seeded_id).execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO scim_group_members(group_id,username) VALUES($1,'alice')")
            .bind(seeded_id)
            .execute(&state.db)
            .await
            .unwrap();
        expect_dev_role(&state, false).await;
        server
            .ask(
                Method::PUT,
                &user_path,
                json!({"userName":"alice","active":true}),
                200,
            )
            .await;
        expect_dev_role(&state, true).await;
        server
            .ask(
                Method::DELETE,
                &format!("Groups/{seeded_id}"),
                Value::Null,
                204,
            )
            .await;
        server.ask(Method::DELETE, &path, Value::Null, 204).await;
        expect_dev_role(&state, false).await;
        let manual: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_roles u JOIN roles r ON r.id=u.role_id WHERE u.server='eng' AND u.username='alice' AND r.name='Support'").fetch_one(&state.db).await.unwrap();
        assert_eq!(manual, 1);
        drop(server);
        db.done(state).await;
    }
}

#[tokio::test]
async fn scim_withdrawal_supersedes_only_its_own_claims() {
    use crate::sso::accounts::{Identity, oidc_key, sign_in};
    for (state, db) in each_db("scim_claim_overlap").await {
        let mut state = configured(state, ScimDelete::Deactivate);
        let config = &mut Arc::get_mut(&mut state.sso).unwrap().config;
        let oidc = AppConfig::from_map(&[
            ("PUBLIC_URL", "https://chat.example"),
            ("OIDC_PROVIDERS", "one,two"),
            ("OIDC_ONE_ISSUER", "https://one.example"),
            ("OIDC_ONE_CLIENT_ID", "one"),
            ("OIDC_TWO_ISSUER", "https://two.example"),
            ("OIDC_TWO_CLIENT_ID", "two"),
            ("SSO_GROUP_MAP", r#"{"Engineering":[{"server":"eng","role":"Dev"}],"guid":[{"server":"eng","role":"Dev"}],"extra":[{"server":"rchat"}]}"#),
        ]).unwrap().sso;
        config.providers = oidc.providers;
        config.group_map = oidc.group_map;
        config.scim.as_mut().unwrap().provider = Some("one".into());
        sqlx::query("INSERT INTO servers(name,display_name,password_hash,created_at) VALUES('eng','Engineering','protected',1)").execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO roles(server,name,color) VALUES('eng','Dev','blue')")
            .execute(&state.db)
            .await
            .unwrap();
        let server = Server::start(state.clone(), true).await;
        let user = server
            .ask(Method::POST, "Users", json!({"userName":"alice"}), 201)
            .await;
        let member = json!({"value":user["id"]});
        let mut identity = Identity {
            provider: "one".into(),
            issuer: "https://one.example".into(),
            subject: oidc_key("one"),
            username_claim: Some("alice".into()),
            scim_key: Some(crate::sso::accounts::user_name_key("alice")),
            display: None,
            groups: vec!["Engineering".into(), "guid".into(), "extra".into()],
            sid: None,
        };
        sign_in(&state, &identity, None).await.unwrap();
        expect_dev_role(&state, true).await;
        // A live v45 group is adopted before serving API traffic, even if no push
        // arrives between upgrade and a provider change.
        sqlx::query("INSERT INTO scim_groups(id,display_name,external_id,created_at,updated_at) VALUES('previous','Engineering','guid',1,1)").execute(&state.db).await.unwrap();
        initialize_group_ownership(&state).await.unwrap();
        expect_dev_role(&state, false).await;
        let mut rotated = state.sso.config.clone();
        rotated.scim.as_mut().unwrap().provider = Some("two".into());
        let rotated = state.clone().with_sso(Arc::new(Sso::new(rotated).unwrap()));
        initialize_group_ownership(&rotated).await.unwrap();
        let source: String =
            sqlx::query_scalar("SELECT alias_source FROM scim_groups WHERE id='previous'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(source, "one");
        server
            .ask(Method::DELETE, "Groups/previous", Value::Null, 204)
            .await;
        let group = server
            .ask(
                Method::POST,
                "Groups",
                json!({"displayName":"Engineering","externalId":"guid","members":[member]}),
                201,
            )
            .await;
        let path = format!("Groups/{}", group["id"].as_str().unwrap());
        let remove = json!({"Operations":[{"op":"remove","path":"members","value":[member]}]});
        let (login, _) = tokio::join!(
            sign_in(&state, &identity, None),
            server.ask(Method::PATCH, &path, remove.clone(), 200)
        );
        login.unwrap();
        expect_dev_role(&state, false).await;
        let groups = crate::sso::groups::effective_groups(&state.db, "alice")
            .await
            .unwrap();
        assert_eq!(groups, std::collections::BTreeSet::from(["extra".into()]));
        let members: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM members WHERE username='alice' AND server='eng'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(members, 0);
        // Changing the setting alone does not transfer an existing directory alias
        // to another provider. Its independent claim remains effective.
        sqlx::query(
            "INSERT INTO sso_user_groups(username,source,grp) VALUES('alice','two','Engineering')",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let mut rotated = state.sso.config.clone();
        rotated.scim.as_mut().unwrap().provider = Some("two".into());
        let rotated = state.clone().with_sso(Arc::new(Sso::new(rotated).unwrap()));
        crate::sso::groups::reconcile(&rotated, "alice")
            .await
            .unwrap();
        expect_dev_role(&rotated, true).await;
        sqlx::query("DELETE FROM sso_user_groups WHERE source='two'")
            .execute(&state.db)
            .await
            .unwrap();
        crate::sso::groups::reconcile(&rotated, "alice")
            .await
            .unwrap();
        expect_dev_role(&rotated, false).await;
        server
            .ask(
                Method::PATCH,
                &path,
                json!({"Operations":[{"op":"add","path":"members","value":[member]}]}),
                200,
            )
            .await;
        expect_dev_role(&state, true).await;
        server
            .ask(
                Method::PUT,
                &path,
                json!({"displayName":"New","externalId":"new-guid","members":[]}),
                200,
            )
            .await;
        sign_in(&state, &identity, None).await.unwrap();
        expect_dev_role(&state, false).await;
        server
            .ask(
                Method::PUT,
                &path,
                json!({"displayName":"Engineering","externalId":"guid","members":[member]}),
                200,
            )
            .await;
        expect_dev_role(&state, true).await;
        sqlx::query("INSERT INTO sso_links(issuer,subject,provider,username,linked_at,last_login_at) VALUES('https://two.example',$1,'two','alice',1,1)").bind(oidc_key("two").as_str()).execute(&state.db).await.unwrap();
        identity.provider = "two".into();
        identity.issuer = "https://two.example".into();
        identity.subject = oidc_key("two");
        sign_in(&state, &identity, None).await.unwrap();
        server.ask(Method::DELETE, &path, Value::Null, 204).await;
        crate::sso::groups::reconcile(&state, "alice")
            .await
            .unwrap();
        expect_dev_role(&state, true).await;
        identity.groups.clear();
        sign_in(&state, &identity, None).await.unwrap();
        expect_dev_role(&state, false).await;
        // A pre-upgrade cached claim has no digest. Remember which provider owned
        // its group even if a later deployment changes or disables SCIM.
        sqlx::query("UPDATE sso_user_groups SET alias_key=NULL WHERE source='one'")
            .execute(&state.db)
            .await
            .unwrap();
        for provider in [Some("two"), None] {
            let mut config = state.sso.config.clone();
            config.scim.as_mut().unwrap().provider = provider.map(str::to_owned);
            let changed = state.clone().with_sso(Arc::new(Sso::new(config).unwrap()));
            crate::sso::groups::reconcile(&changed, "alice")
                .await
                .unwrap();
            expect_dev_role(&changed, false).await;
            identity.groups = vec!["Engineering".into()];
            sign_in(&changed, &identity, None).await.unwrap();
            expect_dev_role(&changed, true).await;
            identity.groups.clear();
            sign_in(&changed, &identity, None).await.unwrap();
            expect_dev_role(&changed, false).await;
        }
        // Group external IDs are opaque text. They can exceed a Postgres index entry.
        let external: String = (0..128)
            .map(|i| oidc_key(&format!("directory-part-{i}")).as_str().to_owned())
            .collect();
        let large = server.ask(Method::POST,"Groups",json!({"displayName":"Regional directory","externalId":external,"members":[member]}),201).await;
        assert_eq!(large["externalId"], external);
        let large_path = format!("Groups/{}", large["id"].as_str().unwrap());
        assert_eq!(
            server.ask(Method::GET, &large_path, Value::Null, 200).await["externalId"],
            external
        );
        server
            .ask(Method::DELETE, &large_path, Value::Null, 204)
            .await;
        drop(server);
        db.done(state).await;
    }
}

#[tokio::test]
async fn scim_startup_reconciles_claimants_before_their_first_grant() {
    for (state, db) in each_db("scim_startup_claimant").await {
        let mut state = configured(state, ScimDelete::Deactivate);
        let config = &mut Arc::get_mut(&mut state.sso).unwrap().config;
        config.scim.as_mut().unwrap().provider = Some("one".into());
        config.group_map.0.insert(
            "extra".into(),
            vec![crate::sso::config::GroupGrant {
                server: "eng".into(),
                role: Some("Dev".into()),
            }],
        );
        let server = Server::start(state.clone(), true).await;
        server
            .ask(Method::POST, "Users", json!({"userName":"alice"}), 201)
            .await;
        for stmt in [
            "INSERT INTO servers(name,display_name,password_hash,created_at) VALUES('eng','Engineering','protected',1)",
            "INSERT INTO roles(server,name,color) VALUES('eng','Dev','blue')",
            "INSERT INTO scim_groups(id,display_name,created_at,updated_at) VALUES('old','staff',1,1)",
            "INSERT INTO sso_user_groups(username,source,grp) VALUES('alice','one','staff'),('alice','one','extra')",
        ] {
            sqlx::query(stmt).execute(&state.db).await.unwrap();
        }
        let grants: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sso_grants WHERE username='alice'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(grants, 0);
        initialize_group_ownership(&state).await.unwrap();
        expect_dev_role(&state, true).await;
        assert_eq!(
            crate::sso::groups::effective_groups(&state.db, "alice")
                .await
                .unwrap(),
            std::collections::BTreeSet::from(["extra".into()])
        );
        drop(server);
        db.done(state).await;
    }
}
