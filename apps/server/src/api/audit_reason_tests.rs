use std::net::SocketAddr;

use axum::http::{HeaderValue, StatusCode};
use serde_json::{Value, json};
use sqlx::Row;

use crate::api::access::perms::Perm;
use crate::api::audit::{
    self, Action, Actor, Entry, REASON_INVALID, REASON_TOO_LONG, parse_reason,
};
use crate::api::test_util::{done, temp_state};
use crate::config::{AppConfig, Roles};
use crate::db::Db;
use crate::state::AppState;

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

struct Api {
    client: reqwest::Client,
    base: String,
}

impl Api {
    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        token: &str,
        reason: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut req = self
            .client
            .request(method, format!("{}/api/v1{path}", self.base))
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(body.to_string());
        if let Some(reason) = reason {
            req = req.header("X-Audit-Reason", reason);
        }
        let res = req.send().await.expect("send");
        let status = res.status();
        let bytes = res.bytes().await.expect("body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn register(&self, name: &str) -> String {
        let res = self
            .client
            .post(format!("{}/api/v1/auth/register", self.base))
            .header("content-type", "application/json")
            .body(
                json!({"username": name, "password": "pw", "avatar_kind": "identicon"}).to_string(),
            )
            .send()
            .await
            .expect("register");
        let body: Value = serde_json::from_slice(&res.bytes().await.expect("body")).expect("json");
        body["token"].as_str().expect("token").to_string()
    }
}

/// The details of the newest entry of `action`.
async fn details(db: &Db, action: &str) -> Value {
    let text: String =
        sqlx::query("SELECT details FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1")
            .bind(action)
            .fetch_one(db)
            .await
            .unwrap_or_else(|e| panic!("{action}: {e}"))
            .try_get(0)
            .expect("details");
    serde_json::from_str(&text).expect("json")
}

async fn member(db: &Db, name: &str) -> bool {
    sqlx::query("SELECT 1 FROM members WHERE server = 'club' AND username = $1")
        .bind(name)
        .fetch_optional(db)
        .await
        .expect("member")
        .is_some()
}

#[test]
fn a_reason_is_percent_decoded_trimmed_and_at_most_300_characters() {
    let read = |text: &str| parse_reason(Some(&HeaderValue::from_str(text).expect("header")));
    let refused = |text: &str| read(text).err().map(|e| e.1);
    assert_eq!(parse_reason(None).ok(), Some(None));
    assert_eq!(read("").ok(), Some(None));
    assert_eq!(read("%20%20").ok(), Some(None));
    let decoded = read("%20Spam%20links%20%E2%9C%85").ok().flatten();
    assert_eq!(
        decoded
            .as_ref()
            .map(|t| (t.starts_with("Spam links "), t.chars().count(), t.len())),
        Some((true, 12, 14))
    );
    assert_eq!(read("plain").ok(), Some(Some("plain".to_string())));
    let most = read(&"%C3%A9".repeat(300)).ok().flatten();
    assert_eq!(
        most.as_ref().map(|t| (t.chars().count(), t.len())),
        Some((300, 600))
    );
    assert_eq!(
        refused(&"%C3%A9".repeat(301)).as_deref(),
        Some(REASON_TOO_LONG)
    );
    assert_eq!(refused(&"a".repeat(301)).as_deref(), Some(REASON_TOO_LONG));
    assert_eq!(refused("%FF").as_deref(), Some(REASON_INVALID));
    assert_eq!(refused("line%0Abreak").as_deref(), Some(REASON_INVALID));
    let raw = HeaderValue::from_bytes(b"caf\xe9").expect("header");
    assert_eq!(
        parse_reason(Some(&raw)).err().map(|e| e.1).as_deref(),
        Some(REASON_INVALID)
    );
}

#[tokio::test]
async fn audit_entries_keep_the_reason_a_request_gives() {
    let (state, path) = temp_state("audit_reasons").await;
    let (addr, server) = serve(state.clone()).await;
    let api = Api {
        client: reqwest::Client::new(),
        base: format!("http://{addr}"),
    };
    let db = &state.db;
    api.register("root").await;
    let alice = api.register("alice").await;
    let mut tokens = Vec::new();
    for name in ["bob", "carol", "dave"] {
        tokens.push(api.register(name).await);
    }
    use reqwest::Method as M;
    let (status, _) = api
        .send(M::POST, "/servers", &alice, None, json!({"name": "club"}))
        .await;
    assert_eq!(status, StatusCode::OK);
    for token in &tokens {
        let (status, _) = api
            .send(M::POST, "/servers/club/join", token, None, json!({}))
            .await;
        assert_eq!(status, StatusCode::OK);
    }

    let kick = |name: &str| json!({ "username": name });
    let reason = Some("%20Spam%20links%2C%20again%20");
    let (status, _) = api
        .send(M::POST, "/servers/club/kick", &alice, reason, kick("bob"))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        details(db, "member.kick").await["reason"],
        json!("Spam links, again")
    );
    let (status, body) = api
        .send(
            M::POST,
            "/servers/club/kick",
            &alice,
            Some(&"a".repeat(301)),
            kick("carol"),
        )
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::BAD_REQUEST, json!(REASON_TOO_LONG))
    );
    let (status, body) = api
        .send(
            M::POST,
            "/servers/club/bans",
            &alice,
            Some("%FF"),
            kick("carol"),
        )
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::BAD_REQUEST, json!(REASON_INVALID))
    );
    assert!(
        member(db, "carol").await,
        "a refused reason changes nothing"
    );
    let (status, _) = api
        .send(M::POST, "/servers/club/kick", &alice, None, kick("carol"))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(details(db, "member.kick").await.get("reason").is_none());

    let (status, role) = api
        .send(
            M::POST,
            "/servers/club/roles",
            &alice,
            None,
            json!({"name": "Mods", "color": "#336699", "perms": 0}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let id = role["id"].as_i64().expect("id");
    let both = Perm::Kick as i64 | Perm::ManageRoles as i64;
    let patch = |perms: i64| json!({ "perms": perms, "mask": both });
    let (status, _) = api
        .send(
            M::PATCH,
            &format!("/servers/club/roles/{id}"),
            &alice,
            Some("Mods%20moderate"),
            patch(both),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let update = details(db, "role.update").await;
    assert_eq!(
        (update["perms_diff"].clone(), update["reason"].clone()),
        (
            json!({"added": ["Kick", "ManageRoles"], "removed": []}),
            json!("Mods moderate")
        )
    );
    let (status, _) = api
        .send(
            M::PATCH,
            &format!("/servers/club/roles/{id}"),
            &alice,
            None,
            patch(Perm::Kick as i64),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        details(db, "role.update").await["perms_diff"],
        json!({"added": [], "removed": ["ManageRoles"]})
    );

    let (status, _) = api
        .send(
            M::PUT,
            "/servers/club/timeouts/dave",
            &alice,
            Some("header"),
            json!({"seconds": 60, "reason": "body"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        details(db, "member.timeout").await["reason"],
        json!("body"),
        "an entry's own reason stays"
    );
    let (status, _) = api
        .send(
            M::DELETE,
            "/servers/club/timeouts/dave",
            &alice,
            Some("Calmer%20now"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let lifted = details(db, "member.untimeout").await;
    assert_eq!(
        (lifted["reason"].clone(), lifted["timeout_reason"].clone()),
        (json!("Calmer now"), json!("body"))
    );
    let (status, _) = api
        .send(
            M::PUT,
            "/servers/club/timeouts/dave",
            &alice,
            Some("flood"),
            json!({"seconds": 60}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        details(db, "member.timeout").await["reason"],
        json!("flood")
    );
    let mut tx = db.begin().await.expect("tx");
    audit::as_reason(
        Some("hello".to_string()),
        audit::record(
            &mut tx,
            Entry::new("club", &Actor::User("bob".to_string()), Action::MemberJoin),
        ),
    )
    .await
    .expect("record");
    tx.commit().await.expect("commit");
    assert!(
        details(db, "member.join").await.get("reason").is_none(),
        "a member's own joining keeps no reason"
    );
    let (status, _) = api
        .send(M::GET, "/servers/club", &alice, Some("%FF"), Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "reading ignores the header");

    let reactions = rchat_perms::registry::value("AddReactions") as i64;
    let (status, _) = api
        .send(
            M::PATCH,
            "/servers/club/everyone",
            &alice,
            Some("Quiet%20week"),
            json!({"perms": 0, "mask": reactions}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let everyone = details(db, "server.update").await;
    assert_eq!(
        (everyone["perms_diff"].clone(), everyone["reason"].clone()),
        (
            json!({"added": [], "removed": ["AddReactions"]}),
            json!("Quiet week")
        )
    );
    server.abort();
    done(state, path).await;
}
