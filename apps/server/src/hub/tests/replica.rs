use super::*;
use crate::hub::replica::Index;

fn script() -> Vec<(u32, Op, i64)> {
    let s = |v: &str| v.to_string();
    vec![
        (
            1,
            Op::Viewing {
                user: s("alice"),
                conn: 1 << 32,
                old: None,
                new: Some(s("rchat")),
            },
            T0,
        ),
        (
            2,
            Op::Viewing {
                user: s("bob"),
                conn: 2 << 32,
                old: None,
                new: Some(s("rchat")),
            },
            T0 + 10,
        ),
        (
            2,
            Op::Viewing {
                user: s("carol"),
                conn: (2 << 32) | 1,
                old: None,
                new: Some(s("other")),
            },
            T0 + 15,
        ),
        (
            1,
            Op::VoiceJoin {
                user: s("alice"),
                conn: 1 << 32,
                server: s("rchat"),
                channel_id: 5,
                cap: 0,
            },
            T0 + 20,
        ),
        (
            2,
            Op::VoiceJoin {
                user: s("carol"),
                conn: (2 << 32) | 1,
                server: s("other"),
                channel_id: 6,
                cap: 0,
            },
            T0 + 25,
        ),
        (
            2,
            Op::CallStart {
                user: s("bob"),
                conn: 2 << 32,
                dm_id: 9,
                dm_users: dm_users(),
                kind: CallKind::Rtc,
                video: false,
                log_id: 70,
                call_id: String::new(),
                peer_id: None,
                relays: Vec::new(),
            },
            T0 + 30,
        ),
        (
            2,
            Op::SetP2p {
                user: s("bob"),
                conn: 2 << 32,
                peer_id: s("peer"),
                ids: vec![s("f1")],
                relays: BTreeMap::new(),
            },
            T0 + 40,
        ),
        (
            1,
            Op::Broadcast {
                event: WsEvent::Banned { username: s("bob") },
            },
            T0 + 50,
        ),
        (1, Op::Heartbeat, T0 + 20_000),
        (1, Op::Heartbeat, T0 + 40_000),
        (1, Op::SweepVoice { idle: 60 }, T0 + 59_000),
        (1, Op::SweepVoice { idle: 60 }, T0 + 80_100),
    ]
}

#[test]
fn apply_is_deterministic() {
    let run = || {
        let mut replica = Replica::default();
        let mut events = Vec::new();
        for (origin, op, t) in script() {
            let applied = replica.apply(origin, op, t);
            events.extend(applied.events.iter().map(|ev| to_bus_json(ev).unwrap()));
        }
        (serde_json::to_string(&replica).unwrap(), events)
    };
    let (state, events) = run();
    assert_eq!(run(), (state.clone(), events.clone()));
    let reloaded: Replica = serde_json::from_str(&state).unwrap();
    assert_eq!(serde_json::to_string(&reloaded).unwrap(), state);
    assert!(
        events
            .iter()
            .any(|e| e.contains("\"type\":\"presence_changed\"")
                && e.contains("\"bob\"")
                && e.contains("false"))
    );
    assert!(
        events
            .iter()
            .any(|e| e.contains("Voice ended after 60s alone"))
    );
    let replica: Replica = serde_json::from_str(&state).unwrap();
    assert!(replica.rooms.is_empty());
    assert!(replica.calls.is_empty());
    assert!(replica.p2p.is_empty());
    assert_eq!(
        replica.index.presence.keys().collect::<Vec<_>>(),
        vec!["rchat"]
    );
}

#[test]
fn sweep_uses_op_time() {
    let mut replica = Replica::default();
    let join = Op::VoiceJoin {
        user: "alice".to_string(),
        conn: 1 << 32,
        server: "rchat".to_string(),
        channel_id: 5,
        cap: 0,
    };
    replica.apply(1, join, T0);
    let early = replica.apply(1, Op::SweepVoice { idle: 60 }, T0 + 59_999);
    assert!(early.events.is_empty());
    let late = replica.apply(1, Op::SweepVoice { idle: 60 }, T0 + 60_000);
    assert_eq!(voice_of(&late.events), vec![(5, Vec::new())]);
}

#[test]
fn duplicates_are_ignored() {
    let mut replica = Replica::default();
    assert!(replica.admit(7, 1));
    assert!(replica.admit(7, 2));
    assert!(!replica.admit(7, 2));
    assert!(!replica.admit(7, 1));
    assert!(replica.admit(8, 1));
}

#[test]
fn skipped_seqs_are_remembered() {
    let mut replica = Replica::default();
    assert!(replica.admit(7, 1) && replica.admit(7, 2) && replica.admit(7, 5));
    assert!(replica.kept(7, 2) && replica.kept(7, 5));
    assert!(!replica.kept(7, 3) && !replica.kept(7, 4) && !replica.kept(7, 6));
    assert!(!replica.admit(7, 4));
    assert!(replica.admit(9, 40));
    assert!(replica.kept(9, 39));
    let json = serde_json::to_string(&replica).unwrap();
    let reloaded: Replica = serde_json::from_str(&json).unwrap();
    assert!(!reloaded.kept(7, 3) && reloaded.kept(7, 5));
    for seq in (7..200).step_by(2) {
        replica.admit(7, seq);
    }
    assert_eq!(replica.peers[&7].gaps.len(), GAPS_KEPT);
    assert!(!replica.kept(7, 196) && replica.kept(7, 197));
}

#[test]
fn presence_is_kept_per_user_and_reads_old_state() {
    let s = |v: &str| v.to_string();
    let (a1, a2, bob) = (1_u64 << 32, (1_u64 << 32) | 1, (1_u64 << 32) | 2);
    let mut replica = Replica::default();
    let first = replica.apply(1, online_op("alice", a1, 0, Some(&["one", "two"])), T0);
    assert_eq!(
        presence_of(&first.events),
        vec![(s("one"), s("alice"), true), (s("two"), s("alice"), true)]
    );
    assert!(
        replica
            .apply(1, online_op("alice", a2, 0, None), T0 + 1)
            .events
            .is_empty()
    );
    replica.apply(1, online_op("bob", bob, 0, Some(&[])), T0 + 2);
    let moved = replica.apply(
        1,
        Op::Rescope {
            user: s("alice"),
            add: vec![s("three")],
            remove: vec![s("one")],
            hidden: None,
            seq: 0,
        },
        T0 + 3,
    );
    assert_eq!(
        presence_of(&moved.events),
        vec![
            (s("one"), s("alice"), false),
            (s("three"), s("alice"), true)
        ]
    );
    let json = serde_json::to_string(&replica).unwrap();
    assert!(json.contains(
        r#""alice":{"servers":["three","two"],"conns":{"4294967296":{"lit":true,"at":1700000000000},"4294967297":{"lit":true,"at":1700000000001}},"up":true,"shows":1700000010000}"#
    ));
    assert!(!json.contains("\"presence\""));
    let reloaded: Replica = serde_json::from_str(&json).unwrap();
    assert!(!reloaded.legacy);
    assert_eq!(serde_json::to_string(&reloaded).unwrap(), json);
    assert_eq!(reloaded.index, reindexed(&replica));

    let old = r#"{"presence":{"rchat":{"carol":[8589934592]}},"rooms":{},"calls":{},"p2p":{},"peers":{},"clock":0}"#;
    let mut legacy: Replica = serde_json::from_str(old).unwrap();
    assert!(legacy.legacy);
    assert_eq!(
        legacy.index.presence,
        BTreeMap::from([(s("rchat"), BTreeSet::from([s("carol")]))])
    );
    let viewing: Op = serde_json::from_str(
        r#"{"op":"viewing","user":"dave","conn":8589934593,"old":null,"new":"rchat"}"#,
    )
    .unwrap();
    legacy.apply(2, viewing, T0);
    assert!(legacy.index.presence["rchat"].contains("dave"));
    let present: Op =
        serde_json::from_str(r#"{"op":"present","user":"dave","conn":8589934593,"server":null}"#)
            .unwrap();
    assert!(legacy.apply(2, present, T0 + 1).events.is_empty());
    legacy.apply(2, drop_op("carol", 2 << 32), T0 + 2);
    let gone = legacy.apply(2, Op::Heartbeat, T0 + 2 + PRESENCE_GRACE_MS);
    assert_eq!(
        presence_of(&gone.events),
        vec![
            (s("rchat"), s("dave"), false),
            (s("rchat"), s("carol"), false)
        ]
    );
    assert!(legacy.seen.is_empty() && legacy.index.presence.is_empty());
    assert_eq!(legacy.index, reindexed(&legacy));
}

#[test]
fn offline_waits_out_the_grace() {
    let s = |v: &str| v.to_string();
    let (c1, c2, c3) = (1_u64 << 32, (1_u64 << 32) | 1, (1_u64 << 32) | 2);
    let mut replica = Replica::default();
    let at = |r: &mut Replica, op: Op, t: i64| presence_of(&r.apply(1, op, T0 + t).events);
    assert_eq!(
        at(&mut replica, online_op("alice", c1, 0, Some(&["one"])), 0),
        vec![(s("one"), s("alice"), true)]
    );
    assert!(at(&mut replica, drop_op("alice", c1), 1_000).is_empty());
    assert!(replica.index.presence["one"].contains("alice"));
    assert!(
        at(
            &mut replica,
            online_op("alice", c2, 0, Some(&["one"])),
            1_000 + PRESENCE_GRACE_MS - 1
        )
        .is_empty()
    );
    assert!(at(&mut replica, Op::Heartbeat, 30_000).is_empty());
    assert!(at(&mut replica, drop_op("alice", c2), 40_000).is_empty());
    assert!(at(&mut replica, Op::Heartbeat, 40_000 + PRESENCE_GRACE_MS - 1).is_empty());
    assert_eq!(
        at(&mut replica, Op::Heartbeat, 40_000 + PRESENCE_GRACE_MS),
        vec![(s("one"), s("alice"), false)]
    );
    assert!(replica.seen.is_empty());

    let mode = |hidden: bool| Op::Broadcast {
        event: WsEvent::PresenceMode {
            username: s("bob"),
            appear_offline: hidden,
            seq: 0,
        },
    };
    let t = 100_000;
    assert_eq!(
        at(&mut replica, online_op("bob", c3, 0, Some(&["one"])), t),
        vec![(s("one"), s("bob"), true)]
    );
    assert_eq!(
        at(&mut replica, mode(true), t + 1_000),
        vec![(s("one"), s("bob"), false)]
    );
    assert!(replica.seen["bob"].hidden && !replica.seen["bob"].up);
    assert_eq!(
        at(&mut replica, mode(false), t + 30_000),
        vec![(s("one"), s("bob"), true)]
    );
    let banned = Op::Broadcast {
        event: WsEvent::Banned { username: s("bob") },
    };
    assert_eq!(
        at(&mut replica, banned, t + 31_000),
        vec![(s("one"), s("bob"), false)]
    );
    assert_eq!(replica.index, reindexed(&replica));
}

#[test]
fn appear_offline_hides_at_once_even_inside_the_grace() {
    let s = |v: &str| v.to_string();
    let (c1, c2, c3) = (1_u64 << 32, (1_u64 << 32) | 1, (2_u64 << 32) | 1);
    let mut replica = Replica::default();
    let at = |r: &mut Replica, op: Op, t: i64| presence_of(&r.apply(1, op, T0 + t).events);
    let mode = |hidden: bool| Op::Broadcast {
        event: WsEvent::PresenceMode {
            username: s("bob"),
            appear_offline: hidden,
            seq: 0,
        },
    };
    assert_eq!(
        at(
            &mut replica,
            online_op("bob", c1, 0, Some(&["one", "two"])),
            0
        ),
        vec![(s("one"), s("bob"), true), (s("two"), s("bob"), true)]
    );
    // A reconnect inside the grace is silent, and appear offline right after it hides
    // bob at once in every server.
    assert!(at(&mut replica, drop_op("bob", c1), 1_000).is_empty());
    assert!(
        at(
            &mut replica,
            online_op("bob", c2, 0, Some(&["one", "two"])),
            2_000
        )
        .is_empty()
    );
    assert_eq!(
        at(&mut replica, mode(true), 2_001),
        vec![(s("one"), s("bob"), false), (s("two"), s("bob"), false)]
    );
    assert!(!replica.index.presence.contains_key("one"));
    // Also while lingering after a disconnect (another device still connected elsewhere
    // is dark): the hide does not wait for the grace.
    assert_eq!(
        at(&mut replica, mode(false), 3_000),
        vec![(s("one"), s("bob"), true), (s("two"), s("bob"), true)]
    );
    assert!(at(&mut replica, drop_op("bob", c2), 4_000).is_empty());
    assert!(replica.seen["bob"].gone > 0);
    assert_eq!(
        at(
            &mut replica,
            Op::Rescope {
                user: s("bob"),
                add: vec![],
                remove: vec![],
                hidden: Some(true),
                seq: 0,
            },
            4_500
        ),
        vec![(s("one"), s("bob"), false), (s("two"), s("bob"), false)]
    );
    // Only bob's rate state and appear-offline version stay, until the rates drain.
    let rest = &replica.seen["bob"];
    assert!(rest.conns.is_empty() && rest.servers.is_empty() && !rest.up && rest.hidden);
    assert!(replica.index.scoped.is_empty() && replica.index.lingering.is_empty());
    // A connection that opens already hidden never shows.
    let hidden = Op::Online {
        user: s("bob"),
        conn: c3,
        lit: true,
        cap: 0,
        scope: Some(Scope {
            servers: vec![s("one")],
            hidden: true,
            seq: 0,
        }),
        every: 0,
    };
    assert!(at(&mut replica, hidden, 5_000).is_empty());
    assert_eq!(replica.index, reindexed(&replica));
}

#[test]
fn a_stale_appear_offline_value_never_undoes_a_newer_one() {
    let s = |v: &str| v.to_string();
    let (c1, c2) = (1_u64 << 32, 2_u64 << 32);
    let mut replica = Replica::default();
    let at = |r: &mut Replica, op: Op, t: i64| presence_of(&r.apply(1, op, T0 + t).events);
    let mode = |hidden: bool, seq: i64| Op::Broadcast {
        event: WsEvent::PresenceMode {
            username: s("bob"),
            appear_offline: hidden,
            seq,
        },
    };
    let opened = |conn: u64, hidden: bool, seq: i64| Op::Online {
        user: s("bob"),
        conn,
        lit: true,
        cap: 0,
        scope: Some(Scope {
            servers: vec![s("one")],
            hidden,
            seq,
        }),
        every: 0,
    };
    assert_eq!(
        at(&mut replica, opened(c1, false, 4), 0),
        vec![(s("one"), s("bob"), true)]
    );
    assert_eq!(
        at(&mut replica, mode(true, 5), 1_000),
        vec![(s("one"), s("bob"), false)]
    );
    // A connection that read version 4 before the change announces after it, and a delta
    // or an event of an older version arrives late: bob stays hidden.
    assert!(at(&mut replica, opened(c2, false, 4), 2_000).is_empty());
    let late = Op::Rescope {
        user: s("bob"),
        add: vec![],
        remove: vec![],
        hidden: Some(false),
        seq: 4,
    };
    assert!(at(&mut replica, late, 3_000).is_empty());
    assert!(at(&mut replica, mode(false, 4), 4_000).is_empty());
    assert!(!replica.index.presence.contains_key("one"));
    assert_eq!(
        (replica.seen["bob"].hidden, replica.seen["bob"].mode),
        (true, 5)
    );
    // The same version again, or a newer one, applies.
    assert!(at(&mut replica, mode(true, 5), 5_000).is_empty());
    assert_eq!(
        at(&mut replica, mode(false, 6), 6_000),
        vec![(s("one"), s("bob"), true)]
    );
    assert_eq!(replica.index, reindexed(&replica));
    // A new connection whose scope adds a server and hides bob shows him nowhere first.
    let wider = Op::Online {
        user: s("bob"),
        conn: c2,
        lit: true,
        cap: 0,
        scope: Some(Scope {
            servers: vec![s("one"), s("two")],
            hidden: true,
            seq: 7,
        }),
        every: 0,
    };
    assert_eq!(
        at(&mut replica, wider, 7_000),
        vec![(s("one"), s("bob"), false)]
    );
    assert_eq!(replica.index, reindexed(&replica));
}

#[test]
fn hidden_users_keep_their_connect_count_after_closing() {
    let s = |v: &str| v.to_string();
    let mut replica = Replica::default();
    let every = 60_000;
    let mut events = 0;
    for i in 0..3_u64 {
        let conn = (1_u64 << 32) | i;
        let open = Op::Online {
            user: s("bob"),
            conn,
            lit: true,
            cap: 0,
            scope: Some(Scope {
                servers: vec![s("one")],
                hidden: true,
                seq: 1,
            }),
            every,
        };
        let t = T0 + i as i64 * 100;
        events += replica.apply(1, open, t).events.len();
        events += replica.apply(1, drop_op("bob", conn), t + 50).events.len();
        assert_eq!(replica.index, reindexed(&replica));
    }
    assert_eq!(events, 0);
    // Three opens are still counted, though bob has no connection left.
    let rest = &replica.seen["bob"];
    assert!(rest.conns.is_empty() && rest.servers.is_empty() && rest.hidden);
    assert_eq!(rest.opened, T0 + 3 * every as i64);
    assert_eq!(rest.wake, rest.opened);
    // Once the count drains, bob is forgotten.
    let later = online_op("carol", 2 << 32, 0, Some(&[]));
    replica.apply(1, later, rest.opened);
    assert!(!replica.seen.contains_key("bob"));
    assert!(replica.index.waking.iter().all(|(_, u)| u != "bob"));
}

#[test]
fn appear_offline_toggle_storms_are_bounded_and_end_in_the_last_state() {
    let s = |v: &str| v.to_string();
    let names: Vec<String> = (0..50).map(|i| format!("s{i:02}")).collect();
    let all: Vec<&str> = names.iter().map(String::as_str).collect();
    let n = all.len();
    let mut replica = Replica::default();
    let at = |r: &mut Replica, op: Op, t: i64| presence_of(&r.apply(1, op, T0 + t).events);
    let mode = |hidden: bool| Op::Broadcast {
        event: WsEvent::PresenceMode {
            username: s("bob"),
            appear_offline: hidden,
            seq: 0,
        },
    };
    assert_eq!(
        at(&mut replica, online_op("bob", 1 << 32, 0, Some(&all)), 0).len(),
        n
    );
    // 200 toggles in 2 s: every hide is immediate; shows past the burst wait.
    let mut events = 0;
    for i in 0..200_i64 {
        let ev = at(&mut replica, mode(i % 2 == 0), 1 + i * 10);
        if i % 2 == 0 {
            assert!(
                !replica.index.presence.contains_key("s00"),
                "hide {i} waited"
            );
        }
        events += ev.len();
    }
    // The first show was spent connecting: three more shows, four hides.
    assert_eq!(events, 2 * n * (SHOW_BURST as usize - 1) + n);
    // The last toggle showed bob; it comes due when the rate allows, once.
    assert!(!replica.seen["bob"].up && replica.seen["bob"].wake > 0);
    assert_eq!(replica.index, reindexed(&replica));
    let wake = replica.seen["bob"].wake - T0;
    assert!(at(&mut replica, Op::Heartbeat, wake - 1).is_empty());
    let shown = at(&mut replica, Op::Heartbeat, wake);
    assert_eq!(shown.len(), n);
    assert!(
        shown
            .iter()
            .all(|(_, user, online)| user == "bob" && *online)
    );
    assert!(at(&mut replica, Op::Heartbeat, wake + 60_000).is_empty());
    // A storm that ends hidden leaves bob hidden, with no show due.
    let t = wake + 100_000;
    for i in 0..21_i64 {
        at(&mut replica, mode(i % 2 == 0), t + i);
    }
    assert!(!replica.index.presence.contains_key("s00"));
    assert!(replica.seen["bob"].hidden && !replica.seen["bob"].up);
    let later = replica.seen["bob"].wake.max(T0 + t) - T0 + 60_000;
    assert!(at(&mut replica, Op::Heartbeat, later).is_empty());
    assert!(!replica.index.presence.contains_key("s00"));
    assert_eq!(replica.seen["bob"].wake, 0);
}

#[test]
fn connections_per_user_are_capped_and_the_replica_stays_small() {
    let names: Vec<String> = (0..PRESENCE_SERVERS_MAX)
        .map(|i| format!("server-{i:04}"))
        .collect();
    let all: Vec<&str> = names.iter().map(String::as_str).collect();
    let mut replica = Replica::default();
    let mut evicted = Vec::new();
    let mut events = 0;
    for i in 0..200_u64 {
        let scope = (i % 50 == 0).then_some(all.as_slice());
        let applied = replica.apply(
            1,
            online_op("alice", (1 << 32) | i, 20, scope),
            T0 + i as i64,
        );
        events += presence_of(&applied.events).len();
        evicted.extend(applied.evicted);
    }
    assert_eq!(events, PRESENCE_SERVERS_MAX);
    assert_eq!(
        evicted,
        (0..180).map(|i| (1 << 32) | i).collect::<Vec<u64>>()
    );
    let seen = &replica.seen["alice"];
    assert_eq!(
        seen.conns.keys().copied().collect::<Vec<u64>>(),
        (180..200).map(|i| (1 << 32) | i).collect::<Vec<u64>>()
    );
    assert_eq!(seen.servers.len(), PRESENCE_SERVERS_MAX);
    let entries: usize = replica.index.presence.values().map(BTreeSet::len).sum();
    assert_eq!(entries, PRESENCE_SERVERS_MAX);
    let json = serde_json::to_string(&replica).unwrap();
    assert!(json.len() < 16_000 + 20 * 64, "{} bytes", json.len());

    let mut add = |server: &str| {
        let op = Op::Rescope {
            user: "alice".to_string(),
            add: vec![server.to_string()],
            remove: Vec::new(),
            hidden: None,
            seq: 0,
        };
        presence_of(&replica.apply(1, op, T0 + 1_000).events)
    };
    assert!(add("zed").is_empty());
    assert_eq!(
        add("aaa"),
        vec![
            ("server-0999".to_string(), "alice".to_string(), false),
            ("aaa".to_string(), "alice".to_string(), true)
        ]
    );
    assert_eq!(replica.seen["alice"].servers.len(), PRESENCE_SERVERS_MAX);
    assert_eq!(replica.index, reindexed(&replica));
}

#[test]
fn unknown_ops_fail_alone() {
    let future = r#"{"origin":7,"seq":1,"op":{"op":"future_op","user":"x"}}"#;
    assert!(serde_json::from_str::<Envelope>(future).is_err());
    let next = r#"{"origin":7,"seq":2,"op":{"op":"online","user":"amy","conn":30064771072,"scope":{"servers":["rchat"]}}}"#;
    let Envelope { origin, seq, op } = serde_json::from_str(next).unwrap();
    let mut replica = Replica::default();
    assert!(replica.admit(origin, seq));
    let applied = replica.apply(origin, op, T0);
    assert_eq!(
        presence_of(&applied.events),
        vec![("rchat".to_string(), "amy".to_string(), true)]
    );
}

fn reindexed(replica: &Replica) -> Index {
    let mut copy = replica.detached();
    copy.reindex();
    copy.index
}

#[test]
fn indexes_follow_every_op() {
    let s = |v: &str| v.to_string();
    let mut replica = Replica::default();
    let mut ops = script();
    let t = T0 + 100_000;
    let more = vec![
        Op::Viewing {
            user: s("dave"),
            conn: 3 << 32,
            old: None,
            new: Some(s("one")),
        },
        Op::Present {
            user: s("dave"),
            conn: 3 << 32,
            server: Some(s("two")),
        },
        Op::Online {
            user: s("dave"),
            conn: 3 << 32,
            lit: true,
            cap: 2,
            scope: Some(Scope {
                servers: vec![s("one"), s("two")],
                hidden: false,
                seq: 0,
            }),
            every: 0,
        },
        Op::Online {
            user: s("hal"),
            conn: (3 << 32) | 4,
            lit: true,
            cap: 0,
            scope: Some(Scope {
                servers: vec![s("two")],
                hidden: false,
                seq: 0,
            }),
            every: 0,
        },
        Op::Online {
            user: s("hal"),
            conn: (3 << 32) | 5,
            lit: false,
            cap: 0,
            scope: None,
            every: 0,
        },
        Op::Rescope {
            user: s("hal"),
            add: vec![s("one")],
            remove: vec![s("two")],
            hidden: None,
            seq: 0,
        },
        Op::Broadcast {
            event: WsEvent::PresenceMode {
                username: s("hal"),
                appear_offline: true,
                seq: 0,
            },
        },
        Op::DropConn {
            user: s("hal"),
            conn: (3 << 32) | 4,
        },
        Op::Broadcast {
            event: WsEvent::MemberLeft {
                server: s("one"),
                username: s("dave"),
            },
        },
        Op::VoiceJoin {
            user: s("dave"),
            conn: 3 << 32,
            server: s("two"),
            channel_id: 11,
            cap: 0,
        },
        Op::VoiceJoin {
            user: s("erin"),
            conn: (3 << 32) | 1,
            server: s("two"),
            channel_id: 11,
            cap: 0,
        },
        Op::Broadcast {
            event: WsEvent::ServerRenamed {
                old_name: s("two"),
                server: crate::api::ServerSummaryLite {
                    name: s("deux"),
                    display_name: s("deux"),
                    creator: None,
                    has_password: false,
                    banner_color: None,
                    name_color: None,
                    public_read: None,
                },
            },
        },
        Op::CallStart {
            user: s("frank"),
            conn: (3 << 32) | 2,
            dm_id: 4,
            dm_users: vec![s("frank"), s("gina")],
            kind: CallKind::Rtc,
            video: false,
            log_id: 9,
            call_id: String::new(),
            peer_id: None,
            relays: Vec::new(),
        },
        Op::CallAccept {
            user: s("gina"),
            conn: (3 << 32) | 3,
            dm_id: 4,
            peer_id: None,
            relays: Vec::new(),
        },
        Op::VoiceJoin {
            user: s("gina"),
            conn: (3 << 32) | 3,
            server: s("deux"),
            channel_id: 11,
            cap: 0,
        },
        Op::Broadcast {
            event: WsEvent::MembersPurged {
                server: s("deux"),
                usernames: vec![s("dave")],
            },
        },
        Op::EvictVoice {
            user: s("erin"),
            channel_id: 11,
        },
        Op::DropConn {
            user: s("gina"),
            conn: (3 << 32) | 3,
        },
        Op::Broadcast {
            event: WsEvent::ServerDeleted { name: s("deux") },
        },
        Op::Depart,
    ];
    ops.extend(
        more.into_iter()
            .enumerate()
            .map(|(i, op)| (3, op, t + i as i64 * 10)),
    );
    for (origin, op, at) in ops {
        replica.apply(origin, op, at);
        assert_eq!(replica.index, reindexed(&replica));
    }
    assert!(
        replica
            .index
            .lingering
            .iter()
            .all(|(_, u)| replica.seen[u].up)
    );
}

#[test]
fn full_voice_rooms_turn_joins_away() {
    let mut replica = Replica::default();
    let join = |user: &str, conn: u64, channel_id: i64| Op::VoiceJoin {
        user: user.to_string(),
        conn,
        server: "rchat".to_string(),
        channel_id,
        cap: 2,
    };
    for (user, conn) in [("a", 1), ("b", 2)] {
        let applied = replica.apply(1, join(user, conn, 5), T0);
        assert!(matches!(applied.outcome, Outcome::Ends(_)));
    }
    replica.apply(1, join("c", 3, 6), T0);
    let refused = replica.apply(1, join("c", 3, 5), T0);
    assert!(matches!(refused.outcome, Outcome::Full) && refused.events.is_empty());
    assert!(matches!(
        replica.apply(1, join("a", 9, 5), T0).outcome,
        Outcome::Ends(_)
    ));
    assert_eq!(replica.rooms[&6].users, vec![("c".to_string(), 3)]);
    assert_eq!(replica.rooms[&5].users.len(), 2);
}

#[test]
fn signals_for_a_left_room_are_dropped() {
    let mut replica = Replica::default();
    let join = |user: &str, conn: u64, channel_id: i64| Op::VoiceJoin {
        user: user.to_string(),
        conn,
        server: "rchat".to_string(),
        channel_id,
        cap: 0,
    };
    let signal = |channel_id: i64| Op::Broadcast {
        event: WsEvent::RtcSignal {
            to: "b".to_string(),
            from: "a".to_string(),
            channel_id: Some(channel_id),
            dm_id: None,
            payload: serde_json::json!({ "candidate": {} }),
        },
    };
    let relayed = |applied: &Applied| {
        applied
            .events
            .iter()
            .filter(|ev| matches!(ev, WsEvent::RtcSignal { .. }))
            .count()
    };
    replica.apply(1, join("a", 1, 5), T0);
    replica.apply(1, join("b", 2, 5), T0);
    assert_eq!(relayed(&replica.apply(1, signal(5), T0)), 1);
    replica.apply(1, join("b", 2, 6), T0);
    assert_eq!(relayed(&replica.apply(1, signal(5), T0)), 0);
    assert_eq!(relayed(&replica.apply(1, signal(6), T0)), 0);
    replica.apply(1, join("a", 1, 6), T0);
    assert_eq!(relayed(&replica.apply(1, signal(6), T0)), 1);
    replica.apply(
        1,
        Op::VoiceLeave {
            user: "b".to_string(),
        },
        T0,
    );
    assert_eq!(relayed(&replica.apply(1, signal(6), T0)), 0);
}

#[test]
fn rejoin_from_another_connection_restates_the_room() {
    let mut replica = Replica::default();
    let join = |conn: u64| Op::VoiceJoin {
        user: "a".to_string(),
        conn,
        server: "rchat".to_string(),
        channel_id: 5,
        cap: 0,
    };
    replica.apply(1, join(1), T0);
    let moved = replica.apply(1, join(9), T0);
    assert_eq!(voice_of(&moved.events), vec![(5, vec!["a".to_string()])]);
    assert_eq!(replica.rooms[&5].users, vec![("a".to_string(), 9)]);
    assert!(replica.apply(1, join(9), T0).events.is_empty());
}

#[test]
fn dm_call_signals_relay_only_while_the_call_is_active() {
    let mut replica = Replica::default();
    let s = |v: &str| v.to_string();
    let relay = |replica: &mut Replica| {
        let op = Op::Broadcast {
            event: signal("bob", "alice", None, Some(9)),
        };
        signals_of(&replica.apply(1, op, T0).events).len()
    };
    let start = Op::CallStart {
        user: s("alice"),
        conn: 1,
        dm_id: 9,
        dm_users: dm_users(),
        kind: CallKind::Rtc,
        video: false,
        log_id: 70,
        call_id: String::new(),
        peer_id: None,
        relays: Vec::new(),
    };
    assert!(matches!(
        replica.apply(1, start, T0).outcome,
        Outcome::Started(Ok(()))
    ));
    assert_eq!(relay(&mut replica), 0);
    let accept = Op::CallAccept {
        user: s("bob"),
        conn: 2,
        dm_id: 9,
        peer_id: None,
        relays: Vec::new(),
    };
    assert!(matches!(
        replica.apply(2, accept, T0).outcome,
        Outcome::Accepted(Ok(_))
    ));
    assert_eq!(relay(&mut replica), 1);
    let wrong_call = Op::Broadcast {
        event: signal("bob", "alice", None, Some(10)),
    };
    assert!(signals_of(&replica.apply(1, wrong_call, T0).events).is_empty());
    let end = Op::CallEnd {
        user: s("alice"),
        dm_id: 9,
    };
    replica.apply(1, end, T0);
    assert_eq!(relay(&mut replica), 0);
}

#[test]
fn purge_event_removes_members_in_one_op() {
    let mut replica = Replica::default();
    let s = |v: &str| v.to_string();
    for (i, user) in ["bob", "carol", "dave"].iter().enumerate() {
        let conn = (1 << 32) | i as u64;
        replica.apply(
            1,
            Op::Viewing {
                user: s(user),
                conn,
                old: None,
                new: Some(s("club")),
            },
            T0,
        );
        replica.apply(
            1,
            Op::VoiceJoin {
                user: s(user),
                conn,
                server: s("club"),
                channel_id: 3,
                cap: 0,
            },
            T0,
        );
    }
    let applied = replica.apply(
        1,
        Op::Broadcast {
            event: WsEvent::MembersPurged {
                server: s("club"),
                usernames: vec![s("bob"), s("carol")],
            },
        },
        T0 + 1,
    );
    assert_eq!(
        presence_of(&applied.events),
        vec![(s("club"), s("bob"), false), (s("club"), s("carol"), false)]
    );
    assert_eq!(
        voice_of(&applied.events).last(),
        Some(&(3, vec![s("dave")]))
    );
    assert_eq!(
        replica.index.presence["club"].iter().collect::<Vec<_>>(),
        ["dave"]
    );
}
