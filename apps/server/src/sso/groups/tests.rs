use super::*;
use crate::{
    api::test_util::each_db,
    config::AppConfig,
    sso::{
        Sso,
        accounts::{Identity, oidc_key, sign_in},
    },
};
use std::sync::Arc;

fn configure(state: &mut AppState) -> Identity {
    let cfg = AppConfig::from_map(&[
        ("OIDC_PROVIDERS", "one"),
        ("OIDC_ONE_ISSUER", "https://one.example"),
        ("OIDC_ONE_CLIENT_ID", "client"),
        ("PUBLIC_URL", "https://chat.example"),
        (
            "SSO_GROUP_MAP",
            r##"{"eng":[{"server":"eng","role":"dev"}],"all":[{"server":"rchat","role":"Ops"}]}"##,
        ),
    ])
    .unwrap();
    state.sso = Arc::new(Sso::new(cfg.sso).unwrap());
    Identity {
        provider: "one".into(),
        issuer: "https://one.example".into(),
        subject: oidc_key("subject"),
        username_claim: Some("alice".into()),
        scim_key: None,
        display: None,
        groups: vec![],
        sid: None,
    }
}

async fn seed(state: &AppState) {
    for sql in [
        "INSERT INTO servers(name,display_name,password_hash,created_at) VALUES('eng','Eng','protected',1)",
        "INSERT INTO roles(server,name,color) VALUES('eng','Dev','blue'),('rchat','Ops','red')",
    ] {
        sqlx::query(sql).execute(&state.db).await.unwrap();
    }
}

async fn count(state: &AppState, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(&state.db).await.unwrap()
}

#[tokio::test]
async fn sign_in_adds_and_removes_only_managed_grants() {
    for (mut state, temp) in each_db("sso_group_login").await {
        let mut id = configure(&mut state);
        seed(&state).await;
        sign_in(&state, &id, None).await.unwrap();
        sqlx::query("INSERT INTO user_roles(server,username,role_id) SELECT server,'alice',id FROM roles WHERE name='Ops'").execute(&state.db).await.unwrap();
        let mut events = state.hub.subscribe();
        id.groups = vec!["eng".into(), "all".into(), "secret-project".into()];
        sign_in(&state, &id, None).await.unwrap();
        assert_eq!(
            effective_groups(&state.db, "alice").await.unwrap(),
            BTreeSet::from(["eng".into(), "all".into()])
        );
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 2);
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM user_roles WHERE username='alice'"
            )
            .await,
            2
        );
        let mut joined = false;
        while let Ok(e) = events.try_recv() {
            joined |= matches!(e,WsEvent::MemberJoined{server,..} if server=="eng");
        }
        assert!(joined);
        assert_eq!(
            reconcile(&state, "alice").await.unwrap(),
            Reconciled::default()
        );
        id.groups.clear();
        sign_in(&state, &id, None).await.unwrap();
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 0);
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM members WHERE username='alice' AND server='eng'"
            )
            .await,
            0
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM members WHERE username='alice' AND server='rchat'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM user_roles WHERE username='alice' AND server='rchat'"
            )
            .await,
            1
        );
        assert_eq!(count(&state,"SELECT COUNT(DISTINCT action) FROM instance_audit WHERE actor='sso' AND target='alice' AND action IN ('sso.group_join','sso.group_leave','sso.role_grant','sso.role_revoke')").await,4);
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM instance_audit WHERE detail LIKE '%secret-project%'"
            )
            .await,
            0
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn scim_reconciles_concurrently_and_preserves_suspension_and_ban() {
    for (mut state, temp) in each_db("sso_group_scim").await {
        let id = configure(&mut state);
        seed(&state).await;
        sign_in(&state, &id, None).await.unwrap();
        for sql in [
            "INSERT INTO scim_groups(id,display_name,external_id,created_at,updated_at) VALUES('1','Team','eng',1,1)",
            "INSERT INTO scim_group_members VALUES('1','alice')",
        ] {
            sqlx::query(sql).execute(&state.db).await.unwrap();
        }
        assert_eq!(
            effective_groups(&state.db, "alice").await.unwrap(),
            BTreeSet::from(["Team".into(), "eng".into()])
        );
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..10 {
            let state = state.clone();
            tasks.spawn(async move { reconcile(&state, "alice").await.unwrap() });
        }
        let mut total = 0;
        while let Some(r) = tasks.join_next().await {
            total += r.unwrap().joined.len();
        }
        assert_eq!(total, 1);
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 2);
        sqlx::query("UPDATE users SET suspended_at=1 WHERE username='alice'")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM scim_group_members")
            .execute(&state.db)
            .await
            .unwrap();
        assert_eq!(reconcile_all(&state).await.unwrap(), 1);
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 2);
        sqlx::query("UPDATE users SET suspended_at=NULL WHERE username='alice'")
            .execute(&state.db)
            .await
            .unwrap();
        assert_eq!(reconcile_all(&state).await.unwrap(), 1);
        for sql in [
            "INSERT INTO scim_group_members VALUES('1','alice')",
            "INSERT INTO server_bans(server,username,created_at) VALUES('eng','alice',1)",
        ] {
            sqlx::query(sql).execute(&state.db).await.unwrap();
        }
        assert_eq!(
            reconcile(&state, "alice").await.unwrap(),
            Reconciled::default()
        );
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 0);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn map_changes_skip_unknown_and_ambiguous_targets_and_keep_manual_roles() {
    use crate::sso::config::GroupGrant;
    for (mut state, temp) in each_db("sso_group_map").await {
        let mut id = configure(&mut state);
        seed(&state).await;
        let grants = Arc::get_mut(&mut state.sso)
            .unwrap()
            .config
            .group_map
            .0
            .get_mut("eng")
            .unwrap();
        grants.push(GroupGrant {
            server: "missing".into(),
            role: None,
        });
        grants.push(GroupGrant {
            server: "rchat".into(),
            role: Some("Missing".into()),
        });
        id.groups.push("eng".into());
        sqlx::query("INSERT INTO roles(server,name,color) VALUES('eng','DEV','blue')")
            .execute(&state.db)
            .await
            .unwrap();
        sign_in(&state, &id, None).await.unwrap();
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 0);
        sqlx::query("DELETE FROM roles WHERE name='DEV'")
            .execute(&state.db)
            .await
            .unwrap();
        assert_eq!(reconcile_all(&state).await.unwrap(), 1);
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 2);
        sqlx::query("INSERT INTO roles(server,name,color) VALUES('eng','Support','red')")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_roles(server,username,role_id) SELECT server,'alice',id FROM roles WHERE name='Support'").execute(&state.db).await.unwrap();
        Arc::get_mut(&mut state.sso)
            .unwrap()
            .config
            .group_map
            .0
            .clear();
        assert_eq!(reconcile_all(&state).await.unwrap(), 1);
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 0);
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM members WHERE server='eng' AND username='alice'"
            )
            .await,
            1
        );
        assert_eq!(count(&state,"SELECT COUNT(*) FROM user_roles u JOIN roles r ON u.role_id=r.id WHERE r.name='Support' AND u.username='alice'").await,1);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_bulk_failure_reconciles_the_later_accounts() {
    for (mut state, temp) in each_db("sso_group_bulk").await {
        let mut id = configure(&mut state);
        seed(&state).await;
        sign_in(&state, &id, None).await.unwrap();
        id.username_claim = Some("zoe".into());
        id.subject = oidc_key("other");
        sign_in(&state, &id, None).await.unwrap();
        // Alice needs a second membership. Zoe's mapped role uses her existing membership.
        Arc::make_mut(&mut state.limits).servers_per_account = 1;
        sqlx::query("INSERT INTO sso_user_groups(username,source,grp) VALUES('alice','one','eng'),('zoe','one','all')")
            .execute(&state.db).await.unwrap();
        let error = reconcile_all(&state).await.unwrap_err();
        assert_eq!(
            error.2.unwrap().control.as_deref(),
            Some("servers_per_account")
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM sso_grants WHERE username='zoe'"
            )
            .await,
            1
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn post_commit_notification_error_preserves_login_and_role_event() {
    for (mut state, temp) in each_db("sso_group_notify").await {
        let mut id = configure(&mut state);
        seed(&state).await;
        sign_in(&state, &id, None).await.unwrap();
        id.groups.push("eng".into());
        sqlx::query("ALTER TABLE member_timeouts RENAME TO unavailable_timeouts")
            .execute(&state.db)
            .await
            .unwrap();
        let mut events = state.hub.subscribe();
        let crate::sso::accounts::SignIn::Session { token, .. } =
            sign_in(&state, &id, None).await.unwrap()
        else {
            panic!("linked account must receive a session");
        };
        assert!(
            sqlx::query("SELECT 1 FROM tokens WHERE username='alice' AND token=$1")
                .bind(db::secret_key(&token))
                .fetch_optional(&state.db)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 2);
        let mut changed = false;
        while let Ok(event) = events.try_recv() {
            changed |= matches!(event, WsEvent::RolesChanged{server} if server=="eng");
        }
        assert!(changed);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn concurrent_unban_keeps_the_desired_grants() {
    for (mut state, temp) in each_db("sso_group_unban").await {
        let mut id = configure(&mut state);
        seed(&state).await;
        id.groups.push("eng".into());
        sign_in(&state, &id, None).await.unwrap();
        sqlx::query("INSERT INTO server_bans(server,username,created_at) VALUES('eng','alice',1)")
            .execute(&state.db)
            .await
            .unwrap();

        // Pause after observing the ban, then run the production moderation handler.
        // The handler must wait for an existing server writer, and the subsequent
        // reconciliation must retry the earlier denial after the unban commits.
        let unban = async {
            let mut writer = begin_account_write(&state.db).await.unwrap();
            db::lock_server(&mut writer, "eng").await.unwrap();
            let mut handler = Box::pin(servers::unban_member(
                axum::extract::State(state.clone()),
                crate::api::Authed(crate::api::test_util::mem_user("root", true)),
                axum::extract::Path(("eng".into(), "alice".into())),
            ));
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(200), &mut handler)
                    .await
                    .is_err()
            );
            writer.commit().await.unwrap();
            let _ = handler.await.unwrap();
        };
        assert_eq!(
            reconcile_after_lookup(&state, "alice", unban)
                .await
                .unwrap(),
            Reconciled::default()
        );
        assert_eq!(count(&state, "SELECT COUNT(*) FROM sso_grants").await, 2);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn membership_limit_commits_withdrawals_and_announces_them() {
    for (mut state, temp) in each_db("sso_group_cap_withdrawal").await {
        let mut id = configure(&mut state);
        seed(&state).await;
        Arc::get_mut(&mut state.sso)
            .unwrap()
            .config
            .group_map
            .0
            .insert(
                "other".into(),
                vec![crate::sso::config::GroupGrant {
                    server: "other".into(),
                    role: None,
                }],
            );
        sqlx::query("INSERT INTO servers(name,display_name,password_hash,created_at) VALUES('other','Other','protected',1)").execute(&state.db).await.unwrap();
        id.groups = vec!["eng".into()];
        sign_in(&state, &id, None).await.unwrap();
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM sso_grants WHERE server='eng'").await,
            2
        );
        Arc::make_mut(&mut state.limits).servers_per_account = 1;
        id.groups = vec!["other".into()];
        let mut events = state.hub.subscribe();
        let Err(error) = sign_in(&state, &id, None).await else {
            panic!("expected account limit")
        };
        assert!(is_membership_limit(&error));
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM members WHERE server IN ('eng','other') AND username='alice'"
            )
            .await,
            0
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM user_roles WHERE server='eng' AND username='alice'"
            )
            .await,
            0
        );
        assert_eq!(count(&state,"SELECT COUNT(*) FROM instance_audit WHERE target='alice' AND action IN ('sso.group_leave','sso.role_revoke')").await,2);
        let (mut left, mut roles) = (false, false);
        while let Ok(event) = events.try_recv() {
            match event {
                WsEvent::MemberLeft { server, username }
                    if server == "eng" && username == "alice" =>
                {
                    left = true
                }
                WsEvent::RolesChanged { server } if server == "eng" => roles = true,
                _ => {}
            }
        }
        assert!(left && roles);
        temp.done(state).await;
    }
}
