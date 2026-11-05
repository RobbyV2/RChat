use tokio::time::Instant;

use super::*;
use crate::api::{Embed, Message, UserRef};
use crate::hub::Op;
use crate::ws::repost::repost;

fn in_channel(channel_id: i64, message: Message) -> WsEvent {
    WsEvent::Message {
        server: Some("rchat".to_string()),
        channel_id: Some(channel_id),
        dm_id: None,
        dm_users: None,
        message: Box::new(message),
    }
}

#[tokio::test]
async fn reposts_are_checked_against_the_database() {
    let (state, path) = crate::api::test_util::temp_state("ws_repost").await;
    let db = &state.db;
    add_user(db, "alice").await;
    add_user(db, "bob").await;
    exec(
        db,
        "UPDATE users SET display_name = 'Alice Now' WHERE username = 'alice'",
    )
    .await;
    exec(
        db,
        "INSERT INTO servers(name, display_name, created_at) VALUES('b', 'Bee', 1)",
    )
    .await;
    exec(
        db,
        "INSERT INTO servers(name, display_name, created_at) VALUES('reused', 'Reused', 1)",
    )
    .await;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1)",
    )
    .await;
    let text = general(db).await;
    let talk: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'talk', 'voice', 1) RETURNING id")
        .fetch_one(db)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'r:999', 1, 1, 1)")
        .bind(talk)
        .execute(db)
        .await
        .unwrap();
    crate::api::test_util::restrict_ruled(db).await;
    let kept = post_message(db, text, "kept").await;
    let gone = post_message(db, text, "gone").await;
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(gone.id)
        .execute(db)
        .await
        .unwrap();
    let mut stale = kept.clone();
    stale.content = "stale".to_string();
    let bob = state.hub.next_conn();
    state.hub.set_online("bob", bob, &["rchat"]);
    state.hub.voice_join("bob", bob, "rchat", talk).await;
    let mut rx = state.hub.subscribe();
    let s = |v: &str| v.to_string();
    let ops = vec![
        Op::Broadcast {
            event: in_channel(text, gone),
        },
        Op::Broadcast {
            event: in_channel(text, stale),
        },
        Op::Broadcast {
            event: WsEvent::ServerRenamed {
                old_name: s("reused"),
                server: lite("b"),
            },
        },
        Op::Broadcast {
            event: WsEvent::ServerRenamed {
                old_name: s("a"),
                server: lite("b"),
            },
        },
        Op::Broadcast {
            event: WsEvent::ServerDeleted { name: s("reused") },
        },
        Op::Broadcast {
            event: WsEvent::ServerDeleted { name: s("a") },
        },
        Op::Broadcast {
            event: WsEvent::MemberKicked {
                server: s("rchat"),
                username: s("bob"),
                banned: false,
            },
        },
        Op::Broadcast {
            event: WsEvent::MemberKicked {
                server: s("rchat"),
                username: s("alice"),
                banned: true,
            },
        },
        Op::ForceOffline {
            server: s("rchat"),
            user: s("bob"),
        },
        Op::Broadcast {
            event: WsEvent::Banned {
                username: s("alice"),
            },
        },
        Op::Broadcast {
            event: WsEvent::UserUpdated {
                user: UserRef {
                    display_name: s("Alice Then"),
                    ..kept.author.clone()
                },
                scope: UserScope::default(),
            },
        },
    ];
    for op in ops {
        repost(&state, op).await;
    }
    let mut seen = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        seen.push(match ev {
            WsEvent::Message { message, .. } => format!("message {}", message.content),
            WsEvent::ServerRenamed { old_name, server } => {
                format!("renamed {old_name} {} {}", server.name, server.display_name)
            }
            WsEvent::ServerDeleted { name } => format!("deleted {name}"),
            WsEvent::MemberKicked {
                server,
                username,
                banned,
            } => format!("kicked {server} {username} {banned}"),
            WsEvent::VoiceState {
                channel_id, users, ..
            } => format!("voice {channel_id} {users:?}"),
            WsEvent::VoiceEnded { dm_users, .. } => format!("voice ended {dm_users:?}"),
            WsEvent::UserUpdated { user, scope: _ } => format!("user {}", user.display_name),
            WsEvent::Banned { username } => format!("banned {username}"),
            WsEvent::PresenceChanged {
                username, online, ..
            } => {
                format!("presence {username} {online}")
            }
            _ => "other".to_string(),
        });
    }
    assert_eq!(
        seen,
        vec![
            s("message kept"),
            s("renamed a b Bee"),
            s("deleted a"),
            format!("voice {talk} []"),
            s("voice ended Some([\"bob\"])"),
            s("kicked rchat alice true"),
            s("user Alice Now"),
        ]
    );
    assert!(state.hub.is_online("rchat", "bob"));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn reposted_message_is_retracted_if_deleted_meanwhile() {
    let (local, path) = crate::api::test_util::temp_state("ws_retract").await;
    add_user(&local.db, "alice").await;
    let text = general(&local.db).await;
    let (hub, mut out) = Hub::replicated();
    let state = AppState::new(
        local.db.clone(),
        hub.clone(),
        None,
        None,
        local.instance.clone(),
    );
    let mut n = 0;
    for delete in [true, false] {
        let message = post_message(&state.db, text, "secret").await;
        let id = message.id;
        let task = {
            let state = state.clone();
            let event = in_channel(text, message);
            tokio::spawn(async move { repost(&state, Op::Broadcast { event }).await })
        };
        let started = Instant::now();
        let posted = loop {
            if let Ok(env) = out.try_recv() {
                break env;
            }
            assert!(started.elapsed() < Duration::from_secs(5));
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(matches!(
            &posted.op,
            Op::Broadcast {
                event: WsEvent::Message { .. }
            }
        ));
        if delete {
            sqlx::query("DELETE FROM messages WHERE id = $1")
                .bind(id)
                .execute(&state.db)
                .await
                .unwrap();
        }
        n += 1;
        hub.ingest(&format!("{n}-0"), posted, true);
        task.await.unwrap();
        match (delete, out.try_recv()) {
            (true, Ok(env)) => assert!(matches!(
                &env.op,
                Op::Broadcast { event: WsEvent::MessageDeleted { id: gone, .. } } if *gone == id
            )),
            (false, Err(_)) => {}
            (_, _) => panic!("unexpected retraction outcome (deleted: {delete})"),
        }
    }
    crate::api::test_util::done(local, path).await;
}

#[tokio::test]
async fn reposted_messages_carry_their_embeds() {
    let (state, path) = crate::api::test_util::temp_state("ws_embeds").await;
    let db = &state.db;
    add_user(db, "alice").await;
    let text = general(db).await;
    let posted = post_message(db, text, "see https://example.com").await;
    exec(db, "INSERT INTO embeds(url, site_name, title, fetched_at) VALUES('https://example.com', 'Example', 'Example Domain', 1)").await;
    sqlx::query(
        "INSERT INTO message_embeds(message_id, ord, url) VALUES($1, 0, 'https://example.com')",
    )
    .bind(posted.id)
    .execute(db)
    .await
    .unwrap();
    let mut rx = state.hub.subscribe();
    repost(
        &state,
        Op::Broadcast {
            event: in_channel(text, posted.clone()),
        },
    )
    .await;
    repost(
        &state,
        Op::Broadcast {
            event: WsEvent::EmbedsResolved {
                server: Some(s("rchat")),
                channel_id: Some(text),
                dm_id: None,
                dm_users: None,
                message_id: posted.id,
                embeds: Vec::new(),
            },
        },
    )
    .await;
    let titles = |embeds: &[Embed]| -> Vec<Option<String>> {
        embeds.iter().map(|e| e.title.clone()).collect()
    };
    let mut seen = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        match ev {
            WsEvent::Message { message, .. } => seen.push(titles(&message.embeds)),
            WsEvent::EmbedsResolved { embeds, .. } => seen.push(titles(&embeds)),
            _ => {}
        }
    }
    let example = vec![Some(s("Example Domain"))];
    assert_eq!(seen, vec![example.clone(), example]);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn reposted_presence_mode_reads_the_database() {
    let (state, path) = crate::api::test_util::temp_state("ws_repost_mode").await;
    add_user(&state.db, "alice").await;
    exec(&state.db, "UPDATE users SET appear_offline = 1").await;
    let mode = |user: &str, appear_offline| WsEvent::PresenceMode {
        username: s(user),
        appear_offline,
        seq: 0,
    };
    assert!(matches!(
        current(&state, mode("alice", false)).await,
        Some(WsEvent::PresenceMode {
            appear_offline: true,
            ..
        })
    ));
    assert!(current(&state, mode("ghost", true)).await.is_none());
    crate::api::test_util::done(state, path).await;
}
