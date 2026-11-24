use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicU32, Ordering};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use serde_json::{Value, json};
use sqlx::Row;

use super::tests::{add_password, exec, patch_as, set_control};
use super::*;
use crate::api::access::{DENIED, NOT_FOUND, PASSWORD_REQUIRED};
use crate::api::passwords::{
    InviteLinkInfo, delete_standing_invite, get_standing_invite, list_passwords,
    make_standing_invite,
};
use crate::api::servers::{
    Invite, InviteStatus, create_server, get_invite_code, get_server, guest_access, join_server,
};
use crate::api::test_util::{add_member, done, mem_user, temp_state};
use crate::api::{ApiError, Authed, MaybeAuthed};
use crate::db::Db;
use crate::state::AppState;

async fn rows_text(db: &Db, sql: &str) -> Vec<String> {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_all(db)
        .await
        .expect(sql)
        .iter()
        .map(|r| {
            r.try_get::<Option<String>, _>(0)
                .expect("text")
                .unwrap_or_default()
        })
        .collect()
}

async fn number(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("number")
}

/// Creates a server as alice; answers its key and its invite link.
async fn made(state: &AppState, body: Value) -> (String, Option<InviteLinkInfo>) {
    let Json(created) = create_server(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Json(serde_json::from_value(body).expect("create body")),
    )
    .await
    .expect("created");
    (created.server.name, created.invite)
}

/// Each call comes from an address of its own, so misses never add up between calls.
async fn card(state: &AppState, viewer: Option<&str>, code: &str) -> Result<Invite, ApiError> {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let ip = IpAddr::V4(Ipv4Addr::from(
        0x0a00_0000 + NEXT.fetch_add(1, Ordering::Relaxed),
    ));
    crate::api::budget::as_client(ip, card_now(state, viewer, code)).await
}

async fn card_now(state: &AppState, viewer: Option<&str>, code: &str) -> Result<Invite, ApiError> {
    get_invite_code(
        State(state.clone()),
        MaybeAuthed(viewer.map(|v| mem_user(v, false))),
        HeaderMap::new(),
        Path(code.to_string()),
    )
    .await
    .map(|Json(invite)| invite)
}

async fn card_from(
    state: &AppState,
    ip: &str,
    viewer: Option<&str>,
    code: &str,
) -> Result<Invite, ApiError> {
    let ip: IpAddr = ip.parse().expect("ip");
    crate::api::budget::as_client(ip, card_now(state, viewer, code)).await
}

async fn join_as(
    state: &AppState,
    who: &str,
    key: &str,
    password: Option<&str>,
) -> Result<(), ApiError> {
    join_server(
        State(state.clone()),
        Authed(mem_user(who, false)),
        Path(key.to_string()),
        Some(Json(
            serde_json::from_value(json!({ "password": password })).expect("join body"),
        )),
    )
    .await
    .map(|_| ())
}

fn answer<T>(res: Result<T, ApiError>) -> String {
    match res {
        Ok(_) => "ok".to_string(),
        Err(ApiError(status, text, reason)) => format!("{status} {text} {reason:?}"),
    }
}

fn gone() -> String {
    format!("404 Not Found {NOT_FOUND} None")
}

async fn standing(
    state: &AppState,
    who: &str,
    key: &str,
) -> Result<Option<InviteLinkInfo>, ApiError> {
    get_standing_invite(
        State(state.clone()),
        Authed(mem_user(who, false)),
        Path(key.to_string()),
    )
    .await
    .map(|Json(link)| link)
}

#[test]
fn codes_are_twelve_clear_characters_found_case_blind() {
    let code = crate::api::passwords::new_code();
    assert_eq!(code.len(), 12);
    assert!(code.bytes().all(|b| ALPHABET.contains(&b)));
    assert_eq!(
        crate::api::passwords::clean_code(&format!(" {} ", code.to_uppercase())).as_deref(),
        Some(code.as_str())
    );
    for bad in ["", "abc", "../etc/passwd", "k7m2p9xq4tz0", &"k".repeat(33)] {
        assert_eq!(crate::api::passwords::clean_code(bad), None, "{bad}");
    }
}

#[tokio::test]
async fn a_code_finds_its_server_and_joins_through_its_password() {
    let (state, path) = temp_state("codes_join").await;
    let db = &state.db;
    let (key, link) = made(&state, json!({"name": "Pixel Club", "join": "invite"})).await;
    let link = link.expect("a new invite server gets its invite link");
    assert_eq!(link.path, format!("/i/{}/", link.code));
    assert_eq!(link.code.len(), 12);
    assert!(!link.path.contains(&key), "the link never names the server");

    let invite = card(&state, Some("bob"), &link.code)
        .await
        .expect("the card");
    assert_eq!(
        invite.server.name, key,
        "the card names the key to join with"
    );
    assert_eq!(invite.server.display_name, "Pixel Club");
    assert_eq!(invite.status, InviteStatus::Joinable);
    assert_eq!(
        answer(join_as(&state, "bob", &key, None).await),
        format!("401 Unauthorized {PASSWORD_REQUIRED} None"),
        "a name alone asks for a password, as for any protected server"
    );
    join_as(&state, "bob", &key, Some(&link.code))
        .await
        .expect("the code works as the password");
    let via = number(
        db,
        &format!("SELECT joined_via FROM members WHERE server = '{key}' AND username = 'bob'"),
    )
    .await;
    let id = number(
        db,
        &format!("SELECT id FROM server_passwords WHERE server = '{key}' AND code IS NOT NULL"),
    )
    .await;
    assert_eq!(via, id, "each code is one row with one id");
    assert_eq!(
        card(&state, Some("bob"), &link.code)
            .await
            .expect("card")
            .status,
        InviteStatus::Member
    );
    let entry = sqlx::query(
        "SELECT actor, target_kind, target_id, details FROM audit_log WHERE action = 'member.join'",
    )
    .fetch_one(db)
    .await
    .expect("the join is in the audit log");
    assert_eq!(entry.try_get::<String, _>(0).expect("actor"), "bob");
    assert_eq!(entry.try_get::<String, _>(1).expect("kind"), "password");
    assert_eq!(entry.try_get::<i64, _>(2).expect("id"), id);
    assert!(
        entry
            .try_get::<String, _>(3)
            .expect("details")
            .contains("\"standing\"")
    );
    for sql in [
        "SELECT details FROM audit_log",
        "SELECT target_name FROM audit_log",
        "SELECT detail FROM instance_audit",
        "SELECT label FROM server_passwords",
        "SELECT lookup FROM server_passwords",
    ] {
        for text in rows_text(db, sql).await {
            assert!(!text.contains(&link.code), "{sql}: {text}");
        }
    }
    done(state, path).await;
}

#[tokio::test]
async fn dead_and_unknown_codes_get_the_same_answer() {
    let (state, path) = temp_state("codes_dead").await;
    let state = crate::api::rare::tests::unlimited(state);
    let db = &state.db;
    let (key, _) = made(
        &state,
        json!({"name": "Hub", "join": "invite", "standing_link": false}),
    )
    .await;
    let made_link = |body: Value| {
        let state = state.clone();
        let key = key.clone();
        async move {
            let Json(created) = crate::api::passwords::create_password(
                State(state),
                Authed(mem_user("alice", false)),
                Path(key),
                Json(serde_json::from_value(body).expect("body")),
            )
            .await
            .expect("a link");
            created
        }
    };
    let once = made_link(json!({"kind": "link", "label": "Once", "max_uses": 1})).await;
    let code = once
        .link
        .as_ref()
        .expect("a link answers its code")
        .code
        .clone();
    assert_eq!(once.password, code);
    join_as(&state, "carol", &key, Some(&code))
        .await
        .expect("its one use");
    assert_eq!(
        answer(card(&state, Some("dave"), &code).await),
        gone(),
        "used up"
    );

    let timed = made_link(json!({"kind": "link", "expires_in": 3600})).await;
    let timed = timed.link.expect("link").code;
    card(&state, Some("dave"), &timed).await.expect("live");
    exec(
        db,
        "UPDATE server_passwords SET expires_at = 5 WHERE expires_at IS NOT NULL",
    )
    .await;
    assert_eq!(
        answer(card(&state, Some("dave"), &timed).await),
        gone(),
        "expired"
    );

    let revoked = made_link(json!({"kind": "link"})).await;
    let revoked_code = revoked.link.expect("link").code;
    let _ = crate::api::passwords::revoke_password(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path((key.clone(), revoked.info.id)),
    )
    .await
    .expect("revoked");
    assert_eq!(
        answer(card(&state, Some("dave"), &revoked_code).await),
        gone()
    );
    for unknown in ["hhhhhhhhhhhh", "nonsense", "../x", ""] {
        assert_eq!(
            answer(card(&state, Some("dave"), unknown).await),
            gone(),
            "{unknown}"
        );
        assert_eq!(
            answer(card(&state, None, unknown).await),
            gone(),
            "guest {unknown}"
        );
    }
    assert_eq!(
        answer(join_as(&state, "dave", &key, Some(&revoked_code)).await),
        format!("404 Not Found {DENIED} None")
    );
    let Json(listed) = list_passwords(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(key.clone()),
    )
    .await
    .expect("list");
    let kinds: Vec<Value> = listed
        .passwords
        .iter()
        .map(|p| serde_json::to_value(p.kind).expect("kind"))
        .collect();
    assert!(kinds.iter().all(|k| k == &json!("link")), "{kinds:?}");
    assert_eq!(
        answer(
            made_link_err(
                &state,
                &key,
                json!({"kind": "link", "password": "long enough"})
            )
            .await
        ),
        format!(
            "400 Bad Request A link makes its own code {:?}",
            Some(crate::api::Reason {
                kind: crate::api::ReasonKind::Invalid,
                control: None,
                retry_after: None,
                field: Some("password".to_string()),
                until: None,
            })
        )
    );
    done(state, path).await;
}

async fn made_link_err(state: &AppState, key: &str, body: Value) -> Result<(), ApiError> {
    crate::api::passwords::create_password(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(key.to_string()),
        Json(serde_json::from_value(body).expect("body")),
    )
    .await
    .map(|_| ())
}

#[tokio::test]
async fn code_misses_use_up_the_password_attempts_of_an_address() {
    let (state, path) = temp_state("codes_misses").await;
    let (_, link) = made(&state, json!({"name": "Hub", "join": "invite"})).await;
    let code = link.expect("link").code;
    for n in 0..5 {
        assert_eq!(
            answer(card_from(&state, "198.51.100.7", Some("dave"), "hhhhhhhhhhhh").await),
            gone(),
            "miss {n}"
        );
    }
    let blocked = answer(card_from(&state, "198.51.100.7", Some("dave"), "jjjjjjjjjjjj").await);
    assert!(blocked.starts_with("429 Too Many Requests"), "{blocked}");
    card_from(&state, "198.51.100.7", Some("dave"), &code)
        .await
        .expect("a working code is no guess");
    assert_eq!(
        answer(card_from(&state, "203.0.113.9", Some("erin"), "kkkkkkkkkkkk").await),
        gone(),
        "another address has attempts of its own"
    );
    done(state, path).await;
}

#[tokio::test]
async fn the_code_card_names_its_preview_and_its_messages_load_with_the_code() {
    let (state, path) = temp_state("codes_preview").await;
    let db = &state.db;
    let (key, link) = made(&state, json!({"name": "Pixel Club", "join": "invite"})).await;
    let code = link.expect("link").code;
    let channel = number(
        db,
        &format!("SELECT id FROM channels WHERE server = '{key}' AND kind = 'text'"),
    )
    .await;
    exec(
        db,
        &format!(
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES({channel}, 'alice', 'inside', {})",
            crate::db::now()
        ),
    )
    .await;
    let invite = card(&state, Some("bob"), &code).await.expect("the card");
    assert_eq!(invite.preview_channel_id, Some(channel));
    assert!(
        invite.preview.is_empty(),
        "the card loads no messages before the viewer opens the preview"
    );
    let mut headers = HeaderMap::new();
    headers.insert("x-invite-password", code.parse().expect("header"));
    let Json(full) = crate::api::servers::get_invite(
        State(state.clone()),
        MaybeAuthed(Some(mem_user("bob", false))),
        headers,
        Path(key.clone()),
        axum::extract::Query(crate::api::servers::InvitePreviewQuery::default()),
    )
    .await
    .expect("the preview with the code");
    assert_eq!(
        full.preview
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        ["inside"]
    );
    done(state, path).await;
}

#[tokio::test]
async fn an_address_out_of_attempts_gets_one_refusal_for_working_and_unknown_codes() {
    let (state, path) = temp_state("codes_spent").await;
    let (_, link) = made(&state, json!({"name": "Hub", "join": "invite"})).await;
    let code = link.expect("link").code;
    let ip = "198.51.100.42";
    for n in 0..40 {
        let a = ALPHABET[n % ALPHABET.len()] as char;
        let b = ALPHABET[n / ALPHABET.len()] as char;
        let _ = card_from(&state, ip, Some("dave"), &format!("hhhhhhhhhh{a}{b}")).await;
    }
    let unknown = answer(card_from(&state, ip, Some("dave"), "kkkkkkkkkkkk").await);
    assert!(unknown.starts_with("429 Too Many Requests"), "{unknown}");
    assert_eq!(
        answer(card_from(&state, ip, Some("dave"), &code).await),
        unknown,
        "a working code tells nothing apart while the address has no attempts left"
    );
    card_from(&state, "203.0.113.42", Some("dave"), &code)
        .await
        .expect("another address opens it");
    done(state, path).await;
}

#[tokio::test]
async fn members_share_the_invite_link_and_managers_replace_it() {
    let (state, path) = temp_state("codes_standing").await;
    let state = crate::api::rare::tests::unlimited(state);
    let db = &state.db;
    exec(db, "INSERT INTO settings(key, value) VALUES('guests_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").await;
    crate::api::Settings::forget(db);
    let (key, link) = made(&state, json!({"name": "Hub", "join": "invite"})).await;
    let first = link.expect("link");
    join_as(&state, "bob", &key, Some(&first.code))
        .await
        .expect("bob joins");
    let shared = standing(&state, "bob", &key)
        .await
        .expect("a member reads it");
    assert_eq!(
        shared.as_ref().map(|l| l.code.as_str()),
        Some(first.code.as_str())
    );
    assert_eq!(
        answer(standing(&state, "mallory", &key).await),
        format!("404 Not Found {DENIED} None"),
        "people who can't open the server get the uniform denial"
    );
    let Json(grant) = guest_access(
        State(state.clone()),
        MaybeAuthed(None),
        Path(key.clone()),
        Json(serde_json::from_value(json!({ "password": first.code })).expect("body")),
    )
    .await
    .expect("a guest with the code");
    let grant = serde_json::to_value(grant).expect("json")["grant"]
        .as_str()
        .expect("a grant")
        .to_string();
    let mut headers = HeaderMap::new();
    headers.insert("x-guest-grant", grant.parse().expect("header"));
    let _ = get_server(
        State(state.clone()),
        MaybeAuthed(None),
        headers.clone(),
        Path(key.clone()),
    )
    .await
    .expect("the grant opens the server");

    let reset = |who: &'static str| {
        let state = state.clone();
        let key = key.clone();
        async move {
            make_standing_invite(State(state), Authed(mem_user(who, false)), Path(key))
                .await
                .map(|Json(link)| link)
        }
    };
    assert!(
        answer(reset("bob").await).starts_with("403"),
        "Delete server only"
    );
    let second = reset("alice").await.expect("a new link");
    assert_ne!(second.code, first.code);
    assert_eq!(
        answer(card(&state, Some("dave"), &first.code).await),
        gone()
    );
    card(&state, Some("dave"), &second.code)
        .await
        .expect("the new code");
    assert_eq!(
        number(
            db,
            &format!("SELECT COUNT(*) FROM members WHERE server = '{key}' AND username = 'bob'")
        )
        .await,
        1,
        "who joined with the old link stays"
    );
    assert_eq!(
        answer(
            get_server(
                State(state.clone()),
                MaybeAuthed(None),
                headers,
                Path(key.clone())
            )
            .await
        ),
        format!("404 Not Found {DENIED} None"),
        "guests of the old link lose the server"
    );
    assert_eq!(
        standing(&state, "bob", &key)
            .await
            .expect("read")
            .map(|l| l.code),
        Some(second.code.clone())
    );
    let _ = delete_standing_invite(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(key.clone()),
    )
    .await
    .expect("removed");
    assert!(standing(&state, "bob", &key).await.expect("read").is_none());
    assert_eq!(
        answer(card(&state, Some("dave"), &second.code).await),
        gone()
    );

    let renamed = reset("alice").await.expect("a link again");
    patch_as(&state, "alice", &key, json!({"name": "Hub renamed"}))
        .await
        .expect("renamed");
    let after = card(&state, Some("dave"), &renamed.code)
        .await
        .expect("the link survives a rename");
    assert_eq!(after.server.display_name, "Hub renamed");
    done(state, path).await;
}

#[tokio::test]
async fn invite_links_are_only_for_servers_people_join_with_an_invite_or_password() {
    let (state, path) = temp_state("codes_modes").await;
    let state = crate::api::rare::tests::unlimited(state);
    let (open, link) = made(&state, json!({"name": "Open"})).await;
    assert!(link.is_none(), "a name server has no invite link");
    let refused = create_server(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Json(serde_json::from_value(json!({"name": "Den", "standing_link": true})).expect("body")),
    )
    .await;
    assert_eq!(
        answer(refused),
        format!(
            "400 Bad Request Only invite servers have an invite link {:?}",
            Some(crate::api::Reason {
                kind: crate::api::ReasonKind::Invalid,
                control: None,
                retry_after: None,
                field: Some("standing_link".to_string()),
                until: None,
            })
        )
    );
    let reset = make_standing_invite(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(open.clone()),
    )
    .await;
    assert!(
        answer(reset).starts_with("400 Bad Request Anyone can join this server by its name"),
        "a name server needs no link"
    );
    let (shut, none) = made(&state, json!({"name": "Shut", "join": "closed"})).await;
    assert!(none.is_none());
    let opened = make_standing_invite(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(shut.clone()),
    )
    .await
    .expect("a closed server opens to its link");
    assert_eq!(
        super::tests::mode_of(&state.db, &shut).await,
        JoinMode::Invite
    );
    card(&state, Some("bob"), &opened.0.code)
        .await
        .expect("card");
    let (vault, none) = made(
        &state,
        json!({"name": "Vault", "join": "password", "password": "long enough"}),
    )
    .await;
    assert!(none.is_none());
    add_member(&state.db, &vault, "bob", 0, 0, 1).await;
    let link = make_standing_invite(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(vault.clone()),
    )
    .await
    .expect("a password server may have one too")
    .0;
    card(&state, Some("carol"), &link.code).await.expect("card");
    add_password(&state, &vault, json!({}))
        .await
        .expect("still makes passwords");
    set_control(&state.db, "server_joining", "nobody").await;
    card(&state, Some("carol"), &link.code)
        .await
        .expect("the card still opens with a working code");
    assert!(answer(join_as(&state, "carol", &vault, Some(&link.code)).await).starts_with("404"));
    done(state, path).await;
}

#[tokio::test]
async fn codes_are_found_and_missed_alike_on_postgres() {
    let Some((state, temp)) = crate::api::test_util::pg_state("codes_pg").await else {
        return;
    };
    let (key, link) = made(&state, json!({"name": "Hub", "join": "invite"})).await;
    let code = link.expect("link").code;
    let invite = card(&state, Some("bob"), &code).await.expect("the card");
    assert_eq!(invite.server.name, key);
    for unknown in ["hhhhhhhhhhhh", "nonsense", ""] {
        assert_eq!(
            answer(card(&state, Some("bob"), unknown).await),
            gone(),
            "{unknown}"
        );
    }
    join_as(&state, "bob", &key, Some(&code))
        .await
        .expect("joined");
    crate::api::test_util::pg_done(state, temp).await;
}
