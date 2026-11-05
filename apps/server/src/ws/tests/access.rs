use std::collections::HashMap;

use tokio::time::Instant;

use super::*;
use crate::api::Message;
use crate::api::access::servers_with_expired_passwords;
use crate::db::now;
use crate::fanout::Topic;
use crate::hub::Epoch;
use crate::ws::access::{
    Access, Pace, SUB_FRAME_COST, SubPace, channel_gate, reauthorize, token_live,
};
use crate::ws::filter::{on_event, wants};

#[tokio::test]
async fn reauthorize_drops_revoked_access() {
    let (state, path) = crate::api::test_util::temp_state("ws_reauthorize").await;
    exec(&state.db, "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, is_site_admin, created_at) VALUES('alice', 'alice', '', 'text', 'identicon', 0, 1)").await;
    exec(&state.db, "INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('vault', 'vault', 'hash', 1)").await;
    exec(
        &state.db,
        "INSERT INTO servers(name, display_name, created_at) VALUES('open', 'open', 1)",
    )
    .await;
    exec(
        &state.db,
        "INSERT INTO members(server, username, joined_at) VALUES('vault', 'alice', 1)",
    )
    .await;
    let mut alice = Access::new(Some("alice".to_string()), false, HashSet::new());
    alice.subs = set(&["vault", "open", "gone"]);
    alice.viewing = Some("vault".to_string());
    alice.viewable = HashMap::from([(1, ("vault".to_string(), true))]);
    assert!(reauthorize(&state, &mut alice).await.unwrap());
    assert_eq!(alice.member_servers, set(&["vault"]));
    assert_eq!(alice.subs, set(&["vault", "open"]));
    assert_eq!(alice.viewing.as_deref(), Some("vault"));
    assert!(alice.viewable.is_empty());

    exec(&state.db, "DELETE FROM members WHERE server = 'vault'").await;
    assert!(reauthorize(&state, &mut alice).await.unwrap());
    assert!(alice.member_servers.is_empty());
    assert_eq!(alice.subs, set(&["open"]));
    assert_eq!(alice.viewing, None);

    exec(&state.db, "DELETE FROM users WHERE username = 'alice'").await;
    assert!(!reauthorize(&state, &mut alice).await.unwrap());

    let mut guest = Access::new(None, false, HashSet::new());
    guest.subs = set(&["vault", "open"]);
    guest.grants = HashMap::from([("vault".to_string(), "forged".to_string())]);
    assert!(reauthorize(&state, &mut guest).await.unwrap());
    assert_eq!(guest.subs, set(&["open"]));
    assert!(guest.grants.is_empty());
    exec(&state.db, "INSERT INTO settings(key, value) VALUES('guests_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value").await;
    assert!(!reauthorize(&state, &mut guest).await.unwrap());
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn failed_reauthorization_holds_back_scoped_events() {
    let (state, path) = crate::api::test_util::temp_state("ws_reauth_fail").await;
    add_user(&state.db, "alice").await;
    let mut alice = Access::new(Some(s("alice")), true, set(&["vault"]));
    alice.subs = set(&["vault", "open"]);
    alice.grants = HashMap::from([(s("open"), s("g"))]);
    alice.viewing = Some(s("vault"));
    alice.viewable = HashMap::from([(1, (s("vault"), true))]);
    let presence = WsEvent::PresenceChanged {
        server: s("vault"),
        username: s("bob"),
        online: true,
        online_count: 1,
    };
    let created = WsEvent::ServerCreated {
        server: lite("elsewhere"),
    };
    let dm = WsEvent::Message {
        server: None,
        channel_id: None,
        dm_id: Some(2),
        dm_users: Some(vec![s("alice"), s("bob")]),
        message: Box::new(message()),
    };
    let kicked = WsEvent::MemberKicked {
        server: s("vault"),
        username: s("alice"),
        banned: true,
    };
    assert!(alice.wants(&presence) && alice.wants(&created));
    crate::db::close(&state.db).await;
    let started = Instant::now();
    let res = reauthorize(&state, &mut alice).await;
    assert!(res.is_err());
    assert!(alice.settle(res, started));
    assert!(alice.retry.pending());
    assert_eq!(alice.member_servers, set(&["vault"]));
    assert_eq!(alice.subs, set(&["vault", "open"]));
    assert_eq!(alice.grants.len(), 1);
    assert_eq!(alice.viewing.as_deref(), Some("vault"));
    assert!(alice.viewable.is_empty());
    assert!(!alice.wants(&presence) && !alice.wants(&created));
    assert!(!alice.wants(&dm) && !alice.wants(&kicked));
    let conn = state.hub.next_conn();
    assert_eq!(
        on_event(&state, conn, &mut alice, &presence).await,
        Some(false)
    );
    assert_eq!(on_event(&state, conn, &mut alice, &dm).await, Some(false));
    assert_eq!(alice.retry.since, Some(started));
    let first = alice.retry.at.unwrap();
    assert!(first >= started + REAUTH_RETRY && first <= Instant::now() + REAUTH_RETRY * 3 / 2);
    let failed = || Err(sqlx::Error::PoolClosed);
    assert!(alice.settle(failed(), Instant::now()));
    assert_eq!(alice.retry.at, Some(first));
    assert_eq!(alice.retry.wait, REAUTH_RETRY * 2);
    for _ in 0..6 {
        alice.retry.at = None;
        assert!(alice.settle(failed(), Instant::now()));
        assert!(alice.retry.at.unwrap() <= started + REAUTH_GIVE_UP);
    }
    assert_eq!(alice.retry.since, Some(started));
    assert_eq!(alice.retry.at, Some(started + REAUTH_GIVE_UP));
    alice.retry.since = Instant::now().checked_sub(REAUTH_GIVE_UP);
    assert!(!alice.settle(failed(), Instant::now()));
    assert!(alice.settle(Ok(true), Instant::now()));
    assert!(!alice.retry.pending() && alice.retry.since.is_none());
    assert_eq!(alice.retry.wait, REAUTH_RETRY);
    assert!(alice.wants(&presence));
    let slow = Instant::now().checked_sub(REAUTH_GIVE_UP).unwrap();
    assert!(!alice.settle(failed(), slow));
    assert!(!Access::new(None, false, HashSet::new()).settle(Ok(false), Instant::now()));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn reused_name_is_rechecked() {
    let (state, path) = crate::api::test_util::temp_state("ws_reuse").await;
    let db = &state.db;
    for name in ["alice", "frank", "gina"] {
        add_user(db, name).await;
    }
    exec(
        db,
        "INSERT INTO servers(name, display_name, created_at) VALUES('b', 'b', 1)",
    )
    .await;
    exec(
        db,
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('a', 'a', 'frank', 2)",
    )
    .await;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('b', 'alice', 1)",
    )
    .await;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('a', 'frank', 2)",
    )
    .await;
    let fresh = insert_id(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('a', 'general', 2) RETURNING id",
    )
    .await;
    let conn = state.hub.next_conn();
    state.hub.set_online("alice", conn, &["a"]);
    let mut alice = Access::new(Some(s("alice")), false, set(&["a"]));
    alice.viewing = Some(s("a"));
    let created = WsEvent::ServerCreated {
        server: ServerSummaryLite {
            creator: Some(s("frank")),
            ..lite("a")
        },
    };
    assert_eq!(
        on_event(&state, conn, &mut alice, &created).await,
        Some(false)
    );
    assert_eq!(alice.member_servers, set(&["b"]));
    assert_eq!(alice.viewing, None);
    assert!(!alice.retry.pending());
    assert!(!state.hub.is_online("a", "alice"));
    assert_eq!(
        on_event(&state, conn, &mut alice, &joined("a", "gina")).await,
        Some(false)
    );
    assert_eq!(
        on_event(&state, conn, &mut alice, &joined("b", "gina")).await,
        Some(true)
    );
    let secret = WsEvent::Message {
        server: Some(s("a")),
        channel_id: Some(fresh),
        dm_id: None,
        dm_users: None,
        message: Box::new(message()),
    };
    assert_eq!(
        on_event(&state, conn, &mut alice, &secret).await,
        Some(false)
    );

    exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'vault', 'frank', 'hash', 3)").await;
    let mut guest = Access::new(None, false, HashSet::new());
    guest.subs = set(&["vault", "b"]);
    guest.grants = HashMap::from([(s("vault"), s("for-the-old-vault"))]);
    let made = WsEvent::ServerCreated {
        server: ServerSummaryLite {
            creator: Some(s("frank")),
            has_password: true,
            banner_color: None,
            name_color: None,
            ..lite("vault")
        },
    };
    assert_eq!(
        on_event(&state, state.hub.next_conn(), &mut guest, &made).await,
        Some(false)
    );
    assert_eq!(guest.subs, set(&["b"]));
    assert!(guest.grants.is_empty());
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn rename_recheck_survives_races_and_errors() {
    let (state, path) = crate::api::test_util::temp_state("ws_rename").await;
    let db = &state.db;
    add_user(db, "alice").await;
    add_user(db, "bob").await;
    exec(db, "INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('c', 'c', 'hash', 1)").await;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('c', 'alice', 1)",
    )
    .await;
    let conn = state.hub.next_conn();
    let mut alice = Access::new(Some(s("alice")), false, set(&["a", "rchat"]));
    alice.viewing = Some(s("a"));
    assert_eq!(
        on_event(&state, conn, &mut alice, &renamed("a", "b")).await,
        Some(true)
    );
    assert_eq!(alice.member_servers, set(&["b", "rchat"]));
    assert_eq!(
        on_event(&state, conn, &mut alice, &renamed("b", "c")).await,
        Some(true)
    );
    assert_eq!(alice.member_servers, set(&["c", "rchat"]));
    assert_eq!(alice.viewing.as_deref(), Some("c"));
    assert!(!alice.retry.pending());

    let mut bob = Access::new(Some(s("bob")), false, set(&["x"]));
    bob.viewing = Some(s("x"));
    assert_eq!(
        on_event(&state, conn, &mut bob, &renamed("x", "c")).await,
        Some(false)
    );
    assert!(bob.member_servers.is_empty());
    assert_eq!(bob.viewing, None);

    let mut carol = Access::new(Some(s("carol")), false, set(&["d", "rchat"]));
    carol.viewable = HashMap::from([(1, (s("rchat"), true))]);
    assert_eq!(
        on_event(&state, conn, &mut carol, &renamed("x", "y")).await,
        Some(false)
    );
    assert_eq!(carol.viewable.len(), 1);
    crate::db::close(&state.db).await;
    assert_eq!(
        on_event(&state, conn, &mut carol, &renamed("d", "e")).await,
        Some(false)
    );
    assert_eq!(carol.member_servers, set(&["e", "rchat"]));
    assert!(carol.retry.pending());
    crate::api::test_util::done(state, path).await;
}

#[test]
fn database_failures_are_logged_in_summary() {
    static SUMMED: AtomicU64 = AtomicU64::new(0);
    static GATE: LogGate = LogGate::new(LOG_EVERY, |n| {
        SUMMED.fetch_add(n, Ordering::SeqCst);
    });
    let secs = Duration::from_secs;
    let t0 = Instant::now();
    assert!(GATE.admit(t0));
    for i in 1..=4 {
        assert!(!GATE.admit(t0 + secs(i)));
    }
    GATE.flush(t0 + LOG_EVERY);
    assert_eq!(SUMMED.load(Ordering::SeqCst), 4);
    assert!(!GATE.admit(t0 + LOG_EVERY + secs(1)));
    GATE.flush(t0 + LOG_EVERY * 2);
    assert_eq!(SUMMED.load(Ordering::SeqCst), 5);
    GATE.flush(t0 + LOG_EVERY * 3);
    assert_eq!(SUMMED.load(Ordering::SeqCst), 5);
    assert!(GATE.admit(t0 + LOG_EVERY * 5));
}

#[tokio::test(start_paused = true)]
async fn hidden_failures_are_summarized_later() {
    const EVERY: Duration = Duration::from_millis(200);
    static SUMMED: AtomicU64 = AtomicU64::new(0);
    static GATE: LogGate = LogGate::new(EVERY, |n| {
        SUMMED.fetch_add(n, Ordering::SeqCst);
    });
    assert!(GATE.admit(Instant::now()));
    assert!(!GATE.admit(Instant::now()) && !GATE.admit(Instant::now()));
    tokio::time::sleep(EVERY / 4).await;
    assert_eq!(SUMMED.load(Ordering::SeqCst), 0);
    tokio::time::sleep(EVERY * 2).await;
    assert_eq!(SUMMED.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn lagged_guest_recheck_drops_revoked_subs() {
    let (state, path) = crate::api::test_util::temp_state("guest_recheck").await;
    let db = &state.db;
    for (name, hash) in [("open", None), ("locked", Some("h")), ("kept", Some("h"))] {
        sqlx::query("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES($1, $1, $2, 0)")
            .bind(name)
            .bind(hash)
            .execute(db)
            .await
            .unwrap();
    }
    exec(
        db,
        "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('h:4d2f4b668cfc48e6059d36e91326bf87de39ba819f35450477bc1ce614a63bbd', 'kept', 0, 4000000000)",
    )
    .await;
    let mut guest = Access::new(None, false, HashSet::new());
    guest.subs = set(&["open", "locked", "kept", "gone"]);
    guest.grants = HashMap::from([(s("locked"), s("g1")), (s("kept"), s("g2"))]);
    assert!(guest.refresh(&state, 1).await);
    assert_eq!(guest.subs, set(&["kept", "open"]));
    assert_eq!(guest.grants.keys().collect::<Vec<_>>(), ["kept"]);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn guests_of_an_expiring_password_are_cut_at_its_expiry() {
    let (state, path) = crate::api::test_util::temp_state("guest_deadline").await;
    let db = &state.db;
    for name in ["tmp", "kept"] {
        sqlx::query("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES($1, $1, 'h', 0)")
            .bind(name)
            .execute(db)
            .await
            .unwrap();
    }
    let at = now() + 3600;
    let id: i64 = sqlx::query("INSERT INTO server_passwords(server, hash, lookup, created_by, created_at, expires_at) VALUES('tmp', 'h', 'l', 'alice', 0, $1) RETURNING id")
        .bind(at)
        .fetch_one(db)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id) VALUES('h:711430f6164e93803d93428bc1fab80f41e213bb197689307de8606d437c3038', 'tmp', 0, 4000000000, $1)")
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    exec(
        db,
        "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('h:4d2f4b668cfc48e6059d36e91326bf87de39ba819f35450477bc1ce614a63bbd', 'kept', 0, 4000000000)",
    )
    .await;
    let mut guest = Access::new(None, false, HashSet::new());
    guest.subs = set(&["tmp", "kept"]);
    guest.grants = HashMap::from([(s("tmp"), s("g1")), (s("kept"), s("g2"))]);
    assert!(guest.refresh(&state, 1).await);
    assert_eq!(guest.subs, set(&["tmp", "kept"]));
    assert_eq!(guest.deadlines, HashMap::from([(s("tmp"), at)]));
    assert_eq!(
        servers_with_expired_passwords(db, at - 10, at - 1)
            .await
            .unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(
        servers_with_expired_passwords(db, at - 1, at)
            .await
            .unwrap(),
        vec![s("tmp")]
    );
    // The clock reaches the expiry: move the expiry (and the deadline read from it) to
    // the past instead of waiting for the wall clock.
    let at = now() - 1;
    sqlx::query("UPDATE server_passwords SET expires_at = $1 WHERE id = $2")
        .bind(at)
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    guest.deadlines.insert(s("tmp"), at);
    let ev = WsEvent::PresenceChanged {
        server: s("tmp"),
        username: s("bob"),
        online: true,
        online_count: 1,
    };
    let conn = state.hub.next_conn();
    assert_eq!(on_event(&state, conn, &mut guest, &ev).await, Some(false));
    assert_eq!(guest.subs, set(&["kept"]));
    assert!(guest.deadlines.is_empty());
    assert_eq!(guest.grants.keys().collect::<Vec<_>>(), ["kept"]);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn a_ban_drops_live_subscriptions() {
    let (state, path) = crate::api::test_util::temp_state("ws_ban_drops_subs").await;
    let conn = state.hub.next_conn();
    let post = |server: &str| WsEvent::Message {
        server: Some(s(server)),
        channel_id: Some(7),
        dm_id: None,
        dm_users: None,
        message: Box::new(Message {
            created_at: now(),
            ..message()
        }),
    };
    let presence = WsEvent::PresenceChanged {
        server: s("open"),
        username: s("bob"),
        online: true,
        online_count: 1,
    };
    let mut carol = Access::new(Some(s("carol")), false, set(&["rchat"]));
    carol.subs = set(&["open", "other"]);
    carol.viewing = Some(s("open"));
    carol.viewable = HashMap::from([(7, (s("open"), true))]);
    assert_eq!(
        on_event(&state, conn, &mut carol, &post("open")).await,
        Some(true)
    );
    let banned = WsEvent::ServerBanned {
        server: s("open"),
        username: s("carol"),
    };
    let elsewhere = WsEvent::ServerBanned {
        server: s("open"),
        username: s("dave"),
    };
    assert_eq!(
        on_event(&state, conn, &mut carol, &elsewhere).await,
        Some(false)
    );
    assert_eq!(carol.subs, set(&["open", "other"]));
    assert_eq!(
        on_event(&state, conn, &mut carol, &banned).await,
        Some(true)
    );
    assert_eq!(carol.subs, set(&["other"]));
    assert_eq!(carol.viewing, None);
    assert!(carol.topics_dirty);
    let topics = carol.topics();
    assert!(!topics.contains(&Topic::Server(s("open"))));
    assert!(!topics.contains(&Topic::View(s("open"))));
    assert_eq!(
        on_event(&state, conn, &mut carol, &post("open")).await,
        Some(false)
    );
    assert_eq!(
        on_event(&state, conn, &mut carol, &presence).await,
        Some(false)
    );
    let mut bert = Access::new(Some(s("bert")), false, set(&["open"]));
    bert.subs = set(&["open"]);
    bert.viewable = HashMap::from([(7, (s("open"), true))]);
    let kicked = WsEvent::MemberKicked {
        server: s("open"),
        username: s("bert"),
        banned: true,
    };
    assert_eq!(on_event(&state, conn, &mut bert, &kicked).await, Some(true));
    assert!(bert.subs.is_empty() && bert.member_servers.is_empty());
    assert_eq!(
        on_event(&state, conn, &mut bert, &post("open")).await,
        Some(false)
    );
    let mut gail = Access::new(Some(s("gail")), false, set(&["open"]));
    gail.subs = set(&["open"]);
    let left = WsEvent::MemberKicked {
        server: s("open"),
        username: s("gail"),
        banned: false,
    };
    on_event(&state, conn, &mut gail, &left).await;
    assert_eq!(gail.subs, set(&["open"]));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn channel_gate_holds_on_database_errors() {
    let (state, path) = crate::api::test_util::temp_state("ws_gate_error").await;
    let mut bob = Access::new(Some(s("bob")), false, set(&["rchat"]));
    crate::db::close(&state.db).await;
    assert_eq!(
        channel_gate(&state, &mut bob, "rchat", 1).await,
        Some(false)
    );
    assert!(bob.retry.pending() && bob.missed);
    assert!(bob.viewable.is_empty());
    bob.retry.since = Instant::now().checked_sub(REAUTH_GIVE_UP);
    assert_eq!(channel_gate(&state, &mut bob, "rchat", 1).await, None);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn token_live_follows_the_tokens_table() {
    let (state, path) = crate::api::test_util::temp_state("token_live").await;
    let db = &state.db;
    add_user(db, "tia").await;
    exec(
        db,
        "INSERT INTO tokens(token, username, created_at) VALUES('h:628b49d96dcde97a430dd4f597705899e09a968f793491e4b704cae33a40dc02', 'tia', 0)",
    )
    .await;
    assert!(token_live(db, Some("t1")).await.unwrap());
    assert!(!token_live(db, Some("t2")).await.unwrap());
    assert!(!token_live(db, None).await.unwrap());
    exec(db, "DELETE FROM tokens WHERE token = 'h:628b49d96dcde97a430dd4f597705899e09a968f793491e4b704cae33a40dc02'").await;
    assert!(!token_live(db, Some("t1")).await.unwrap());
    crate::db::close(&state.db).await;
    assert!(token_live(db, Some("t1")).await.is_err());
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn token_recheck_fails_closed() {
    let (state, path) = crate::api::test_util::temp_state("ws_token_recheck").await;
    let db = &state.db;
    add_user(db, "tia").await;
    exec(
        db,
        "INSERT INTO tokens(token, username, created_at) VALUES('h:628b49d96dcde97a430dd4f597705899e09a968f793491e4b704cae33a40dc02', 'tia', 0), ('h:c44474038d459e40e4714afefa7bf8dae9f9834b22f5e8ec1dd434ecb62b512e', 'tia', 0)",
    )
    .await;
    let session = |token: &str| {
        let mut access = Access::new(Some(s("tia")), false, set(&["vault"]));
        access.token = Some(s(token));
        access.subs = set(&["open"]);
        access
    };
    let (mut tia, mut gone) = (session("t1"), session("t2"));
    exec(db, "DELETE FROM tokens WHERE token = 'h:c44474038d459e40e4714afefa7bf8dae9f9834b22f5e8ec1dd434ecb62b512e'").await;
    assert!(tia.check_token(db).await && !tia.retry.pending());
    assert!(!gone.check_token(db).await);
    let dm = WsEvent::Message {
        server: None,
        channel_id: None,
        dm_id: Some(2),
        dm_users: Some(vec![s("tia"), s("bob")]),
        message: Box::new(message()),
    };
    let scoped = [
        dm.clone(),
        WsEvent::MemberKicked {
            server: s("vault"),
            username: s("tia"),
            banned: false,
        },
        WsEvent::PresenceMode {
            username: s("tia"),
            appear_offline: true,
            seq: 0,
        },
        WsEvent::PresenceChanged {
            server: s("open"),
            username: s("bob"),
            online: true,
            online_count: 1,
        },
        WsEvent::ServerCreated {
            server: lite("seeded"),
        },
        WsEvent::RtcSignal {
            to: s("tia"),
            from: s("bob"),
            channel_id: None,
            dm_id: Some(2),
            payload: serde_json::Value::Null,
        },
    ];
    assert!(scoped.iter().take(4).all(|ev| tia.wants(ev)));
    crate::db::close(&state.db).await;
    let started = Instant::now();
    assert!(tia.check_token(db).await);
    assert!(tia.retry.pending() && tia.missed && tia.retry.since >= Some(started));
    assert!(scoped.iter().all(|ev| !tia.wants(ev)));
    let conn = state.hub.next_conn();
    assert_eq!(on_event(&state, conn, &mut tia, &dm).await, Some(false));
    assert!(tia.refresh(&state, conn).await && tia.retry.pending());
    assert!(tia.retry.at.unwrap() <= started + REAUTH_GIVE_UP);
    tia.retry.since = Instant::now().checked_sub(REAUTH_GIVE_UP);
    assert!(!tia.refresh(&state, conn).await);
    crate::api::test_util::done(state, path).await;
}

#[test]
fn lag_reauthorizes_at_most_every_interval() {
    let mut lag = Pace::new(LAG_REAUTH_EVERY);
    let start = Instant::now();
    assert!(lag.hit(start));
    assert!(!lag.hit(start + Duration::from_millis(100)));
    assert_eq!(lag.due, Some(start + LAG_REAUTH_EVERY));
    assert!(!lag.hit(start + Duration::from_millis(500)));
    lag.fire(start + LAG_REAUTH_EVERY);
    assert!(lag.due.is_none());
    assert!(lag.hit(start + LAG_REAUTH_EVERY * 2));
}

#[test]
fn only_lossy_epochs_owe_a_resync() {
    let mut access = Access::new(Some(s("tia")), false, HashSet::new());
    let mut seen = 0;
    access.note_epoch(&mut seen, Epoch { count: 1, lossy: 0 });
    access.note_epoch(&mut seen, Epoch { count: 2, lossy: 0 });
    assert!(!access.missed);
    access.note_epoch(&mut seen, Epoch { count: 3, lossy: 1 });
    assert!(std::mem::take(&mut access.missed) && seen == 1);
    access.note_epoch(&mut seen, Epoch { count: 4, lossy: 1 });
    assert!(!access.missed);
}

#[tokio::test]
async fn reauthorization_ends_revoked_sessions() {
    let (state, path) = crate::api::test_util::temp_state("ws_revoked").await;
    let db = &state.db;
    add_user(db, "tia").await;
    exec(
        db,
        "INSERT INTO tokens(token, username, created_at) VALUES('h:628b49d96dcde97a430dd4f597705899e09a968f793491e4b704cae33a40dc02', 'tia', 0), ('h:c44474038d459e40e4714afefa7bf8dae9f9834b22f5e8ec1dd434ecb62b512e', 'tia', 0)",
    )
    .await;
    let session = |token: &str| {
        let mut access = Access::new(Some(s("tia")), false, HashSet::new());
        access.token = Some(s(token));
        access
    };
    let (mut kept, mut gone) = (session("t1"), session("t2"));
    exec(db, "DELETE FROM tokens WHERE token = 'h:c44474038d459e40e4714afefa7bf8dae9f9834b22f5e8ec1dd434ecb62b512e'").await;
    assert!(kept.refresh(&state, 1).await);
    assert!(!gone.refresh(&state, 2).await);
    assert!(!wants(
        &WsEvent::TokensRevoked { username: s("tia") },
        Some("tia"),
        true,
        &HashSet::new(),
        &HashSet::new()
    ));
    crate::api::test_util::done(state, path).await;
}

#[test]
fn subscribe_checks_are_paced_and_the_last_list_wins() {
    let now = Instant::now();
    let names: Vec<String> = (0..200).map(|i| format!("Srv{i}")).collect();
    let mut guest = SubPace::new(false);
    let mut applied = 0;
    for _ in 0..200 {
        guest.want(names.clone(), HashMap::new());
        if guest.take(|servers, _| servers.len(), now).is_some() {
            applied += 1;
        }
    }
    assert_eq!(
        applied, 1,
        "one flood of unknown names runs its checks once"
    );
    let (waiting, _) = guest.wanted.clone().expect("the last list waits");
    assert_eq!(waiting.len(), GUEST_SUBSCRIBE_CAP);
    assert_eq!(waiting[0], "srv0");
    let due = guest.due.expect("due");
    assert!(due >= now + Duration::from_secs(3));
    assert!(guest.take(|servers, _| servers.len(), due).is_some());
    let mut user = SubPace::new(true);
    let mut applied = 0;
    for _ in 0..200 {
        user.want(vec![s("RChat"), s("rchat")], HashMap::new());
        if let Some((servers, _)) = user.take(|_, _| 0, now) {
            assert_eq!(servers, vec![s("rchat")]);
            applied += 1;
        }
    }
    assert_eq!(applied, (SUB_CHECKS_BURST / SUB_FRAME_COST) as usize);
    let mut tab = SubPace::new(true);
    tab.want(vec![s("rchat")], HashMap::new());
    assert!(
        tab.take(|servers, _| servers.len(), now).is_some(),
        "a normal client subscribes at once"
    );
}
