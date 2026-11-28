use crate::db::now;
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde_json::json;
use sqlx::Row;

use super::*;
use crate::api::admin::{PurgeKind, hide_user_in, resume_purges};
use crate::api::auth::{LoginReq, hash_password, login_at};
use crate::api::test_util::{add_member, each_db};
use crate::db::{NewUser, get_user};
use crate::sso::config::{ProviderConfig, ScimConfig, ScimDelete, SsoConfig, TokenAuth};

const T: i64 = 1_800_000_000;

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .expect(sql);
}

async fn count(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("count")
}

/// root (a site admin), alice and bob, all with the password `pw`.
async fn people(db: &Db) {
    let hash = hash_password("pw").await.expect("hash");
    for (name, admin) in [("root", true), ("alice", false), ("bob", false)] {
        NewUser::plain(name).hash(&hash).admin(admin).add(db).await;
    }
}

async fn session(db: &Db, name: &str) -> Session {
    Session {
        user: get_user(db, name).await.expect("read").expect("user"),
        token: format!("token-{name}"),
        created_at: 0,
    }
}

fn confirm(secret: &str) -> DeleteAccount {
    serde_json::from_value(json!({ "reauth": { "password": secret } })).expect("body")
}

async fn ask(state: &AppState, name: &str, t: i64) -> Result<i64, (StatusCode, String)> {
    match request_at(state, session(&state.db, name).await, confirm("pw"), t).await {
        Ok(Json(DeletionPending { delete_at })) => Ok(delete_at),
        Err(ApiError(status, text, _)) => Err((status, text)),
    }
}

async fn sign_in(state: &AppState, name: &str, t: i64) -> bool {
    let req: LoginReq =
        serde_json::from_value(json!({ "username": name, "password": "pw" })).expect("login");
    login_at(state, req, t).await.is_ok()
}

fn provider(id: &str, auto_create: bool) -> ProviderConfig {
    ProviderConfig {
        id: id.to_string(),
        name: id.to_string(),
        issuer: format!("https://{id}.example"),
        client_id: "client".to_string(),
        client_secret: None,
        scopes: vec!["openid".to_string()],
        username_claim: "preferred_username".to_string(),
        display_claim: "name".to_string(),
        groups_claim: "groups".to_string(),
        allowed_groups: Vec::new(),
        auto_create,
        sync_profile: false,
        end_session: false,
        token_auth: TokenAuth::Basic,
    }
}

fn refused_here() -> Result<i64, (StatusCode, String)> {
    Err((StatusCode::FORBIDDEN, REFUSED.to_string()))
}

const PENDING: &str = "SELECT COUNT(*) FROM pending_purges";
const OWN_ROWS: &str = "SELECT COUNT(*) FROM pending_purges WHERE self_requested = 1";

#[tokio::test]
async fn asking_signs_the_account_out_and_signing_in_again_keeps_it() {
    for (state, temp) in each_db("deletion_ask").await {
        let db = &state.db;
        people(db).await;
        exec(db, "INSERT INTO tokens(token, username, created_at) VALUES('one', 'alice', 0), ('two', 'alice', 0), ('other', 'bob', 0)").await;

        let wrong = request_at(&state, session(db, "alice").await, confirm("no"), T).await;
        assert_eq!(wrong.err().map(|e| e.0), Some(StatusCode::UNAUTHORIZED));
        assert_eq!(count(db, PENDING).await, 0);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM tokens WHERE username = 'alice'").await,
            2
        );
        let fresh: DeleteAccount =
            serde_json::from_value(json!({ "reauth": { "fresh_session": true } })).expect("body");
        let unconfirmed = request_at(&state, session(db, "alice").await, fresh, T + 5).await;
        assert_eq!(
            unconfirmed.err().map(|e| e.0),
            Some(StatusCode::UNAUTHORIZED)
        );

        let mut rx = state.hub.subscribe();
        assert_eq!(ask(&state, "alice", T + 10).await, Ok(T + 10 + GRACE_SECS));
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::TokensRevoked { username }) if username == "alice"
        ));
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM tokens WHERE username = 'alice'").await,
            0
        );
        assert_eq!(count(db, "SELECT COUNT(*) FROM tokens").await, 1);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM pending_purges WHERE kind = 'user' AND key = 'alice' AND self_requested = 1 AND created_at = 1800000010").await,
            1
        );
        assert_eq!(
            due(db, "alice").await.expect("due"),
            Some(T + 10 + GRACE_SECS)
        );
        assert_eq!(due(db, "bob").await.expect("due"), None);

        assert_eq!(resume_purges(&state).await.expect("sweep"), 0);
        assert!(get_user(db, "alice").await.expect("read").is_some());
        assert_eq!(count(db, OWN_ROWS).await, 1);

        assert_eq!(
            ask(&state, "alice", T + 500).await,
            Ok(T + 10 + GRACE_SECS),
            "asking again keeps the first date"
        );

        assert!(sign_in(&state, "alice", T + 600).await);
        assert_eq!(count(db, PENDING).await, 0);
        assert_eq!(due(db, "alice").await.expect("due"), None);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM tokens WHERE username = 'alice'").await,
            1
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_session_opened_another_way_keeps_the_account_by_asking() {
    for (state, temp) in each_db("deletion_cancel").await {
        let db = &state.db;
        people(db).await;
        assert_eq!(ask(&state, "alice", T).await, Ok(T + GRACE_SECS));
        assert_eq!(ask(&state, "bob", T).await, Ok(T + GRACE_SECS));
        let alice = get_user(db, "alice").await.expect("read").expect("alice");
        let me = crate::api::auth::me_payload(db, &alice).await.expect("me");
        assert_eq!(me.delete_at, Some(T + GRACE_SECS));
        for _ in 0..2 {
            let Json(_) = cancel(State(state.clone()), Authed(alice.clone()))
                .await
                .expect("cancel");
            assert_eq!(due(db, "alice").await.expect("due"), None);
            assert_eq!(due(db, "bob").await.expect("due"), Some(T + GRACE_SECS));
        }
        let me = crate::api::auth::me_payload(db, &alice).await.expect("me");
        assert_eq!(me.delete_at, None);
        assert_eq!(
            serde_json::to_value(&me).expect("json").get("delete_at"),
            None
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn the_account_goes_with_its_messages_and_p2p_rows_once_the_wait_is_over() {
    for (state, temp) in each_db("deletion_due").await {
        let db = &state.db;
        people(db).await;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'bob', 0)").await;
        add_member(db, "club", "alice", 0, 0, 0).await;
        add_member(db, "club", "bob", 1, 0, 0).await;
        for sql in [
            "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 0)",
            "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'mine', 1 FROM channels WHERE server = 'club'",
            "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'bob', 'his', 2 FROM channels WHERE server = 'club'",
            "INSERT INTO p2p_backups(username, ik, version, size, updated_at, data) VALUES('alice', 'ik', 1, 1, 0, 'x'), ('bob', 'ik', 1, 1, 0, 'x')",
            "INSERT INTO p2p_backup_seq(username, ik, latest) VALUES('alice', 'ik', 1), ('bob', 'ik', 1)",
            "INSERT INTO p2p_identities(username, ik, record, updated_at) VALUES('alice', 'ik', '{}', 0), ('bob', 'ik', '{}', 0)",
        ] {
            exec(db, sql).await;
        }
        let asked = now() - GRACE_SECS + 3600;
        assert_eq!(ask(&state, "alice", asked).await, Ok(asked + GRACE_SECS));
        assert_eq!(resume_purges(&state).await.expect("early"), 0);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE author = 'alice'").await,
            1
        );

        exec(
            db,
            "UPDATE pending_purges SET created_at = created_at - 3600",
        )
        .await;
        let mut rx = state.hub.subscribe();
        assert_eq!(resume_purges(&state).await.expect("due"), 1);
        assert!(get_user(db, "alice").await.expect("read").is_none());
        assert_eq!(count(db, PENDING).await, 0);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE author = 'alice'").await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE author = 'bob'").await,
            1
        );
        for table in ["p2p_backups", "p2p_backup_seq", "p2p_identities", "members"] {
            assert_eq!(
                count(
                    db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE username = 'alice'")
                )
                .await,
                0,
                "{table}"
            );
            assert_eq!(
                count(
                    db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE username = 'bob'")
                )
                .await,
                1,
                "{table}"
            );
        }
        let mut signed_out = false;
        while let Ok(event) = rx.try_recv() {
            signed_out |=
                matches!(event, WsEvent::TokensRevoked { username } if username == "alice");
        }
        assert!(signed_out);
        assert!(!sign_in(&state, "alice", now()).await);
        assert_eq!(resume_purges(&state).await.expect("idle"), 0);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn hiding_an_account_removes_its_p2p_rows_and_takes_over_its_own_deletion() {
    for (state, temp) in each_db("deletion_hide").await {
        let db = &state.db;
        people(db).await;
        for sql in [
            "INSERT INTO p2p_backups(username, ik, version, size, updated_at, data) VALUES('alice', 'ik', 1, 1, 0, 'x'), ('alice', 'ik', 2, 1, 0, 'x'), ('bob', 'ik', 1, 1, 0, 'x')",
            "INSERT INTO p2p_backup_seq(username, ik, latest) VALUES('alice', 'ik', 2), ('bob', 'ik', 1)",
            "INSERT INTO p2p_identities(username, ik, record, updated_at) VALUES('alice', 'ik', '{}', 0), ('bob', 'ik', '{}', 0)",
        ] {
            exec(db, sql).await;
        }
        assert_eq!(ask(&state, "alice", T).await, Ok(T + GRACE_SECS));
        let mut tx = db.begin().await.expect("begin");
        let hidden = hide_user_in(&mut tx, "alice", PurgeKind::Ban)
            .await
            .expect("hide");
        tx.commit().await.expect("commit");
        assert!(hidden.starts_purge());
        assert_eq!(hidden.p2p_held(), (2, 1));
        assert_eq!(count(db, OWN_ROWS).await, 0);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM pending_purges WHERE kind = 'ban' AND key = 'alice' AND self_requested = 0").await,
            1
        );
        assert_eq!(count(db, PENDING).await, 1);
        for table in ["p2p_backups", "p2p_backup_seq", "p2p_identities"] {
            assert_eq!(
                count(
                    db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE username = 'alice'")
                )
                .await,
                0,
                "{table}"
            );
            assert_eq!(
                count(
                    db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE username = 'bob'")
                )
                .await,
                1,
                "{table}"
            );
        }
        assert_eq!(due(db, "alice").await.expect("due"), None);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn the_last_site_admin_and_provider_made_accounts_get_one_refusal() {
    for (state, temp) in each_db("deletion_refused").await {
        let state = state.with_sso(Arc::new(
            crate::sso::Sso::new(SsoConfig {
                providers: vec![provider("made", true), provider("linked", false)],
                scim: Some(ScimConfig {
                    token_sha256: [0; 32],
                    delete: ScimDelete::Deactivate,
                    provider: Some("directory".to_string()),
                }),
                ..Default::default()
            })
            .expect("sso"),
        ));
        let db = &state.db;
        people(db).await;
        let hash = hash_password("pw").await.expect("hash");
        for name in ["carol", "dan", "erin", "sage"] {
            NewUser::plain(name)
                .hash(&hash)
                .admin(name == "sage")
                .add(db)
                .await;
        }
        for sql in [
            "INSERT INTO sso_links(issuer, subject, provider, username, linked_at, last_login_at) VALUES('https://made.example', 's1', 'made', 'alice', 0, 0)",
            "INSERT INTO sso_links(issuer, subject, provider, username, linked_at, last_login_at) VALUES('https://linked.example', 's2', 'linked', 'bob', 0, 0)",
            "INSERT INTO sso_links(issuer, subject, provider, username, linked_at, last_login_at) VALUES('https://directory.example', 's3', 'directory', 'carol', 0, 0)",
            "INSERT INTO scim_users(id, username, user_name_key, created_at, updated_at) VALUES('d', 'dan', 'dan', 0, 0)",
            "INSERT INTO sso_links(issuer, subject, provider, username, linked_at, last_login_at) VALUES('https://gone.example', 's4', 'gone', 'erin', 0, 0)",
        ] {
            exec(db, sql).await;
        }
        for name in ["alice", "carol", "dan"] {
            assert_eq!(ask(&state, name, T).await, refused_here(), "{name}");
        }
        assert_eq!(count(db, PENDING).await, 0);
        assert_eq!(ask(&state, "bob", T).await, Ok(T + GRACE_SECS));
        assert_eq!(ask(&state, "erin", T).await, Ok(T + GRACE_SECS));

        assert_eq!(ask(&state, "sage", T).await, Ok(T + GRACE_SECS));
        assert_eq!(
            ask(&state, "root", T).await,
            refused_here(),
            "the other site admin is leaving"
        );
        assert!(sign_in(&state, "sage", T + 1).await);
        exec(
            db,
            "UPDATE users SET suspended_at = 1 WHERE username = 'sage'",
        )
        .await;
        assert_eq!(ask(&state, "root", T).await, refused_here());
        exec(
            db,
            "UPDATE users SET suspended_at = NULL WHERE username = 'sage'",
        )
        .await;
        assert_eq!(ask(&state, "root", T).await, Ok(T + GRACE_SECS));
        assert_eq!(ask(&state, "sage", T).await, refused_here());
        temp.done(state).await;
    }
}

#[tokio::test]
async fn an_account_that_may_not_go_when_the_wait_ends_stays() {
    for (state, temp) in each_db("deletion_recheck").await {
        let db = &state.db;
        people(db).await;
        let hash = hash_password("pw").await.expect("hash");
        NewUser::plain("sage").hash(&hash).admin(true).add(db).await;
        let asked = now() - GRACE_SECS - 10;
        assert_eq!(ask(&state, "alice", asked).await, Ok(asked + GRACE_SECS));
        assert_eq!(ask(&state, "root", asked).await, Ok(asked + GRACE_SECS));
        for sql in [
            "INSERT INTO scim_users(id, username, user_name_key, created_at, updated_at) VALUES('a', 'alice', 'alice', 0, 0)",
            "DELETE FROM users WHERE username = 'sage'",
        ] {
            exec(db, sql).await;
        }
        assert_eq!(resume_purges(&state).await.expect("sweep"), 0);
        assert_eq!(count(db, PENDING).await, 0);
        for name in ["alice", "root"] {
            let kept = get_user(db, name).await.expect("read").expect(name);
            assert_ne!(kept.password_hash, PURGING_HASH, "{name}");
            assert!(sign_in(&state, name, now()).await, "{name}");
        }
        temp.done(state).await;
    }
}
