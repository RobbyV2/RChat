use std::collections::HashMap;

use tokio::time::Instant;

use super::*;
use crate::api::{Member, Message, Settings, UserRef};
use crate::db::now;
use crate::fanout::Topic;
use crate::ws::access::{Access, channel_gate, reauthorize};
use crate::ws::conn::look;
use crate::ws::filter::{event_channel, on_event, self_grant, track, wants};
use crate::ws::rewrite::presence_snapshot;

#[tokio::test]
async fn poll_updates_respect_the_read_history_floor() {
    let (state, path) = crate::api::test_util::temp_state("ws_poll_floor").await;
    let db = &state.db;
    for name in ["bob", "erin", "nina"] {
        add_user(db, name).await;
    }
    exec(db, "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1), ('rchat', 'erin', 500)").await;
    let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
        .fetch_one(db)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    let ev = |created_at: i64| WsEvent::PollUpdated {
        server: Some("rchat".to_string()),
        channel_id: Some(cid),
        dm_id: None,
        dm_users: None,
        message_id: 1,
        thread_root_id: None,
        created_at,
        poll: Box::new(crate::api::polls::sample_poll()),
    };
    let conn = state.hub.next_conn();
    let mut bob = Access::new(Some("bob".to_string()), false, set(&["rchat"]));
    let mut erin = Access::new(Some("erin".to_string()), false, set(&["rchat"]));
    let mut guest = Access::new(None, false, HashSet::new());
    guest.subs = set(&["rchat"]);
    for access in [&mut bob, &mut erin, &mut guest] {
        assert_eq!(
            on_event(&state, conn, access, &ev(100)).await,
            Some(true),
            "read history for all"
        );
    }
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:erin', 1, 1, 0)")
        .bind(cid)
        .execute(db)
        .await
        .unwrap();
    for access in [&mut bob, &mut erin, &mut guest] {
        access.viewable.clear();
        access.floors.clear();
    }
    assert_eq!(on_event(&state, conn, &mut bob, &ev(100)).await, Some(true));
    assert_eq!(
        on_event(&state, conn, &mut erin, &ev(100)).await,
        Some(false),
        "a poll from before erin joined"
    );
    assert_eq!(
        on_event(&state, conn, &mut erin, &ev(600)).await,
        Some(true)
    );
    assert_eq!(
        on_event(&state, conn, &mut guest, &ev(100)).await,
        Some(true)
    );
    let dm = WsEvent::PollUpdated {
        server: None,
        channel_id: None,
        dm_id: Some(1),
        dm_users: Some(vec!["bob".to_string(), "erin".to_string()]),
        message_id: 2,
        thread_root_id: None,
        created_at: 1,
        poll: Box::new(crate::api::polls::sample_poll()),
    };
    let mut nina = Access::new(Some("nina".to_string()), false, HashSet::new());
    assert_eq!(on_event(&state, conn, &mut erin, &dm).await, Some(true));
    assert_eq!(on_event(&state, conn, &mut nina, &dm).await, Some(false));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn replayed_messages_respect_the_read_history_floor() {
    let (state, path) = crate::api::test_util::temp_state("ws_replay_floor").await;
    let db = &state.db;
    for name in ["bob", "erin"] {
        add_user(db, name).await;
    }
    exec(db, "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1), ('rchat', 'erin', 500)").await;
    let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
        .fetch_one(db)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:erin', 1, 1, 0)")
        .bind(cid)
        .execute(db)
        .await
        .unwrap();
    let ev = |created_at: i64| WsEvent::Message {
        server: Some("rchat".to_string()),
        channel_id: Some(cid),
        dm_id: None,
        dm_users: None,
        message: Box::new(Message {
            channel_id: Some(cid),
            dm_id: None,
            created_at,
            edited_at: Some(created_at + 1),
            ..message()
        }),
    };
    let conn = state.hub.next_conn();
    let mut bob = Access::new(Some("bob".to_string()), false, set(&["rchat"]));
    let mut erin = Access::new(Some("erin".to_string()), false, set(&["rchat"]));
    assert_eq!(on_event(&state, conn, &mut bob, &ev(100)).await, Some(true));
    assert_eq!(
        on_event(&state, conn, &mut erin, &ev(100)).await,
        Some(false),
        "a replayed message from before erin joined"
    );
    assert_eq!(
        on_event(&state, conn, &mut erin, &ev(now())).await,
        Some(true)
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn channel_events_need_the_owning_server() {
    let (state, path) = crate::api::test_util::temp_state("ws_owner").await;
    let db = &state.db;
    add_user(db, "bob").await;
    exec(
        db,
        "INSERT INTO servers(name, display_name, created_at) VALUES('a', 'a', 1)",
    )
    .await;
    exec(
        db,
        "INSERT INTO servers(name, display_name, created_at) VALUES('b', 'b', 1)",
    )
    .await;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('b', 'bob', 1)",
    )
    .await;
    let text = insert_id(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('b', 'chat', 1) RETURNING id",
    )
    .await;
    let talk = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('b', 'talk', 'voice', 1) RETURNING id").await;
    let role = insert_id(
        db,
        "INSERT INTO roles(server, name, color, perms) VALUES('b', 'crew', '#fff', 0) RETURNING id",
    )
    .await;
    sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('b', 'bob', $1)")
        .bind(role)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, 1, 1, 1)")
        .bind(talk)
        .bind(format!("r:{role}"))
        .execute(db)
        .await
        .unwrap();
    crate::api::test_util::restrict_ruled(db).await;
    let mut bob = Access::new(Some(s("bob")), false, set(&["b"]));
    let mut guest = Access::new(None, false, HashSet::new());
    assert_eq!(channel_gate(&state, &mut bob, "a", text).await, Some(false));
    assert_eq!(bob.viewable.get(&text), Some(&(s("b"), true)));
    assert_eq!(channel_gate(&state, &mut bob, "b", text).await, Some(true));
    assert_eq!(channel_gate(&state, &mut bob, "a", text).await, Some(false));
    assert_eq!(channel_gate(&state, &mut bob, "b", talk).await, Some(true));
    assert_eq!(
        channel_gate(&state, &mut guest, "b", talk).await,
        Some(false)
    );
    track(&renamed("b", "c"), &mut bob);
    assert!(bob.viewable.is_empty());

    let conn = state.hub.next_conn();
    assert!(
        state
            .hub
            .voice_join("bob", conn, "a", talk)
            .await
            .is_empty()
    );
    evict_unviewable(&state, "a", None).await;
    assert_eq!(state.hub.rooms_in("a", None), vec![(talk, vec![s("bob")])]);
    crate::api::test_util::done(state, path).await;
}

#[test]
fn self_grants_are_recognized() {
    let author = message().author;
    let joined = WsEvent::MemberJoined {
        server: "vault".to_string(),
        member: Member {
            user: author,
            is_admin: false,
            is_creator: false,
            online: false,
            perms: 0,
            role_ids: Vec::new(),
            joined_via: None,
            timeout: None,
        },
    };
    assert_eq!(self_grant(&joined, Some("alice")), Some("vault"));
    assert_eq!(self_grant(&joined, Some("bob")), None);
    let created = |creator: Option<&str>| WsEvent::ServerCreated {
        server: ServerSummaryLite {
            name: "vault".to_string(),
            display_name: "vault".to_string(),
            creator: creator.map(str::to_string),
            has_password: true,
            banner_color: None,
            name_color: None,
        },
    };
    assert_eq!(
        self_grant(&created(Some("alice")), Some("alice")),
        Some("vault")
    );
    assert_eq!(self_grant(&created(None), None), None);
    assert_eq!(self_grant(&created(Some("alice")), None), None);
    let kicked = WsEvent::MemberKicked {
        server: "vault".to_string(),
        username: "alice".to_string(),
        banned: false,
    };
    assert_eq!(self_grant(&kicked, Some("alice")), None);
}

#[tokio::test]
async fn timeout_events_reach_only_the_member_and_moderators() {
    let (state, path) = crate::api::test_util::temp_state("timeout_events").await;
    let db = &state.db;
    for name in ["bob", "carol", "mo", "boss"] {
        add_user_row(db, name).await;
    }
    crate::api::test_util::add_member(db, "rchat", "bob", 0, 0, 0).await;
    crate::api::test_util::add_member(db, "rchat", "carol", 0, 0, 0).await;
    crate::api::test_util::add_member(db, "rchat", "mo", 0, 0, 0).await;
    crate::api::test_util::add_member(db, "rchat", "boss", 1, 0, 0).await;
    let role = insert_id(db, "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'mods', '#ffffff', 128) RETURNING id").await;
    sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'mo', $1)")
        .bind(role)
        .execute(db)
        .await
        .expect("role");
    let ev = WsEvent::MemberTimeout {
        server: s("rchat"),
        username: s("bob"),
        until: Some(now() + 60),
        remaining: 60,
        reason: Some(s("spam")),
    };
    let conn = state.hub.next_conn();
    for (user, site_admin, member, expected) in [
        ("bob", false, true, true),
        ("bob", false, false, true),
        ("mo", false, true, true),
        ("boss", false, true, true),
        ("carol", false, true, false),
        ("root", true, false, false),
    ] {
        let servers = match member {
            true => set(&["rchat"]),
            false => set(&[]),
        };
        let mut access = Access::new(Some(s(user)), site_admin, servers);
        assert_eq!(
            on_event(&state, conn, &mut access, &ev).await,
            Some(expected),
            "{user}"
        );
    }
    let mut guest = Access::new(None, false, set(&[]));
    guest.subs = set(&["rchat"]);
    assert_eq!(on_event(&state, conn, &mut guest, &ev).await, Some(false));
    crate::api::test_util::done(state, path).await;
}

#[test]
fn server_ban_notice_goes_only_to_the_banned_user() {
    let ev = WsEvent::ServerBanned {
        server: s("open"),
        username: s("bob"),
    };
    let none = set(&[]);
    assert!(wants(&ev, Some("bob"), false, &none, &none));
    assert!(!wants(
        &ev,
        Some("carol"),
        false,
        &set(&["open"]),
        &set(&["open"])
    ));
    assert!(!wants(&ev, None, false, &none, &set(&["open"])));
}

fn every_event() -> Vec<WsEvent> {
    let dm = || Some(vec![s("alice"), s("bob")]);
    let chan = Channel {
        id: 1,
        name: s("c"),
        kind: ChannelKind::Text,
        slowmode_seconds: 0,
        restrict_view: false,
        restrict_send: false,
        topic: None,
        category_id: None,
        position: 0,
    };
    let mut evs = Vec::new();
    for server in [Some(s("a")), Some(s("b")), None] {
        let dm_users = match server {
            Some(_) => None,
            None => dm(),
        };
        evs.push(WsEvent::Message {
            server: server.clone(),
            channel_id: Some(1),
            dm_id: None,
            dm_users: dm_users.clone(),
            message: Box::new(message()),
        });
        evs.push(WsEvent::MessageUpdated {
            server: server.clone(),
            channel_id: server.as_ref().map(|_| 1),
            update: Updated::full(message()),
            dm_users: dm_users.clone().unwrap_or_default(),
        });
        evs.push(WsEvent::PollUpdated {
            server: server.clone(),
            channel_id: server.as_ref().map(|_| 1),
            dm_id: None,
            dm_users: dm_users.clone(),
            message_id: 1,
            thread_root_id: None,
            created_at: 1,
            poll: Box::new(crate::api::polls::sample_poll()),
        });
        evs.push(WsEvent::MessageDeleted {
            server: server.clone(),
            channel_id: Some(1),
            dm_id: None,
            dm_users: dm_users.clone(),
            id: 1,
            thread_root_id: None,
        });
        evs.push(WsEvent::MessagesDeleted {
            server: server.clone(),
            channel_id: server.as_ref().map(|_| 1),
            dm_id: None,
            dm_users: dm_users.clone(),
            thread_root_id: None,
            ids: vec![1, 2],
            created: vec![1, 2],
        });
        evs.push(WsEvent::MediaRemoved {
            server: server.clone(),
            channel_id: Some(1),
            dm_id: None,
            dm_users: dm_users.clone(),
            message_id: 1,
            removed_by_author: false,
        });
        evs.push(WsEvent::EmbedsResolved {
            server: server.clone(),
            channel_id: Some(1),
            dm_id: None,
            dm_users: dm_users.clone(),
            message_id: 1,
            embeds: Vec::new(),
        });
        evs.push(WsEvent::EmbedsRemoved {
            server: server.clone(),
            channel_id: Some(1),
            dm_id: None,
            dm_users: dm_users.clone(),
            message_id: 1,
            ord: 0,
            banner: false,
        });
        evs.push(WsEvent::VoiceEnded {
            server,
            channel_id: Some(1),
            dm_id: None,
            dm_users,
            reason: s("r"),
        });
    }
    for server in ["a", "b", "z"] {
        for user in ["alice", "bob"] {
            evs.extend([
                joined(server, user),
                WsEvent::MemberLeft {
                    server: s(server),
                    username: s(user),
                },
                WsEvent::MemberKicked {
                    server: s(server),
                    username: s(user),
                    banned: true,
                },
                WsEvent::MembersPurged {
                    server: s(server),
                    usernames: vec![s(user)],
                },
                WsEvent::AdminChanged {
                    server: s(server),
                    username: s(user),
                    is_admin: true,
                    perms: 1,
                },
                WsEvent::ServerCreated {
                    server: ServerSummaryLite {
                        creator: Some(s(user)),
                        ..lite(server)
                    },
                },
                WsEvent::PresenceMode {
                    username: s(user),
                    appear_offline: true,
                    seq: 0,
                },
                WsEvent::ReadUpdated {
                    username: s(user),
                    scope: s("c1"),
                    last_read: 1,
                    pings_until: 0,
                },
                WsEvent::TokensRevoked { username: s(user) },
                WsEvent::DmClosed {
                    username: s(user),
                    dm_id: 1,
                },
                WsEvent::DmReopened {
                    username: s(user),
                    dm_id: 1,
                },
                WsEvent::GroupPingsSeen {
                    username: s(user),
                    scope: s("c1"),
                    message_ids: vec![1],
                },
                WsEvent::UserBlocked {
                    username: s(user),
                    blocked: crate::api::blocks::BlockedUser {
                        user: crate::api::missing_user("x"),
                        blocked_at: 1,
                    },
                },
                WsEvent::UserUnblocked {
                    username: s(user),
                    blocked: s("x"),
                },
                WsEvent::PollVoted {
                    username: s(user),
                    message_id: 1,
                },
                WsEvent::BulkDeleteProgress {
                    username: s(user),
                    job: crate::api::bulk_delete::BulkJob {
                        id: 1,
                        scope: s("c1"),
                        status: crate::api::bulk_delete::JobStatus::Running,
                        deleted: 0,
                        skipped: 0,
                        estimate: 1,
                        created_at: 1,
                        finished_at: None,
                        error: None,
                    },
                },
                WsEvent::FriendRequestAdded {
                    username: s(user),
                    request: crate::api::friends::FriendRequest {
                        user: crate::api::missing_user("x"),
                        created_at: 1,
                        incoming: true,
                    },
                },
                WsEvent::FriendRequestRemoved {
                    username: s(user),
                    other: s("x"),
                },
                WsEvent::FriendAdded {
                    username: s(user),
                    friend: crate::api::friends::Friend {
                        user: crate::api::missing_user("x"),
                        since: 1,
                        online: false,
                    },
                },
                WsEvent::FriendRemoved {
                    username: s(user),
                    friend: s("x"),
                },
                WsEvent::FriendPresence {
                    username: s(user),
                    friend: s("x"),
                    online: true,
                },
                WsEvent::PrivacyChanged {
                    username: s(user),
                    privacy: crate::api::friends::Privacy::default(),
                },
                WsEvent::RtcSignal {
                    to: s(user),
                    from: s("x"),
                    channel_id: None,
                    dm_id: Some(1),
                    payload: serde_json::Value::Null,
                },
                WsEvent::P2pAvailability {
                    hoster: s(user),
                    peer_id: None,
                    ids: Vec::new(),
                    online: false,
                    scope_servers: vec![s(server)],
                    scope_users: vec![s("carol")],
                },
                WsEvent::Banned { username: s(user) },
                WsEvent::UserUpdated {
                    user: UserRef {
                        username: s(user),
                        ..message().author
                    },
                    scope: UserScope {
                        servers: vec![s(server)],
                        views: Vec::new(),
                        users: vec![s("carol")],
                    },
                },
                WsEvent::UserUpdated {
                    user: UserRef {
                        username: s(user),
                        ..message().author
                    },
                    scope: UserScope {
                        servers: Vec::new(),
                        views: vec![s(server)],
                        users: Vec::new(),
                    },
                },
            ]);
        }
        evs.extend([
            WsEvent::ChannelCreated {
                server: s(server),
                channel: chan.clone(),
            },
            WsEvent::ChannelRenamed {
                server: s(server),
                channel: chan.clone(),
            },
            WsEvent::ChannelDeleted {
                server: s(server),
                channel_id: 1,
                rules: None,
            },
            WsEvent::RolesChanged { server: s(server) },
            WsEvent::ChannelPermsChanged {
                server: s(server),
                channel_id: 1,
            },
            WsEvent::VoiceState {
                server: s(server),
                channel_id: 1,
                users: Vec::new(),
            },
            WsEvent::ServerCreated {
                server: lite(server),
            },
            renamed(server, "q"),
            renamed("q", server),
            WsEvent::ServerDeleted { name: s(server) },
        ]);
    }
    evs.extend([
        WsEvent::CallState {
            dm_id: 1,
            dm_users: vec![s("alice"), s("bob")],
            state: CallPhase::Ringing,
            from: s("alice"),
            kind: CallKind::Rtc,
            video: false,
            call_id: None,
            answered_at: None,
            peers: Vec::new(),
            relays: Vec::new(),
        },
        WsEvent::CallState {
            dm_id: 1,
            dm_users: vec![s("alice"), s("bob")],
            state: CallPhase::Active,
            from: s("alice"),
            kind: CallKind::P2p,
            video: false,
            call_id: Some(s("c")),
            answered_at: Some(5),
            peers: vec![CallPeer {
                user: s("alice"),
                peer_id: s("pa"),
            }],
            relays: Vec::new(),
        },
        WsEvent::DmCreated {
            dm_id: 1,
            dm_users: vec![s("bob"), s("carol")],
        },
        WsEvent::UserUpdated {
            user: message().author,
            scope: UserScope::default(),
        },
        WsEvent::UserRegistered {
            user: message().author,
        },
        WsEvent::SettingsChanged {
            settings: Settings {
                profanity_filter: false,
                ..Settings::DENY
            },
        },
        WsEvent::Error {
            message: s("e"),
            reason: None,
        },
        WsEvent::P2pHosted {
            live: Vec::new(),
            checked: Vec::new(),
            key: s("k"),
            peer_id: s("p"),
            now: 1,
        },
        WsEvent::P2pPeer {
            message_id: 1,
            peer_id: Some(s("p")),
            token: Some(s("t")),
            expires_at: Some(2),
            error: None,
            relays: Vec::new(),
        },
        WsEvent::UserShown {
            username: s("alice"),
            online: true,
        },
        WsEvent::Resync,
    ]);
    evs
}

#[test]
fn routing_reaches_everyone_who_wants_an_event() {
    let mut alice = Access::new(Some(s("alice")), false, set(&["a"]));
    alice.subs = set(&["b"]);
    alice.viewing = Some(s("a"));
    let mut admin = Access::new(Some(s("bob")), true, set(&["b"]));
    admin.viewing = Some(s("b"));
    let mut guest = Access::new(None, false, HashSet::new());
    guest.subs = set(&["a"]);
    let mut held = Access::new(Some(s("carol")), false, set(&["a"]));
    held.retry.at = Some(Instant::now());
    let lurker = Access::new(Some(s("dave")), false, set(&["a", "b"]));
    let mut checked = 0;
    for access in [&alice, &admin, &guest, &held, &lurker] {
        let topics = access.topics();
        for ev in every_event() {
            if !access.wants(&ev) {
                continue;
            }
            checked += 1;
            let routed = match crate::fanout::route(&ev) {
                crate::fanout::Route::Everyone => true,
                crate::fanout::Route::To(targets) => targets.iter().any(|t| reaches(t, &topics)),
            };
            let viewer_only = match &ev {
                WsEvent::PresenceChanged { .. } => true,
                WsEvent::UserUpdated { user, scope } => {
                    !scope.views.is_empty() && access.user.as_ref() != Some(&user.username)
                }
                _ => false,
            };
            assert!(
                routed || viewer_only,
                "{:?} misses {}",
                access.user,
                to_bus_json(&ev).unwrap()
            );
        }
    }
    assert!(checked > 100);
    let presence = |server: &str| WsEvent::PresenceChanged {
        server: s(server),
        username: s("x"),
        online: true,
        online_count: 1,
    };
    fn viewers(ev: &WsEvent) -> Vec<crate::fanout::Target<'_>> {
        match crate::fanout::route(ev) {
            crate::fanout::Route::To(targets) => targets,
            crate::fanout::Route::Everyone => panic!("presence is never global"),
        }
    }
    assert!(
        viewers(&presence("a"))
            .iter()
            .any(|t| reaches(t, &alice.topics()))
    );
    assert!(
        viewers(&presence("b"))
            .iter()
            .any(|t| reaches(t, &alice.topics()))
    );
    assert!(
        viewers(&presence("a"))
            .iter()
            .any(|t| reaches(t, &guest.topics()))
    );
    assert!(
        !viewers(&presence("a"))
            .iter()
            .any(|t| reaches(t, &lurker.topics()))
    );
    assert!(!lurker.wants(&WsEvent::UserRegistered {
        user: message().author
    }));
}

#[tokio::test]
async fn shared_channel_cache_follows_permission_events() {
    let (state, path) = crate::api::test_util::temp_state("ws_channel_cache").await;
    let db = &state.db;
    add_user(db, "bob").await;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1)",
    )
    .await;
    let text = general(db).await;
    let mut bob = Access::new(Some(s("bob")), false, set(&["rchat"]));
    let mut guest = Access::new(None, false, set(&[]));
    assert_eq!(
        channel_gate(&state, &mut bob, "rchat", text).await,
        Some(true)
    );
    assert_eq!(
        channel_gate(&state, &mut guest, "rchat", text).await,
        Some(true)
    );
    assert_eq!(state.hub.channels().len(), 1);
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'r:999', 1, 1, 1)")
        .bind(text)
        .execute(db)
        .await
        .unwrap();
    crate::api::test_util::restrict_ruled(db).await;
    let mut late = Access::new(Some(s("bob")), false, set(&["rchat"]));
    assert_eq!(
        channel_gate(&state, &mut late, "rchat", text).await,
        Some(true)
    );
    state.hub.broadcast(WsEvent::ChannelPermsChanged {
        server: s("rchat"),
        channel_id: text,
    });
    let changed = WsEvent::ChannelPermsChanged {
        server: s("rchat"),
        channel_id: text,
    };
    track(&changed, &mut bob);
    track(&changed, &mut guest);
    assert_eq!(
        channel_gate(&state, &mut bob, "rchat", text).await,
        Some(false)
    );
    assert_eq!(
        channel_gate(&state, &mut guest, "rchat", text).await,
        Some(false)
    );
    let roles = WsEvent::RolesChanged { server: s("other") };
    track(&roles, &mut bob);
    assert_eq!(bob.viewable.len(), 1);
    track(&WsEvent::RolesChanged { server: s("rchat") }, &mut bob);
    assert!(bob.viewable.is_empty());
    exec(db, "DELETE FROM channel_perms").await;
    for (sql, open) in [
        (
            "UPDATE channels SET restrict_view = 0, restrict_send = 1",
            true,
        ),
        (
            "UPDATE channels SET restrict_view = 1, restrict_send = 0",
            false,
        ),
        (
            "UPDATE channels SET restrict_view = 0, restrict_send = 0",
            true,
        ),
    ] {
        exec(db, sql).await;
        state.hub.broadcast(changed.clone());
        track(&changed, &mut bob);
        track(&changed, &mut guest);
        assert_eq!(
            channel_gate(&state, &mut bob, "rchat", text).await,
            Some(open),
            "{sql}"
        );
        assert_eq!(
            channel_gate(&state, &mut guest, "rchat", text).await,
            Some(open),
            "{sql}"
        );
    }
    crate::api::test_util::done(state, path).await;
}

async fn routed(inbox: &mut crate::fanout::Inbox, hub: &Hub, ev: WsEvent) -> Option<WsEvent> {
    hub.broadcast(ev);
    let wait = tokio::time::sleep(Duration::from_millis(300));
    tokio::pin!(wait);
    loop {
        tokio::select! {
            got = inbox.rx.recv() => match got.map(|f| f.ev.clone()) {
                Some(ev @ WsEvent::Message { .. }) => return Some(ev),
                Some(_) => {}
                None => return None,
            },
            _ = &mut wait => return None,
        }
    }
}

#[tokio::test]
async fn a_non_member_viewer_of_an_open_server_gets_its_live_events() {
    let (state, path, general, secret) = peek_world("ws_peek_live").await;
    let conn = state.hub.next_conn();
    let mut inbox = state
        .hub
        .open(conn, &HashSet::from([Topic::User(s("nora"))]));
    let mut nora = Access::new(Some(s("nora")), false, set(&["home"]));
    assert_eq!(
        look(&state, conn, &mut nora, Some(s("Open"))).await,
        Some(s("open"))
    );
    state.hub.reconcile(conn, &nora.topics(), 0);
    assert_eq!(nora.peek.as_deref(), Some("open"));
    assert_eq!(nora.viewing, None);
    let topics = state.hub.topics(conn);
    assert!(topics.contains(&Topic::Server(s("open"))) && topics.contains(&Topic::View(s("open"))));
    let got = routed(&mut inbox, &state.hub, post_in("open", general))
        .await
        .expect("routed");
    assert_eq!(on_event(&state, conn, &mut nora, &got).await, Some(true));
    let hidden = routed(&mut inbox, &state.hub, post_in("open", secret))
        .await
        .expect("routed");
    assert_eq!(
        on_event(&state, conn, &mut nora, &hidden).await,
        Some(false)
    );
    assert!(presence_snapshot(&state.hub, &nora, "open").is_some());

    let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
    look(&state, state.hub.next_conn(), &mut alice, Some(s("open"))).await;
    assert_eq!(alice.peek, None);
    assert!(alice.subs.is_empty());
    assert_eq!(alice.viewing.as_deref(), Some("open"));

    look(&state, conn, &mut nora, Some(s("vault"))).await;
    state.hub.reconcile(conn, &nora.topics(), u64::MAX);
    assert_eq!(nora.peek, None);
    assert!(nora.subs.is_empty());
    let topics = state.hub.topics(conn);
    assert!(
        !topics
            .iter()
            .any(|t| matches!(t, Topic::Server(v) | Topic::View(v) if v == "open" || v == "vault"))
    );
    assert!(
        routed(&mut inbox, &state.hub, post_in("open", general))
            .await
            .is_none()
    );
    assert_eq!(
        on_event(&state, conn, &mut nora, &post_in("open", general)).await,
        Some(false)
    );

    look(&state, conn, &mut nora, Some(s("open"))).await;
    assert_eq!(nora.peek.as_deref(), Some("open"));
    look(&state, conn, &mut nora, Some(s("home"))).await;
    assert_eq!(nora.peek, None);
    assert_eq!(nora.viewing.as_deref(), Some("home"));
    assert!(!nora.topics().contains(&Topic::Server(s("open"))));
    look(&state, conn, &mut nora, Some(s("open"))).await;
    look(&state, conn, &mut nora, None).await;
    assert_eq!(nora.peek, None);
    assert!(!nora.topics().contains(&Topic::Server(s("open"))));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn a_non_member_viewer_loses_live_events_with_access() {
    let (state, path, general, _) = peek_world("ws_peek_lost").await;
    let db = &state.db;
    let conn = state.hub.next_conn();
    let mut nora = Access::new(Some(s("nora")), false, set(&["home"]));
    nora.viewable = HashMap::from([(general, (s("open"), true))]);

    look(&state, conn, &mut nora, Some(s("open"))).await;
    exec(
        db,
        "UPDATE servers SET password_hash = 'hash' WHERE name = 'open'",
    )
    .await;
    let locked = WsEvent::ServerUpdated {
        server: ServerSummaryLite {
            has_password: true,
            banner_color: None,
            name_color: None,
            ..lite("open")
        },
    };
    assert_eq!(
        on_event(&state, conn, &mut nora, &locked).await,
        Some(false)
    );
    assert_eq!(nora.peek, None);
    assert!(!nora.topics().contains(&Topic::Server(s("open"))));
    assert_eq!(
        on_event(&state, conn, &mut nora, &post_in("open", general)).await,
        Some(false)
    );
    assert!(reauthorize(&state, &mut nora).await.unwrap());
    assert_eq!(nora.peek, None);
    exec(
        db,
        "UPDATE servers SET password_hash = NULL WHERE name = 'open'",
    )
    .await;

    look(&state, conn, &mut nora, Some(s("open"))).await;
    nora.viewable = HashMap::from([(general, (s("open"), true))]);
    assert_eq!(
        on_event(&state, conn, &mut nora, &post_in("open", general)).await,
        Some(true)
    );
    exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('open', 'nora', 'alice', 2)").await;
    let banned = WsEvent::ServerBanned {
        server: s("open"),
        username: s("nora"),
    };
    assert_eq!(on_event(&state, conn, &mut nora, &banned).await, Some(true));
    assert_eq!((nora.peek.as_ref(), nora.looking.as_ref()), (None, None));
    assert!(!nora.topics().contains(&Topic::Server(s("open"))));
    assert_eq!(
        on_event(&state, conn, &mut nora, &post_in("open", general)).await,
        Some(false)
    );
    look(&state, conn, &mut nora, Some(s("open"))).await;
    assert_eq!(nora.peek, None);
    assert!(nora.subs.is_empty());
    assert!(reauthorize(&state, &mut nora).await.unwrap());
    assert_eq!(nora.peek, None);
    exec(db, "DELETE FROM server_bans").await;

    look(&state, conn, &mut nora, Some(s("open"))).await;
    let gone = WsEvent::ServerDeleted { name: s("open") };
    on_event(&state, conn, &mut nora, &gone).await;
    assert_eq!((nora.peek.as_ref(), nora.looking.as_ref()), (None, None));
    assert!(nora.subs.is_empty() && !nora.topics().contains(&Topic::Server(s("open"))));

    look(&state, conn, &mut nora, Some(s("open"))).await;
    assert!(nora.hold(sqlx::Error::PoolClosed, Instant::now()));
    assert!(!nora.wants(&post_in("open", general)));
    look(&state, conn, &mut nora, Some(s("open"))).await;
    assert_eq!(nora.peek, None);
    assert!(!nora.topics().contains(&Topic::Server(s("open"))));
    assert!(nora.refresh(&state, conn).await && !nora.retry.pending());
    assert_eq!(nora.peek.as_deref(), Some("open"));
    assert!(nora.wants(&post_in("open", general)));
    crate::api::test_util::done(state, path).await;
}

fn reaction_in(server: Option<&str>, cid: Option<i64>, dm: Option<i64>, added: bool) -> WsEvent {
    let (server, dm_users) = (server.map(s), dm.map(|_| vec![s("alice"), s("bob")]));
    let (message_id, thread_root_id, emoji, username) = (4, None, s("👍"), s("bob"));
    match added {
        true => WsEvent::ReactionAdded {
            server,
            channel_id: cid,
            dm_id: dm,
            dm_users,
            message_id,
            thread_root_id,
            emoji,
            username,
            count: 1,
        },
        false => WsEvent::ReactionRemoved {
            server,
            channel_id: cid,
            dm_id: dm,
            dm_users,
            message_id,
            thread_root_id,
            emoji,
            username,
            count: 0,
        },
    }
}

#[tokio::test]
async fn reactions_reach_only_those_who_can_see_the_channel() {
    let (state, path, general, secret) = peek_world("ws_reaction_routes").await;
    let conn = state.hub.next_conn();
    let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
    let mut nora = Access::new(Some(s("nora")), false, set(&["home"]));
    for added in [true, false] {
        let seen = reaction_in(Some("open"), Some(general), None, added);
        let hidden = reaction_in(Some("open"), Some(secret), None, added);
        assert_eq!(
            crate::fanout::route(&seen),
            crate::fanout::Route::To(vec![crate::fanout::Target::Server("open")])
        );
        assert_eq!(event_channel(&hidden), Some(("open", secret)));
        assert_eq!(on_event(&state, conn, &mut alice, &seen).await, Some(true));
        assert_eq!(
            on_event(&state, conn, &mut alice, &hidden).await,
            Some(false)
        );
        assert_eq!(on_event(&state, conn, &mut nora, &seen).await, Some(false));
        let dm = reaction_in(None, None, Some(7), added);
        assert_eq!(
            crate::fanout::route(&dm),
            crate::fanout::Route::To(vec![
                crate::fanout::Target::User("alice"),
                crate::fanout::Target::User("bob")
            ])
        );
        assert!(wants(
            &dm,
            Some("alice"),
            false,
            &HashSet::new(),
            &HashSet::new()
        ));
        assert!(!wants(
            &dm,
            Some("nora"),
            true,
            &set(&["open"]),
            &HashSet::new()
        ));
        let wire = serde_json::to_value(&seen).expect("json");
        assert_eq!(
            wire["type"],
            if added {
                "reaction_added"
            } else {
                "reaction_removed"
            }
        );
        assert_eq!(wire["emoji"], "👍");
        assert_eq!(wire["username"], "bob");
    }
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn edits_reach_only_those_who_can_see_the_channel() {
    let (state, path, general, secret) = peek_world("ws_edit_routes").await;
    let conn = state.hub.next_conn();
    let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
    let mut nora = Access::new(Some(s("nora")), false, set(&["home"]));
    let edit = |server: Option<&str>, channel_id: Option<i64>, dm_users: &[&str]| {
        WsEvent::MessageUpdated {
            server: server.map(s),
            channel_id,
            update: Updated::full(message()),
            dm_users: dm_users.iter().map(|u| s(u)).collect(),
        }
    };
    let seen = edit(Some("open"), Some(general), &[]);
    let hidden = edit(Some("open"), Some(secret), &[]);
    assert_eq!(
        crate::fanout::route(&seen),
        crate::fanout::Route::To(vec![crate::fanout::Target::Server("open")])
    );
    assert_eq!(event_channel(&seen), Some(("open", general)));
    assert_eq!(event_channel(&hidden), Some(("open", secret)));
    assert_eq!(on_event(&state, conn, &mut alice, &seen).await, Some(true));
    assert_eq!(
        on_event(&state, conn, &mut alice, &hidden).await,
        Some(false)
    );
    assert_eq!(on_event(&state, conn, &mut nora, &seen).await, Some(false));
    let dm = edit(None, None, &["alice", "bob"]);
    assert_eq!(event_channel(&dm), None);
    assert_eq!(
        crate::fanout::route(&dm),
        crate::fanout::Route::To(vec![
            crate::fanout::Target::User("alice"),
            crate::fanout::Target::User("bob")
        ])
    );
    assert!(wants(
        &dm,
        Some("alice"),
        false,
        &HashSet::new(),
        &HashSet::new()
    ));
    assert!(!wants(
        &dm,
        Some("nora"),
        true,
        &set(&["open"]),
        &HashSet::new()
    ));
    let wire = serde_json::to_value(&seen).expect("json");
    assert_eq!(wire["type"], "message_updated");
    assert_eq!(wire["server"], "open");
    assert_eq!(wire["channel_id"], general);
    assert!(wire.get("dm_users").is_none());
    let bus = to_bus_json(&WsEvent::MessageUpdated {
        server: None,
        channel_id: None,
        update: Updated::full(message()),
        dm_users: vec![s("alice"), s("bob")],
    })
    .expect("bus");
    let stub = WsEvent::MessageUpdated {
        server: Some(s("open")),
        channel_id: Some(secret),
        update: Updated::stub(7, Some(3), Some(99)),
        dm_users: Vec::new(),
    };
    assert_eq!(event_channel(&stub), Some(("open", secret)));
    assert_eq!(on_event(&state, conn, &mut alice, &stub).await, Some(false));
    let wire = serde_json::to_value(&stub).expect("json");
    assert_eq!(
        wire,
        serde_json::json!({"type": "message_updated", "server": "open", "channel_id": secret, "id": 7, "thread_root_id": 3, "edited_at": 99, "stub": true})
    );
    let back: WsEvent =
        serde_json::from_str(&to_bus_json(&stub).expect("bus")).expect("stub parses");
    assert!(matches!(
        back,
        WsEvent::MessageUpdated {
            update: Updated::Stub(EditStub {
                id: 7,
                thread_root_id: Some(3),
                edited_at: Some(99),
                stub: true
            }),
            ..
        }
    ));
    let back: WsEvent =
        serde_json::from_str(&to_bus_json(&seen).expect("bus")).expect("full parses");
    assert!(matches!(
        back,
        WsEvent::MessageUpdated { update: Updated::Full { message }, .. } if message.id == 4
    ));
    let routing = ",\"server\":null,\"channel_id\":null";
    assert!(bus.contains(routing));
    let old: WsEvent = serde_json::from_str(&bus.replace(routing, ""))
        .expect("an event without server and channel_id still parses");
    assert!(matches!(
        old,
        WsEvent::MessageUpdated {
            server: None,
            channel_id: None,
            update: Updated::Full { message: _ },
            dm_users
        } if dm_users.len() == 2
    ));
    crate::api::test_util::done(state, path).await;
}
