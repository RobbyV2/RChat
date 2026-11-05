use std::sync::atomic::AtomicI64;

use super::*;
use crate::ws::{CallPhase, to_bus_json};

mod limits;
mod link;
mod replica;

const T0: i64 = 1_700_000_000_000;

#[derive(Clone)]
pub(crate) struct MemBus {
    hubs: Arc<Mutex<Vec<Hub>>>,
    log: Arc<Mutex<Vec<(String, String)>>>,
    clock: Arc<AtomicI64>,
}

impl MemBus {
    pub(crate) fn new() -> MemBus {
        MemBus {
            hubs: Arc::new(Mutex::new(Vec::new())),
            log: Arc::new(Mutex::new(Vec::new())),
            clock: Arc::new(AtomicI64::new(T0)),
        }
    }

    pub(crate) fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub(crate) fn join(&self) -> Hub {
        let (hub, out) = Hub::replicated();
        self.attach(hub.clone(), out, None);
        hub
    }

    fn attach(&self, hub: Hub, mut out: mpsc::Receiver<Envelope>, after: Option<&str>) {
        {
            let log = self.log.lock().unwrap();
            for (id, json) in log.iter() {
                if after.is_none_or(|a| stream_pos(id) > stream_pos(a)) {
                    hub.ingest(id, serde_json::from_str(json).unwrap(), false);
                }
            }
            hub.set_publishing(true);
            hub.set_following(true);
            hub.set_caught_up(true);
            self.hubs.lock().unwrap().push(hub);
        }
        let bus = self.clone();
        tokio::spawn(async move {
            while let Some(env) = out.recv().await {
                bus.append(to_bus_json(&env).unwrap());
            }
        });
    }

    fn append(&self, json: String) {
        let mut log = self.log.lock().unwrap();
        let id = format!("{}-{}", self.clock.load(Ordering::SeqCst), log.len());
        for hub in self.hubs.lock().unwrap().iter() {
            hub.ingest(&id, serde_json::from_str(&json).unwrap(), true);
        }
        log.push((id, json));
    }
}

fn drain(rx: &mut broadcast::Receiver<WsEvent>) -> Vec<WsEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
}

fn presence_of(evs: &[WsEvent]) -> Vec<(String, String, bool)> {
    evs.iter()
        .filter_map(|ev| match ev {
            WsEvent::PresenceChanged {
                server,
                username,
                online,
                online_count: _,
            } => Some((server.clone(), username.clone(), *online)),
            _ => None,
        })
        .collect()
}

fn voice_of(evs: &[WsEvent]) -> Vec<(i64, Vec<String>)> {
    evs.iter()
        .filter_map(|ev| match ev {
            WsEvent::VoiceState {
                server: _,
                channel_id,
                users,
            } => Some((*channel_id, users.clone())),
            _ => None,
        })
        .collect()
}

fn calls_of(evs: &[WsEvent]) -> Vec<(i64, CallPhase)> {
    evs.iter()
        .filter_map(|ev| match ev {
            WsEvent::CallState {
                dm_id,
                dm_users: _,
                state,
                from: _,
                kind: _,
                video: _,
                call_id: _,
                answered_at: _,
                peers: _,
                relays: _,
            } => Some((*dm_id, *state)),
            _ => None,
        })
        .collect()
}

async fn outlive(bus: &MemBus, alive: &Hub) {
    for _ in 0..3 {
        bus.advance(DEAD_AFTER_MS / 3);
        alive.flush().await;
    }
    bus.advance(1_000);
    alive.flush().await;
}

fn dm_users() -> Vec<String> {
    vec!["alice".to_string(), "bob".to_string()]
}

#[tokio::test]
async fn local_hub_applies_inline() {
    let hub = Hub::new();
    let mut rx = hub.subscribe();
    let a = hub.next_conn();
    let b = hub.next_conn();
    hub.set_online("alice", a, &["rchat"]);
    hub.set_online("alice", b, &["rchat"]);
    assert!(hub.is_online("rchat", "alice"));
    assert_eq!(hub.online_count("rchat"), 1);
    hub.announce("alice", a, false, None);
    assert!(hub.is_online("rchat", "alice"));
    hub.announce("alice", b, false, None);
    assert!(hub.is_online("rchat", "alice"));
    hub.expire_presence();
    assert!(!hub.is_online("rchat", "alice"));
    assert_eq!(
        presence_of(&drain(&mut rx)),
        vec![
            ("rchat".to_string(), "alice".to_string(), true),
            ("rchat".to_string(), "alice".to_string(), false)
        ]
    );
    assert!(hub.voice_join("alice", a, "rchat", 5).await.is_empty());
    assert_eq!(
        hub.rooms_in("rchat", None),
        vec![(5, vec!["alice".to_string()])]
    );
    hub.broadcast(WsEvent::ChannelDeleted {
        server: "rchat".to_string(),
        channel_id: 5,
        rules: None,
    });
    assert!(hub.rooms_in("rchat", None).is_empty());
    assert!(hub.ready());
}

fn online_op(user: &str, conn: u64, cap: usize, servers: Option<&[&str]>) -> Op {
    Op::Online {
        user: user.to_string(),
        conn,
        lit: true,
        cap,
        scope: servers.map(|servers| Scope {
            servers: servers.iter().map(|v| v.to_string()).collect(),
            hidden: false,
            seq: 0,
        }),
        every: 0,
    }
}

fn drop_op(user: &str, conn: u64) -> Op {
    Op::DropConn {
        user: user.to_string(),
        conn,
    }
}

#[tokio::test]
async fn broadcast_reaches_each_connection_once() {
    let bus = MemBus::new();
    let hubs = [bus.join(), bus.join(), bus.join()];
    let mut receivers: Vec<_> = hubs
        .iter()
        .flat_map(|h| [h.subscribe(), h.subscribe()])
        .collect();
    hubs[1].broadcast(WsEvent::RolesChanged {
        server: "rchat".to_string(),
    });
    for hub in &hubs {
        hub.flush().await;
    }
    for rx in receivers.iter_mut() {
        let evs = drain(rx);
        assert_eq!(evs.len(), 1);
        assert!(matches!(&evs[0], WsEvent::RolesChanged { server } if server == "rchat"));
    }
}

#[tokio::test]
async fn p2p_calls_bind_their_id_and_the_peer_ids_of_both_tabs() {
    let s = |v: &str| v.to_string();
    let hub = Hub::new();
    let mut rx = hub.subscribe();
    type Bound = (CallPhase, Option<String>, Vec<(String, String)>);
    let bound = |evs: Vec<WsEvent>| -> Vec<Bound> {
        evs.into_iter()
            .filter_map(|ev| match ev {
                WsEvent::CallState {
                    dm_id: _,
                    dm_users: _,
                    state,
                    from: _,
                    kind: _,
                    video: _,
                    call_id,
                    answered_at: _,
                    peers,
                    relays: _,
                } => Some((
                    state,
                    call_id,
                    peers.into_iter().map(|p| (p.user, p.peer_id)).collect(),
                )),
                _ => None,
            })
            .collect()
    };
    let pair = |a: &str, b: &str| vec![(s("alice"), s(a)), (s("bob"), s(b))];
    let (alice, bob, bob2) = (hub.next_conn(), hub.next_conn(), hub.next_conn());
    hub.set_p2p("alice", alice, s("hosted-a"), Vec::new());
    hub.set_p2p("bob", bob, s("hosted-b"), Vec::new());
    hub.call_start(
        "alice",
        alice,
        9,
        dm_users(),
        CallKind::P2p,
        false,
        70,
        Some(s("pa")),
    )
    .await
    .unwrap();
    hub.call_accept("bob", bob2, 9, Some(s("pb2")))
        .await
        .unwrap();
    hub.call_end("alice", 9).await.unwrap();
    let first = bound(drain(&mut rx));
    assert_eq!(first.len(), 3);
    assert_eq!(first[0], (CallPhase::Ringing, None, Vec::new()));
    let id = first[1].1.clone().expect("an active P2P call has an id");
    assert_eq!(id.len(), 32);
    assert_eq!(
        first[1],
        (CallPhase::Active, Some(id.clone()), pair("pa", "pb2")),
        "the tab that accepted, not bob's other tab"
    );
    assert_eq!(first[2], (CallPhase::Ended, None, Vec::new()));

    hub.call_start(
        "alice",
        alice,
        9,
        dm_users(),
        CallKind::P2p,
        false,
        71,
        None,
    )
    .await
    .unwrap();
    hub.call_accept("bob", bob, 9, None).await.unwrap();
    let old = bound(drain(&mut rx));
    assert_eq!(
        old[1].2,
        pair("hosted-a", "hosted-b"),
        "older apps name no peer id, so the hosting one stands in"
    );
    assert!(old[1].1.as_ref().is_some_and(|other| *other != id));
    hub.call_end("bob", 9).await.unwrap();

    hub.call_start(
        "alice",
        alice,
        9,
        dm_users(),
        CallKind::Rtc,
        false,
        72,
        Some(s("pa")),
    )
    .await
    .unwrap();
    hub.call_accept("bob", bob, 9, Some(s("pb"))).await.unwrap();
    assert_eq!(
        bound(drain(&mut rx)).last(),
        Some(&(CallPhase::Active, None, Vec::new())),
        "instance calls carry no peer ids"
    );
}

#[tokio::test]
async fn p2p_calls_carry_the_relays_each_side_declared() {
    let s = |v: &str| v.to_string();
    let hub = Hub::new();
    let mut rx = hub.subscribe();
    type Declared = Vec<(String, Vec<String>)>;
    let relays_of = |evs: Vec<WsEvent>| -> Vec<(CallPhase, Declared)> {
        evs.into_iter()
            .filter_map(|ev| match ev {
                WsEvent::CallState {
                    dm_id: _,
                    dm_users: _,
                    state,
                    from: _,
                    kind: _,
                    video: _,
                    call_id: _,
                    answered_at: _,
                    peers: _,
                    relays,
                } => Some((
                    state,
                    relays.into_iter().map(|r| (r.user, r.hosts)).collect(),
                )),
                _ => None,
            })
            .collect()
    };
    let (alice, bob) = (hub.next_conn(), hub.next_conn());
    let p2p = (CallKind::P2p, false);
    hub.call_start_from(
        "alice",
        alice,
        9,
        dm_users(),
        p2p,
        70,
        (Some(s("pa")), vec![s("turn.a.example")]),
    )
    .await
    .unwrap();
    hub.call_accept_from("bob", bob, 9, (Some(s("pb")), vec![s("turn.b.example")]))
        .await
        .unwrap();
    let evs = relays_of(drain(&mut rx));
    assert_eq!(
        evs[0],
        (
            CallPhase::Ringing,
            vec![(s("alice"), vec![s("turn.a.example")])]
        ),
        "the callee sees the caller's relay before it accepts"
    );
    assert_eq!(
        evs[1],
        (
            CallPhase::Active,
            vec![
                (s("alice"), vec![s("turn.a.example")]),
                (s("bob"), vec![s("turn.b.example")])
            ]
        )
    );
    hub.call_end("alice", 9).await.unwrap();
    drain(&mut rx);

    hub.call_start_from(
        "alice",
        alice,
        9,
        dm_users(),
        p2p,
        71,
        (Some(s("pa")), Vec::new()),
    )
    .await
    .unwrap();
    hub.call_accept("bob", bob, 9, Some(s("pb"))).await.unwrap();
    assert!(
        relays_of(drain(&mut rx)).iter().all(|(_, r)| r.is_empty()),
        "no relays declared, none sent"
    );
    hub.call_end("alice", 9).await.unwrap();

    hub.call_start_from(
        "alice",
        alice,
        9,
        dm_users(),
        (CallKind::Rtc, false),
        72,
        (None, vec![s("turn.a.example")]),
    )
    .await
    .unwrap();
    assert!(
        relays_of(drain(&mut rx)).iter().all(|(_, r)| r.is_empty()),
        "instance calls carry no relays"
    );
}

#[tokio::test]
async fn p2p_hosts_keep_relays_per_file() {
    let s = |v: &str| v.to_string();
    let hub = Hub::new();
    let conn = hub.next_conn();
    hub.set_p2p_relayed(
        "alice",
        conn,
        s("peer-a"),
        vec![s("f1"), s("f2")],
        BTreeMap::from([(s("f1"), vec![s("turn.a.example")])]),
    );
    hub.flush().await;
    assert_eq!(
        hub.p2p_host_of("alice", "f1"),
        Some((s("peer-a"), vec![s("turn.a.example")]))
    );
    assert_eq!(
        hub.p2p_host_of("alice", "f2"),
        Some((s("peer-a"), Vec::new()))
    );
    assert_eq!(hub.p2p_host_of("alice", "f3"), None);
}

fn signal(from: &str, to: &str, channel_id: Option<i64>, dm_id: Option<i64>) -> WsEvent {
    WsEvent::RtcSignal {
        to: to.to_string(),
        from: from.to_string(),
        channel_id,
        dm_id,
        payload: serde_json::json!({ "candidate": {}, "sid": "s1" }),
    }
}

fn signals_of(evs: &[WsEvent]) -> Vec<(String, String)> {
    evs.iter()
        .filter_map(|ev| match ev {
            WsEvent::RtcSignal {
                to,
                from,
                channel_id: _,
                dm_id: _,
                payload: _,
            } => Some((from.clone(), to.clone())),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn voice_snapshot_covers_only_held_servers() {
    let hub = Hub::new();
    let s = |v: &str| v.to_string();
    hub.voice_join("alice", 1, "one", 5).await;
    hub.voice_join("bob", 2, "two", 6).await;
    hub.call_start(
        "carol",
        3,
        9,
        vec![s("carol"), s("dave")],
        CallKind::Rtc,
        false,
        1,
        None,
    )
    .await
    .unwrap();
    let held = [s("one")];
    assert_eq!(
        voice_of(&hub.voice_snapshot_for(held.iter(), Some("dave"))),
        vec![(5, vec![s("alice")])]
    );
    assert_eq!(
        calls_of(&hub.voice_snapshot_for(held.iter(), Some("dave"))),
        vec![(9, CallPhase::Ringing)]
    );
    assert!(calls_of(&hub.voice_snapshot_for(held.iter(), Some("erin"))).is_empty());
    assert_eq!(hub.voice_snapshot().len(), 3);
}
