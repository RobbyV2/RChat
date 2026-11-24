use super::*;
use crate::api::test_util::each_db;
use crate::config::AppConfig;
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;

fn configure(state: &mut AppState, create: bool, sync: bool) {
    let cfg = AppConfig::from_map(&[
        ("OIDC_PROVIDERS", "one,two"),
        ("OIDC_ONE_ISSUER", "https://one.example"),
        ("OIDC_ONE_CLIENT_ID", "one"),
        ("OIDC_TWO_ISSUER", "https://two.example"),
        ("OIDC_TWO_CLIENT_ID", "two"),
        ("PUBLIC_URL", "https://chat.example"),
        ("SCIM_PROVIDER", "one"),
        ("SCIM_TOKEN", "01234567890123456789012345678901"),
        ("OIDC_ONE_AUTO_CREATE", if create { "on" } else { "off" }),
        ("OIDC_ONE_SYNC_PROFILE", if sync { "on" } else { "off" }),
    ])
    .unwrap();
    state.sso = Arc::new(crate::sso::Sso::new(cfg.sso).unwrap());
}
fn identity() -> Identity {
    Identity {
        provider: "one".into(),
        issuer: "https://one.example".into(),
        subject: oidc_key("Subject@corp.example"),
        scim_key: None,
        username_claim: Some("Alice@corp.example".into()),
        display: Some("Alice Smith".into()),
        groups: vec!["private-group".into()],
        sid: Some(oidc_key("Session@corp.example")),
    }
}
fn session(result: SignIn, created: bool) -> User {
    let SignIn::Session {
        user,
        created: actual,
        ..
    } = result
    else {
        panic!("expected session")
    };
    assert_eq!(actual, created);
    user
}
fn denied<T>(result: Result<T, ApiError>, message: &str) {
    assert!(matches!(result, Err(ApiError(StatusCode::FORBIDDEN,s,_)) if s == message))
}

#[test]
fn clean_username_cases() {
    for (raw, want) in [
        ("  Bob@x.y ", Some("Bob")),
        ("@x", None),
        ("a\x07b", Some("ab")),
        ("", None),
    ] {
        assert_eq!(clean_username(raw).as_deref(), want);
    }
    assert_eq!(clean_username(&"é".repeat(150)).unwrap(), "é".repeat(100));
}

#[tokio::test]
async fn first_sign_in_creates_an_account_without_a_password() {
    for (mut state, db) in each_db("sso_first").await {
        configure(&mut state, true, true);
        let id = identity();
        let SignIn::Session {
            user: u,
            token,
            created: true,
        } = sign_in(&state, &id, None).await.unwrap()
        else {
            panic!("expected first session")
        };
        assert!(u.is_site_admin && !has_password(&u));
        assert_eq!(
            (&*u.username, &*u.password_hash, &*u.display_name),
            ("alice", "!sso", "Alice Smith")
        );
        for query in [
            "SELECT * FROM users",
            "SELECT * FROM sso_links",
            "SELECT * FROM scim_users",
            "SELECT * FROM tokens",
            "SELECT * FROM instance_audit",
        ] {
            for row in sqlx::query(query).fetch_all(&state.db).await.unwrap() {
                for i in 0..row.len() {
                    if let Ok(text) = row.try_get::<String, _>(i) {
                        assert!(!text.contains("corp.example"));
                    }
                }
            }
        }
        let row = sqlx::query("SELECT actor,detail FROM instance_audit WHERE action='sso.sign_in'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>(0), "alice");
        assert_eq!(
            serde_json::from_str::<Value>(&row.get::<String, _>(1)).unwrap(),
            json!({"provider":"one","created":true})
        );
        let row = sqlx::query("SELECT token,sso_provider,sso_sid FROM tokens")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(
            (
                row.get::<String, _>(0),
                row.get::<String, _>(1),
                row.get::<String, _>(2)
            ),
            (
                secret_key(&token),
                "one".into(),
                oidc_key("Session@corp.example").as_str().to_owned()
            )
        );
        suspend(&state, "alice").await.unwrap();
        denied(
            sign_in(&state, &id, None).await,
            "This account is suspended",
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn second_sign_in_reuses_the_link_and_syncs_the_name() {
    for (mut state, db) in each_db("sso_profile").await {
        crate::api::test_util::profanity_on(&state.db).await;
        configure(&mut state, true, true);
        let mut id = identity();
        session(sign_in(&state, &id, None).await.unwrap(), true);
        let mut events = state.hub.subscribe();
        id.display = Some("A. Smith".into());
        assert_eq!(
            session(sign_in(&state, &id, None).await.unwrap(), false).display_name,
            "A. Smith"
        );
        assert!(matches!(events.try_recv(), Ok(WsEvent::UserUpdated { .. })));
        configure(&mut state, true, false);
        let long = "Alice Morgan from Silver Lake and Green Bay";
        let clipped: String = long.chars().take(32).collect();
        id.display = Some(long.into());
        assert_eq!(
            session(sign_in(&state, &id, None).await.unwrap(), false).display_name,
            "A. Smith"
        );
        configure(&mut state, true, true);
        assert_eq!(
            session(sign_in(&state, &id, None).await.unwrap(), false).display_name,
            clipped
        );
        for claim in ["Alice@corp.example", "A\u{200b}B", "fuck"] {
            id.display = Some(claim.into());
            assert_eq!(
                session(sign_in(&state, &id, None).await.unwrap(), false).display_name,
                clipped
            );
        }
        db.done(state).await;
    }
}

#[tokio::test]
async fn name_collisions_never_link() {
    for (mut state, db) in each_db("sso_collision").await {
        configure(&mut state, true, true);
        super::tests::account(&state, "admin").await;
        let mut id = identity();
        id.username_claim = Some("Admin@corp.example".into());
        assert!(
            matches!(sign_in(&state,&id,None).await.unwrap(), SignIn::NeedsUsername{suggestion:Some(s),reason:NameIssue::Taken} if s=="Admin")
        );
        assert!(
            matches!(sign_in(&state,&id,Some("admin")).await,Err(ApiError(StatusCode::BAD_REQUEST,s,_)) if s=="Username is taken")
        );
        let user = session(sign_in(&state, &id, Some("admin2")).await.unwrap(), true);
        assert_eq!(user.username, "admin2");
        assert!(!user.is_site_admin);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT username FROM sso_links")
                .fetch_all(&state.db)
                .await
                .unwrap(),
            ["admin2"]
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn scim_users_link_on_first_sign_in() {
    for (mut state, db) in each_db("sso_scim").await {
        configure(&mut state, true, true);
        super::tests::account(&state, "alice").await;
        let mut id = identity();
        sqlx::query("INSERT INTO scim_users(id,username,user_name_key,created_at,updated_at) VALUES('managed','alice',$1,0,0)")
            .bind(user_name_key("alice")).execute(&state.db).await.unwrap();
        // A callback created before SCIM was enabled carries only a local suggestion.
        let old_callback = Identity {
            username_claim: Some("Alice".into()),
            ..id.clone()
        };
        assert!(matches!(
            sign_in(&state, &old_callback, None).await.unwrap(),
            SignIn::NeedsUsername {
                reason: NameIssue::Taken,
                ..
            }
        ));
        id.scim_key = Some(user_name_key("Alice@corp.example"));
        id.username_claim = Some("Alice".into());
        sqlx::query("UPDATE scim_users SET user_name_key=$1 WHERE id='managed'")
            .bind(user_name_key(" alice@corp.example "))
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("UPDATE scim_users SET deleted_at=1")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(matches!(
            sign_in(&state, &id, None).await.unwrap(),
            SignIn::NeedsUsername {
                reason: NameIssue::Taken,
                ..
            }
        ));
        sqlx::query("UPDATE scim_users SET deleted_at=NULL")
            .execute(&state.db)
            .await
            .unwrap();
        suspend(&state, "alice").await.unwrap();
        denied(
            sign_in(&state, &id, None).await,
            "This account is suspended",
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sso_links")
                .fetch_one(&state.db)
                .await
                .unwrap(),
            0
        );
        unsuspend(&state, "alice").await.unwrap();
        let other = Identity {
            provider: "two".into(),
            issuer: "https://two.example".into(),
            ..id.clone()
        };
        assert!(matches!(
            sign_in(&state, &other, None).await.unwrap(),
            SignIn::NeedsUsername {
                reason: NameIssue::Taken,
                ..
            }
        ));
        assert_eq!(
            session(sign_in(&state, &id, None).await.unwrap(), false).username,
            "alice"
        );
        id.subject = oidc_key("other-subject");
        assert!(matches!(
            sign_in(&state, &id, None).await.unwrap(),
            SignIn::NeedsUsername {
                reason: NameIssue::Taken,
                ..
            }
        ));
        db.done(state).await;
    }
}
#[tokio::test]
async fn concurrent_first_sign_ins_make_one_account() {
    for (mut state, db) in each_db("sso_concurrent").await {
        configure(&mut state, true, true);
        let id = identity();
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..10 {
            let state = state.clone();
            let id = id.clone();
            tasks.spawn(async move {
                let SignIn::Session { user, created, .. } =
                    sign_in(&state, &id, None).await.unwrap()
                else {
                    panic!("expected session")
                };
                assert_eq!(user.username, "alice");
                created
            });
        }
        let mut created = 0;
        while let Some(r) = tasks.join_next().await {
            created += usize::from(r.unwrap());
        }
        assert_eq!(created, 1);
        for query in [
            "SELECT COUNT(*) FROM users",
            "SELECT COUNT(*) FROM sso_links",
        ] {
            assert_eq!(
                sqlx::query_scalar::<_, i64>(query)
                    .fetch_one(&state.db)
                    .await
                    .unwrap(),
                1
            );
        }
        db.done(state).await;
    }
}
#[tokio::test]
async fn policy_blocks_new_accounts() {
    for (mut state, db) in each_db("sso_policy").await {
        let id = identity();
        configure(&mut state, false, true);
        denied(sign_in(&state, &id, None).await, "New accounts are closed");
        configure(&mut state, true, true);
        for value in ["closed", "sso"] {
            sqlx::query("INSERT INTO settings(key,value) VALUES('registration',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(value).execute(&state.db).await.unwrap();
            Settings::forget(&state.db);
            let result = sign_in(&state, &id, None).await;
            if value == "closed" {
                denied(result, "New accounts are closed");
            } else {
                session(result.unwrap(), true);
            }
        }
        db.done(state).await;
    }
}

#[tokio::test]
async fn name_policy_applies_to_claims_and_picked_names() {
    use crate::api::admin::{PurgeKind, finish_purge, hide_user_rows};
    for (mut state, db) in each_db("sso_picker").await {
        crate::api::test_util::profanity_on(&state.db).await;
        configure(&mut state, true, true);
        let mut id = identity();
        super::tests::account(&state, "ban").await;
        hide_user_rows(&state, "ban", PurgeKind::Ban).await.unwrap();
        finish_purge(&state, PurgeKind::Ban, "ban").await.unwrap();
        for (claim, reason, message) in [
            ("ban", NameIssue::Taken, "Username is banned"),
            (
                "fuck",
                NameIssue::Taken,
                "Content blocked by profanity filter",
            ),
            (
                "bad\u{200b}name",
                NameIssue::Invalid,
                "Username has invalid characters",
            ),
        ] {
            id.username_claim = Some(claim.into());
            assert!(
                matches!(sign_in(&state,&id,None).await.unwrap(),SignIn::NeedsUsername{reason:r,..} if r==reason)
            );
            assert!(
                matches!(sign_in(&state,&id,Some(claim)).await,Err(ApiError(StatusCode::BAD_REQUEST,s,_)) if s==message)
            );
        }
        id.username_claim = None;
        assert!(matches!(
            sign_in(&state, &id, None).await.unwrap(),
            SignIn::NeedsUsername {
                reason: NameIssue::Invalid,
                suggestion: None
            }
        ));
        db.done(state).await;
    }
}

#[tokio::test]
async fn token_issue_orders_with_suspension_and_refuses_purged_users() {
    for (mut state, db) in each_db("sso_issue").await {
        configure(&mut state, true, true);
        let other = super::tests::account(&state, "local").await;
        let id = identity();
        session(sign_in(&state, &id, None).await.unwrap(), true);
        let (issued, paused) = tokio::join!(sign_in(&state, &id, None), suspend(&state, "alice"));
        assert!(paused.unwrap());
        match issued {
            Ok(SignIn::Session { token, .. }) => assert!(
                crate::api::user_for_token(&state, &token)
                    .await
                    .unwrap()
                    .is_none()
            ),
            Err(e) => assert_eq!(e.0, StatusCode::FORBIDDEN),
            _ => panic!("expected linked account"),
        }
        assert!(
            crate::api::user_for_token(&state, &other)
                .await
                .unwrap()
                .is_some()
        );
        unsuspend(&state, "alice").await.unwrap();
        sqlx::query("UPDATE users SET password_hash='!purging' WHERE username='alice'")
            .execute(&state.db)
            .await
            .unwrap();
        denied(
            sign_in(&state, &id, None).await,
            "This account is suspended",
        );
        sqlx::query("DELETE FROM users WHERE username='alice'")
            .execute(&state.db)
            .await
            .unwrap();
        denied(
            sign_in(&state, &id, None).await,
            "This account is suspended",
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn oidc_keys_preserve_exact_subject_and_session_identity() {
    let subject = oidc_key("Subject@corp.example");
    assert_ne!(oidc_key(subject.as_str()), subject);
    assert_ne!(oidc_key(" Subject@corp.example"), subject);
    assert_eq!(
        serde_json::from_value::<OidcKey>(json!(subject.as_str())).unwrap(),
        subject
    );
    assert!(serde_json::from_value::<OidcKey>(json!("Subject@corp.example")).is_err());
    for (mut state, db) in each_db("sso_oidc_keys").await {
        configure(&mut state, true, true);
        let mut id = identity();
        session(sign_in(&state, &id, None).await.unwrap(), true);
        id.sid = Some(oidc_key("session@corp.example"));
        session(sign_in(&state, &id, None).await.unwrap(), false);
        let subjects = sqlx::query_scalar::<_, String>("SELECT subject FROM sso_links")
            .fetch_all(&state.db)
            .await
            .unwrap();
        assert_eq!(subjects, [subject.as_str()]);
        let sids = sqlx::query_scalar::<_, String>("SELECT sso_sid FROM tokens")
            .fetch_all(&state.db)
            .await
            .unwrap();
        assert_eq!(sids.len(), 2);
        for raw in ["Session@corp.example", "session@corp.example"] {
            assert!(sids.iter().any(|s| s == oidc_key(raw).as_str()));
        }
        id.subject = oidc_key("subject@corp.example");
        assert!(matches!(
            sign_in(&state, &id, None).await.unwrap(),
            SignIn::NeedsUsername {
                reason: NameIssue::Taken,
                ..
            }
        ));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tokens")
                .fetch_one(&state.db)
                .await
                .unwrap(),
            2
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn exchanged_session_cannot_authenticate_a_same_second_replacement() {
    use crate::api::admin::{PurgeKind, finish_purge, hide_user_rows};
    for (mut state, db) in each_db("sso_replacement").await {
        configure(&mut state, true, true);
        super::tests::account(&state, "local").await;
        let id = identity();
        let SignIn::Session {
            user: old, token, ..
        } = sign_in(&state, &id, None).await.unwrap()
        else {
            panic!("expected session")
        };
        assert!(
            crate::api::user_for_token(&state, &token)
                .await
                .unwrap()
                .is_some()
        );
        hide_user_rows(&state, "alice", PurgeKind::User)
            .await
            .unwrap();
        finish_purge(&state, PurgeKind::User, "alice")
            .await
            .unwrap();
        let replacement = super::tests::account(&state, "alice").await;
        sqlx::query("UPDATE users SET created_at=$1 WHERE username='alice'")
            .bind(old.created_at)
            .execute(&state.db)
            .await
            .unwrap();
        assert!(
            crate::api::user_for_token(&state, &replacement)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            crate::api::user_for_token(&state, &token)
                .await
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            sign_in(&state, &id, None).await.unwrap(),
            SignIn::NeedsUsername {
                reason: NameIssue::Taken,
                ..
            }
        ));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM tokens WHERE sso_provider IS NOT NULL"
            )
            .fetch_one(&state.db)
            .await
            .unwrap(),
            0
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn token_write_failure_rolls_back_verified_account_changes() {
    for (mut state, db) in each_db("sso_atomic_bearer").await {
        configure(&mut state, true, true);
        let id = identity();
        // Fail only the final token insert in this isolated database.
        sqlx::query("ALTER TABLE tokens RENAME TO offline_tokens")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(sign_in(&state, &id, None).await.is_err());
        for query in [
            "SELECT COUNT(*) FROM users",
            "SELECT COUNT(*) FROM sso_links",
            "SELECT COUNT(*) FROM instance_audit WHERE action='sso.sign_in'",
        ] {
            assert_eq!(
                sqlx::query_scalar::<_, i64>(query)
                    .fetch_one(&state.db)
                    .await
                    .unwrap(),
                0
            );
        }
        sqlx::query("ALTER TABLE offline_tokens RENAME TO tokens")
            .execute(&state.db)
            .await
            .unwrap();
        session(sign_in(&state, &id, None).await.unwrap(), true);
        db.done(state).await;
    }
}
