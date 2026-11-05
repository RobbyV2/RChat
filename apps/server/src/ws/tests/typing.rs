use super::*;
use crate::ws::filter::{event_channel, wants};
use crate::ws::typing::{Typer, typing_db};

#[tokio::test]
async fn dm_typing_reads_blocks_from_the_primary() {
    let (state, path) = crate::api::test_util::temp_state("ws_typing_primary").await;
    let (replica, replica_path) = crate::api::test_util::temp_state("ws_typing_replica").await;
    for db in [&state.db, &replica.db] {
        for name in ["bob", "carol"] {
            add_user_row(db, name).await;
        }
        exec(
            db,
            "INSERT INTO dms(id, user_a, user_b) VALUES(77, 'bob', 'carol')",
        )
        .await;
    }
    exec(
        &state.db,
        "INSERT INTO blocks(blocker, blocked, created_at) VALUES('carol', 'bob', 0)",
    )
    .await;
    let lagging = state.clone().with_reader(replica.db.clone());
    assert_eq!(
        Typer::new()
            .command(&lagging.read(), "bob", s("d77"), true)
            .await
            .len(),
        1,
        "the replica has not seen the block yet"
    );
    assert!(
        Typer::new()
            .command(&typing_db(&lagging, "d77"), "bob", s("d77"), true)
            .await
            .is_empty()
    );
    crate::api::test_util::done(replica, replica_path).await;
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn typing_follows_the_send_gate() {
    let (state, path) = crate::api::test_util::temp_state("ws_typing").await;
    let db = &state.db;
    for name in ["bob", "carol", "dave", "root", "erin"] {
        add_user_row(db, name).await;
    }
    crate::api::test_util::add_member(db, "rchat", "erin", 1, 0, 0).await;
    exec(
        db,
        "UPDATE users SET display_name = 'Bobby' WHERE username = 'bob'",
    )
    .await;
    exec(
        db,
        "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
    )
    .await;
    for name in ["bob", "carol"] {
        crate::api::test_util::add_member(db, "rchat", name, 0, 0, 0).await;
    }
    let chat = insert_id(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'chat', 0) RETURNING id",
    )
    .await;
    let news = insert_id(db, "INSERT INTO channels(server, name, created_at, restrict_send) VALUES('rchat', 'news', 0, 1) RETURNING id").await;
    let talk = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'talk', 'voice', 0) RETURNING id").await;
    let root = insert_id(db, "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'carol', 'hi', 1 FROM channels WHERE name = 'chat' RETURNING id").await;
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('bob', 'carol') RETURNING id",
    )
    .await;
    let read = state.read();
    let typed = |user: &'static str, scope: String, on: bool| {
        let read = read.clone();
        async move { Typer::new().command(&read, user, scope, on).await }
    };
    let shown = |evs: Vec<WsEvent>| match evs.as_slice() {
        [
            WsEvent::Typing {
                server,
                channel_id,
                dm_id,
                dm_users,
                scope: _,
                username,
                display_name,
                until,
            },
        ] => Some((
            server.clone(),
            channel_id.or(*dm_id),
            dm_users.clone(),
            username.clone(),
            display_name.clone(),
            *until > 0,
        )),
        _ => None,
    };
    assert_eq!(
        shown(typed("bob", format!("c{chat}"), true).await),
        Some((
            Some(s("rchat")),
            Some(chat),
            None,
            s("bob"),
            s("Bobby"),
            true
        ))
    );
    assert_eq!(
        shown(typed("bob", format!("t{root}"), true).await),
        Some((
            Some(s("rchat")),
            Some(chat),
            None,
            s("bob"),
            s("Bobby"),
            true
        ))
    );
    assert_eq!(
        shown(typed("carol", format!("d{dm}"), true).await),
        Some((
            None,
            Some(dm),
            Some(vec![s("bob"), s("carol")]),
            s("carol"),
            s("carol"),
            true
        ))
    );
    assert!(shown(typed("erin", format!("c{news}"), true).await).is_some());
    for (user, scope) in [
        ("carol", format!("c{news}")),
        ("bob", format!("c{talk}")),
        ("dave", format!("c{chat}")),
        ("dave", format!("d{dm}")),
        ("root", format!("c{chat}")),
        ("bob", "x1".to_string()),
        ("bob", "c".to_string()),
        ("bob", "c-1".to_string()),
        ("bob", "c999".to_string()),
        ("bob", format!("c{chat}{}", "0".repeat(30))),
    ] {
        assert!(
            typed(user, scope.clone(), true).await.is_empty(),
            "{user} {scope}"
        );
    }
    assert!(typed("bob", format!("c{chat}"), false).await.is_empty());

    let mut typer = Typer::new();
    let user = "bob";
    let first = typer.command(db, user, format!("c{chat}"), true).await;
    assert_eq!(first.len(), 1);
    assert!(
        typer
            .command(db, user, format!("c{chat}"), true)
            .await
            .is_empty()
    );
    let moved = typer.command(db, user, format!("d{dm}"), true).await;
    assert!(matches!(
        moved.as_slice(),
        [
            WsEvent::Typing { scope: a, until: 0, .. },
            WsEvent::Typing { scope: b, .. },
        ] if *a == format!("c{chat}") && *b == format!("d{dm}")
    ));
    let stopped = typer.command(db, user, format!("d{dm}"), false).await;
    assert!(matches!(
        stopped.as_slice(),
        [WsEvent::Typing { until: 0, .. }]
    ));
    assert!(
        typer
            .command(db, user, format!("d{dm}"), false)
            .await
            .is_empty()
    );
    assert!(typer.stop(user).is_none());
    typer.bucket.tokens = 0.0;
    assert!(
        typer
            .command(db, user, format!("d{dm}"), true)
            .await
            .is_empty()
    );
    typer.bucket.tokens = TYPING_BURST;
    assert_eq!(
        typer.command(db, user, format!("d{dm}"), true).await.len(),
        1
    );
    typer.bucket.tokens = -TYPING_BURST;
    let paced = typer.command(db, user, format!("d{dm}"), false).await;
    assert!(matches!(
        paced.as_slice(),
        [WsEvent::Typing { until: 0, .. }]
    ));
    assert_eq!(
        typer.command(db, user, format!("d{dm}"), true).await.len(),
        0
    );
    typer.bucket.tokens = TYPING_BURST;
    typer.command(db, user, format!("d{dm}"), true).await;
    assert!(typer.bucket.tokens >= 0.0);
    assert!(matches!(
        typer.stop(user),
        Some(WsEvent::Typing { until: 0, .. })
    ));
    let mut flood = Typer::new();
    for i in 0..50 {
        flood
            .command(db, user, format!("c{}", chat + i + 100), true)
            .await;
    }
    assert!(flood.bucket.tokens >= -TYPING_BURST);
    let mut canon = Typer::new();
    let first = canon.command(db, user, format!("c+{chat}"), true).await;
    assert!(matches!(
        first.as_slice(),
        [WsEvent::Typing { scope, .. }] if *scope == format!("c{chat}")
    ));
    assert!(
        canon
            .command(db, user, format!("c0{chat}"), true)
            .await
            .is_empty()
    );
    let stop = canon.command(db, user, format!("c{chat}"), false).await;
    assert!(matches!(
        stop.as_slice(),
        [WsEvent::Typing { until: 0, .. }]
    ));
    crate::api::test_util::done(state, path).await;
}

#[test]
fn typing_skips_the_typer_and_strangers() {
    let typing = |server: Option<&str>, dm_users: Option<Vec<String>>| WsEvent::Typing {
        server: server.map(s),
        channel_id: server.map(|_| 3),
        dm_id: dm_users.as_ref().map(|_| 4),
        dm_users,
        scope: s("c3"),
        username: s("bob"),
        display_name: s("Bob"),
        until: 9,
    };
    let channel = typing(Some("rchat"), None);
    let dm = typing(None, Some(vec![s("bob"), s("carol")]));
    let members = set(&["rchat"]);
    let none = HashSet::new();
    assert!(wants(&channel, Some("carol"), false, &members, &none));
    assert!(wants(&channel, None, false, &none, &members));
    assert!(!wants(&channel, Some("bob"), false, &members, &none));
    assert!(!wants(&channel, Some("dave"), true, &none, &none));
    assert!(wants(&dm, Some("carol"), false, &none, &none));
    assert!(!wants(&dm, Some("bob"), false, &none, &none));
    assert!(!wants(&dm, Some("dave"), true, &members, &none));
    assert_eq!(event_channel(&channel), Some(("rchat", 3)));
    assert_eq!(event_channel(&dm), None);
    let wire = to_bus_json(&dm).expect("bus json");
    assert!(matches!(
        serde_json::from_str::<WsEvent>(&wire),
        Ok(WsEvent::Typing { dm_users: Some(users), until: 9, .. }) if users.len() == 2
    ));
    assert_eq!(
        crate::fanout::route(&dm),
        crate::fanout::Route::To(vec![
            crate::fanout::Target::User("bob"),
            crate::fanout::Target::User("carol")
        ])
    );
}

#[test]
fn typing_is_paced_per_account() {
    let hub = Hub::new();
    let shown = (0..40).filter(|_| hub.typing_ok("bob")).count();
    assert_eq!(shown, crate::hub::TYPING_USER_BURST as usize);
    assert!(hub.typing_ok("carol"));
}
