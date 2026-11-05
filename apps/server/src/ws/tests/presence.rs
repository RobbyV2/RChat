use std::collections::BTreeMap;

use tokio::time::Instant;

use super::*;
use crate::hub::{Op, PRESENCE_SERVERS_MAX, Scope};
use crate::ws::access::Access;
use crate::ws::filter::{track, wants};

#[test]
fn presence_events_carry_the_online_count() {
    let hub = Hub::new();
    let mut rx = hub.subscribe();
    hub.set_online("ann", 1, &["rchat"]);
    hub.set_online("bo", 2, &["rchat"]);
    hub.set_online("bo", 3, &["rchat"]);
    hub.set_online("bo", 2, &[] as &[&str]);
    hub.set_online("bo", 3, &[] as &[&str]);
    hub.set_online("ann", 1, &["other"]);
    let mut counts = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let WsEvent::PresenceChanged {
            server,
            username,
            online,
            online_count,
        } = ev
        {
            counts.push((server, username, online, online_count));
        }
    }
    assert_eq!(
        counts,
        [
            (s("rchat"), s("ann"), true, 1),
            (s("rchat"), s("bo"), true, 2),
            (s("rchat"), s("bo"), false, 1),
            (s("rchat"), s("ann"), false, 0),
            (s("other"), s("ann"), true, 1),
        ]
    );
}

#[test]
fn presence_order_matches_the_client() {
    let hub = Hub::new();
    let names = [
        "\u{1f600}",
        "z",
        "\u{ff21}",
        "a",
        "\u{e9}",
        "ab",
        "\u{1f600}a",
    ];
    for (i, name) in names.iter().enumerate() {
        hub.set_online(name, 10 + i as u64, &["rchat"]);
    }
    assert_eq!(
        hub.online_after("rchat", None, 50),
        [
            "a",
            "ab",
            "z",
            "\u{e9}",
            "\u{ff21}",
            "\u{1f600}",
            "\u{1f600}a"
        ]
    );
}

fn presence_events(rx: &mut broadcast::Receiver<WsEvent>) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let WsEvent::PresenceChanged {
            server,
            username: _,
            online,
            online_count: _,
        } = ev
        {
            out.push((server, online));
        }
    }
    out
}

fn presence_counts(rx: &mut broadcast::Receiver<WsEvent>) -> Vec<(String, String, bool, i64)> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let WsEvent::PresenceChanged {
            server,
            username,
            online,
            online_count,
        } = ev
        {
            out.push((server, username, online, online_count));
        }
    }
    out
}

#[tokio::test]
async fn members_are_online_in_every_server_without_viewing_one() {
    let hub = Hub::new();
    let mut rx = hub.subscribe();
    let mut a = Access::new(Some(s("alice")), false, set(&["one", "two"]));
    a.sync(&hub, 1);
    assert!(a.viewing.is_none());
    assert!(hub.is_online("one", "alice") && hub.is_online("two", "alice"));
    a.view(&hub, 1, Some(s("one")));
    a.view(&hub, 1, None);
    assert!(hub.is_online("one", "alice") && hub.is_online("two", "alice"));
    let mut b = Access::new(Some(s("alice")), false, set(&["one", "two"]));
    b.sync(&hub, 2);
    assert_eq!(hub.online_count("one"), 1);
    assert_eq!(
        presence_counts(&mut rx),
        vec![
            (s("one"), s("alice"), true, 1),
            (s("two"), s("alice"), true, 1)
        ]
    );
    let _ = hub.drop_conn("alice", 1).await;
    assert!(hub.is_online("one", "alice") && hub.is_online("two", "alice"));
    assert!(presence_counts(&mut rx).is_empty());
    let _ = hub.drop_conn("alice", 2).await;
    let mut back = Access::new(Some(s("alice")), false, set(&["one", "two"]));
    back.sync(&hub, 5);
    let _ = hub.drop_conn("alice", 5).await;
    assert!(hub.is_online("one", "alice") && presence_counts(&mut rx).is_empty());
    hub.expire_presence();
    assert!(!hub.is_online("one", "alice") && !hub.is_online("two", "alice"));
    assert_eq!(
        presence_counts(&mut rx),
        vec![
            (s("one"), s("alice"), false, 0),
            (s("two"), s("alice"), false, 0)
        ]
    );
    let mut lone = Access::new(Some(s("zoe")), false, HashSet::new());
    lone.sync(&hub, 3);
    assert!(lone.announced && hub.is_online_anywhere("zoe"));
    assert!(presence_counts(&mut rx).is_empty());
    let mut guest = Access::new(None, false, set(&["one"]));
    guest.sync(&hub, 4);
    assert!(!guest.announced && hub.online_set("one").is_empty());
}

#[tokio::test]
async fn online_counts_follow_membership() {
    let hub = Hub::new();
    let mut rx = hub.subscribe();
    let mut alice = Access::new(Some(s("alice")), false, set(&["one"]));
    let mut bob = Access::new(Some(s("bob")), false, set(&["one", "two"]));
    alice.sync(&hub, 1);
    bob.sync(&hub, 2);
    assert_eq!((hub.online_count("one"), hub.online_count("two")), (2, 1));
    let _ = presence_counts(&mut rx);
    let mut step = |ev: WsEvent| {
        hub.broadcast(ev.clone());
        for (conn, access) in [(1, &mut alice), (2, &mut bob)] {
            track(&ev, access);
            access.sync(&hub, conn);
        }
        presence_counts(&mut rx)
    };
    assert_eq!(
        step(joined("two", "alice")),
        vec![(s("two"), s("alice"), true, 2)]
    );
    let left = WsEvent::MemberLeft {
        server: s("two"),
        username: s("alice"),
    };
    assert_eq!(step(left), vec![(s("two"), s("alice"), false, 1)]);
    step(joined("two", "alice"));
    let kicked = WsEvent::MemberKicked {
        server: s("two"),
        username: s("alice"),
        banned: false,
    };
    assert_eq!(step(kicked), vec![(s("two"), s("alice"), false, 1)]);
    let banned = WsEvent::MemberKicked {
        server: s("one"),
        username: s("bob"),
        banned: true,
    };
    assert_eq!(step(banned), vec![(s("one"), s("bob"), false, 1)]);
    assert!(step(renamed("two", "deux")).is_empty());
    assert_eq!(hub.online_set("deux"), HashSet::from([s("bob")]));
    assert!(hub.online_set("two").is_empty());
    assert!(step(WsEvent::ServerDeleted { name: s("deux") }).is_empty());
    assert_eq!(hub.online_count("deux"), 0);
    let purged = WsEvent::MembersPurged {
        server: s("one"),
        usernames: vec![s("alice")],
    };
    assert_eq!(step(purged), vec![(s("one"), s("alice"), false, 0)]);
    assert!(hub.online_set("one").is_empty());
    assert!(bob.member_servers.is_empty() && bob.moved.is_empty());
}

#[tokio::test]
async fn membership_changes_post_deltas_not_full_lists() {
    let (hub, mut out) = Hub::replicated();
    let mut ops =
        || -> Vec<Op> { std::iter::from_fn(|| out.try_recv().ok().map(|e| e.op)).collect() };
    let many: HashSet<String> = (0..1500).map(|i| format!("s{i:04}")).collect();
    let mut alice = Access::new(Some(s("alice")), false, many);
    alice.sync(&hub, 1);
    assert!(matches!(
        ops().as_slice(),
        [Op::Online { lit: true, cap: 20, scope: Some(Scope { servers, hidden: false, seq: 0 }), .. }]
            if servers.len() == PRESENCE_SERVERS_MAX && servers[0] == "s0000"
    ));
    let mut step = |ev: WsEvent| {
        track(&ev, &mut alice);
        alice.sync(&hub, 1);
    };
    step(joined("elsewhere", "bob"));
    step(renamed("other", "else"));
    step(WsEvent::RolesChanged { server: s("s0001") });
    assert!(ops().is_empty());
    step(joined("new", "alice"));
    step(WsEvent::MemberLeft {
        server: s("s0002"),
        username: s("alice"),
    });
    alice.set_hidden(&hub, 1, true, 0);
    let posted = ops();
    assert!(matches!(
        posted.as_slice(),
        [
            Op::Rescope { add: a1, remove: r1, hidden: None, .. },
            Op::Rescope { add: a2, remove: r2, hidden: None, .. },
            Op::Rescope { add: a3, remove: r3, hidden: Some(true), .. },
        ] if *a1 == [s("new")] && r1.is_empty() && a2.is_empty() && *r2 == [s("s0002")]
            && a3.is_empty() && r3.is_empty()
    ));
}

#[tokio::test]
async fn appear_offline_suppresses_and_restores_presence() {
    let hub = Hub::new();
    let mut rx = hub.subscribe();
    let (mut a, mut b) = (viewer("alice", false), viewer("alice", false));
    a.sync(&hub, 1);
    b.sync(&hub, 2);
    assert!(hub.is_online("rchat", "alice") && hub.is_online("other", "alice"));
    assert_eq!(hub.online_count("rchat"), 1);
    assert_eq!(
        presence_events(&mut rx),
        vec![(s("other"), true), (s("rchat"), true)]
    );
    a.set_hidden(&hub, 1, true, 0);
    assert!(!hub.is_online("rchat", "alice") && !hub.is_online("other", "alice"));
    b.set_hidden(&hub, 2, true, 0);
    assert_eq!(hub.online_count("rchat"), 0);
    assert!(hub.online_set("rchat").is_empty());
    assert_eq!(
        presence_events(&mut rx),
        vec![(s("other"), false), (s("rchat"), false)]
    );
    let mut c = viewer("alice", true);
    c.sync(&hub, 3);
    c.view(&hub, 3, Some(s("rchat")));
    b.set_hidden(&hub, 2, true, 0);
    assert!(!hub.is_online("rchat", "alice") && !hub.is_online("other", "alice"));
    assert!(presence_events(&mut rx).is_empty());
    a.set_hidden(&hub, 1, false, 0);
    assert!(hub.is_online("other", "alice") && hub.is_online("rchat", "alice"));
    c.set_hidden(&hub, 3, false, 0);
    b.set_hidden(&hub, 2, false, 0);
    assert_eq!(hub.online_count("rchat"), 1);
    assert_eq!(
        presence_events(&mut rx),
        vec![(s("other"), true), (s("rchat"), true)]
    );
    a.set_hidden(&hub, 1, true, 0);
    assert!(!hub.is_online("rchat", "alice") && !hub.is_online("other", "alice"));
    assert_eq!(
        presence_events(&mut rx),
        vec![(s("other"), false), (s("rchat"), false)]
    );
    let _ = hub.drop_conn("alice", 1).await;
    let _ = hub.drop_conn("alice", 3).await;
    let _ = hub.drop_conn("alice", 2).await;
    hub.expire_presence();
    assert!(!hub.is_online("rchat", "alice") && presence_events(&mut rx).is_empty());
}

#[tokio::test]
async fn lagged_rename_drops_stale_presence() {
    let (state, path) = lagged_presence_state("ws_lag_rename").await;
    let hub = state.hub.clone();
    let mut rx = hub.subscribe();
    let mut a = Access::new(Some(s("alice")), false, set(&["rchat"]));
    a.view(&hub, 1, Some(s("rchat")));
    hub.broadcast(renamed("rchat", "chat"));
    assert!(hub.is_online("chat", "alice"));
    let _ = presence_events(&mut rx);
    exec(&state.db, "UPDATE users SET appear_offline = 1").await;
    assert!(a.refresh(&state, 1).await);
    assert!(a.hidden);
    assert_eq!(a.viewing, None);
    hub.expire_presence();
    assert!(!hub.is_online("chat", "alice"));
    assert_eq!(presence_events(&mut rx), vec![(s("chat"), false)]);
    a.set_hidden(&hub, 1, false, 0);
    assert!(hub.is_online("chat", "alice") && !hub.is_online("rchat", "alice"));
    let _ = hub.drop_conn("alice", 1).await;
    hub.expire_presence();
    assert_eq!(
        presence_events(&mut rx),
        vec![(s("chat"), true), (s("chat"), false)]
    );
    assert!(hub.online_set("chat").is_empty() && hub.online_set("rchat").is_empty());
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn lagged_resync_keeps_valid_presence() {
    let (state, path) = lagged_presence_state("ws_lag_keep").await;
    let hub = state.hub.clone();
    let mut a = Access::new(Some(s("alice")), false, set(&["rchat"]));
    a.view(&hub, 1, Some(s("rchat")));
    hub.broadcast(renamed("rchat", "chat"));
    a.viewing = Some(s("chat"));
    assert!(a.refresh(&state, 1).await);
    assert!(hub.is_online("chat", "alice"));
    exec(&state.db, "UPDATE users SET appear_offline = 1").await;
    assert!(a.refresh(&state, 1).await);
    hub.expire_presence();
    assert!(!hub.is_online("chat", "alice"));
    exec(&state.db, "UPDATE users SET appear_offline = 0").await;
    assert!(a.refresh(&state, 1).await);
    assert!(hub.is_online("chat", "alice"));
    let _ = hub.drop_conn("alice", 1).await;
    hub.expire_presence();
    assert!(!hub.is_online("chat", "alice"));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn leave_after_lagged_rename_removes_presence() {
    let hub = Hub::new();
    let mut a = viewer("alice", false);
    a.view(&hub, 1, Some(s("rchat")));
    hub.broadcast(renamed("rchat", "chat"));
    let _ = hub.drop_conn("alice", 1).await;
    hub.expire_presence();
    assert!(!hub.is_online("chat", "alice"));
    assert!(hub.online_set("chat").is_empty());
}

#[tokio::test]
async fn force_offline_does_not_steal_other_connections() {
    let hub = Hub::new();
    let (mut a, mut b) = (viewer("alice", false), viewer("alice", false));
    a.sync(&hub, 1);
    hub.force_offline("rchat", "alice");
    assert!(!hub.is_online("rchat", "alice") && hub.is_online("other", "alice"));
    b.sync(&hub, 2);
    assert!(hub.is_online("rchat", "alice"));
    let _ = hub.drop_conn("alice", 2).await;
    assert!(hub.is_online("rchat", "alice") && hub.is_online("other", "alice"));
    let mut rx = hub.subscribe();
    hub.broadcast(WsEvent::Banned {
        username: s("alice"),
    });
    assert!(!hub.is_online("other", "alice"));
    let _ = hub.drop_conn("alice", 1).await;
    hub.expire_presence();
    assert_eq!(
        presence_events(&mut rx),
        vec![(s("other"), false), (s("rchat"), false)]
    );
    assert!(hub.online_set("rchat").is_empty() && hub.online_set("other").is_empty());
}

#[test]
fn presence_mode_reaches_only_its_user() {
    let ev = WsEvent::PresenceMode {
        username: s("alice"),
        appear_offline: true,
        seq: 0,
    };
    let none = HashSet::new();
    assert!(wants(&ev, Some("alice"), false, &none, &none));
    assert!(!wants(&ev, Some("bob"), true, &none, &none));
    assert!(!wants(&ev, None, false, &none, &none));
    assert!(!wants(&WsEvent::Resync, Some("alice"), true, &none, &none));
}

fn apply_modes(hub: &Hub, rx: &mut broadcast::Receiver<WsEvent>, conn: u64, access: &mut Access) {
    while let Ok(ev) = rx.try_recv() {
        if let WsEvent::PresenceMode {
            username,
            appear_offline,
            seq,
        } = ev
            && access.user.as_deref() == Some(username.as_str())
        {
            access.set_hidden(hub, conn, appear_offline, seq);
        }
    }
}

#[tokio::test]
async fn appear_offline_holds_across_instances() {
    let bus = crate::hub::tests::MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let (mut rx_a, mut rx_b) = (a.subscribe(), b.subscribe());
    let (ca, cb) = (a.next_conn(), b.next_conn());
    let (mut on_a, mut on_b) = (viewer("alice", false), viewer("alice", false));
    on_a.view(&a, ca, Some(s("rchat")));
    on_b.view(&b, cb, Some(s("rchat")));
    a.flush().await;
    b.flush().await;
    assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
    a.broadcast(WsEvent::PresenceMode {
        username: s("alice"),
        appear_offline: true,
        seq: 1,
    });
    a.flush().await;
    apply_modes(&a, &mut rx_a, ca, &mut on_a);
    apply_modes(&b, &mut rx_b, cb, &mut on_b);
    a.flush().await;
    b.flush().await;
    assert!(!a.is_online("rchat", "alice") && !b.is_online("rchat", "alice"));
    on_b.view(&b, cb, Some(s("other")));
    b.flush().await;
    assert!(!a.is_online("other", "alice"));
    b.broadcast(WsEvent::PresenceMode {
        username: s("alice"),
        appear_offline: false,
        seq: 2,
    });
    b.flush().await;
    apply_modes(&a, &mut rx_a, ca, &mut on_a);
    apply_modes(&b, &mut rx_b, cb, &mut on_b);
    a.flush().await;
    b.flush().await;
    assert!(a.is_online("rchat", "alice") && a.is_online("other", "alice"));
    assert!(b.is_online("rchat", "alice") && b.is_online("other", "alice"));
}

// Review I1: a socket reads `appear_offline` before alice turns it on and announces after
// the change, without ever seeing the event. She stays hidden on every node.
#[tokio::test]
async fn a_socket_with_a_stale_appear_offline_can_not_unhide() {
    let bus = crate::hub::tests::MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let mut rx_a = a.subscribe();
    let (ca, cb) = (a.next_conn(), b.next_conn());
    let mut on_a = viewer("alice", false);
    on_a.view(&a, ca, Some(s("rchat")));
    a.flush().await;
    b.flush().await;
    assert!(b.is_online("rchat", "alice"));
    let mut late = viewer("alice", false);
    late.take_mode((false, 0));
    a.broadcast(WsEvent::PresenceMode {
        username: s("alice"),
        appear_offline: true,
        seq: 1,
    });
    a.flush().await;
    apply_modes(&a, &mut rx_a, ca, &mut on_a);
    a.flush().await;
    b.flush().await;
    assert!(!a.is_online("rchat", "alice") && !b.is_online("rchat", "alice"));
    late.view(&b, cb, Some(s("rchat")));
    b.flush().await;
    a.flush().await;
    assert!(!a.is_online("rchat", "alice") && !b.is_online("rchat", "alice"));
    assert!(!b.is_online("other", "alice") && a.online_set("rchat").is_empty());
    // An event older than what the connection read is ignored by the connection too.
    late.take_mode((true, 1));
    late.set_hidden(&b, cb, false, 0);
    assert!(late.hidden);
    // A newer value shows her again.
    b.broadcast(WsEvent::PresenceMode {
        username: s("alice"),
        appear_offline: false,
        seq: 2,
    });
    b.flush().await;
    a.flush().await;
    assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
}

#[tokio::test]
async fn pending_epoch_stays_dark_until_recovered() {
    let (state, path) = lagged_presence_state("ws_epoch_dark").await;
    let hub = state.hub.clone();
    let mut rx = hub.subscribe();
    let mut a = Access::new(Some(s("alice")), false, set(&["chat"]));
    a.view(&hub, 1, Some(s("chat")));
    a.hosting = Some((s("peer"), vec![s("f1")], BTreeMap::new()));
    a.announce(&state, 1).await;
    assert!(hub.is_online("chat", "alice"));
    assert!(hub.p2p_of("alice").is_some());
    let _ = rx.try_recv();
    while rx.try_recv().is_ok() {}
    assert!(a.hold(sqlx::Error::PoolClosed, Instant::now()));
    a.announce(&state, 1).await;
    assert!(a.dark);
    hub.expire_presence();
    assert!(!hub.is_online("chat", "alice"));
    a.view(&hub, 1, Some(s("chat")));
    a.set_hidden(&hub, 1, false, 0);
    assert!(!hub.is_online("chat", "alice"));
    let mut hosted = 0;
    while let Ok(ev) = rx.try_recv() {
        hosted += matches!(ev, WsEvent::P2pAvailability { .. }) as usize;
    }
    assert_eq!(hosted, 0);
    assert!(a.refresh(&state, 1).await);
    assert!(!a.retry.pending() && a.dark && a.missed);
    a.announce(&state, 1).await;
    assert!(!a.dark);
    assert!(hub.is_online("chat", "alice"));
    let mut hosted = 0;
    while let Ok(ev) = rx.try_recv() {
        hosted += matches!(ev, WsEvent::P2pAvailability { online: true, .. }) as usize;
    }
    assert_eq!(hosted, 1);
    crate::api::test_util::done(state, path).await;
}
