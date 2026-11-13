use serde_json::{Value, json};
use sqlx::{AnyConnection, Row};

use crate::api::audit::like_escape;
use crate::db::{Db, PURGE_BATCH, delete_batched};

/// How long the pace row of an account that stopped reporting is kept.
const PACE_KEEP: i64 = 7 * 86400;

/// Deletes the reports to the moderators of a server that is being purged, in batches. Reports
/// to the instance stay: they keep `server_name`, and the foreign key empties their `server`
/// when the server row goes.
pub(crate) async fn purge_server(db: &Db, server: &str) -> sqlx::Result<u64> {
    let mut total = 0;
    loop {
        let mut tx = db.begin().await?;
        crate::db::no_statement_limit(&mut tx).await?;
        let n = sqlx::query("DELETE FROM reports WHERE id IN (SELECT id FROM reports WHERE kind = 'server' AND server = $1 LIMIT $2)")
            .bind(server)
            .bind(PURGE_BATCH)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        tx.commit().await?;
        total += n;
        if n < PURGE_BATCH as u64 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

/// Takes the account `username` out of stored JSON: every object that names it as `username`
/// becomes `{"deleted": true}`, and a `creator` that is the account becomes `null`. Says whether
/// anything changed.
fn forget_in(value: &mut Value, username: &str) -> bool {
    match value {
        Value::Object(map) => {
            if map.get("username").and_then(Value::as_str) == Some(username) {
                *value = json!({ "deleted": true });
                return true;
            }
            let mut changed = false;
            if map.get("creator").and_then(Value::as_str) == Some(username) {
                map.insert("creator".to_string(), Value::Null);
                changed = true;
            }
            for inner in map.values_mut() {
                changed |= forget_in(inner, username);
            }
            changed
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, inner| forget_in(inner, username) | changed),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
    }
}

/// Drops a deleted account's name from the reports (as reporter, assignee, the one reported, an
/// author in a snapshot, a person an answer names, the actor of an event, the one who muted a
/// reporter), so a new account with the same username never inherits the history. What was
/// written stays.
pub(crate) async fn forget_user(conn: &mut AnyConnection, username: &str) -> sqlx::Result<()> {
    let rows = sqlx::query("SELECT id, snapshot, answers FROM reports WHERE snapshot LIKE $1 ESCAPE '\\' OR answers LIKE $1 ESCAPE '\\'")
        .bind(like_escape(&Value::from(username).to_string()))
        .fetch_all(&mut *conn)
        .await?;
    for row in &rows {
        let (id, snapshot, answers): (i64, String, String) =
            (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?);
        for (column, text) in [("snapshot", snapshot), ("answers", answers)] {
            let Ok(mut stored) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if forget_in(&mut stored, username) {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "UPDATE reports SET {column} = $1 WHERE id = $2"
                )))
                .bind(stored.to_string())
                .bind(id)
                .execute(&mut *conn)
                .await?;
            }
        }
    }
    for sql in [
        "UPDATE reports SET reporter = NULL WHERE reporter = $1",
        "UPDATE reports SET assignee = NULL WHERE assignee = $1",
        "UPDATE reports SET target_user = NULL, target_key = 'd:' || CAST(id AS TEXT) WHERE target_user = $1",
        "UPDATE report_events SET actor = NULL WHERE actor = $1",
        "UPDATE report_mutes SET muted_by = NULL WHERE muted_by = $1",
        "DELETE FROM report_mutes WHERE username = $1",
        "DELETE FROM instance_report_mutes WHERE username = $1",
        "DELETE FROM report_pace WHERE reporter = $1",
    ] {
        sqlx::query(sql).bind(username).execute(&mut *conn).await?;
    }
    Ok(())
}

/// Deletes closed reports that were resolved more than `retention_days` days before `t` (0
/// keeps them forever), and the pace rows of accounts that sent no report for a week. Returns
/// how many reports it deleted.
pub(crate) async fn sweep(db: &Db, retention_days: u32, t: i64) -> sqlx::Result<u64> {
    delete_batched(
        db,
        "DELETE FROM report_pace WHERE (reporter, kind) IN (SELECT reporter, kind FROM report_pace WHERE last_at < $1 LIMIT $2)",
        t - PACE_KEEP,
    )
    .await?;
    if retention_days == 0 {
        return Ok(0);
    }
    delete_batched(
        db,
        "DELETE FROM reports WHERE id IN (SELECT id FROM reports WHERE resolved_at IS NOT NULL AND resolved_at < $1 LIMIT $2)",
        t - i64::from(retention_days) * 86400,
    )
    .await
}

#[cfg(test)]
mod tests {
    use sqlx::Row;

    use super::{forget_user, purge_server, sweep};
    use crate::db::{Db, close, open_started};
    use crate::limits::Limits;

    /// Runs `body` on a fresh SQLite file and, when `TEST_POSTGRES_URL` is set, on a fresh
    /// Postgres database.
    async fn on_each_database<F, Fut>(tag: &str, body: F)
    where
        F: Fn(Db) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let path = crate::db::temp_db_path(tag);
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open_started(path.to_str()).await.expect("open");
        body(db.clone()).await;
        close(&db).await;
        wipe();
        if let Some(pg) = crate::api::test_util::pg_temp(tag).await {
            let db = open_started(Some(&pg.url)).await.expect("open");
            body(db.clone()).await;
            close(&db).await;
            drop(pg);
        }
    }

    async fn run(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"))
            .try_get(0)
            .expect("count")
    }

    /// A report with the columns a test sets, and its id.
    async fn report(db: &Db, columns: &str, values: &str) -> i64 {
        let sql = format!(
            "INSERT INTO reports(form, form_label, reason, created_at, updated_at, {columns}) VALUES('user', 'Report a user', 'spam', 10, 10, {values}) RETURNING id"
        );
        sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
            .fetch_one(db)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"))
            .try_get(0)
            .expect("id")
    }

    #[tokio::test]
    async fn server_purge_keeps_instance_reports() {
        on_each_database("reports_purge", |db| async move {
            run(&db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('s', 'S', NULL, 1)").await;
            run(&db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('t', 'T', NULL, 1)").await;
            let to_mods = report(
                &db,
                "kind, server, server_name, target_kind, target_key, snapshot",
                "'server', 's', 'S', 'user', 'u:carol', '{}'",
            )
            .await;
            let to_instance = report(
                &db,
                "kind, server, server_name, target_kind, target_key, snapshot",
                "'instance', 's', 'S', 'user', 'u:carol', '{}'",
            )
            .await;
            let elsewhere = report(
                &db,
                "kind, server, server_name, target_kind, target_key, snapshot",
                "'server', 't', 'T', 'user', 'u:carol', '{}'",
            )
            .await;
            run(&db, &format!("INSERT INTO report_events(report_id, actor, kind, created_at) VALUES({to_mods}, 'dave', 'note', 11)")).await;
            run(&db, "INSERT INTO report_mutes(server, username, muted_by, created_at) VALUES('s', 'bob', 'dave', 12)").await;

            assert_eq!(purge_server(&db, "s").await.expect("purge"), 1);
            run(&db, "DELETE FROM servers WHERE name = 's'").await;
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {to_mods}")).await,
                0,
                "the report to the server's moderators is gone"
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_events").await, 0);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_mutes").await, 0);
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {to_instance} AND server IS NULL AND server_name = 'S'")).await,
                1,
                "the report to the instance stays, with the name the server had"
            );
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {elsewhere} AND server = 't'")).await,
                1
            );
            assert_eq!(purge_server(&db, "s").await.expect("again"), 0);
        })
        .await;
    }

    #[tokio::test]
    async fn purge_deletes_in_batches() {
        on_each_database("reports_purge_batches", |db| async move {
            run(&db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('s', 'S', NULL, 1)").await;
            let n = crate::db::PURGE_BATCH + 20;
            for _ in 0..n {
                report(
                    &db,
                    "kind, server, target_kind, target_key, snapshot",
                    "'server', 's', 'user', 'u:carol', '{}'",
                )
                .await;
            }
            assert_eq!(purge_server(&db, "s").await.expect("purge"), n as u64);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM reports").await, 0);
        })
        .await;
    }

    #[tokio::test]
    async fn forgetting_an_account_leaves_no_name() {
        on_each_database("reports_forget", |db| async move {
            run(&db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('s', 'S', NULL, 1)").await;
            let snapshot = serde_json::json!({
                "message": {"id": 5, "author": {"username": "carol", "display_name": "Carol"}, "content": "buy my coins", "kind": "text"},
                "context": [
                    {"id": 3, "author": {"username": "bob", "display_name": "Bob"}, "content": "hello there"},
                    {"id": 4, "author": {"username": "erin", "display_name": "Erin"}, "content": "hi"},
                ],
                "user": {"username": "carol", "display_name": "Carol"},
                "server": {"name": "s", "display_name": "S", "creator": "carol", "member_count": 3},
                "channel": "general",
            });
            let answers = serde_json::json!([
                {"id": "witness", "label": "Who saw it", "kind": "user", "value": {"username": "bob", "display_name": "Bob"}},
                {"id": "details", "label": "What happened", "kind": "long_text", "value": "they kept posting ads"},
            ]);
            let id: i64 = sqlx::query("INSERT INTO reports(kind, server, server_name, target_kind, target_key, target_user, reporter, assignee, form, form_label, reason, note, answers, snapshot, created_at, updated_at) VALUES('server', 's', 'S', 'message', 'u:carol', 'carol', 'bob', 'bob', 'message', 'Report message', 'spam', 'so many ads', $1, $2, 10, 10) RETURNING id")
                .bind(answers.to_string())
                .bind(snapshot.to_string())
                .fetch_one(&db)
                .await
                .expect("report")
                .try_get(0)
                .expect("id");
            let other = report(
                &db,
                "kind, target_kind, target_key, target_user, reporter, snapshot",
                "'instance', 'user', 'u:erin', 'erin', 'erin', '{\"user\": {\"username\": \"erin\"}}'",
            )
            .await;
            run(&db, &format!("INSERT INTO report_events(report_id, actor, kind, detail, created_at) VALUES({id}, 'dave', 'note', '{{\"text\": \"looking\"}}', 11)")).await;
            run(&db, &format!("INSERT INTO report_events(report_id, actor, kind, created_at) VALUES({id}, 'bob', 'assign', 12)")).await;
            run(&db, "INSERT INTO report_mutes(server, username, muted_by, created_at) VALUES('s', 'bob', 'dave', 12)").await;
            run(&db, "INSERT INTO report_mutes(server, username, muted_by, created_at) VALUES('s', 'erin', 'carol', 12)").await;
            run(&db, "INSERT INTO instance_report_mutes(username, created_at) VALUES('bob', 12)").await;
            run(&db, "INSERT INTO instance_report_mutes(username, created_at) VALUES('erin', 12)").await;
            run(&db, "INSERT INTO report_pace(reporter, kind, last_at) VALUES('bob', 'server', 12)").await;
            run(&db, "INSERT INTO report_pace(reporter, kind, last_at) VALUES('erin', 'server', 12)").await;

            let mut conn = db.acquire().await.expect("conn");
            forget_user(&mut conn, "bob").await.expect("forget bob");
            forget_user(&mut conn, "carol").await.expect("forget carol");
            drop(conn);

            let mut text = String::new();
            for (table, columns) in [
                ("reports", "COALESCE(server, '') || '|' || COALESCE(target_key, '') || '|' || COALESCE(target_user, '') || '|' || COALESCE(reporter, '') || '|' || COALESCE(assignee, '') || '|' || COALESCE(note, '') || '|' || answers || '|' || snapshot"),
                ("report_events", "COALESCE(actor, '') || '|' || detail"),
                ("report_mutes", "username || '|' || COALESCE(muted_by, '')"),
                ("instance_report_mutes", "username"),
                ("report_pace", "reporter"),
            ] {
                let rows = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {columns} FROM {table}")))
                    .fetch_all(&db)
                    .await
                    .expect(table);
                for row in &rows {
                    text.push_str(&row.try_get::<String, _>(0).expect("text"));
                    text.push('\n');
                }
            }
            let lower = text.to_lowercase();
            assert!(!lower.contains("bob") && !lower.contains("carol"), "{text}");
            for kept in ["buy my coins", "hello there", "so many ads", "they kept posting ads", "looking", "erin", "dave"] {
                assert!(text.contains(kept), "{kept} stays: {text}");
            }

            let row = sqlx::query("SELECT target_key, target_user, reporter, assignee, snapshot, answers FROM reports WHERE id = $1")
                .bind(id)
                .fetch_one(&db)
                .await
                .expect("row");
            let key: String = row.try_get(0).expect("key");
            assert_eq!(key, format!("d:{id}"));
            for column in 1..4 {
                assert_eq!(row.try_get::<Option<String>, _>(column).expect("name"), None);
            }
            let snapshot: serde_json::Value =
                serde_json::from_str(&row.try_get::<String, _>(4).expect("snapshot")).expect("json");
            assert_eq!(
                snapshot,
                serde_json::json!({
                    "message": {"id": 5, "author": {"deleted": true}, "content": "buy my coins", "kind": "text"},
                    "context": [
                        {"id": 3, "author": {"deleted": true}, "content": "hello there"},
                        {"id": 4, "author": {"username": "erin", "display_name": "Erin"}, "content": "hi"},
                    ],
                    "user": {"deleted": true},
                    "server": {"name": "s", "display_name": "S", "creator": null, "member_count": 3},
                    "channel": "general",
                })
            );
            let answers: serde_json::Value =
                serde_json::from_str(&row.try_get::<String, _>(5).expect("answers")).expect("json");
            assert_eq!(answers[0]["value"], serde_json::json!({"deleted": true}));
            assert_eq!(answers[1]["value"], "they kept posting ads");

            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {other} AND target_key = 'u:erin' AND target_user = 'erin' AND reporter = 'erin'")).await,
                1,
                "another account's report is untouched"
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_events WHERE actor = 'dave'").await, 1);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_events WHERE actor IS NULL").await, 1);
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM report_mutes WHERE username = 'erin' AND muted_by IS NULL").await,
                1,
                "the mute a deleted moderator set stays"
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_mutes").await, 1);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM instance_report_mutes").await, 1);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_pace").await, 1);
        })
        .await;
    }

    #[tokio::test]
    async fn forgetting_an_account_reads_names_literally() {
        on_each_database("reports_forget_like", |db| async move {
            let kept = report(
                &db,
                "kind, target_kind, target_key, target_user, snapshot",
                "'instance', 'user', 'u:axb', 'axb', '{\"user\": {\"username\": \"axb\"}}'",
            )
            .await;
            let gone = report(
                &db,
                "kind, target_kind, target_key, target_user, snapshot",
                "'instance', 'user', 'u:a_b', 'a_b', '{\"user\": {\"username\": \"a_b\"}, \"note\": \"a_b said hi\"}'",
            )
            .await;
            let mut conn = db.acquire().await.expect("conn");
            forget_user(&mut conn, "a_b").await.expect("forget");
            drop(conn);
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {kept} AND target_user = 'axb' AND snapshot LIKE '%axb%'")).await,
                1
            );
            let snapshot: String = sqlx::query("SELECT snapshot FROM reports WHERE id = $1")
                .bind(gone)
                .fetch_one(&db)
                .await
                .expect("row")
                .try_get(0)
                .expect("snapshot");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&snapshot).expect("json"),
                serde_json::json!({"user": {"deleted": true}, "note": "a_b said hi"}),
                "only the account's own objects change, never what people wrote"
            );

            for name in ["o\"neil", "back\\slash", "tab\tbed"] {
                let snapshot = serde_json::json!({
                    "user": {"username": name, "display_name": "Secret Display"},
                    "message": {"author": {"username": name}, "content": "kept"},
                });
                let answers = serde_json::json!([
                    {"id": "who", "label": "Who", "kind": "user", "value": {"username": name}},
                ]);
                let id: i64 = sqlx::query("INSERT INTO reports(kind, target_kind, target_key, target_user, form, form_label, reason, answers, snapshot, created_at, updated_at) VALUES('instance', 'user', $1, $2, 'user', 'Report a user', 'spam', $3, $4, 10, 10) RETURNING id")
                    .bind(format!("u:{name}"))
                    .bind(name)
                    .bind(answers.to_string())
                    .bind(snapshot.to_string())
                    .fetch_one(&db)
                    .await
                    .expect("report")
                    .try_get(0)
                    .expect("id");
                let mut conn = db.acquire().await.expect("conn");
                forget_user(&mut conn, name).await.expect("forget");
                drop(conn);
                let row = sqlx::query("SELECT target_user, snapshot, answers FROM reports WHERE id = $1")
                    .bind(id)
                    .fetch_one(&db)
                    .await
                    .expect("row");
                assert_eq!(row.try_get::<Option<String>, _>(0).expect("target"), None);
                let json = |n: usize| -> serde_json::Value {
                    serde_json::from_str(&row.try_get::<String, _>(n).expect("text")).expect("json")
                };
                assert_eq!(
                    json(1),
                    serde_json::json!({"user": {"deleted": true}, "message": {"author": {"deleted": true}, "content": "kept"}}),
                    "{name} as JSON writes it"
                );
                assert_eq!(json(2)[0]["value"], serde_json::json!({"deleted": true}), "{name}");
            }
        })
        .await;
    }

    #[tokio::test]
    async fn retention_sweeps_closed_reports_only() {
        on_each_database("reports_sweep", |db| async move {
            let day = 86400;
            let t = crate::db::now();
            let insert = |status: &'static str, created: i64, resolved: Option<i64>| {
                let db = db.clone();
                async move {
                    let resolved = resolved.map_or("NULL".to_string(), |at| at.to_string());
                    let sql = format!(
                        "INSERT INTO reports(kind, target_kind, target_key, form, form_label, reason, snapshot, status, created_at, updated_at, resolved_at) VALUES('instance', 'none', '-', 'bug', 'Report a bug', 'other', '{{}}', '{status}', {created}, {created}, {resolved}) RETURNING id"
                    );
                    let id: i64 = sqlx::query(sqlx::AssertSqlSafe(sql))
                        .fetch_one(&db)
                        .await
                        .expect("report")
                        .try_get(0)
                        .expect("id");
                    id
                }
            };
            let old = insert("dismissed", t - 500 * day, Some(t - 181 * day)).await;
            let recent = insert("resolved", t - 500 * day, Some(t - 179 * day)).await;
            let open = insert("open", t - 400 * day, None).await;
            run(&db, &format!("INSERT INTO report_events(report_id, kind, created_at) VALUES({old}, 'status', 5)")).await;
            run(&db, &format!("INSERT INTO report_pace(reporter, kind, last_at) VALUES('bob', 'server', {})", t - 8 * day)).await;
            run(&db, &format!("INSERT INTO report_pace(reporter, kind, last_at) VALUES('bob', 'instance', {})", t - 6 * day)).await;

            assert_eq!(sweep(&db, 0, t).await.expect("keep forever"), 0);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM reports").await, 3, "0 keeps closed reports");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM report_pace").await,
                1,
                "pace rows age out after a week either way"
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_pace WHERE kind = 'instance'").await, 1);

            let limits = Limits::default();
            assert_eq!(limits.report_retention_days, 180);
            let swept = crate::db::sweep_stale(&db, &limits).await.expect("sweep");
            assert_eq!(swept.reports, 1);
            let left: Vec<i64> = sqlx::query("SELECT id FROM reports ORDER BY id")
                .fetch_all(&db)
                .await
                .expect("left")
                .iter()
                .map(|r| r.try_get(0).expect("id"))
                .collect();
            assert_eq!(left, [recent, open], "{old} was closed 181 days ago");
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_events").await, 0);
            assert_eq!(sweep(&db, 180, t).await.expect("again"), 0);
        })
        .await;
    }
}
