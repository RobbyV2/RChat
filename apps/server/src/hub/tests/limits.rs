use super::*;
use crate::hub::limits::signal_burst_for;

#[test]
fn an_unlimited_voice_room_gets_the_default_signal_budget() {
    let default = signal_burst_for(crate::ws::VOICE_ROOM_MAX);
    assert_eq!(signal_burst_for(0), default);
    assert!(default > SIGNAL_BURST);
    assert_eq!(signal_burst_for(4), SIGNAL_BURST);
    assert_eq!(signal_burst_for(100), 2 * 100 * crate::ws::SIGNAL_MAX);
}

#[test]
fn sockets_are_counted_per_address() {
    let hub = Hub::new();
    hub.set_limits(Limits {
        sockets_per_ip: 3,
        guests_per_ip: 1,
        ..Limits::default()
    });
    let (a, b): (IpAddr, IpAddr) = (
        "203.0.113.1".parse().unwrap(),
        "203.0.113.2".parse().unwrap(),
    );
    let mut slots: Vec<AddrSlot> = (0..3).filter_map(|_| hub.addr_slot(a)).collect();
    assert_eq!(slots.len(), 3);
    assert!(hub.addr_slot(a).is_none() && hub.addr_slot(b).is_some());
    assert!(slots[0].guest() && slots[0].guest());
    assert!(!slots[1].guest(), "past the guests' share");
    slots.remove(0);
    assert!(slots[0].guest());
    drop(slots);
    assert!(hub.inner.addrs.lock().unwrap().is_empty());
    let (v6a, v6b): (IpAddr, IpAddr) = (
        "2001:db8:1:2::1".parse().unwrap(),
        "2001:db8:1:2:ffff::9".parse().unwrap(),
    );
    let held: Vec<AddrSlot> = (0..3).filter_map(|_| hub.addr_slot(v6a)).collect();
    assert_eq!(held.len(), 3);
    assert!(
        hub.addr_slot(v6b).is_none(),
        "an IPv6 /64 counts as one address"
    );
    assert!(hub.addr_slot("2001:db8:1:3::1".parse().unwrap()).is_some());
}

#[test]
fn guest_sockets_are_capped_for_the_whole_instance() {
    let hub = Hub::new();
    hub.set_limits(Limits {
        guests_per_ip: 5,
        guests_max: 2,
        ..Limits::default()
    });
    let addr = |n: u8| -> IpAddr { format!("203.0.113.{n}").parse().unwrap() };
    let mut slots: Vec<AddrSlot> = (1..=3).filter_map(|n| hub.addr_slot(addr(n))).collect();
    assert!(slots[0].guest() && slots[1].guest());
    assert!(
        !slots[2].guest(),
        "the third guest is past the instance's cap"
    );
    assert!(slots[0].guest(), "a counted guest stays counted");
    slots.remove(0);
    assert!(slots[1].guest(), "a closed guest frees its place");
    drop(slots);
    assert_eq!(hub.inner.guests.load(Ordering::Relaxed), 0);
    hub.set_limits(Limits {
        guests_max: 0,
        ..Limits::default()
    });
    let mut slot = hub.addr_slot(addr(9)).expect("slot");
    assert!(!slot.guest(), "0 turns guests off");
}

#[tokio::test]
async fn oldest_connection_closes_past_the_cap() {
    let hub = Hub::new();
    hub.set_limits(Limits {
        conns_per_user: 2,
        ..Limits::default()
    });
    let mut inboxes = Vec::new();
    for _ in 0..3 {
        let conn = hub.next_conn();
        inboxes.push(hub.open(conn, &HashSet::from([Topic::User("alice".to_string())])));
        hub.set_online("alice", conn, &["rchat"]);
    }
    let evicted: Vec<bool> = inboxes.iter().map(Inbox::evicted).collect();
    assert_eq!(evicted, [true, false, false]);
    assert!(inboxes[0].rx.recv().await.is_none());
    assert_eq!(hub.connections(), 2);
    assert_eq!(hub.online_count("rchat"), 1);
    hub.set_limits(Limits {
        connect_burst: 3,
        connect_every: Duration::from_secs(3600),
        ..Limits::default()
    });
    assert!((0..3).all(|_| hub.connect_ok("bob")));
    assert!(!hub.connect_ok("bob") && hub.connect_ok("carol"));
}

#[tokio::test]
async fn connect_rate_counts_across_instances() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let limits = Limits {
        connect_burst: 3,
        connect_every: Duration::from_secs(60),
        ..Limits::default()
    };
    a.set_limits(limits);
    b.set_limits(limits);
    for _ in 0..3 {
        assert!(a.connect_ok("bob"));
        a.set_online("bob", a.next_conn(), &["rchat"]);
    }
    a.flush().await;
    b.flush().await;
    // b has not seen a connect from bob itself, but the cluster has seen three.
    assert!(!b.connect_ok("bob") && b.connect_ok("carol"));
    bus.advance(60_000);
    b.flush().await;
    assert!(b.connect_ok("bob"));
    b.set_online("bob", b.next_conn(), &["rchat"]);
    b.flush().await;
    assert!(!a.connect_ok("bob"));
}

#[test]
fn the_voice_room_limit_sizes_the_signal_budget() {
    let hub = Hub::new();
    assert_eq!(
        hub.signal_burst(),
        signal_burst_for(crate::ws::VOICE_ROOM_MAX)
    );
    hub.set_limits(Limits {
        voice_room_max: 100,
        ..Limits::default()
    });
    let burst = 2 * 100 * crate::ws::SIGNAL_MAX;
    assert_eq!(hub.signal_burst(), burst);
    assert!(hub.signal_ok("alice", burst));
    assert!(!hub.signal_ok("alice", burst / 2));
    assert!(hub.signal_ok("bob", burst));
}

#[test]
fn a_call_start_churn_keeps_the_dm_pace() {
    let hub = Hub::new();
    let rings: Vec<bool> = (0..4).map(|_| hub.call_ok("alice", 7)).collect();
    assert_eq!(rings, [true, true, true, false]);
    for n in 0..PACED_USERS_MAX as i64 {
        hub.call_ok("mallory", 1_000_000 + n);
    }
    assert!(!hub.call_ok("alice", 7), "a spent DM stays spent");
    assert!(hub.call_ok("alice", 8));
}

#[tokio::test]
async fn a_bounded_shown_queue_keeps_the_last_state() {
    let hub = Hub::new();
    hub.set_limits(Limits {
        shown_max: 1,
        ..Limits::default()
    });
    let mut shown = hub.take_shown().expect("feed");
    for (user, online) in [("alice", true), ("bob", true), ("alice", false)] {
        hub.inner.shown.send((user.to_string(), online));
        assert!(hub.inner.shown.queued() <= 1, "never past the bound");
    }
    let mut last = HashMap::new();
    while let Ok((user, online)) = shown.try_recv() {
        last.insert(user, online);
    }
    assert_eq!(
        last,
        HashMap::from([("alice".to_string(), false), ("bob".to_string(), true)])
    );
    hub.inner.shown.send(("carol".to_string(), true));
    assert_eq!(
        shown.recv().await,
        Some(("carol".to_string(), true)),
        "the queue takes items again once the consumer caught up"
    );
}

#[tokio::test]
async fn a_bounded_aftermath_queue_loses_no_work() {
    let hub = Hub::new();
    hub.set_limits(Limits {
        aftermath_max: 1,
        ..Limits::default()
    });
    let mut work = hub.take_aftermath().expect("feed");
    for log_id in 1..=3 {
        let purge = Purge {
            ends: vec![CallEnd {
                log_id,
                answered: true,
                dm_users: Vec::new(),
            }],
            p2p: Vec::new(),
        };
        hub.inner.aftermath.send(Aftermath::Settle(purge));
        assert!(hub.inner.aftermath.queued() <= 1, "never past the bound");
    }
    let mut ended = Vec::new();
    while let Some(job) = tokio::time::timeout(Duration::from_millis(50), work.recv())
        .await
        .ok()
        .flatten()
    {
        if let Aftermath::Settle(purge) = job {
            ended.extend(purge.ends.iter().map(|end| end.log_id));
        }
    }
    assert_eq!(ended, [1, 2, 3], "every call log is finalized");
}

#[tokio::test]
async fn an_unbounded_queue_keeps_every_item_in_order() {
    let hub = Hub::new();
    let mut shown = hub.take_shown().expect("feed");
    for n in 0..100 {
        hub.inner.shown.send((format!("u{n}"), n % 2 == 0));
    }
    assert_eq!(hub.inner.shown.queued(), 100);
    for n in 0..100 {
        assert_eq!(shown.recv().await, Some((format!("u{n}"), n % 2 == 0)));
    }
}

#[test]
fn inbox_and_pacing_sizes_follow_the_limits() {
    let hub = Hub::new();
    hub.set_limits(Limits {
        inbox_frames: 4,
        paced_users_max: 100,
        ..Limits::default()
    });
    let conn = hub.next_conn();
    let mut inbox = hub.open(conn, &HashSet::from([Topic::User("alice".to_string())]));
    for n in 0..10 {
        hub.inner.router.deliver(WsEvent::UserUnblocked {
            username: "alice".to_string(),
            blocked: format!("b{n}"),
        });
    }
    let mut got = 0;
    while inbox.rx.try_recv().is_ok() {
        got += 1;
    }
    assert_eq!(got, 4, "the inbox holds WS_INBOX_FRAMES");
    let now = Instant::now();
    for n in 0..500 {
        hub.voice_ok_at(&format!("u{n}"), now);
    }
    assert!(hub.inner.pacing.voice.len() <= 100);
}
