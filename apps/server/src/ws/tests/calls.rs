use std::collections::HashMap;

use axum::extract::State;
use tokio::time::Instant;

use super::*;
use crate::api::messages::{Quotes, load_message};
use crate::db::now;
use crate::hub::VOICE_EVERY;
use crate::ws::access::{Access, still_held};
use crate::ws::calls::{VoiceWait, call_peer_id, in_call, in_voice, voice_msg};
use crate::ws::p2p::CALLING_TOO_OFTEN;
use crate::ws::protocol::ClientMsg;

async fn time_out(db: &Db, user: &str, until: i64) {
    sqlx::query("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', $1, $2, 0) ON CONFLICT(server, username) DO UPDATE SET until = excluded.until")
        .bind(user)
        .bind(until)
        .execute(db)
        .await
        .expect("timeout");
}

#[tokio::test]
async fn banned_user_cannot_join_voice() {
    let (state, path) = crate::api::test_util::temp_state("ban_voice").await;
    for name in ["bob", "carol"] {
        add_user_row(&state.db, name).await;
    }
    let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    exec(&state.db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('rchat', 'bob', 'alice', 0)").await;
    let join = |user| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id: cid });
    assert_eq!(join("bob").await, Err("Channel not found".into()));
    join("carol").await.expect("carol joins");
    assert_eq!(
        state.hub.rooms_in("rchat", None),
        vec![(cid, vec!["carol".to_string()])]
    );
    assert!(
        !authed_sub_ok(&state.db, "rchat", "bob", false)
            .await
            .expect("sub")
    );
    assert!(
        authed_sub_ok(&state.db, "rchat", "carol", false)
            .await
            .expect("sub")
    );
    let access = Access::new(Some(s("bob")), false, set(&[]));
    assert!(
        !still_held(&state.db, &access, "rchat", &state.limits)
            .await
            .expect("held")
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn timed_out_members_cannot_join_voice() {
    let (state, path) = crate::api::test_util::temp_state("timeout_voice").await;
    for name in ["bob", "carol"] {
        add_user_row(&state.db, name).await;
        crate::api::test_util::add_member(&state.db, "rchat", name, 0, 0, 0).await;
    }
    let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    let other = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'den', 'voice', 0) RETURNING id").await;
    time_out(&state.db, "bob", now() + 600).await;
    let join = |user, channel_id| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id });
    let timed_out = Err(crate::api::access::TIMED_OUT.into());
    assert_eq!(join("bob", cid).await, timed_out);
    join("carol", cid).await.expect("carol joins");
    time_out(&state.db, "carol", now() + 600).await;
    assert_eq!(
        state.hub.rooms_in("rchat", None),
        vec![(cid, vec!["carol".to_string()])],
        "a timeout mutes, it does not disconnect"
    );
    assert_eq!(join("carol", other).await, timed_out, "no switching rooms");
    voice_msg(&state, "carol", 1, ClientMsg::VoiceLeave)
        .await
        .expect("leave");
    assert_eq!(
        join("carol", cid).await,
        timed_out,
        "leaving and rejoining stays blocked"
    );
    time_out(&state.db, "carol", now()).await;
    join("carol", cid).await.expect("joins once it ended");
    exec(
        &state.db,
        "DELETE FROM member_timeouts WHERE username = 'bob'",
    )
    .await;
    join("bob", cid).await.expect("joins once removed");
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn timed_out_members_cannot_turn_on_video_in_voice() {
    let (state, path) = crate::api::test_util::temp_state("timeout_video").await;
    for name in ["bob", "carol"] {
        add_user_row(&state.db, name).await;
        crate::api::test_util::add_member(&state.db, "rchat", name, 0, 0, 0).await;
    }
    let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    for name in ["bob", "carol"] {
        voice_msg(&state, name, 1, ClientMsg::VoiceJoin { channel_id: cid })
            .await
            .expect("join");
    }
    time_out(&state.db, "bob", now() + 600).await;
    let signal = |from, payload| {
        voice_msg(
            &state,
            from,
            1,
            ClientMsg::RtcSignal {
                to: s(if from == "bob" { "carol" } else { "bob" }),
                channel_id: Some(cid),
                dm_id: None,
                payload,
            },
        )
    };
    let timed_out = Err(crate::api::access::TIMED_OUT.into());
    assert_eq!(
        signal("bob", serde_json::json!({"cam": true})).await,
        timed_out
    );
    assert_eq!(
        signal(
            "bob",
            serde_json::json!({"muted": true, "cam": false, "screen": true})
        )
        .await,
        timed_out
    );
    for ok in [
        serde_json::json!({"muted": true, "cam": false, "screen": false}),
        serde_json::json!({"candidate": {"candidate": ""}}),
        serde_json::json!({"restart": true}),
    ] {
        signal("bob", ok.clone())
            .await
            .expect("audio signalling stays");
    }
    signal("carol", serde_json::json!({"cam": true, "screen": true}))
        .await
        .expect("others are not affected");
    time_out(&state.db, "bob", now()).await;
    signal("bob", serde_json::json!({"cam": true}))
        .await
        .expect("works once it ended");
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn timed_out_members_cannot_tell_if_hidden_voice_is_in_use() {
    let (state, path) = crate::api::test_util::temp_state("timeout_hidden_voice").await;
    for name in ["alice", "bob"] {
        add_user_row(&state.db, name).await;
        crate::api::test_util::add_member(&state.db, "rchat", name, 0, 0, 0).await;
    }
    let busy = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at, restrict_view) VALUES('rchat', 'staff', 'voice', 0, 1) RETURNING id").await;
    let empty = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at, restrict_view) VALUES('rchat', 'quiet', 'voice', 0, 1) RETURNING id").await;
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 1)")
        .bind(busy)
        .execute(&state.db)
        .await
        .expect("rule");
    voice_msg(
        &state,
        "alice",
        1,
        ClientMsg::VoiceJoin { channel_id: busy },
    )
    .await
    .expect("alice joins");
    time_out(&state.db, "bob", now() + 600).await;
    let probe = |channel_id| {
        voice_msg(
            &state,
            "bob",
            2,
            ClientMsg::RtcSignal {
                to: s("alice"),
                channel_id: Some(channel_id),
                dm_id: None,
                payload: serde_json::json!({"cam": true}),
            },
        )
    };
    let none = Err("No shared voice session".into());
    assert_eq!(probe(busy).await, none, "a hidden room in use");
    assert_eq!(probe(empty).await, none, "an empty hidden room");
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn locked_server_voice_needs_membership() {
    let (state, path) = crate::api::test_util::temp_state("locked_voice").await;
    let db = &state.db;
    for name in ["alice", "bob", "eve", "root"] {
        add_user_row(db, name).await;
    }
    exec(
        db,
        "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
    )
    .await;
    exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 0)").await;
    let cid = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('vault', 'lounge', 'voice', 0) RETURNING id").await;
    exec(
        db,
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('vault', 'alice', 1, 0)",
    )
    .await;
    exec(
        db,
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('vault', 'bob', 0, 0)",
    )
    .await;
    let join = |user| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id: cid });
    join("bob").await.expect("member joins");
    state.hub.voice_leave("bob").await;
    exec(
        db,
        "DELETE FROM members WHERE server = 'vault' AND username = 'bob'",
    )
    .await;
    for (outsider, want) in [
        ("bob", "Channel not found"),
        ("eve", "Channel not found"),
        ("root", "Join this server to use voice"),
    ] {
        assert_eq!(join(outsider).await, Err(want.into()), "{outsider}");
    }
    join("alice").await.expect("alice joins");
    assert_eq!(
        state.hub.rooms_in("vault", None),
        vec![(cid, vec!["alice".to_string()])]
    );
    exec(
        db,
        "UPDATE servers SET password_hash = '!purging' WHERE name = 'vault'",
    )
    .await;
    state.hub.voice_leave("alice").await;
    assert_eq!(join("alice").await, Err("Channel not found".into()));
    crate::api::test_util::done(state, path).await;
}

/// Sets the instance's joining rule as the admin page stores it, and drops the cached settings.
async fn set_joining(db: &Db, mode: &str) {
    exec(db, "DELETE FROM settings WHERE key = 'server_joining'").await;
    sqlx::query("INSERT INTO settings(key, value) VALUES('server_joining', $1)")
        .bind(mode)
        .execute(db)
        .await
        .expect("joining");
    crate::api::Settings::forget(db);
}

async fn site_sets(state: &AppState, body: serde_json::Value) {
    let patch = serde_json::from_value(body).expect("patch");
    let _ = crate::api::admin::patch_settings(
        State(state.clone()),
        crate::api::Authed(crate::api::test_util::mem_user("root", true)),
        axum::Json(patch),
    )
    .await
    .expect("settings");
}

async fn within_5s(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + std::time::Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < until, "{what} within 5 seconds");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// The four kinds of server people who aren't members meet, each with a voice channel and
/// `alice` as their admin: `vault` (password, reading on), `locked` (password), `open` (no
/// password, reading on) and `lobby` (no password, following the site).
async fn reading_world(db: &Db) -> Vec<(&'static str, i64)> {
    for name in ["alice", "eve"] {
        add_user_row(db, name).await;
    }
    exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, public_read, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 1, 0)").await;
    exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('locked', 'Locked', 'alice', 'hash', 0)").await;
    exec(db, "INSERT INTO servers(name, display_name, creator, public_read, created_at) VALUES('open', 'Open', 'alice', 1, 0)").await;
    exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('lobby', 'Lobby', 'alice', 0)").await;
    let mut rooms = Vec::new();
    for server in ["vault", "locked", "open", "lobby"] {
        let cid: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES($1, 'talk', 'voice', 0) RETURNING id")
            .bind(server)
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        crate::api::test_util::add_member(db, server, "alice", 1, 0, 0).await;
        rooms.push((server, cid));
    }
    rooms
}

async fn set_control(db: &Db, key: &str, value: &str) {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(db)
        .await
        .expect("control");
    crate::api::Settings::forget(db);
}

#[tokio::test]
async fn voice_follows_who_can_open_the_server() {
    let (state, path) = crate::api::test_util::temp_state("reader_voice").await;
    let db = &state.db;
    let rooms = reading_world(db).await;
    let hidden = insert_id(db, "INSERT INTO channels(server, name, kind, created_at, restrict_view) VALUES('open', 'staff', 'voice', 0, 1) RETURNING id").await;
    let join = |user, channel_id| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id });
    let gone = Err("Channel not found".into());
    for (mode, reading, opens) in [
        ("everyone", "1", ["vault", "open", "lobby"].as_slice()),
        ("invites", "1", &["vault", "open"]),
        ("nobody", "1", &["vault", "open"]),
        ("everyone", "0", &[]),
        ("invites", "0", &[]),
    ] {
        set_joining(db, mode).await;
        set_control(db, "public_reading", reading).await;
        for (server, cid) in &rooms {
            let got = join("eve", *cid).await;
            match opens.contains(server) {
                true => {
                    got.unwrap_or_else(|e| panic!("{mode} {reading} {server}: {e:?}"));
                    assert_eq!(
                        state.hub.rooms_in(server, None),
                        vec![(*cid, vec![s("eve")])],
                        "{mode} {reading} {server}: open to a guest, so to eve"
                    );
                    state.hub.voice_leave("eve").await;
                }
                false => assert_eq!(
                    got, gone,
                    "{mode} {reading} {server}: a guest can't open it, so eve can't talk"
                ),
            }
            join("alice", *cid).await.expect("members always talk");
            state.hub.voice_leave("alice").await;
        }
        assert_eq!(
            join("eve", hidden).await,
            gone,
            "{mode} {reading}: channel permissions still apply"
        );
    }
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn readers_leave_voice_when_the_server_closes_to_them() {
    let (state, path) = crate::api::test_util::temp_state("reader_voice_close").await;
    let db = &state.db;
    let rooms = reading_world(db).await;
    let room = |name: &str| rooms.iter().find(|(s, _)| *s == name).expect("room").1;
    let follow = crate::api::Settings::follow(&state);
    let join = |user, channel_id| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id });
    join("eve", room("lobby")).await.expect("eve reads lobby");
    site_sets(&state, serde_json::json!({"server_joining": "invites"})).await;
    within_5s("eve leaves a server only members open now", || {
        state.hub.rooms_in("lobby", None).is_empty()
    })
    .await;
    join("eve", room("open"))
        .await
        .expect("the owner made open readable");
    join("alice", room("lobby")).await.expect("a member stays");
    site_sets(&state, serde_json::json!({"server_joining": "nobody"})).await;
    site_sets(&state, serde_json::json!({"server_joining": "invites"})).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(
        state.hub.rooms_in("open", None),
        vec![(room("open"), vec![s("eve")])],
        "still readable, so still in voice"
    );
    assert_eq!(state.hub.rooms_in("lobby", None).len(), 1, "members stay");
    let patch = serde_json::from_value(serde_json::json!({"public_read": null})).expect("patch");
    let _ = crate::api::servers::update_server(
        State(state.clone()),
        crate::api::Authed(crate::api::test_util::mem_user("alice", false)),
        axum::extract::Path(s("open")),
        axum::Json(patch),
    )
    .await
    .expect("the owner turns reading back to the site's rule");
    within_5s("eve leaves when the owner closes it", || {
        state.hub.rooms_in("open", None).is_empty()
    })
    .await;
    follow.abort();
    crate::api::test_util::done(state, path).await;
}

const GUEST: &str = "@guest:00000000000000aa";

/// A guest connection named `GUEST`, following `subs` with `grants`.
fn guest_at(subs: &[&str], grants: &[(&str, &str)]) -> Access {
    let mut access = Access::new(None, false, set(&[]));
    access.guest = Some(s(GUEST));
    access.subs = set(subs);
    access.grants = grants.iter().map(|(k, v)| (s(k), s(v))).collect();
    access
}

/// A live guest grant on `server` from the password `password_id` (`None`: the permanent one).
async fn grant_on(db: &Db, server: &str, password_id: Option<i64>, tag: &str) -> String {
    let grant = crate::api::test_util::test_grant(tag);
    sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id) VALUES($1, $2, 0, 4000000000, $3)")
        .bind(crate::db::secret_key(&grant))
        .bind(server)
        .bind(password_id)
        .execute(db)
        .await
        .expect("grant");
    grant
}

async fn as_guest(
    state: &AppState,
    access: &Access,
    msg: ClientMsg,
) -> Result<(), crate::ws::protocol::Refused> {
    crate::ws::calls::voice_cmd(state, access, 9, msg).await
}

#[tokio::test]
async fn guests_use_voice_where_they_can_open_the_server() {
    let (state, path) = crate::api::test_util::temp_state("guest_voice").await;
    let db = &state.db;
    let rooms = reading_world(db).await;
    let room = |name: &str| rooms.iter().find(|(s, _)| *s == name).expect("room").1;
    let grant = grant_on(db, "locked", None, "locked-guest").await;
    let hidden = insert_id(db, "INSERT INTO channels(server, name, kind, created_at, restrict_view) VALUES('lobby', 'staff', 'voice', 0, 1) RETURNING id").await;
    let text = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('lobby', 'chat', 'text', 0) RETURNING id").await;
    let all = guest_at(&["vault", "locked", "open", "lobby"], &[("locked", &grant)]);
    let join = |channel_id| ClientMsg::VoiceJoin { channel_id };
    let gone = Err("Channel not found".into());
    for (mode, opens) in [
        ("everyone", ["vault", "locked", "open", "lobby"].as_slice()),
        ("invites", &["vault", "locked", "open"]),
    ] {
        set_joining(db, mode).await;
        for (server, cid) in &rooms {
            let grant = all.grants.get(*server).map(String::as_str);
            let follows = crate::ws::guest_sub_ok(db, server, grant, &state.limits)
                .await
                .expect("sub");
            assert_eq!(follows, opens.contains(server), "{mode} {server}");
            let got = as_guest(&state, &all, join(*cid)).await;
            match follows {
                true => {
                    got.unwrap_or_else(|e| panic!("{mode} {server}: {e:?}"));
                    assert_eq!(
                        state.hub.rooms_in(server, None),
                        vec![(*cid, vec![s(GUEST)])],
                        "{mode} {server}: a guest who can open it talks"
                    );
                    as_guest(&state, &all, ClientMsg::VoiceLeave)
                        .await
                        .expect("leave");
                }
                false => assert_eq!(got, gone, "{mode} {server}"),
            }
        }
    }
    set_joining(db, "everyone").await;
    for (why, access) in [
        ("not following it", guest_at(&["vault"], &[])),
        ("without the password", guest_at(&["locked"], &[])),
    ] {
        let server = match why {
            "not following it" => "lobby",
            _ => "locked",
        };
        assert_eq!(
            as_guest(&state, &access, join(room(server))).await,
            gone,
            "{why}"
        );
    }
    assert_eq!(
        as_guest(&state, &all, join(hidden)).await,
        gone,
        "channel permissions apply"
    );
    assert_eq!(
        as_guest(&state, &all, join(text)).await,
        Err("Not a voice channel".into())
    );
    assert_eq!(
        as_guest(
            &state,
            &all,
            ClientMsg::CallStart {
                dm_id: 1,
                p2p: false,
                video: false,
                peer_id: None,
                relays: Vec::new(),
            }
        )
        .await,
        Err("Create an account to join voice".into()),
        "calls need an account"
    );
    assert_eq!(
        as_guest(
            &state,
            &Access::new(None, false, set(&["lobby"])),
            join(room("lobby"))
        )
        .await,
        Err("Create an account to join voice".into()),
        "a connection without a voice name"
    );

    as_guest(&state, &all, join(room("lobby")))
        .await
        .expect("guest joins");
    voice_msg(&state, "alice", 1, join(room("lobby")))
        .await
        .expect("alice joins");
    let mut rx = state.hub.subscribe();
    let signal = |to: &str, channel_id, dm_id| ClientMsg::RtcSignal {
        to: s(to),
        channel_id,
        dm_id,
        payload: serde_json::json!({"sdp": "x"}),
    };
    as_guest(&state, &all, signal("alice", Some(room("lobby")), None))
        .await
        .expect("a guest signals alice");
    voice_msg(&state, "alice", 1, signal(GUEST, Some(room("lobby")), None))
        .await
        .expect("alice signals the guest, by its name as it is");
    let mut seen = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let WsEvent::RtcSignal {
            to,
            from,
            channel_id: _,
            dm_id: _,
            payload: _,
        } = ev
        {
            seen.push(format!("{from} -> {to}"));
        }
    }
    assert_eq!(
        seen,
        [format!("{GUEST} -> alice"), format!("alice -> {GUEST}")]
    );
    let none = Err("No shared voice session".into());
    assert_eq!(
        as_guest(&state, &all, signal("eve", Some(room("lobby")), None)).await,
        none
    );
    assert_eq!(
        as_guest(&state, &all, signal("alice", None, Some(1))).await,
        none
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn a_guest_leaves_voice_when_its_server_closes_to_it() {
    let (state, path) = crate::api::test_util::temp_state("guest_voice_close").await;
    let db = &state.db;
    let rooms = reading_world(db).await;
    let room = |name: &str| rooms.iter().find(|(s, _)| *s == name).expect("room").1;
    let conn = state.hub.next_conn();
    let ticket = insert_id(db, "INSERT INTO server_passwords(server, label, hash, lookup, created_at, expires_at) VALUES('locked', 'Friends', 'h', 'l', 0, 4000000000) RETURNING id").await;
    let grant = grant_on(db, "locked", Some(ticket), "ticket-guest").await;
    let mut guest = guest_at(&[], &[]);
    let follow = |servers: &[&str]| servers.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    crate::ws::conn::subscribe(
        &state,
        conn,
        &mut guest,
        follow(&["locked", "lobby"]),
        HashMap::from([(s("locked"), grant.clone())]),
    )
    .await;
    assert_eq!(guest.subs, set(&["locked", "lobby"]));
    let join = |channel_id| ClientMsg::VoiceJoin { channel_id };
    as_guest(&state, &guest, join(room("locked")))
        .await
        .expect("in with the password");

    exec(db, "UPDATE server_passwords SET expires_at = 1").await;
    assert!(guest.refresh(&state, conn).await);
    assert_eq!(guest.subs, set(&["lobby"]));
    within_5s("the guest leaves voice when its password ends", || {
        state.hub.rooms_in("locked", None).is_empty()
    })
    .await;
    assert_eq!(
        as_guest(&state, &guest, join(room("locked"))).await,
        Err("Channel not found".into())
    );

    as_guest(&state, &guest, join(room("lobby")))
        .await
        .expect("lobby is public");
    set_joining(db, "invites").await;
    assert!(guest.refresh(&state, conn).await);
    within_5s(
        "the guest leaves voice when only members open the server",
        || state.hub.rooms_in("lobby", None).is_empty(),
    )
    .await;

    crate::ws::conn::subscribe(&state, conn, &mut guest, follow(&["vault"]), HashMap::new()).await;
    as_guest(&state, &guest, join(room("vault")))
        .await
        .expect("vault is readable");
    crate::ws::conn::subscribe(&state, conn, &mut guest, Vec::new(), HashMap::new()).await;
    within_5s(
        "the guest leaves voice when it stops following the server",
        || state.hub.rooms_in("vault", None).is_empty(),
    )
    .await;
    crate::api::test_util::done(state, path).await;
}

#[test]
fn guests_get_only_their_own_voice_events() {
    let guest = guest_at(&["rchat"], &[]);
    assert!(
        guest
            .topics()
            .contains(&crate::fanout::Topic::User(s(GUEST)))
    );
    let signal = |to: &str| WsEvent::RtcSignal {
        to: s(to),
        from: s("alice"),
        channel_id: Some(1),
        dm_id: None,
        payload: serde_json::json!({}),
    };
    let ended = |user: &str| WsEvent::VoiceEnded {
        server: None,
        channel_id: Some(1),
        dm_id: None,
        dm_users: Some(vec![s(user)]),
        reason: s("You no longer have access to this voice channel"),
    };
    assert!(guest.wants(&signal(GUEST)));
    assert!(guest.wants(&ended(GUEST)));
    assert!(!guest.wants(&signal("@guest:00000000000000bb")));
    assert!(!guest.wants(&ended("alice")));
    assert!(
        !guest.wants(&WsEvent::MemberTimeout {
            server: s("rchat"),
            username: s("bob"),
            until: Some(9),
            remaining: 9,
            reason: None,
        }),
        "nothing else meant for accounts"
    );
    let plain = Access::new(None, false, set(&[]));
    assert!(!plain.wants(&signal(GUEST)));
}

#[tokio::test]
async fn site_admins_get_member_view_in_voice() {
    let (state, path) = crate::api::test_util::temp_state("admin_voice_view").await;
    let db = &state.db;
    for name in ["alice", "root"] {
        add_user_row(db, name).await;
        sqlx::query(
            "INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, 0)",
        )
        .bind(name)
        .execute(db)
        .await
        .expect("member");
    }
    exec(
        db,
        "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
    )
    .await;
    let cid = insert_id(db, "INSERT INTO channels(server, name, kind, created_at, restrict_view) VALUES('rchat', 'staff', 'voice', 0, 1) RETURNING id").await;
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 1)")
        .bind(cid)
        .execute(db)
        .await
        .expect("rule");
    let join = |user| voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id: cid });
    assert_eq!(
        join("root").await,
        Err("Channel not found".into()),
        "a site admin who is a plain member can not join a hidden voice channel"
    );
    join("alice").await.expect("alice joins");
    let _ = state.hub.voice_join("root", 2, "rchat", cid).await;
    evict_unviewable(&state, "rchat", Some(cid)).await;
    assert_eq!(
        state.hub.rooms_in("rchat", None),
        vec![(cid, vec!["alice".to_string()])],
        "the recheck uses member rights too"
    );
    crate::api::test_util::done(state, path).await;
}

#[test]
fn calls_name_only_plain_peer_ids() {
    assert_eq!(call_peer_id(None), Ok(None));
    assert_eq!(call_peer_id(Some(s("peer-a"))), Ok(Some(s("peer-a"))));
    assert_eq!(call_peer_id(Some(s("a b"))), Err(s("Invalid peer id")));
}

#[tokio::test]
async fn active_call_state_carries_the_answer_time() {
    let (state, path) = crate::api::test_util::temp_state("call_answered_at").await;
    let db = &state.db;
    for name in ["alice", "bob"] {
        add_user_row(db, name).await;
    }
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let mut rx = state.hub.subscribe();
    let start = ClientMsg::CallStart {
        dm_id: dm,
        p2p: false,
        video: false,
        peer_id: None,
        relays: Vec::new(),
    };
    voice_msg(&state, "alice", 1, start).await.expect("start");
    let accept = ClientMsg::CallAccept {
        dm_id: dm,
        peer_id: None,
        relays: Vec::new(),
    };
    voice_msg(&state, "bob", 2, accept).await.expect("accept");
    let mut seen = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let WsEvent::CallState {
            dm_id: _,
            dm_users: _,
            state,
            from: _,
            kind: _,
            video: _,
            call_id: _,
            answered_at,
            peers: _,
            relays: _,
        } = ev
        {
            seen.push((state, answered_at));
        }
    }
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0], (CallPhase::Ringing, None));
    assert_eq!(seen[1].0, CallPhase::Active);
    assert!(seen[1].1.is_some_and(|at| at > 0));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn blocked_users_cannot_call() {
    let (state, path) = crate::api::test_util::temp_state("call_blocked").await;
    let db = &state.db;
    for name in ["alice", "bob"] {
        add_user_row(db, name).await;
    }
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 1)")
        .execute(db)
        .await
        .expect("block");
    let start = || ClientMsg::CallStart {
        dm_id: dm,
        p2p: false,
        video: false,
        peer_id: None,
        relays: Vec::new(),
    };
    assert_eq!(
        voice_msg(&state, "bob", 1, start())
            .await
            .err()
            .map(|e| e.message)
            .as_deref(),
        Some(crate::api::blocks::NOT_ACCEPTING)
    );
    assert!(voice_msg(&state, "alice", 2, start()).await.is_err());
    let logs = insert_id(db, "SELECT COUNT(*) FROM messages WHERE kind = 'call'").await;
    assert_eq!(logs, 0);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn calls_answer_alike_for_missing_and_unreachable_dms() {
    let (state, path) = crate::api::test_util::temp_state("call_dm_probe").await;
    let db = &state.db;
    for name in ["alice", "bob", "carol", "dave"] {
        add_user_row(db, name).await;
    }
    let theirs = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('bob', 'carol') RETURNING id",
    )
    .await;
    let purging = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'dave') RETURNING id",
    )
    .await;
    exec(
        db,
        "UPDATE users SET password_hash = '!purging' WHERE username = 'dave'",
    )
    .await;
    let start = |dm_id| ClientMsg::CallStart {
        dm_id,
        p2p: false,
        video: false,
        peer_id: None,
        relays: Vec::new(),
    };
    let alice = crate::api::test_util::mem_user("alice", false);
    for dm in [theirs, purging + 100, purging] {
        assert_eq!(
            voice_msg(&state, "alice", 1, start(dm)).await,
            Err("DM not found".into()),
            "dm {dm}"
        );
        let rest = crate::api::access::resolve_dm(db, dm, &alice).await;
        assert!(
            rest.is_err_and(|e| e.0 == axum::http::StatusCode::NOT_FOUND),
            "dm {dm}"
        );
    }
    let logs = insert_id(db, "SELECT COUNT(*) FROM messages WHERE kind = 'call'").await;
    assert_eq!(logs, 0);
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn accepts_answer_alike_for_missing_and_unreachable_dms() {
    let (state, path) = crate::api::test_util::temp_state("accept_dm_probe").await;
    let db = &state.db;
    for name in ["alice", "bob", "carol", "dave", "erin", "frank"] {
        add_user_row(db, name).await;
    }
    let theirs = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('bob', 'carol') RETURNING id",
    )
    .await;
    let purging = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'dave') RETURNING id",
    )
    .await;
    exec(
        db,
        "UPDATE users SET password_hash = '!purging' WHERE username = 'dave'",
    )
    .await;
    exec(
        db,
        "INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 1)",
    )
    .await;
    let start = ClientMsg::CallStart {
        dm_id: theirs,
        p2p: true,
        video: false,
        peer_id: Some(s("peer-a")),
        relays: vec![s("turn.a.example")],
    };
    voice_msg(&state, "bob", 1, start).await.expect("start");
    let accept = |dm_id, relays: Vec<String>| ClientMsg::CallAccept {
        dm_id,
        peer_id: Some(s("peer-x")),
        relays,
    };
    let none = Err(s("No incoming call").into());
    assert_eq!(
        voice_msg(&state, "alice", 2, accept(theirs, Vec::new())).await,
        none
    );
    assert_eq!(
        voice_msg(&state, "alice", 2, accept(purging, Vec::new())).await,
        none
    );
    assert_eq!(
        voice_msg(&state, "frank", 3, accept(purging + 100, Vec::new())).await,
        none
    );
    for n in 0..5 {
        assert_eq!(
            voice_msg(&state, "erin", 4, accept(theirs, vec![s("not a host!")])).await,
            none,
            "probe {n}"
        );
    }
    assert_eq!(
        voice_msg(&state, "erin", 4, accept(theirs, vec![s("not a host!")])).await,
        Err(s("Too many requests, slow down").into())
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn blocking_ends_calls_and_stops_answers_and_signals() {
    let (state, path) = crate::api::test_util::temp_state("call_block_ends").await;
    let db = &state.db;
    for name in ["alice", "bob"] {
        add_user_row(db, name).await;
    }
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let start = || ClientMsg::CallStart {
        dm_id: dm,
        p2p: false,
        video: false,
        peer_id: None,
        relays: Vec::new(),
    };
    let accept = || ClientMsg::CallAccept {
        dm_id: dm,
        peer_id: None,
        relays: Vec::new(),
    };
    let signal = || ClientMsg::RtcSignal {
        to: s("alice"),
        channel_id: None,
        dm_id: Some(dm),
        payload: serde_json::json!({ "sdp": "x" }),
    };
    let block = async |on: bool| match on {
        true => {
            let _ = crate::api::blocks::block_user(
                State(state.clone()),
                crate::api::Authed(crate::api::test_util::mem_user("alice", false)),
                axum::Json(
                    serde_json::from_value(serde_json::json!({ "username": "bob" })).expect("req"),
                ),
            )
            .await
            .expect("block");
        }
        false => {
            sqlx::query("DELETE FROM blocks")
                .execute(&state.db)
                .await
                .expect("unblock");
        }
    };
    let quiet_block = async || {
        sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 1)")
            .execute(&state.db)
            .await
            .expect("row");
    };
    let outcome = async || -> (Option<String>, bool) {
        let r = sqlx::query(
            "SELECT call_outcome, call_ended_at FROM messages WHERE kind = 'call' ORDER BY id DESC LIMIT 1",
        )
        .fetch_one(&state.db)
        .await
        .expect("log");
        (r.get(0), r.get::<Option<i64>, _>(1).is_some())
    };
    let ended = |rx: &mut broadcast::Receiver<WsEvent>| {
        std::iter::from_fn(|| rx.try_recv().ok()).any(|ev| {
            matches!(ev, WsEvent::CallState { dm_id, state: CallPhase::Ended, .. } if dm_id == dm)
        })
    };

    voice_msg(&state, "bob", 1, start()).await.expect("ring");
    let mut rx = state.hub.subscribe();
    block(true).await;
    assert!(ended(&mut rx), "the ringing call ends");
    assert_eq!(outcome().await, (Some(s("declined")), true));
    assert!(voice_msg(&state, "alice", 2, accept()).await.is_err());
    block(false).await;

    voice_msg(&state, "bob", 1, start())
        .await
        .expect("ring again");
    quiet_block().await;
    assert_eq!(
        voice_msg(&state, "alice", 2, accept())
            .await
            .err()
            .map(|e| e.message)
            .as_deref(),
        Some("You blocked this user. Unblock them to send messages.")
    );
    state.hub.call_end("bob", dm).await.expect("end");
    block(false).await;

    voice_msg(&state, "bob", 1, start()).await.expect("ring");
    voice_msg(&state, "alice", 2, accept())
        .await
        .expect("answer");
    voice_msg(&state, "bob", 1, signal())
        .await
        .expect("signals flow");
    quiet_block().await;
    assert_eq!(
        voice_msg(&state, "bob", 1, signal())
            .await
            .err()
            .map(|e| e.message)
            .as_deref(),
        Some(crate::api::blocks::NOT_ACCEPTING)
    );
    block(false).await;

    let mut rx = state.hub.subscribe();
    block(true).await;
    assert!(ended(&mut rx), "the active call ends");
    assert_eq!(outcome().await, (Some(s("completed")), true));
    assert!(voice_msg(&state, "bob", 1, signal()).await.is_err());
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn p2p_calls_take_only_valid_relay_hosts() {
    let (state, path) = crate::api::test_util::temp_state("call_relays").await;
    let db = &state.db;
    for name in ["alice", "bob"] {
        add_user_row(db, name).await;
    }
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let start = |relays: Vec<String>| ClientMsg::CallStart {
        dm_id: dm,
        p2p: true,
        video: false,
        peer_id: Some(s("peer-a")),
        relays,
    };
    for bad in [
        vec![s("turn:x.example")],
        vec![s("x.example:3478")],
        (0..5).map(|n| format!("r{n}.example")).collect(),
    ] {
        assert!(voice_msg(&state, "alice", 1, start(bad)).await.is_err());
    }
    let mut rx = state.hub.subscribe();
    voice_msg(&state, "alice", 1, start(vec![s("Turn.A.example")]))
        .await
        .expect("start");
    let bad_accept = ClientMsg::CallAccept {
        dm_id: dm,
        peer_id: Some(s("peer-b")),
        relays: vec![s("<b>")],
    };
    assert!(voice_msg(&state, "bob", 2, bad_accept).await.is_err());
    let accept = ClientMsg::CallAccept {
        dm_id: dm,
        peer_id: Some(s("peer-b")),
        relays: vec![s("turn.b.example")],
    };
    voice_msg(&state, "bob", 2, accept).await.expect("accept");
    let mut seen = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let WsEvent::CallState {
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
        } = ev
        {
            seen.push((
                state,
                relays
                    .into_iter()
                    .map(|r| (r.user, r.hosts))
                    .collect::<Vec<_>>(),
            ));
        }
    }
    assert_eq!(
        seen,
        vec![
            (
                CallPhase::Ringing,
                vec![(s("alice"), vec![s("turn.a.example")])]
            ),
            (
                CallPhase::Active,
                vec![
                    (s("alice"), vec![s("turn.a.example")]),
                    (s("bob"), vec![s("turn.b.example")])
                ]
            ),
        ]
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn instance_calls_ignore_relays_on_accept() {
    let (state, path) = crate::api::test_util::temp_state("call_relays_rtc").await;
    let db = &state.db;
    for name in ["alice", "bob"] {
        add_user_row(db, name).await;
    }
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let start = ClientMsg::CallStart {
        dm_id: dm,
        p2p: false,
        video: false,
        peer_id: None,
        relays: Vec::new(),
    };
    voice_msg(&state, "alice", 1, start).await.expect("start");
    assert_eq!(state.hub.call_kind(dm), Some(CallKind::Rtc));
    let mut rx = state.hub.subscribe();
    let accept = ClientMsg::CallAccept {
        dm_id: dm,
        peer_id: None,
        relays: vec![s("<b>")],
    };
    voice_msg(&state, "bob", 2, accept).await.expect("accept");
    let mut active = 0;
    while let Ok(ev) = rx.try_recv() {
        if let WsEvent::CallState {
            dm_id: _,
            dm_users: _,
            state: CallPhase::Active,
            from: _,
            kind: _,
            video: _,
            call_id: _,
            answered_at: _,
            peers: _,
            relays,
        } = ev
        {
            assert!(relays.is_empty());
            active += 1;
        }
    }
    assert_eq!(active, 1);
    assert_eq!(
        state.hub.call_relays(dm),
        Some(vec![(s("alice"), Vec::new())])
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn call_logs_record_video_and_the_connection() {
    let (state, path) = crate::api::test_util::temp_state("call_log_kind").await;
    let db = &state.db;
    for name in ["alice", "bob"] {
        add_user_row(db, name).await;
    }
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let mut logs = Vec::new();
    for (p2p, video) in [(false, false), (true, true), (false, true)] {
        let start = ClientMsg::CallStart {
            dm_id: dm,
            p2p,
            video,
            peer_id: p2p.then(|| s("peer-a")),
            relays: Vec::new(),
        };
        let mut rx = state.hub.subscribe();
        voice_msg(&state, "alice", 1, start).await.expect("start");
        let mut rung = None;
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::CallState {
                dm_id: _,
                dm_users: _,
                state: _,
                from: _,
                kind,
                video,
                call_id: _,
                answered_at: _,
                peers: _,
                relays: _,
            } = ev
            {
                rung = Some((kind, video));
            }
        }
        let kind = match p2p {
            true => CallKind::P2p,
            false => CallKind::Rtc,
        };
        assert_eq!(
            rung,
            Some((kind, video)),
            "the ringing state names the call type"
        );
        state.hub.call_end("alice", dm).await.expect("end");
        let id: i64 = sqlx::query("SELECT MAX(id) FROM messages WHERE kind = 'call'")
            .fetch_one(db)
            .await
            .expect("log")
            .get(0);
        let call = load_message(db, id, Quotes::Skip)
            .await
            .expect("load")
            .expect("row")
            .call
            .expect("call log");
        logs.push((call.p2p, call.video));
    }
    assert_eq!(
        logs,
        [
            (Some(false), Some(false)),
            (Some(true), Some(true)),
            (Some(false), Some(true)),
        ]
    );
    exec(
        db,
        "INSERT INTO messages(dm_id, author, content, kind, created_at) VALUES(1, 'alice', '', 'call', 1)",
    )
    .await;
    let old: i64 = sqlx::query("SELECT MAX(id) FROM messages")
        .fetch_one(db)
        .await
        .expect("old")
        .get(0);
    let call = load_message(db, old, Quotes::Skip)
        .await
        .expect("load")
        .expect("row")
        .call
        .expect("call log");
    assert_eq!(
        (call.p2p, call.video),
        (None, None),
        "older logs stay unknown"
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn voice_hops_are_paced_per_account_and_the_last_wins() {
    let (state, path) = crate::api::test_util::temp_state("ws_voice_pace").await;
    add_user_row(&state.db, "bob").await;
    crate::api::test_util::add_member(&state.db, "rchat", "bob", 0, 0, 0).await;
    let a = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'a', 'voice', 0) RETURNING id").await;
    let b = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'b', 'voice', 0) RETURNING id").await;
    let mut rx = state.hub.subscribe();
    let mut tabs: Vec<VoiceWait> = (0..20).map(|_| VoiceWait::default()).collect();
    let now = Instant::now();
    let at = now.into_std();
    let mut ran = 0;
    for n in 0..100 {
        let channel_id = if n % 2 == 0 { a } else { b };
        let msg = ClientMsg::VoiceJoin { channel_id };
        if let Some(msg) = tabs[n % 20].offer(msg, || state.hub.voice_ok_at("bob", at), now) {
            voice_msg(&state, "bob", 1, msg).await.expect("join");
            ran += 1;
        }
    }
    assert_eq!(ran, crate::hub::VOICE_BURST);
    let mut states = 0;
    while let Ok(ev) = rx.try_recv() {
        if matches!(ev, WsEvent::VoiceState { .. }) {
            states += 1;
        }
    }
    assert!(states <= 2 * ran as usize, "{states} voice states");
    assert!(matches!(tabs[0].wanted, Some(ClientMsg::VoiceJoin { channel_id }) if channel_id == a));
    tabs[0].offer(ClientMsg::VoiceLeave, || true, now);
    assert!(
        matches!(tabs[0].wanted, Some(ClientMsg::VoiceLeave)),
        "the latest replaces a waiting join"
    );
    assert!(
        tabs[1]
            .fire(|| state.hub.voice_ok_at("bob", at), now)
            .is_none()
    );
    assert!(tabs[1].due.is_some());
    let later = now + VOICE_EVERY * 2;
    assert!(matches!(
        tabs[1].fire(|| state.hub.voice_ok_at("bob", later.into_std()), later),
        Some(ClientMsg::VoiceJoin { channel_id }) if channel_id == b
    ));
    assert!(
        state.hub.voice_ok("carol"),
        "other accounts keep their own pace"
    );
    crate::api::test_util::done(state, path).await;
}

async fn message_seq(db: &Db) -> i64 {
    sqlx::query("SELECT seq FROM sqlite_sequence WHERE name = 'messages'")
        .fetch_optional(db)
        .await
        .expect("seq")
        .map_or(0, |r| r.try_get(0).expect("seq"))
}

#[tokio::test]
async fn refused_call_starts_write_nothing_and_are_paced() {
    let (state, path) = crate::api::test_util::temp_state("ws_call_pace").await;
    let db = &state.db;
    for name in ["alice", "bob", "carol", "dave", "erin"] {
        add_user_row(db, name).await;
    }
    let ab = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let ac = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id",
    )
    .await;
    let de = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('dave', 'erin') RETURNING id",
    )
    .await;
    let start = |dm_id| ClientMsg::CallStart {
        dm_id,
        p2p: false,
        video: false,
        peer_id: None,
        relays: Vec::new(),
    };
    voice_msg(&state, "alice", 1, start(ab))
        .await
        .expect("call");
    let before = message_seq(db).await;
    let mut errs = Vec::new();
    for _ in 0..100 {
        errs.push(
            voice_msg(&state, "alice", 1, start(ac))
                .await
                .expect_err("refused"),
        );
    }
    assert_eq!(
        voice_msg(&state, "carol", 2, start(ac)).await,
        Err(s("alice is already in a call").into())
    );
    assert_eq!(
        message_seq(db).await,
        before,
        "refused calls write no log row"
    );
    assert!(
        errs[..3]
            .iter()
            .all(|e| e.message == "You are already in a call"),
        "{errs:?}"
    );
    assert!(
        errs[3..].iter().all(|e| e.message == CALLING_TOO_OFTEN),
        "{errs:?}"
    );
    for _ in 0..crate::hub::DM_CALL_BURST {
        voice_msg(&state, "dave", 3, start(de)).await.expect("call");
        voice_msg(&state, "dave", 3, ClientMsg::CallLeave { dm_id: de })
            .await
            .expect("leave");
    }
    assert_eq!(
        voice_msg(&state, "dave", 3, start(de)).await,
        Err(s(CALLING_TOO_OFTEN).into()),
        "ringing the same DM over and over is paced"
    );
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn signals_are_capped_in_size_and_bytes_per_account() {
    let (state, path) = crate::api::test_util::temp_state("ws_signal_pace").await;
    for name in ["alice", "bob"] {
        add_user_row(&state.db, name).await;
        crate::api::test_util::add_member(&state.db, "rchat", name, 0, 0, 0).await;
    }
    let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    for name in ["alice", "bob"] {
        voice_msg(&state, name, 1, ClientMsg::VoiceJoin { channel_id: cid })
            .await
            .expect("join");
    }
    let signal = |to: &str, size: usize| ClientMsg::RtcSignal {
        to: to.to_string(),
        channel_id: Some(cid),
        dm_id: None,
        payload: serde_json::json!({ "sdp": "x".repeat(size) }),
    };
    assert_eq!(
        voice_msg(&state, "alice", 1, signal("bob", 24 * 1024)).await,
        Err(s("Signal too large").into())
    );
    let mut sent = 0;
    for _ in 0..100 {
        if voice_msg(&state, "alice", 1, signal("bob", 15 * 1024))
            .await
            .is_ok()
        {
            sent += 1;
        }
    }
    let each = 15 * 1024 + 10;
    let burst = state.hub.signal_burst() / each;
    assert!(
        (burst..=burst + 1).contains(&sent),
        "{sent} signals passed (the budget refills while they are sent)"
    );
    voice_msg(&state, "bob", 1, signal("alice", 4 * 1024))
        .await
        .expect("the other account signals as usual");
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn a_full_voice_room_can_be_negotiated_twice_at_once() {
    let (state, path) = crate::api::test_util::temp_state("ws_signal_room").await;
    for name in ["alice", "bob"] {
        add_user_row(&state.db, name).await;
        crate::api::test_util::add_member(&state.db, "rchat", name, 0, 0, 0).await;
    }
    let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    for name in ["alice", "bob"] {
        voice_msg(&state, name, 1, ClientMsg::VoiceJoin { channel_id: cid })
            .await
            .expect("join");
    }
    for n in 0..2 * (state.limits.voice_room_max - 1) {
        let offer = ClientMsg::RtcSignal {
            to: s("bob"),
            channel_id: Some(cid),
            dm_id: None,
            payload: serde_json::json!({ "sdp": "x".repeat(11 * 1024) }),
        };
        assert_eq!(
            voice_msg(&state, "alice", 1, offer).await,
            Ok(()),
            "offer {n}"
        );
    }
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn answering_a_call_is_paced_apart_from_voice_hops() {
    let (state, path) = crate::api::test_util::temp_state("ws_accept_pace").await;
    let db = &state.db;
    for name in ["alice", "bob"] {
        add_user_row(db, name).await;
    }
    let ab = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let start = ClientMsg::CallStart {
        dm_id: ab,
        p2p: false,
        video: false,
        peer_id: None,
        relays: Vec::new(),
    };
    voice_msg(&state, "alice", 1, start).await.expect("call");
    while state.hub.voice_ok("bob") {}
    let accept = ClientMsg::CallAccept {
        dm_id: ab,
        peer_id: None,
        relays: Vec::new(),
    };
    assert_eq!(voice_msg(&state, "bob", 2, accept).await, Ok(()));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn in_voice_is_true_only_in_that_room() {
    let (state, path) = crate::api::test_util::temp_state("in_voice").await;
    state.hub.voice_join("bob", 1, "club", 7).await;
    assert!(in_voice(&state, "club", 7, "bob"));
    assert!(!in_voice(&state, "club", 8, "bob"));
    assert!(!in_voice(&state, "other", 7, "bob"));
    assert!(!in_voice(&state, "club", 7, "eve"));
    state.hub.voice_leave("bob").await;
    assert!(!in_voice(&state, "club", 7, "bob"));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn in_call_is_true_only_for_joined_participants() {
    let (state, path) = crate::api::test_util::temp_state("in_call").await;
    let pair = vec![s("a"), s("b")];
    state
        .hub
        .call_start("a", 1, 3, pair, CallKind::Rtc, false, 1, None)
        .await
        .expect("start");
    assert!(!in_call(&state, 3, "a"));
    assert!(!in_call(&state, 3, "b"));
    state
        .hub
        .call_accept("b", 2, 3, None)
        .await
        .expect("accept");
    assert!(in_call(&state, 3, "a"));
    assert!(in_call(&state, 3, "b"));
    assert!(!in_call(&state, 4, "a"));
    assert!(!in_call(&state, 3, "eve"));
    state.hub.call_end("b", 3).await.expect("leave");
    assert!(!in_call(&state, 3, "a"));
    assert!(!in_call(&state, 3, "b"));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn in_call_is_false_in_p2p_calls() {
    let (state, path) = crate::api::test_util::temp_state("in_call_p2p").await;
    let pair = vec![s("a"), s("b")];
    state
        .hub
        .call_start("a", 1, 3, pair, CallKind::P2p, false, 1, None)
        .await
        .expect("start");
    state
        .hub
        .call_accept("b", 2, 3, None)
        .await
        .expect("accept");
    assert!(!state.hub.rtc_shared("a", "b", None, Some(3)));
    assert!(!in_call(&state, 3, "a"));
    assert!(!in_call(&state, 3, "b"));
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn call_errors_never_carry_database_text() {
    let (state, path) = crate::api::test_util::temp_state("call_db_errors").await;
    for name in ["alice", "bob"] {
        add_user_row(&state.db, name).await;
    }
    let dm = insert_id(
        &state.db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let cid = insert_id(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    let url = format!("sqlite://{}?mode=rwc", path.display());
    let starved = sqlx::any::AnyPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect(&url)
        .await
        .expect("starved pool");
    let held = starved.acquire().await.expect("the only connection");
    let busy = state.clone().with_reader(starved.clone());
    let start = ClientMsg::CallStart {
        dm_id: dm,
        p2p: false,
        video: false,
        peer_id: None,
        relays: Vec::new(),
    };
    let join = ClientMsg::VoiceJoin { channel_id: cid };
    for msg in [start, join] {
        let refused = voice_msg(&busy, "alice", 1, msg).await.expect_err("busy");
        assert_eq!(refused.message, crate::api::SERVER_BUSY);
        assert_eq!(
            refused.reason.map(|r| r.kind),
            Some(crate::api::ReasonKind::Unavailable)
        );
    }
    drop(held);
    starved.close().await;
    crate::api::test_util::done(state, path).await;
}

fn off(control: &'static str, message: &str) -> crate::ws::protocol::Refused {
    crate::ws::protocol::Refused {
        message: message.to_string(),
        reason: Some(crate::api::Reason {
            kind: crate::api::ReasonKind::OffSite,
            control: Some(control.to_string()),
            retry_after: None,
            field: None,
        }),
    }
}

const CALLS_OFF: &str = "Calls are turned off on this site";
const P2P_OFF: &str = "P2P is turned off on this site";

fn rtc_call(dm_id: i64, p2p: bool) -> ClientMsg {
    ClientMsg::CallStart {
        dm_id,
        p2p,
        video: false,
        peer_id: None,
        relays: Vec::new(),
    }
}

fn accept(dm_id: i64) -> ClientMsg {
    ClientMsg::CallAccept {
        dm_id,
        peer_id: None,
        relays: Vec::new(),
    }
}

#[tokio::test]
async fn the_calls_switch_refuses_voice_and_calls_with_its_reason() {
    let (state, path) = crate::api::test_util::temp_state("calls_switch").await;
    let db = &state.db;
    for name in ["alice", "bob", "carol", "dave"] {
        add_user_row(db, name).await;
    }
    crate::db::NewUser::plain("root")
        .hash("x")
        .admin(true)
        .add(db)
        .await;
    for name in ["alice", "bob", "root"] {
        crate::api::test_util::add_member(db, "rchat", name, 0, 0, 0).await;
    }
    let cid = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let other = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('carol', 'dave') RETURNING id",
    )
    .await;
    let join = |user: &'static str, channel_id| {
        voice_msg(&state, user, 1, ClientMsg::VoiceJoin { channel_id })
    };
    let guest = guest_at(&["rchat"], &[]);

    join("alice", cid).await.expect("calls are on");
    voice_msg(&state, "alice", 1, ClientMsg::VoiceLeave)
        .await
        .expect("leave");
    as_guest(&state, &guest, ClientMsg::VoiceJoin { channel_id: cid })
        .await
        .expect("a guest joins too");
    as_guest(&state, &guest, ClientMsg::VoiceLeave)
        .await
        .expect("leave");

    voice_msg(&state, "alice", 1, rtc_call(dm, false))
        .await
        .expect("a call rings while calls are on");
    let mut rx = state.hub.subscribe();
    site_sets(&state, serde_json::json!({"calls": false})).await;
    let event = serde_json::to_value(rx.try_recv().expect("settings_changed")).expect("json");
    assert_eq!(event["settings"]["calls"], serde_json::json!(false));
    let older: crate::api::Settings = serde_json::from_value(serde_json::json!({
        "profanity_filter": true,
        "asset_previews": true,
        "asset_uploads": true,
        "guests_enabled": true,
    }))
    .expect("a copy from before the switch");
    assert!(older.calls);
    let calls_off = || Err(off("calls", CALLS_OFF));
    for (who, channel) in [
        ("alice", cid),
        ("carol", cid),
        ("root", cid),
        ("alice", cid + 500),
        ("nobody", cid),
    ] {
        assert_eq!(
            join(who, channel).await,
            calls_off(),
            "{who} at {channel}: a member, a non-member, the site admin and an unknown channel answer alike"
        );
    }
    assert_eq!(
        as_guest(&state, &guest, ClientMsg::VoiceJoin { channel_id: cid }).await,
        calls_off(),
        "a guest gets the same answer"
    );
    assert!(state.hub.rooms_in("rchat", None).is_empty());
    for (who, dm_id) in [("alice", dm), ("carol", dm), ("alice", dm + 500)] {
        assert_eq!(
            voice_msg(&state, who, 1, rtc_call(dm_id, false)).await,
            calls_off(),
            "{who} starts in {dm_id}: a DM of theirs, someone else's and none answer alike"
        );
    }
    assert_eq!(
        insert_id(db, "SELECT COUNT(*) FROM messages WHERE kind = 'call'").await,
        1,
        "only the call from before the switch has a log"
    );
    assert_eq!(
        voice_msg(&state, "bob", 2, accept(dm)).await,
        calls_off(),
        "the call that was ringing can't be answered"
    );
    for (who, dm_id) in [("carol", dm), ("alice", dm + 500)] {
        assert_eq!(
            voice_msg(&state, who, 1, accept(dm_id))
                .await
                .expect_err("not theirs")
                .reason,
            None,
            "{who} in {dm_id}: nothing about a DM that isn't theirs"
        );
    }
    voice_msg(&state, "bob", 2, ClientMsg::CallDecline { dm_id: dm })
        .await
        .expect("declining is never refused");
    voice_msg(&state, "alice", 1, ClientMsg::VoiceLeave)
        .await
        .expect("leaving is never refused");
    assert_eq!(
        insert_id(db, "SELECT COUNT(*) FROM channels WHERE kind = 'voice'").await,
        1,
        "voice channels stay"
    );

    voice_msg(&state, "carol", 3, rtc_call(other, true))
        .await
        .expect("P2P calls follow P2P, which is on");
    voice_msg(&state, "dave", 4, accept(other))
        .await
        .expect("and so does accepting one");
    voice_msg(&state, "dave", 4, ClientMsg::CallLeave { dm_id: other })
        .await
        .expect("leave");
    site_sets(&state, serde_json::json!({"p2p": false, "calls": true})).await;
    assert_eq!(
        voice_msg(&state, "carol", 3, rtc_call(other, true)).await,
        Err(off("p2p", P2P_OFF))
    );
    assert_eq!(
        voice_msg(&state, "carol", 3, rtc_call(other + 500, true)).await,
        Err(off("p2p", P2P_OFF))
    );
    voice_msg(&state, "bob", 2, rtc_call(dm, false))
        .await
        .expect("a call through the instance");
    voice_msg(&state, "bob", 2, ClientMsg::CallLeave { dm_id: dm })
        .await
        .expect("leave");
    join("alice", cid).await.expect("calls are on again");
    crate::api::test_util::done(state, path).await;
}

#[tokio::test]
async fn turning_calls_off_ends_running_calls() {
    let (state, path) = crate::api::test_util::temp_state("calls_end").await;
    let db = &state.db;
    for name in ["alice", "bob", "carol", "dave", "erin"] {
        add_user_row(db, name).await;
    }
    crate::api::test_util::add_member(db, "rchat", "erin", 0, 0, 0).await;
    crate::api::test_util::add_member(db, "rchat", "alice", 0, 0, 0).await;
    let cid = insert_id(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
    let dm = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
    )
    .await;
    let p2p = insert_id(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('carol', 'dave') RETURNING id",
    )
    .await;
    let follow = crate::api::Settings::follow(&state);
    voice_msg(&state, "erin", 5, ClientMsg::VoiceJoin { channel_id: cid })
        .await
        .expect("erin joins voice");
    voice_msg(&state, "alice", 1, rtc_call(dm, false))
        .await
        .expect("start");
    voice_msg(&state, "bob", 2, accept(dm))
        .await
        .expect("accept");
    voice_msg(&state, "carol", 3, rtc_call(p2p, true))
        .await
        .expect("a P2P call rings");
    assert!(in_call(&state, dm, "alice") && in_voice(&state, "rchat", cid, "erin"));

    let mut rx = state.hub.subscribe();
    site_sets(&state, serde_json::json!({"calls": false})).await;
    within_5s("the voice room and the call end", || {
        state.hub.rooms_in("rchat", None).is_empty() && state.hub.call_kind(dm).is_none()
    })
    .await;
    assert_eq!(
        state.hub.call_kind(p2p),
        Some(crate::ws::CallKind::P2p),
        "a P2P call follows P2P"
    );
    let mut seen = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        match ev {
            WsEvent::VoiceEnded {
                server: _,
                channel_id,
                dm_id: _,
                dm_users,
                reason,
            } => seen.push(format!("voice {channel_id:?} {dm_users:?} {reason}")),
            WsEvent::CallState {
                dm_id,
                dm_users: _,
                state: crate::ws::CallPhase::Ended,
                from: _,
                kind: _,
                video: _,
                call_id: _,
                answered_at: _,
                peers: _,
                relays: _,
            } => seen.push(format!("call {dm_id} ended")),
            _ => {}
        }
    }
    assert_eq!(
        seen,
        [
            format!("voice Some({cid}) Some([\"erin\"]) Calls were turned off"),
            format!("call {dm} ended"),
        ]
    );
    let until = Instant::now() + std::time::Duration::from_secs(5);
    let outcome: String = loop {
        let row = sqlx::query(
            "SELECT call_outcome FROM messages WHERE kind = 'call' AND dm_id = $1 AND call_ended_at IS NOT NULL",
        )
        .bind(dm)
        .fetch_optional(db)
        .await
        .expect("the call's log");
        match row {
            Some(row) => break row.try_get(0).expect("outcome"),
            None => {
                assert!(
                    Instant::now() < until,
                    "the call log closes within 5 seconds"
                );
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }
    };
    assert_eq!(outcome, "completed");

    site_sets(&state, serde_json::json!({"p2p": false})).await;
    within_5s("the P2P call ends", || state.hub.call_kind(p2p).is_none()).await;
    follow.abort();
    crate::api::test_util::done(state, path).await;
}
