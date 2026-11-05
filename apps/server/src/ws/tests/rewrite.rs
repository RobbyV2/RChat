use std::collections::HashMap;

use super::*;
use crate::api::access::ViewRules;
use crate::db::now;
use crate::ws::access::{Access, channel_gate};
use crate::ws::filter::{event_channel, on_event, track, wants};
use crate::ws::rewrite::{
    PRESENCE_SNAPSHOT_MAX, channel_for, client_frame, deleted_for, layout_for, own_timeout,
    poll_for, presence_snapshot,
};

#[tokio::test]
async fn after_vote_updates_carry_counts_only_for_voters() {
    let (state, path) = crate::api::test_util::temp_state("ws_poll_voters").await;
    let db = &state.db;
    for name in ["bob", "carol"] {
        add_user(db, name).await;
    }
    exec(db, "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1), ('rchat', 'carol', 1)").await;
    let pepper = crate::db::pepper(db).await.unwrap();
    for anonymous in [0, 1] {
        let id: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, kind, created_at) SELECT id, 'bob', 'q', 'poll', 5 FROM channels WHERE server = 'rchat' RETURNING id")
            .fetch_one(db)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        sqlx::query("INSERT INTO polls(message_id, kind, question, anonymous, results, created_at) VALUES($1, 'single', 'q', $2, 'after_vote', 5)")
            .bind(id)
            .bind(anonymous)
            .execute(db)
            .await
            .unwrap();
        let option: i64 = sqlx::query("INSERT INTO poll_options(message_id, position, text, created_at) VALUES($1, 0, 'a', 5) RETURNING id")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        let voter = match anonymous {
            0 => "bob".to_string(),
            _ => crate::api::polls::anonymous_key(&pepper, id, "bob", 1),
        };
        sqlx::query("INSERT INTO poll_votes(message_id, voter, option_id, value, created_at) VALUES($1, $2, $3, 1, 6)")
            .bind(id)
            .bind(voter)
            .bind(option)
            .execute(db)
            .await
            .unwrap();
        let ev = crate::api::polls::update_event(db, id)
            .await
            .unwrap()
            .unwrap();
        let mut bob = Access::new(Some("bob".to_string()), false, set(&["rchat"]));
        bob.since = Some(1);
        let mut carol = Access::new(Some("carol".to_string()), false, set(&["rchat"]));
        carol.since = Some(1);
        let counts = |ev: Option<WsEvent>| match ev {
            Some(WsEvent::PollUpdated { poll, .. }) => poll
                .results
                .map(|r| r.counts.iter().map(|c| c.count).collect::<Vec<_>>()),
            _ => None,
        };
        assert_eq!(
            counts(Some(ev.clone())),
            None,
            "the shared event hides counts"
        );
        assert_eq!(
            counts(poll_for(&state, &bob, &ev).await),
            Some(vec![1]),
            "the voter's own copy has them"
        );
        assert!(
            poll_for(&state, &carol, &ev).await.is_none(),
            "others get the shared event"
        );
        bob.since = Some(2);
        assert_eq!(
            poll_for(&state, &bob, &ev).await.is_some(),
            anonymous == 0,
            "an anonymous vote belongs to the account that cast it"
        );
    }
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn bulk_deletes_reach_viewers_with_only_the_ids_they_could_read() {
    let (state, path) = crate::api::test_util::temp_state("ws_bulk_floor").await;
    let db = &state.db;
    for name in ["bob", "erin", "nina", "zed"] {
        add_user(db, name).await;
    }
    exec(db, "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'bob', 1), ('rchat', 'erin', 500), ('rchat', 'zed', 1)").await;
    let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
        .fetch_one(db)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:erin', 1, 1, 0), ($1, 'u:zed', 0, 0, 0)")
        .bind(cid)
        .execute(db)
        .await
        .unwrap();
    let ev = |ids: Vec<i64>, created: Vec<i64>| WsEvent::MessagesDeleted {
        server: Some("rchat".to_string()),
        channel_id: Some(cid),
        dm_id: None,
        dm_users: None,
        thread_root_id: None,
        ids,
        created,
    };
    let conn = state.hub.next_conn();
    let mut bob = Access::new(Some("bob".to_string()), false, set(&["rchat"]));
    let mut erin = Access::new(Some("erin".to_string()), false, set(&["rchat"]));
    let mut zed = Access::new(Some("zed".to_string()), false, set(&["rchat"]));
    let mixed = ev(vec![9, 8, 7], vec![700, 600, 100]);
    assert_eq!(on_event(&state, conn, &mut bob, &mixed).await, Some(true));
    assert!(deleted_for(&state, &mut bob, &mixed).await.is_none());
    assert_eq!(on_event(&state, conn, &mut zed, &mixed).await, Some(false));
    assert_eq!(on_event(&state, conn, &mut erin, &mixed).await, Some(true));
    let Some(WsEvent::MessagesDeleted { ids, .. }) = deleted_for(&state, &mut erin, &mixed).await
    else {
        panic!("erin gets her own copy");
    };
    assert_eq!(ids, vec![9, 8]);
    let old = ev(vec![3, 2], vec![100, 200]);
    assert_eq!(on_event(&state, conn, &mut erin, &old).await, Some(false));
    assert_eq!(on_event(&state, conn, &mut bob, &old).await, Some(true));
    let client = serde_json::to_string(&mixed).unwrap();
    assert!(client.contains(r#""ids":[9,8,7]"#) && !client.contains("created"));
    assert!(
        to_bus_json(&mixed)
            .unwrap()
            .contains(r#""created":[700,600,100]"#)
    );
    let dm = WsEvent::MessagesDeleted {
        server: None,
        channel_id: None,
        dm_id: Some(1),
        dm_users: Some(vec!["bob".to_string(), "erin".to_string()]),
        thread_root_id: None,
        ids: vec![5],
        created: vec![1],
    };
    let mut nina = Access::new(Some("nina".to_string()), false, HashSet::new());
    assert_eq!(on_event(&state, conn, &mut erin, &dm).await, Some(true));
    assert_eq!(on_event(&state, conn, &mut nina, &dm).await, Some(false));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn the_member_gets_their_timeout_without_the_reason() {
    let (state, path) = crate::api::test_util::temp_state("timeout_reason").await;
    let db = &state.db;
    for name in ["bob", "mo"] {
        add_user_row(db, name).await;
        crate::api::test_util::add_member(db, "rchat", name, 0, 0, 0).await;
    }
    let role = insert_id(db, "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'mods', '#ffffff', 128) RETURNING id").await;
    sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'mo', $1)")
        .bind(role)
        .execute(db)
        .await
        .expect("role");
    let ev = |username: &str| WsEvent::MemberTimeout {
        server: s("rchat"),
        username: s(username),
        until: Some(now() + 60),
        remaining: 60,
        reason: Some(s("spam")),
    };
    let reason_of = |ev: &WsEvent| match ev {
        WsEvent::MemberTimeout {
            server: _,
            username: _,
            until: _,
            remaining: _,
            reason,
        } => reason.clone(),
        _ => panic!("not a timeout"),
    };
    let fanned = crate::fanout::Fanned::new(ev("bob"), 1);
    assert!(
        client_frame(&fanned, Some("bob")).is_none(),
        "the shared frame (with the reason) never goes to the member"
    );
    let mod_frame = client_frame(&fanned, Some("mo")).expect("moderators get the frame");
    assert!(mod_frame.as_str().contains("spam"));
    let mut bob = Access::new(Some(s("bob")), false, set(&["rchat"]));
    let mine = own_timeout(&state, &mut bob, &ev("bob"))
        .await
        .expect("open")
        .expect("bob's own event");
    assert_eq!(reason_of(&mine), None);
    assert!(!serde_json::to_string(&mine).unwrap().contains("spam"));
    let mut mo = Access::new(Some(s("mo")), false, set(&["rchat"]));
    assert!(matches!(
        own_timeout(&state, &mut mo, &ev("bob")).await,
        Some(None)
    ));
    let mine = own_timeout(&state, &mut mo, &ev("mo"))
        .await
        .expect("open")
        .expect("mo's own event");
    assert_eq!(
        reason_of(&mine),
        Some(s("spam")),
        "a member who holds Timeout members sees the reason of their own"
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn viewing_snapshot_is_bounded_and_counts_the_viewer() {
    let hub = Hub::new();
    let mut names: Vec<String> = (0..60).map(|i| format!("u{i:02}")).collect();
    for (i, name) in names.iter().enumerate() {
        hub.set_online(name, 100 + i as u64, &["rchat"]);
    }
    let mut me = viewer("aaron", false);
    me.view(&hub, 1, Some(s("rchat")));
    let Some(WsEvent::PresenceSnapshot {
        server,
        online,
        online_count,
    }) = presence_snapshot(&hub, &me, "rchat")
    else {
        panic!("snapshot");
    };
    names.insert(0, s("aaron"));
    names.truncate(PRESENCE_SNAPSHOT_MAX);
    assert_eq!(
        (server.as_str(), online, online_count),
        ("rchat", names, 61)
    );
    let hidden = viewer("zed", true);
    let Some(WsEvent::PresenceSnapshot {
        online,
        online_count,
        ..
    }) = presence_snapshot(&hub, &hidden, "rchat")
    else {
        panic!("snapshot");
    };
    assert!(!online.iter().any(|n| n == "zed"));
    assert_eq!(online_count, 61);
    let mut early = viewer("ab", false);
    early.announced = true;
    let Some(WsEvent::PresenceSnapshot {
        online,
        online_count,
        ..
    }) = presence_snapshot(&hub, &early, "rchat")
    else {
        panic!("snapshot");
    };
    assert_eq!(
        (online.len(), &online[..3], online_count),
        (50, &[s("aaron"), s("ab"), s("u00")][..], 62)
    );
    assert!(presence_snapshot(&hub, &me, "elsewhere").is_none());
    let ev = presence_snapshot(&hub, &me, "rchat").expect("snapshot");
    assert!(!wants(
        &ev,
        Some("aaron"),
        true,
        &set(&["rchat"]),
        &set(&[])
    ));
}

#[test]
fn purged_members_get_their_own_kick() {
    let fanned = crate::fanout::Fanned::new(
        WsEvent::MembersPurged {
            server: s("club"),
            usernames: vec![s("bob"), s("carol")],
        },
        1,
    );
    assert_eq!(
        client_frame(&fanned, Some("carol")).unwrap().as_str(),
        r#"{"type":"member_kicked","server":"club","username":"carol","banned":false}"#
    );
    assert_eq!(
        client_frame(&fanned, Some("alice")).unwrap().as_str(),
        r#"{"type":"roles_changed","server":"club"}"#
    );
    let mut carol = Access::new(Some(s("carol")), false, set(&["club", "rchat"]));
    carol.viewing = Some(s("club"));
    track(&fanned.ev, &mut carol);
    assert_eq!(carol.member_servers, set(&["rchat"]));
    assert!(carol.viewing.is_none() && carol.topics_dirty);
    let mut alice = Access::new(Some(s("alice")), false, set(&["club"]));
    track(&fanned.ev, &mut alice);
    assert_eq!(alice.member_servers, set(&["club"]));
}

#[tokio::test]
async fn layout_changes_only_carry_viewable_channels() {
    let (state, path, general, secret) = peek_world("layout_filter").await;
    let db = &state.db;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('open', 'nora', 1)",
    )
    .await;
    exec(
        db,
        "UPDATE members SET is_admin = 1 WHERE server = 'open' AND username = 'alice'",
    )
    .await;
    let hidden = insert_id(db, "INSERT INTO channel_categories(server, name, position, created_at) VALUES('open', 'Staff', 0, 1) RETURNING id").await;
    let empty = insert_id(db, "INSERT INTO channel_categories(server, name, position, created_at) VALUES('open', 'Later', 1, 1) RETURNING id").await;
    sqlx::query("UPDATE channels SET category_id = $1 WHERE id = $2")
        .bind(hidden)
        .bind(secret)
        .execute(db)
        .await
        .unwrap();
    let layout = crate::api::categories::current_layout(db, "open")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(layout.uncategorized, [general]);
    assert_eq!(
        layout.categories.iter().map(|c| c.id).collect::<Vec<_>>(),
        [hidden, empty]
    );
    let ev = WsEvent::LayoutChanged {
        server: s("open"),
        layout: layout.clone(),
        created: None,
        deleted: None,
    };
    let fanned = crate::fanout::Fanned::new(ev.clone(), 1);
    assert!(client_frame(&fanned, Some("nora")).is_none());
    let mut nora = Access::new(Some(s("nora")), false, set(&["open"]));
    assert_eq!(on_event(&state, 1, &mut nora, &ev).await, Some(true));
    let mine = layout_for(&state, &mut nora, "open", &layout, None, None)
        .await
        .unwrap()
        .unwrap();
    let json = serde_json::to_string(&mine).unwrap();
    assert!(json.contains("\"type\":\"layout_changed\""), "{json}");
    assert!(!json.contains(&format!("{secret}")), "{json}");
    assert!(!json.contains("Staff") && !json.contains("Later"), "{json}");
    match mine {
        WsEvent::LayoutChanged {
            server,
            layout,
            created: _,
            deleted: _,
        } => {
            assert_eq!(server, "open");
            assert_eq!(layout.uncategorized, [general]);
            assert!(layout.categories.is_empty());
        }
        _ => panic!("expected layout_changed"),
    }
    let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
    match layout_for(&state, &mut alice, "open", &layout, None, None)
        .await
        .unwrap()
        .unwrap()
    {
        WsEvent::LayoutChanged {
            server: _,
            layout: got,
            created: _,
            deleted: _,
        } => assert_eq!(got, layout),
        _ => panic!("expected layout_changed"),
    }
    let mut stranger = Access::new(Some(s("zed")), false, HashSet::new());
    assert_eq!(on_event(&state, 2, &mut stranger, &ev).await, Some(false));
    let stale = WsEvent::LayoutChanged {
        server: s("open"),
        layout: crate::api::ChannelLayout {
            version: 0,
            uncategorized: Vec::new(),
            categories: Vec::new(),
        },
        created: Some(secret),
        deleted: None,
    };
    match current(&state, stale).await {
        Some(WsEvent::LayoutChanged {
            server: _,
            layout: got,
            created,
            deleted: None,
        }) => {
            assert_eq!(got, layout);
            assert_eq!(created, Some(secret));
        }
        _ => panic!("expected the stored layout"),
    }
    crate::api::test_util::done(state, path).await;
}
#[tokio::test]
async fn channel_events_reach_only_viewers_with_their_own_positions() {
    let (state, path, general, secret) = peek_world("channel_event_positions").await;
    let db = &state.db;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('open', 'nora', 1)",
    )
    .await;
    let after = insert_id(db, "INSERT INTO channels(server, name, created_at, position) VALUES('open', 'after', 1, 2) RETURNING id").await;
    exec(db, "UPDATE channels SET position = 1 WHERE name = 'secret'").await;
    let (_, hidden) = channel_now(db, secret).await.unwrap().unwrap();
    let (_, shown) = channel_now(db, after).await.unwrap().unwrap();
    assert_eq!(shown.position, 2);
    let layout = crate::api::categories::current_layout(db, "open")
        .await
        .unwrap()
        .unwrap();
    let created = WsEvent::ChannelCreated {
        server: s("open"),
        channel: hidden.clone(),
    };
    assert_eq!(event_channel(&created), Some(("open", secret)));
    let fanned = crate::fanout::Fanned::new(created.clone(), 1);
    assert!(client_frame(&fanned, Some("nora")).is_none());
    let mut nora = Access::new(Some(s("nora")), false, set(&["open"]));
    assert_eq!(on_event(&state, 1, &mut nora, &created).await, Some(false));
    assert!(
        matches!(
            layout_for(&state, &mut nora, "open", &layout, Some(secret), None).await,
            Some(None)
        ),
        "creating a hidden channel sends its non-viewers no layout either"
    );
    for ev in [
        WsEvent::ChannelCreated {
            server: s("open"),
            channel: shown.clone(),
        },
        WsEvent::ChannelRenamed {
            server: s("open"),
            channel: shown.clone(),
        },
        WsEvent::ChannelUpdated {
            server: s("open"),
            channel: shown.clone(),
        },
    ] {
        let fanned = crate::fanout::Fanned::new(ev.clone(), 2);
        assert!(client_frame(&fanned, Some("nora")).is_none());
        assert_eq!(on_event(&state, 1, &mut nora, &ev).await, Some(true));
        let mine = channel_for(&state, &mut nora, &fanned)
            .await
            .unwrap()
            .expect("own frame");
        let wire = serde_json::to_value(&mine).unwrap();
        assert_eq!(wire["type"], serde_json::to_value(&ev).unwrap()["type"]);
        assert_eq!(wire["channel"]["id"], after);
        assert_eq!(
            wire["channel"]["position"], 1,
            "the hidden channel in between is not counted"
        );
    }
    assert!(matches!(
        layout_for(&state, &mut nora, "open", &layout, Some(after), None).await,
        Some(Some(WsEvent::LayoutChanged { .. }))
    ));
    let other = crate::fanout::Fanned::new(post_in("open", general), 3);
    assert!(matches!(
        channel_for(&state, &mut nora, &other).await,
        Some(None)
    ));
    exec(
        db,
        "UPDATE members SET is_admin = 1 WHERE server = 'open' AND username = 'alice'",
    )
    .await;
    let mut alice = Access::new(Some(s("alice")), false, set(&["open"]));
    assert_eq!(on_event(&state, 2, &mut alice, &created).await, Some(true));
    let fanned = crate::fanout::Fanned::new(
        WsEvent::ChannelRenamed {
            server: s("open"),
            channel: shown.clone(),
        },
        4,
    );
    match channel_for(&state, &mut alice, &fanned).await {
        Some(Some(WsEvent::ChannelRenamed { server: _, channel })) => {
            assert_eq!(channel.position, 2)
        }
        _ => panic!("expected channel_renamed"),
    }
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn channel_deleted_reaches_only_those_who_could_view_it() {
    let (state, path, general, secret) = peek_world("channel_deleted_viewers").await;
    let db = &state.db;
    add_user(db, "vic").await;
    add_user(db, "max").await;
    for sql in [
        "INSERT INTO members(server, username, joined_at) VALUES('open', 'nora', 1)",
        "INSERT INTO members(server, username, joined_at) VALUES('open', 'vic', 1)",
        "INSERT INTO members(server, username, joined_at) VALUES('open', 'max', 1)",
        "UPDATE members SET is_admin = 1 WHERE server = 'open' AND username = 'alice'",
    ] {
        exec(db, sql).await;
    }
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:vic', 1, 1, 1)")
        .bind(secret)
        .execute(db)
        .await
        .unwrap();
    let rules = crate::api::access::ws_view_rules(db, secret).await.unwrap();
    let open = crate::api::access::ws_view_rules(db, general)
        .await
        .unwrap();
    let mut warm_nora = Access::new(Some(s("nora")), false, set(&["open"]));
    let mut warm_vic = Access::new(Some(s("vic")), false, set(&["open"]));
    assert_eq!(
        channel_gate(&state, &mut warm_nora, "open", secret).await,
        Some(false)
    );
    assert_eq!(
        channel_gate(&state, &mut warm_vic, "open", secret).await,
        Some(true)
    );
    exec(db, "DELETE FROM channel_perms").await;
    sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(secret)
        .execute(db)
        .await
        .unwrap();
    let deleted = |rules: Option<ViewRules>| WsEvent::ChannelDeleted {
        server: s("open"),
        channel_id: secret,
        rules,
    };
    let ev = deleted(Some(rules.clone()));
    let wire = serde_json::to_string(&ev).unwrap();
    assert!(!wire.contains("rules") && !wire.contains("u:vic"), "{wire}");
    let back: WsEvent = serde_json::from_str(&to_bus_json(&ev).unwrap()).unwrap();
    assert!(matches!(&back, WsEvent::ChannelDeleted { rules: Some(r), .. } if r.rules.len() == 2));
    let old: WsEvent = serde_json::from_str(&wire).unwrap();
    assert!(matches!(&old, WsEvent::ChannelDeleted { rules: None, .. }));
    let fanned = crate::fanout::Fanned::new(back.clone(), 1);
    assert_eq!(
        client_frame(&fanned, Some("nora")).as_deref(),
        Some(wire.as_str())
    );
    for (user, want) in [
        ("nora", false),
        ("max", false),
        ("vic", true),
        ("alice", true),
    ] {
        let mut cold = Access::new(Some(s(user)), false, set(&["open"]));
        assert_eq!(
            on_event(&state, 1, &mut cold, &back).await,
            Some(want),
            "{user}"
        );
    }
    let mut guest = Access::new(None, false, HashSet::new());
    guest.subs.insert(s("open"));
    assert_eq!(on_event(&state, 1, &mut guest, &back).await, Some(false));
    assert_eq!(
        on_event(&state, 1, &mut warm_nora, &back).await,
        Some(false)
    );
    assert!(warm_nora.viewable.is_empty());
    assert_eq!(on_event(&state, 1, &mut warm_vic, &back).await, Some(true));
    assert!(warm_vic.viewable.is_empty());
    let mut cold_vic = Access::new(Some(s("vic")), false, set(&["open"]));
    assert_eq!(
        on_event(&state, 1, &mut cold_vic, &old).await,
        Some(false),
        "no rules, no memo"
    );
    let mut warm_vic = Access::new(Some(s("vic")), false, set(&["open"]));
    warm_vic.viewable = HashMap::from([(secret, (s("open"), true))]);
    assert_eq!(
        on_event(&state, 1, &mut warm_vic, &old).await,
        Some(true),
        "the memo decides"
    );
    let mut nora = Access::new(Some(s("nora")), false, set(&["open"]));
    let public = WsEvent::ChannelDeleted {
        server: s("open"),
        channel_id: general,
        rules: Some(open),
    };
    assert_eq!(on_event(&state, 1, &mut nora, &public).await, Some(true));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn deleting_a_hidden_channel_sends_its_non_viewers_no_layout() {
    let (state, path, general, secret) = peek_world("layout_after_delete").await;
    let db = &state.db;
    add_user(db, "vic").await;
    for sql in [
        "INSERT INTO members(server, username, joined_at) VALUES('open', 'nora', 1)",
        "INSERT INTO members(server, username, joined_at) VALUES('open', 'vic', 1)",
        "UPDATE members SET is_admin = 1 WHERE server = 'open' AND username = 'alice'",
    ] {
        exec(db, sql).await;
    }
    let after = insert_id(db, "INSERT INTO channels(server, name, created_at, position) VALUES('open', 'after', 1, 2) RETURNING id").await;
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:vic', 1, 1, 1)")
        .bind(secret)
        .execute(db)
        .await
        .unwrap();
    let rules = crate::api::access::ws_view_rules(db, secret).await.unwrap();
    let shown = crate::api::access::ws_view_rules(db, after).await.unwrap();
    sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(secret)
        .execute(db)
        .await
        .unwrap();
    let layout = crate::api::categories::current_layout(db, "open")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(layout.uncategorized, [general, after]);
    let ev = WsEvent::LayoutChanged {
        server: s("open"),
        layout: layout.clone(),
        created: None,
        deleted: Some(rules.clone()),
    };
    let wire = serde_json::to_string(&ev).unwrap();
    assert!(
        !wire.contains("deleted") && !wire.contains("u:vic"),
        "{wire}"
    );
    let back: WsEvent = serde_json::from_str(&to_bus_json(&ev).unwrap()).unwrap();
    let Some(WsEvent::LayoutChanged {
        server: _,
        layout: _,
        created: None,
        deleted: Some(kept),
    }) = current(&state, back).await
    else {
        panic!("expected layout_changed with its deleted rules");
    };
    for (user, sent) in [("nora", false), ("vic", true), ("alice", true)] {
        let mut access = Access::new(Some(s(user)), false, set(&["open"]));
        assert_eq!(on_event(&state, 1, &mut access, &ev).await, Some(true));
        let mine = layout_for(&state, &mut access, "open", &layout, None, Some(&kept))
            .await
            .unwrap();
        assert_eq!(mine.is_some(), sent, "{user}");
    }
    let mut nora = Access::new(Some(s("nora")), false, set(&["open"]));
    assert!(
        matches!(
            layout_for(&state, &mut nora, "open", &layout, None, Some(&shown)).await,
            Some(Some(WsEvent::LayoutChanged { .. }))
        ),
        "deleting a channel they could view still updates their layout"
    );
    crate::api::test_util::done(state, path).await;
}
