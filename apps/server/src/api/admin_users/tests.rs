use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::Row;

use super::{CreatedAccount, PASSWORDS_OFF, add_to_server, create_account};
use crate::api::admin::{PurgeKind, ban_in, finish_purge, hide_user_rows};
use crate::api::auth::{LoginReq, login_at};
use crate::api::test_util::{each_db, mem_user, profanity_on, site_sets};
use crate::api::{ApiError, Authed, CHANGE_FIRST, ReasonKind};
use crate::db::{NewUser, get_user, now, temp_password};
use crate::state::AppState;
use crate::ws::WsEvent;

fn root() -> Authed {
    Authed(mem_user("root", true))
}

fn says(e: ApiError) -> (StatusCode, String) {
    let ApiError(status, error, _) = e;
    (status, error)
}

async fn exec(state: &AppState, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(&state.db)
        .await
        .expect(sql);
}

async fn count(state: &AppState, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(&state.db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("count")
}

async fn create(state: &AppState, who: Authed, body: Value) -> Result<CreatedAccount, ApiError> {
    let req = serde_json::from_value(body).expect("request");
    create_account(State(state.clone()), who, Json(req))
        .await
        .map(|Json(made)| made)
}

async fn refusal(state: &AppState, body: Value) -> (StatusCode, String) {
    match create(state, root(), body).await {
        Ok(made) => panic!("created {}", made.user.username),
        Err(e) => says(e),
    }
}

/// An instance with the site admin `root`, a server `club` with a password and the role
/// `Helper`, and a server `lobby` with the role `Guide`. Answers the two role ids.
async fn seed(state: &AppState) -> (i64, i64) {
    NewUser::plain("root")
        .admin(true)
        .at(1)
        .add(&state.db)
        .await;
    for (name, hash) in [("club", "'x'"), ("lobby", "NULL")] {
        exec(
            state,
            &format!("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('{name}', '{name}', {hash}, 1)"),
        )
        .await;
        exec(
            state,
            &format!(
                "INSERT INTO channels(server, name, created_at) VALUES('{name}', 'general', 1)"
            ),
        )
        .await;
    }
    let role = |server: &'static str, name: &'static str| {
        let state = state.clone();
        async move {
            sqlx::query(
                "INSERT INTO roles(server, name, color) VALUES($1, $2, '#112233') RETURNING id",
            )
            .bind(server)
            .bind(name)
            .fetch_one(&state.db)
            .await
            .expect("role")
            .try_get::<i64, _>(0)
            .expect("id")
        }
    };
    (role("club", "Helper").await, role("lobby", "Guide").await)
}

async fn servers_of(state: &AppState, name: &str) -> Vec<String> {
    sqlx::query("SELECT server FROM members WHERE username = $1 ORDER BY server")
        .bind(name)
        .fetch_all(&state.db)
        .await
        .expect("members")
        .iter()
        .map(|r| r.try_get(0).expect("server"))
        .collect()
}

#[tokio::test]
async fn an_account_is_made_with_a_temporary_password_and_its_servers() {
    for (state, db) in each_db("admin_create").await {
        let (helper, guide) = seed(&state).await;
        let mut rx = state.hub.subscribe();
        let before = now();
        let made = create(
            &state,
            root(),
            json!({"username": "Dana", "display_name": " Dana R. ", "servers": [
                {"server": "Club", "roles": [helper]},
                {"server": "nowhere"},
                {"server": "lobby", "roles": [helper]},
                {"server": "lobby", "roles": [guide]},
            ]}),
        )
        .await
        .expect("create");
        assert_eq!(
            (made.user.username.as_str(), made.user.display_name.as_str()),
            ("dana", "Dana R.")
        );
        let expires = made.expires_at.expect("72 hours by default");
        assert!((before + 72 * 3600..=now() + 72 * 3600).contains(&expires));
        let results: Vec<(String, bool, Option<String>)> = made
            .servers
            .into_iter()
            .map(|r| (r.server, r.ok, r.error))
            .collect();
        assert_eq!(
            results,
            [
                ("club".to_string(), true, None),
                (
                    "nowhere".to_string(),
                    false,
                    Some("Server not found or wrong password".to_string())
                ),
                (
                    "lobby".to_string(),
                    false,
                    Some("Role not found".to_string())
                ),
                ("lobby".to_string(), true, None),
            ],
            "one server that fails leaves the account and the others"
        );
        assert_eq!(servers_of(&state, "dana").await, ["club", "lobby", "rchat"]);
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM members WHERE username = 'dana' AND joined_via IS NULL AND is_admin = 0").await,
            3
        );
        assert_eq!(
            count(&state, &format!("SELECT COUNT(*) FROM user_roles WHERE username = 'dana' AND ((server = 'club' AND role_id = {helper}) OR (server = 'lobby' AND role_id = {guide}))")).await,
            2
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM user_roles WHERE username = 'dana'"
            )
            .await,
            2
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM messages WHERE author = 'dana' AND kind = 'join'"
            )
            .await,
            3,
            "each server gets its join message"
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM dms WHERE user_a = 'dana' AND user_b = 'dana'"
            )
            .await,
            1
        );
        let dana = get_user(&state.db, "dana")
            .await
            .expect("load")
            .expect("dana");
        assert!(!dana.is_site_admin);
        assert_eq!(dana.password_kind, "text");
        assert!(dana.password_hash.starts_with("$argon2"));
        assert_eq!(
            temp_password(&state.db, "dana")
                .await
                .expect("mark")
                .map(|t| t.expires_at),
            Some(Some(expires))
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM temp_passwords WHERE username = 'dana' AND issued_by = 'root'"
            )
            .await,
            1
        );
        let mut joined = Vec::new();
        let mut registered = 0;
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::MemberJoined { server, member } if member.user.username == "dana" => {
                    joined.push(server)
                }
                WsEvent::UserRegistered { user } if user.username == "dana" => registered += 1,
                _ => {}
            }
        }
        joined.sort();
        assert_eq!(
            (joined, registered),
            (
                vec!["club".to_string(), "lobby".to_string(), "rchat".to_string()],
                1
            )
        );
        let audit: Vec<(String, String, String, String)> = sqlx::query("SELECT COALESCE(actor, ''), action, COALESCE(target, ''), detail FROM instance_audit ORDER BY id")
            .fetch_all(&state.db)
            .await
            .expect("audit")
            .iter()
            .map(|r| (r.try_get(0).expect("actor"), r.try_get(1).expect("action"), r.try_get(2).expect("target"), r.try_get(3).expect("detail")))
            .collect();
        assert_eq!(audit.len(), 2, "{audit:?}");
        assert_eq!(
            (
                audit[0].0.as_str(),
                audit[0].1.as_str(),
                audit[0].2.as_str()
            ),
            ("root", "user.create", "dana")
        );
        assert_eq!(
            (
                audit[1].0.as_str(),
                audit[1].1.as_str(),
                audit[1].2.as_str(),
                audit[1].3.as_str()
            ),
            ("root", "staff.view_server", "club", "{}"),
            "adding the account to a server the admin is not in opens it with instance powers"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&audit[0].3).expect("detail"),
            json!({"display_name": "Dana R.", "servers": ["Club", "nowhere", "lobby", "lobby"]})
        );
        assert!(
            !audit[0].3.contains(&made.temp_password),
            "the log never holds the password"
        );

        let login: LoginReq =
            serde_json::from_value(json!({"username": "dana", "password": made.temp_password}))
                .expect("login");
        let Json(session) = login_at(&state, login, now())
            .await
            .expect("the temporary password signs in");
        assert_eq!(
            serde_json::to_value(session.user.password_temporary).expect("json"),
            json!({"expires_at": expires, "change": "required"})
        );
        let Err(ApiError(status, error, _)) =
            crate::api::user_for_token(&state, &session.token).await
        else {
            panic!("the session is not restricted");
        };
        assert_eq!(
            (status, error.as_str()),
            (StatusCode::FORBIDDEN, CHANGE_FIRST)
        );

        let plain = create(
            &state,
            root(),
            json!({"username": "Eve", "display_name": "  "}),
        )
        .await
        .expect("without a display name");
        assert_eq!(
            (
                plain.user.username.as_str(),
                plain.user.display_name.as_str()
            ),
            ("eve", "Eve")
        );
        assert!(plain.servers.is_empty());
        assert_eq!(servers_of(&state, "eve").await, ["rchat"]);
        assert_ne!(plain.temp_password, made.temp_password);
        db.done(state).await;
    }
}

#[tokio::test]
async fn new_accounts_follow_the_rules_of_sign_up() {
    for (state, db) in each_db("admin_create_rules").await {
        seed(&state).await;
        create(&state, root(), json!({"username": "dana"}))
            .await
            .expect("dana");
        let bad = |msg: &str| (StatusCode::BAD_REQUEST, msg.to_string());
        assert_eq!(
            refusal(&state, json!({"username": "DANA"})).await,
            bad("Username is taken")
        );
        assert_eq!(
            refusal(&state, json!({"username": "root"})).await,
            bad("Username is taken")
        );
        assert_eq!(
            refusal(&state, json!({"username": "a@b"})).await,
            bad("Usernames can't contain @")
        );
        assert_eq!(
            refusal(&state, json!({"username": "a\u{0}b"})).await,
            bad("Username required")
        );
        assert_eq!(
            refusal(&state, json!({"username": "  "})).await,
            bad("Username required")
        );
        assert_eq!(
            refusal(&state, json!({"username": "a\u{200b}b"})).await,
            bad("Username has invalid characters")
        );
        assert_eq!(
            refusal(&state, json!({"username": "x".repeat(101)})).await,
            bad("Username must be at most 100 characters")
        );
        assert_eq!(
            refusal(
                &state,
                json!({"username": "frank", "display_name": "y".repeat(33)})
            )
            .await,
            bad("Display name must be at most 32 characters")
        );
        assert_eq!(
            refusal(&state, json!({"username": "frank", "display_name": "Dana"})).await,
            bad("Username is taken"),
            "a display name can not pass for another account"
        );
        NewUser::plain("mallory").at(2).add(&state.db).await;
        let mut tx = state.db.begin().await.expect("begin");
        ban_in(&mut tx, "mallory").await.expect("ban");
        tx.commit().await.expect("commit");
        finish_purge(&state, PurgeKind::Ban, "mallory")
            .await
            .expect("purge");
        assert_eq!(
            refusal(&state, json!({"username": "Mallory"})).await,
            bad("Username is banned")
        );
        profanity_on(&state.db).await;
        assert_eq!(
            refusal(&state, json!({"username": "fuckface"})).await,
            bad("Content blocked by profanity filter")
        );
        assert_eq!(
            refusal(
                &state,
                json!({"username": "gina", "display_name": "fuckface"})
            )
            .await,
            bad("Content blocked by profanity filter")
        );
        let many: Vec<Value> = (0..21)
            .map(|n| json!({"server": format!("s{n}")}))
            .collect();
        assert_eq!(
            refusal(&state, json!({"username": "gina", "servers": many})).await,
            bad("At most 20 servers")
        );
        let roles: Vec<i64> = (0..21).collect();
        assert_eq!(
            refusal(
                &state,
                json!({"username": "gina", "servers": [{"server": "club", "roles": roles}]})
            )
            .await,
            bad("At most 20 roles in a server")
        );
        for name in ["frank", "gina", "mallory", "fuckface"] {
            assert!(
                get_user(&state.db, name).await.expect("load").is_none(),
                "{name}"
            );
        }
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM temp_passwords").await,
            1
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn accounts_are_made_in_every_sign_up_mode_but_not_without_passwords() {
    for (state, db) in each_db("admin_create_modes").await {
        seed(&state).await;
        let hidden = create(
            &state,
            Authed(mem_user("bob", false)),
            json!({"username": "zed"}),
        )
        .await
        .map(|_| ())
        .map_err(says);
        assert_eq!(
            hidden,
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        for (n, mode) in ["closed", "sso", "open"].into_iter().enumerate() {
            site_sets(&state, json!({"registration": mode})).await;
            create(&state, root(), json!({"username": format!("user{n}")}))
                .await
                .expect(mode);
        }
        site_sets(
            &state,
            json!({"default_servers": ["lobby", "club", "gone"]}),
        )
        .await;
        create(&state, root(), json!({"username": "wide"}))
            .await
            .expect("wide");
        assert_eq!(
            servers_of(&state, "wide").await,
            ["club", "lobby"],
            "the default servers of the moment, a missing one skipped"
        );
        site_sets(&state, json!({"password_login": false})).await;
        let Err(ApiError(status, error, reason)) =
            create(&state, root(), json!({"username": "late"})).await
        else {
            panic!("made an account nobody can sign in to");
        };
        assert_eq!(
            (status, error.as_str()),
            (StatusCode::BAD_REQUEST, PASSWORDS_OFF)
        );
        let reason = reason.expect("reason");
        assert_eq!(
            (reason.kind, reason.control.as_deref()),
            (ReasonKind::OffSite, Some("password_login"))
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM users WHERE is_site_admin <> 0"
            )
            .await,
            1,
            "none of the new accounts is a site admin"
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn an_account_is_added_to_a_server_whatever_joining_allows() {
    for (state, db) in each_db("admin_add_member").await {
        let (helper, guide) = seed(&state).await;
        NewUser::plain("dana").at(2).add(&state.db).await;
        NewUser::plain("bob").at(2).add(&state.db).await;
        site_sets(&state, json!({"server_joining": "nobody"})).await;
        let add = |who: Authed, name: &'static str, body: Value| {
            let state = state.clone();
            async move {
                add_to_server(
                    State(state),
                    who,
                    Path(name.to_string()),
                    Json(serde_json::from_value(body).expect("request")),
                )
                .await
                .map(|_| ())
                .map_err(says)
            }
        };
        let mut rx = state.hub.subscribe();
        add(root(), "Dana", json!({"server": "Club", "roles": [helper]}))
            .await
            .expect("added");
        assert_eq!(servers_of(&state, "dana").await, ["club"]);
        assert_eq!(
            count(&state, &format!("SELECT COUNT(*) FROM user_roles WHERE server = 'club' AND username = 'dana' AND role_id = {helper}")).await,
            1
        );
        let mut joined = 0;
        while let Ok(ev) = rx.try_recv() {
            if matches!(&ev, WsEvent::MemberJoined { server, member } if server == "club" && member.user.username == "dana")
            {
                joined += 1;
            }
        }
        assert_eq!(joined, 1);
        assert_eq!(
            count(&state, &format!("SELECT COUNT(*) FROM instance_audit WHERE actor = 'root' AND action = 'server.add_member' AND target = 'dana' AND detail = '{{\"roles\":[{helper}],\"server\":\"club\"}}'")).await,
            1
        );
        add(root(), "dana", json!({"server": "club"}))
            .await
            .expect("a member already");
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM members WHERE username = 'dana'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &state,
                "SELECT member_count FROM servers WHERE name = 'club'"
            )
            .await,
            1
        );
        let missing = Err((StatusCode::NOT_FOUND, "Not found".to_string()));
        assert_eq!(
            add(root(), "ghost", json!({"server": "club"})).await,
            missing
        );
        assert_eq!(
            add(
                Authed(mem_user("bob", false)),
                "dana",
                json!({"server": "lobby"})
            )
            .await,
            missing
        );
        assert_eq!(
            add(root(), "dana", json!({"server": "nowhere"})).await,
            Err((
                StatusCode::NOT_FOUND,
                "Server not found or wrong password".to_string()
            ))
        );
        assert_eq!(
            add(
                root(),
                "dana",
                json!({"server": "lobby", "roles": [helper]})
            )
            .await,
            Err((StatusCode::NOT_FOUND, "Role not found".to_string()))
        );
        assert_eq!(
            servers_of(&state, "dana").await,
            ["club"],
            "a role of another server changes nothing"
        );
        exec(
            &state,
            "INSERT INTO server_bans(server, username, created_at) VALUES('lobby', 'dana', 1)",
        )
        .await;
        let banned = add(root(), "dana", json!({"server": "lobby", "roles": [guide]})).await;
        assert_eq!(
            banned.map_err(|(status, _)| status),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(servers_of(&state, "dana").await, ["club"]);

        hide_user_rows(&state, "dana", PurgeKind::User)
            .await
            .expect("hide");
        finish_purge(&state, PurgeKind::User, "dana")
            .await
            .expect("purge");
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM instance_audit WHERE action = 'server.add_member' AND target IS NULL").await,
            2,
            "the log forgets who was added"
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM instance_audit WHERE target = 'dana'"
            )
            .await,
            0
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn a_deleted_account_leaves_no_display_name_in_the_log() {
    for (state, db) in each_db("admin_create_forget").await {
        seed(&state).await;
        create(
            &state,
            root(),
            json!({"username": "dana", "display_name": "Dana R."}),
        )
        .await
        .expect("dana");
        hide_user_rows(&state, "dana", PurgeKind::User)
            .await
            .expect("hide");
        finish_purge(&state, PurgeKind::User, "dana")
            .await
            .expect("purge");
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM instance_audit WHERE action = 'user.create' AND target IS NULL AND detail = '{}'").await,
            1
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM instance_audit WHERE detail LIKE '%Dana%'"
            )
            .await,
            0
        );
        db.done(state).await;
    }
}
