use sqlx::{Connection, Row};

use super::*;
use crate::api::test_util::{non_test_code, pg_temp};

async fn commit_mode(conn: &mut AnyConnection) -> String {
    sqlx::query("SHOW synchronous_commit")
        .fetch_one(&mut *conn)
        .await
        .expect("show")
        .get(0)
}

#[tokio::test]
async fn light_writes_skip_the_flush_on_postgres() {
    for (mode, inside) in [(LightCommits::Async, "off"), (LightCommits::Sync, "on")] {
        let Some(pg) = pg_temp("light_commits").await else {
            return;
        };
        let opts = DbOptions {
            limits: Limits {
                database_max_connections: Some(1),
                ..Limits::default()
            },
            light_commits: mode,
            ..DbOptions::default()
        };
        let db = open_with(Some(&pg.url), &opts).await.expect("open");
        sqlx::query("SET synchronous_commit = on")
            .execute(&db)
            .await
            .expect("whatever the server's default");
        let mut tx = db.begin().await.expect("tx");
        assert_eq!(commit_mode(&mut tx).await, "on");
        light(&db, &mut tx).await.expect("light");
        assert_eq!(commit_mode(&mut tx).await, inside, "{mode:?}");
        sqlx::query("INSERT INTO read_state(username, scope, last_read) VALUES('alice', 'c1', 7)")
            .execute(&mut *tx)
            .await
            .expect("read mark");
        tx.commit().await.expect("commit");
        let mut tx = db.begin().await.expect("the next transaction");
        assert_eq!(commit_mode(&mut tx).await, "on", "only that transaction");
        let kept: i64 = sqlx::query("SELECT last_read FROM read_state WHERE username = 'alice'")
            .fetch_one(&mut *tx)
            .await
            .expect("row")
            .get(0);
        assert_eq!(kept, 7);
        tx.rollback().await.expect("rollback");
        close(&db).await;
        drop(pg);
    }
}

#[tokio::test]
async fn light_commits_do_nothing_on_sqlite() {
    for mode in [LightCommits::Async, LightCommits::Sync] {
        let path = temp_db_path("light_commits");
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let opts = DbOptions {
            light_commits: mode,
            ..DbOptions::default()
        };
        let db = open_with(path.to_str(), &opts).await.expect("open");
        let mut tx = db.begin().await.expect("tx");
        light(&db, &mut tx).await.expect("light");
        sqlx::query("INSERT INTO read_state(username, scope, last_read) VALUES('alice', 'c1', 7)")
            .execute(&mut *tx)
            .await
            .expect("read mark");
        tx.commit().await.expect("commit");
        let kept: i64 = sqlx::query("SELECT last_read FROM read_state WHERE username = 'alice'")
            .fetch_one(&db)
            .await
            .expect("row")
            .get(0);
        assert_eq!(kept, 7);
        close(&db).await;
        wipe();
    }
}

#[test]
fn light_commits_are_async_unless_the_env_says_sync() {
    for (raw, mode) in [
        (None, LightCommits::Async),
        (Some(""), LightCommits::Async),
        (Some(" async "), LightCommits::Async),
        (Some("sync"), LightCommits::Sync),
        (Some("SYNC"), LightCommits::Sync),
    ] {
        assert_eq!(LightCommits::parse(raw).expect("mode"), mode, "{raw:?}");
    }
    assert_eq!(
        LightCommits::parse(Some("off")).unwrap_err().to_string(),
        "DATABASE_LIGHT_COMMITS: expected async or sync, got off"
    );
    let options = |pairs: &[(&str, &str)]| {
        crate::config::AppConfig::from_map(pairs).map(|config| config.db_options().light_commits)
    };
    assert_eq!(options(&[]).expect("default"), LightCommits::Async);
    assert_eq!(
        options(&[("DATABASE_LIGHT_COMMITS", "sync")]).expect("sync"),
        LightCommits::Sync
    );
    assert_eq!(
        options(&[("DATABASE_LIGHT_COMMITS", "maybe")])
            .unwrap_err()
            .to_string(),
        "DATABASE_LIGHT_COMMITS: expected async or sync, got maybe"
    );
    let example = include_str!("../../../../../.env.local.example");
    assert!(example.contains("# Postgres: async or sync."));
    assert!(example.contains("\n# DATABASE_LIGHT_COMMITS=async\n"));
}

/// Every `.rs` file under `dir`, as (path from `src`, non-test code).
fn sources(dir: &std::path::Path, src: &std::path::Path, found: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).expect("source directory") {
        let path = entry.expect("entry").path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if path.is_dir() {
            if name != "tests" {
                sources(&path, src, found);
            }
        } else if name.ends_with(".rs") && name != "tests.rs" {
            let code = std::fs::read_to_string(&path).expect("source");
            let rel = path.strip_prefix(src).expect("under src");
            found.push((rel.display().to_string(), non_test_code(&code)));
        }
    }
}

/// The name of the function a line declares.
fn declared(line: &str) -> Option<&str> {
    let at = line.find("fn ")?;
    let before = &line[..at];
    if !before.trim().is_empty()
        && !before
            .split_whitespace()
            .all(|word| word.starts_with("pub") || word == "async" || word == "const")
    {
        return None;
    }
    let name = &line[at + 3..];
    Some(&name[..name.find(['(', '<'])?])
}

/// The (file, function) of every call of `name` outside tests and outside `name` itself.
fn callers(name: &str) -> Vec<(String, String)> {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&src, &src, &mut files);
    assert!(
        files.len() > 50,
        "the scan reads the sources: {}",
        files.len()
    );
    let call = format!("{name}(");
    let mut callers = Vec::new();
    for (file, code) in &files {
        let mut function = "";
        for line in code.lines() {
            if let Some(declared) = declared(line) {
                function = declared;
            }
            let calls = line.match_indices(&call).any(|(at, _)| {
                !line[..at]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric() || c == '_')
            });
            if calls && function != name {
                callers.push((file.clone(), function.to_string()));
            }
        }
    }
    callers.sort();
    callers.dedup();
    callers
}

fn named(callers: &[(String, String)]) -> Vec<(&str, &str)> {
    callers
        .iter()
        .map(|(file, function)| (file.as_str(), function.as_str()))
        .collect()
}

#[test]
fn only_bookkeeping_uses_light_commits() {
    assert_eq!(
        named(&callers("light")),
        [
            ("api/auth.rs", "throttle_attempt"),
            ("api/messages.rs", "read_scope"),
            ("db/touch.rs", "flush_grant_touches"),
            ("db/touch.rs", "touch_interaction"),
        ]
    );
}

fn limited(secs: u64) -> DbOptions {
    DbOptions {
        limits: Limits {
            database_statement_timeout_secs: secs,
            ..Limits::default()
        },
        ..DbOptions::default()
    }
}

async fn answer(e: sqlx::Error) -> (axum::http::StatusCode, Option<String>, String) {
    use axum::response::IntoResponse;
    let res = crate::api::ApiError::from(e).into_response();
    let retry = res
        .headers()
        .get(axum::http::header::RETRY_AFTER)
        .map(|v| v.to_str().expect("header").to_string());
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), 4096)
        .await
        .expect("body");
    (
        status,
        retry,
        String::from_utf8(body.to_vec()).expect("text"),
    )
}

const BUSY_BODY: &str = r#"{"error":"Server busy, try again in a moment"}"#;
const ERROR_BODY: &str = r#"{"error":"Something went wrong"}"#;

#[tokio::test]
async fn a_statement_over_the_limit_fails_on_postgres() {
    let Some(pg) = pg_temp("statement_limit").await else {
        return;
    };
    let db = open_with(Some(&pg.url), &limited(1)).await.expect("open");
    let started = std::time::Instant::now();
    let slow = sqlx::query("SELECT COUNT(*) FROM pg_sleep(2)")
        .execute(&db)
        .await
        .expect_err("over the limit");
    assert!(started.elapsed() < Duration::from_millis(1900));
    assert_eq!(
        answer(slow).await,
        (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Some("1".to_string()),
            BUSY_BODY.to_string()
        )
    );
    sqlx::query("SELECT COUNT(*) FROM pg_sleep(0.1)")
        .execute(&db)
        .await
        .expect("under the limit");
    close(&db).await;
    let db = open_with(Some(&pg.url), &limited(0)).await.expect("open");
    sqlx::query("SELECT COUNT(*) FROM pg_sleep(1.2)")
        .execute(&db)
        .await
        .expect("0 means no limit");
    close(&db).await;
    drop(pg);
}

#[tokio::test]
async fn database_errors_never_reach_the_body() {
    let path = temp_db_path("generic_500");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    let twice = || async {
        sqlx::query("INSERT INTO banned_usernames(username) VALUES('secret_name')")
            .execute(&db)
            .await
    };
    twice().await.expect("first");
    let constraint = twice().await.expect_err("constraint");
    assert!(constraint.to_string().contains("banned_usernames"));
    let generic = (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        None,
        ERROR_BODY.to_string(),
    );
    assert_eq!(answer(constraint).await, generic);
    assert_eq!(answer(sqlx::Error::RowNotFound).await, generic);
    let wrapped: crate::api::ApiError =
        anyhow::Error::from(twice().await.expect_err("constraint")).into();
    assert_eq!(
        (wrapped.0, wrapped.1.as_str()),
        (generic.0, "Something went wrong")
    );
    let other: crate::api::ApiError = anyhow::anyhow!("not the database").into();
    assert_eq!(other.1, "not the database");
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn pool_timeouts_answer_503() {
    let path = temp_db_path("pool_timeout");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let opts = DbOptions {
        limits: Limits {
            database_acquire_timeout_secs: Some(1),
            ..Limits::default()
        },
        ..DbOptions::default()
    };
    let db = open_with(path.to_str(), &opts).await.expect("open");
    let held = db.begin().await.expect("the only writer");
    let timed_out = sqlx::query("SELECT 1")
        .execute(&db)
        .await
        .expect_err("no free connection");
    assert!(matches!(timed_out, sqlx::Error::PoolTimedOut));
    assert_eq!(
        answer(timed_out).await,
        (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Some("1".to_string()),
            BUSY_BODY.to_string()
        )
    );
    drop(held);
    close(&db).await;
    wipe();
}

async fn statement_limit(conn: &mut AnyConnection) -> String {
    sqlx::query("SHOW statement_timeout")
        .fetch_one(&mut *conn)
        .await
        .expect("show")
        .get(0)
}

#[tokio::test]
async fn init_purges_and_builds_have_no_statement_limit() {
    assert_eq!(
        named(&callers("no_statement_limit")),
        [
            ("api/admin.rs", "run_purge"),
            ("api/audit.rs", "purge_server"),
            ("api/bulk_delete.rs", "delete_ids"),
            ("api/bulk_delete.rs", "step"),
            ("api/reports/store.rs", "purge_server"),
            ("db/pool.rs", "open_with"),
            ("db/sweep.rs", "delete_batched"),
            ("db/sweep.rs", "purge_messages"),
        ]
    );
    assert!(include_str!("../indexes.rs").contains("\"SET statement_timeout = 0\""));
    let Some(pg) = pg_temp("no_statement_limit").await else {
        return;
    };
    let db = open_with(Some(&pg.url), &limited(1)).await.expect("open");
    let mut tx = db.begin().await.expect("tx");
    assert_eq!(statement_limit(&mut tx).await, "1s");
    no_statement_limit(&mut tx).await.expect("lift");
    assert_eq!(statement_limit(&mut tx).await, "0");
    sqlx::query("SELECT COUNT(*) FROM pg_sleep(1.3)")
        .execute(&mut *tx)
        .await
        .expect("no limit in this transaction");
    tx.commit().await.expect("commit");
    let mut tx = db.begin().await.expect("the next transaction");
    assert_eq!(
        statement_limit(&mut tx).await,
        "1s",
        "only that transaction"
    );
    tx.rollback().await.expect("rollback");
    close(&db).await;
    let mut other = AnyConnection::connect(&pg.url).await.expect("another copy");
    sqlx::query("SELECT COUNT(*) FROM pg_advisory_lock($1)")
        .bind(SCHEMA_LOCK)
        .execute(&mut other)
        .await
        .expect("the other copy is in its init");
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        other.close().await.expect("the other copy is done");
    });
    let started = std::time::Instant::now();
    let db = open_with(Some(&pg.url), &limited(1))
        .await
        .expect("an init that waits longer than the limit");
    assert!(started.elapsed() >= Duration::from_millis(1400));
    release.await.expect("released");
    let purged = crate::db::purge_messages(&db, "author = $1", "nobody")
        .await
        .expect("purge");
    assert_eq!(purged, 0);
    close(&db).await;
    drop(pg);
}

#[tokio::test]
async fn acquire_timeout_defaults_to_10_s() {
    assert_eq!(Limits::default().acquire_timeout_secs(), 10);
    let example = include_str!("../../../../../.env.local.example");
    assert!(example.contains("\n# DATABASE_ACQUIRE_TIMEOUT_SECS=10\n"));
    for (set, secs) in [(None, 10), (Some(3), 3)] {
        let path = temp_db_path("acquire_timeout");
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let opts = DbOptions {
            limits: Limits {
                database_acquire_timeout_secs: set,
                ..Limits::default()
            },
            ..DbOptions::default()
        };
        let db = open_with(path.to_str(), &opts).await.expect("open");
        for pool in [&db, &reader(&db)] {
            assert_eq!(
                pool.options().get_acquire_timeout(),
                Duration::from_secs(secs)
            );
        }
        close(&db).await;
        wipe();
    }
}

#[tokio::test]
async fn web_only_copies_open_one_connection() {
    let web_only = |roles: &str| {
        crate::config::AppConfig::from_map(&[
            ("DATABASE_URL", "postgres://u:p@db/x"),
            ("REDIS_URL", "redis://redis:6379"),
            ("RCHAT_ROLES", roles),
        ])
        .expect("config")
        .db_options()
        .web_only
    };
    assert!(web_only("web"));
    assert!(!web_only("web,api"));
    assert!(!web_only("all"));
    let Some(pg) = pg_temp("web_only").await else {
        return;
    };
    for (web_only, min, connections) in [(true, Some(4), 1), (false, None, 20)] {
        let opts = DbOptions {
            limits: Limits {
                database_max_connections: Some(20),
                database_min_connections: min,
                ..Limits::default()
            },
            web_only,
            ..DbOptions::default()
        };
        let db = open_with(Some(&pg.url), &opts).await.expect("open");
        assert_eq!(db.options().get_max_connections(), connections);
        close(&db).await;
    }
    drop(pg);
}

#[tokio::test]
async fn connection_budget_names_the_numbers() {
    let budget = |pool, allowed, used| ConnectionBudget {
        pool,
        allowed,
        used,
    };
    let roomy = budget(8, 97, 1);
    assert_eq!((roomy.room(), roomy.tight()), (11, false));
    assert_eq!(
        roomy.message(),
        "A pool of 8 database connections leaves room for 11 more copies like this one (1 of 97 Postgres connections in use)"
    );
    let tight = budget(8, 97, 75);
    assert_eq!((tight.room(), tight.tight()), (1, true));
    assert_eq!(
        tight.message(),
        "A pool of 8 database connections leaves room for 1 more copies like this one (75 of 97 Postgres connections in use)"
    );
    assert_eq!(budget(8, 97, 57).room(), 4);
    assert_eq!(budget(50, 97, 90).room(), 0);
    let path = temp_db_path("budget");
    let _ = std::fs::remove_file(&path);
    let db = open(path.to_str()).await.expect("open");
    assert_eq!(connection_budget(&db).await.expect("sqlite"), None);
    close(&db).await;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let Some(pg) = pg_temp("budget").await else {
        return;
    };
    let db = open(Some(&pg.url)).await.expect("open");
    let read = connection_budget(&db)
        .await
        .expect("budget")
        .expect("postgres");
    let allowed: i64 = sqlx::query("SELECT CAST(current_setting('max_connections') AS BIGINT) - CAST(current_setting('superuser_reserved_connections') AS BIGINT)")
        .fetch_one(&db)
        .await
        .expect("settings")
        .get(0);
    assert_eq!((read.pool, read.allowed), (8, allowed));
    assert!(read.used >= 1 && read.used <= allowed, "{read:?}");
    close(&db).await;
    drop(pg);
}

#[test]
fn bad_guard_rail_values_name_the_variable() {
    for (name, value, range) in [
        ("DATABASE_STATEMENT_TIMEOUT_SECS", "-1", "0 to 3600"),
        ("DATABASE_STATEMENT_TIMEOUT_SECS", "3601", "0 to 3600"),
        ("DATABASE_STATEMENT_TIMEOUT_SECS", "soon", "0 to 3600"),
        ("DATABASE_ACQUIRE_TIMEOUT_SECS", "0", "1 to 3600"),
    ] {
        let err = crate::config::AppConfig::from_map(&[(name, value)])
            .map(|_| ())
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("{name}: expected {range}, got {value}")
        );
    }
    let config = crate::config::AppConfig::from_map(&[("DATABASE_STATEMENT_TIMEOUT_SECS", "0")])
        .expect("no limit");
    assert_eq!(config.limits.database_statement_timeout_secs, 0);
    assert_eq!(Limits::default().database_statement_timeout_secs, 60);
}
