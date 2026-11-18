use std::collections::HashMap;

use axum::http::StatusCode;
use futures_util::{SinkExt, StreamExt};
use tokio::time::Instant;

use super::*;
use crate::api::Member;
use crate::fanout::Topic;
use crate::server::client_ip::ClientIp;
use crate::ws::access::{Access, Pace, catch_up};
use crate::ws::calls::voice_msg;
use crate::ws::conn::{sub_held, subscribe};
use crate::ws::filter::on_event;
use crate::ws::protocol::ClientMsg;
use crate::ws::typing::Bucket;

#[tokio::test]
async fn an_overflowed_inbox_drops_stale_events_and_resyncs() {
    let (state, path) = crate::api::test_util::temp_state("ws_overflow").await;
    add_user(&state.db, "alice").await;
    exec(
        &state.db,
        "INSERT INTO servers(name, display_name, created_at) VALUES('club', 'club', 1)",
    )
    .await;
    exec(
        &state.db,
        "INSERT INTO members(server, username, joined_at) VALUES('club', 'alice', 2)",
    )
    .await;
    let router = crate::fanout::Router::default();
    let conn = 1;
    let topics = HashSet::from([Topic::User(s("alice")), Topic::Server(s("club"))]);
    let mut inbox = router.open(conn, &topics);
    router.deliver(WsEvent::MemberLeft {
        server: s("club"),
        username: s("alice"),
    });
    let filler = |id| WsEvent::MessageDeleted {
        server: Some(s("club")),
        channel_id: Some(1),
        dm_id: None,
        dm_users: None,
        id,
        thread_root_id: None,
        notice: Some(false),
    };
    for id in 0..600 {
        router.deliver(filler(id));
    }
    router.deliver(WsEvent::MemberJoined {
        server: s("club"),
        member: Member {
            user: message().author,
            is_admin: false,
            is_creator: false,
            online: false,
            perms: 0,
            role_ids: Vec::new(),
            joined_via: None,
            timeout: None,
        },
    });
    let first = inbox.rx.recv().await.unwrap();
    assert!(matches!(first.ev, WsEvent::MemberLeft { .. }));
    assert!(inbox.lagged());
    let mut alice = Access::new(Some(s("alice")), false, HashSet::new());
    let mut lag = Pace::new(LAG_REAUTH_EVERY);
    let (through, open) = catch_up(&state, conn, &mut alice, &mut inbox, &mut lag, first.seq).await;
    assert!(open && alice.missed);
    assert!(through > first.seq);
    assert!(inbox.rx.try_recv().is_err());
    assert_eq!(alice.member_servers, set(&["club"]));
    router.deliver(filler(9000));
    let fresh = inbox.rx.recv().await.unwrap();
    assert!(fresh.seq > through && alice.wants(&fresh.ev));
    alice.missed = false;
    let (_, open) = catch_up(&state, conn, &mut alice, &mut inbox, &mut lag, fresh.seq).await;
    assert!(open && !alice.missed && lag.due.is_some());
    crate::api::test_util::done(state, path).await;
}

#[test]
fn flooding_clients_are_throttled_then_closed() {
    let mut bucket = Bucket::new();
    let now = bucket.at;
    let mut allowed = 0;
    let mut dropped = 0;
    loop {
        match bucket.take(now) {
            Some(true) => allowed += 1,
            Some(false) => dropped += 1,
            None => break,
        }
    }
    assert_eq!((allowed, dropped), (MSG_BURST as usize, MSG_BURST as usize));
    let mut bucket = Bucket::new();
    for i in 0..1_000 {
        let at = bucket.at + Duration::from_millis(25);
        assert_eq!(bucket.take(at), Some(true), "message {i}");
    }
}

#[tokio::test]
async fn leaving_a_locked_server_drops_its_subscription() {
    let (state, path, general, _) = peek_world("ws_leave_locked").await;
    let db = &state.db;
    let conn = state.hub.next_conn();
    exec(
        db,
        "UPDATE servers SET password_hash = 'hash' WHERE name = 'open'",
    )
    .await;
    let mut nora = Access::new(Some(s("nora")), false, set(&["home", "open"]));
    nora.subs.insert(s("open"));
    nora.viewable = HashMap::from([(general, (s("open"), true))]);
    for left in [
        WsEvent::MemberLeft {
            server: s("open"),
            username: s("nora"),
        },
        WsEvent::MemberKicked {
            server: s("open"),
            username: s("nora"),
            banned: false,
        },
    ] {
        nora.member_servers.insert(s("open"));
        nora.subs.insert(s("open"));
        on_event(&state, conn, &mut nora, &left).await;
        assert!(!nora.held("open"));
        assert_eq!(
            on_event(&state, conn, &mut nora, &post_in("open", general)).await,
            Some(false)
        );
    }
    crate::api::test_util::done(state, path).await;
}

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn live(tag: &str) -> (AppState, std::path::PathBuf, std::net::SocketAddr) {
    let (state, path) = crate::api::test_util::temp_state(tag).await;
    let trusted =
        crate::server::client_ip::ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
    let app = crate::api::routes(
        state.clone(),
        &crate::config::Roles::ALL,
        ClientIp(trusted),
        None,
    )
    .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    (state, path, addr)
}

async fn dial(
    addr: std::net::SocketAddr,
    from: &str,
) -> Result<Client, tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut req = format!("ws://{addr}/ws")
        .into_client_request()
        .expect("request");
    req.headers_mut()
        .insert("x-forwarded-for", from.parse().expect("header"));
    tokio_tungstenite::connect_async(req)
        .await
        .map(|(ws, _)| ws)
}

async fn send_auth(ws: &mut Client, token: Option<&str>) {
    let frame = serde_json::json!({ "type": "auth", "token": token }).to_string();
    ws.send(tokio_tungstenite::tungstenite::Message::text(frame))
        .await
        .expect("auth");
}

// The close code the socket gets within `wait`, or `None` while it stays open.
async fn closed_with(ws: &mut Client, wait: Duration) -> Option<u16> {
    use tokio_tungstenite::tungstenite::Message as T;
    let until = Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(until, ws.next()).await {
            Err(_) => return None,
            Ok(Some(Ok(T::Close(frame)))) => {
                return Some(frame.map_or(1005, |f| f.code.into()));
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_)) | None) => return Some(1006),
        }
    }
}

// Waits until `done` holds; the ceiling only bounds a failing run.
async fn until(mut done: impl FnMut() -> bool) {
    let ceiling = Instant::now() + Duration::from_secs(30);
    while !done() {
        assert!(Instant::now() < ceiling, "condition never held");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn silent_sockets_close_and_addresses_are_capped() {
    let (state, path, addr) = live("ws_addr_cap").await;
    add_user_row(&state.db, "alice").await;
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'alice', 0)")
        .bind(crate::db::secret_key("alice-token"))
        .execute(&state.db)
        .await
        .expect("token");
    let ceiling = Duration::from_secs(30);
    state.hub.set_auth_wait(Duration::from_millis(100));
    let mut quiet = dial(addr, "203.0.113.1").await.expect("dial");
    quiet
        .send(tokio_tungstenite::tungstenite::Message::Ping(
            Default::default(),
        ))
        .await
        .expect("ping");
    assert_eq!(
        closed_with(&mut quiet, ceiling).await,
        Some(CLOSE_NO_AUTH.0),
        "a socket that never authenticates is closed"
    );
    // From here on no socket may close for want of an auth frame, however slow the run.
    state.hub.set_auth_wait(Duration::from_secs(3600));
    state.hub.set_limits(crate::hub::Limits {
        sockets_per_ip: 3,
        guests_per_ip: 1,
        ..crate::hub::Limits::default()
    });
    let ip = |s: &str| s.parse::<std::net::IpAddr>().expect("ip");
    let mut tabs = Vec::new();
    for _ in 0..3 {
        let mut tab = dial(addr, "203.0.113.2").await.expect("tab");
        send_auth(&mut tab, Some("alice-token")).await;
        tabs.push(tab);
    }
    match dial(addr, "203.0.113.2").await {
        Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
            assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS)
        }
        Err(e) => panic!("unexpected error {e}"),
        Ok(_) => panic!("a fourth socket from one address was accepted"),
    }
    let mut guest = dial(addr, "203.0.113.3").await.expect("guest");
    send_auth(&mut guest, None).await;
    until(|| state.hub.addr_open(ip("203.0.113.3")) == (1, 1)).await;
    let mut second = dial(addr, "203.0.113.3").await.expect("second guest");
    send_auth(&mut second, None).await;
    assert_eq!(
        closed_with(&mut second, ceiling).await,
        Some(CLOSE_TOO_MANY_ADDR.0)
    );
    until(|| state.hub.addr_open(ip("203.0.113.3")) == (1, 1)).await;
    assert_eq!(
        closed_with(&mut guest, Duration::from_millis(50)).await,
        None,
        "the first guest stays open"
    );
    for tab in &mut tabs {
        assert_eq!(
            closed_with(tab, Duration::from_millis(50)).await,
            None,
            "signed-in tabs stay open"
        );
    }
    let mut first = tabs.remove(0);
    first.close(None).await.expect("close");
    assert!(closed_with(&mut first, ceiling).await.is_some());
    until(|| state.hub.addr_open(ip("203.0.113.2")).0 == 2).await;
    assert!(
        dial(addr, "203.0.113.2").await.is_ok(),
        "a closed socket frees its slot"
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn a_recovery_closes_the_sockets_of_old_sessions() {
    use crate::api::test_util::{PHRASE_KEY, phrase_sign};
    let (state, path, addr) = live("ws_recovery").await;
    crate::db::NewUser::plain("alice")
        .hash("x")
        .add_recoverable(&state.db, Some(PHRASE_KEY), Some(0))
        .await;
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'alice', 0)")
        .bind(crate::db::secret_key("thief-token"))
        .execute(&state.db)
        .await
        .expect("token");
    let ceiling = Duration::from_secs(30);
    let mut thief = dial(addr, "203.0.113.4").await.expect("thief");
    send_auth(&mut thief, Some("thief-token")).await;
    until(|| state.hub.is_online_anywhere("alice")).await;
    let client = reqwest::Client::new();
    let post = |path: &str, body: serde_json::Value| {
        client
            .post(format!("http://{addr}{path}"))
            .header("x-forwarded-for", "198.51.100.4")
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
    };
    let challenge = post(
        "/auth/recovery/challenge",
        serde_json::json!({ "username": "Alice" }),
    )
    .await
    .expect("challenge")
    .text()
    .await
    .expect("challenge body");
    let challenge: serde_json::Value = serde_json::from_str(&challenge).expect("challenge json");
    let nonce = challenge["nonce"].as_str().expect("nonce");
    let res = post(
        "/auth/recovery",
        serde_json::json!({
            "username": "Alice",
            "nonce": nonce,
            "sig": phrase_sign("recover", "alice", nonce, ""),
            "new": { "password": "new pass" },
        }),
    )
    .await
    .expect("recover");
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_str(&res.text().await.expect("recover body")).expect("recover json");
    let token = body["token"].as_str().expect("token").to_string();
    assert!(
        closed_with(&mut thief, ceiling).await.is_some(),
        "the old session's socket closes"
    );
    until(|| !state.hub.is_online_anywhere("alice")).await;
    let mut mine = dial(addr, "203.0.113.4").await.expect("mine");
    send_auth(&mut mine, Some(&token)).await;
    until(|| state.hub.is_online_anywhere("alice")).await;
    assert_eq!(
        closed_with(&mut mine, Duration::from_millis(50)).await,
        None
    );
    crate::api::test_util::done(state, path).await;
}

async fn next_of_type(ws: &mut Client, kind: &str, wait: Duration) -> Option<serde_json::Value> {
    next_among(ws, &[kind], wait).await
}

async fn next_among(ws: &mut Client, kinds: &[&str], wait: Duration) -> Option<serde_json::Value> {
    use tokio_tungstenite::tungstenite::Message as T;
    let until = Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(until, ws.next()).await {
            Ok(Some(Ok(T::Text(text)))) => {
                let v: serde_json::Value = serde_json::from_str(&text).ok()?;
                if kinds.iter().any(|kind| v["type"] == *kind) {
                    return Some(v);
                }
                assert_ne!(v["type"], "error", "{v}");
            }
            Ok(Some(Ok(_))) => {}
            Err(_) | Ok(Some(Err(_)) | None) => return None,
        }
    }
}

async fn socket_account(state: &AppState, name: &str, admin: i64) {
    add_user(&state.db, name).await;
    crate::api::test_util::add_member(&state.db, "rchat", name, admin, 0, 1).await;
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, 1)")
        .bind(crate::db::secret_key(&format!("{name}-token")))
        .bind(name)
        .execute(&state.db)
        .await
        .unwrap();
}

async fn viewing_socket(addr: std::net::SocketAddr, name: &str) -> Client {
    let mut ws = dial(addr, "203.0.113.21").await.expect("socket");
    send_auth(&mut ws, Some(&format!("{name}-token"))).await;
    ws.send(tokio_tungstenite::tungstenite::Message::text(
        r#"{"type":"viewing","server":"rchat"}"#,
    ))
    .await
    .unwrap();
    next_of_type(&mut ws, "presence_snapshot", Duration::from_secs(10))
        .await
        .expect("viewing");
    ws
}

async fn layout_names(ws: &mut Client) -> Vec<String> {
    let mut names = Vec::new();
    loop {
        let frame = next_among(
            ws,
            &["layout_changed", "upload_expiry_changed"],
            Duration::from_secs(10),
        )
        .await
        .expect("end of layout changes");
        if frame["type"] == "upload_expiry_changed" {
            return names;
        }
        assert_eq!(frame.as_object().unwrap().len(), 3, "{frame}");
        names.push(
            frame["layout"]["categories"][0]["name"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
}

fn end_events(state: &AppState) {
    state
        .hub
        .broadcast(WsEvent::UploadExpiryChanged { server: s("rchat") });
}

#[tokio::test]
async fn recovered_layout_edits_send_the_current_layout_only_for_visible_changes() {
    use crate::api::{Authed, categories::rename_category, test_util};
    use crate::hub::{Aftermath, Op};
    use axum::{
        Json,
        extract::{Path, State},
    };

    let (state, path, addr) = live("ws_layout_recovery").await;
    let db = &state.db;
    socket_account(&state, "alice", 1).await;
    socket_account(&state, "nora", 0).await;
    let public = insert_id(db, "INSERT INTO channel_categories(server, name, position, created_at) VALUES('rchat', 'Spring', 0, 1) RETURNING id").await;
    let empty = insert_id(db, "INSERT INTO channel_categories(server, name, position, created_at) VALUES('rchat', 'Empty', 1, 1) RETURNING id").await;
    sqlx::query("UPDATE channels SET category_id = $1 WHERE server = 'rchat'")
        .bind(public)
        .execute(db)
        .await
        .unwrap();
    let (hub, mut out) = Hub::replicated();
    let mut writer = state.clone();
    writer.hub = hub.clone();
    let mut aftermath = hub.take_aftermath().unwrap();
    let mut reader = viewing_socket(addr, "nora").await;
    let mut manager = viewing_socket(addr, "alice").await;
    for (id, name) in [(empty, "Later"), (public, "Summer"), (public, "Autumn")] {
        let body = serde_json::from_value(serde_json::json!({ "name": name })).unwrap();
        let _ = rename_category(
            State(writer.clone()),
            Authed(test_util::mem_user("alice", false)),
            Path(id),
            Json(body),
        )
        .await
        .unwrap();
        let Op::Broadcast { event } = out.try_recv().expect("published rename").op else {
            panic!("expected broadcast")
        };
        state
            .hub
            .broadcast(serde_json::from_str(&to_bus_json(&event).unwrap()).unwrap());
    }
    end_events(&state);
    assert_eq!(layout_names(&mut reader).await, ["Summer", "Autumn"]);
    assert_eq!(
        layout_names(&mut manager).await,
        ["Spring", "Summer", "Autumn"]
    );
    reader.close(None).await.unwrap();
    let mut reader = viewing_socket(addr, "nora").await;

    hub.heartbeat();
    hub.ingest("4-0", out.try_recv().unwrap(), true);
    let Aftermath::Repost(missed) = aftermath.try_recv().expect("missing broadcasts") else {
        panic!("expected reposts")
    };
    assert_eq!(missed.len(), 3);
    for op in missed {
        crate::ws::repost::repost(&writer, op).await;
        let Op::Broadcast { event } = out.try_recv().expect("reposted rename").op else {
            panic!("expected broadcast")
        };
        let received = serde_json::from_str(&to_bus_json(&event).unwrap()).unwrap();
        let recovered = crate::ws::repost::current(&writer, received)
            .await
            .expect("current layout");
        state.hub.broadcast(recovered);
    }
    end_events(&state);
    assert_eq!(layout_names(&mut reader).await, ["Autumn", "Autumn"]);
    assert_eq!(layout_names(&mut manager).await, ["Autumn"; 3]);
    test_util::done(state, path).await;
}

#[tokio::test]
async fn layout_events_without_a_comparison_use_consecutive_snapshots_on_the_socket() {
    let (state, path, addr) = live("ws_layout_snapshots").await;
    socket_account(&state, "nora", 0).await;
    socket_account(&state, "alice", 1).await;
    let mut manager = viewing_socket(addr, "alice").await;
    let channel = general(&state.db).await;
    let mut reader = viewing_socket(addr, "nora").await;
    for (version, public, empty) in [
        (10, "Spring", "Later"),
        (11, "Spring", "Elsewhere"),
        (12, "Summer", "Elsewhere"),
        (14, "Autumn", "Later"),
        (15, "Winter", "Later"),
    ] {
        let wire = serde_json::json!({
            "type": "layout_changed", "server": "rchat",
            "layout": { "version": version, "uncategorized": [], "categories": [
                {"id": 101, "name": public, "channels": [channel]},
                {"id": 102, "name": empty, "channels": []}
            ]}
        });
        state.hub.broadcast(serde_json::from_value(wire).unwrap());
    }
    end_events(&state);
    assert_eq!(layout_names(&mut reader).await, ["Summer", "Winter"]);
    assert_eq!(
        layout_names(&mut manager).await,
        ["Spring", "Spring", "Summer", "Autumn", "Winter"]
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn normal_tabs_keep_working_under_the_limits() {
    let (state, path, addr) = live("ws_normal_tabs").await;
    for name in ["alice", "bob"] {
        add_user_row(&state.db, name).await;
        crate::api::test_util::add_member(&state.db, "rchat", name, 0, 0, 0).await;
    }
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'alice', 0)")
        .bind(crate::db::secret_key("alice-token"))
        .execute(&state.db)
        .await
        .expect("token");
    let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    let mut tabs = Vec::new();
    for n in 0..4 {
        let mut tab = dial(addr, "203.0.113.9").await.expect("tab");
        send_auth(&mut tab, (n < 3).then_some("alice-token")).await;
        for _ in 0..5 {
            let frame = serde_json::json!({ "type": "subscribe", "servers": ["rchat"] });
            tab.send(tokio_tungstenite::tungstenite::Message::text(
                frame.to_string(),
            ))
            .await
            .expect("subscribe");
        }
        tabs.push(tab);
    }
    voice_msg(&state, "bob", 1, ClientMsg::VoiceJoin { channel_id: cid })
        .await
        .expect("join");
    for tab in &mut tabs {
        let ev = next_of_type(tab, "voice_state", Duration::from_secs(30)).await;
        assert!(ev.is_some_and(|v| v["users"] == serde_json::json!(["bob"])));
    }
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn guests_are_named_and_leave_voice_when_they_close() {
    use tokio_tungstenite::tungstenite::Message as T;
    let (state, path, addr) = live("ws_guest_voice").await;
    let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    let mut names = Vec::new();
    for from in ["203.0.113.7", "203.0.113.8"] {
        let mut ws = dial(addr, from).await.expect("guest");
        send_auth(&mut ws, None).await;
        let named = next_of_type(&mut ws, "guest_name", Duration::from_secs(30))
            .await
            .expect("a guest learns its voice name first");
        let name = named["name"].as_str().expect("name").to_string();
        assert!(name.starts_with("@guest:") && name.len() == 23, "{name}");
        for frame in [
            serde_json::json!({ "type": "subscribe", "servers": ["rchat"] }),
            serde_json::json!({ "type": "voice_join", "channel_id": cid }),
        ] {
            ws.send(T::text(frame.to_string())).await.expect("send");
        }
        let listed = next_of_type(&mut ws, "voice_state", Duration::from_secs(30))
            .await
            .expect("voice state");
        assert_eq!(listed["users"], serde_json::json!([name]));
        ws.close(None).await.expect("close");
        until(|| state.hub.rooms_in("rchat", None).is_empty()).await;
        names.push(name);
    }
    assert_ne!(names[0], names[1], "each connection has its own name");
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn subscribe_checks_only_servers_not_held() {
    let (state, path) = crate::api::test_util::temp_state("ws_sub_held").await;
    let conn = state.hub.next_conn();
    let mut guest = Access::new(None, false, set(&[]));
    subscribe(
        &state,
        conn,
        &mut guest,
        vec![s("rchat"), s("nope")],
        HashMap::new(),
    )
    .await;
    assert_eq!(guest.subs, set(&["rchat"]));
    assert!(sub_held(&guest, "rchat", None));
    assert!(
        !sub_held(&guest, "rchat", Some(&s("grant"))),
        "a new grant is checked again"
    );
    let mut user = Access::new(Some(s("bob")), false, set(&[]));
    add_user_row(&state.db, "bob").await;
    subscribe(&state, conn, &mut user, vec![s("rchat")], HashMap::new()).await;
    assert_eq!(user.subs, set(&["rchat"]));
    crate::db::close(&state.read()).await;
    subscribe(
        &state,
        conn,
        &mut guest,
        vec![s("rchat"), s("other")],
        HashMap::new(),
    )
    .await;
    assert_eq!(
        guest.subs,
        set(&["rchat"]),
        "held servers need no database read"
    );
    subscribe(&state, conn, &mut user, vec![s("rchat")], HashMap::new()).await;
    assert_eq!(user.subs, set(&["rchat"]));
    subscribe(&state, conn, &mut user, Vec::new(), HashMap::new()).await;
    assert!(user.subs.is_empty());
    crate::api::test_util::done(state, path).await;
}

/// The text frames `ws` gets until one that `last` accepts, that one included.
async fn frames_until(
    ws: &mut Client,
    last: impl Fn(&serde_json::Value) -> bool,
) -> Vec<serde_json::Value> {
    use tokio_tungstenite::tungstenite::Message as T;
    let until = Instant::now() + Duration::from_secs(30);
    let mut frames = Vec::new();
    loop {
        match tokio::time::timeout_at(until, ws.next()).await {
            Ok(Some(Ok(T::Text(text)))) => {
                let v: serde_json::Value = serde_json::from_str(&text).expect("json");
                let done = last(&v);
                frames.push(v);
                if done {
                    return frames;
                }
            }
            Ok(Some(Ok(_))) => {}
            Err(_) => panic!("no such frame within the wait: {frames:?}"),
            Ok(other) => panic!("the socket ended ({:?}): {frames:?}", other.is_some()),
        }
    }
}

#[tokio::test]
async fn deletion_frames_use_the_evidence_available_to_each_socket() {
    use serde_json::{Value, json};

    async fn received(ws: &mut Client) -> Vec<Value> {
        frames_until(ws, |event| event["type"] == "upload_expiry_changed")
            .await
            .into_iter()
            .filter_map(|event| {
                assert!(event.get("notice").is_none() && event.get("notices").is_none());
                match event["type"].as_str()? {
                    "message_deleted" => Some(event["id"].clone()),
                    "messages_deleted" => Some(event["ids"].clone()),
                    _ => None,
                }
            })
            .collect()
    }

    let (state, path, addr) = live("ws_delete_evidence").await;
    socket_account(&state, "bob", 0).await;
    socket_account(&state, "nora", 0).await;
    exec(
        &state.db,
        "DELETE FROM members WHERE server = 'rchat' AND username = 'nora'",
    )
    .await;
    exec(
        &state.db,
        "UPDATE servers SET public_read = 1 WHERE name = 'rchat'",
    )
    .await;
    let mut outsider = viewing_socket(addr, "nora").await;
    let mut member = viewing_socket(addr, "bob").await;
    exec(
        &state.db,
        "UPDATE servers SET members_visible = 0 WHERE name = 'rchat'",
    )
    .await;
    let server = crate::api::access::ws_server_lite(&state.db, "rchat")
        .await
        .unwrap()
        .unwrap();
    state.hub.broadcast(WsEvent::ServerUpdated { server });

    let cid = general(&state.db).await;
    let send = |mut wire: Value| {
        wire["server"] = "rchat".into();
        wire["channel_id"] = cid.into();
        let event: WsEvent = serde_json::from_value(wire.clone()).unwrap();
        let bus = to_bus_json(&event).unwrap();
        let forwarded: Value = serde_json::from_str(&bus).unwrap();
        for key in ["notice", "notices"] {
            assert_eq!(forwarded.get(key), wire.get(key));
        }
        state.hub.broadcast(serde_json::from_str(&bus).unwrap());
    };
    for event in [
        json!({"type":"message_deleted", "id":1, "notice":false}),
        json!({"type":"message_deleted", "id":2}),
        json!({"type":"message_deleted", "id":3, "notice":true}),
        json!({"type":"messages_deleted", "ids":[4,5], "notices":[5]}),
        json!({"type":"messages_deleted", "ids":[6,7]}),
        json!({"type":"messages_deleted", "ids":[8,9], "notices":[]}),
    ] {
        send(event);
    }
    end_events(&state);
    assert_eq!(
        received(&mut outsider).await,
        [json!(1), json!([4]), json!([8, 9])]
    );
    assert_eq!(
        received(&mut member).await,
        [
            json!(1),
            json!(2),
            json!(3),
            json!([4, 5]),
            json!([6, 7]),
            json!([8, 9])
        ]
    );

    state.hub.channels().clear();
    state.read().close().await;
    send(json!({"type":"messages_deleted", "ids":[10,11], "notices":[11]}));
    end_events(&state);
    assert!(received(&mut outsider).await.is_empty());
    assert!(received(&mut member).await.is_empty());
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn live_replies_reach_only_members_who_may_read_their_root() {
    use crate::api::Authed;
    use crate::api::messages::{
        delete_message, edit_message, send_channel_message, send_thread_message,
    };
    use crate::api::reactions::add_reaction;
    use axum::Json;
    use axum::extract::{Path, State};
    let (state, path, addr) = live("ws_thread_history").await;
    let db = &state.db;
    for (name, joined) in [("alice", 0), ("carol", 1000), ("dave", 1000)] {
        add_user_row(db, name).await;
        crate::api::test_util::add_member(db, "rchat", name, 0, 0, joined).await;
        sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, 0)")
            .bind(crate::db::secret_key(&format!("{name}-token")))
            .bind(name)
            .execute(db)
            .await
            .expect("token");
    }
    let cid = general(db).await;
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:carol', 1, 1, 0)")
        .bind(cid)
        .execute(db)
        .await
        .expect("no history for carol");
    let root = |at: i64| async move {
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', 'root', $2) RETURNING id")
            .bind(cid)
            .bind(at)
            .fetch_one(db)
            .await
            .expect("root")
            .try_get::<i64, _>(0)
            .expect("id")
    };
    let (old_root, new_root) = (root(500).await, root(crate::db::now()).await);
    let mut sockets = Vec::new();
    for name in ["carol", "dave", "alice"] {
        let mut ws = dial(addr, "203.0.113.20").await.expect("socket");
        send_auth(&mut ws, Some(&format!("{name}-token"))).await;
        let frame = serde_json::json!({ "type": "subscribe", "servers": ["rchat"] });
        ws.send(tokio_tungstenite::tungstenite::Message::text(
            frame.to_string(),
        ))
        .await
        .expect("subscribe");
        sockets.push(ws);
    }
    let alice = || Authed(crate::api::test_util::mem_user("alice", false));
    let send =
        |text: &str| serde_json::from_value(serde_json::json!({ "content": text })).expect("body");
    let mut ready = false;
    for _ in 0..20 {
        let Json(ping) =
            send_channel_message(State(state.clone()), Path(cid), alice(), Json(send("ping")))
                .await
                .expect("ping");
        let mut seen = 0;
        for ws in sockets.iter_mut().take(2) {
            if next_of_type(ws, "message", Duration::from_secs(1))
                .await
                .is_some_and(|v| v["message"]["id"] == ping.id)
            {
                seen += 1;
            }
        }
        if seen == 2 {
            ready = true;
            break;
        }
    }
    assert!(ready, "the sockets never got their first event");
    let Json(reply) = send_thread_message(
        State(state.clone()),
        Path(old_root),
        alice(),
        Json(send("under the old root")),
    )
    .await
    .expect("reply");
    let _ = edit_message(
        State(state.clone()),
        Path(reply.id),
        alice(),
        Json(
            serde_json::from_value(serde_json::json!({ "content": "edited under the old root" }))
                .expect("body"),
        ),
    )
    .await
    .expect("edit");
    let _ = add_reaction(
        State(state.clone()),
        Path((reply.id, "\u{1f44d}".to_string())),
        alice(),
    )
    .await
    .expect("react");
    let typing = serde_json::json!({ "type": "typing", "scope": format!("t{old_root}") });
    sockets[2]
        .send(tokio_tungstenite::tungstenite::Message::text(
            typing.to_string(),
        ))
        .await
        .expect("typing");
    let mut dave = frames_until(&mut sockets[1], |v| v["type"] == "typing").await;
    let _ = delete_message(State(state.clone()), Path(reply.id), alice())
        .await
        .expect("delete");
    let Json(later) = send_thread_message(
        State(state.clone()),
        Path(new_root),
        alice(),
        Json(send("under the new root")),
    )
    .await
    .expect("later reply");
    let about_reply = |v: &serde_json::Value| {
        v["message"]["id"] == reply.id
            || v["id"] == reply.id
            || v["message_id"] == reply.id
            || v["scope"] == format!("t{old_root}")
    };
    let is_later = |v: &serde_json::Value| v["type"] == "message" && v["message"]["id"] == later.id;
    let carol = frames_until(&mut sockets[0], is_later).await;
    let leaked: Vec<&serde_json::Value> = carol.iter().filter(|v| about_reply(v)).collect();
    assert!(leaked.is_empty(), "carol got {leaked:?}");
    dave.extend(frames_until(&mut sockets[1], is_later).await);
    let kinds: Vec<&str> = dave
        .iter()
        .filter(|v| about_reply(v))
        .filter_map(|v| v["type"].as_str())
        .collect();
    assert_eq!(
        kinds,
        [
            "message",
            "message_updated",
            "reaction_added",
            "typing",
            "message_deleted"
        ],
        "dave reads the old root"
    );
    crate::api::test_util::done(state, path).await;
}
