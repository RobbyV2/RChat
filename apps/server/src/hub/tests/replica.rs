use super::*;
use crate::hub::replica::{
    Index, STAFF_MUTE_MS, VOICE_BLOCKS_MAX, VOICE_BLOCKS_PER_SERVER, VOICE_MUTES_MAX,
    VOICE_MUTES_PER_SERVER,
};
use crate::ws::SeatAudio;

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
                addr: None,
                muted: false,
                deafened: false,
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
                addr: None,
                muted: false,
                deafened: false,
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
        addr: None,
        muted: false,
        deafened: false,
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
            addr: None,
            muted: true,
            deafened: false,
        },
        Op::VoiceJoin {
            user: s("erin"),
            conn: (3 << 32) | 1,
            server: s("two"),
            channel_id: 11,
            cap: 0,
            addr: None,
            muted: false,
            deafened: false,
        },
        Op::VoiceAudio {
            user: s("erin"),
            conn: (3 << 32) | 1,
            muted: true,
            deafened: true,
        },
        guest_join(
            "@guest:0000000000000001",
            (3 << 32) | 6,
            "two",
            11,
            "10.0.0.9",
        ),
        hush("@guest:0000000000000001", "two", true),
        guest_join(
            "@guest:0000000000000002",
            (3 << 32) | 7,
            "one",
            12,
            "10.0.0.8",
        ),
        hush_from("@guest:0000000000000002", "one", "10.0.0.8"),
        kick_from("@guest:0000000000000003", "two", "10.0.0.7"),
        kick("@guest:0000000000000002", "one", STAFF, BLOCK_MS),
        hush("@guest:0000000000000001", "two", false),
        hush("@guest:0000000000000001", "two", true),
        Op::Broadcast {
            event: WsEvent::ServerRenamed {
                old_name: s("two"),
                server: crate::api::ServerSummaryLite {
                    seal: Default::default(),
                    name: s("deux"),
                    display_name: s("deux"),
                    creator: None,
                    has_password: false,
                    banner_color: None,
                    name_color: None,
                    public_read: None,
                    guest_voice: false,
                    guest_chat: false,
                    members_visible: true,
                    hide_members: false,
                    join_mode: Default::default(),
                    listed: true,
                    profiles_mode: Default::default(),
                    description: None,
                    icon_kind: Default::default(),
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
            addr: None,
            muted: false,
            deafened: false,
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
            reason: None,
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
    assert_eq!(replica.voice_mutes.len(), 1);
    replica.apply(1, Op::Heartbeat, t + STAFF_MUTE_MS + 60_000);
    assert_eq!(replica.index, reindexed(&replica));
    assert!(replica.voice_mutes.is_empty() && replica.voice_blocks.is_empty());
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
        addr: None,
        muted: false,
        deafened: false,
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
        addr: None,
        muted: false,
        deafened: false,
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
        addr: None,
        muted: false,
        deafened: false,
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
                addr: None,
                muted: false,
                deafened: false,
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

fn guest_join(user: &str, conn: u64, server: &str, channel_id: i64, addr: &str) -> Op {
    Op::VoiceJoin {
        user: user.to_string(),
        conn,
        server: server.to_string(),
        channel_id,
        cap: 0,
        addr: Some(addr.to_string()),
        muted: false,
        deafened: false,
    }
}

fn account_join(user: &str, conn: u64, server: &str, channel_id: i64) -> Op {
    Op::VoiceJoin {
        user: user.to_string(),
        conn,
        server: server.to_string(),
        channel_id,
        cap: 0,
        addr: None,
        muted: false,
        deafened: false,
    }
}

const STAFF: &str = "Removed from voice by staff";
const BLOCK_MS: i64 = 600_000;

fn kick(user: &str, server: &str, reason: &str, block_ms: i64) -> Op {
    Op::VoiceKick {
        user: user.to_string(),
        server: server.to_string(),
        reason: reason.to_string(),
        block_ms,
        addr: None,
    }
}

fn hush(user: &str, server: &str, muted: bool) -> Op {
    Op::VoiceHush {
        user: user.to_string(),
        server: server.to_string(),
        muted,
        addr: None,
    }
}

fn blocked_for(applied: &Applied) -> Option<i64> {
    match applied.outcome {
        Outcome::Blocked(left) => Some(left),
        _ => None,
    }
}

fn joined(applied: &Applied) -> bool {
    matches!(applied.outcome, Outcome::Ends(_))
}

fn hushed_of(evs: &[WsEvent]) -> Vec<(i64, String, bool, bool)> {
    evs.iter()
        .filter_map(|ev| match ev {
            WsEvent::VoiceMuted {
                server: _,
                channel_id,
                username,
                muted,
                staff,
            } => Some((*channel_id, username.clone(), *muted, *staff)),
            _ => None,
        })
        .collect()
}

fn ended_of(evs: &[WsEvent]) -> Vec<(i64, String, String)> {
    evs.iter()
        .filter_map(|ev| match ev {
            WsEvent::VoiceEnded {
                server: None,
                channel_id: Some(cid),
                dm_id: None,
                dm_users: Some(users),
                reason,
            } => Some((*cid, users.join(","), reason.clone())),
            _ => None,
        })
        .collect()
}

fn round_trip(replica: &Replica) -> Replica {
    let json = serde_json::to_string(replica).unwrap();
    let reloaded: Replica = serde_json::from_str(&json).unwrap();
    assert_eq!(serde_json::to_string(&reloaded).unwrap(), json);
    reloaded
}

#[test]
fn a_kicked_guest_stays_out_of_that_servers_voice_for_the_block() {
    let s = |v: &str| v.to_string();
    let a = "@guest:00000000000000aa";
    let b = "@guest:00000000000000bb";
    let mut replica = Replica::default();
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    replica.apply(1, account_join("alice", 2, "club", 5), T0);
    let applied = replica.apply(1, kick(a, "club", STAFF, BLOCK_MS), T0 + 1_000);
    assert_eq!(voice_of(&applied.events), vec![(5, vec![s("alice")])]);
    assert_eq!(ended_of(&applied.events), vec![(5, s(a), s(STAFF))]);

    let again = replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0 + 61_000);
    assert_eq!(blocked_for(&again), Some(540_000), "the same connection");
    assert!(again.events.is_empty());
    let other_room = replica.apply(1, guest_join(a, 1, "club", 6, "10.0.0.1"), T0 + 61_000);
    assert_eq!(
        blocked_for(&other_room),
        Some(540_000),
        "every channel of it"
    );
    let reload = replica.apply(1, guest_join(b, 3, "club", 5, "10.0.0.1"), T0 + 61_000);
    assert_eq!(
        blocked_for(&reload),
        Some(540_000),
        "a new connection from the same address"
    );
    assert!(replica.rooms[&5].users.iter().all(|(u, _)| u == "alice"));
    let elsewhere = replica.apply(1, guest_join(a, 1, "other", 7, "10.0.0.1"), T0 + 61_000);
    assert!(joined(&elsewhere), "another server is not blocked");
    let other_addr = replica.apply(1, guest_join(b, 3, "club", 5, "10.0.0.2"), T0 + 61_000);
    assert!(joined(&other_addr), "another address");

    let late = replica.apply(1, guest_join(a, 1, "club", 6, "10.0.0.1"), T0 + 600_999);
    assert_eq!(
        blocked_for(&late),
        Some(1),
        "the block lasts its whole window"
    );
    let after = replica.apply(1, guest_join(a, 1, "club", 6, "10.0.0.1"), T0 + 601_000);
    assert!(joined(&after), "the block ends by itself");
    assert!(replica.voice_blocks.is_empty(), "ended blocks are dropped");
    round_trip(&replica);
}

#[test]
fn a_kick_without_a_block_only_takes_the_guest_out() {
    let s = |v: &str| v.to_string();
    let a = "@guest:00000000000000aa";
    let b = "@guest:00000000000000bb";
    let mut replica = Replica::default();
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    replica.apply(1, guest_join(b, 2, "club", 5, "10.0.0.1"), T0);
    let reason = "Guests can't use voice in this server";
    let applied = replica.apply(1, kick(a, "club", reason, 0), T0);
    assert_eq!(ended_of(&applied.events), vec![(5, s(a), s(reason))]);
    assert_eq!(
        voice_of(&applied.events),
        vec![(5, vec![s(b)])],
        "a guest from the same address stays"
    );
    assert!(replica.voice_blocks.is_empty());
    assert_eq!(replica.voice_addrs.keys().collect::<Vec<_>>(), vec![b]);
    let back = replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0 + 1);
    assert!(joined(&back));
}

#[test]
fn a_disconnect_takes_out_every_guest_from_that_address() {
    let s = |v: &str| v.to_string();
    let (a, b, c, d) = (
        "@guest:00000000000000aa",
        "@guest:00000000000000bb",
        "@guest:00000000000000cc",
        "@guest:00000000000000dd",
    );
    let mut replica = Replica::default();
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    replica.apply(1, guest_join(b, 2, "club", 6, "10.0.0.1"), T0);
    replica.apply(1, guest_join(c, 3, "other", 7, "10.0.0.1"), T0);
    replica.apply(1, guest_join(d, 4, "club", 5, "10.0.0.2"), T0);
    replica.apply(1, account_join("alice", 5, "club", 5), T0);
    replica.apply(1, account_join("10.0.0.1", 6, "club", 6), T0);
    let applied = replica.apply(1, kick(a, "club", STAFF, BLOCK_MS), T0 + 1);
    assert_eq!(
        voice_of(&applied.events),
        vec![(5, vec![s(d), s("alice")]), (6, vec![s("10.0.0.1")])],
        "one state per room"
    );
    assert_eq!(
        ended_of(&applied.events),
        vec![(5, s(a), s(STAFF)), (6, s(b), s(STAFF))],
        "each guest taken out is told"
    );
    assert_eq!(
        replica.room_in(c, "other"),
        Some(7),
        "another server's voice"
    );
    for (name, addr) in [(b, "10.0.0.9"), (b, "10.0.0.1"), (a, "10.0.0.9")] {
        let back = replica.apply(1, guest_join(name, 9, "club", 5, addr), T0 + 2);
        assert_eq!(blocked_for(&back), Some(599_999), "{name} from {addr}");
    }
    let fresh = replica.apply(
        1,
        guest_join("@guest:00000000000000ee", 9, "club", 5, "10.0.0.1"),
        T0 + 2,
    );
    assert_eq!(blocked_for(&fresh), Some(599_999), "the address");
    assert!(joined(&replica.apply(
        1,
        account_join("10.0.0.1", 6, "club", 5),
        T0 + 2
    )));
}

#[test]
fn a_disconnect_racing_the_guests_reload_covers_its_address() {
    let s = |v: &str| v.to_string();
    let (a, b, c) = (
        "@guest:00000000000000aa",
        "@guest:00000000000000bb",
        "@guest:00000000000000cc",
    );
    let at_check = |replica: &Replica| replica.voice_addrs.get(a).cloned();
    let closed = |replica: &mut Replica| {
        replica.apply(
            1,
            Op::DropConn {
                user: s(a),
                conn: 1,
            },
            T0 + 1,
        )
    };
    let staff_kick = |addr: Option<String>| Op::VoiceKick {
        user: s(a),
        server: s("club"),
        reason: s(STAFF),
        block_ms: BLOCK_MS,
        addr,
    };

    let mut replica = Replica::default();
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    let addr = at_check(&replica);
    closed(&mut replica);
    assert!(replica.voice_addrs.is_empty());
    replica.apply(1, staff_kick(addr), T0 + 2);
    let reload = replica.apply(1, guest_join(c, 3, "club", 5, "10.0.0.1"), T0 + 3);
    assert_eq!(
        blocked_for(&reload),
        Some(599_999),
        "the address read at the check is blocked"
    );

    let mut replica = Replica::default();
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    let addr = at_check(&replica);
    closed(&mut replica);
    assert!(joined(&replica.apply(
        1,
        guest_join(b, 2, "club", 5, "10.0.0.1"),
        T0 + 1
    )));
    let applied = replica.apply(1, staff_kick(addr), T0 + 2);
    assert_eq!(
        ended_of(&applied.events),
        vec![(5, s(b), s(STAFF))],
        "the reloaded tab that came back first goes too"
    );
    assert!(replica.rooms.is_empty());
    for name in [b, c] {
        let back = replica.apply(1, guest_join(name, 3, "club", 5, "10.0.0.1"), T0 + 3);
        assert_eq!(blocked_for(&back), Some(599_999), "{name}");
    }
}

#[test]
fn a_staff_mute_holds_for_the_guest_and_its_address_in_that_server() {
    let s = |v: &str| v.to_string();
    let (a, b, c, d, e) = (
        "@guest:00000000000000aa",
        "@guest:00000000000000bb",
        "@guest:00000000000000cc",
        "@guest:00000000000000dd",
        "@guest:00000000000000ee",
    );
    let mut replica = Replica::default();
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    replica.apply(1, guest_join(b, 2, "club", 6, "10.0.0.1"), T0);
    replica.apply(1, guest_join(c, 3, "club", 5, "10.0.0.2"), T0);
    replica.apply(1, guest_join(d, 4, "other", 7, "10.0.0.1"), T0);
    replica.apply(1, account_join("10.0.0.1", 5, "club", 5), T0);
    let muted = replica.apply(1, hush(a, "club", true), T0);
    assert_eq!(
        hushed_of(&muted.events),
        vec![(5, s(a), true, true), (6, s(b), true, true)],
        "the guest and every guest from its address in that server"
    );
    assert!(
        replica
            .apply(1, hush(a, "club", true), T0)
            .events
            .is_empty(),
        "muting twice says nothing"
    );
    assert!(
        replica
            .apply(1, hush(b, "club", true), T0)
            .events
            .is_empty(),
        "nor does muting a guest the mute covers"
    );
    for (name, server) in [(c, "club"), ("10.0.0.1", "club"), (d, "other")] {
        assert!(!replica.hushed(name, server), "{name} in {server}");
    }

    let moved = replica.apply(1, guest_join(a, 1, "club", 6, "10.0.0.1"), T0 + 1);
    assert_eq!(
        hushed_of(&moved.events),
        vec![(6, s(a), true, true)],
        "a move inside the server keeps the mute"
    );
    let held = [s("club")];
    let listed = vec![(6, s(b), true, true), (6, s(a), true, true)];
    assert_eq!(
        hushed_of(&replica.voice_snapshot_for(held.iter(), None)),
        listed,
        "a new listener learns it"
    );
    assert_eq!(
        hushed_of(&round_trip(&replica).voice_snapshot_for(held.iter(), None)),
        listed
    );

    replica.apply(1, Op::VoiceLeave { user: s(a) }, T0 + 2);
    let rejoin = replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0 + 3);
    assert_eq!(
        hushed_of(&rejoin.events),
        vec![(5, s(a), true, true)],
        "a leave and a rejoin keep it"
    );
    replica.apply(
        1,
        Op::DropConn {
            user: s(a),
            conn: 1,
        },
        T0 + 4,
    );
    let reload = replica.apply(1, guest_join(e, 8, "club", 5, "10.0.0.1"), T0 + 5);
    assert_eq!(
        hushed_of(&reload.events),
        vec![(5, s(e), true, true)],
        "a reload from that address keeps it"
    );
    replica.apply(
        1,
        kick(b, "club", "Guests can't use voice in this server", 0),
        T0 + 6,
    );
    let back = replica.apply(1, guest_join(b, 2, "club", 6, "10.0.0.1"), T0 + 7);
    assert_eq!(hushed_of(&back.events), vec![(6, s(b), true, true)]);
    let away = replica.apply(1, guest_join(e, 8, "other", 7, "10.0.0.1"), T0 + 8);
    assert!(hushed_of(&away.events).is_empty(), "another server");
    replica.apply(1, guest_join(e, 8, "club", 5, "10.0.0.1"), T0 + 9);

    let unmuted = replica.apply(1, hush(e, "club", false), T0 + 10);
    assert_eq!(
        hushed_of(&unmuted.events),
        vec![(5, s(e), false, true), (6, s(b), false, true)],
        "unmuting any guest it covers ends it for all of them"
    );
    assert!(replica.voice_mutes.is_empty());
    assert!(
        replica
            .apply(1, hush(e, "club", false), T0 + 10)
            .events
            .is_empty()
    );
    let rejoin = replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0 + 11);
    assert!(hushed_of(&rejoin.events).is_empty());
}

#[test]
fn a_staff_mute_ends_after_a_day_and_forgets_the_address() {
    let s = |v: &str| v.to_string();
    let a = "@guest:00000000000000aa";
    let b = "@guest:00000000000000bb";
    let day = 24 * 60 * 60 * 1000;
    let mut replica = Replica::default();
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    replica.apply(1, hush(a, "club", true), T0);
    let before = replica.apply(1, Op::Heartbeat, T0 + day - 1);
    assert!(before.events.is_empty());
    assert!(replica.hushed(a, "club"));
    let ended = replica.apply(1, Op::Heartbeat, T0 + day);
    assert_eq!(
        hushed_of(&ended.events),
        vec![(5, s(a), false, true)],
        "listeners hear it again"
    );
    assert!(replica.voice_mutes.is_empty() && !replica.hushed(a, "club"));
    let reload = replica.apply(1, guest_join(b, 2, "club", 5, "10.0.0.1"), T0 + day + 1);
    assert!(hushed_of(&reload.events).is_empty());

    replica.apply(1, hush(b, "club", true), T0 + day + 2);
    replica.apply(1, kick(b, "club", STAFF, BLOCK_MS), T0 + day + 3);
    replica.apply(1, Op::VoiceLeave { user: s(a) }, T0 + day + 4);
    assert!(
        serde_json::to_string(&replica)
            .unwrap()
            .contains("10.0.0.1")
    );
    replica.apply(1, Op::Heartbeat, T0 + 2 * day + 2);
    assert!(
        !serde_json::to_string(&replica)
            .unwrap()
            .contains("10.0.0.1"),
        "no address is kept once the block and the mute ended"
    );
}

#[test]
fn an_address_block_never_keeps_an_account_out() {
    let s = |v: &str| v.to_string();
    let a = "@guest:00000000000000aa";
    let mut replica = Replica::default();
    for (guest, addr) in [(a, "10.0.0.1"), ("@guest:00000000000000bb", "2001:db8::")] {
        replica.apply(1, guest_join(guest, 1, "club", 5, addr), T0);
        replica.apply(1, kick(guest, "club", STAFF, BLOCK_MS), T0);
        let account = replica.apply(1, account_join(addr, 2, "club", 5), T0 + 1);
        assert!(joined(&account), "an account named {addr} joins");
        let reload = guest_join("@guest:00000000000000cc", 3, "club", 5, addr);
        assert_eq!(
            blocked_for(&replica.apply(1, reload, T0 + 1)),
            Some(599_999),
            "a guest from {addr} is still out"
        );
        replica.apply(1, Op::VoiceLeave { user: s(addr) }, T0 + 1);
    }
    let named = replica.apply(1, guest_join(a, 4, "club", 5, "10.9.9.9"), T0 + 1);
    assert_eq!(
        blocked_for(&named),
        Some(599_999),
        "the guest's name is out from any address"
    );
    let addr_named = replica.apply(
        1,
        guest_join("@guest:00000000000000dd", 5, "club", 5, a),
        T0 + 1,
    );
    assert!(joined(&addr_named), "a name block is not an address block");
}

fn renamed(old_name: &str, name: &str) -> Op {
    let s = |v: &str| v.to_string();
    Op::Broadcast {
        event: WsEvent::ServerRenamed {
            old_name: s(old_name),
            server: crate::api::ServerSummaryLite {
                seal: Default::default(),
                name: s(name),
                display_name: s(name),
                creator: None,
                has_password: false,
                banner_color: None,
                name_color: None,
                public_read: None,
                guest_voice: false,
                guest_chat: false,
                members_visible: true,
                hide_members: false,
                join_mode: Default::default(),
                listed: true,
                profiles_mode: Default::default(),
                description: None,
                icon_kind: Default::default(),
            },
        },
    }
}

#[test]
fn a_rename_keeps_staff_mutes_and_blocks() {
    let s = |v: &str| v.to_string();
    let a = "@guest:00000000000000aa";
    let b = "@guest:00000000000000bb";
    let mut replica = Replica::default();
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    replica.apply(1, guest_join(b, 2, "club", 5, "10.0.0.2"), T0);
    replica.apply(1, hush(a, "club", true), T0);
    replica.apply(1, kick(b, "club", STAFF, BLOCK_MS), T0);
    replica.apply(1, renamed("club", "club2"), T0 + 1);
    let held = [s("club2")];
    assert_eq!(
        hushed_of(&replica.voice_snapshot_for(held.iter(), None)),
        vec![(5, s(a), true, true)],
        "a new listener still learns the mute"
    );
    let moved = replica.apply(1, guest_join(a, 1, "club2", 6, "10.0.0.1"), T0 + 2);
    assert_eq!(hushed_of(&moved.events), vec![(6, s(a), true, true)]);
    let back = replica.apply(1, guest_join(b, 2, "club2", 5, "10.0.0.2"), T0 + 2);
    assert_eq!(blocked_for(&back), Some(599_998), "the same connection");
    let reload = replica.apply(1, guest_join(b, 3, "club2", 5, "10.0.0.2"), T0 + 2);
    assert!(blocked_for(&reload).is_some(), "the same address");
    let unmuted = replica.apply(1, hush(a, "club2", false), T0 + 3);
    assert_eq!(hushed_of(&unmuted.events), vec![(6, s(a), false, true)]);
    assert!(replica.voice_mutes.is_empty());
}

#[test]
fn every_way_out_of_voice_forgets_the_address_and_keeps_the_mute() {
    let s = |v: &str| v.to_string();
    let a = "@guest:00000000000000aa";
    let b = "@guest:00000000000000bb";
    let ways = [
        Op::EvictVoice {
            user: s(a),
            channel_id: 5,
            reason: None,
        },
        Op::Broadcast {
            event: WsEvent::ChannelDeleted {
                server: s("club"),
                channel_id: 5,
                rules: None,
            },
        },
        Op::SweepVoice { idle: 1 },
        kick(a, "club", "Guests can't use voice in this server", 0),
        Op::VoiceLeave { user: s(a) },
        Op::DropConn {
            user: s(a),
            conn: 1,
        },
    ];
    for (n, way) in ways.into_iter().enumerate() {
        let mut replica = Replica::default();
        replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
        replica.apply(1, hush(a, "club", true), T0);
        replica.apply(1, way, T0 + 5_000);
        assert!(replica.rooms.is_empty(), "{n}");
        assert!(replica.voice_addrs.is_empty(), "{n}");
        let reload = replica.apply(1, guest_join(b, 2, "club", 5, "10.0.0.1"), T0 + 5_001);
        assert_eq!(
            hushed_of(&reload.events),
            vec![(5, s(b), true, true)],
            "{n}"
        );
    }
    let mut replica = Replica::default();
    replica.apply(2, guest_join(a, 2 << 32, "club", 5, "10.0.0.1"), T0);
    replica.apply(2, hush(a, "club", true), T0);
    replica.apply(2, Op::Depart, T0 + 1);
    assert!(replica.rooms.is_empty());
    assert!(replica.voice_addrs.is_empty(), "a departing copy's guests");
    assert_eq!(replica.voice_mutes.len(), 1);

    replica.apply(1, guest_join(b, 2, "club", 5, "10.0.0.2"), T0 + 2);
    replica.apply(1, kick(b, "club", STAFF, BLOCK_MS), T0 + 2);
    assert!(!replica.voice_blocks.is_empty());
    let deleted = Op::Broadcast {
        event: WsEvent::ServerDeleted { name: s("club") },
    };
    replica.apply(1, deleted, T0 + 3);
    assert!(
        replica.voice_mutes.is_empty() && replica.voice_blocks.is_empty(),
        "a deleted server's mutes and blocks go with it"
    );
}

#[test]
fn ops_cost_nothing_per_guest_in_voice() {
    let mut replica = Replica::default();
    for n in 0..2_000u64 {
        let user = format!("@guest:{n:016x}");
        let addr = format!("10.0.{}.{}", n / 256, n % 256);
        replica.apply(1, guest_join(&user, n + 1, "club", 5, &addr), T0);
        if n % 20 == 0 {
            replica.apply(1, hush(&user, "club", true), T0);
        }
    }
    assert_eq!(replica.voice_addrs.len(), 2_000);
    assert_eq!(replica.voice_mutes.len(), 100);
    let started = std::time::Instant::now();
    for n in 0..10_000 {
        replica.apply(1, Op::Heartbeat, T0 + n);
    }
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(replica.voice_addrs.len(), 2_000);
}

fn hush_from(user: &str, server: &str, addr: &str) -> Op {
    Op::VoiceHush {
        user: user.to_string(),
        server: server.to_string(),
        muted: true,
        addr: Some(addr.to_string()),
    }
}

fn kick_from(user: &str, server: &str, addr: &str) -> Op {
    Op::VoiceKick {
        user: user.to_string(),
        server: server.to_string(),
        reason: STAFF.to_string(),
        block_ms: BLOCK_MS,
        addr: Some(addr.to_string()),
    }
}

#[test]
fn one_servers_mutes_and_blocks_never_end_anothers() {
    let s = |v: &str| v.to_string();
    let (a, b, first) = (
        "@guest:00000000000000aa",
        "@guest:00000000000000bb",
        "@guest:00000000000000ff",
    );
    let mut replica = Replica::default();
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    replica.apply(1, hush(a, "club", true), T0);
    replica.apply(1, guest_join(b, 2, "club", 5, "10.0.0.2"), T0);
    replica.apply(1, kick(b, "club", STAFF, BLOCK_MS), T0);
    replica.apply(1, guest_join(first, 3, "evil", 1, "2001:db8:ffff::"), T0);
    replica.apply(1, hush(first, "evil", true), T0);
    let mut evs = Vec::new();
    for n in 0..12_000i64 {
        let user = format!("@guest:{:016x}", 0x1000 + n);
        let addr = format!("2001:db8:{n:x}::");
        let at = T0 + 1 + n / 100;
        evs.extend(replica.apply(1, hush_from(&user, "evil", &addr), at).events);
        replica.apply(1, kick_from(&user, "evil", &addr), at);
    }
    let at = T0 + 1 + 12_000 / 100;
    assert!(
        replica.hushed(a, "club"),
        "12,000 mutes in another server never end club's"
    );
    let back = replica.apply(1, guest_join(b, 2, "club", 5, "10.0.0.2"), at);
    assert!(blocked_for(&back).is_some(), "nor its blocks");
    let reload = replica.apply(
        1,
        guest_join("@guest:00000000000000cc", 4, "club", 5, "10.0.0.2"),
        at,
    );
    assert!(blocked_for(&reload).is_some());
    assert_eq!(
        replica.voice_mutes.len(),
        VOICE_MUTES_PER_SERVER + 1,
        "each server holds at most its own cap"
    );
    assert_eq!(replica.voice_blocks.len(), VOICE_BLOCKS_PER_SERVER + 2);
    assert!(!replica.hushed(first, "evil"));
    assert!(
        hushed_of(&evs).contains(&(1, s(first), false, true)),
        "the mute that ends first in that server ends early, and listeners hear it again"
    );
}

#[test]
fn snapshots_walk_only_the_mutes_of_their_servers() {
    let s = |v: &str| v.to_string();
    let mut replica = Replica::default();
    let others = (VOICE_MUTES_MAX - VOICE_MUTES_PER_SERVER) as i64;
    for n in 0..others {
        let user = format!("@guest:{:016x}", 0x10_000 + n);
        let addr = format!("2001:db8:{n:x}::");
        let server = format!("evil{}", n % 10);
        replica.apply(1, hush_from(&user, &server, &addr), T0);
    }
    for n in 0..VOICE_MUTES_PER_SERVER as i64 {
        let user = format!("@guest:{:016x}", 0x20_000 + n);
        let addr = format!("10.1.{}.{}", n / 256, n % 256);
        replica.apply(1, hush_from(&user, "club", &addr), T0);
    }
    for n in 0..2_000u64 {
        let user = format!("member{n}");
        let channel_id = 10 + (n as i64 % 40);
        replica.apply(1, account_join(&user, 100_000 + n, "club", channel_id), T0);
    }
    let muted = "@guest:00000000000000aa";
    let other = "@guest:00000000000000bb";
    replica.apply(1, guest_join(muted, 1, "club", 10, "10.1.0.7"), T0);
    replica.apply(1, guest_join(other, 2, "club", 10, "2001:db8:7::"), T0);
    let held = [s("club")];
    let started = std::time::Instant::now();
    for _ in 0..10 {
        replica.voice_snapshot_for(held.iter(), None);
    }
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(replica.voice_mutes.len(), VOICE_MUTES_MAX);
    assert_eq!(
        hushed_of(&replica.voice_snapshot_for(held.iter(), None)),
        vec![(10, s(muted), true, true)],
        "the guest from a muted address of club, not the one from another server's"
    );
}

#[test]
fn at_the_instance_cap_the_fullest_server_gives_way() {
    let mut replica = Replica::default();
    let (a, b) = ("@guest:00000000000000aa", "@guest:00000000000000bb");
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    replica.apply(1, hush(a, "club", true), T0);
    replica.apply(1, guest_join(b, 2, "club", 5, "10.0.0.2"), T0);
    replica.apply(1, kick(b, "club", STAFF, BLOCK_MS), T0);
    let servers = VOICE_MUTES_MAX / VOICE_MUTES_PER_SERVER + 2;
    for s in 0..servers {
        for n in 0..VOICE_MUTES_PER_SERVER as i64 {
            let user = format!("@guest:{:08x}{:08x}", s, n);
            let addr = format!("2001:db8:{s:x}:{n:x}::");
            let server = format!("evil{s}");
            replica.apply(1, hush_from(&user, &server, &addr), T0 + 1);
            replica.apply(1, kick_from(&user, &server, &addr), T0 + 1);
        }
    }
    assert!(replica.voice_mutes.len() <= VOICE_MUTES_MAX);
    assert!(replica.voice_blocks.len() <= VOICE_BLOCKS_MAX);
    assert!(replica.hushed(a, "club"), "a small server's mute stays");
    let back = replica.apply(1, guest_join(b, 2, "club", 5, "10.0.0.2"), T0 + 2);
    assert!(blocked_for(&back).is_some(), "and its blocks");
    assert_eq!(replica.index, reindexed(&replica));
}

#[test]
fn renames_keep_the_lookup() {
    let mut replica = Replica::default();
    let a = "@guest:00000000000000aa";
    replica.apply(1, guest_join(a, 1, "club", 5, "10.0.0.1"), T0);
    replica.apply(1, hush(a, "club", true), T0);
    replica.apply(1, renamed("club", "hall"), T0);
    assert!(replica.hushed(a, "hall") && !replica.hushed(a, "club"));
    assert_eq!(replica.index, reindexed(&replica));
}

fn audio_join(user: &str, conn: u64, channel_id: i64, muted: bool, deafened: bool) -> Op {
    Op::VoiceJoin {
        user: user.to_string(),
        conn,
        server: "club".to_string(),
        channel_id,
        cap: 0,
        addr: None,
        muted,
        deafened,
    }
}

fn audio_op(user: &str, conn: u64, muted: bool, deafened: bool) -> Op {
    Op::VoiceAudio {
        user: user.to_string(),
        conn,
        muted,
        deafened,
    }
}

fn audio_of(evs: &[WsEvent]) -> Vec<(i64, String, bool, bool)> {
    evs.iter()
        .filter_map(|ev| match ev {
            WsEvent::VoiceAudio {
                server: _,
                channel_id,
                username,
                muted,
                deafened,
            } => Some((*channel_id, username.clone(), *muted, *deafened)),
            _ => None,
        })
        .collect()
}

// What snapshot room states say about each user's own audio, by room.
fn seats_of(evs: &[WsEvent]) -> Vec<(i64, String, bool, bool)> {
    evs.iter()
        .filter_map(|ev| match ev {
            WsEvent::VoiceState {
                server: _,
                channel_id,
                users: _,
                audio: Some(audio),
            } => Some((*channel_id, audio)),
            _ => None,
        })
        .flat_map(|(cid, audio)| {
            audio.iter().map(move |a| {
                let SeatAudio {
                    username,
                    muted,
                    deafened,
                } = a;
                (cid, username.clone(), *muted, *deafened)
            })
        })
        .collect()
}

fn audio_in(replica: &Replica, channel_id: i64) -> Vec<(String, bool, bool)> {
    replica
        .rooms
        .get(&channel_id)
        .map(|room| {
            room.audio
                .iter()
                .map(|(user, a)| (user.clone(), a.muted, a.deafened))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn voice_audio_changes_only_the_senders_seat() {
    let s = |v: &str| v.to_string();
    let mut replica = Replica::default();
    replica.apply(1, audio_join("amy", 1, 5, false, false), T0);
    replica.apply(1, audio_join("ben", 2, 5, false, false), T0);
    let muted = replica.apply(1, audio_op("amy", 1, true, false), T0);
    assert_eq!(audio_of(&muted.events), vec![(5, s("amy"), true, false)]);
    assert_eq!(audio_in(&replica, 5), vec![(s("amy"), true, false)]);
    for (user, conn) in [("amy", 9), ("cat", 3), ("ben", 1)] {
        let other = replica.apply(1, audio_op(user, conn, true, true), T0);
        assert!(
            other.events.is_empty(),
            "{user} on {conn} holds no seat there"
        );
    }
    assert!(
        replica
            .apply(1, audio_op("amy", 1, true, false), T0)
            .events
            .is_empty(),
        "an unchanged state says nothing"
    );
    let deaf = replica.apply(1, audio_op("ben", 2, true, true), T0);
    assert_eq!(audio_of(&deaf.events), vec![(5, s("ben"), true, true)]);
    let open = replica.apply(1, audio_op("amy", 1, false, false), T0);
    assert_eq!(audio_of(&open.events), vec![(5, s("amy"), false, false)]);
    assert_eq!(
        audio_in(&replica, 5),
        vec![(s("ben"), true, true)],
        "only states off the default are kept"
    );
    assert_eq!(replica.index, reindexed(&replica));
}

#[test]
fn voice_audio_goes_with_the_seat() {
    let s = |v: &str| v.to_string();
    let mut replica = Replica::default();
    replica.apply(1, audio_join("ben", 2, 5, false, false), T0);
    let joined = replica.apply(1, audio_join("amy", 1, 5, true, false), T0);
    assert_eq!(
        voice_of(&joined.events),
        vec![(5, vec![s("ben"), s("amy")])]
    );
    assert_eq!(audio_of(&joined.events), vec![(5, s("amy"), true, false)]);
    let moved = replica.apply(1, audio_join("amy", 1, 6, false, true), T0);
    assert_eq!(audio_of(&moved.events), vec![(6, s("amy"), false, true)]);
    assert!(
        audio_in(&replica, 5).is_empty(),
        "a move drops the old seat's state"
    );
    replica.apply(1, audio_join("amy", 1, 5, true, false), T0);
    let tab = replica.apply(1, audio_join("amy", 7, 5, false, false), T0);
    assert_eq!(audio_of(&tab.events), vec![(5, s("amy"), false, false)]);
    assert!(
        replica
            .apply(1, audio_op("amy", 1, true, false), T0)
            .events
            .is_empty(),
        "the tab the seat moved from says nothing"
    );
    let ways_out = [
        Op::VoiceLeave { user: s("amy") },
        Op::DropConn {
            user: s("amy"),
            conn: 7,
        },
        Op::EvictVoice {
            user: s("amy"),
            channel_id: 5,
            reason: None,
        },
        kick("amy", "club", STAFF, 0),
        Op::Broadcast {
            event: WsEvent::MemberLeft {
                server: s("club"),
                username: s("amy"),
            },
        },
    ];
    for out in ways_out {
        replica.apply(1, audio_join("amy", 7, 5, true, true), T0);
        assert_eq!(audio_in(&replica, 5), vec![(s("amy"), true, true)]);
        replica.apply(1, out, T0);
        assert_eq!(replica.rooms[&5].users, vec![(s("ben"), 2)]);
        assert!(audio_in(&replica, 5).is_empty());
    }
    replica.apply(1, audio_op("ben", 2, true, false), T0);
    replica.apply(1, Op::VoiceLeave { user: s("ben") }, T0);
    assert!(
        !replica.rooms.contains_key(&5),
        "the room ends with its state"
    );
    assert_eq!(replica.index, reindexed(&replica));
}

#[test]
fn snapshots_carry_voice_audio() {
    let s = |v: &str| v.to_string();
    let mut replica = Replica::default();
    replica.apply(1, audio_join("amy", 1, 5, true, false), T0);
    replica.apply(1, audio_join("ben", 2, 5, true, true), T0);
    replica.apply(1, audio_join("cat", 3, 5, false, false), T0);
    replica.apply(
        1,
        Op::VoiceJoin {
            user: s("dan"),
            conn: 4,
            server: s("other"),
            channel_id: 8,
            cap: 0,
            addr: None,
            muted: true,
            deafened: false,
        },
        T0,
    );
    let held = [s("club")];
    let evs = replica.voice_snapshot_for(held.iter(), None);
    assert_eq!(evs.len(), 1, "one event for the room");
    assert_eq!(
        voice_of(&evs),
        vec![(5, vec![s("amy"), s("ben"), s("cat")])]
    );
    assert_eq!(
        seats_of(&evs),
        vec![(5, s("amy"), true, false), (5, s("ben"), true, true)]
    );
    assert!(audio_of(&evs).is_empty());
    assert_eq!(seats_of(&replica.voice_snapshot()).len(), 3);
    let reloaded = round_trip(&replica);
    assert_eq!(
        seats_of(&reloaded.voice_snapshot_for(held.iter(), None)),
        seats_of(&evs)
    );
    let quiet = replica.apply(1, audio_op("amy", 1, false, false), T0);
    assert!(
        matches!(
            quiet.events.as_slice(),
            [WsEvent::VoiceAudio {
                server: _,
                channel_id: 5,
                username: _,
                muted: false,
                deafened: false,
            }]
        ),
        "live changes come one by one"
    );
    let live = replica.apply(1, audio_join("eve", 5, 5, true, false), T0);
    assert!(
        live.events.iter().all(|ev| !matches!(
            ev,
            WsEvent::VoiceState {
                server: _,
                channel_id: _,
                users: _,
                audio: Some(_),
            }
        )),
        "a live room state carries no audio"
    );
}

#[test]
fn rooms_without_audio_load() {
    let s = |v: &str| v.to_string();
    let old = r#"{"rooms":{"5":{"server":"club","users":[["amy",1],["ben",2]],"lone_since":0}},"seen":{}}"#;
    let mut replica: Replica = serde_json::from_str(old).expect("old snapshot");
    assert!(audio_in(&replica, 5).is_empty());
    assert!(seats_of(&replica.voice_snapshot()).is_empty());
    let json = serde_json::to_string(&replica).unwrap();
    assert!(!json.contains("audio"), "{json}");
    let join: Op = serde_json::from_str(
        r#"{"op":"voice_join","user":"cat","conn":3,"server":"club","channel_id":5}"#,
    )
    .expect("a join of an older version");
    assert!(matches!(
        join,
        Op::VoiceJoin {
            user: _,
            conn: 3,
            server: _,
            channel_id: 5,
            cap: 0,
            addr: None,
            muted: false,
            deafened: false,
        }
    ));
    replica.apply(1, join, T0);
    replica.apply(1, audio_op("amy", 1, true, false), T0);
    assert_eq!(
        audio_in(&round_trip(&replica), 5),
        vec![(s("amy"), true, false)]
    );
    let quiet = serde_json::to_string(&audio_join("cat", 3, 5, false, false)).unwrap();
    assert!(
        !quiet.contains("muted") && !quiet.contains("deafened"),
        "{quiet}"
    );
}
