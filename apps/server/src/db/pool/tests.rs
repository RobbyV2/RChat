use sqlx::Row;

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

#[test]
fn only_bookkeeping_uses_light_commits() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&src, &src, &mut files);
    assert!(
        files.len() > 50,
        "the scan reads the sources: {}",
        files.len()
    );
    let mut callers = Vec::new();
    for (file, code) in &files {
        let mut function = "";
        for line in code.lines() {
            if let Some(name) = declared(line) {
                function = name;
            }
            let calls = line.match_indices("light(").any(|(at, _)| {
                !line[..at]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric() || c == '_')
            });
            if calls && function != "light" {
                callers.push((file.as_str(), function));
            }
        }
    }
    callers.sort();
    assert_eq!(
        callers,
        [
            ("api/auth.rs", "throttle_attempt"),
            ("api/messages.rs", "read_scope"),
            ("db/touch.rs", "flush_grant_touches"),
            ("db/touch.rs", "touch_interaction"),
        ]
    );
}
