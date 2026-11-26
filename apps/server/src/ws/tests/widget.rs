use std::net::SocketAddr;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as Wire;

use super::*;
use crate::api::test_util::{add_member, done, mem_user, site_sets, temp_state};
use crate::server::client_ip::{ClientIp, ProxyTrust};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const HOST: &str = "https://host.example";

async fn serve(state: &AppState) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
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
    let server = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    (addr, server)
}

/// A widget of the built-in server and a session for it, opened from `HOST`.
async fn widget(state: &AppState, channel: i64, mode: &str) -> (String, String) {
    let config = serde_json::from_value(serde_json::json!({
        "channel_id": channel,
        "mode": mode,
        "enabled": true,
        "composer": true,
        "origins": [],
    }))
    .expect("config");
    let Json(w) = crate::api::widgets::create(
        State(state.clone()),
        crate::api::Authed(mem_user("manager", false)),
        Path("rchat".to_string()),
        Json(config),
    )
    .await
    .expect("widget");
    let open = serde_json::from_value(serde_json::json!({ "parent": HOST })).expect("open");
    let Json(session) = crate::api::widgets::open(
        State(state.clone()),
        Path(w.id.clone()),
        axum::http::HeaderMap::new(),
        Json(open),
    )
    .await
    .expect("session");
    let ticket = serde_json::to_value(&session).expect("session")["ticket"]
        .as_str()
        .expect("ticket")
        .to_string();
    (w.id, ticket)
}

async fn dial(addr: SocketAddr, id: &str, ticket: &str, token: Option<&str>) -> Socket {
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?widget={id}"))
        .await
        .expect("connect");
    let hello = serde_json::json!({ "ticket": ticket, "parent": HOST, "token": token });
    socket
        .send(Wire::Text(hello.to_string().into()))
        .await
        .expect("hello");
    socket
}

/// The next event frame, or `None` once the socket closes.
async fn next(socket: &mut Socket, wait: Duration) -> Option<serde_json::Value> {
    loop {
        match tokio::time::timeout(wait, socket.next()).await {
            Err(_) => panic!("no frame within {wait:?}"),
            Ok(Some(Ok(Wire::Text(text)))) => {
                return Some(serde_json::from_str(&text).expect("json"));
            }
            Ok(Some(Ok(Wire::Ping(_) | Wire::Pong(_)))) => {}
            Ok(Some(Ok(_)) | Some(Err(_)) | None) => return None,
        }
    }
}

/// Frames until one of type `kind`.
async fn until(socket: &mut Socket, kind: &str) -> serde_json::Value {
    loop {
        let frame = next(socket, Duration::from_secs(10))
            .await
            .unwrap_or_else(|| panic!("closed before {kind}"));
        if frame["type"] == kind {
            return frame;
        }
    }
}

async fn closes(socket: &mut Socket) {
    while next(socket, Duration::from_secs(10)).await.is_some() {}
}

/// Every frame that arrives within `wait`, with the time it arrived.
async fn quiet(
    socket: &mut Socket,
    wait: Duration,
) -> Vec<(tokio::time::Instant, serde_json::Value)> {
    let end = tokio::time::Instant::now() + wait;
    let mut frames = Vec::new();
    loop {
        let left = end.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return frames;
        }
        match tokio::time::timeout(left, socket.next()).await {
            Err(_) => return frames,
            Ok(Some(Ok(Wire::Text(text)))) => {
                frames.push((
                    tokio::time::Instant::now(),
                    serde_json::from_str(&text).expect("json"),
                ));
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_)) | None) => panic!("closed"),
        }
    }
}

fn join(channel: i64) -> Wire {
    Wire::Text(
        serde_json::json!({ "type": "voice_join", "channel_id": channel })
            .to_string()
            .into(),
    )
}

async fn world(tag: &str) -> (AppState, std::path::PathBuf) {
    let (state, path) = temp_state(tag).await;
    let db = &state.db;
    for name in ["manager", "member", "alice"] {
        add_user_row(db, name).await;
    }
    add_member(db, "rchat", "manager", 1, 0, 0).await;
    add_member(db, "rchat", "member", 0, 0, 0).await;
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'member', 0)")
        .bind(crate::db::secret_key("member-token"))
        .execute(db)
        .await
        .expect("token");
    site_sets(
        &state,
        serde_json::json!({ "widgets": true, "widget_chat": true, "guests_enabled": true }),
    )
    .await;
    (state, path)
}

#[tokio::test]
async fn a_voice_frame_follows_guest_voice_and_ends_revoked_seats() {
    let (state, path) = world("widget_socket_voice").await;
    let db = &state.db;
    let room = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    let (id, ticket) = widget(&state, room, "voice").await;
    let (addr, server) = serve(&state).await;

    let mut refused = dial(addr, &id, &ticket, None).await;
    let ready = until(&mut refused, "widget_ready").await;
    assert!(crate::ws::is_guest(ready["name"].as_str().expect("name")));
    refused.send(join(room)).await.expect("join");
    closes(&mut refused).await;
    assert!(
        state.hub.rooms_in("rchat", Some(room)).is_empty(),
        "no guest voice yet"
    );

    site_sets(&state, serde_json::json!({ "guest_voice_enabled": true })).await;
    exec(
        db,
        "UPDATE servers SET guest_voice_opt_in = 1 WHERE name = 'rchat'",
    )
    .await;
    let mut guest = dial(addr, &id, &ticket, None).await;
    let name = until(&mut guest, "widget_ready").await["name"]
        .as_str()
        .expect("name")
        .to_string();
    guest.send(join(room)).await.expect("join");
    let state_frame = until(&mut guest, "voice_state").await;
    assert_eq!(state_frame["users"], serde_json::json!([name]));
    let mut member = dial(addr, &id, &ticket, Some("member-token")).await;
    assert_eq!(until(&mut member, "widget_ready").await["name"], "member");
    member.send(join(room)).await.expect("join");
    let both = until(&mut member, "voice_state").await;
    assert_eq!(both["users"].as_array().map(Vec::len), Some(2));

    site_sets(&state, serde_json::json!({ "guest_voice_enabled": false })).await;
    closes(&mut guest).await;
    let left = until(&mut member, "voice_state").await;
    assert_eq!(
        left["users"],
        serde_json::json!(["member"]),
        "the member stays"
    );
    assert_eq!(
        state.hub.rooms_in("rchat", Some(room)),
        vec![(room, vec!["member".to_string()])]
    );

    exec(db, "DELETE FROM tokens WHERE username = 'member'").await;
    state.hub.broadcast(WsEvent::TokensRevoked {
        username: "member".to_string(),
    });
    closes(&mut member).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !state.hub.rooms_in("rchat", Some(room)).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the revoked seat ends");
    server.abort();
    done(state, path).await;
}

#[tokio::test]
async fn a_chat_frame_hears_changes_in_its_channel_without_reading_the_room_each_time() {
    let (state, path) = world("widget_socket_chat").await;
    let db = &state.db;
    let channel = general(db).await;
    let other = insert_id(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'other', 0) RETURNING id",
    )
    .await;
    let (id, ticket) = widget(&state, channel, "public_chat").await;
    let (addr, server) = serve(&state).await;
    let mut frame = dial(addr, &id, &ticket, None).await;
    until(&mut frame, "widget_ready").await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let event = |channel_id: i64, message: Message| WsEvent::Message {
        server: Some("rchat".to_string()),
        channel_id: Some(channel_id),
        dm_id: None,
        dm_users: None,
        message: Box::new(message),
    };
    let away = post_message(db, other, "elsewhere").await;
    state.hub.broadcast(event(other, away));
    assert!(
        quiet(&mut frame, Duration::from_millis(1500))
            .await
            .is_empty(),
        "another channel's message"
    );
    for n in 0..5 {
        let message = post_message(db, channel, &format!("burst {n}")).await;
        state.hub.broadcast(event(channel, message));
    }
    let heard = quiet(&mut frame, Duration::from_millis(3000)).await;
    assert!(
        heard.iter().all(|(_, f)| f["type"] == "widget_refresh"),
        "{heard:?}"
    );
    assert!(
        (1..=2).contains(&heard.len()),
        "a burst is a refresh at once and at most one more: {heard:?}"
    );
    if let [(first, _), (second, _)] = heard.as_slice() {
        assert!(
            second.duration_since(*first) >= Duration::from_millis(900),
            "refreshes are a second apart"
        );
    }

    site_sets(&state, serde_json::json!({ "widget_chat": false })).await;
    until(&mut frame, "widget_refresh").await;

    sqlx::query("UPDATE channels SET restrict_view = 1 WHERE id = $1")
        .bind(channel)
        .execute(db)
        .await
        .expect("restrict");
    state.hub.broadcast(WsEvent::ChannelPermsChanged {
        server: "rchat".to_string(),
        channel_id: channel,
    });
    closes(&mut frame).await;
    server.abort();
    done(state, path).await;
}

#[tokio::test]
async fn a_voice_frame_says_its_audio_while_it_holds_its_seat() {
    let (state, path) = world("widget_socket_audio").await;
    let db = &state.db;
    let room = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    let (id, ticket) = widget(&state, room, "voice").await;
    let (addr, server) = serve(&state).await;
    let audio = |muted: bool| {
        Wire::Text(
            serde_json::json!({ "type": "voice_audio", "muted": muted, "deafened": false })
                .to_string()
                .into(),
        )
    };
    let heard = |state: &AppState| {
        state
            .hub
            .voice_snapshot()
            .into_iter()
            .map(|ev| match ev {
                WsEvent::VoiceState {
                    server: _,
                    channel_id: _,
                    users: _,
                    audio: Some(audio),
                } => audio.len(),
                _ => 0,
            })
            .sum::<usize>()
    };
    let mut member = dial(addr, &id, &ticket, Some("member-token")).await;
    assert_eq!(until(&mut member, "widget_ready").await["name"], "member");
    member.send(audio(true)).await.expect("audio");
    let muted_join = serde_json::json!({ "type": "voice_join", "channel_id": room, "muted": true });
    member
        .send(Wire::Text(muted_join.to_string().into()))
        .await
        .expect("join");
    until(&mut member, "voice_state").await;
    let own = until(&mut member, "voice_audio").await;
    assert_eq!(
        (own["username"].clone(), own["muted"].clone()),
        ("member".into(), true.into())
    );
    assert_eq!(heard(&state), 1);
    member.send(audio(false)).await.expect("unmute");
    let open = until(&mut member, "voice_audio").await;
    assert_eq!(open["muted"], false);
    assert_eq!(heard(&state), 0, "the default is not kept");
    assert_eq!(
        state.hub.rooms_in("rchat", Some(room)),
        vec![(room, vec!["member".to_string()])]
    );
    server.abort();
    done(state, path).await;
}

#[tokio::test]
async fn a_frame_hears_audio_only_in_the_call_of_its_channel() {
    use crate::hub::Audio;
    let (state, path) = world("widget_socket_audio_scope").await;
    let db = &state.db;
    let room = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    let other = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'other', 'voice', 0) RETURNING id").await;
    let (id, ticket) = widget(&state, room, "voice").await;
    let (addr, server) = serve(&state).await;
    let said = |frames: &[(tokio::time::Instant, serde_json::Value)]| {
        frames
            .iter()
            .filter(|(_, f)| f["type"] == "voice_audio")
            .map(|(_, f)| (f["username"].clone(), f["deafened"].clone()))
            .collect::<Vec<_>>()
    };
    let mut member = dial(addr, &id, &ticket, Some("member-token")).await;
    assert_eq!(until(&mut member, "widget_ready").await["name"], "member");
    let (alice, carol) = (state.hub.next_conn(), state.hub.next_conn());
    let muted = Audio {
        muted: true,
        deafened: false,
    };
    let deaf = Audio {
        muted: true,
        deafened: true,
    };
    state
        .hub
        .voice_join_with("alice", alice, ("rchat", room), 0, muted)
        .await
        .expect("alice joins");
    state
        .hub
        .voice_join_with("carol", carol, ("rchat", other), 0, muted)
        .await
        .expect("carol joins");
    assert!(
        said(&quiet(&mut member, Duration::from_millis(1500)).await).is_empty(),
        "outside the call"
    );
    member.send(join(room)).await.expect("join");
    until(&mut member, "widget_mutes").await;
    state.hub.voice_audio("carol", carol, deaf);
    state.hub.voice_audio("alice", alice, deaf);
    assert_eq!(
        said(&quiet(&mut member, Duration::from_millis(1500)).await),
        vec![(
            serde_json::Value::from("alice"),
            serde_json::Value::from(true)
        )],
        "only its own channel"
    );
    server.abort();
    done(state, path).await;
}
