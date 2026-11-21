use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sqlx::Row;

use super::{Issuer, LENGTH, expiry, generate, reset};
use crate::api::admin::{
    AdminQuery, PurgeKind, finish_purge, hide_user_rows, list_users, overview,
};
use crate::api::admin_users::{OWN_PASSWORD, PASSWORDS_OFF, get_account, reset_password, sign_out};
use crate::api::auth::{LoginReq, SAME_AS_TEMPORARY, login_at};
use crate::api::join_modes::ALPHABET;
use crate::api::policy::TempChange;
use crate::api::reauth::{CHANGE_TEMPORARY, Purpose, ReAuth, Session, check_at};
use crate::api::test_util::{
    PHRASE_KEY, done, each_db, mem_user, phrase_sign, site_sets, temp_state,
};
use crate::api::{ApiError, Authed, CHANGE_FIRST, RESTRICTED_MAY, ReasonKind, Settings};
use crate::config::Roles;
use crate::db::{NewUser, get_user, now, secret_key, temp_password};
use crate::server::client_ip::{ClientIp, ProxyTrust};
use crate::state::AppState;
use crate::ws::WsEvent;

const T: i64 = 1_800_000_000;

#[test]
fn temporary_passwords_are_twenty_unambiguous_characters_in_groups_of_four() {
    let mut seen = std::collections::HashSet::new();
    for _ in 0..200 {
        let made = generate();
        let groups: Vec<&str> = made.split('-').collect();
        assert_eq!(groups.len(), LENGTH / 4, "{made}");
        assert!(groups.iter().all(|g| g.len() == 4), "{made}");
        assert!(
            made.bytes().all(|b| b == b'-' || ALPHABET.contains(&b)),
            "{made}"
        );
        assert!(seen.insert(made), "no two are the same");
    }
    for look_alike in b"01ilo" {
        assert!(!ALPHABET.contains(look_alike));
    }
    let bits = LENGTH as f64 * (ALPHABET.len() as f64).log2();
    assert!(bits >= 80.0, "{bits} bits");
}

#[test]
fn a_printed_temporary_password_is_hidden() {
    let issued = super::Issued {
        temp_password: "k7mq-x3ta-9fzc-w2hd-pn4e".to_string(),
        expires_at: Some(5),
    };
    let printed = format!("{issued:?} {:?}", Some(&issued));
    assert!(!printed.contains("k7mq"), "{printed}");
    assert!(printed.contains("<hidden>") && printed.contains("Some(5)"));
}

#[test]
fn a_lifetime_of_zero_hours_never_expires() {
    assert_eq!(expiry(0, 1000), None);
    assert_eq!(expiry(72, 1000), Some(1000 + 72 * 3600));
    assert_eq!(expiry(720, 0), Some(2_592_000));
}

async fn add(state: &AppState, name: &str, admin: bool) {
    NewUser::plain(name).admin(admin).at(1).add(&state.db).await;
}

async fn add_token(state: &AppState, name: &str, token: &str) {
    sqlx::query(
        "INSERT INTO tokens(token, username, created_at, last_used_at) VALUES($1, $2, $3, $3)",
    )
    .bind(secret_key(token))
    .bind(name)
    .bind(now())
    .execute(&state.db)
    .await
    .expect("token");
}

async fn sign_in(state: &AppState, name: &str, password: &str, t: i64) -> Result<String, ApiError> {
    let req: LoginReq =
        serde_json::from_value(json!({"username": name, "password": password})).expect("login");
    login_at(state, req, t).await.map(|Json(resp)| resp.token)
}

async fn count(state: &AppState, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(&state.db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("count")
}

fn says(e: ApiError) -> (StatusCode, String) {
    let ApiError(status, error, _) = e;
    (status, error)
}

async fn serve(state: &AppState) -> SocketAddr {
    let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
    let app = crate::api::routes(state.clone(), &Roles::ALL, ClientIp(trusted), None)
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    addr
}

/// One request as the client at `from`, with `{}` as the body of everything but a GET.
async fn ask(
    client: &reqwest::Client,
    addr: SocketAddr,
    from: u32,
    method: &str,
    path: &str,
    token: Option<&str>,
) -> (StatusCode, String) {
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).expect("method");
    let ip = std::net::Ipv4Addr::from(0x0b00_0000 + from);
    let mut req = client
        .request(method.clone(), format!("http://{addr}{path}"))
        .header("x-forwarded-for", ip.to_string());
    if method != reqwest::Method::GET {
        req = req.header("content-type", "application/json").body("{}");
    }
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    let res = req.send().await.expect("request");
    let status = res.status();
    (status, res.text().await.unwrap_or_default())
}

fn error_of(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
}

/// The path of a route pattern with a value in each parameter.
fn filled(pattern: &str) -> String {
    pattern
        .split('/')
        .map(|part| match part.strip_prefix('{') {
            Some(param) => match param.trim_end_matches('}').trim_start_matches('*') {
                "name" => "rchat",
                "username" => "dana",
                "ik" | "code" | "token" | "kind" => "x",
                _ => "1",
            },
            None => part,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[tokio::test]
async fn a_session_that_must_change_its_password_reaches_only_its_own_account() {
    let (state, path) = temp_state("temp_route_walk").await;
    add(&state, "dana", false).await;
    add(&state, "norma", false).await;
    let issued = reset(&state.db, "dana", Issuer::Cli, 72, now())
        .await
        .expect("reset");
    assert_eq!(
        Settings::load(&state.db).await.password_change,
        TempChange::Required
    );
    let addr = serve(&state).await;
    let client = reqwest::Client::new();
    let routes: Vec<(String, String)> = crate::api::openapi::tests::registered_routes()
        .into_iter()
        .filter_map(|(method, path)| {
            path.strip_prefix("/api/v1")
                .map(|rest| (method.to_uppercase(), rest.to_string()))
        })
        .filter(|(_, path)| path != "/ws")
        .collect();
    assert!(routes.len() > 200, "{} routes", routes.len());
    let mut refused = 0;
    let mut wrong = Vec::new();
    for (n, (method, pattern)) in routes.iter().enumerate() {
        let n = n as u32;
        let path = filled(pattern);
        let held = format!("dana-{n}");
        add_token(&state, "dana", &held).await;
        let anon = ask(&client, addr, 3 * n, method, &path, None).await;
        let (status, body) = ask(&client, addr, 3 * n + 1, method, &path, Some(&held)).await;
        let stopped =
            status == StatusCode::FORBIDDEN && error_of(&body).as_deref() == Some(CHANGE_FIRST);
        let may = RESTRICTED_MAY.contains(&(method.as_str(), pattern.as_str()));
        match (may, stopped) {
            (true, true) => wrong.push(format!("{method} {pattern}: refused, but it is allowed")),
            (true, false) => {}
            (false, true) => refused += 1,
            (false, false) if anon.0 == status && anon.0 != StatusCode::UNAUTHORIZED => {}
            (false, false) => wrong.push(format!(
                "{method} {pattern}: {status} {body} (without a session: {} {})",
                anon.0, anon.1
            )),
        }
        if method == "GET" {
            let open = format!("norma-{n}");
            add_token(&state, "norma", &open).await;
            let (_, body) = ask(&client, addr, 3 * n + 2, method, &path, Some(&open)).await;
            if error_of(&body).as_deref() == Some(CHANGE_FIRST) {
                wrong.push(format!("{method} {pattern}: refuses an ordinary session"));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    assert!(refused > 150, "only {refused} routes refused the session");
    for (method, path) in RESTRICTED_MAY {
        assert!(
            routes.contains(&(method.to_string(), path.to_string())),
            "{method} {path} is a route"
        );
    }
    add_token(&state, "dana", "dana-me").await;
    let (status, body) = ask(&client, addr, 900_001, "GET", "/me", Some("dana-me")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let me: Value = serde_json::from_str(&body).expect("me");
    assert_eq!(
        me["password_temporary"],
        json!({"expires_at": issued.expires_at, "change": "required"})
    );
    let cookie = client
        .get(format!("http://{addr}/media/1"))
        .header("x-forwarded-for", "12.0.0.1")
        .header("cookie", "rchat_token=dana-me")
        .send()
        .await
        .expect("media");
    assert_eq!(cookie.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        error_of(&cookie.text().await.expect("body")).as_deref(),
        Some(CHANGE_FIRST),
        "a session in a cookie is held to the same rule"
    );
    let (status, body) = ask(
        &client,
        addr,
        900_002,
        "GET",
        "/servers/rchat",
        Some("dana-me"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let refusal: Value = serde_json::from_str(&body).expect("refusal");
    assert_eq!(
        refusal,
        json!({"error": CHANGE_FIRST, "reason": {"kind": "off_account", "control": "password_change"}})
    );
    done(state, path).await;
}

#[tokio::test]
async fn the_rule_holds_under_the_api_prefixes() {
    let (state, path) = temp_state("temp_prefixes").await;
    add(&state, "dana", false).await;
    reset(&state.db, "dana", Issuer::Cli, 72, now())
        .await
        .expect("reset");
    add_token(&state, "dana", "dana-token").await;
    let config = crate::config::AppConfig::from_map(&[] as &[(&str, &str)]).expect("config");
    let app = crate::server::route_builder::resolve_versions(
        crate::server::route_builder::api_router(&config, state.clone()),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    let client = reqwest::Client::new();
    for (path, allowed) in [
        ("/api/v1/me", true),
        ("/api/me", true),
        ("/api/v1/me/servers", false),
        ("/api/me/servers", false),
        ("/api/v1/servers/rchat", false),
        ("/api/v1/dms", false),
    ] {
        let (status, body) = ask(&client, addr, 1, "GET", path, Some("dana-token")).await;
        match allowed {
            true => assert_eq!(status, StatusCode::OK, "{path}: {body}"),
            false => assert_eq!(
                (status, error_of(&body).as_deref()),
                (StatusCode::FORBIDDEN, Some(CHANGE_FIRST)),
                "{path}"
            ),
        }
    }
    let (status, _) = ask(
        &client,
        addr,
        2,
        "POST",
        "/api/v1/auth/logout",
        Some("dana-token"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "signing out is always possible");
    done(state, path).await;
}

#[tokio::test]
async fn a_temporary_password_signs_in_until_it_expires() {
    for (state, db) in each_db("temp_expiry").await {
        add(&state, "dana", false).await;
        let issued = reset(&state.db, "dana", Issuer::Cli, 2, T)
            .await
            .expect("reset");
        assert_eq!(issued.expires_at, Some(T + 7200));
        let token = sign_in(&state, "dana", &issued.temp_password, T + 10)
            .await
            .expect("signs in while it is valid");
        assert!(!token.is_empty());
        let wrong = sign_in(&state, "dana", "k7mq-x3ta-9fzc-w2hd-aaaa", T + 20)
            .await
            .map_err(says);
        let late = sign_in(&state, "dana", &issued.temp_password, T + 7200)
            .await
            .map_err(says);
        assert_eq!(late, wrong, "an expired one fails like a wrong one");
        assert_eq!(
            late,
            Err((StatusCode::UNAUTHORIZED, "Invalid credentials".to_string()))
        );
        let forever = reset(&state.db, "dana", Issuer::Cli, 0, T)
            .await
            .expect("reset");
        assert_eq!(forever.expires_at, None);
        assert_eq!(
            sign_in(&state, "dana", &issued.temp_password, T + 7300)
                .await
                .map_err(says),
            wrong,
            "a replaced temporary password is a wrong password"
        );
        sign_in(&state, "dana", &forever.temp_password, T + 40_000_000)
            .await
            .expect("no expiry");
        let stored: String = sqlx::query("SELECT password_hash FROM users WHERE username = 'dana'")
            .fetch_one(&state.db)
            .await
            .expect("hash")
            .try_get(0)
            .expect("hash");
        assert!(stored.starts_with("$argon2"), "only a hash is stored");
        assert_eq!(
            count(
                &state,
                &format!(
                    "SELECT COUNT(*) FROM instance_audit WHERE detail LIKE '%{}%' OR detail LIKE '%{}%'",
                    issued.temp_password, forever.temp_password
                )
            )
            .await,
            0,
            "the log never holds a temporary password"
        );
        db.done(state).await;
    }
}

async fn status_of(
    state: &AppState,
    addr: SocketAddr,
    from: u32,
    token: &str,
) -> (StatusCode, String) {
    let _ = state;
    ask(
        &reqwest::Client::new(),
        addr,
        from,
        "GET",
        "/me/servers",
        Some(token),
    )
    .await
}

#[tokio::test]
async fn an_encouraged_session_works_until_the_setting_or_the_clock_stops_it() {
    let (state, path) = temp_state("temp_encouraged").await;
    add(&state, "dana", false).await;
    site_sets(&state, json!({"password_change": "encouraged"})).await;
    let issued = reset(&state.db, "dana", Issuer::Cli, 72, now())
        .await
        .expect("reset");
    let token = sign_in(&state, "dana", &issued.temp_password, now())
        .await
        .expect("sign in");
    let addr = serve(&state).await;
    let (status, body) = status_of(&state, addr, 1, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let me = ask(&reqwest::Client::new(), addr, 2, "GET", "/me", Some(&token)).await;
    let me: Value = serde_json::from_str(&me.1).expect("me");
    assert_eq!(me["password_temporary"]["change"], "encouraged");
    site_sets(&state, json!({"password_change": "required"})).await;
    let (status, body) = status_of(&state, addr, 3, &token).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(error_of(&body).as_deref(), Some(CHANGE_FIRST));
    site_sets(&state, json!({"password_change": "encouraged"})).await;
    assert_eq!(status_of(&state, addr, 4, &token).await.0, StatusCode::OK);
    sqlx::query("UPDATE temp_passwords SET expires_at = $1 WHERE username = 'dana'")
        .bind(now() - 1)
        .execute(&state.db)
        .await
        .expect("expire");
    let (status, body) = status_of(&state, addr, 5, &token).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let me = ask(&reqwest::Client::new(), addr, 6, "GET", "/me", Some(&token)).await;
    assert_eq!(me.0, StatusCode::OK);
    let me: Value = serde_json::from_str(&me.1).expect("me");
    assert_eq!(
        me["password_temporary"]["change"], "required",
        "an expired temporary password must be changed whatever the setting says"
    );
    let changed = reqwest::Client::new()
        .post(format!("http://{addr}/me/password"))
        .header("x-forwarded-for", "12.0.0.9")
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(json!({"current": {"password": issued.temp_password}, "new": {"password": "my own words"}}).to_string())
        .send()
        .await
        .expect("change");
    assert_eq!(
        changed.status(),
        StatusCode::OK,
        "the session proved it while it was valid"
    );
    assert_eq!(status_of(&state, addr, 7, &token).await.0, StatusCode::OK);
    let me = ask(&reqwest::Client::new(), addr, 8, "GET", "/me", Some(&token)).await;
    let me: Value = serde_json::from_str(&me.1).expect("me");
    assert_eq!(me["password_temporary"], Value::Null);
    done(state, path).await;
}

#[tokio::test]
async fn choosing_a_password_ends_the_temporary_one() {
    for (state, db) in each_db("temp_change").await {
        add(&state, "root", true).await;
        add(&state, "dana", false).await;
        let issued = reset(&state.db, "dana", Issuer::Account("root"), 72, now())
            .await
            .expect("reset");
        let token = sign_in(&state, "dana", &issued.temp_password, now())
            .await
            .expect("sign in");
        let addr = serve(&state).await;
        let change = |from: u32, current: String, new: &'static str| {
            let token = token.clone();
            async move {
                let res = reqwest::Client::new()
                    .post(format!("http://{addr}/me/password"))
                    .header("x-forwarded-for", format!("12.0.1.{from}"))
                    .bearer_auth(token)
                    .header("content-type", "application/json")
                    .body(
                        json!({"current": {"password": current}, "new": {"password": new}})
                            .to_string(),
                    )
                    .send()
                    .await
                    .expect("change");
                let status = res.status();
                let body = res.text().await.expect("body");
                (status, serde_json::from_str::<Value>(&body).expect("json"))
            }
        };
        let same: &'static str = Box::leak(issued.temp_password.clone().into_boxed_str());
        let (status, body) = change(1, issued.temp_password.clone(), same).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            json!({"error": SAME_AS_TEMPORARY, "reason": {"kind": "invalid", "field": "new"}})
        );
        assert!(
            temp_password(&state.db, "dana")
                .await
                .expect("mark")
                .is_some()
        );
        sqlx::query("UPDATE change_attempts SET last_at = last_at - 10")
            .execute(&state.db)
            .await
            .expect("rewind");
        let (status, body) = change(2, issued.temp_password.clone(), "a password of my own").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(temp_password(&state.db, "dana").await.expect("mark"), None);
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM instance_audit WHERE action = 'user.password_set' AND actor = 'dana' AND target = 'dana'").await,
            1,
            "the log shows the account is in use"
        );
        assert_eq!(
            sign_in(&state, "dana", &issued.temp_password, T)
                .await
                .map_err(says),
            Err((StatusCode::UNAUTHORIZED, "Invalid credentials".to_string())),
            "the temporary password is gone for good"
        );
        sign_in(&state, "dana", "a password of my own", T + 10)
            .await
            .expect("the new password");
        sqlx::query("UPDATE change_attempts SET last_at = last_at - 10")
            .execute(&state.db)
            .await
            .expect("rewind");
        let (status, _) = change(3, "a password of my own".to_string(), "another one").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM instance_audit WHERE action = 'user.password_set'"
            )
            .await,
            1,
            "an ordinary change is not logged"
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn a_recovery_ends_the_temporary_password() {
    let (state, path) = temp_state("temp_recovery").await;
    NewUser::plain("alice")
        .at(1)
        .add_recoverable(&state.db, Some(PHRASE_KEY), Some(5))
        .await;
    reset(&state.db, "alice", Issuer::Cli, 72, T)
        .await
        .expect("reset");
    assert!(
        temp_password(&state.db, "alice")
            .await
            .expect("mark")
            .is_some()
    );
    let challenge = crate::api::recovery::challenge_at(
        &state,
        serde_json::from_value(json!({"username": "alice"})).expect("challenge"),
        T,
    )
    .await
    .expect("challenge");
    let nonce = serde_json::to_value(&challenge.0).expect("json")["nonce"]
        .as_str()
        .expect("nonce")
        .to_string();
    let sig = phrase_sign("recover", "alice", &nonce, "");
    let resp = crate::api::recovery::recover_at(
        &state,
        serde_json::from_value(json!({"username": "alice", "nonce": nonce, "sig": sig, "new": {"password": "mine again"}})).expect("recover"),
        T + 5,
    )
    .await
    .expect("recover");
    assert_eq!(temp_password(&state.db, "alice").await.expect("mark"), None);
    assert!(resp.0.user.password_temporary.is_none());
    done(state, path).await;
}

#[tokio::test]
async fn a_reset_replaces_the_password_and_ends_every_session() {
    for (state, db) in each_db("temp_reset").await {
        add(&state, "root", true).await;
        add(&state, "bob", false).await;
        add(&state, "dana", false).await;
        add_token(&state, "dana", "phone").await;
        add_token(&state, "dana", "laptop").await;
        add_token(&state, "bob", "bob-token").await;
        sqlx::query("UPDATE users SET recovery_pub = $1, recovery_set_at = 5, password_kind = 'words' WHERE username = 'dana'")
            .bind(PHRASE_KEY)
            .execute(&state.db)
            .await
            .expect("phrase");
        let root = || Authed(mem_user("root", true));
        let mut rx = state.hub.subscribe();
        let before = now();
        let Json(issued) = reset_password(State(state.clone()), root(), Path("Dana".to_string()))
            .await
            .expect("reset");
        assert!(
            matches!(rx.try_recv(), Ok(WsEvent::TokensRevoked { username }) if username == "dana")
        );
        let expires = issued.expires_at.expect("72 hours by default");
        assert!((before + 72 * 3600..=now() + 72 * 3600).contains(&expires));
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM tokens WHERE username = 'dana'"
            )
            .await,
            0
        );
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM tokens WHERE username = 'bob'").await,
            1
        );
        let dana = get_user(&state.db, "dana")
            .await
            .expect("load")
            .expect("dana");
        assert_eq!(dana.password_kind, "text");
        assert_eq!(
            dana.recovery_pub.as_deref(),
            Some(PHRASE_KEY),
            "the phrase stays"
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM temp_passwords WHERE username = 'dana' AND issued_by = 'root'"
            )
            .await,
            1
        );
        assert_eq!(
            count(&state, &format!("SELECT COUNT(*) FROM instance_audit WHERE action = 'user.temp_password' AND actor = 'root' AND target = 'dana' AND detail = '{{\"expires_at\":{expires}}}'")).await,
            1
        );
        sign_in(&state, "dana", &issued.temp_password, now())
            .await
            .expect("the temporary password signs in");
        site_sets(&state, json!({"temp_password_hours": 0})).await;
        let Json(second) = reset_password(State(state.clone()), root(), Path("dana".to_string()))
            .await
            .expect("second reset");
        assert_eq!(second.expires_at, None);
        assert_ne!(second.temp_password, issued.temp_password);
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM temp_passwords").await,
            1
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM tokens WHERE username = 'dana'"
            )
            .await,
            0
        );

        let own = reset_password(State(state.clone()), root(), Path("ROOT".to_string()))
            .await
            .map(|_| ())
            .map_err(says);
        assert_eq!(
            own,
            Err((StatusCode::BAD_REQUEST, OWN_PASSWORD.to_string()))
        );
        let missing = reset_password(State(state.clone()), root(), Path("nobody".to_string()))
            .await
            .map(|_| ())
            .map_err(says);
        assert_eq!(
            missing,
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        let plain = reset_password(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path("dana".to_string()),
        )
        .await
        .map(|_| ())
        .map_err(says);
        assert_eq!(
            plain, missing,
            "anyone else gets the answer of a missing page"
        );
        site_sets(&state, json!({"password_login": false})).await;
        let Err(ApiError(status, error, reason)) =
            reset_password(State(state.clone()), root(), Path("dana".to_string())).await
        else {
            panic!("issued a password nobody can use");
        };
        assert_eq!(
            (status, error.as_str()),
            (StatusCode::BAD_REQUEST, PASSWORDS_OFF)
        );
        let reason = reason.expect("reason");
        assert_eq!(
            (reason.kind, reason.control.as_deref()),
            (ReasonKind::OffSite, Some("password_login"))
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn signing_an_account_out_ends_its_sessions_only() {
    let (state, path) = temp_state("temp_sign_out").await;
    add(&state, "root", true).await;
    add(&state, "bob", false).await;
    add(&state, "dana", false).await;
    add_token(&state, "dana", "phone").await;
    add_token(&state, "dana", "laptop").await;
    add_token(&state, "bob", "bob-token").await;
    let mut rx = state.hub.subscribe();
    let _ = sign_out(
        State(state.clone()),
        Authed(mem_user("root", true)),
        Path("Dana".to_string()),
    )
    .await
    .expect("sign out");
    assert!(matches!(rx.try_recv(), Ok(WsEvent::TokensRevoked { username }) if username == "dana"));
    assert_eq!(
        count(
            &state,
            "SELECT COUNT(*) FROM tokens WHERE username = 'dana'"
        )
        .await,
        0
    );
    assert_eq!(
        count(&state, "SELECT COUNT(*) FROM tokens WHERE username = 'bob'").await,
        1
    );
    assert_eq!(
        count(&state, "SELECT COUNT(*) FROM instance_audit WHERE action = 'user.sign_out' AND actor = 'root' AND target = 'dana' AND detail = '{\"sessions\":2}'").await,
        1
    );
    for (who, target) in [
        (mem_user("bob", false), "dana"),
        (mem_user("root", true), "ghost"),
    ] {
        let refused = sign_out(State(state.clone()), Authed(who), Path(target.to_string()))
            .await
            .map(|_| ())
            .map_err(says);
        assert_eq!(
            refused,
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
    }
    done(state, path).await;
}

#[tokio::test]
async fn a_temporary_password_confirms_nothing() {
    let (state, path) = temp_state("temp_reauth").await;
    add(&state, "dana", false).await;
    let issued = reset(&state.db, "dana", Issuer::Cli, 72, T)
        .await
        .expect("reset");
    site_sets(&state, json!({"password_change": "encouraged"})).await;
    add_token(&state, "dana", "tok").await;
    let (user, created_at) = crate::api::session_for_token(&state, "tok")
        .await
        .expect("lookup")
        .expect("an encouraged session is open");
    assert!(user.temp.is_some());
    let session = Session {
        user,
        token: "tok".to_string(),
        created_at,
    };
    for confirm in [
        ReAuth::Password(issued.temp_password.clone()),
        ReAuth::FreshSession,
    ] {
        let refused = check_at(&state, &session, confirm, Purpose::RemovePhrase, now())
            .await
            .map_err(says);
        assert_eq!(
            refused,
            Err((StatusCode::UNAUTHORIZED, CHANGE_TEMPORARY.to_string()))
        );
    }
    assert_eq!(
        count(&state, "SELECT COUNT(*) FROM change_attempts").await,
        0,
        "refused before any attempt is counted"
    );
    site_sets(&state, json!({"password_change": "required"})).await;
    let Err(ApiError(status, error, _)) = crate::api::session_for_token(&state, "tok").await else {
        panic!("a restricted session was handed out");
    };
    assert_eq!(
        (status, error.as_str()),
        (StatusCode::FORBIDDEN, CHANGE_FIRST)
    );
    done(state, path).await;
}

#[tokio::test]
async fn the_account_list_filters_by_temporary_passwords() {
    for (state, db) in each_db("temp_filter").await {
        add(&state, "root", true).await;
        for name in ["amy", "ben", "cat"] {
            add(&state, name, false).await;
        }
        reset(&state.db, "amy", Issuer::Cli, 72, now())
            .await
            .expect("amy");
        reset(&state.db, "ben", Issuer::Cli, 1, now() - 7200)
            .await
            .expect("ben");
        add_token(&state, "amy", "amy-token").await;
        let root = || Authed(mem_user("root", true));
        let names = |filter: Option<&'static str>| {
            let state = state.clone();
            async move {
                let query: AdminQuery =
                    serde_json::from_value(json!({"filter": filter})).expect("query");
                list_users(State(state), root(), Query(query))
                    .await
                    .map(|page| page.0.into_iter().map(|u| u.username).collect::<Vec<_>>())
                    .map_err(says)
            }
        };
        assert_eq!(
            names(None).await.expect("all"),
            ["amy", "ben", "cat", "root"]
        );
        assert_eq!(
            names(Some("temporary")).await.expect("temporary"),
            ["amy", "ben"]
        );
        assert_eq!(names(Some("expired")).await.expect("expired"), ["ben"]);
        assert_eq!(
            names(Some("old")).await,
            Err((
                StatusCode::BAD_REQUEST,
                "filter: expected temporary or expired".to_string()
            ))
        );
        let Json(seen) = overview(State(state.clone()), root())
            .await
            .expect("overview");
        assert_eq!(seen.temporary_count, 2);
        let Json(amy) = get_account(State(state.clone()), root(), Path("Amy".to_string()))
            .await
            .expect("amy");
        let amy = serde_json::to_value(&amy).expect("json");
        assert_eq!(amy["user"]["username"], "amy");
        assert_eq!(amy["sign_in"], "text");
        assert_eq!(amy["temporary"]["expired"], false);
        assert_eq!(
            (&amy["sessions"], &amy["servers"], &amy["phrase"]),
            (&json!(1), &json!(0), &json!(false))
        );
        assert_eq!(amy["created_at"], 1);
        assert!(amy.get("is_site_admin").is_none());
        let Json(ben) = get_account(State(state.clone()), root(), Path("ben".to_string()))
            .await
            .expect("ben");
        assert!(ben.temporary.expect("temporary").expired);
        let Json(cat) = get_account(State(state.clone()), root(), Path("cat".to_string()))
            .await
            .expect("cat");
        assert!(cat.temporary.is_none());
        let own = serde_json::to_value(
            get_account(State(state.clone()), root(), Path("root".to_string()))
                .await
                .expect("root")
                .0,
        )
        .expect("json");
        assert_eq!(
            own.as_object().expect("object").keys().collect::<Vec<_>>(),
            amy.as_object().expect("object").keys().collect::<Vec<_>>(),
            "every account has the same fields"
        );
        for (who, target) in [
            (mem_user("amy", false), "ben"),
            (mem_user("root", true), "ghost"),
        ] {
            let refused = get_account(State(state.clone()), Authed(who), Path(target.to_string()))
                .await
                .map(|_| ())
                .map_err(says);
            assert_eq!(
                refused,
                Err((StatusCode::NOT_FOUND, "Not found".to_string()))
            );
        }
        db.done(state).await;
    }
}

#[tokio::test]
async fn a_deleted_account_leaves_no_temporary_password_behind() {
    let (state, path) = temp_state("temp_purge").await;
    add(&state, "root", true).await;
    add(&state, "dana", false).await;
    add(&state, "eve", false).await;
    reset(&state.db, "dana", Issuer::Account("eve"), 72, T)
        .await
        .expect("dana");
    reset(&state.db, "eve", Issuer::Account("root"), 72, T)
        .await
        .expect("eve");
    hide_user_rows(&state, "eve", PurgeKind::User)
        .await
        .expect("hide");
    finish_purge(&state, PurgeKind::User, "eve")
        .await
        .expect("purge");
    assert_eq!(
        count(
            &state,
            "SELECT COUNT(*) FROM temp_passwords WHERE username = 'eve'"
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &state,
            "SELECT COUNT(*) FROM temp_passwords WHERE username = 'dana' AND issued_by IS NULL"
        )
        .await,
        1,
        "a new account named eve issued nothing"
    );
    done(state, path).await;
}

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn dial(addr: SocketAddr, token: &str) -> Client {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("dial");
    let frame = json!({ "type": "auth", "token": token }).to_string();
    ws.send(tokio_tungstenite::tungstenite::Message::text(frame))
        .await
        .expect("auth");
    ws
}

/// The close code and reason the socket gets within `wait`, or `None` while it stays open.
async fn closed_with(ws: &mut Client, wait: Duration) -> Option<(u16, String)> {
    use tokio_tungstenite::tungstenite::Message as M;
    let until = tokio::time::Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(until, ws.next()).await {
            Err(_) => return None,
            Ok(Some(Ok(M::Close(frame)))) => {
                return Some(frame.map_or((1005, String::new()), |f| {
                    (f.code.into(), f.reason.to_string())
                }));
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_)) | None) => return Some((1006, String::new())),
        }
    }
}

#[tokio::test]
async fn sockets_of_sessions_that_must_change_their_password_close() {
    let (state, path): (AppState, PathBuf) = temp_state("temp_socket").await;
    add(&state, "dana", false).await;
    add(&state, "norma", false).await;
    reset(&state.db, "dana", Issuer::Cli, 72, now())
        .await
        .expect("reset");
    add_token(&state, "dana", "dana-token").await;
    add_token(&state, "norma", "norma-token").await;
    let addr = serve(&state).await;
    let ceiling = Duration::from_secs(30);
    let mut refused = dial(addr, "dana-token").await;
    assert_eq!(
        closed_with(&mut refused, ceiling).await,
        Some((4403, "password_change".to_string()))
    );
    site_sets(&state, json!({"password_change": "encouraged"})).await;
    let mut dana = dial(addr, "dana-token").await;
    let mut norma = dial(addr, "norma-token").await;
    assert_eq!(
        closed_with(&mut dana, Duration::from_millis(300)).await,
        None
    );
    site_sets(&state, json!({"password_change": "required"})).await;
    assert_eq!(
        closed_with(&mut dana, ceiling).await,
        Some((4403, "password_change".to_string())),
        "the open socket closes when the change becomes required"
    );
    assert_eq!(
        closed_with(&mut norma, Duration::from_millis(300)).await,
        None
    );
    let mut again = dial(addr, "dana-token").await;
    assert_eq!(
        closed_with(&mut again, ceiling).await,
        Some((4403, "password_change".to_string()))
    );
    site_sets(&state, json!({"password_change": "encouraged"})).await;
    sqlx::query("UPDATE temp_passwords SET expires_at = $1 WHERE username = 'dana'")
        .bind(now() + 2)
        .execute(&state.db)
        .await
        .expect("set expiry");
    let mut expiring = dial(addr, "dana-token").await;
    assert_eq!(
        closed_with(&mut expiring, Duration::from_millis(100)).await,
        None
    );
    assert_eq!(
        closed_with(&mut expiring, ceiling).await,
        Some((4403, "password_change".to_string()))
    );
    done(state, path).await;
}
