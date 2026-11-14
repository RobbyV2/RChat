use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sqlx::Row;
use utoipa::OpenApi;

use super::*;
use crate::api::auth::{AuthResp, change_password, hash_password, login_at, patch_me, register};
use crate::api::budget::as_client;
use crate::api::config_shares::create_share;
use crate::api::instance::{Peer, p2p_binding};
use crate::api::p2p_backup::{PutError, put_backup};
use crate::api::p2p_identity::put_identity;
use crate::api::passwords::create_password;
use crate::api::reauth::{AuthedSession, Session};
use crate::api::recovery::{challenge, recover, remove_phrase, set_phrase};
use crate::api::servers::{create_server, delete_server, server_available, update_server};
use crate::api::test_util::{PHRASE_KEY, done, mem_user, temp_state};
use crate::api::webhooks::{
    create_outgoing, create_webhook, reset_secret, reset_token, test_outgoing,
};
use crate::api::{Authed, Reason, ReasonKind, Settings, user_for_token};
use crate::db::{Db, NewUser, get_user, now, pool_key, secret_key};
use crate::limits::Limits;

static CLOCKS: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(Default::default);

/// The time of the rare requests for the database of `state`. It starts at the first request
/// and moves only with `pass`, so no answer depends on how long a test takes.
pub(crate) fn clock(state: &AppState) -> Instant {
    match CLOCKS.lock() {
        Ok(mut clocks) => *clocks
            .entry(pool_key(&state.db))
            .or_insert_with(Instant::now),
        Err(_) => Instant::now(),
    }
}

/// Moves the clock of the rare requests forward by `by` for the database of `state`.
pub(crate) fn pass(state: &AppState, by: Duration) {
    if let Ok(mut clocks) = CLOCKS.lock() {
        *clocks
            .entry(pool_key(&state.db))
            .or_insert_with(Instant::now) += by;
    }
}

/// `state` without limits on rare requests, for tests of other rules that make many of them.
pub(crate) fn unlimited(state: AppState) -> AppState {
    let limits = Limits {
        rare_requests_per_hour: 0,
        rare_requests_per_day: 0,
        ..(*state.limits).clone()
    };
    state.with_limits(Arc::new(limits))
}

fn limited(state: AppState, per_hour: u32, per_day: u32) -> AppState {
    state.with_limits(Arc::new(Limits {
        rare_requests_per_hour: per_hour,
        rare_requests_per_day: per_day,
        ..Limits::default()
    }))
}

/// What a request answered: refused as a rare request, with the seconds to wait, or anything
/// else.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Answer {
    Refused(u64),
    Answered(StatusCode),
}

fn answer<T>(res: Result<T, ApiError>) -> Answer {
    match res {
        Ok(_) => Answer::Answered(StatusCode::OK),
        Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            text,
            Some(Reason {
                kind: ReasonKind::Rate,
                control: None,
                retry_after: Some(wait),
                field: None,
            }),
        )) if text == TOO_OFTEN => Answer::Refused(wait),
        Err(ApiError(code, _, _)) => Answer::Answered(code),
    }
}

fn refused(answer: &Answer) -> bool {
    matches!(answer, Answer::Refused(_))
}

/// Whether a request was answered and keeps its count. A refusal by another limit or for
/// capacity gives the count back.
fn kept(answer: &Answer) -> bool {
    match answer {
        Answer::Refused(_) => false,
        Answer::Answered(code) => !matches!(
            *code,
            StatusCode::LOCKED | StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
        ),
    }
}

fn body<T: DeserializeOwned>(value: Value) -> Json<T> {
    Json(serde_json::from_value(value).expect("body"))
}

fn uploaded(res: Result<impl Sized, PutError>) -> Result<(), ApiError> {
    match res {
        Ok(_) => Ok(()),
        Err(PutError::Stale(_)) => Err(ApiError(StatusCode::CONFLICT, String::new(), None)),
        Err(PutError::Other(e)) => Err(e),
    }
}

fn ip(text: &str) -> IpAddr {
    text.parse().expect("ip")
}

fn key_of(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn ik(seed: u8) -> String {
    URL_SAFE_NO_PAD.encode(key_of(seed).verifying_key().to_bytes())
}

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .expect(sql);
}

async fn id(db: &Db, sql: &str, binds: &[&str]) -> i64 {
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()));
    for value in binds {
        query = query.bind(*value);
    }
    query
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("id")
}

/// The server `server` of `owner`, its only member and admin, with a `general` channel.
async fn own_server(db: &Db, owner: &str, server: &str) -> i64 {
    id(
        db,
        "INSERT INTO servers(name, display_name, creator, member_count, created_at) VALUES($1, $1, $2, 1, 0) RETURNING created_at",
        &[server, owner],
    )
    .await;
    id(
        db,
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES($1, $2, 1, 0, 0) RETURNING joined_at",
        &[server, owner],
    )
    .await;
    id(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES($1, 'general', 0) RETURNING id",
        &[server],
    )
    .await
}

async fn hooks_of(db: &Db, owner: &str, server: &str, channel: i64) -> (i64, i64) {
    let incoming = sqlx::query("INSERT INTO webhooks(server, channel_id, name, token_hash, creator, created_at) VALUES($1, $2, 'Hook', 'x', $3, 0) RETURNING id")
        .bind(server)
        .bind(channel)
        .bind(owner)
        .fetch_one(db)
        .await
        .expect("webhook")
        .try_get(0)
        .expect("id");
    let outgoing = id(
        db,
        "INSERT INTO outgoing_webhooks(server, name, url, events, secret, creator, created_at) VALUES($1, 'Out', 'https://198.51.100.7/hook', 'message.created', 'whsec_test', $2, 0) RETURNING id",
        &[server, owner],
    )
    .await;
    (incoming, outgoing)
}

async fn quiet(db: &Db) {
    exec(
        db,
        "UPDATE settings SET value = '0' WHERE key = 'profanity_filter'",
    )
    .await;
    exec(
        db,
        "UPDATE settings SET value = '1' WHERE key = 'outgoing_webhooks'",
    )
    .await;
    Settings::forget(db);
}

/// One rare request of each operation the class lists.
#[derive(Clone, Copy, Debug)]
enum Route {
    DisplayName,
    SignUp,
    Password,
    SetPhrase,
    RemovePhrase,
    Challenge,
    Recover,
    NameCheck,
    Rename,
    NewServer,
    DeleteServer,
    NewPassword,
    NewPermanent,
    NewWebhook,
    WebhookToken,
    NewOutgoing,
    OutgoingSecret,
    OutgoingTest,
    ConfigLink,
    P2pBackup,
    P2pIdentity,
    P2pBinding,
}

impl Route {
    const ALL: [Route; 22] = [
        Route::DisplayName,
        Route::SignUp,
        Route::Password,
        Route::SetPhrase,
        Route::RemovePhrase,
        Route::Challenge,
        Route::Recover,
        Route::NameCheck,
        Route::Rename,
        Route::NewServer,
        Route::DeleteServer,
        Route::NewPassword,
        Route::NewPermanent,
        Route::NewWebhook,
        Route::WebhookToken,
        Route::NewOutgoing,
        Route::OutgoingSecret,
        Route::OutgoingTest,
        Route::ConfigLink,
        Route::P2pBackup,
        Route::P2pIdentity,
        Route::P2pBinding,
    ];

    /// The kind it counts as, and its method and path in the API document.
    fn of(self) -> (Rare, &'static str, &'static str) {
        match self {
            Route::DisplayName => (Rare::DisplayName, "patch", "/api/v1/me"),
            Route::SignUp => (Rare::SignUp, "post", "/api/v1/auth/register"),
            Route::Password => (Rare::Password, "post", "/api/v1/me/password"),
            Route::SetPhrase => (Rare::Phrase, "put", "/api/v1/me/recovery"),
            Route::RemovePhrase => (Rare::Phrase, "delete", "/api/v1/me/recovery"),
            Route::Challenge => (Rare::Recovery, "post", "/api/v1/auth/recovery/challenge"),
            Route::Recover => (Rare::Recovery, "post", "/api/v1/auth/recovery"),
            Route::NameCheck => (Rare::ServerName, "get", "/api/v1/servers/{name}/available"),
            Route::Rename => (Rare::ServerName, "patch", "/api/v1/servers/{name}"),
            Route::NewServer => (Rare::NewServer, "post", "/api/v1/servers"),
            Route::DeleteServer => (Rare::DeletedServer, "delete", "/api/v1/servers/{name}"),
            Route::NewPassword => (
                Rare::ServerPassword,
                "post",
                "/api/v1/servers/{name}/passwords",
            ),
            Route::NewPermanent => (Rare::ServerPassword, "patch", "/api/v1/servers/{name}"),
            Route::NewWebhook => (Rare::Webhook, "post", "/api/v1/servers/{name}/webhooks"),
            Route::WebhookToken => (
                Rare::Webhook,
                "post",
                "/api/v1/servers/{name}/webhooks/{id}/token",
            ),
            Route::NewOutgoing => (
                Rare::Webhook,
                "post",
                "/api/v1/servers/{name}/outgoing_webhooks",
            ),
            Route::OutgoingSecret => (
                Rare::Webhook,
                "post",
                "/api/v1/servers/{name}/outgoing_webhooks/{id}/secret",
            ),
            Route::OutgoingTest => (
                Rare::Webhook,
                "post",
                "/api/v1/servers/{name}/outgoing_webhooks/{id}/test",
            ),
            Route::ConfigLink => (Rare::ConfigLink, "post", "/api/v1/config_shares"),
            Route::P2pBackup => (Rare::P2pBackup, "put", "/api/v1/me/p2p_backup/{ik}"),
            Route::P2pIdentity => (Rare::P2pIdentity, "put", "/api/v1/me/p2p_identity/{ik}"),
            Route::P2pBinding => (Rare::P2pBinding, "post", "/api/v1/identity/p2p_binding"),
        }
    }

    /// Makes the `n`th request of this route as actor `i`: the account `u{i}` with its server
    /// `s{i}`, or the client address 198.18.0.`i` when it is signed out. A request paced by its
    /// session or by the username it names has its own for every `n`, so none waits for the one
    /// before it.
    async fn call(self, w: &World, i: usize, n: usize) -> Answer {
        let state = || State(w.state.clone());
        let who = format!("u{i}");
        let me = || Authed(mem_user(&who, false));
        let server = format!("s{i}");
        let place = &w.places[i];
        let address = ip(&format!("198.18.0.{i}"));
        match self {
            Route::DisplayName => answer(
                patch_me(
                    state(),
                    me(),
                    body(json!({ "display_name": format!("Name {n}") })),
                )
                .await,
            ),
            Route::SignUp => answer(
                as_client(
                    address,
                    register(
                        state(),
                        body(json!({
                            "username": format!("new{i}x{n}"),
                            "password": "pw",
                            "avatar_kind": "identicon",
                        })),
                    ),
                )
                .await,
            ),
            Route::Password => answer(
                change_password(
                    state(),
                    Authed(w.user(&who).await),
                    bearer(&format!("tok-{who}-{n}")),
                    body(json!({
                        "current": { "password": "pw" },
                        "new": { "password": "pw" },
                    })),
                )
                .await,
            ),
            Route::SetPhrase => answer(
                set_phrase(
                    state(),
                    w.session(&who, n).await,
                    body(json!({ "key": PHRASE_KEY, "reauth": { "password": "pw" } })),
                )
                .await,
            ),
            Route::RemovePhrase => answer(
                remove_phrase(
                    state(),
                    w.session(&who, n).await,
                    body(json!({ "reauth": { "password": "pw" } })),
                )
                .await,
            ),
            Route::Challenge => answer(
                as_client(
                    address,
                    challenge(state(), body(json!({ "username": "alice" }))),
                )
                .await,
            ),
            Route::Recover => answer(
                as_client(
                    address,
                    recover(
                        state(),
                        body(json!({
                            "username": format!("alice{n}"),
                            "nonce": "x",
                            "sig": "y",
                            "new": { "password": "pw" },
                        })),
                    ),
                )
                .await,
            ),
            Route::NameCheck => {
                answer(server_available(state(), me(), Path(format!("free{i}x{n}"))).await)
            }
            Route::Rename => answer(
                update_server(
                    state(),
                    me(),
                    Path(server),
                    body(json!({ "name": "taken" })),
                )
                .await,
            ),
            Route::NewServer => answer(
                create_server(
                    state(),
                    me(),
                    body(json!({ "name": format!("made{i}x{n}") })),
                )
                .await,
            ),
            Route::DeleteServer => {
                answer(delete_server(state(), me(), Path(format!("{server}x{n}"))).await)
            }
            Route::NewPassword => {
                answer(create_password(state(), me(), Path(server), body(json!({}))).await)
            }
            Route::NewPermanent => answer(
                update_server(
                    state(),
                    me(),
                    Path(server),
                    body(json!({ "password": format!("a long password {n}") })),
                )
                .await,
            ),
            Route::NewWebhook => answer(
                create_webhook(
                    state(),
                    me(),
                    Path(server),
                    body(json!({ "channel_id": place.channel, "name": format!("Hook {n}") })),
                )
                .await,
            ),
            Route::WebhookToken => {
                answer(reset_token(state(), me(), Path((server, place.incoming))).await)
            }
            Route::NewOutgoing => answer(
                create_outgoing(
                    state(),
                    me(),
                    Path(server),
                    body(json!({
                        "name": format!("Out {n}"),
                        "url": "https://198.51.100.7/hook",
                        "events": ["message.created"],
                    })),
                )
                .await,
            ),
            Route::OutgoingSecret => {
                answer(reset_secret(state(), me(), Path((server, place.outgoing)), None).await)
            }
            Route::OutgoingTest => {
                answer(test_outgoing(state(), me(), Path((server, place.outgoing))).await)
            }
            Route::ConfigLink => answer(
                create_share(
                    state(),
                    me(),
                    body(json!({ "blob": "rc1.abc", "expires_in": 600 })),
                )
                .await,
            ),
            Route::P2pBackup => answer(uploaded(
                put_backup(
                    state(),
                    Authed(w.user(&who).await),
                    Path(ik(i as u8 + 1)),
                    Query(serde_json::from_value(json!({ "version": 1 })).expect("params")),
                    HeaderMap::new(),
                    Body::from(vec![1u8, 2, 3]),
                )
                .await,
            )),
            Route::P2pIdentity => answer(
                put_identity(
                    state(),
                    w.session(&who, n).await,
                    Path(ik(i as u8 + 1)),
                    Body::from("{}"),
                )
                .await,
            ),
            Route::P2pBinding => answer(
                p2p_binding(
                    state(),
                    me(),
                    Peer(None),
                    HeaderMap::new(),
                    body(json!({ "ik": "nope", "ts": 0, "proof": "x" })),
                )
                .await,
            ),
        }
    }
}

struct Place {
    channel: i64,
    incoming: i64,
    outgoing: i64,
}

struct World {
    state: AppState,
    path: PathBuf,
    places: Vec<Place>,
}

impl World {
    /// The account `who` as stored now.
    async fn user(&self, who: &str) -> User {
        get_user(&self.state.db, who)
            .await
            .expect("load")
            .expect(who)
    }

    /// The `n`th session of `who`, with its own pace.
    async fn session(&self, who: &str, n: usize) -> AuthedSession {
        let token = format!("tok-{who}-{n}");
        signed_in(&self.state.db, who, &token).await;
        AuthedSession(Session {
            user: self.user(who).await,
            token,
            created_at: 0,
        })
    }
}

async fn signed_in(db: &Db, who: &str, token: &str) {
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, 0)")
        .bind(secret_key(token))
        .bind(who)
        .execute(db)
        .await
        .expect("token");
}

/// An account `u{i}` with the password `pw` and a password-protected server `s{i}` and two
/// webhooks for every route, six more servers `s{i}x{n}` to delete, and a server named `taken`.
async fn world(tag: &str, per_hour: u32, per_day: u32) -> World {
    let (state, path) = temp_state(tag).await;
    let state = limited(state, per_hour, per_day);
    let db = &state.db;
    quiet(db).await;
    let hash = hash_password("pw").await.expect("hash");
    let mut places = Vec::new();
    for i in 0..Route::ALL.len() {
        let (who, server) = (format!("u{i}"), format!("s{i}"));
        NewUser::plain(&who).hash(&hash).at(1).add(db).await;
        let channel = own_server(db, &who, &server).await;
        for n in 0..6 {
            own_server(db, &who, &format!("{server}x{n}")).await;
        }
        let (incoming, outgoing) = hooks_of(db, &who, &server, channel).await;
        places.push(Place {
            channel,
            incoming,
            outgoing,
        });
    }
    exec(db, "UPDATE servers SET password_hash = 'set'").await;
    own_server(db, "u0", "taken").await;
    World {
        state,
        path,
        places,
    }
}

#[test]
fn every_listed_operation_is_tested_and_kinds_have_their_own_names() {
    let mut listed: Vec<(&str, &str, &str)> = Rare::ALL
        .into_iter()
        .flat_map(|kind| {
            kind.routes()
                .iter()
                .map(move |(method, path)| (kind.name(), *method, *path))
        })
        .collect();
    let mut tested: Vec<(&str, &str, &str)> = Route::ALL
        .into_iter()
        .map(|route| {
            let (kind, method, path) = route.of();
            (kind.name(), method, path)
        })
        .collect();
    listed.sort();
    tested.sort();
    assert_eq!(tested, listed);
    let mut names: Vec<&str> = Rare::ALL.into_iter().map(Rare::name).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), Rare::ALL.len());
}

#[test]
fn the_api_document_names_the_limits_on_every_rare_operation_and_nowhere_else() {
    let doc = serde_json::to_value(crate::api::openapi::ApiDoc::openapi()).expect("json");
    let mut listed: Vec<(&str, &str)> = Rare::ALL
        .into_iter()
        .flat_map(|kind| kind.routes().iter().copied())
        .collect();
    listed.sort();
    listed.dedup();
    let mut seen = Vec::new();
    for (path, item) in doc["paths"].as_object().expect("paths") {
        for (method, op) in item.as_object().expect("item") {
            if !["get", "post", "put", "patch", "delete"].contains(&method.as_str()) {
                continue;
            }
            let text = op["description"].as_str().unwrap_or_default();
            let rare = listed.contains(&(method.as_str(), path.as_str()));
            assert_eq!(
                text.contains("RARE_REQUESTS_PER_HOUR") && text.contains("RARE_REQUESTS_PER_DAY"),
                rare,
                "{method} {path}: {text}"
            );
            if rare {
                let refused = &op["responses"]["429"];
                let said = refused["description"].as_str().unwrap_or_default();
                assert!(said.contains(TOO_OFTEN), "{method} {path}: {said}");
                assert!(
                    refused["content"].get("application/json").is_some(),
                    "{method} {path}: the refusal is JSON"
                );
                seen.push((method.clone(), path.clone()));
            }
        }
    }
    assert_eq!(seen.len(), listed.len(), "{seen:?}");
}

#[tokio::test]
async fn every_rare_operation_is_refused_past_its_limits_and_answers_after_them() {
    let w = world("rare_routes", 2, 3).await;
    let each = |n: usize| {
        let w = &w;
        async move {
            let mut answers = Vec::new();
            for (i, route) in Route::ALL.into_iter().enumerate() {
                answers.push((route, route.call(w, i, n).await));
            }
            answers
        }
    };
    for n in 0..2 {
        for (route, answer) in each(n).await {
            assert!(kept(&answer), "{route:?} {n}: {answer:?}");
        }
    }
    for (route, answer) in each(2).await {
        assert_eq!(answer, Answer::Refused(3600), "{route:?} past 2 an hour");
    }
    pass(&w.state, HOUR);
    for (route, answer) in each(3).await {
        assert!(kept(&answer), "{route:?} in the next hour: {answer:?}");
    }
    for (route, answer) in each(4).await {
        assert_eq!(answer, Answer::Refused(82_800), "{route:?} past 3 a day");
    }
    pass(&w.state, DAY);
    for (route, answer) in each(5).await {
        assert!(kept(&answer), "{route:?} the next day: {answer:?}");
    }
    done(w.state, w.path).await;
}

#[tokio::test]
async fn the_operations_of_one_kind_share_its_count() {
    let w = world("rare_kinds", 2, 0).await;
    for kind in Rare::ALL {
        let routes: Vec<(usize, Route)> = Route::ALL
            .into_iter()
            .enumerate()
            .filter(|(_, route)| route.of().0 == kind)
            .collect();
        if routes.len() < 2 {
            continue;
        }
        let actor = routes[0].0;
        for (n, (_, route)) in routes.iter().take(2).enumerate() {
            let answer = route.call(&w, actor, n).await;
            assert!(!refused(&answer), "{kind:?} {route:?}: {answer:?}");
        }
        for (n, (_, route)) in routes.iter().enumerate() {
            let answer = route.call(&w, actor, n + 2).await;
            assert!(refused(&answer), "{kind:?} {route:?} shares: {answer:?}");
        }
        let answer = Route::DisplayName.call(&w, actor, 9).await;
        assert!(
            !refused(&answer),
            "{kind:?}: another kind counts apart: {answer:?}"
        );
    }
    done(w.state, w.path).await;
}

async fn named(state: &AppState, user: &crate::db::User, name: &str) -> Answer {
    answer(
        patch_me(
            State(state.clone()),
            Authed(user.clone()),
            body(json!({ "display_name": name })),
        )
        .await,
    )
}

async fn sign_up(state: &AppState, from: &str, name: &str) -> Answer {
    answer(
        as_client(
            ip(from),
            register(
                State(state.clone()),
                body(json!({ "username": name, "password": "pw", "avatar_kind": "identicon" })),
            ),
        )
        .await,
    )
}

async fn challenged(state: &AppState, from: &str, name: &str) -> Answer {
    answer(
        as_client(
            ip(from),
            challenge(State(state.clone()), body(json!({ "username": name }))),
        )
        .await,
    )
}

#[tokio::test]
async fn spellings_sessions_and_addresses_share_counts_and_accounts_do_not() {
    let (state, path) = temp_state("rare_who").await;
    let state = limited(state, 3, 0);
    let db = &state.db;
    quiet(db).await;
    let hash = hash_password("pw").await.expect("hash");
    NewUser::plain("alice")
        .shown("Alice")
        .hash(&hash)
        .at(1)
        .add(db)
        .await;
    NewUser::plain("bob").at(1).add(db).await;
    let t = now();
    let mut sessions = Vec::new();
    for (n, typed) in ["ALICE", "alice", "Alice"].into_iter().enumerate() {
        let Json(AuthResp { token, .. }) = login_at(
            &state,
            serde_json::from_value(json!({ "username": typed, "password": "pw" })).expect("login"),
            t + 10 * n as i64,
        )
        .await
        .expect(typed);
        let user = user_for_token(&state, &token)
            .await
            .expect("lookup")
            .expect("session");
        assert_eq!(user.username, "alice", "{typed}");
        sessions.push(user);
    }
    let ok = Answer::Answered(StatusCode::OK);
    let taken = Answer::Answered(StatusCode::BAD_REQUEST);
    assert_eq!(named(&state, &sessions[0], "Bob").await, taken);
    assert_eq!(named(&state, &sessions[1], "B0B").await, taken);
    assert_eq!(named(&state, &sessions[2], "Zed").await, ok);
    for (n, name) in ["Ann", "bob", "b\u{43e}b"].into_iter().enumerate() {
        assert!(
            refused(&named(&state, &sessions[n], name).await),
            "taken and free names get the same refusal, from any session: {name}"
        );
    }
    for name in ["Zed", "ALICE", "alice"] {
        let now = get_user(db, "alice").await.expect("load").expect("alice");
        assert_eq!(
            named(&state, &now, name).await,
            ok,
            "the current name and the own username are never counted: {name}"
        );
    }
    let bob = get_user(db, "bob").await.expect("load").expect("bob");
    assert_eq!(named(&state, &bob, "Bobby").await, ok, "bob counts apart");

    for name in ["carol", "Dave", "erin"] {
        assert_eq!(sign_up(&state, "192.0.2.1", name).await, ok, "{name}");
    }
    for name in ["frank", "ALICE", "b0b"] {
        assert!(
            refused(&sign_up(&state, "192.0.2.1", name).await),
            "one address, whatever the name: {name}"
        );
    }
    assert_eq!(sign_up(&state, "192.0.2.2", "frank").await, ok);
    for name in ["gail", "hank", "ivy"] {
        assert_eq!(sign_up(&state, "2001:db8:1:2::1", name).await, ok, "{name}");
    }
    assert!(
        refused(&sign_up(&state, "2001:db8:1:2:ffff::9", "jo").await),
        "one /64 is one address"
    );

    for name in ["alice", "bob", "ghost"] {
        assert_eq!(challenged(&state, "198.51.100.1", name).await, ok, "{name}");
    }
    assert!(refused(&challenged(&state, "198.51.100.1", "Alice").await));
    assert_eq!(
        challenged(&state, "198.51.100.2", "alice").await,
        ok,
        "another address may still recover alice"
    );
    done(state, path).await;
}

async fn new_password(state: &AppState, token: &str, current: &str, new: &str) -> Answer {
    let user = get_user(&state.db, "owen")
        .await
        .expect("load")
        .expect("owen");
    answer(
        change_password(
            State(state.clone()),
            Authed(user),
            bearer(token),
            body(json!({ "current": { "password": current }, "new": { "password": new } })),
        )
        .await,
    )
}

async fn new_phrase(state: &AppState, token: &str, set: bool, password: &str) -> Answer {
    let user = get_user(&state.db, "owen")
        .await
        .expect("load")
        .expect("owen");
    let session = AuthedSession(Session {
        user,
        token: token.to_string(),
        created_at: 0,
    });
    let reauth = json!({ "password": password });
    match set {
        true => answer(
            set_phrase(
                State(state.clone()),
                session,
                body(json!({ "key": PHRASE_KEY, "reauth": reauth })),
            )
            .await,
        ),
        false => answer(
            remove_phrase(
                State(state.clone()),
                session,
                body(json!({ "reauth": reauth })),
            )
            .await,
        ),
    }
}

#[tokio::test]
async fn only_confirmed_password_and_phrase_changes_count_and_wrong_tries_use_up_nothing() {
    let (state, path) = temp_state("rare_reauth").await;
    let state = limited(state, 3, 0);
    let db = &state.db;
    let hash = hash_password("pw").await.expect("hash");
    NewUser::plain("owen").hash(&hash).at(1).add(db).await;
    let ok = Answer::Answered(StatusCode::OK);
    let wrong = Answer::Answered(StatusCode::UNAUTHORIZED);
    signed_in(db, "owen", "stolen").await;
    for n in 0..6 {
        let got = new_password(&state, "stolen", "guess", "mine").await;
        assert!(!refused(&got), "a wrong or paced password try {n}: {got:?}");
        let got = new_phrase(&state, "stolen", n % 2 == 0, "guess").await;
        assert!(!refused(&got), "a wrong or paced phrase try {n}: {got:?}");
    }
    for n in 0..4 {
        let token = format!("stolen-{n}");
        signed_in(db, "owen", &token).await;
        assert_eq!(new_password(&state, &token, "guess", "mine").await, wrong);
        let token = format!("stolen-phrase-{n}");
        signed_in(db, "owen", &token).await;
        assert_eq!(new_phrase(&state, &token, n % 2 == 0, "guess").await, wrong);
    }
    for (n, (current, new)) in [("pw", "pw1"), ("pw1", "pw2"), ("pw2", "pw3")]
        .into_iter()
        .enumerate()
    {
        let token = format!("own-{n}");
        assert_eq!(
            new_password(&state, &token, current, new).await,
            ok,
            "the owner's change {n}"
        );
    }
    assert!(
        refused(&new_password(&state, "own-3", "pw3", "pw4").await),
        "the fourth change"
    );
    assert!(
        refused(&new_password(&state, "own-4", "guess", "pw4").await),
        "a wrong try past the limit gets the same refusal"
    );
    assert!(
        refused(&new_password(&state, "own-2", "pw3", "pw4").await),
        "so does a try the pace would refuse"
    );
    for (n, set) in [true, false, true].into_iter().enumerate() {
        let token = format!("own-phrase-{n}");
        signed_in(db, "owen", &token).await;
        assert_eq!(
            new_phrase(&state, &token, set, "pw3").await,
            ok,
            "the owner's phrase {n}"
        );
    }
    signed_in(db, "owen", "own-phrase-3").await;
    assert!(refused(
        &new_phrase(&state, "own-phrase-3", false, "pw3").await
    ));
    assert!(refused(
        &new_phrase(&state, "own-phrase-3", true, "guess").await
    ));
    let owen = get_user(db, "owen").await.expect("load").expect("owen");
    assert!(
        owen.recovery_pub.is_some(),
        "the refused removal changed nothing"
    );
    done(state, path).await;
}

#[tokio::test]
async fn refusals_by_other_limits_and_for_capacity_give_the_count_back() {
    let (state, path) = temp_state("rare_given_back").await;
    let state = limited(state, 3, 0);
    let db = &state.db;
    quiet(db).await;
    let day = now() / 86400;
    for (name, count, last_at) in [("paced", 1, now() + 1000), ("locked", 1001, 0)] {
        for row in crate::api::names::pace_keys(None, name) {
            exec(
                db,
                &format!(
                    "INSERT INTO login_attempts(username, day, count, last_at) VALUES('{row}', '{day}', {count}, {last_at})"
                ),
            )
            .await;
        }
    }
    let from = "198.51.100.9";
    let recovered = |name: &'static str| {
        as_client(
            ip(from),
            recover(
                State(state.clone()),
                body(json!({
                    "username": name,
                    "nonce": "x",
                    "sig": "y",
                    "new": { "password": "pw" },
                })),
            ),
        )
    };
    for _ in 0..5 {
        assert_eq!(
            answer(recovered("paced").await),
            Answer::Answered(StatusCode::TOO_MANY_REQUESTS),
            "the pace of the username"
        );
        assert_eq!(
            answer(recovered("locked").await),
            Answer::Answered(StatusCode::LOCKED),
            "the daily lock of the username"
        );
    }
    for name in ["bob", "carol", "dave"] {
        assert_eq!(
            answer(recovered(name).await),
            Answer::Answered(StatusCode::UNAUTHORIZED),
            "{name}"
        );
    }
    assert!(refused(&answer(recovered("erin").await)));

    NewUser::plain("uma").at(1).add(db).await;
    let uma = get_user(db, "uma").await.expect("load").expect("uma");
    let upload = |version: i64| {
        put_backup(
            State(state.clone()),
            Authed(uma.clone()),
            Path(ik(9)),
            Query(serde_json::from_value(json!({ "version": version })).expect("params")),
            HeaderMap::new(),
            Body::from(vec![1u8, 2, 3]),
        )
    };
    let busy: Vec<_> = (0..3)
        .map(|_| crate::api::media::reading_slot(db, "uma").expect("slot"))
        .collect();
    for _ in 0..5 {
        assert_eq!(
            answer(uploaded(upload(1).await)),
            Answer::Answered(StatusCode::TOO_MANY_REQUESTS),
            "too many uploads at once"
        );
    }
    drop(busy);
    for version in 1..=3 {
        assert_eq!(
            answer(uploaded(upload(version).await)),
            Answer::Answered(StatusCode::OK)
        );
    }
    assert!(refused(&answer(uploaded(upload(4).await))));

    let make = |name: &'static str| {
        create_server(
            State(state.clone()),
            Authed(mem_user("uma", false)),
            body(json!({ "name": name })),
        )
    };
    own_server(db, "uma", "taken").await;
    for n in 0..3 {
        let got = answer(make("taken").await);
        assert!(
            matches!(got, Answer::Answered(code) if code.is_client_error() && code != StatusCode::TOO_MANY_REQUESTS),
            "a taken name {n}: {got:?}"
        );
    }
    assert!(
        refused(&answer(make("fresh").await)),
        "a taken name counts like a free one"
    );
    done(state, path).await;
}

#[tokio::test]
async fn a_held_request_is_given_back_only_for_refusals_by_other_limits_and_capacity() {
    let (state, path) = temp_state("rare_held").await;
    let state = limited(state, 1, 0);
    let alice = mem_user("alice", false);
    let error = |status: StatusCode| ApiError(status, String::new(), None);
    for _ in 0..5 {
        check(&state, Rare::DisplayName, Some(&alice)).expect("a check counts nothing");
    }
    take(&state, Rare::DisplayName, Some(&alice)).expect("taken");
    assert!(refused(&answer(check(
        &state,
        Rare::DisplayName,
        Some(&alice)
    ))));
    for status in [
        StatusCode::LOCKED,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let held = hold(&state, Rare::Webhook, Some(&alice)).expect("held");
        assert!(
            refused(&answer(take(&state, Rare::Webhook, Some(&alice)))),
            "{status}: held while it runs"
        );
        assert!(counted(held, Err::<(), _>(error(status))).is_err());
    }
    drop(hold(&state, Rare::Webhook, Some(&alice)).expect("dropped before an answer"));
    for (kind, status) in [
        (Rare::Webhook, None),
        (Rare::ConfigLink, Some(StatusCode::BAD_REQUEST)),
        (Rare::NewServer, Some(StatusCode::CONFLICT)),
        (Rare::Phrase, Some(StatusCode::UNAUTHORIZED)),
        (Rare::Password, Some(StatusCode::INTERNAL_SERVER_ERROR)),
    ] {
        hold(&state, kind, Some(&alice))
            .expect("held")
            .answered(status.map(error).as_ref());
        assert!(
            refused(&answer(take(&state, kind, Some(&alice)))),
            "{kind:?} {status:?} keeps it"
        );
    }
    done(state, path).await;
}

#[tokio::test]
async fn server_passwords_refused_by_their_checks_do_not_count() {
    let (state, path) = temp_state("rare_tickets").await;
    let state = limited(state, 3, 0);
    let db = &state.db;
    quiet(db).await;
    NewUser::plain("uma").at(1).add(db).await;
    own_server(db, "uma", "home").await;
    exec(db, "UPDATE servers SET password_hash = 'set'").await;
    let ticket = |uses: i64| {
        create_password(
            State(state.clone()),
            Authed(mem_user("uma", false)),
            Path("home".to_string()),
            body(json!({ "max_uses": uses })),
        )
    };
    let permanent = |password: &'static str| {
        update_server(
            State(state.clone()),
            Authed(mem_user("uma", false)),
            Path("home".to_string()),
            body(json!({ "password": password })),
        )
    };
    let wrong = Answer::Answered(StatusCode::BAD_REQUEST);
    for _ in 0..5 {
        assert_eq!(answer(ticket(0).await), wrong, "uses out of range");
        assert_eq!(answer(permanent("abc").await), wrong, "too weak");
    }
    for _ in 0..2 {
        assert_eq!(answer(ticket(1).await), Answer::Answered(StatusCode::OK));
    }
    assert_eq!(
        answer(permanent("a long new password").await),
        Answer::Answered(StatusCode::OK)
    );
    assert!(refused(&answer(ticket(1).await)));
    assert!(
        refused(&answer(permanent("abc").await)),
        "past the limit every request gets the same refusal"
    );
    done(state, path).await;
}

#[tokio::test]
async fn zero_turns_a_limit_off_and_a_refusal_never_says_to_wait_less_than_needed() {
    let (state, path) = temp_state("rare_limits").await;
    let alice = mem_user("alice", false);
    let off = limited(state.clone(), 0, 0);
    for n in 0..200 {
        assert!(take(&off, Rare::DisplayName, Some(&alice)).is_ok(), "{n}");
    }
    let daily = limited(state.clone(), 0, 5);
    let hourly = limited(state.clone(), 5, 0);
    for (state, kind) in [(&daily, Rare::Password), (&hourly, Rare::Phrase)] {
        for n in 0..5 {
            assert!(take(state, kind, Some(&alice)).is_ok(), "{kind:?} {n}");
        }
    }
    pass(&state, Duration::from_secs(600));
    let wait = |res| match answer(res) {
        Answer::Refused(wait) => wait,
        other => panic!("not refused: {other:?}"),
    };
    assert_eq!(
        wait(take(&daily, Rare::Password, Some(&alice))),
        86_400 - 600,
        "the day"
    );
    assert_eq!(
        wait(take(&hourly, Rare::Phrase, Some(&alice))),
        3600 - 600,
        "the hour"
    );
    let one = limited(state.clone(), 1, 0);
    let bob = mem_user("bob", false);
    for kind in Rare::ALL {
        assert!(
            take(&one, kind, Some(&bob)).is_ok(),
            "{kind:?}: the other kinds left it alone"
        );
    }
    for kind in Rare::ALL {
        assert!(refused(&answer(take(&one, kind, Some(&bob)))), "{kind:?}");
    }
    done(state, path).await;
}

#[tokio::test]
async fn a_refusal_says_rate_and_how_long_to_wait_over_http() {
    let (state, path) = temp_state("rare_http").await;
    let state = limited(state, 1, 0);
    NewUser::plain("alice").at(1).add(&state.db).await;
    NewUser::plain("bob").at(1).add(&state.db).await;
    own_server(&state.db, "bob", "taken").await;
    signed_in(&state.db, "alice", "tok").await;
    let config = crate::config::AppConfig::defaults();
    let app = crate::server::route_builder::api_router(&config, state.clone());
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
    let client = reqwest::Client::new();
    let mut seen = Vec::new();
    for name in ["free", "taken", "other"] {
        let res = client
            .get(format!("http://{addr}/api/v1/servers/{name}/available"))
            .header(
                header::AUTHORIZATION,
                HeaderValue::from_static("Bearer tok"),
            )
            .send()
            .await
            .expect("request");
        let code = res.status();
        let wait = res
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        let body: Value = serde_json::from_str(&res.text().await.expect("body")).expect("json");
        seen.push((code, wait, body));
    }
    server.abort();
    assert_eq!(
        seen[0],
        (StatusCode::OK, None, json!({ "available": true }))
    );
    for (code, wait, body) in &seen[1..] {
        let wait = wait.expect("Retry-After");
        assert_eq!(*code, StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert!((3590..=3600).contains(&wait), "{wait}");
        assert_eq!(
            *body,
            json!({ "error": TOO_OFTEN, "reason": { "kind": "rate", "retry_after": wait } }),
            "a taken and a free name get the same refusal"
        );
    }
    done(state, path).await;
}

/// The steps of a day, each with its answer.
#[derive(Default)]
struct Day(Vec<(String, Answer)>);

impl Day {
    fn note<T>(&mut self, step: &str, res: Result<T, ApiError>) -> Answer {
        let got = answer(res);
        self.0.push((step.to_string(), got));
        got
    }

    fn ok<T>(&mut self, step: &str, res: Result<T, ApiError>) {
        let got = self.note(step, res);
        assert_eq!(got, Answer::Answered(StatusCode::OK), "{step}");
    }
}

fn bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).expect("header"),
    );
    headers
}

#[tokio::test]
async fn an_ordinary_day_never_meets_the_limits() {
    let (state, path) = temp_state("rare_day").await;
    let db = &state.db;
    quiet(db).await;
    let st = || State(state.clone());
    let user =
        |name: &'static str| async move { get_user(db, name).await.expect("load").expect(name) };
    let mut day = Day::default();
    let home = ip("192.0.2.10");
    let mut tokens = HashMap::new();
    for name in ["Alice", "Bob", "Carol", "Dave"] {
        let made = as_client(
            home,
            register(
                st(),
                body(json!({
                    "username": name,
                    "password": format!("pw of {name}"),
                    "avatar_kind": "identicon",
                })),
            ),
        )
        .await;
        let token = match &made {
            Ok(Json(resp)) => resp.token.clone(),
            Err(e) => panic!("{name} signs up: {e:?}"),
        };
        tokens.insert(name.to_lowercase(), token);
        day.ok("sign-up", made);
    }
    for name in ["Bob", "B0b"] {
        let res = patch_me(
            st(),
            Authed(user("alice").await),
            body(json!({ "display_name": name })),
        );
        let got = day.note("a taken display name", res.await);
        assert_eq!(got, Answer::Answered(StatusCode::BAD_REQUEST), "{name}");
    }
    for name in ["Bobbie", "Alice K"] {
        let res = patch_me(
            st(),
            Authed(user("alice").await),
            body(json!({ "display_name": name })),
        );
        day.ok("a display name", res.await);
    }
    let session = Session {
        user: user("alice").await,
        token: tokens["alice"].clone(),
        created_at: now(),
    };
    let res = set_phrase(
        st(),
        AuthedSession(session),
        body(json!({ "key": PHRASE_KEY, "reauth": { "password": "pw of Alice" } })),
    );
    day.ok("a backup phrase", res.await);
    let res = change_password(
        st(),
        Authed(user("alice").await),
        bearer("a mistyped session"),
        body(json!({ "current": { "password": "pw of Alce" }, "new": { "password": "next" } })),
    );
    let got = day.note("a mistyped password", res.await);
    assert_eq!(got, Answer::Answered(StatusCode::UNAUTHORIZED));
    let Json(AuthResp { token: phone, .. }) = login_at(
        &state,
        serde_json::from_value(json!({ "username": "alice", "password": "pw of Alice" }))
            .expect("login"),
        now(),
    )
    .await
    .expect("a second device");
    let res = change_password(
        st(),
        Authed(user("alice").await),
        bearer(&phone),
        body(json!({ "current": { "password": "pw of Alice" }, "new": { "password": "next" } })),
    );
    day.ok("a new password", res.await);
    pass(&state, HOUR);

    for (typed, name) in [
        (["ga", "gamin", "gaming-c"], "gaming-club"),
        (["bo", "book", "book-n"], "book-nook"),
    ] {
        for text in typed.into_iter().chain([name]) {
            let res = server_available(st(), Authed(user("alice").await), Path(text.to_string()));
            day.ok("a name check while typing", res.await);
        }
        let res = create_server(
            st(),
            Authed(user("alice").await),
            body(json!({ "name": name })),
        );
        day.ok("a new server", res.await);
    }
    let res = update_server(
        st(),
        Authed(user("alice").await),
        Path("gaming-club".to_string()),
        body(json!({ "password": "a long club password" })),
    );
    day.ok("a server password", res.await);
    for n in 0..5 {
        let res = create_password(
            st(),
            Authed(user("alice").await),
            Path("gaming-club".to_string()),
            body(json!({ "label": format!("Friend {n}"), "max_uses": 1 })),
        );
        day.ok("a ticket", res.await);
    }
    pass(&state, 3 * HOUR);

    let channel = id(
        db,
        "SELECT id FROM channels WHERE server = $1 AND name = 'general'",
        &["gaming-club"],
    )
    .await;
    let res = create_webhook(
        st(),
        Authed(user("alice").await),
        Path("gaming-club".to_string()),
        body(json!({ "channel_id": channel, "name": "Club news" })),
    );
    day.ok("a webhook", res.await);
    let res = create_outgoing(
        st(),
        Authed(user("alice").await),
        Path("gaming-club".to_string()),
        body(json!({
            "name": "Bot",
            "url": "https://198.51.100.7/hook",
            "events": ["message.created"],
        })),
    );
    day.note("an outgoing webhook", res.await);
    let (_, outgoing) = hooks_of(db, "alice", "gaming-club", channel).await;
    for _ in 0..3 {
        let res = test_outgoing(
            st(),
            Authed(user("alice").await),
            Path(("gaming-club".to_string(), outgoing)),
        );
        day.ok("a test event", res.await);
    }
    let res = reset_secret(
        st(),
        Authed(user("alice").await),
        Path(("gaming-club".to_string(), outgoing)),
        None,
    );
    day.ok("a new secret", res.await);
    for text in ["book-c", "book-corner"] {
        let res = server_available(st(), Authed(user("alice").await), Path(text.to_string()));
        day.ok("a name check while typing", res.await);
    }
    let res = update_server(
        st(),
        Authed(user("alice").await),
        Path("book-nook".to_string()),
        body(json!({ "name": "book-corner" })),
    );
    day.ok("a renamed server", res.await);
    pass(&state, 2 * HOUR);

    for _ in 0..2 {
        let res = create_share(
            st(),
            Authed(user("alice").await),
            body(json!({ "blob": "rc1.abc", "expires_in": 600 })),
        );
        day.ok("a config link", res.await);
    }
    let iss = state.instance.origin(None, &HeaderMap::new());
    let sub = format!("alice@{}", state.instance.host(&iss));
    for seed in [7, 8] {
        let ts = now();
        let proof = key_of(seed).sign(&crate::identity::binding_message(&sub, ts));
        let res = p2p_binding(
            st(),
            Authed(user("alice").await),
            Peer(None),
            HeaderMap::new(),
            body(json!({
                "ik": ik(seed),
                "ts": ts,
                "proof": URL_SAFE_NO_PAD.encode(proof.to_bytes()),
            })),
        );
        day.ok("a P2P badge", res.await);
    }
    for (who, name) in [("bob", "Bobby"), ("carol", "Caz"), ("dave", "D")] {
        let res = patch_me(
            st(),
            Authed(user(who).await),
            body(json!({ "display_name": name })),
        );
        day.ok("a display name", res.await);
    }

    for n in 0..32 {
        let res = put_backup(
            st(),
            Authed(user("alice").await),
            Path(ik(7)),
            Query(serde_json::from_value(json!({ "version": n + 1 })).expect("params")),
            HeaderMap::new(),
            Body::from(vec![n as u8; 64]),
        );
        day.ok("a P2P backup", uploaded(res.await));
        if n == 20 {
            let res = delete_server(
                st(),
                Authed(user("alice").await),
                Path("book-corner".to_string()),
            );
            day.ok("a deleted server", res.await);
        }
        pass(&state, HOUR / 2);
    }
    let res = patch_me(
        st(),
        Authed(user("alice").await),
        body(json!({ "display_name": "Ally" })),
    );
    day.ok("a display name", res.await);
    let refusals: Vec<&(String, Answer)> = day.0.iter().filter(|(_, a)| refused(a)).collect();
    assert!(refusals.is_empty(), "{refusals:?}");
    assert!(day.0.len() > 70, "{}", day.0.len());
    done(state, path).await;
}
