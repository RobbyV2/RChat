use super::*;

#[tokio::test]
async fn unconfirmed_signals_are_bounded_per_call_without_a_resync() {
    let (hub, _rx) = Hub::replicated();
    for _ in 0..1000 {
        hub.broadcast(signal("alice", "bob", Some(1), None));
    }
    for _ in 0..10 {
        hub.broadcast(signal("alice", "bob", None, Some(7)));
    }
    hub.force_offline("rchat", "alice");
    assert_eq!(hub.pending_len(), (SIGNALS_PENDING + 10 + 1, false));
    let kept: Vec<u64> = hub
        .inner
        .link
        .as_ref()
        .unwrap()
        .pending
        .lock()
        .unwrap()
        .keys()
        .copied()
        .collect();
    assert_eq!(
        kept[0],
        1000 - SIGNALS_PENDING as u64 + 1,
        "the oldest signals go first"
    );
}

#[tokio::test]
async fn legacy_snapshot_makes_every_node_announce_again() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let (alice, bob) = (a.next_conn(), b.next_conn());
    a.set_online("alice", alice, &["rchat"]);
    b.set_online("bob", bob, &["rchat"]);
    a.flush().await;
    b.flush().await;
    let (id, current) = a.snapshot().unwrap();
    let mut epochs = [a.epoch(), b.epoch()];
    for epoch in epochs.iter_mut() {
        epoch.borrow_and_update();
    }
    let old = r#"{"presence":{"rchat":{"olga":[8589934592]}},"rooms":{},"calls":{},"p2p":{},"peers":{},"clock":0}"#;
    let (c, out) = Hub::replicated();
    c.restore(&id, old).unwrap();
    bus.attach(c.clone(), out, Some(&id));
    assert_eq!(c.online_set("rchat"), HashSet::from(["olga".to_string()]));
    c.flush().await;
    for ((hub, conn, user), epoch) in [(&a, alice, "alice"), (&b, bob, "bob")]
        .into_iter()
        .zip(epochs.iter_mut())
    {
        assert!(epoch.has_changed().unwrap());
        epoch.borrow_and_update();
        hub.set_online(user, conn, &["rchat"]);
        hub.flush().await;
    }
    assert_eq!(
        c.online_set("rchat"),
        HashSet::from(["alice", "bob", "olga"].map(String::from))
    );
    a.reannounce_all();
    a.flush().await;
    assert!(!epochs[0].has_changed().unwrap() && !epochs[1].has_changed().unwrap());
    let (d, out) = Hub::replicated();
    d.restore(&id, &current).unwrap();
    bus.attach(d.clone(), out, Some(&id));
    d.flush().await;
    assert!(!epochs[0].has_changed().unwrap());
}

#[tokio::test]
async fn online_anywhere_spans_instances() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let conn = a.next_conn();
    let _inbox = a.open(conn, &HashSet::from([Topic::User("zoe".to_string())]));
    assert!(a.is_online_anywhere("zoe") && !b.is_online_anywhere("zoe"));
    a.set_online("zoe", conn, &[] as &[&str]);
    a.flush().await;
    b.flush().await;
    assert!(b.is_online_anywhere("zoe") && !b.is_online_anywhere("yan"));
    assert!(b.online_set("rchat").is_empty());
    a.close(conn);
    assert!(!a.is_online_anywhere("zoe") && b.is_online_anywhere("zoe"));
    let _ = a.drop_conn("zoe", conn).await;
    a.flush().await;
    b.flush().await;
    assert!(!b.is_online_anywhere("zoe"));
}

#[tokio::test]
async fn presence_across_instances() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let mut rx_b = b.subscribe();
    let conn_a = a.next_conn();
    let conn_b = b.next_conn();
    a.set_online("alice", conn_a, &["rchat"]);
    a.flush().await;
    assert!(b.is_online("rchat", "alice"));
    assert_eq!(b.online_set("rchat"), HashSet::from(["alice".to_string()]));
    b.set_online("alice", conn_b, &["rchat"]);
    b.flush().await;
    a.announce("alice", conn_a, false, None);
    a.flush().await;
    assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
    b.announce("alice", conn_b, false, None);
    b.flush().await;
    assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
    bus.advance(PRESENCE_GRACE_MS);
    b.flush().await;
    assert!(!a.is_online("rchat", "alice") && !b.is_online("rchat", "alice"));
    assert_eq!(
        presence_of(&drain(&mut rx_b)),
        vec![
            ("rchat".to_string(), "alice".to_string(), true),
            ("rchat".to_string(), "alice".to_string(), false)
        ]
    );
}

#[tokio::test]
async fn voice_and_call_across_instances() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let mut rx_a = a.subscribe();
    let (alice, bob) = (a.next_conn(), b.next_conn());
    assert!(a.voice_join("alice", alice, "rchat", 5).await.is_empty());
    assert!(b.voice_join("bob", bob, "rchat", 5).await.is_empty());
    let both = vec![(5, vec!["alice".to_string(), "bob".to_string()])];
    assert_eq!(a.rooms_in("rchat", None), both);
    assert_eq!(b.rooms_in("rchat", Some(5)), both);
    assert!(a.rtc_shared("alice", "bob", Some(5), None));
    assert!(b.rtc_shared("bob", "alice", Some(5), None));
    assert_eq!(
        voice_of(&drain(&mut rx_a)),
        vec![(5, vec!["alice".to_string()]), (5, both[0].1.clone())]
    );
    a.call_start(
        "alice",
        alice,
        9,
        dm_users(),
        CallKind::Rtc,
        false,
        70,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        b.call_start("bob", bob, 9, dm_users(), CallKind::Rtc, false, 71, None)
            .await,
        Err("You are already in a call".to_string())
    );
    let (log_id, users) = b.call_accept("bob", bob, 9, None).await.unwrap();
    assert_eq!((log_id, users), (70, dm_users()));
    assert!(a.rooms_in("rchat", None).is_empty());
    assert!(a.rtc_shared("alice", "bob", None, Some(9)));
    assert!(b.rtc_shared("alice", "bob", None, Some(9)));
    let end = a.call_end("alice", 9).await.unwrap();
    assert!(end.answered && end.log_id == 70);
    assert!(!b.rtc_shared("alice", "bob", None, Some(9)));
    assert_eq!(
        calls_of(&drain(&mut rx_a)),
        vec![
            (9, CallPhase::Ringing),
            (9, CallPhase::Active),
            (9, CallPhase::Ended)
        ]
    );
    assert_eq!(
        to_bus_json(&a.voice_snapshot()).unwrap(),
        to_bus_json(&b.voice_snapshot()).unwrap()
    );
}

#[tokio::test]
async fn dead_instance_is_purged() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let mut aftermath = b.take_aftermath().unwrap();
    let mut rx_b = b.subscribe();
    let (alice, bob) = (a.next_conn(), b.next_conn());
    a.set_online("alice", alice, &["rchat"]);
    b.set_online("bob", bob, &["rchat"]);
    a.set_p2p("alice", alice, "peer-a".to_string(), vec!["f".to_string()]);
    a.call_start(
        "alice",
        alice,
        9,
        dm_users(),
        CallKind::P2p,
        false,
        70,
        None,
    )
    .await
    .unwrap();
    b.call_accept("bob", bob, 9, None).await.unwrap();
    assert!(
        b.voice_join("carol", b.next_conn(), "rchat", 5)
            .await
            .is_empty()
    );
    drain(&mut rx_b);
    outlive(&bus, &b).await;
    let evs = drain(&mut rx_b);
    assert_eq!(
        presence_of(&evs),
        vec![("rchat".to_string(), "alice".to_string(), false)]
    );
    assert_eq!(calls_of(&evs), vec![(9, CallPhase::Ended)]);
    assert!(!b.is_online("rchat", "alice") && b.is_online("rchat", "bob"));
    assert!(b.p2p_of("alice").is_none());
    assert_eq!(
        b.rooms_in("rchat", None),
        vec![(5, vec!["carol".to_string()])]
    );
    let Aftermath::Settle(purge) = aftermath.try_recv().unwrap() else {
        panic!("expected the purge aftermath");
    };
    assert_eq!(purge.ends.len(), 1);
    assert!(purge.ends[0].answered && purge.ends[0].log_id == 70);
    assert!(matches!(purge.p2p.as_slice(), [(user, P2pDrop::Offline)] if user == "alice"));
    assert!(!a.is_online("rchat", "alice"));
}

#[tokio::test]
async fn purged_instance_reannounces() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let mut epoch = a.epoch();
    let alice = a.next_conn();
    a.set_online("alice", alice, &["rchat"]);
    a.flush().await;
    outlive(&bus, &b).await;
    assert!(epoch.has_changed().unwrap());
    assert_eq!(epoch.borrow_and_update().lossy, 0);
    a.resync(true);
    assert_eq!(epoch.borrow_and_update().lossy, 1);
    a.set_online("alice", alice, &["rchat"]);
    a.flush().await;
    assert!(b.is_online("rchat", "alice"));
    a.set_online("alice", alice, &[] as &[&str]);
    a.flush().await;
    assert!(!b.is_online("rchat", "alice"));
}

#[tokio::test]
async fn reannounce_repairs_lost_switch() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let alice = a.next_conn();
    let mut replica = Replica::default();
    let viewing = |old: Option<&str>, new: Option<&str>| Op::Viewing {
        user: "alice".to_string(),
        conn: alice,
        old: old.map(str::to_string),
        new: new.map(str::to_string),
    };
    replica.apply(1, viewing(None, Some("one")), T0);
    let stale = replica.apply(
        1,
        Op::Present {
            user: "alice".to_string(),
            conn: alice,
            server: Some("two".to_string()),
        },
        T0 + 1,
    );
    assert_eq!(
        presence_of(&stale.events),
        vec![("two".to_string(), "alice".to_string(), true)]
    );
    a.set_online("alice", alice, &["one"]);
    a.flush().await;
    a.set_online("alice", alice, &["two"]);
    a.flush().await;
    assert!(!b.is_online("one", "alice") && b.is_online("two", "alice"));
    a.set_online("alice", alice, &[] as &[&str]);
    a.flush().await;
    assert!(!b.is_online("two", "alice") && !a.is_online("two", "alice"));
}

#[tokio::test]
async fn departing_instance_clears_its_state() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let alice = a.next_conn();
    a.set_online("alice", alice, &["rchat"]);
    assert!(a.voice_join("alice", alice, "rchat", 5).await.is_empty());
    let purge = a.depart().await.unwrap();
    assert!(purge.ends.is_empty());
    assert!(b.is_online("rchat", "alice"));
    assert!(b.rooms_in("rchat", None).is_empty());
    bus.advance(PRESENCE_GRACE_MS);
    b.flush().await;
    assert!(!b.is_online("rchat", "alice"));
}

#[tokio::test]
async fn bootstrap_from_snapshot() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let (alice, bob) = (a.next_conn(), b.next_conn());
    a.set_online("alice", alice, &["rchat"]);
    assert!(a.voice_join("alice", alice, "rchat", 5).await.is_empty());
    let (id, json) = a.snapshot().unwrap();
    b.set_online("bob", bob, &["rchat"]);
    assert!(b.voice_join("bob", bob, "rchat", 5).await.is_empty());
    let (c, out) = Hub::replicated();
    c.restore(&id, &json).unwrap();
    bus.attach(c.clone(), out, Some(&id));
    let mut rx_c = c.subscribe();
    assert_eq!(c.online_set("rchat"), a.online_set("rchat"));
    assert_eq!(c.rooms_in("rchat", None), a.rooms_in("rchat", None));
    assert_eq!(
        c.rooms_in("rchat", None),
        vec![(5, vec!["alice".to_string(), "bob".to_string()])]
    );
    assert!(drain(&mut rx_c).is_empty());
    let carol = c.next_conn();
    c.set_online("carol", carol, &["rchat"]);
    c.flush().await;
    assert!(a.is_online("rchat", "carol"));
    assert_eq!(a.snapshot().unwrap().1, c.snapshot().unwrap().1);
}

#[tokio::test]
async fn bus_outage_does_not_purge_live_instances() {
    let bus = MemBus::new();
    let hubs: Vec<Hub> = (0..3).map(|_| bus.join()).collect();
    let mut epochs: Vec<_> = hubs.iter().map(|h| h.epoch()).collect();
    let mut rx = hubs[0].subscribe();
    for (i, h) in hubs.iter().enumerate() {
        for u in 0..100 {
            h.set_online(&format!("u{i}_{u}"), h.next_conn(), &["big"]);
        }
        h.flush().await;
    }
    drain(&mut rx);
    bus.advance(DEAD_AFTER_MS + 1_000);
    for h in &hubs {
        h.flush().await;
    }
    let offline = presence_of(&drain(&mut rx))
        .iter()
        .filter(|(_, _, on)| !on)
        .count();
    let resynced = epochs
        .iter_mut()
        .filter(|e| e.has_changed().unwrap())
        .count();
    assert_eq!((offline, resynced), (0, 0));
    assert!(hubs.iter().all(|h| h.online_count("big") == 300));
    for _ in 0..3 {
        bus.advance(DEAD_AFTER_MS / 3);
        hubs[0].flush().await;
        hubs[1].flush().await;
    }
    bus.advance(1_000);
    hubs[0].flush().await;
    let offline = presence_of(&drain(&mut rx))
        .iter()
        .filter(|(s, u, on)| s == "big" && u.starts_with("u2_") && !on)
        .count();
    assert_eq!(offline, 100);
    assert!(hubs.iter().all(|h| h.online_count("big") == 200));
    assert!(epochs[2].has_changed().unwrap());
}

#[tokio::test]
async fn signals_relay_across_instances_in_log_order() {
    let bus = MemBus::new();
    let (a, b) = (bus.join(), bus.join());
    let (mut rx_a, mut rx_b) = (a.subscribe(), b.subscribe());
    let (alice, bob) = (a.next_conn(), b.next_conn());
    a.voice_join("alice", alice, "rchat", 5).await;
    b.voice_join("bob", bob, "rchat", 5).await;
    a.flush().await;
    assert!(a.rtc_shared("alice", "bob", Some(5), None));
    a.broadcast(signal("alice", "bob", Some(5), None));
    a.flush().await;
    b.flush().await;
    let relayed = vec![("alice".to_string(), "bob".to_string())];
    assert_eq!(signals_of(&drain(&mut rx_b)), relayed);
    assert_eq!(signals_of(&drain(&mut rx_a)), relayed);
    // a still saw bob in the room when it checked, but bob's leave on b
    // lands in the log first, so neither instance relays the signal
    assert!(a.rtc_shared("alice", "bob", Some(5), None));
    b.voice_leave("bob").await;
    a.broadcast(signal("alice", "bob", Some(5), None));
    a.flush().await;
    b.flush().await;
    assert!(signals_of(&drain(&mut rx_a)).is_empty());
    assert!(signals_of(&drain(&mut rx_b)).is_empty());

    a.call_start(
        "alice",
        alice,
        9,
        dm_users(),
        CallKind::Rtc,
        false,
        70,
        None,
    )
    .await
    .unwrap();
    b.broadcast(signal("bob", "alice", None, Some(9)));
    b.flush().await;
    a.flush().await;
    assert!(signals_of(&drain(&mut rx_a)).is_empty());
    b.call_accept("bob", bob, 9, None).await.unwrap();
    b.broadcast(signal("bob", "alice", None, Some(9)));
    b.flush().await;
    a.flush().await;
    let back = vec![("bob".to_string(), "alice".to_string())];
    assert_eq!(signals_of(&drain(&mut rx_a)), back);
    assert_eq!(signals_of(&drain(&mut rx_b)), back);
    a.call_end("alice", 9).await.unwrap();
    b.broadcast(signal("bob", "alice", None, Some(9)));
    b.flush().await;
    a.flush().await;
    assert!(signals_of(&drain(&mut rx_a)).is_empty());
    assert!(signals_of(&drain(&mut rx_b)).is_empty());
}

#[tokio::test]
async fn reads_are_coalesced_per_scope() {
    let (hub, mut out) = Hub::replicated();
    hub.coalesce_reads();
    let read = |scope: &str, last_read, pings_until| WsEvent::ReadUpdated {
        username: "alice".to_string(),
        scope: scope.to_string(),
        last_read,
        pings_until,
    };
    hub.broadcast(read("c1", 5, 40));
    hub.broadcast(read("c1", 9, 0));
    hub.broadcast(read("c1", 7, 12));
    hub.broadcast(read("c2", 1, 0));
    assert!(out.try_recv().is_err());
    hub.flush_reads();
    let posted: Vec<(String, i64, i64)> = std::iter::from_fn(|| out.try_recv().ok())
        .map(|env| match env.op {
            Op::Broadcast {
                event:
                    WsEvent::ReadUpdated {
                        scope,
                        last_read,
                        pings_until,
                        ..
                    },
            } => (scope, last_read, pings_until),
            _ => panic!("expected reads"),
        })
        .collect();
    assert_eq!(
        posted,
        vec![("c1".to_string(), 9, 40), ("c2".to_string(), 1, 0)]
    );
}

#[tokio::test]
async fn full_publish_queue_is_recovered_by_a_resync() {
    let (hub, mut out) = Hub::replicated();
    let mut epoch = hub.epoch();
    let conn = hub.next_conn();
    for i in 0..=OUT_CAP {
        hub.set_online("alice", conn, &[&format!("s{}", i % 2)]);
    }
    let queued: Vec<Envelope> = std::iter::from_fn(|| out.try_recv().ok()).collect();
    assert_eq!(queued.len(), OUT_CAP);
    for (i, env) in queued.into_iter().enumerate() {
        hub.ingest(&format!("{}-{i}", T0), env, true);
    }
    assert!(!epoch.has_changed().unwrap());
    hub.heartbeat();
    hub.ingest(&format!("{}-0", T0 + 1), out.try_recv().unwrap(), true);
    assert!(epoch.has_changed().unwrap());
    assert_eq!(epoch.borrow_and_update().lossy, 0);
}

#[tokio::test]
async fn unconfirmed_cleanup_finishes_in_the_background() {
    let (hub, mut out) = Hub::replicated();
    let mut aftermath = hub.take_aftermath().unwrap();
    let conn = hub.next_conn();
    hub.set_online("alice", conn, &["rchat"]);
    hub.set_p2p("alice", conn, "peer".to_string(), vec!["f".to_string()]);
    let started = std::time::Instant::now();
    let (ends, drop) = hub.drop_conn("alice", conn).await;
    assert!(started.elapsed() >= CALL_TIMEOUT);
    assert!(ends.is_empty() && matches!(drop, P2pDrop::Kept));
    let posted: Vec<Envelope> = std::iter::from_fn(|| out.try_recv().ok()).collect();
    assert_eq!(posted.len(), 3);
    for (i, env) in posted.into_iter().enumerate() {
        hub.ingest(&format!("{T0}-{i}"), env, true);
    }
    assert!(hub.is_online("rchat", "alice"));
    hub.heartbeat();
    let beat = out.try_recv().unwrap();
    hub.ingest(&format!("{}-0", T0 + PRESENCE_GRACE_MS), beat, true);
    assert!(!hub.is_online("rchat", "alice"));
    let Ok(Aftermath::Settle(purge)) = aftermath.try_recv() else {
        panic!("the late drop should be settled");
    };
    assert!(matches!(purge.p2p.as_slice(), [(user, P2pDrop::Offline)] if user == "alice"));
}
