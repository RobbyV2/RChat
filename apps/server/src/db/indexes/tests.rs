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
const INLINE_BEFORE: [&str; 45] = [
    "idx_members_username",
    "idx_messages_channel_id",
    "idx_messages_dm_id",
    "idx_messages_author",
    "idx_messages_thread_root",
    "idx_messages_channel_top",
    "idx_media_uploaded_at",
    "idx_messages_media",
    "idx_messages_channel_author",
    "idx_message_embeds_url",
    "idx_members_user_joined",
    "idx_members_admins",
    "idx_members_name_c",
    "idx_members_admins_c",
    "idx_pings_user",
    "idx_pings_message",
    "idx_pings_created",
    "idx_pings_seen",
    "idx_pings_actor",
    "idx_reactions_message",
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
    "idx_group_pings_server",
    "idx_group_pings_server_time",
    "idx_audit_log_server",
    "idx_audit_log_action",
    "idx_audit_log_actor",
    "idx_audit_log_created",
    "idx_poll_votes_option",
    "idx_poll_votes_voter",
    "idx_reactions_agg",
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
