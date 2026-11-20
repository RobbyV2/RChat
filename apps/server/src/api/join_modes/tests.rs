use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sqlx::Row;

use super::*;
use crate::api::access::{DENIED, PASSWORD_REQUIRED, Proof, resolve_server};
use crate::api::passwords::create_password;
use crate::api::servers::{
    create_server, get_invite, get_server, search_servers, server_available, update_server,
};
use crate::api::test_util::{add_member, done, mem_user, temp_state};
use crate::api::{ApiError, Authed, MaybeAuthed, Reason, ReasonKind, ServerDetail};
use crate::db::{Db, NO_PERMANENT_HASH, User};
use crate::state::AppState;

#[test]
fn modes_read_from_the_hash_first() {
    assert_eq!(join_mode_of(None, None), Some(JoinMode::Name));
    assert_eq!(join_mode_of(Some("invite"), None), Some(JoinMode::Name));
    assert_eq!(join_mode_of(None, Some("hash")), Some(JoinMode::Password));
    assert_eq!(
        join_mode_of(Some("closed"), Some("hash")),
        Some(JoinMode::Password)
    );
    assert_eq!(
        join_mode_of(Some("invite"), Some(NO_PERMANENT_HASH)),
        Some(JoinMode::Invite)
    );
    assert_eq!(
        join_mode_of(Some("closed"), Some(NO_PERMANENT_HASH)),
        Some(JoinMode::Closed)
    );
    for stored in [None, Some("name"), Some("password"), Some("other")] {
        assert_eq!(join_mode_of(stored, Some(NO_PERMANENT_HASH)), None);
    }
    assert_eq!(legacy_mode(true), JoinMode::Invite);
    assert_eq!(legacy_mode(false), JoinMode::Closed);
}

#[test]
fn modes_round_trip_their_words() {
    for mode in [
        JoinMode::Name,
        JoinMode::Invite,
        JoinMode::Password,
        JoinMode::Closed,
    ] {
        assert_eq!(JoinMode::parse(mode.as_str()), Some(mode));
        assert_eq!(
            serde_json::to_value(mode).expect("json"),
            json!(mode.as_str())
        );
        assert_eq!(
            mode.hash(None).as_deref() == Some(NO_PERMANENT_HASH),
            !mode.by_name()
        );
    }
    assert_eq!(JoinMode::parse("Name"), None);
}

#[test]
fn only_explicit_invite_and_closed_servers_keep_their_key() {
    assert!(keeps_key(true, None, JoinMode::Name));
    assert!(keeps_key(false, Some(JoinMode::Invite), JoinMode::Invite));
    assert!(keeps_key(false, Some(JoinMode::Closed), JoinMode::Closed));
    assert!(!keeps_key(false, None, JoinMode::Invite));
    assert!(!keeps_key(false, None, JoinMode::Closed));
    assert!(!keeps_key(false, Some(JoinMode::Invite), JoinMode::Name));
    assert!(!keeps_key(false, Some(JoinMode::Name), JoinMode::Name));
    assert!(!keeps_key(
        false,
        Some(JoinMode::Password),
        JoinMode::Password
    ));
}

#[test]
fn random_text_uses_the_alphabet_evenly() {
    let mut seen = [0usize; 31];
    for _ in 0..2000 {
        let text = random_text(KEY_LEN);
        assert_eq!(text.len(), KEY_LEN);
        for b in text.bytes() {
            let at = ALPHABET
                .iter()
                .position(|a| *a == b)
                .expect("in the alphabet");
            seen[at] += 1;
        }
    }
    assert!(seen.iter().all(|n| (450..=850).contains(n)), "{seen:?}");
    assert!(!ALPHABET.iter().any(|b| b"01ilo".contains(b)));
}

pub(crate) async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .expect(sql);
}

pub(crate) async fn set_control(db: &Db, key: &str, value: &str) {
    exec(db, &format!("INSERT INTO settings(key, value) VALUES('{key}', '{value}') ON CONFLICT(key) DO UPDATE SET value = excluded.value")).await;
    crate::api::Settings::forget(db);
}

async fn text(db: &Db, sql: &str) -> Option<String> {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_optional(db)
        .await
        .expect(sql)
        .and_then(|r| r.try_get(0).expect("value"))
}

async fn number(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("number")
}

pub(crate) async fn create_as(
    state: &AppState,
    who: &str,
    body: Value,
) -> Result<ServerDetail, ApiError> {
    create_server(
        State(state.clone()),
        Authed(mem_user(who, false)),
        Json(serde_json::from_value(body).expect("create body")),
    )
    .await
    .map(|Json(created)| created.server)
}

pub(crate) async fn patch_as(
    state: &AppState,
    who: &str,
    server: &str,
    body: Value,
) -> Result<crate::api::ServerSummaryLite, ApiError> {
    update_server(
        State(state.clone()),
        Authed(mem_user(who, false)),
        Path(server.to_string()),
        Json(serde_json::from_value(body).expect("patch body")),
    )
    .await
    .map(|Json(updated)| updated.server)
}

pub(crate) async fn add_password(
    state: &AppState,
    server: &str,
    body: Value,
) -> Result<String, ApiError> {
    create_password(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(server.to_string()),
        Json(serde_json::from_value(body).expect("password body")),
    )
    .await
    .map(|Json(made)| made.password)
}

pub(crate) async fn mode_of(db: &Db, key: &str) -> JoinMode {
    resolve_server(db, key, Some(&mem_user("root", true)), &Proof::none())
        .await
        .expect("the staff view")
        .lite()
        .join_mode
}

fn invalid(text: &str, field: &str) -> (StatusCode, String, Option<Reason>) {
    (
        StatusCode::BAD_REQUEST,
        text.to_string(),
        Some(Reason {
            kind: ReasonKind::Invalid,
            control: None,
            retry_after: None,
            field: Some(field.to_string()),
        }),
    )
}

fn off_site(status: StatusCode, text: &str, control: &str) -> (StatusCode, String, Option<Reason>) {
    (
        status,
        text.to_string(),
        Some(Reason {
            kind: ReasonKind::OffSite,
            control: Some(control.to_string()),
            retry_after: None,
            field: None,
        }),
    )
}

fn refusal<T>(res: Result<T, ApiError>) -> (StatusCode, String, Option<Reason>) {
    match res {
        Ok(_) => panic!("expected a refusal"),
        Err(ApiError(status, text, reason)) => (status, text, reason),
    }
}

fn random_key(key: &str, name: &str) {
    assert_eq!(key.len(), KEY_LEN, "{key}");
    assert!(key.bytes().all(|b| ALPHABET.contains(&b)), "{key}");
    assert_ne!(key, name.to_lowercase());
}

#[tokio::test]
async fn old_clients_get_todays_servers() {
    let (state, path) = temp_state("join_modes_old_clients").await;
    let db = &state.db;
    let club = create_as(&state, "alice", json!({"name": "Club"}))
        .await
        .expect("a name alone");
    assert_eq!((club.name.as_str(), club.has_password), ("club", false));
    assert_eq!((club.join_mode, club.listed), (JoinMode::Name, true));
    let vault = create_as(
        &state,
        "alice",
        json!({"name": "Vault", "password": "long enough"}),
    )
    .await
    .expect("a name and a password");
    assert_eq!((vault.name.as_str(), vault.has_password), ("vault", true));
    assert_eq!(vault.join_mode, JoinMode::Password);
    assert_eq!(
        text(db, "SELECT join_mode FROM servers WHERE name = 'club'")
            .await
            .as_deref(),
        Some("name"),
        "new servers store their mode"
    );
    assert_eq!(
        text(db, "SELECT join_mode FROM servers WHERE name = 'vault'")
            .await
            .as_deref(),
        Some("password")
    );
    assert_eq!(
        number(db, "SELECT COUNT(*) FROM channels WHERE server = 'club'").await,
        1,
        "one text channel, as before"
    );
    assert_eq!(
        number(
            db,
            "SELECT join_messages + leave_messages FROM servers WHERE name = 'club'"
        )
        .await,
        2
    );
    done(state, path).await;
}

#[tokio::test]
async fn invite_and_closed_servers_get_a_random_key_and_may_share_a_name() {
    let (state, path) = temp_state("join_modes_random_keys").await;
    let state = crate::api::rare::tests::unlimited(state);
    let db = &state.db;
    let mut keys = Vec::new();
    for mode in ["invite", "closed", "invite"] {
        let made = create_as(&state, "alice", json!({"name": "Pixel Club", "join": mode}))
            .await
            .expect(mode);
        random_key(&made.name, "Pixel Club");
        assert_eq!(made.display_name, "Pixel Club");
        assert!(
            made.has_password,
            "{mode}: older copies see a protected server"
        );
        assert_eq!(made.join_mode.as_str(), mode);
        assert_eq!(
            text(
                db,
                &format!(
                    "SELECT password_hash FROM servers WHERE name = '{}'",
                    made.name
                )
            )
            .await
            .as_deref(),
            Some(NO_PERMANENT_HASH)
        );
        keys.push(made.name);
    }
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), 3, "each its own key");
    let available = server_available(
        State(state.clone()),
        Authed(mem_user("bob", false)),
        Path("Pixel Club".to_string()),
    )
    .await
    .expect("available")
    .0;
    assert_eq!(
        serde_json::to_value(available).expect("json"),
        json!({"available": true}),
        "the name of an invite server says nothing"
    );
    let named = create_as(&state, "alice", json!({"name": "Pixel Club"}))
        .await
        .expect("the name is still free for a name server");
    assert_eq!(named.name, "pixel club");
    for body in [
        json!({"name": "Pixel Club"}),
        json!({"name": "pixel club", "join": "password", "password": "long enough"}),
    ] {
        assert_eq!(
            refusal(create_as(&state, "alice", body).await).1,
            "Server name is taken",
            "servers found by name keep unique names"
        );
    }
    done(state, path).await;
}

#[tokio::test]
async fn create_options_are_checked_and_stored() {
    let (state, path) = temp_state("join_modes_options").await;
    let state = crate::api::rare::tests::unlimited(state);
    let db = &state.db;
    for (body, want) in [
        (
            json!({"name": "A", "join": "password"}),
            invalid("A password needs 8 characters", "password"),
        ),
        (
            json!({"name": "A", "join": "password", "password": "  "}),
            invalid("A password needs 8 characters", "password"),
        ),
        (
            json!({"name": "A", "join": "invite", "password": "long enough"}),
            invalid("Pick one way to join", "join"),
        ),
        (
            json!({"name": "A", "join": "name", "password": "long enough"}),
            invalid("Pick one way to join", "join"),
        ),
        (
            json!({"name": "A", "join": "closed", "listed": true}),
            invalid("Listed is only for servers people join by name", "listed"),
        ),
        (
            json!({"name": "A", "upload_expiry": {"mode": "custom", "seconds": 5}}),
            invalid("Choose a time from 1 hour to 365 days", "upload_expiry"),
        ),
    ] {
        assert_eq!(
            refusal(create_as(&state, "alice", body.clone()).await),
            want,
            "{body}"
        );
    }
    assert_eq!(
        number(db, "SELECT COUNT(*) FROM servers WHERE display_name = 'A'").await,
        0,
        "nothing was made"
    );

    let made = create_as(
        &state,
        "alice",
        json!({"name": "Den", "listed": false, "public_read": false, "channels": "text_voice", "notices": false, "upload_expiry": {"mode": "custom", "seconds": 172800}}),
    )
    .await
    .expect("every option");
    assert_eq!(made.join_mode, JoinMode::Name);
    assert!(!made.listed);
    assert_eq!(made.public_read, Some(false));
    let mut channels: Vec<(String, String)> = made
        .channels
        .iter()
        .map(|c| {
            (
                c.name.clone(),
                serde_json::to_value(c.kind)
                    .expect("kind")
                    .as_str()
                    .expect("word")
                    .to_string(),
            )
        })
        .collect();
    channels.sort();
    assert_eq!(
        channels,
        [
            ("Voice".to_string(), "voice".to_string()),
            ("general".to_string(), "text".to_string())
        ]
    );
    assert_eq!(
        number(
            db,
            "SELECT join_messages + leave_messages FROM servers WHERE name = 'den'"
        )
        .await,
        0
    );
    assert_eq!(
        number(db, "SELECT upload_expiry FROM servers WHERE name = 'den'").await,
        172800
    );
    assert_eq!(
        text(
            db,
            "SELECT upload_expiry_by FROM servers WHERE name = 'den'"
        )
        .await
        .as_deref(),
        Some("alice"),
        "a longer time is charged to whoever chose it"
    );

    set_control(db, "public_reading", "0").await;
    assert_eq!(
        refusal(create_as(&state, "alice", json!({"name": "B", "public_read": true})).await),
        off_site(
            StatusCode::FORBIDDEN,
            "Public reading is turned off on this site",
            "public_reading"
        )
    );
    set_control(db, "public_reading", "1").await;

    set_control(db, "server_joining", "invites").await;
    assert_eq!(
        refusal(create_as(&state, "alice", json!({"name": "B", "join": "name"})).await),
        off_site(
            StatusCode::BAD_REQUEST,
            "This instance needs invites to join. Pick invite or password.",
            "server_joining"
        )
    );
    let old = create_as(&state, "alice", json!({"name": "B"}))
        .await
        .expect("an old client still makes today's server");
    assert_eq!(old.join_mode, JoinMode::Name);
    let invite = create_as(
        &state,
        "alice",
        json!({"name": "C", "join": "invite", "public_read": true}),
    )
    .await
    .expect("an invite server");
    assert_eq!(invite.public_read, Some(true));
    done(state, path).await;
}

async fn viewer_answers(state: &AppState, key: &str, viewer: Option<User>) -> Vec<String> {
    let server = get_server(
        State(state.clone()),
        MaybeAuthed(viewer.clone()),
        HeaderMap::new(),
        Path(key.to_string()),
    )
    .await;
    let invite = get_invite(
        State(state.clone()),
        MaybeAuthed(viewer.clone()),
        HeaderMap::new(),
        Path(key.to_string()),
        Query(crate::api::servers::InvitePreviewQuery::default()),
    )
    .await;
    let mut out = Vec::new();
    for answer in [server.map(|_| ()), invite.map(|_| ())] {
        out.push(match answer {
            Ok(()) => "open".to_string(),
            Err(ApiError(status, text, reason)) => format!("{status} {text} {reason:?}"),
        });
    }
    out
}

#[tokio::test]
async fn only_name_servers_open_to_people_who_are_not_members() {
    let (state, path) = temp_state("join_modes_visibility").await;
    let state = crate::api::rare::tests::unlimited(state);
    let db = &state.db;
    let mut keys = Vec::new();
    for body in [
        json!({"name": "Open"}),
        json!({"name": "Links", "join": "invite"}),
        json!({"name": "Secret", "join": "password", "password": "long enough"}),
        json!({"name": "Shut", "join": "closed"}),
    ] {
        keys.push(create_as(&state, "alice", body).await.expect("made").name);
    }
    exec(
        db,
        "INSERT INTO settings(key, value) VALUES('guests_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
    )
    .await;
    crate::api::Settings::forget(db);
    for viewer in [Some(mem_user("bob", false)), None] {
        assert_eq!(
            viewer_answers(&state, &keys[0], viewer.clone()).await,
            ["open", "open"],
            "{:?}",
            viewer.as_ref().map(|u| &u.username)
        );
        let unknown = viewer_answers(&state, "no-such-server", viewer.clone()).await;
        assert_eq!(
            unknown,
            [
                format!("404 Not Found {DENIED} None"),
                format!("401 Unauthorized {PASSWORD_REQUIRED} None")
            ]
        );
        for key in &keys[1..] {
            assert_eq!(
                viewer_answers(&state, key, viewer.clone()).await,
                unknown,
                "{key}: the same answers as for a server that doesn't exist"
            );
        }
    }
    add_member(db, &keys[1], "bob", 0, 0, 1).await;
    assert_eq!(
        viewer_answers(&state, &keys[1], Some(mem_user("bob", false))).await,
        ["open", "open"],
        "members open it"
    );
    done(state, path).await;
}

async fn found(state: &AppState, who: Option<&str>, q: &str) -> Vec<String> {
    search_servers(
        State(state.clone()),
        MaybeAuthed(who.map(|w| mem_user(w, false))),
        Query(serde_json::from_value(json!({ "q": q })).expect("query")),
    )
    .await
    .expect("search")
    .0
    .into_iter()
    .map(|m| m.name)
    .collect()
}

#[tokio::test]
async fn search_lists_servers_people_find_by_name_unless_they_are_unlisted() {
    let (state, path) = temp_state("join_modes_search").await;
    let state = crate::api::rare::tests::unlimited(state);
    let db = &state.db;
    let open = create_as(&state, "alice", json!({"name": "Pix open"}))
        .await
        .expect("open");
    let hidden = create_as(
        &state,
        "alice",
        json!({"name": "Pix hidden", "listed": false}),
    )
    .await
    .expect("unlisted");
    let reading = create_as(
        &state,
        "alice",
        json!({"name": "Pix vault", "password": "long enough", "public_read": true}),
    )
    .await
    .expect("a readable password server");
    let links = create_as(
        &state,
        "alice",
        json!({"name": "Pix links", "join": "invite", "public_read": true}),
    )
    .await
    .expect("a readable invite server");
    exec(db, "INSERT INTO servers(name, display_name, password_hash, public_read, created_at) VALUES('pix old', 'Pix old', '!none', 1, 1)").await;
    let mut want = vec![open.name.clone(), reading.name.clone()];
    want.sort();
    assert_eq!(found(&state, Some("bob"), "pix").await, want);
    assert_eq!(found(&state, None, "pix").await, want, "guests too");
    add_member(db, &hidden.name, "carol", 0, 0, 1).await;
    add_member(db, &links.name, "carol", 0, 0, 1).await;
    let mut mine = vec![
        open.name.clone(),
        hidden.name.clone(),
        reading.name.clone(),
        links.name.clone(),
    ];
    mine.sort();
    assert_eq!(
        found(&state, Some("carol"), "pix").await,
        mine,
        "members find their own servers"
    );
    patch_as(&state, "alice", &hidden.name, json!({"listed": true}))
        .await
        .expect("listed again");
    patch_as(&state, "alice", &open.name, json!({"listed": false}))
        .await
        .expect("unlisted");
    let mut want = vec![hidden.name.clone(), reading.name.clone()];
    want.sort();
    assert_eq!(found(&state, Some("dave"), "pix").await, want);
    assert_eq!(
        refusal(patch_as(&state, "alice", &links.name, json!({"listed": true})).await),
        invalid("Listed is only for servers people join by name", "listed")
    );
    done(state, path).await;
}

#[tokio::test]
async fn servers_from_before_join_modes_read_their_mode_from_the_password() {
    let (state, path) = temp_state("join_modes_legacy").await;
    let db = &state.db;
    for stmt in [
        "INSERT INTO servers(name, display_name, created_at) VALUES('pub', 'Pub', 1)",
        "INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('vault', 'Vault', 'hash', 1)",
        "INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('inv', 'Inv', '!none', 1)",
        "INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('shut', 'Shut', '!none', 1)",
        "INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('spent', 'Spent', '!none', 1)",
        "INSERT INTO server_passwords(server, hash, lookup, created_at) VALUES('inv', '!lookup', 'a', 1)",
        "INSERT INTO server_passwords(server, hash, lookup, created_at, revoked_at) VALUES('shut', '!lookup', 'b', 1, 2)",
        "INSERT INTO server_passwords(server, hash, lookup, created_at, max_uses, uses) VALUES('spent', '!lookup', 'c', 1, 1, 1)",
        "INSERT INTO server_passwords(server, hash, lookup, created_at, expires_at) VALUES('spent', '!lookup', 'd', 1, 2)",
    ] {
        exec(db, stmt).await;
    }
    for (key, mode) in [
        ("pub", JoinMode::Name),
        ("vault", JoinMode::Password),
        ("inv", JoinMode::Invite),
        ("shut", JoinMode::Closed),
        ("spent", JoinMode::Closed),
    ] {
        assert_eq!(mode_of(db, key).await, mode, "{key}");
        assert_eq!(
            text(
                db,
                &format!("SELECT join_mode FROM servers WHERE name = '{key}'")
            )
            .await,
            None,
            "{key}: nothing is written"
        );
    }
    let lite = crate::api::access::ws_server_lite(db, "inv")
        .await
        .expect("lite")
        .expect("found");
    assert_eq!(lite.join_mode, JoinMode::Invite, "events say it too");
    exec(
        db,
        "UPDATE servers SET join_mode = 'closed' WHERE name = 'inv'",
    )
    .await;
    assert_eq!(
        mode_of(db, "inv").await,
        JoinMode::Closed,
        "a stored mode says"
    );
    exec(
        db,
        "UPDATE servers SET join_mode = 'invite', password_hash = NULL WHERE name = 'shut'",
    )
    .await;
    assert_eq!(
        mode_of(db, "shut").await,
        JoinMode::Name,
        "a copy that made it public changed only the password"
    );
    done(state, path).await;
}

async fn key_of(db: &Db, display: &str) -> String {
    text(
        db,
        &format!("SELECT name FROM servers WHERE display_name = '{display}'"),
    )
    .await
    .expect("key")
}

async fn live_passwords(db: &Db, key: &str) -> i64 {
    number(
        db,
        &format!(
            "SELECT COUNT(*) FROM server_passwords WHERE server = '{key}' AND revoked_at IS NULL"
        ),
    )
    .await
}

#[tokio::test]
async fn renames_keep_the_key_of_servers_not_found_by_name() {
    let (state, path) = temp_state("join_modes_renames").await;
    let state = crate::api::rare::tests::unlimited(state);
    let db = &state.db;
    let links = create_as(&state, "alice", json!({"name": "Links", "join": "invite"}))
        .await
        .expect("invite");
    add_password(&state, &links.name, json!({"label": "Friends"}))
        .await
        .expect("a password");
    let renamed = patch_as(&state, "alice", &links.name, json!({"name": "New links"}))
        .await
        .expect("renamed");
    assert_eq!(
        (renamed.name.as_str(), renamed.display_name.as_str()),
        (links.name.as_str(), "New links"),
        "the key stays"
    );
    assert_eq!(
        live_passwords(db, &links.name).await,
        2,
        "its invite link and its password keep working"
    );

    exec(db, "INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('old', 'Old', '!none', 1)").await;
    add_member(
        db,
        "old",
        "alice",
        1,
        crate::api::access::perms::ALL_PERMS,
        1,
    )
    .await;
    add_password(&state, "old", json!({}))
        .await
        .expect("a password");
    patch_as(&state, "alice", "old", json!({"name": "Older"}))
        .await
        .expect("renamed");
    assert_eq!(
        key_of(db, "Older").await,
        "older",
        "older servers rename as before"
    );
    assert_eq!(live_passwords(db, "older").await, 0);
    done(state, path).await;
}

#[tokio::test]
async fn managers_change_how_people_join() {
    let (state, path) = temp_state("join_modes_changes").await;
    let state = crate::api::rare::tests::unlimited(state);
    let db = &state.db;
    let links = create_as(&state, "alice", json!({"name": "Hub", "join": "invite"}))
        .await
        .expect("invite");
    let key = links.name.clone();
    create_as(&state, "bob", json!({"name": "Hub"}))
        .await
        .expect("bob takes the name");
    assert_eq!(
        refusal(patch_as(&state, "alice", &key, json!({"join": "name"})).await),
        invalid(
            "That name is taken. Pick another to let people join by name.",
            "name"
        )
    );
    assert_eq!(mode_of(db, &key).await, JoinMode::Invite, "nothing changed");
    for (body, want) in [
        (
            json!({"join": "password"}),
            invalid("A password needs 8 characters", "password"),
        ),
        (
            json!({"join": "closed", "password": "long enough"}),
            invalid("Pick one way to join", "join"),
        ),
        (
            json!({"join": "invite", "protected": true}),
            invalid("Use join or protected, not both", "protected"),
        ),
    ] {
        assert_eq!(
            refusal(patch_as(&state, "alice", &key, body.clone()).await),
            want,
            "{body}"
        );
    }
    let named = patch_as(
        &state,
        "alice",
        &key,
        json!({"join": "name", "name": "Hub two"}),
    )
    .await
    .expect("joined by its new name");
    assert_eq!(
        (named.name.as_str(), named.join_mode, named.has_password),
        ("hub two", JoinMode::Name, false),
        "it takes its name as its key"
    );
    let back = patch_as(&state, "alice", "hub two", json!({"join": "invite"}))
        .await
        .expect("invite again");
    assert_eq!(
        (back.name.as_str(), back.join_mode, back.has_password),
        ("hub two", JoinMode::Invite, true),
        "it keeps its key"
    );
    add_password(&state, "hub two", json!({}))
        .await
        .expect("a password");
    let shut = patch_as(&state, "alice", "hub two", json!({"join": "closed"}))
        .await
        .expect("closed");
    assert_eq!(shut.join_mode, JoinMode::Closed);
    assert_eq!(live_passwords(db, "hub two").await, 0, "nobody new gets in");
    add_password(&state, "hub two", json!({}))
        .await
        .expect("a way in again");
    assert_eq!(
        mode_of(db, "hub two").await,
        JoinMode::Invite,
        "a new password opens a closed server to invites"
    );
    let secret = patch_as(
        &state,
        "alice",
        "hub two",
        json!({"join": "password", "password": "long enough"}),
    )
    .await
    .expect("a password server");
    assert_eq!(secret.join_mode, JoinMode::Password);
    let kept = patch_as(&state, "alice", "hub two", json!({"join": "password"}))
        .await
        .expect("its password stays");
    assert_eq!(kept.join_mode, JoinMode::Password);
    let public = patch_as(&state, "alice", "hub two", json!({"protected": false}))
        .await
        .expect("an old client makes it public");
    assert_eq!(public.join_mode, JoinMode::Name);
    assert_eq!(
        text(db, "SELECT join_mode FROM servers WHERE name = 'hub two'")
            .await
            .as_deref(),
        Some("name")
    );
    set_control(db, "server_joining", "invites").await;
    patch_as(&state, "alice", "hub two", json!({"join": "invite"}))
        .await
        .expect("invite");
    assert_eq!(
        refusal(patch_as(&state, "alice", "hub two", json!({"join": "name"})).await),
        off_site(
            StatusCode::BAD_REQUEST,
            "This instance needs invites to join. Pick invite or password.",
            "server_joining"
        )
    );
    let audit = text(
        db,
        "SELECT details FROM audit_log WHERE action = 'access.mode' ORDER BY id DESC LIMIT 1",
    )
    .await
    .expect("audited");
    assert!(
        audit.contains("\"join_mode\"") && audit.contains("\"invite\""),
        "{audit}"
    );
    done(state, path).await;
}
