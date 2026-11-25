use super::*;
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
