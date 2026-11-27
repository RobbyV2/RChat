use axum::Json;
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::Row;

use super::{
    Created, UserCommand, act, announce_resets, create_user, printed, reset_password, run,
};
use crate::api::auth::{LoginReq, login_at};
use crate::api::temp_passwords::Issued;
use crate::api::test_util::{done, each_db, site_sets, temp_state};
use crate::api::{ApiError, CHANGE_FIRST};
use crate::db::{Db, get_user, now, secret_key, temp_password};
use crate::limits::Limits;
use crate::state::AppState;
use crate::ws::WsEvent;

async fn count(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("count")
}

async fn sign_in(state: &AppState, name: &str, password: &str) -> Result<String, ApiError> {
    let req: LoginReq =
        serde_json::from_value(json!({"username": name, "password": password})).expect("login");
    login_at(state, req, now())
        .await
        .map(|Json(resp)| resp.token)
}

fn says(e: ApiError) -> (StatusCode, String) {
    let ApiError(status, error, _) = e;
    (status, error)
}

#[tokio::test]
async fn the_first_account_administers_the_site_and_later_ones_do_not() {
    for (state, db) in each_db("cli_create").await {
        site_sets(&state, json!({"registration": "closed"})).await;
        let limits = Limits::default();
        let Created {
            username,
            first,
            issued,
        } = create_user(&state.db, &limits, "Olive", None)
            .await
            .expect("the first account, with sign-up closed");
        assert_eq!((username.as_str(), first), ("olive", true));
        let olive = get_user(&state.db, "olive")
            .await
            .expect("load")
            .expect("olive");
        assert!(olive.is_site_admin);
        assert_eq!(olive.display_name, "Olive");
        let second = create_user(&state.db, &limits, "dana", Some(" Dana R. "))
            .await
            .expect("a second account");
        assert!(!second.first);
        let dana = get_user(&state.db, "dana")
            .await
            .expect("load")
            .expect("dana");
        assert!(!dana.is_site_admin);
        assert_eq!(dana.display_name, "Dana R.");
        assert_eq!(
            count(
                &state.db,
                "SELECT COUNT(*) FROM users WHERE is_site_admin <> 0"
            )
            .await,
            1
        );
        for name in ["olive", "dana"] {
            assert_eq!(
                count(&state.db, &format!("SELECT COUNT(*) FROM members WHERE server = 'rchat' AND username = '{name}'")).await,
                1,
                "{name} joined the default server"
            );
            assert_eq!(
                count(
                    &state.db,
                    &format!(
                        "SELECT COUNT(*) FROM dms WHERE user_a = '{name}' AND user_b = '{name}'"
                    )
                )
                .await,
                1
            );
            assert_eq!(
                count(&state.db, &format!("SELECT COUNT(*) FROM temp_passwords WHERE username = '{name}' AND issued_by IS NULL")).await,
                1
            );
        }
        let audit: Vec<(Option<String>, String, String, Value)> = sqlx::query(
            "SELECT actor, action, target, detail FROM instance_audit WHERE action = 'user.create' ORDER BY id",
        )
        .fetch_all(&state.db)
        .await
        .expect("audit")
        .iter()
        .map(|r| {
            (
                r.try_get(0).expect("actor"),
                r.try_get(1).expect("action"),
                r.try_get(2).expect("target"),
                serde_json::from_str(&r.try_get::<String, _>(3).expect("detail")).expect("json"),
            )
        })
        .collect();
        assert_eq!(
            audit,
            [
                (
                    None,
                    "user.create".to_string(),
                    "olive".to_string(),
                    json!({"by": "cli", "display_name": "Olive", "servers": []})
                ),
                (
                    None,
                    "user.create".to_string(),
                    "dana".to_string(),
                    json!({"by": "cli", "display_name": "Dana R.", "servers": []})
                ),
            ]
        );
        let token = sign_in(&state, "olive", &issued.temp_password)
            .await
            .expect("signs in");
        let Err(ApiError(status, error, _)) = crate::api::user_for_token(&state, &token).await
        else {
            panic!("the session is not restricted");
        };
        assert_eq!(
            (status, error.as_str()),
            (StatusCode::FORBIDDEN, CHANGE_FIRST)
        );
        assert_eq!(
            create_user(&state.db, &limits, "OLIVE", None)
                .await
                .map(|_| ())
                .map_err(says),
            Err((StatusCode::BAD_REQUEST, "Username is taken".to_string()))
        );
        assert_eq!(
            create_user(&state.db, &limits, "a@b", None)
                .await
                .map(|_| ())
                .map_err(says),
            Err((
                StatusCode::BAD_REQUEST,
                "Usernames can't contain @".to_string()
            ))
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn a_reset_at_the_command_line_ends_sessions_and_reaches_a_running_server() {
    for (state, db) in each_db("cli_reset").await {
        let limits = Limits::default();
        let olive = create_user(&state.db, &limits, "olive", None)
            .await
            .expect("olive");
        create_user(&state.db, &limits, "dana", None)
            .await
            .expect("dana");
        sqlx::query("UPDATE temp_passwords SET issued_at = issued_at - 100000")
            .execute(&state.db)
            .await
            .expect("age");
        for (name, token) in [("olive", "o1"), ("olive", "o2"), ("dana", "d1")] {
            sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, $3)")
                .bind(secret_key(token))
                .bind(name)
                .bind(now())
                .execute(&state.db)
                .await
                .expect("token");
        }
        site_sets(
            &state,
            json!({"registration": "closed", "password_login": false, "temp_password_hours": 0}),
        )
        .await;
        let mut rx = state.hub.subscribe();
        assert_eq!(announce_resets(&state).await.expect("nothing new"), 0);
        let issued = reset_password(&state.db, "Olive")
            .await
            .expect("the site admin too");
        assert_eq!(issued.expires_at, None);
        assert_ne!(issued.temp_password, olive.issued.temp_password);
        assert_eq!(
            count(
                &state.db,
                "SELECT COUNT(*) FROM tokens WHERE username = 'olive'"
            )
            .await,
            0
        );
        assert_eq!(
            count(
                &state.db,
                "SELECT COUNT(*) FROM tokens WHERE username = 'dana'"
            )
            .await,
            1
        );
        assert!(
            get_user(&state.db, "olive")
                .await
                .expect("load")
                .expect("olive")
                .is_site_admin
        );
        assert_eq!(
            temp_password(&state.db, "olive")
                .await
                .expect("mark")
                .map(|t| t.expires_at),
            Some(None)
        );
        assert_eq!(
            count(&state.db, "SELECT COUNT(*) FROM instance_audit WHERE action = 'user.temp_password' AND actor IS NULL AND target = 'olive' AND detail LIKE '%\"by\":\"cli\"%'").await,
            1
        );
        assert!(
            rx.try_recv().is_err(),
            "the command line reaches no socket by itself"
        );
        assert_eq!(announce_resets(&state).await.expect("announce"), 1);
        assert!(
            matches!(rx.try_recv(), Ok(WsEvent::TokensRevoked { username }) if username == "olive")
        );
        assert!(rx.try_recv().is_err());
        sign_in(&state, "olive", &issued.temp_password)
            .await
            .expect("the new password");
        assert_eq!(
            reset_password(&state.db, "ghost")
                .await
                .map(|_| ())
                .map_err(says),
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        db.done(state).await;
    }
}

#[tokio::test]
async fn the_commands_print_the_password_once_with_its_lifetime() {
    let (state, path) = temp_state("cli_print").await;
    let limits = Limits::default();
    let out = act(
        &state.db,
        &limits,
        UserCommand::Create {
            name: "Olive".to_string(),
            display_name: None,
        },
    )
    .await
    .expect("create");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 4, "{out}");
    assert_eq!(lines[0], "Created the account olive.");
    assert_eq!(
        lines[1],
        "It is the first account, so it administers this site."
    );
    let password = lines[2]
        .strip_prefix("Temporary password: ")
        .expect("password line");
    sign_in(&state, "olive", password)
        .await
        .expect("the printed password signs in");
    assert_eq!(
        lines[3],
        "It signs in for 72 hours. It is shown only now. The account chooses its own password after signing in."
    );
    let out = act(
        &state.db,
        &limits,
        UserCommand::Create {
            name: "dana".to_string(),
            display_name: Some("Dana".to_string()),
        },
    )
    .await
    .expect("dana");
    assert_eq!(out.lines().count(), 3, "{out}");
    let out = act(
        &state.db,
        &limits,
        UserCommand::ResetPassword {
            name: "DANA".to_string(),
        },
    )
    .await
    .expect("reset");
    assert!(
        out.starts_with(
            "Reset the password of dana. Its sessions are signed out.\nTemporary password: "
        ),
        "{out}"
    );
    let issued = Issued {
        temp_password: "abcd-efgh".to_string(),
        expires_at: None,
    };
    assert_eq!(
        printed(&issued, 0),
        "Temporary password: abcd-efgh\nIt does not expire. It is shown only now. The account chooses its own password after signing in."
    );
    assert!(
        printed(
            &Issued {
                expires_at: Some(5),
                ..issued
            },
            1
        )
        .contains("for 1 hour.")
    );
    done(state, path).await;
}

#[tokio::test]
async fn the_tool_leaves_the_settings_and_their_config_records_alone() {
    let path = crate::db::temp_db_path("cli_records");
    let url = path.to_str().expect("path").to_string();
    let server = crate::config::AppConfig::from_map(&[
        ("DATABASE_URL", url.as_str()),
        ("AUTH_REGISTRATION", "closed"),
        ("TEMP_PASSWORD_HOURS", "5"),
    ])
    .expect("server config");
    let db = crate::db::open_with(Some(&url), &server.db_options())
        .await
        .expect("start");
    let records = |db: Db| async move {
        sqlx::query("SELECT key, value FROM settings WHERE key LIKE 'env:%' OR key IN ('registration', 'temp_password_hours') ORDER BY key")
            .fetch_all(&db)
            .await
            .expect("records")
            .iter()
            .map(|r| (r.try_get::<String, _>(0).expect("key"), r.try_get::<String, _>(1).expect("value")))
            .collect::<Vec<_>>()
    };
    let before = records(db.clone()).await;
    assert!(
        before.contains(&("env:registration".to_string(), "closed".to_string())),
        "{before:?}"
    );
    crate::db::close(&db).await;
    let tool =
        crate::config::AppConfig::from_map(&[("DATABASE_URL", url.as_str())]).expect("tool config");
    let out = run(
        &tool,
        UserCommand::Create {
            name: "olive".to_string(),
            display_name: None,
        },
    )
    .await
    .expect("the tool runs without the server's settings in its env");
    assert!(out.contains("It signs in for 5 hours."), "{out}");
    let refused = run(
        &tool,
        UserCommand::ResetPassword {
            name: "nobody".to_string(),
        },
    )
    .await
    .expect_err("no such account");
    assert_eq!(refused.to_string(), "Not found");
    let db = crate::db::open(Some(&url)).await.expect("reopen");
    assert_eq!(records(db.clone()).await, before);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM users WHERE username = 'olive' AND is_site_admin = 1"
        )
        .await,
        1
    );
    crate::db::close(&db).await;
}
