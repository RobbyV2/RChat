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

async fn next_of_type(ws: &mut Client, kind: &str, wait: Duration) -> Option<serde_json::Value> {
    use tokio_tungstenite::tungstenite::Message as T;
    let until = Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(until, ws.next()).await {
            Ok(Some(Ok(T::Text(text)))) => {
                let v: serde_json::Value = serde_json::from_str(&text).ok()?;
                if v["type"] == kind {
                    return Some(v);
                }
                assert_ne!(v["type"], "error", "{v}");
            }
            Ok(Some(Ok(_))) => {}
            Err(_) | Ok(Some(Err(_)) | None) => return None,
        }
    }
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
