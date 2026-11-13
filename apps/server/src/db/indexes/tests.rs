use sqlx::{AnyConnection, Connection, Row};

use super::super::migrate::late_indexes;
use super::super::pool::{close, open_started, temp_db_path};
use super::super::schema::{POSTGRES_SCHEMA, SQLITE_SCHEMA};
use super::*;
use crate::api::test_util::pg_temp;

async fn run(db: &Db, stmt: &str) {
    sqlx::query(sqlx::AssertSqlSafe(stmt.to_string()))
        .execute(db)
        .await
        .expect(stmt);
}

/// Whether Postgres has the index `name`, and whether it is valid.
async fn state(db: &Db, name: &str) -> Option<bool> {
    let mut conn = db.acquire().await.expect("connection");
    index_valid(&mut conn, name).await.expect("index state")
}

/// A table of `ONLINE_ROWS` rows with the index `idx_online_t_old`.
async fn big_table(db: &Db) {
    run(
        db,
        "CREATE TABLE online_t(id BIGINT PRIMARY KEY, v TEXT NOT NULL)",
    )
    .await;
    run(
        db,
        &format!(
            "INSERT INTO online_t SELECT g, 'v' || g FROM generate_series(1, {ONLINE_ROWS}) g"
        ),
    )
    .await;
    run(db, "CREATE INDEX idx_online_t_old ON online_t(v)").await;
}

const ON_BIG: &[OnlineIndex] = &[OnlineIndex {
    name: "idx_online_t_new",
    table: "online_t",
    body: "ON online_t(v, id)",
    replaces: &["idx_online_t_old"],
    extension: None,
}];

fn built(built: &[&'static str], dropped: &[&'static str]) -> Built {
    Built {
        built: built.to_vec(),
        dropped: dropped.to_vec(),
        ..Built::default()
    }
}

#[tokio::test]
async fn online_index_on_a_big_table_builds_after_start() {
    let Some(pg) = pg_temp("online_big").await else {
        return;
    };
    let db = open_started(Some(&pg.url)).await.expect("open");
    run(
        &db,
        "INSERT INTO messages(channel_id, author, content, created_at) SELECT c.id, 'alice', 'message ' || g, 1 FROM channels c, generate_series(1, 200001) g WHERE c.server = 'rchat'",
    )
    .await;
    run(&db, "DROP INDEX idx_messages_content_trgm").await;
    big_table(&db).await;
    close(&db).await;
    let db = open_started(Some(&pg.url)).await.expect("start");
    assert_eq!(
        state(&db, "idx_messages_content_trgm").await,
        None,
        "the start does not build an index on a big table"
    );
    let limits = Limits::default();
    assert_eq!(
        build_online(&db, &limits).await.expect("build"),
        built(&["idx_messages_content_trgm"], &[])
    );
    assert_eq!(state(&db, "idx_messages_content_trgm").await, Some(true));
    assert_eq!(
        build_online(&db, &limits).await.expect("again"),
        Built::default()
    );
    let mut tx = db.begin().await.expect("tx");
    build_inline(&mut tx, false, ON_BIG).await.expect("inline");
    tx.commit().await.expect("commit");
    assert_eq!(state(&db, "idx_online_t_new").await, None);
    assert_eq!(state(&db, "idx_online_t_old").await, Some(true));
    assert_eq!(
        build(&db, &limits, ON_BIG).await.expect("build"),
        built(&["idx_online_t_new"], &["idx_online_t_old"])
    );
    assert_eq!(state(&db, "idx_online_t_new").await, Some(true));
    assert_eq!(state(&db, "idx_online_t_old").await, None);
    assert_eq!(
        build(&db, &limits, ON_BIG).await.expect("again"),
        Built::default()
    );
    let mem: String = {
        let mut conn = AnyConnection::connect(&pg.url).await.expect("connect");
        sqlx::query("SHOW maintenance_work_mem")
            .fetch_one(&mut conn)
            .await
            .expect("show")
            .try_get(0)
            .expect("value")
    };
    assert_eq!(
        mem, "64MB",
        "the build settings stay on the build's connection"
    );
    close(&db).await;
    drop(pg);
}

#[tokio::test]
async fn an_invalid_online_index_is_rebuilt() {
    let Some(pg) = pg_temp("online_invalid").await else {
        return;
    };
    let db = open_started(Some(&pg.url)).await.expect("open");
    big_table(&db).await;
    let limits = Limits::default();
    build(&db, &limits, ON_BIG).await.expect("build");
    let invalidate =
        "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_online_t_new'::regclass";
    run(&db, invalidate).await;
    assert_eq!(state(&db, "idx_online_t_new").await, Some(false));
    assert_eq!(
        build(&db, &limits, ON_BIG).await.expect("rebuild"),
        built(&["idx_online_t_new"], &[])
    );
    assert_eq!(state(&db, "idx_online_t_new").await, Some(true));
    run(&db, "DELETE FROM online_t WHERE id > 10").await;
    run(&db, "ANALYZE online_t").await;
    run(&db, invalidate).await;
    let mut tx = db.begin().await.expect("tx");
    build_inline(&mut tx, false, ON_BIG).await.expect("inline");
    tx.commit().await.expect("commit");
    assert_eq!(
        state(&db, "idx_online_t_new").await,
        Some(true),
        "a small table gets it rebuilt in the init"
    );
    close(&db).await;
    drop(pg);
}

#[tokio::test]
async fn only_one_copy_builds_online_indexes() {
    let Some(pg) = pg_temp("online_lock").await else {
        return;
    };
    let db = open_started(Some(&pg.url)).await.expect("open");
    big_table(&db).await;
    let limits = Limits::default();
    let mut other = AnyConnection::connect(&pg.url).await.expect("other copy");
    sqlx::query("SELECT COUNT(*) FROM pg_advisory_lock($1)")
        .bind(INDEX_LOCK)
        .execute(&mut other)
        .await
        .expect("lock");
    assert_eq!(
        build(&db, &limits, ON_BIG).await.expect("busy"),
        Built {
            busy: true,
            ..Built::default()
        }
    );
    assert_eq!(state(&db, "idx_online_t_new").await, None);
    other.close().await.expect("the other copy stops");
    assert_eq!(
        build(&db, &limits, ON_BIG).await.expect("build"),
        built(&["idx_online_t_new"], &["idx_online_t_old"])
    );
    let (first, second) = tokio::join!(build(&db, &limits, ON_BIG), build(&db, &limits, ON_BIG));
    let (first, second) = (first.expect("first"), second.expect("second"));
    assert!(first.failed.is_empty() && second.failed.is_empty());
    close(&db).await;
    drop(pg);
}

#[tokio::test]
async fn a_start_waits_for_no_online_build() {
    let Some(pg) = pg_temp("online_beside").await else {
        return;
    };
    let db = open_started(Some(&pg.url)).await.expect("open");
    close(&db).await;
    let mut building = AnyConnection::connect(&pg.url)
        .await
        .expect("a copy that builds");
    let mut tx = Connection::begin(&mut building).await.expect("tx");
    let tables: Vec<String> = sqlx::query(
        "SELECT CAST(tablename AS TEXT) FROM pg_tables WHERE schemaname = current_schema()",
    )
    .fetch_all(&mut *tx)
    .await
    .expect("tables")
    .iter()
    .map(|row| row.get(0))
    .collect();
    assert!(tables.len() > 40, "{tables:?}");
    for table in &tables {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "LOCK TABLE {table} IN SHARE UPDATE EXCLUSIVE MODE"
        )))
        .execute(&mut *tx)
        .await
        .expect("the lock of CREATE INDEX CONCURRENTLY");
    }
    let wait = std::time::Duration::from_secs(60);
    let db = tokio::time::timeout(wait, open_started(Some(&pg.url)))
        .await
        .expect("the start waits for no build")
        .expect("start");
    let inserted = tokio::time::timeout(
        wait,
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'hi', 1 FROM channels WHERE server = 'rchat'")
            .execute(&db),
    )
    .await
    .expect("writes go on")
    .expect("insert");
    assert_eq!(inserted.rows_affected(), 1);
    tx.rollback().await.expect("the build ends");
    building.close().await.expect("close");
    close(&db).await;
    drop(pg);
}

#[tokio::test]
async fn a_copy_that_finds_the_build_lock_taken_tries_again() {
    let Some(pg) = pg_temp("online_retry").await else {
        return;
    };
    let db = open_started(Some(&pg.url)).await.expect("open");
    big_table(&db).await;
    let mut other = AnyConnection::connect(&pg.url)
        .await
        .expect("the copy that builds");
    sqlx::query("SELECT COUNT(*) FROM pg_advisory_lock($1)")
        .bind(INDEX_LOCK)
        .execute(&mut other)
        .await
        .expect("lock");
    let release = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        other.close().await.expect("its build ends");
    });
    let every = std::time::Duration::from_millis(100);
    assert_eq!(
        build_when_free(&db, &Limits::default(), ON_BIG, every)
            .await
            .expect("build"),
        built(&["idx_online_t_new"], &["idx_online_t_old"])
    );
    release.await.expect("released");
    close(&db).await;
    drop(pg);
}

#[tokio::test]
async fn small_tables_get_online_indexes_inline() {
    let Some(pg) = pg_temp("online_small").await else {
        return;
    };
    let db = open_started(Some(&pg.url)).await.expect("open");
    for OnlineIndex { name, .. } in ONLINE_INDEXES {
        assert_eq!(state(&db, name).await, Some(true), "{name}");
    }
    assert_eq!(
        build_online(&db, &Limits::default()).await.expect("build"),
        Built::default()
    );
    run(
        &db,
        "CREATE TABLE online_t(id BIGINT PRIMARY KEY, v TEXT NOT NULL)",
    )
    .await;
    run(&db, "INSERT INTO online_t VALUES(1, 'a')").await;
    run(&db, "CREATE INDEX idx_online_t_old ON online_t(v)").await;
    for _ in 0..2 {
        let mut tx = db.begin().await.expect("tx");
        build_inline(&mut tx, false, ON_BIG).await.expect("inline");
        tx.commit().await.expect("commit");
        assert_eq!(state(&db, "idx_online_t_new").await, Some(true));
        assert_eq!(state(&db, "idx_online_t_old").await, None);
    }
    close(&db).await;
    drop(pg);
}

#[tokio::test]
async fn sqlite_builds_online_indexes_inline() {
    let path = temp_db_path("online_sqlite");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open_started(path.to_str()).await.expect("open");
    run(
        &db,
        "CREATE TABLE online_t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)",
    )
    .await;
    run(&db, "INSERT INTO online_t VALUES(1, 'a')").await;
    run(&db, "CREATE INDEX idx_online_t_old ON online_t(v)").await;
    let entries = [
        OnlineIndex {
            name: "idx_online_t_new",
            table: "online_t",
            body: "ON online_t(v, id)",
            replaces: &["idx_online_t_old"],
            extension: None,
        },
        OnlineIndex {
            name: "idx_online_t_ext",
            table: "online_t",
            body: "ON online_t USING gin (lower(v) gin_trgm_ops)",
            replaces: &[],
            extension: Some("pg_trgm"),
        },
    ];
    let names = || async {
        sqlx::query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'online_t' ORDER BY name")
            .fetch_all(&db)
            .await
            .expect("indexes")
            .iter()
            .map(|row| row.get::<String, _>(0))
            .collect::<Vec<_>>()
    };
    for _ in 0..2 {
        let mut tx = db.begin().await.expect("tx");
        build_inline(&mut tx, true, &entries).await.expect("inline");
        tx.commit().await.expect("commit");
        assert_eq!(names().await, ["idx_online_t_new"]);
    }
    assert_eq!(
        build(&db, &Limits::default(), &entries)
            .await
            .expect("build"),
        Built::default()
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn a_missing_extension_skips_its_index() {
    let Some(pg) = pg_temp("online_ext").await else {
        return;
    };
    let db = open_started(Some(&pg.url)).await.expect("open");
    big_table(&db).await;
    const NEEDS: &[OnlineIndex] = &[
        OnlineIndex {
            name: "idx_online_t_ext",
            table: "online_t",
            body: "ON online_t(v)",
            replaces: &["idx_online_t_old"],
            extension: Some("rchat_no_such_extension"),
        },
        OnlineIndex {
            name: "idx_online_t_new",
            table: "online_t",
            body: "ON online_t(v, id)",
            replaces: &[],
            extension: None,
        },
    ];
    let mut tx = db.begin().await.expect("tx");
    build_inline(&mut tx, false, NEEDS).await.expect("inline");
    tx.commit().await.expect("the init transaction survives");
    assert_eq!(
        build(&db, &Limits::default(), NEEDS).await.expect("build"),
        Built {
            built: vec!["idx_online_t_new"],
            skipped: vec!["idx_online_t_ext"],
            ..Built::default()
        }
    );
    assert_eq!(state(&db, "idx_online_t_ext").await, None);
    assert_eq!(
        state(&db, "idx_online_t_old").await,
        Some(true),
        "the replaced index stays without its replacement"
    );
    run(&db, "DELETE FROM online_t WHERE id > 10").await;
    run(&db, "ANALYZE online_t").await;
    let mut tx = db.begin().await.expect("tx");
    build_inline(&mut tx, false, NEEDS).await.expect("inline");
    tx.commit().await.expect("commit");
    assert_eq!(state(&db, "idx_online_t_ext").await, None);
    assert_eq!(state(&db, "idx_online_t_old").await, Some(true));
    close(&db).await;
    drop(pg);
}

async fn rows(db: &Db, stmt: &str) -> Vec<sqlx::any::AnyRow> {
    sqlx::query(sqlx::AssertSqlSafe(stmt.to_string()))
        .fetch_all(db)
        .await
        .expect(stmt)
}

async fn texts(db: &Db, stmt: &str) -> Vec<String> {
    rows(db, stmt)
        .await
        .iter()
        .map(|row| row.get::<String, _>(0))
        .collect()
}

/// Runs `body` on a fresh SQLite file and, when `TEST_POSTGRES_URL` is set, on a fresh Postgres
/// database.
async fn on_each_database<F, Fut>(tag: &str, body: F)
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let path = temp_db_path(tag);
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    body(path.to_str().expect("path").to_string()).await;
    wipe();
    if let Some(pg) = pg_temp(tag).await {
        body(pg.url.clone()).await;
        drop(pg);
    }
}

async fn has_index(db: &Db, name: &str) -> bool {
    let sql = match is_sqlite(db) {
        true => "SELECT name FROM sqlite_master WHERE type = 'index' AND name = $1",
        false => "SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1",
    };
    sqlx::query(sql)
        .bind(name)
        .fetch_optional(db)
        .await
        .expect("index")
        .is_some()
}

/// The plan of `query`, with sequential scans off on Postgres so that a table of a few rows
/// shows which index serves it.
async fn plan(db: &Db, query: &str) -> String {
    let mut conn = db.acquire().await.expect("connection");
    let (explain, column) = match is_sqlite(db) {
        true => ("EXPLAIN QUERY PLAN", 3),
        false => {
            sqlx::query("SET enable_seqscan = off")
                .execute(&mut *conn)
                .await
                .expect("no sequential scans");
            ("EXPLAIN", 0)
        }
    };
    let lines: Vec<String> = sqlx::query(sqlx::AssertSqlSafe(format!("{explain} {query}")))
        .fetch_all(&mut *conn)
        .await
        .expect(query)
        .iter()
        .map(|row| row.get::<String, _>(column))
        .collect();
    if !is_sqlite(db) {
        sqlx::query("RESET enable_seqscan")
            .execute(&mut *conn)
            .await
            .expect("reset");
    }
    lines.join("\n")
}

const PREFIX_DUPLICATES: [(&str, &str); 4] = [
    ("idx_members_username", "ON members(username)"),
    ("idx_dms_user_b", "ON dms(user_b)"),
    (
        "idx_reactions_message",
        "ON reactions(message_id, emoji, created_at)",
    ),
    ("idx_group_pings_server", "ON group_pings(server)"),
];

const STORED_SCHEMA: &str =
    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'";

async fn prefix_duplicates_upgrade(url: String) {
    let db = open_started(Some(&url)).await.expect("open");
    for (name, body) in PREFIX_DUPLICATES {
        run(&db, &format!("CREATE INDEX {name} {body}")).await;
    }
    for stmt in [
        "DROP INDEX idx_pings_server",
        "UPDATE settings SET value = '21' WHERE key = 'schema_version'",
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 7)",
        "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 7)",
        "INSERT INTO members(server, username, joined_at) VALUES('club', 'alice', 7)",
        "INSERT INTO members(server, username, joined_at) VALUES('club', 'bob', 8)",
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
        "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', '@everyone hello', 7 FROM channels WHERE server = 'club'",
        "INSERT INTO reactions(message_id, username, emoji, created_at) SELECT id, 'bob', 'x', 9 FROM messages WHERE content = '@everyone hello'",
        "INSERT INTO group_pings(message_id, channel_id, server, kind, actor, created_at) SELECT id, channel_id, 'club', 'everyone', 'alice', 7 FROM messages WHERE content = '@everyone hello'",
        "INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at) SELECT 'bob', 'mention', 'c' || channel_id, 'club', id, 'alice', 7 FROM messages WHERE content = '@everyone hello'",
    ] {
        run(&db, stmt).await;
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open_started(Some(&url)).await.expect("upgrade");
        assert_eq!(
            rows(&db, STORED_SCHEMA).await[0].get::<i64, _>(0),
            super::super::migrate::SCHEMA_VERSION
        );
        for (name, _) in PREFIX_DUPLICATES {
            assert!(!has_index(&db, name).await, "{name} is gone");
        }
        for name in [
            "idx_members_user_joined",
            "idx_dms_b_latest",
            "idx_reactions_agg",
            "idx_group_pings_server_time",
            "idx_pings_server",
        ] {
            assert!(has_index(&db, name).await, "{name}");
        }
        for (query, index) in [
            (
                "SELECT server, joined_at FROM members WHERE username = 'alice'",
                "idx_members_user_joined",
            ),
            (
                "SELECT id, user_a, user_b, last_message_id FROM dms WHERE user_b = 'bob' AND user_a <> user_b AND closed_b = 0",
                "idx_dms_b_latest",
            ),
            (
                "SELECT message_id, emoji, COUNT(*), MIN(created_at) / 1000, MAX(CASE WHEN username = 'bob' THEN 1 ELSE 0 END) FROM reactions WHERE message_id IN (1, 2) GROUP BY message_id, emoji ORDER BY message_id, MIN(created_at), emoji",
                "idx_reactions_agg",
            ),
            (
                "SELECT g.message_id FROM group_pings g WHERE g.server = 'club'",
                "idx_group_pings_server_time",
            ),
            (
                "SELECT id FROM pings WHERE server = 'club'",
                "idx_pings_server",
            ),
        ] {
            let plan = plan(&db, query).await;
            assert!(plan.contains(index), "{query} uses {index}: {plan}");
        }
        for (table, kept) in [
            ("members WHERE server = 'club'", 2),
            ("dms", 1),
            ("reactions", 1),
            ("group_pings", 1),
            ("pings", 1),
        ] {
            assert_eq!(
                rows(&db, &format!("SELECT COUNT(*) FROM {table}")).await[0].get::<i64, _>(0),
                kept,
                "{table}"
            );
        }
        close(&db).await;
    }
}

#[tokio::test]
async fn prefix_duplicate_indexes_are_dropped() {
    on_each_database("prefix_duplicates", prefix_duplicates_upgrade).await;
}

const OLD_MESSAGE_INDEXES: [(&str, &str); 2] = [
    ("idx_messages_dm_id", "ON messages(dm_id, id)"),
    (
        "idx_messages_thread_root",
        "ON messages(thread_root_id, id)",
    ),
];

async fn message_indexes_upgrade(url: String) {
    let db = open_started(Some(&url)).await.expect("open");
    for (name, body) in OLD_MESSAGE_INDEXES {
        run(&db, &format!("CREATE INDEX {name} {body}")).await;
    }
    for stmt in [
        "DROP INDEX idx_messages_dm",
        "DROP INDEX idx_messages_thread",
        "UPDATE settings SET value = '24' WHERE key = 'schema_version'",
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
        "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'root', 7 FROM channels WHERE server = 'rchat'",
        "INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) SELECT channel_id, id, 'bob', 'reply', 8 FROM messages WHERE content = 'root'",
        "INSERT INTO messages(dm_id, author, content, created_at) SELECT id, 'alice', 'direct', 9 FROM dms",
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) INSERT INTO messages(channel_id, author, content, created_at) SELECT c.id, 'alice', 'more', 10 FROM n, channels c WHERE c.server = 'rchat'",
        "ANALYZE",
    ] {
        run(&db, stmt).await;
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open_started(Some(&url)).await.expect("upgrade");
        assert_eq!(
            rows(&db, STORED_SCHEMA).await[0].get::<i64, _>(0),
            super::super::migrate::SCHEMA_VERSION
        );
        for (name, _) in OLD_MESSAGE_INDEXES {
            assert!(!has_index(&db, name).await, "{name} is gone");
        }
        for (query, index) in [
            (
                "SELECT m.id FROM messages m WHERE m.dm_id = 1 AND m.id < 1000 ORDER BY m.id DESC LIMIT 51",
                "idx_messages_dm",
            ),
            (
                "SELECT MAX(id) FROM messages WHERE dm_id = 1",
                "idx_messages_dm",
            ),
            (
                "SELECT m.id FROM messages m WHERE m.thread_root_id = 1 AND m.id > 0 ORDER BY m.id LIMIT 51",
                "idx_messages_thread",
            ),
            (
                "SELECT m.id, (SELECT COUNT(*) FROM messages r WHERE r.thread_root_id = m.id) FROM messages m WHERE m.id = 1",
                "idx_messages_thread",
            ),
        ] {
            assert!(has_index(&db, index).await, "{index}");
            let plan = plan(&db, query).await;
            assert!(
                plan.contains(&format!("{index} "))
                    || plan.ends_with(index)
                    || plan.contains(&format!("{index}\n")),
                "{query} uses {index}: {plan}"
            );
        }
        for (kind, kept) in [
            ("dm_id IS NOT NULL", 1),
            ("thread_root_id IS NOT NULL", 1),
            ("content = 'root'", 1),
        ] {
            assert_eq!(
                rows(&db, &format!("SELECT COUNT(*) FROM messages WHERE {kind}")).await[0]
                    .get::<i64, _>(0),
                kept,
                "{kind}"
            );
        }
        close(&db).await;
    }
}

#[tokio::test]
async fn old_message_indexes_are_replaced() {
    on_each_database("message_indexes", message_indexes_upgrade).await;
}

#[tokio::test]
async fn an_invalid_concurrent_index_is_rebuilt() {
    let Some(pg) = pg_temp("online_invalid_messages").await else {
        return;
    };
    let db = open_started(Some(&pg.url)).await.expect("open");
    run(
        &db,
        &format!("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) SELECT c.id, NULLIF(g % 10, 0), 'alice', 'message ' || g, 1 FROM channels c, generate_series(1, {ONLINE_ROWS}) g WHERE c.server = 'rchat'"),
    )
    .await;
    run(
        &db,
        "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_messages_thread'::regclass",
    )
    .await;
    close(&db).await;
    let db = open_started(Some(&pg.url)).await.expect("start");
    assert_eq!(state(&db, "idx_messages_thread").await, Some(false));
    assert_eq!(
        build_online(&db, &Limits::default()).await.expect("build"),
        built(&["idx_messages_thread"], &[])
    );
    assert_eq!(state(&db, "idx_messages_thread").await, Some(true));
    close(&db).await;
    drop(pg);
}

/// One index of a table: its columns in order (`None` for an expression), whether it is unique
/// and its `WHERE`.
struct Listed {
    table: String,
    name: String,
    columns: Vec<Option<String>>,
    unique: bool,
    predicate: Option<String>,
}

/// Every SQLite index, with the primary key of a rowid table as an index of its own.
async fn sqlite_indexes(db: &Db, table: &str) -> Vec<Listed> {
    let mut listed = Vec::new();
    let mut keyed = false;
    for row in rows(db, &format!("PRAGMA index_list({table})")).await {
        keyed |= row.get::<String, _>(3) == "pk";
        let name: String = row.get(1);
        let columns = rows(db, &format!("PRAGMA index_info({name})"))
            .await
            .iter()
            .map(|col| col.get::<Option<String>, _>(2))
            .collect();
        let sql: Option<String> = sqlx::query("SELECT sql FROM sqlite_master WHERE name = $1")
            .bind(&name)
            .fetch_one(db)
            .await
            .expect("index sql")
            .get(0);
        listed.push(Listed {
            table: table.to_string(),
            name,
            columns,
            unique: row.get::<i64, _>(2) != 0,
            predicate: sql.and_then(|sql| sql.split_once(" WHERE ").map(|(_, p)| p.to_string())),
        });
    }
    let mut key: Vec<(i64, String)> = rows(db, &format!("PRAGMA table_info({table})"))
        .await
        .iter()
        .map(|col| (col.get::<i64, _>(5), col.get::<String, _>(1)))
        .filter(|(order, _)| *order > 0)
        .collect();
    key.sort();
    if !key.is_empty() && !keyed {
        listed.push(Listed {
            table: table.to_string(),
            name: format!("{table}_rowid"),
            columns: key.into_iter().map(|(_, name)| Some(name)).collect(),
            unique: true,
            predicate: None,
        });
    }
    listed
}

async fn sqlite_tables(db: &Db) -> Vec<String> {
    texts(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name",
    )
    .await
}

/// `table(columns)` of every SQLite foreign key that no index starts with. A partial index
/// counts when it leaves out only the rows without the key.
async fn sqlite_keys_without_index(db: &Db) -> Vec<String> {
    let mut missing = Vec::new();
    for table in sqlite_tables(db).await {
        let indexes = sqlite_indexes(db, &table).await;
        let mut keys: Vec<(i64, Vec<String>)> = Vec::new();
        for row in rows(db, &format!("PRAGMA foreign_key_list({table})")).await {
            let (id, from): (i64, String) = (row.get(0), row.get(3));
            match keys.iter_mut().find(|(key, _)| *key == id) {
                Some((_, columns)) => columns.push(from),
                None => keys.push((id, vec![from])),
            }
        }
        for (_, mut key) in keys {
            key.sort();
            let only_set = format!("{} IS NOT NULL", key[0]);
            let served = indexes.iter().any(|index| {
                let mut leading: Vec<String> = index
                    .columns
                    .iter()
                    .take(key.len())
                    .flatten()
                    .cloned()
                    .collect();
                leading.sort();
                leading == key
                    && (index.predicate.is_none()
                        || (key.len() == 1 && index.predicate.as_deref() == Some(&only_set)))
            });
            if !served {
                missing.push(format!("{table}({})", key.join(",")));
            }
        }
    }
    missing
}

const POSTGRES_KEYS_WITHOUT_INDEX: &str = "SELECT c.conrelid::regclass::text || '(' || k.columns || ')' FROM pg_constraint c CROSS JOIN LATERAL (SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS columns FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) k WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid AND (i.indpred IS NULL OR pg_get_expr(i.indpred, i.indrelid) = '(' || k.columns || ' IS NOT NULL)') AND (SELECT array_agg(x ORDER BY x) FROM unnest((i.indkey::int2[])[0:cardinality(c.conkey) - 1]) x) = (SELECT array_agg(x ORDER BY x) FROM unnest(c.conkey) x)) ORDER BY 1";

#[tokio::test]
async fn every_foreign_key_has_an_index() {
    on_each_database("fk_indexes", |url| async move {
        let db = open_started(Some(&url)).await.expect("open");
        let keys = match is_sqlite(&db) {
            true => {
                rows(&db, "SELECT COUNT(*) FROM pragma_foreign_key_list('pings')").await[0]
                    .get::<i64, _>(0)
            }
            false => rows(&db, "SELECT COUNT(*) FROM pg_constraint WHERE contype = 'f' AND conrelid = 'pings'::regclass").await[0]
                .get::<i64, _>(0),
        };
        assert_eq!(keys, 2, "the scan sees the foreign keys of pings");
        let missing = match is_sqlite(&db) {
            true => sqlite_keys_without_index(&db).await,
            false => texts(&db, POSTGRES_KEYS_WITHOUT_INDEX).await,
        };
        assert_eq!(missing, Vec::<String>::new());
        run(&db, "DROP INDEX idx_pings_server").await;
        let missing = match is_sqlite(&db) {
            true => sqlite_keys_without_index(&db).await,
            false => texts(&db, POSTGRES_KEYS_WITHOUT_INDEX).await,
        };
        assert_eq!(missing, ["pings(server)"], "the scan finds a key without an index");
        close(&db).await;
    })
    .await;
}

/// `a is a prefix of b` for every SQLite index `a` whose columns start another index `b` of the
/// same table with the same `WHERE`. Unique indexes are constraints and stay.
async fn sqlite_prefix_indexes(db: &Db) -> Vec<String> {
    let mut found = Vec::new();
    for table in sqlite_tables(db).await {
        let indexes = sqlite_indexes(db, &table).await;
        for a in &indexes {
            for b in &indexes {
                let whole = a.columns.iter().all(Option::is_some);
                let prefix = b.columns.len() >= a.columns.len()
                    && b.columns[..a.columns.len()] == a.columns[..];
                let first = a.columns.len() < b.columns.len() || a.name < b.name;
                if a.name != b.name
                    && a.table == b.table
                    && !a.unique
                    && whole
                    && prefix
                    && first
                    && a.predicate == b.predicate
                {
                    found.push(format!("{} is a prefix of {}", a.name, b.name));
                }
            }
        }
    }
    found
}

const POSTGRES_PREFIX_INDEXES: &str = "WITH idx AS (SELECT i.indrelid AS tbl, c.relname AS name, i.indisunique AS uniq, COALESCE(pg_get_expr(i.indpred, i.indrelid), '') AS pred, c.relam AS am, (SELECT array_agg(pg_get_indexdef(i.indexrelid, k, true) ORDER BY k) FROM generate_series(1, i.indnkeyatts) k) AS cols FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = current_schema()::regnamespace) SELECT a.name || ' is a prefix of ' || b.name FROM idx a JOIN idx b ON a.tbl = b.tbl AND a.name <> b.name AND a.pred = b.pred AND a.am = b.am AND NOT a.uniq AND cardinality(a.cols) <= cardinality(b.cols) AND a.cols = b.cols[1:cardinality(a.cols)] AND (cardinality(a.cols) < cardinality(b.cols) OR a.name < b.name) ORDER BY 1";

/// Postgres compares these by the database collation and the primary key by another one only
/// when the database collation is not `C`, so the catalog shows the same columns.
const COLLATION_INDEXES: [&str; 1] = ["idx_members_name_c is a prefix of members_pkey"];

#[tokio::test]
async fn no_index_is_a_prefix_of_another() {
    on_each_database("prefix_indexes", |url| async move {
        let db = open_started(Some(&url)).await.expect("open");
        let sqlite = is_sqlite(&db);
        let found = || async {
            match sqlite {
                true => sqlite_prefix_indexes(&db).await,
                false => texts(&db, POSTGRES_PREFIX_INDEXES)
                    .await
                    .into_iter()
                    .filter(|pair| !COLLATION_INDEXES.contains(&pair.as_str()))
                    .collect(),
            }
        };
        assert_eq!(found().await, Vec::<String>::new());
        run(
            &db,
            "CREATE INDEX idx_members_username ON members(username)",
        )
        .await;
        run(&db, "CREATE INDEX idx_pings_server_again ON pings(server)").await;
        assert_eq!(
            found().await,
            [
                "idx_members_username is a prefix of idx_members_user_joined",
                "idx_pings_server is a prefix of idx_pings_server_again"
            ],
            "the scan finds a prefix and a copy"
        );
        close(&db).await;
    })
    .await;
}

/// Tables that can be big. Their new indexes go in `ONLINE_INDEXES`.
const BIG_TABLES: [&str; 11] = [
    "messages",
    "reactions",
    "members",
    "read_state",
    "audit_log",
    "pings",
    "group_pings",
    "here_pings",
    "message_embeds",
    "poll_votes",
    "media",
];

/// The indexes on big tables that the schema strings and `late_indexes` had before online
/// indexes. Nothing is added here.
const INLINE_BEFORE: [&str; 37] = [
    "idx_messages_channel_id",
    "idx_messages_author",
    "idx_messages_channel_top",
    "idx_media_uploaded_at",
    "idx_messages_media",
    "idx_messages_channel_author",
    "idx_message_embeds_url",
    "idx_members_admins",
    "idx_members_name_c",
    "idx_members_admins_c",
    "idx_pings_user",
    "idx_pings_message",
    "idx_pings_created",
    "idx_pings_seen",
    "idx_pings_actor",
    "idx_reactions_username",
    "idx_messages_fwd_author",
    "idx_messages_channel_pins",
    "idx_messages_dm_pins",
    "idx_messages_system",
    "idx_group_pings_channel",
    "idx_group_pings_message",
    "idx_group_pings_created",
    "idx_group_pings_role",
    "idx_here_pings_ping",
    "idx_audit_log_server",
    "idx_audit_log_action",
    "idx_audit_log_actor",
    "idx_audit_log_created",
    "idx_poll_votes_option",
    "idx_poll_votes_voter",
    "idx_pings_kept",
    "idx_messages_system_channel",
    "idx_messages_pin_notice",
    "idx_media_default_expiry",
    "idx_media_timed_expiry",
    "idx_media_kept",
];

/// The (name, table) of every `CREATE INDEX` statement in `sql`.
fn created_indexes(sql: &str) -> Vec<(String, String)> {
    sql.split(';')
        .filter_map(|stmt| {
            let words: Vec<&str> = stmt.split_whitespace().collect();
            let at = words.iter().position(|w| *w == "INDEX")?;
            if words.first() != Some(&"CREATE")
                || words.get(at + 1..at + 4) != Some(&["IF", "NOT", "EXISTS"])
            {
                return None;
            }
            let (name, on, table) = (words.get(at + 4)?, words.get(at + 5)?, words.get(at + 6)?);
            assert_eq!(*on, "ON", "{stmt}");
            let table = table.split('(').next().unwrap_or(table);
            Some((name.to_string(), table.to_string()))
        })
        .collect()
}

#[test]
fn new_indexes_on_big_tables_are_online_indexes() {
    let inline: Vec<(String, String)> = [SQLITE_SCHEMA, POSTGRES_SCHEMA]
        .into_iter()
        .map(str::to_string)
        .chain([late_indexes(true).join(";"), late_indexes(false).join(";")])
        .flat_map(|sql| created_indexes(&sql))
        .collect();
    assert!(
        inline.len() > 150,
        "the scan reads the schema: {}",
        inline.len()
    );
    for (name, table) in &inline {
        assert!(
            !BIG_TABLES.contains(&table.as_str()) || INLINE_BEFORE.contains(&name.as_str()),
            "{name} is an index on {table}, which can be big: make it an ONLINE_INDEXES entry"
        );
        assert!(
            ONLINE_INDEXES.iter().all(|online| online.name != name),
            "{name} is an online index, so the schema strings and late_indexes leave it out"
        );
    }
    for OnlineIndex {
        name,
        table,
        body,
        replaces,
        extension: _,
    } in ONLINE_INDEXES
    {
        assert!(
            body.starts_with(&format!("ON {table}("))
                || body.starts_with(&format!("ON {table} USING ")),
            "{name} is on {table}"
        );
        for old in *replaces {
            assert!(
                inline.iter().all(|(inline, _)| inline != old)
                    && ONLINE_INDEXES.iter().all(|online| online.name != *old),
                "{old} is replaced by {name}, so nothing creates it"
            );
        }
    }
    for src in [
        include_str!("../schema.rs"),
        include_str!("../migrate.rs"),
        include_str!("../pool.rs"),
    ] {
        assert!(
            !src.contains("CONCURRENTLY"),
            "concurrent builds go through ONLINE_INDEXES"
        );
        assert!(
            !src.contains("gin_trgm_ops"),
            "the trigram indexes are ONLINE_INDEXES entries"
        );
    }
}
