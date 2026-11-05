use std::collections::{BTreeMap, HashMap};

use tokio::time::Instant;

use super::*;
use crate::api::access::{USER_SCOPE_SERVERS, ws_live_hosted};
use crate::db::{MediaKind, now};
use crate::ws::access::Access;
use crate::ws::filter::{on_event, track};
use crate::ws::p2p::{
    NOT_AVAILABLE, RelaySet, Who, hosting_ids, hosting_relays, p2p_offline, p2p_release, p2p_scope,
    p2p_visible,
};
use crate::ws::protocol::ClientMsg;

#[tokio::test]
async fn p2p_who_answers_only_shared_scopes_and_readable_ids() {
    let (state, path) = crate::api::test_util::temp_state("p2p_who_scope").await;
    let db = &state.db;
    for name in ["alice", "bob", "carol", "eve"] {
        add_user_row(db, name).await;
    }
    exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 0)").await;
    let vault = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('vault', 'general', 'text', 0) RETURNING id").await;
    let general = insert_id(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
    for (server, user) in [("rchat", "alice"), ("vault", "alice"), ("rchat", "bob")] {
        sqlx::query(
            "INSERT INTO members(server, username, is_admin, joined_at) VALUES($1, $2, 0, 0)",
        )
        .bind(server)
        .bind(user)
        .execute(db)
        .await
        .expect("member");
    }
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id",
    )
    .await;
    let ids: Vec<String> = ["f1", "f2", "f3", "f4"].map(str::to_string).to_vec();
    for (id, channel, dm_id) in [
        ("f1", Some(general), None),
        ("f2", Some(vault), None),
        ("f3", None, Some(dm)),
    ] {
        sqlx::query("INSERT INTO messages(channel_id, dm_id, author, content, media_id, media_kind, media_hoster, created_at) VALUES($1, $2, 'alice', '', $3, 'p2p', 'alice', 0)")
            .bind(channel)
            .bind(dm_id)
            .bind(id)
            .execute(db)
            .await
            .expect("p2p message");
    }
    state
        .hub
        .set_p2p("alice", 1, "peer-a".to_string(), ids.clone());
    let ask = |me: &'static str, servers: &[&str]| {
        let mut access = Access::new(Some(s(me)), false, set(servers));
        let state = state.clone();
        async move { p2p_visible(&state, &mut access, me, "alice").await }
    };
    assert_eq!(ask("bob", &["rchat"]).await, Some(vec![s("f1")]));
    let mut carol = ask("carol", &[]).await.expect("dm partner");
    carol.sort();
    assert_eq!(carol, [s("f1"), s("f3")]);
    assert_eq!(ask("eve", &[]).await, None);
    let mut own = ask("alice", &["rchat", "vault"]).await.expect("self");
    own.sort();
    assert_eq!(own, ids);
    exec(
        db,
        "UPDATE users SET appear_offline = 1 WHERE username = 'alice'",
    )
    .await;
    assert_eq!(ask("bob", &["rchat"]).await, None);
    assert_eq!(ask("carol", &[]).await, None);
    exec(
        db,
        "UPDATE users SET appear_offline = 0 WHERE username = 'alice'",
    )
    .await;
    let mut bob = Access::new(Some(s("bob")), false, set(&["rchat"]));
    let first = p2p_visible(&state, &mut bob, "bob", "alice").await;
    assert_eq!(first, Some(vec![s("f1")]));
    assert_eq!((bob.who.peers.len(), bob.who.media.len()), (1, 4));
    exec(db, "DELETE FROM messages WHERE media_id = 'f1'").await;
    assert_eq!(
        p2p_visible(&state, &mut bob, "bob", "alice").await,
        first,
        "a burst within the cache window reuses the scope lookups"
    );
    exec(
        db,
        "UPDATE users SET appear_offline = 1 WHERE username = 'alice'",
    )
    .await;
    assert_eq!(
        p2p_visible(&state, &mut bob, "bob", "alice").await,
        None,
        "appear offline applies at once, even within the cache window"
    );
    let left = WsEvent::MemberLeft {
        server: s("rchat"),
        username: s("bob"),
    };
    track(&left, &mut bob);
    assert!(bob.who.peers.is_empty() && bob.who.media.is_empty());
    bob.member_servers = set(&["rchat"]);
    assert_eq!(p2p_visible(&state, &mut bob, "bob", "alice").await, None);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn p2p_who_keeps_the_read_history_floor_and_the_p2p_switch() {
    let (state, path) = crate::api::test_util::temp_state("p2p_who_floor").await;
    let db = &state.db;
    for name in ["alice", "bob", "dave"] {
        add_user_row(db, name).await;
    }
    let general = insert_id(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
    for (user, joined) in [("alice", 0), ("bob", 50), ("dave", 50)] {
        sqlx::query(
            "INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, $2)",
        )
        .bind(user)
        .bind(joined)
        .execute(db)
        .await
        .expect("member");
    }
    exec(db, "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) SELECT id, 'u:bob', 1, 1, 0 FROM channels WHERE server = 'rchat'").await;
    for (id, at) in [("old", 10), ("new", 60)] {
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_kind, media_hoster, created_at) VALUES($1, 'alice', '', $2, 'p2p', 'alice', $3)")
            .bind(general)
            .bind(id)
            .bind(at)
            .execute(db)
            .await
            .expect("p2p message");
    }
    let ids = vec![s("old"), s("new")];
    state.hub.set_p2p("alice", 1, s("peer-a"), ids.clone());
    let ask = |me: &'static str| {
        let mut access = Access::new(Some(s(me)), false, set(&["rchat"]));
        let state = state.clone();
        async move { p2p_visible(&state, &mut access, me, "alice").await }
    };
    assert_eq!(
        ask("bob").await,
        Some(vec![s("new")]),
        "no read history: only files posted since joining"
    );
    let mut dave = ask("dave").await.expect("dave");
    dave.sort();
    assert_eq!(dave, [s("new"), s("old")]);
    exec(
        db,
        "INSERT INTO settings(key, value) VALUES('p2p_attachments', '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
    )
    .await;
    crate::api::Settings::forget(db);
    assert_eq!(
        ask("dave").await,
        Some(Vec::new()),
        "with P2P attachments off no file is offered; the peer stays for calls"
    );
    let mut live = ws_live_hosted(db, "alice", &[s("old"), s("gone"), s("new")])
        .await
        .expect("live");
    live.sort();
    assert_eq!(live, [s("new"), s("old")]);
    assert_eq!(
        ws_live_hosted(db, "bob", &ids).await,
        Some(Vec::new()),
        "only the hoster's own messages count, so a shared browser adopts no one else's file"
    );
    exec(
        db,
        "UPDATE messages SET media_removed = 2 WHERE media_id = 'old'",
    )
    .await;
    exec(
        db,
        "UPDATE messages SET media_expires_at = 1 WHERE media_id = 'new'",
    )
    .await;
    assert_eq!(ws_live_hosted(db, "alice", &ids).await, Some(Vec::new()));
    assert_eq!(ws_live_hosted(db, "bob", &[]).await, Some(Vec::new()));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn hosting_broadcasts_reach_others_only_through_p2p_who() {
    let (state, path) = crate::api::test_util::temp_state("p2p_broadcast_ids").await;
    let db = &state.db;
    for name in ["alice", "bob", "carol"] {
        add_user_row(db, name).await;
    }
    for user in ["alice", "carol"] {
        sqlx::query(
            "INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, 0)",
        )
        .bind(user)
        .execute(db)
        .await
        .expect("member");
    }
    let general = insert_id(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    for (id, channel, dm_id) in [("pub", Some(general), None), ("dm", None, Some(dm))] {
        sqlx::query("INSERT INTO messages(channel_id, dm_id, author, content, media_id, media_kind, media_hoster, created_at) VALUES($1, $2, 'alice', '', $3, 'p2p', 'alice', 0)")
            .bind(channel)
            .bind(dm_id)
            .bind(id)
            .execute(db)
            .await
            .expect("p2p message");
    }
    let ids = vec![s("pub"), s("dm")];
    state.hub.set_p2p("alice", 1, s("peer-a"), ids.clone());
    let hosting = WsEvent::P2pAvailability {
        hoster: s("alice"),
        peer_id: Some(s("peer-a")),
        ids,
        online: true,
        scope_servers: vec![s("rchat")],
        scope_users: vec![s("bob")],
    };
    let conn = state.hub.next_conn();
    let mut carol = Access::new(Some(s("carol")), false, set(&["rchat"]));
    assert!(carol.wants(&hosting));
    assert_eq!(
        on_event(&state, conn, &mut carol, &hosting).await,
        Some(false)
    );
    assert_eq!(carol.who.pending, [s("alice")]);
    assert!(carol.who.pace.due.is_some());
    assert_eq!(
        p2p_visible(&state, &mut carol, "carol", "alice").await,
        Some(vec![s("pub")]),
        "the DM attachment's id never reaches a server co-member"
    );
    let mut alice = Access::new(Some(s("alice")), false, set(&["rchat"]));
    assert_eq!(
        on_event(&state, conn, &mut alice, &hosting).await,
        Some(true)
    );
    assert!(alice.who.pending.is_empty());
    let offline = p2p_offline(s("alice"), vec![s("rchat")], Vec::new());
    assert_eq!(
        on_event(&state, conn, &mut carol, &offline).await,
        Some(true)
    );

    let mut bob = Access::new(Some(s("bob")), false, HashSet::new());
    assert_eq!(
        p2p_visible(&state, &mut bob, "bob", "alice").await,
        Some(vec![s("pub"), s("dm")])
    );
    bob.who.pace.fire(Instant::now());
    bob.who
        .media
        .insert((s("alice"), s("new")), (Instant::now(), false));
    let mut posted = message();
    posted.media = Some(crate::api::MediaRef {
        id: s("new"),
        filename: s("a.txt"),
        kind: MediaKind::P2p,
        hoster: Some(s("alice")),
        expires_at: None,
        size: Some(1),
        mime: None,
        sha256: None,
        removed: false,
        removed_by_author: false,
        spoiler: false,
    });
    let created = WsEvent::Message {
        server: None,
        channel_id: None,
        dm_id: Some(dm),
        dm_users: Some(vec![s("alice"), s("bob")]),
        message: Box::new(posted),
    };
    assert_eq!(on_event(&state, conn, &mut bob, &created).await, Some(true));
    assert!(!bob.who.media.contains_key(&(s("alice"), s("new"))));
    assert_eq!(bob.who.pending, [s("alice")]);
    assert_eq!(
        bob.who.pace.due,
        bob.who.pace.last.map(|last| last + P2P_WHO_EVERY),
        "a hoster's new attachment is re-asked about on the next paced p2p_who"
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn p2p_peer_ids_go_only_to_readers_of_the_message_with_a_token() {
    let (state, path) = crate::api::test_util::temp_state("p2p_release").await;
    let db = &state.db;
    for name in ["alice", "bob", "carol", "dave", "eve"] {
        add_user_row(db, name).await;
    }
    let general = insert_id(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
    for (user, joined) in [("alice", 0), ("bob", 50), ("dave", 50)] {
        sqlx::query(
            "INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, $2)",
        )
        .bind(user)
        .bind(joined)
        .execute(db)
        .await
        .expect("member");
    }
    exec(db, "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) SELECT id, 'u:bob', 1, 1, 0 FROM channels WHERE server = 'rchat'").await;
    exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 0)").await;
    exec(
        db,
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('vault', 'alice', 0, 0)",
    )
    .await;
    let vault = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('vault', 'general', 'text', 0) RETURNING id").await;
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id",
    )
    .await;
    let mut ids = HashMap::new();
    for (name, channel, dm_id, at, removed, expires) in [
        ("old", Some(general), None, 10, 0, None),
        ("new", Some(general), None, 60, 0, None),
        ("dm", None, Some(dm), 60, 0, None),
        ("vault", Some(vault), None, 60, 0, None),
        ("gone", Some(general), None, 60, 1, None),
        ("expired", Some(general), None, 60, 0, Some(1)),
    ] {
        let id: i64 = sqlx::query("INSERT INTO messages(channel_id, dm_id, author, content, media_id, media_kind, media_hoster, created_at, media_removed, media_expires_at) VALUES($1, $2, 'alice', '', $3, 'p2p', 'alice', $4, $5, $6) RETURNING id")
            .bind(channel)
            .bind(dm_id)
            .bind(name)
            .bind(at)
            .bind(removed)
            .bind(expires)
            .fetch_one(db)
            .await
            .expect("p2p message")
            .try_get(0)
            .expect("id");
        ids.insert(name, id);
    }
    state.hub.set_p2p_relayed(
        "alice",
        1,
        s("peer-a"),
        ["old", "new", "dm", "vault", "gone", "expired"]
            .map(s)
            .to_vec(),
        BTreeMap::from([(s("new"), vec![s("turn.a.example")])]),
    );
    let ask = |me: Option<&'static str>, file: &'static str| {
        let access = Access::new(me.map(s), false, set(&["rchat"]));
        let state = state.clone();
        let id = ids[file];
        async move { p2p_release(&state, &access, id, "peer-b").await }
    };
    let token = |ev: WsEvent| match ev {
        WsEvent::P2pPeer {
            message_id: _,
            peer_id: Some(peer),
            token: Some(token),
            expires_at: Some(_),
            error: None,
            relays: _,
        } => Some((peer, token)),
        _ => None,
    };
    let refusal = |ev: WsEvent| match ev {
        WsEvent::P2pPeer {
            message_id,
            peer_id: None,
            token: None,
            expires_at: None,
            error: Some(error),
            relays: _,
        } => Some((message_id, error)),
        _ => None,
    };
    let listed = |me: &'static str| {
        let mut access = Access::new(Some(s(me)), false, set(&["rchat"]));
        let state = state.clone();
        async move { p2p_visible(&state, &mut access, me, "alice").await }
    };
    let key = crate::p2p::host_key(&state.instance.p2p_secret, "alice", "peer-a");
    let (peer, granted) = token(ask(Some("bob"), "new").await).expect("bob reads new");
    assert_eq!(peer, "peer-a");
    let grant = crate::p2p::verify(&key, &granted, now()).expect("signed for alice's tab");
    assert_eq!(
        (
            grant.message_id,
            grant.p2p_id.as_str(),
            grant.requester.as_str(),
            grant.hoster.as_str(),
            grant.hoster_peer.as_str(),
            grant.requester_peer.as_str(),
        ),
        (ids["new"], "new", "bob", "alice", "peer-a", "peer-b")
    );
    assert!((grant.exp - now() - crate::p2p::TOKEN_TTL).abs() <= 2);
    assert_eq!(
        crate::p2p::verify(&key, &granted, grant.exp),
        None,
        "short-lived"
    );
    let relays = |ev: WsEvent| match ev {
        WsEvent::P2pPeer {
            message_id: _,
            peer_id: _,
            token: _,
            expires_at: _,
            error: _,
            relays,
        } => relays,
        _ => Vec::new(),
    };
    assert_eq!(
        relays(ask(Some("bob"), "new").await),
        vec![s("turn.a.example")],
        "the relay alice declared for this file"
    );
    assert!(relays(ask(Some("dave"), "old").await).is_empty());
    assert!(
        relays(ask(Some("bob"), "dm").await).is_empty(),
        "never on a refusal"
    );
    assert!(token(ask(Some("dave"), "old").await).is_some());
    assert!(token(ask(Some("carol"), "dm").await).is_some());
    assert!(
        token(ask(Some("eve"), "new").await).is_some(),
        "a public server's messages can be read without joining"
    );
    for (me, file, why) in [
        (
            Some("bob"),
            "old",
            "before bob joined, without read history",
        ),
        (Some("bob"), "dm", "a DM bob is not in"),
        (Some("eve"), "vault", "a protected server eve is not in"),
        (Some("alice"), "new", "the hoster has the file"),
        (Some("dave"), "gone", "removed"),
        (Some("dave"), "expired", "expired"),
    ] {
        assert_eq!(
            refusal(ask(me, file).await),
            Some((ids[file], s(NOT_AVAILABLE))),
            "{why}"
        );
    }
    assert!(token(ask(None, "new").await).is_none(), "guests");
    let dave = Access::new(Some(s("dave")), false, set(&["rchat"]));
    assert!(token(p2p_release(&state, &dave, ids["new"], "bad id").await).is_none());
    assert!(token(p2p_release(&state, &dave, 999_999, "peer-b").await).is_none());
    exec(
        db,
        "UPDATE users SET appear_offline = 1 WHERE username = 'alice'",
    )
    .await;
    assert!(
        token(ask(Some("dave"), "new").await).is_none(),
        "appears offline"
    );
    exec(
        db,
        "UPDATE users SET appear_offline = 0 WHERE username = 'alice'",
    )
    .await;
    state.hub.set_p2p("alice", 1, s("peer-a"), vec![s("old")]);
    assert!(
        token(ask(Some("dave"), "new").await).is_none(),
        "no tab hosts the file"
    );
    state.hub.set_p2p("alice", 2, s("peer-a2"), vec![s("new")]);
    let (peer, _) = token(ask(Some("dave"), "new").await).expect("the other tab");
    assert_eq!(peer, "peer-a2");
    for (blocker, blocked) in [("alice", "dave"), ("dave", "alice")] {
        sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES($1, $2, 0)")
            .bind(blocker)
            .bind(blocked)
            .execute(db)
            .await
            .expect("block");
        assert_eq!(
            refusal(ask(Some("dave"), "new").await),
            Some((ids["new"], s(NOT_AVAILABLE))),
            "{blocker} blocked {blocked}"
        );
        assert_eq!(
            listed("dave").await,
            Some(Vec::new()),
            "{blocker} blocked {blocked}: no file shows as available"
        );
        exec(db, "DELETE FROM blocks").await;
    }
    assert!(token(ask(Some("dave"), "new").await).is_some(), "unblocked");
    let mut shown = listed("dave").await.expect("shown");
    shown.sort();
    assert_eq!(shown, [s("new"), s("old")]);
    exec(
        db,
        "INSERT INTO settings(key, value) VALUES('p2p_attachments', '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
    )
    .await;
    crate::api::Settings::forget(db);
    assert!(token(ask(Some("dave"), "new").await).is_none(), "P2P off");
    let mut allowed = 0;
    while state.hub.release_ok("zed") {
        allowed += 1;
    }
    assert_eq!(allowed, crate::hub::RELEASE_BURST);
    let limited = Access::new(Some(s("zed")), false, set(&["rchat"]));
    assert_eq!(
        refusal(p2p_release(&state, &limited, ids["new"], "peer-b").await),
        Some((
            ids["new"],
            s("Too many downloads at once, try again in a moment")
        ))
    );
    crate::api::test_util::done(state, path).await;
}

#[test]
fn p2p_who_is_paced_and_merged_per_connection() {
    let mut who = Who::new();
    let now = Instant::now();
    who.ask(vec![s("Alice"), s("bob"), s("alice")]);
    assert_eq!(who.pending, [s("alice"), s("bob")]);
    assert!(who.pace.hit(now));
    who.pending.clear();
    who.ask(vec![s("carol")]);
    assert!(!who.pace.hit(now + Duration::from_millis(100)));
    who.ask(vec![s("dave"), s("carol")]);
    assert_eq!(who.pending, [s("carol"), s("dave")]);
    assert_eq!(who.pace.due, Some(now + P2P_WHO_EVERY));
    who.ask((0..200).map(|n| format!("u{n}")).collect());
    assert_eq!(who.pending.len(), P2P_WHO_CAP);
}

#[tokio::test]
async fn p2p_who_shows_an_offline_hoster_only_to_their_call_partner() {
    let (state, path) = crate::api::test_util::temp_state("p2p_who_call").await;
    let db = &state.db;
    for name in ["alice", "carol", "eve"] {
        add_user_row(db, name).await;
    }
    exec(
        db,
        "UPDATE users SET appear_offline = 1 WHERE username = 'alice'",
    )
    .await;
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id",
    )
    .await;
    state
        .hub
        .set_p2p("alice", 1, "peer-a".to_string(), Vec::new());
    let ask = |me: &'static str| {
        let mut access = Access::new(Some(s(me)), false, set(&[]));
        let state = state.clone();
        async move { p2p_visible(&state, &mut access, me, "alice").await }
    };
    assert_eq!(ask("carol").await, None);
    let pair = vec![s("alice"), s("carol")];
    state
        .hub
        .call_start("alice", 1, dm, pair.clone(), CallKind::Rtc, false, 1, None)
        .await
        .expect("voice call");
    assert_eq!(
        ask("carol").await,
        None,
        "only P2P calls show an offline hoster"
    );
    state.hub.call_end("alice", dm).await.expect("end");
    state
        .hub
        .call_start("alice", 1, dm, pair, CallKind::P2p, false, 2, None)
        .await
        .expect("p2p call");
    assert_eq!(
        ask("carol").await,
        Some(Vec::new()),
        "online to the call partner, and never with a peer id"
    );
    assert_eq!(ask("eve").await, None);
    state.hub.call_end("alice", dm).await.expect("end");
    assert_eq!(ask("carol").await, None);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn hosting_relays_keep_valid_hosts_of_hosted_files() {
    let ids = vec![s("f1"), s("f2")];
    let kept = hosting_relays(
        ids.clone(),
        BTreeMap::from([
            (s("f1"), vec![s("TURN.A.example")]),
            (s("f2"), Vec::new()),
            (s("other"), vec![s("turn.b.example")]),
        ]),
        Vec::new(),
    );
    assert_eq!(
        kept,
        (
            ids.clone(),
            BTreeMap::from([(s("f1"), vec![s("turn.a.example")])])
        )
    );
    assert!(
        serde_json::from_str::<ClientMsg>(r#"{"type":"p2p_hosting","peer_id":"p","ids":[]}"#)
            .is_ok(),
        "older apps send no relays"
    );
}

#[tokio::test]
async fn hosting_drops_only_the_ids_with_a_bad_relay_list() {
    let ids = vec![s("f1"), s("f2"), s("f3"), s("f4")];
    let (kept, relays) = hosting_relays(
        ids,
        BTreeMap::from([
            (s("f1"), vec![s("a.example:3478")]),
            (s("f2"), vec![s("turn.a.example")]),
        ]),
        vec![
            RelaySet {
                hosts: vec![s("<b>")],
                ids: vec![s("f3")],
            },
            RelaySet {
                hosts: vec![s("turn.b.example")],
                ids: vec![s("f2"), s("f4")],
            },
        ],
    );
    assert_eq!(kept, vec![s("f4")]);
    assert_eq!(
        relays,
        BTreeMap::from([(s("f4"), vec![s("turn.b.example")])])
    );
    let (kept, relays) = hosting_relays(
        vec![s("f1"), s("f2")],
        BTreeMap::from([(s("f1"), vec![s("turn.a.example")])]),
        vec![RelaySet {
            hosts: vec![s("TURN.A.example")],
            ids: vec![s("f1"), s("f2"), s("gone")],
        }],
    );
    assert_eq!(kept, vec![s("f1"), s("f2")]);
    assert_eq!(
        relays,
        BTreeMap::from([
            (s("f1"), vec![s("turn.a.example")]),
            (s("f2"), vec![s("turn.a.example")]),
        ])
    );
}

#[tokio::test]
async fn a_full_hosting_message_with_shared_relays_fits_a_frame() {
    let ids: Vec<String> = (0..P2P_IDS_CAP).map(|i| format!("{i:032x}")).collect();
    let hosts: Vec<String> = (0..crate::p2p::RELAY_HOSTS_MAX)
        .map(|i| {
            let label = |c: &str, n| c.repeat(n);
            format!(
                "{i}{}.{}.{}.{}",
                label("a", 62),
                label("b", 63),
                label("c", 63),
                label("d", 61)
            )
        })
        .collect();
    assert!(
        hosts
            .iter()
            .all(|h| h.len() == 253 && crate::p2p::relay_host(h).is_some())
    );
    let text = serde_json::json!({
        "type": "p2p_hosting",
        "peer_id": "rchat-0123456789abcdef",
        "ids": ids,
        "relay_sets": [{ "hosts": hosts, "ids": ids }],
    })
    .to_string();
    assert!(text.len() < FRAME_MAX, "{}", text.len());
    let Ok(ClientMsg::P2pHosting {
        peer_id: _,
        ids: got,
        relays,
        relay_sets,
    }) = serde_json::from_str::<ClientMsg>(&text)
    else {
        panic!("p2p_hosting");
    };
    let (kept, relays) = hosting_relays(hosting_ids(got), relays, relay_sets);
    assert_eq!(kept.len(), P2P_IDS_CAP);
    assert_eq!(relays.len(), P2P_IDS_CAP);
    assert!(relays.values().all(|h| *h == hosts));
}

#[tokio::test]
async fn hosting_announces_are_deduped_paced_cached_and_bounded() {
    let (state, path) = lagged_presence_state("ws_hosting_pace").await;
    let hub = state.hub.clone();
    let mut rx = hub.subscribe();
    let scopes = |rx: &mut tokio::sync::broadcast::Receiver<WsEvent>| {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::P2pAvailability {
                ids, scope_servers, ..
            } = ev
            {
                out.push((ids, scope_servers));
            }
        }
        out
    };
    let mut a = Access::new(Some(s("alice")), false, set(&["chat"]));
    a.host(&state, 1, (s("peer"), vec![s("f1")], BTreeMap::new()))
        .await;
    assert_eq!(scopes(&mut rx), vec![(vec![s("f1")], vec![s("chat")])]);
    a.host(&state, 1, (s("peer"), vec![s("f1")], BTreeMap::new()))
        .await;
    assert!(scopes(&mut rx).is_empty());
    a.host(
        &state,
        1,
        (s("peer"), vec![s("f1"), s("f2")], BTreeMap::new()),
    )
    .await;
    a.host(&state, 1, (s("peer"), vec![s("f2")], BTreeMap::new()))
        .await;
    assert!(scopes(&mut rx).is_empty());
    assert!(a.hosting_pace.due.is_some());
    exec(&state.db, "DELETE FROM members WHERE username = 'alice'").await;
    a.hosting_pace.fire(Instant::now());
    a.announce_hosting(&state, 1).await;
    assert_eq!(scopes(&mut rx), vec![(vec![s("f2")], vec![s("chat")])]);
    track(
        &WsEvent::MemberLeft {
            server: s("chat"),
            username: s("alice"),
        },
        &mut a,
    );
    a.announce_hosting(&state, 1).await;
    assert_eq!(scopes(&mut rx), vec![(vec![s("f2")], Vec::<String>::new())]);
    for i in 0..(USER_SCOPE_SERVERS + 20) {
        sqlx::query("INSERT INTO servers(name, display_name, created_at) VALUES($1, $1, 1)")
            .bind(format!("s{i}"))
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO members(server, username, joined_at) VALUES($1, 'alice', $2)")
            .bind(format!("s{i}"))
            .bind(i)
            .execute(&state.db)
            .await
            .unwrap();
    }
    let (servers, users) = p2p_scope(&state.read(), "alice").await;
    assert_eq!(servers.len() as i64, USER_SCOPE_SERVERS);
    assert_eq!(users, vec![s("alice")]);
    crate::api::test_util::done(state, path).await;
}
