use std::time::{Duration, Instant};

use sqlx::Row;
use sqlx::any::AnyPoolOptions;

use super::migrate::*;
use super::schema::*;
use super::sweep::*;

use super::*;
use crate::api::access::perms::{ALL_PERMS, Restrict, fold_access, perm_row};
use crate::api::controls::ControlSeeds;
use crate::api::test_util::{add_member, done, temp_state};
use crate::limits::Limits;

/// A server start with nothing set in the env, which is what these tests mean by opening a
/// database. `super::open` is the tool's way in.
async fn open(database_url: Option<&str>) -> anyhow::Result<Db> {
    open_started(database_url).await
}

async fn general_id(db: &Db) -> i64 {
    sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
        .fetch_one(db)
        .await
        .expect("general channel")
        .try_get(0)
        .expect("channel id")
}

async fn count(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .expect("count")
        .try_get(0)
        .expect("count value")
}

#[tokio::test]
async fn reader_pool_reads_committed_writes_and_refuses_writes() {
    let (state, path) = temp_state("reader_pool").await;
    let read = state.read();
    assert!(
        sqlx::query("INSERT INTO settings(key, value) VALUES('x', '1')")
            .execute(&read)
            .await
            .is_err(),
        "reader must be query_only"
    );
    let mut tx = state.db.begin().await.expect("begin");
    sqlx::query("INSERT INTO settings(key, value) VALUES('held', '1')")
        .execute(&mut *tx)
        .await
        .expect("write in open tx");
    let started = Instant::now();
    assert_eq!(
        count(&read, "SELECT COUNT(*) FROM settings WHERE key = 'held'").await,
        0
    );
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "readers do not wait for an open write transaction"
    );
    tx.commit().await.expect("commit");
    assert_eq!(
        count(&read, "SELECT COUNT(*) FROM settings WHERE key = 'held'").await,
        1
    );
    done(state, path).await;
}

#[tokio::test]
async fn triggers_keep_dm_latest_and_recounts_keep_member_counts() {
    let (state, path) = temp_state("triggers").await;
    let db = &state.db;
    let dm: i64 = sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('a', 'b') RETURNING id")
        .fetch_one(db)
        .await
        .expect("dm")
        .try_get(0)
        .expect("id");
    let mut ids = Vec::new();
    for _ in 0..3 {
        let id: i64 = sqlx::query("INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'a', 'x', 1) RETURNING id")
            .bind(dm)
            .fetch_one(db)
            .await
            .expect("msg")
            .try_get(0)
            .expect("id");
        ids.push(id);
    }
    let latest = || async {
        count(
            db,
            &format!("SELECT last_message_id FROM dms WHERE id = {dm}"),
        )
        .await
    };
    assert_eq!(latest().await, ids[2]);
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(ids[2])
        .execute(db)
        .await
        .expect("delete latest");
    assert_eq!(latest().await, ids[1]);
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(ids[0])
        .execute(db)
        .await
        .expect("delete older");
    assert_eq!(latest().await, ids[1]);
    sqlx::query("DELETE FROM messages WHERE dm_id = $1")
        .bind(dm)
        .execute(db)
        .await
        .expect("delete all");
    assert_eq!(latest().await, 0);
    let members =
        || async { count(db, "SELECT member_count FROM servers WHERE name = 'rchat'").await };
    assert_eq!(members().await, 0);
    for name in ["x", "y", "z"] {
        add_member(db, "rchat", name, 0, 0, now()).await;
    }
    sqlx::query("INSERT INTO members(server, username, joined_at) VALUES('rchat', 'x', 1) ON CONFLICT(server, username) DO NOTHING")
        .execute(db)
        .await
        .expect("duplicate join");
    recount_members(db, "rchat").await.expect("recount");
    assert_eq!(members().await, 3);
    sqlx::query("DELETE FROM members WHERE server = 'rchat' AND username = 'y'")
        .execute(db)
        .await
        .expect("leave");
    assert_eq!(members().await, 3, "only a recount changes the count");
    recount_members(db, "rchat").await.expect("recount");
    assert_eq!(members().await, 2);
    sqlx::query("INSERT INTO servers(name, display_name, created_at) VALUES('old', 'Old', 1)")
        .execute(db)
        .await
        .expect("server");
    add_member(db, "old", "x", 1, 0, now()).await;
    sqlx::query("UPDATE servers SET name = 'new' WHERE name = 'old'")
        .execute(db)
        .await
        .expect("rename");
    assert_eq!(
        count(db, "SELECT member_count FROM servers WHERE name = 'new'").await,
        1
    );
    recount_members(db, "gone").await.expect("recount");
    done(state, path).await;
}

const OLD_SQLITE_COUNTS: [&str; 2] = [
    "CREATE TRIGGER IF NOT EXISTS members_count_insert AFTER INSERT ON members BEGIN UPDATE servers SET member_count = member_count + 1 WHERE name = new.server; END",
    "CREATE TRIGGER IF NOT EXISTS members_count_delete AFTER DELETE ON members BEGIN UPDATE servers SET member_count = member_count - 1 WHERE name = old.server; END",
];

const OLD_POSTGRES_COUNTS: [&str; 5] = [
    "CREATE OR REPLACE FUNCTION rchat_members_count_insert() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE servers SET member_count = member_count + 1 WHERE name = NEW.server; RETURN NULL; END $f$",
    "CREATE OR REPLACE FUNCTION rchat_members_count_delete() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE servers SET member_count = member_count - 1 WHERE name = OLD.server; RETURN NULL; END $f$",
    "CREATE TRIGGER members_count_insert AFTER INSERT ON members FOR EACH ROW EXECUTE FUNCTION rchat_members_count_insert()",
    "CREATE TRIGGER members_count_delete AFTER DELETE ON members FOR EACH ROW EXECUTE FUNCTION rchat_members_count_delete()",
    "UPDATE settings SET value = 'before' WHERE key = 'trigger_version'",
];

async fn old_member_counts(db: &Db, is_sqlite: bool) {
    let old: &[&str] = match is_sqlite {
        true => &OLD_SQLITE_COUNTS,
        false => &OLD_POSTGRES_COUNTS,
    };
    for stmt in old.iter().chain(&[
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', 'alice', 3)",
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('old', 'alice', 1, 3)",
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('old', 'bob', 0, 4)",
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('old', 'carol', 0, 5)",
        "DELETE FROM members WHERE server = 'old' AND username = 'carol'",
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', 'dan', 0, 6)",
    ]) {
        sqlx::query(*stmt).execute(db).await.expect(stmt);
    }
    let old_objects = match is_sqlite {
        true => 2,
        false => 4,
    };
    assert_eq!(count(db, &count_triggers(is_sqlite)).await, old_objects);
    assert_eq!(
        count(db, "SELECT member_count FROM servers WHERE name = 'old'").await,
        2
    );
}

fn count_triggers(is_sqlite: bool) -> String {
    match is_sqlite {
        true => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'members_count%'".to_string(),
        false => "SELECT (SELECT COUNT(*) FROM pg_trigger WHERE tgname LIKE 'members_count%') + (SELECT COUNT(*) FROM pg_proc WHERE proname LIKE 'rchat_members_count%')".to_string(),
    }
}

async fn upgraded_member_counts(db: &Db, is_sqlite: bool, round: usize) {
    assert_eq!(count(db, &count_triggers(is_sqlite)).await, 0);
    let dm_trigger = match is_sqlite {
        true => {
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_dm_latest_insert'"
        }
        false => "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'messages_dm_latest_insert'",
    };
    assert_eq!(count(db, dm_trigger).await, 1);
    assert_eq!(
        count(db, "SELECT COUNT(*) FROM servers WHERE name = 'old' AND display_name = 'Old' AND creator = 'alice' AND created_at = 3").await,
        1
    );
    assert_eq!(
        count(db, "SELECT COUNT(*) FROM members WHERE (server = 'old' AND username = 'alice' AND is_admin = 1 AND joined_at = 3) OR (server = 'old' AND username = 'bob' AND is_admin = 0 AND joined_at = 4) OR (server = 'rchat' AND username = 'dan' AND joined_at = 6)").await,
        3
    );
    assert_eq!(
        count(db, "SELECT member_count FROM servers WHERE name = 'rchat'").await,
        1
    );
    let old = "SELECT member_count FROM servers WHERE name = 'old'";
    if round == 0 {
        assert_eq!(count(db, old).await, 2);
        sqlx::query("INSERT INTO members(server, username, joined_at) VALUES('old', 'erin', 7)")
            .execute(db)
            .await
            .expect("insert");
        assert_eq!(count(db, old).await, 2, "no trigger counts it");
        recount_members(db, "old").await.expect("recount");
    }
    assert_eq!(count(db, old).await, 3);
}

async fn wrong_member_counts_are_fixed(db: &Db) {
    for stmt in [
        "INSERT INTO servers(name, display_name, created_at) VALUES('a1', 'a1', 1), ('a2', 'a2', 1), ('b1', 'b1', 1), ('b2', 'b2', 1), ('c1', 'c1', 1)",
        "INSERT INTO members(server, username, joined_at) VALUES('a1', 'x', 1), ('a1', 'y', 1), ('a2', 'x', 1), ('b2', 'x', 1), ('b2', 'y', 1), ('b2', 'z', 1), ('c1', 'y', 1)",
        "UPDATE servers SET member_count = 2 WHERE name = 'a1'",
        "UPDATE servers SET member_count = 5 WHERE name = 'a2'",
        "UPDATE servers SET member_count = 4 WHERE name = 'b1'",
        "UPDATE servers SET member_count = 3 WHERE name = 'b2'",
        "UPDATE servers SET member_count = 0 WHERE name = 'c1'",
    ] {
        sqlx::query(stmt).execute(db).await.expect(stmt);
    }
    let counts = || async {
        sqlx::query("SELECT name, member_count FROM servers ORDER BY name")
            .fetch_all(db)
            .await
            .expect("counts")
            .iter()
            .map(|r| {
                (
                    r.try_get::<String, _>(0).expect("name"),
                    r.try_get::<i64, _>(1).expect("count"),
                )
            })
            .collect::<Vec<_>>()
    };
    let want = |c1: i64| {
        [
            ("a1", 2),
            ("a2", 1),
            ("b1", 0),
            ("b2", 3),
            ("c1", c1),
            ("rchat", 0),
        ]
        .map(|(n, c)| (n.to_string(), c))
        .to_vec()
    };
    assert_eq!(fix_member_counts(db, 2).await.expect("fix"), 3);
    assert_eq!(counts().await, want(1));
    assert_eq!(fix_member_counts(db, 2).await.expect("again"), 0);
    sqlx::query("UPDATE servers SET member_count = 9 WHERE name = 'c1'")
        .execute(db)
        .await
        .expect("break c1");
    assert_eq!(counts().await, want(9));
    assert_eq!(
        sweep_stale(db, &Limits::default())
            .await
            .expect("sweep")
            .member_counts,
        1
    );
    assert_eq!(counts().await, want(1));
    assert_eq!(
        sweep_stale(db, &Limits::default())
            .await
            .expect("sweep")
            .member_counts,
        0
    );
}

#[tokio::test]
async fn the_sweep_fixes_wrong_member_counts() {
    let (state, path) = temp_state("count_sweep").await;
    wrong_member_counts_are_fixed(&state.db).await;
    done(state, path).await;
    if let Some((state, pg)) = crate::api::test_util::pg_state("count_sweep").await {
        wrong_member_counts_are_fixed(&state.db).await;
        crate::api::test_util::pg_done(state, pg).await;
    }
}

#[tokio::test]
async fn member_count_triggers_are_dropped_from_an_old_database() {
    let path = crate::db::temp_db_path("count_triggers");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    old_member_counts(&db, true).await;
    close(&db).await;
    for round in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        upgraded_member_counts(&db, true, round).await;
        close(&db).await;
    }
    wipe();
    if let Some(pg) = crate::api::test_util::pg_temp("count_triggers").await {
        let db = open(Some(pg.url.as_str())).await.expect("open postgres");
        old_member_counts(&db, false).await;
        close(&db).await;
        for round in 0..2 {
            let db = open(Some(pg.url.as_str())).await.expect("upgrade postgres");
            upgraded_member_counts(&db, false, round).await;
            close(&db).await;
        }
        drop(pg);
    }
}

#[tokio::test]
async fn new_columns_are_backfilled_on_existing_databases() {
    let path = crate::db::temp_db_path("backfill");
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP TRIGGER messages_dm_latest_insert",
        "DROP TRIGGER messages_dm_latest_delete",
        "DROP INDEX idx_dms_a_latest",
        "DROP INDEX idx_dms_b_latest",
        "DROP INDEX idx_guest_grants_used",
        "ALTER TABLE dms DROP COLUMN last_message_id",
        "ALTER TABLE servers DROP COLUMN member_count",
        "ALTER TABLE guest_grants DROP COLUMN last_used_at",
        "INSERT INTO dms(user_a, user_b) VALUES('a', 'b')",
        "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'a', 'x', 1)",
        "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'b', 'y', 2)",
        "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'a', 1)",
        "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'b', 1)",
        "INSERT INTO guest_grants(\"grant\", server, created_at) VALUES('g', 'rchat', 77)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    let db = open(path.to_str()).await.expect("reopen");
    assert_eq!(
        count(&db, "SELECT last_message_id FROM dms WHERE id = 1").await,
        2
    );
    assert_eq!(
        count(&db, "SELECT member_count FROM servers WHERE name = 'rchat'").await,
        2
    );
    assert!(count(&db, "SELECT last_used_at FROM guest_grants").await >= now() - 60);
    add_member(&db, "rchat", "c", 0, 0, now()).await;
    assert_eq!(
        count(&db, "SELECT member_count FROM servers WHERE name = 'rchat'").await,
        3
    );
    close(&db).await;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[tokio::test]
async fn existing_users_get_a_presence_seq_column() {
    let path = crate::db::temp_db_path("presence_seq");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE users DROP COLUMN presence_seq",
        "UPDATE settings SET value = '5' WHERE key = 'schema_version'",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, appear_offline, created_at) VALUES('alice', 'Alice', 'h', 'text', 'identicon', 1, 5)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert!(
        sqlx::query("SELECT presence_seq FROM users")
            .fetch_all(&db)
            .await
            .is_err()
    );
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM users WHERE username = 'alice' AND appear_offline = 1 AND created_at = 5 AND presence_seq = 0").await,
            1
        );
        assert_eq!(
            count(&db, &format!("SELECT COUNT(*) FROM settings WHERE key = 'schema_version' AND value = '{SCHEMA_VERSION}'")).await,
            1
        );
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn existing_channels_get_an_empty_topic_column() {
    let path = crate::db::temp_db_path("topic_col");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE channels DROP COLUMN topic",
        "DELETE FROM settings WHERE key = 'profanity_channel_topics'",
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', 'alice', 3)",
        "INSERT INTO channels(server, name, kind, slowmode_seconds, created_at, restrict_send) VALUES('old', 'chat', 'text', 30, 3, 1)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'talk', 'voice', 3)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert!(
        sqlx::query("SELECT topic FROM channels")
            .fetch_all(&db)
            .await
            .is_err()
    );
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        let rows = sqlx::query("SELECT name, kind, slowmode_seconds, restrict_send, topic FROM channels WHERE server = 'old' ORDER BY id")
            .fetch_all(&db)
            .await
            .expect("rows");
        let got: Vec<(String, String, i64, i64, Option<String>)> = rows
            .iter()
            .map(|r| {
                (
                    r.try_get(0).expect("name"),
                    r.try_get(1).expect("kind"),
                    r.try_get(2).expect("slowmode"),
                    r.try_get(3).expect("restrict_send"),
                    r.try_get(4).expect("topic"),
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("chat".into(), "text".into(), 30, 1, None),
                ("talk".into(), "voice".into(), 0, 0, None),
            ]
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM settings WHERE key = 'profanity_channel_topics' AND value = '1'").await,
            1
        );
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    sqlx::query("UPDATE channels SET topic = 'hi' WHERE name = 'talk'")
        .execute(&db)
        .await
        .expect("write topic");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM channels WHERE topic = 'hi'").await,
        1
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn existing_channels_keep_their_order_after_categories() {
    let path = crate::db::temp_db_path("layout_col");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_channel_categories_server",
        "DROP TABLE channel_categories",
        "ALTER TABLE channels DROP COLUMN category_id",
        "ALTER TABLE channels DROP COLUMN position",
        "ALTER TABLE servers DROP COLUMN layout_version",
        "DELETE FROM settings WHERE key = 'profanity_category_names'",
        "UPDATE settings SET value = '2' WHERE key = 'schema_version'",
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', 'alice', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'talk', 'voice', 3)",
        "INSERT INTO channels(server, name, kind, created_at, topic) VALUES('old', 'chat', 'text', 3, 'hi')",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'music', 'voice', 3)",
        "INSERT INTO channels(server, name, kind, created_at, restrict_view) VALUES('old', 'staff', 'text', 3, 1)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        let rows = sqlx::query("SELECT name, kind, topic, restrict_view, category_id, position FROM channels WHERE server = 'old' ORDER BY position, id")
            .fetch_all(&db)
            .await
            .expect("rows");
        type Got = (String, String, Option<String>, i64, Option<i64>, i64);
        let got: Vec<Got> = rows
            .iter()
            .map(|r| {
                (
                    r.try_get(0).expect("name"),
                    r.try_get(1).expect("kind"),
                    r.try_get(2).expect("topic"),
                    r.try_get(3).expect("restrict_view"),
                    r.try_get(4).expect("category"),
                    r.try_get(5).expect("position"),
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("chat".into(), "text".into(), Some("hi".into()), 0, None, 0),
                ("staff".into(), "text".into(), None, 1, None, 1),
                ("talk".into(), "voice".into(), None, 0, None, 2),
                ("music".into(), "voice".into(), None, 0, None, 3),
            ]
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM servers WHERE layout_version = 0").await,
            count(&db, "SELECT COUNT(*) FROM servers").await
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM channel_categories").await,
            0
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM settings WHERE key = 'profanity_category_names' AND value = '1'").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    let id = count(&db, "INSERT INTO channel_categories(server, name, position, created_at) VALUES('old', 'Games', 0, 4) RETURNING id").await;
    sqlx::query("UPDATE channels SET category_id = $1 WHERE name = 'talk'")
        .bind(id)
        .execute(&db)
        .await
        .expect("move");
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM channels WHERE category_id IS NOT NULL"
        )
        .await,
        1
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn existing_dms_start_open() {
    let path = crate::db::temp_db_path("dm_closed");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE dms DROP COLUMN closed_a",
        "ALTER TABLE dms DROP COLUMN closed_b",
        "UPDATE settings SET value = '7' WHERE key = 'schema_version'",
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'alice')",
        "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'bob', 'hi', 3)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM dms WHERE closed_a = 0 AND closed_b = 0"
            )
            .await,
            2
        );
        assert_eq!(
            count(&db, "SELECT last_message_id FROM dms WHERE id = 1").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM messages WHERE dm_id = 1 AND content = 'hi'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    sqlx::query("UPDATE dms SET closed_a = 1 WHERE id = 1")
        .execute(&db)
        .await
        .expect("close");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM dms WHERE closed_a = 1").await,
        1
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn existing_databases_get_the_preview_image_cache() {
    let path = crate::db::temp_db_path("preview_images");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_preview_images_fetched",
        "DROP TABLE preview_images",
        "UPDATE settings SET value = '14' WHERE key = 'schema_version'",
        "INSERT INTO embeds(url, title, image_url, fetched_at) VALUES('https://a.example/', 'A', 'https://a.example/i.png', 1)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM preview_images").await, 0);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_preview_images_fetched'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM embeds WHERE image_url = 'https://a.example/i.png'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn existing_databases_get_blocks() {
    let path = crate::db::temp_db_path("blocks");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_blocks_recent",
        "DROP INDEX idx_blocks_blocked",
        "DROP TABLE blocks",
        "UPDATE settings SET value = '8' WHERE key = 'schema_version'",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', '', 'text', 'identicon', 1)",
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
        "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'bob', 'hi', 3)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM blocks").await, 0);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_blocks_recent', 'idx_blocks_blocked')"
            )
            .await,
            2
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM messages WHERE dm_id = 1 AND content = 'hi'"
            )
            .await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM users WHERE username = 'alice'").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 5)")
        .execute(&db)
        .await
        .expect("block");
    assert!(
        sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 6)")
            .execute(&db)
            .await
            .is_err(),
        "one row per pair"
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn existing_databases_get_friends() {
    let path = crate::db::temp_db_path("friends");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_friends_friend",
        "DROP INDEX idx_friend_requests_in",
        "DROP INDEX idx_friend_requests_out",
        "DROP INDEX idx_friend_pings_user",
        "DROP TABLE friends",
        "DROP TABLE friend_requests",
        "DROP TABLE friend_pings",
        "DROP TABLE privacy",
        "UPDATE settings SET value = '9' WHERE key = 'schema_version'",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', '', 'text', 'identicon', 1)",
        "INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 2)",
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
        "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'bob', 'hi', 3)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        for table in ["friends", "friend_requests", "friend_pings", "privacy"] {
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM {table}")).await,
                0,
                "{table}"
            );
        }
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_friends_friend', 'idx_friend_requests_in', 'idx_friend_requests_out', 'idx_friend_pings_user')"
            )
            .await,
            4
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM messages WHERE dm_id = 1 AND content = 'hi'"
            )
            .await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM blocks WHERE blocker = 'alice'").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    sqlx::query("INSERT INTO privacy(username) VALUES('alice')")
        .execute(&db)
        .await
        .expect("privacy");
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM privacy WHERE dms = 'everyone' AND friend_requests = 'everyone'"
        )
        .await,
        1,
        "defaults"
    );
    for bad in [
        "UPDATE privacy SET dms = 'nobody'",
        "UPDATE privacy SET friend_requests = 'friends'",
        "INSERT INTO friend_pings(username, kind, actor, created_at) VALUES('alice', 'mention', 'bob', 1)",
    ] {
        assert!(sqlx::query(bad).execute(&db).await.is_err(), "{bad}");
    }
    sqlx::query(
        "INSERT INTO friend_requests(sender, recipient, created_at) VALUES('bob', 'alice', 5)",
    )
    .execute(&db)
    .await
    .expect("request");
    assert!(
        sqlx::query(
            "INSERT INTO friend_requests(sender, recipient, created_at) VALUES('bob', 'alice', 6)"
        )
        .execute(&db)
        .await
        .is_err(),
        "one request per pair"
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn existing_databases_get_polls() {
    let path = crate::db::temp_db_path("polls");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_polls_due",
        "DROP INDEX idx_poll_options_message",
        "DROP INDEX idx_poll_votes_option",
        "DROP INDEX idx_poll_votes_voter",
        "DROP TABLE poll_votes",
        "DROP TABLE poll_options",
        "DROP TABLE poll_snapshots",
        "DROP TABLE polls",
        "UPDATE settings SET value = '10' WHERE key = 'schema_version'",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', '', 'text', 'identicon', 1)",
        "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'old message', 3 FROM channels WHERE server = 'rchat'",
        "INSERT INTO reactions(message_id, username, emoji, created_at) SELECT id, 'alice', 'x', 4 FROM messages",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        for table in ["polls", "poll_options", "poll_votes", "poll_snapshots"] {
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM {table}")).await,
                0,
                "{table}"
            );
        }
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_polls_due', 'idx_poll_options_message', 'idx_poll_votes_option', 'idx_poll_votes_voter')"
            )
            .await,
            4
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE content = 'old message' AND kind = 'user' AND created_at = 3").await,
            1
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM reactions").await, 1);
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    let id = count(&db, "SELECT id FROM messages").await;
    sqlx::query(
        "INSERT INTO polls(message_id, kind, question, created_at) VALUES($1, 'single', 'q', 5)",
    )
    .bind(id)
    .execute(&db)
    .await
    .expect("poll");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM polls WHERE anonymous = 0 AND results = 'always' AND allow_change = 1 AND allow_add = 0 AND min_choices = 1 AND max_choices = 1 AND closes_at IS NULL AND closed_at IS NULL AND version = 0").await,
        1,
        "defaults"
    );
    for bad in [
        "UPDATE polls SET kind = 'other'",
        "UPDATE polls SET results = 'never'",
        "INSERT INTO polls(message_id, kind, question, created_at) VALUES(999999, 'single', 'q', 5)",
    ] {
        assert!(sqlx::query(bad).execute(&db).await.is_err(), "{bad}");
    }
    sqlx::query("INSERT INTO poll_votes(message_id, voter, option_id, value, created_at) VALUES($1, 'alice', 1, 1, 6)")
        .bind(id)
        .execute(&db)
        .await
        .expect("vote");
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(id)
        .execute(&db)
        .await
        .expect("delete");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM polls").await, 0, "cascade");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM poll_votes").await,
        0,
        "cascade"
    );
    for stmt in [
        "DROP INDEX idx_polls_due",
        "DROP TABLE polls",
        "CREATE TABLE polls(message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('single','multiple','ranked','rating','yes_no')), question TEXT NOT NULL, anonymous INTEGER NOT NULL DEFAULT 0, results TEXT NOT NULL DEFAULT 'always' CHECK(results IN ('always','after_vote','after_close')), allow_change INTEGER NOT NULL DEFAULT 1, allow_add INTEGER NOT NULL DEFAULT 0, min_choices INTEGER NOT NULL DEFAULT 1, max_choices INTEGER NOT NULL DEFAULT 1, scale INTEGER, closes_at INTEGER, closed_at INTEGER, closed_by TEXT, created_at INTEGER NOT NULL)",
        "INSERT INTO messages(channel_id, author, content, kind, created_at) SELECT id, 'alice', 'q', 'poll', 7 FROM channels WHERE server = 'rchat'",
        "INSERT INTO polls(message_id, kind, question, created_at) SELECT MAX(id), 'single', 'q', 7 FROM messages",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("add version");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM polls WHERE version = 0").await,
            1,
            "version"
        );
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn existing_databases_get_bulk_delete_jobs() {
    let path = crate::db::temp_db_path("bulk_jobs_migration");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_bulk_delete_jobs_running",
        "DROP INDEX idx_bulk_delete_jobs_user",
        "DROP INDEX idx_bulk_delete_jobs_claim",
        "DROP INDEX idx_bulk_delete_jobs_finished",
        "DROP TABLE bulk_delete_jobs",
        "UPDATE settings SET value = '12' WHERE key = 'schema_version'",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', '', 'text', 'identicon', 1)",
        "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'old message', 3 FROM channels WHERE server = 'rchat'",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM bulk_delete_jobs").await, 0);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_bulk_delete_jobs_%'"
            )
            .await,
            4
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM messages WHERE content = 'old message' AND created_at = 3"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    sqlx::query(
        "INSERT INTO bulk_delete_jobs(username, scope, created_at) VALUES('alice', 'c1', 5)",
    )
    .execute(&db)
    .await
    .expect("job");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM bulk_delete_jobs WHERE status = 'running' AND except_ids = '[]' AND after_id = 0 AND upto_id = 0 AND cursor_id = 0 AND estimate = 0 AND deleted = 0 AND skipped = 0 AND authors = '{}' AND staff = 0 AND author_filter IS NULL AND audit_id IS NULL AND error IS NULL AND claimed_at = 0 AND finished_at IS NULL AND channel_id IS NULL").await,
        1,
        "defaults"
    );
    for bad in [
        "INSERT INTO bulk_delete_jobs(username, scope, created_at) VALUES('alice', 'c1', 6)",
        "UPDATE bulk_delete_jobs SET status = 'paused'",
    ] {
        assert!(sqlx::query(bad).execute(&db).await.is_err(), "{bad}");
    }
    sqlx::query("UPDATE bulk_delete_jobs SET status = 'done'")
        .execute(&db)
        .await
        .expect("done");
    sqlx::query(
        "INSERT INTO bulk_delete_jobs(username, scope, created_at) VALUES('alice', 'c1', 6)",
    )
    .execute(&db)
    .await
    .expect("a new job once the old one ended");
    for stmt in [
        "DROP INDEX idx_bulk_delete_jobs_running",
        "DROP INDEX idx_bulk_delete_jobs_claim",
        "DROP INDEX idx_bulk_delete_jobs_finished",
        "DROP TABLE bulk_delete_jobs",
        "CREATE TABLE bulk_delete_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL)",
        "INSERT INTO bulk_delete_jobs(username, scope, created_at) VALUES('alice', 'c9', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("heal columns");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM bulk_delete_jobs WHERE status = 'running' AND deleted = 0 AND claimed_at = 0 AND author_filter IS NULL AND audit_id IS NULL").await,
            1,
            "healed"
        );
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn existing_users_get_an_empty_bio_column() {
    let path = crate::db::temp_db_path("bio_col");
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE users DROP COLUMN bio",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('old', 'old', '', 'text', 'identicon', 1)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert!(
        sqlx::query("SELECT bio FROM users")
            .fetch_all(&db)
            .await
            .is_err()
    );
    close(&db).await;
    let db = open(path.to_str()).await.expect("reopen");
    let old = get_user(&db, "old").await.expect("load").expect("old");
    assert_eq!(old.bio, None);
    sqlx::query("UPDATE users SET bio = 'hi' WHERE username = 'old'")
        .execute(&db)
        .await
        .expect("write bio");
    let old = get_user(&db, "old").await.expect("load").expect("old");
    assert_eq!(old.bio.as_deref(), Some("hi"));
    close(&db).await;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[tokio::test]
async fn existing_servers_get_empty_color_columns() {
    let path = crate::db::temp_db_path("server_colors");
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE servers DROP COLUMN banner_color",
        "ALTER TABLE servers DROP COLUMN name_color",
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', NULL, 1)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert!(
        sqlx::query("SELECT banner_color FROM servers")
            .fetch_all(&db)
            .await
            .is_err()
    );
    close(&db).await;
    let db = open(path.to_str()).await.expect("reopen");
    let row = sqlx::query("SELECT banner_color, name_color FROM servers WHERE name = 'old'")
        .fetch_one(&db)
        .await
        .expect("colors");
    assert_eq!(row.try_get::<Option<String>, _>(0).expect("banner"), None);
    assert_eq!(row.try_get::<Option<String>, _>(1).expect("name"), None);
    sqlx::query(
        "UPDATE servers SET banner_color = '#123456', name_color = '#abcdef' WHERE name = 'old'",
    )
    .execute(&db)
    .await
    .expect("write colors");
    close(&db).await;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[tokio::test]
async fn an_interrupted_migration_still_backfills_on_the_next_boot() {
    let path = crate::db::temp_db_path("migrate");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP TRIGGER messages_dm_latest_insert",
        "DROP TRIGGER messages_dm_latest_delete",
        "DROP INDEX idx_dms_a_latest",
        "DROP INDEX idx_dms_b_latest",
        "ALTER TABLE dms DROP COLUMN last_message_id",
        "INSERT INTO dms(user_a, user_b) VALUES('a', 'b')",
        "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'a', 'x', 1)",
        "CREATE TABLE idx_dms_a_latest(x INTEGER)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    assert!(open(path.to_str()).await.is_err());
    let raw = AnyPoolOptions::new()
        .max_connections(1)
        .connect(&format!("sqlite://{}", path.display()))
        .await
        .expect("raw");
    let cols = sqlx::query("SELECT name FROM pragma_table_info('dms')")
        .fetch_all(&raw)
        .await
        .expect("columns");
    assert!(!cols.iter().any(|r| {
        r.try_get::<String, _>(0)
            .is_ok_and(|c| c == "last_message_id")
    }));
    sqlx::query("DROP TABLE idx_dms_a_latest")
        .execute(&raw)
        .await
        .expect("unblock");
    raw.close().await;
    let db = open(path.to_str()).await.expect("reopen");
    assert_eq!(
        count(&db, "SELECT last_message_id FROM dms WHERE id = 1").await,
        1
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn guest_grant_networks_migrate_onto_an_old_database() {
    let path = crate::db::temp_db_path("grant_network_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_guest_grants_network",
        "ALTER TABLE guest_grants DROP COLUMN network",
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 1)",
        "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id) VALUES('h:old', 'club', 1, 7, 3)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = 'h:old' AND server = 'club' AND created_at = 1 AND last_used_at = 7 AND password_id = 3 AND network IS NULL").await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_guest_grants_network'").await,
            1
        );
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn call_log_kinds_migrate_onto_an_old_database() {
    let path = crate::db::temp_db_path("call_kind_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE messages DROP COLUMN call_kind",
        "ALTER TABLE messages DROP COLUMN call_video",
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
        "INSERT INTO messages(dm_id, author, content, kind, call_answered_at, call_ended_at, call_outcome, created_at) VALUES(1, 'alice', '', 'call', 5, 9, 'completed', 4)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE kind = 'call' AND call_answered_at = 5 AND call_ended_at = 9 AND call_outcome = 'completed' AND call_kind IS NULL AND call_video IS NULL").await,
            1
        );
        sqlx::query("INSERT INTO messages(dm_id, author, content, kind, call_kind, call_video, created_at) VALUES(1, 'bob', '', 'call', 'p2p', 1, 10)")
            .execute(&db)
            .await
            .expect("new log");
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM messages WHERE call_kind = 'p2p' AND call_video = 1"
        )
        .await,
        2
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn server_passwords_migrate_onto_an_old_database() {
    let path = crate::db::temp_db_path("pw_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_guest_grants_password",
        "DROP INDEX idx_server_passwords_server",
        "DROP TABLE server_passwords",
        "ALTER TABLE members DROP COLUMN joined_via",
        "ALTER TABLE guest_grants DROP COLUMN password_id",
        "DELETE FROM settings WHERE key = 'password_pepper'",
        "DELETE FROM settings WHERE key = 'relay_secret'",
        "DELETE FROM settings WHERE key = 'p2p_secret'",
        "UPDATE settings SET value = 'old-instance' WHERE key = 'instance_id'",
        "INSERT INTO servers(name, display_name, creator, password_hash, member_count, created_at) VALUES('club', 'Club', 'alice', 'hash', 1, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', 'alice', 1, 0, 5)",
        "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g', 'club', 1, 1)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    let mut peppers = Vec::new();
    let mut relays = Vec::new();
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM members WHERE server = 'club' AND username = 'alice' AND joined_via IS NULL AND joined_at = 5 AND is_admin = 1").await,
            1
        );
        assert_eq!(
            count(&db, &format!("SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = '{}' AND password_id IS NULL AND last_used_at = 1", secret_key("g"))).await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM servers WHERE name = 'club' AND password_hash = 'hash' AND member_count = 1").await,
            1
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM server_passwords").await, 0);
        sqlx::query("INSERT INTO server_passwords(server, hash, lookup, created_at) VALUES('club', 'h', 'l', 1)")
            .execute(&db)
            .await
            .expect("new table");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM server_passwords WHERE uses = 0 AND label IS NULL AND expires_at IS NULL AND max_uses IS NULL AND revoked_at IS NULL AND used_up_at IS NULL").await,
            1
        );
        sqlx::query("DELETE FROM server_passwords")
            .execute(&db)
            .await
            .expect("clear");
        let instance: String = sqlx::query("SELECT value FROM settings WHERE key = 'instance_id'")
            .fetch_one(&db)
            .await
            .expect("instance")
            .try_get(0)
            .expect("value");
        assert_eq!(instance, "old-instance");
        let p = pepper(&db).await.expect("pepper");
        assert_eq!(p.len(), 64);
        peppers.push(p);
        let relay: String = sqlx::query("SELECT value FROM settings WHERE key = 'relay_secret'")
            .fetch_one(&db)
            .await
            .expect("relay secret")
            .try_get(0)
            .expect("value");
        assert_eq!(relay.len(), 64);
        let p2p: String = sqlx::query("SELECT value FROM settings WHERE key = 'p2p_secret'")
            .fetch_one(&db)
            .await
            .expect("p2p secret")
            .try_get(0)
            .expect("value");
        assert_eq!(p2p.len(), 64);
        assert_ne!(p2p, relay);
        relays.push(format!("{relay}{p2p}"));
        close(&db).await;
    }
    assert_eq!(peppers[0], peppers[1], "the pepper is inserted once");
    assert_eq!(
        relays[0], relays[1],
        "the relay and P2P secrets are inserted once"
    );
    wipe();
}

#[tokio::test]
async fn config_shares_table_is_added_to_an_old_database() {
    let path = crate::db::temp_db_path("share_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_config_shares_owner",
        "DROP INDEX idx_config_shares_expires",
        "DROP TABLE config_shares",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, appear_offline, created_at) VALUES('alice', 'Alice', 'h', 'text', 'identicon', 1, 5)",
        "INSERT INTO tokens(token, username, created_at) VALUES('tok', 'alice', 5)",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'config_shares'"
        )
        .await,
        0
    );
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM users WHERE username = 'alice' AND appear_offline = 1 AND created_at = 5").await,
            1
        );
        assert_eq!(
            count(
                &db,
                &format!(
                    "SELECT COUNT(*) FROM tokens WHERE token = '{}' AND username = 'alice'",
                    secret_key("tok")
                )
            )
            .await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old' AND created_at = 7").await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_config_shares_%'").await,
            2
        );
        sqlx::query("INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('abcdefghijkl', 'alice', 'rc1.x', 1, 2)")
            .execute(&db)
            .await
            .expect("new table");
        assert!(
            sqlx::query("INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('abcdefghijkl', 'bob', 'rc1.y', 1, 2)")
                .execute(&db)
                .await
                .is_err(),
            "id is the primary key"
        );
        sqlx::query("DELETE FROM config_shares")
            .execute(&db)
            .await
            .expect("clear");
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn group_mentions_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("group_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_group_pings_channel",
        "DROP INDEX idx_group_pings_message",
        "DROP INDEX idx_group_pings_created",
        "DROP INDEX idx_group_pings_role",
        "DROP INDEX idx_group_pings_server",
        "DROP INDEX idx_here_pings_ping",
        "DROP TABLE here_pings",
        "DROP TABLE group_pings",
        "ALTER TABLE roles DROP COLUMN mentionable",
        "ALTER TABLE messages DROP COLUMN group_mentions",
        "UPDATE settings SET value = '3' WHERE key = 'schema_version'",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'all', 1, 31, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'kick', 1, 4, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'plain', 0, 31, 1)",
        "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'old', '#ffffff', 31)",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'all', 'old @everyone', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'all' AND content = 'old @everyone' AND created_at = 7 AND group_mentions IS NULL").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM roles WHERE name = 'old' AND perms = 543 AND mentionable = 0"
            )
            .await,
            1
        );
        assert_eq!(
            count(&db, "SELECT perms FROM members WHERE username = 'all'").await,
            ALL_PERMS
        );
        assert_eq!(
            count(&db, "SELECT perms FROM members WHERE username = 'kick'").await,
            516
        );
        assert_eq!(
            count(&db, "SELECT perms FROM members WHERE username = 'plain'").await,
            31
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_group_pings_%' OR name = 'idx_here_pings_ping')").await,
            9
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        sqlx::query("INSERT INTO group_pings(message_id, channel_id, server, kind, actor, created_at) SELECT id, channel_id, 'rchat', 'everyone', 'all', 7 FROM messages WHERE author = 'all'")
            .execute(&db)
            .await
            .expect("new table");
        assert!(
            sqlx::query("INSERT INTO group_pings(message_id, channel_id, server, kind, actor, created_at) SELECT id, channel_id, 'rchat', 'nobody', 'all', 7 FROM messages WHERE author = 'all'")
                .execute(&db)
                .await
                .is_err(),
            "kind is checked"
        );
        sqlx::query("INSERT INTO here_pings(ping_id, username) SELECT id, 'kick' FROM group_pings")
            .execute(&db)
            .await
            .expect("here");
        sqlx::query("DELETE FROM group_pings")
            .execute(&db)
            .await
            .expect("clear");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM here_pings").await, 0);
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn group_pings_read_replaces_the_inbox_markers() {
    let path = crate::db::temp_db_path("group_read");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_group_pings_read_message",
        "DROP INDEX idx_group_pings_read_created",
        "DROP INDEX idx_group_pings_server_time",
        "DROP TABLE group_pings_read",
        "UPDATE settings SET value = '11' WHERE key = 'schema_version'",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'boss', '@everyone', 7)",
        "INSERT INTO group_pings(message_id, channel_id, server, kind, actor, created_at) SELECT id, channel_id, 'rchat', 'everyone', 'boss', 7 FROM messages",
        "INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at, seen) SELECT 'alice', 'mention', 'c' || channel_id, 'rchat', id, 'boss', 7, 3 FROM messages",
        "INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at, seen) SELECT 'alice', 'reaction', 'c' || channel_id, 'rchat', id, 'bob', 7, 1 FROM messages",
        "INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at, seen) SELECT 'alice', 'mention', 'c' || channel_id, 'rchat', id, 'bob', 7, 0 FROM messages",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for round in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pings WHERE seen = 3").await,
            0,
            "markers are gone"
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pings WHERE seen IN (0, 1)").await,
            2,
            "real pings stay"
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM group_pings").await, 1);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_group_pings_read_message', 'idx_group_pings_read_created', 'idx_group_pings_server_time')").await,
            3
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        if round == 0 {
            sqlx::query("INSERT INTO group_pings_read(username, message_id, created_at) SELECT 'alice', id, 7 FROM messages")
                .execute(&db)
                .await
                .expect("new table");
        } else {
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM group_pings_read").await,
                1,
                "kept on a second start"
            );
            sqlx::query("DELETE FROM messages")
                .execute(&db)
                .await
                .expect("delete");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM group_pings_read").await,
                0,
                "cascades with the message"
            );
        }
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn audit_log_is_added_to_an_old_database() {
    let path = crate::db::temp_db_path("audit_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_audit_log_server",
        "DROP INDEX idx_audit_log_action",
        "DROP INDEX idx_audit_log_actor",
        "DROP INDEX idx_audit_log_created",
        "DROP TABLE audit_channels",
        "DROP TABLE audit_log",
        "UPDATE settings SET value = '4' WHERE key = 'schema_version'",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'all', 1, 63, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'zero', 1, 0, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'kick', 1, 4, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'plain', 0, 63, 1)",
        "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'old', '#ffffff', 63)",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'all', 'old', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'all' AND content = 'old' AND created_at = 7").await,
            1
        );
        for (name, perms) in [
            ("all", ALL_PERMS),
            ("zero", 0),
            ("kick", 516),
            ("plain", 63),
        ] {
            assert_eq!(
                count(
                    &db,
                    &format!("SELECT perms FROM members WHERE username = '{name}'")
                )
                .await,
                perms,
                "{name}"
            );
        }
        assert_eq!(
            count(&db, "SELECT perms FROM roles WHERE name = 'old'").await,
            575
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_audit_log_%'").await,
            4
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        sqlx::query(
            "INSERT INTO audit_log(server, action, created_at) VALUES('rchat', 'member.kick', 1)",
        )
        .execute(&db)
        .await
        .expect("new table");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM audit_log WHERE actor IS NULL AND staff = 0 AND target_staff = 0 AND details = '{}' AND target_kind IS NULL").await,
            1
        );
        sqlx::query("INSERT INTO audit_channels(entry_id, channel_id) SELECT id, 5 FROM audit_log")
            .execute(&db)
            .await
            .expect("channel refs");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM audit_channels WHERE channel_id = 5 AND private = 0"
            )
            .await,
            1
        );
        assert!(
            sqlx::query("INSERT INTO audit_log(server, action, created_at) VALUES('nowhere', 'member.kick', 1)")
                .execute(&db)
                .await
                .is_err(),
            "server is a foreign key"
        );
        sqlx::query("DELETE FROM audit_log")
            .execute(&db)
            .await
            .expect("clear");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM audit_channels").await,
            0,
            "channel refs go with their entry"
        );
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn timeouts_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("timeout_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_member_timeouts_until",
        "DROP TABLE member_timeouts",
        "UPDATE settings SET value = '6' WHERE key = 'schema_version'",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'all', 1, 127, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'zero', 1, 0, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'kick', 1, 4, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'plain', 0, 127, 1)",
        "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'old', '#ffffff', 127)",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'all', 'old', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'all' AND content = 'old' AND created_at = 7").await,
            1
        );
        for (name, perms) in [
            ("all", ALL_PERMS),
            ("zero", 0),
            ("kick", 516),
            ("plain", 127),
        ] {
            assert_eq!(
                count(
                    &db,
                    &format!("SELECT perms FROM members WHERE username = '{name}'")
                )
                .await,
                perms,
                "{name}"
            );
        }
        assert_eq!(
            count(&db, "SELECT perms FROM roles WHERE name = 'old'").await,
            639
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_member_timeouts_until'").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        sqlx::query("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'plain', 9, 1)")
            .execute(&db)
            .await
            .expect("new table");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM member_timeouts WHERE reason IS NULL AND set_by IS NULL AND until = 9").await,
            1
        );
        assert!(
            sqlx::query("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('nowhere', 'plain', 9, 1)")
                .execute(&db)
                .await
                .is_err(),
            "server is a foreign key"
        );
        sqlx::query("DELETE FROM member_timeouts")
            .execute(&db)
            .await
            .expect("clear");
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn webhooks_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("webhook_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_webhooks_server",
        "DROP INDEX idx_webhooks_channel",
        "DROP INDEX idx_outgoing_webhooks_server",
        "DROP INDEX idx_webhook_deliveries_due",
        "DROP INDEX idx_webhook_deliveries_hook",
        "DROP INDEX idx_webhook_deliveries_created",
        "DROP TABLE webhook_deliveries",
        "DROP TABLE outgoing_webhooks",
        "DROP TABLE webhooks",
        "ALTER TABLE messages DROP COLUMN webhook_id",
        "ALTER TABLE messages DROP COLUMN webhook_name",
        "ALTER TABLE messages DROP COLUMN webhook_avatar",
        "ALTER TABLE messages DROP COLUMN webhook_embeds",
        "DELETE FROM settings WHERE key = 'outgoing_webhooks'",
        "UPDATE settings SET value = '13' WHERE key = 'schema_version'",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'all', 1, 255, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'zero', 1, 0, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'kick', 1, 4, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'plain', 0, 255, 1)",
        "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'old', '#ffffff', 255)",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'all', 'old', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'all' AND content = 'old' AND created_at = 7 AND webhook_id IS NULL AND webhook_name IS NULL AND webhook_avatar IS NULL AND webhook_embeds IS NULL").await,
            1
        );
        for (name, perms) in [
            ("all", ALL_PERMS),
            ("zero", 0),
            ("kick", 516),
            ("plain", 255),
        ] {
            assert_eq!(
                count(
                    &db,
                    &format!("SELECT perms FROM members WHERE username = '{name}'")
                )
                .await,
                perms,
                "{name}"
            );
        }
        assert_eq!(
            count(&db, "SELECT perms FROM roles WHERE name = 'old'").await,
            767
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%webhook%'").await,
            6
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM settings WHERE key = 'outgoing_webhooks' AND value = '0'"
            )
            .await,
            1,
            "outgoing webhooks start off"
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        let cid = count(&db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        sqlx::query("INSERT INTO webhooks(server, channel_id, name, token_hash, created_at) VALUES('rchat', $1, 'Hook', 'h', 1)")
            .bind(cid)
            .execute(&db)
            .await
            .expect("new table");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM webhooks WHERE avatar_kind = 'identicon' AND creator_mentions = 0 AND avatar_color IS NULL AND last_used_at IS NULL").await,
            1
        );
        sqlx::query("INSERT INTO outgoing_webhooks(server, name, url, events, secret, created_at) VALUES('rchat', 'Out', 'https://example.com/', 'message.created', 's', 1)")
            .execute(&db)
            .await
            .expect("outgoing table");
        sqlx::query("INSERT INTO webhook_deliveries(hook_id, event, next_at, created_at) VALUES((SELECT id FROM outgoing_webhooks), 'ping', 1, 1)")
            .execute(&db)
            .await
            .expect("deliveries table");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'pending' AND attempts = 0 AND claimed_at = 0").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM outgoing_webhooks WHERE enabled = 1 AND failures = 0"
            )
            .await,
            1
        );
        assert!(
            sqlx::query("INSERT INTO webhooks(server, channel_id, name, token_hash, created_at) VALUES('nowhere', $1, 'Hook', 'h', 1)")
                .bind(cid)
                .execute(&db)
                .await
                .is_err(),
            "server is a foreign key"
        );
        sqlx::query("DELETE FROM outgoing_webhooks")
            .execute(&db)
            .await
            .expect("clear outgoing");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM webhook_deliveries").await,
            0
        );
        sqlx::query("DELETE FROM webhooks")
            .execute(&db)
            .await
            .expect("clear");
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn pings_table_is_added_to_an_old_database() {
    let path = crate::db::temp_db_path("ping_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_pings_user",
        "DROP INDEX idx_pings_message",
        "DROP INDEX idx_pings_created",
        "DROP INDEX idx_pings_seen",
        "DROP INDEX idx_pings_actor",
        "DROP TABLE pings",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'hi @bob', 7)",
        "INSERT INTO read_state(username, scope, last_read) VALUES('bob', 'c1', 3)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'pings'"
        )
        .await,
        0
    );
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'hi @bob' AND created_at = 7").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM read_state WHERE username = 'bob' AND last_read = 3"
            )
            .await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_pings_%'").await,
            6
        );
        sqlx::query("INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at) SELECT 'bob', 'mention', 'c' || channel_id, 'rchat', id, 'alice', 8 FROM messages WHERE author = 'alice'")
            .execute(&db)
            .await
            .expect("ping on an old message");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pings WHERE seen = 0 AND emoji IS NULL AND thread_root_id IS NULL AND kind = 'mention'").await,
            1
        );
        assert!(
            sqlx::query("INSERT INTO pings(username, kind, scope, message_id, actor, created_at) VALUES('bob', 'other', 'c1', 1, 'alice', 8)")
                .execute(&db)
                .await
                .is_err(),
            "kind is checked"
        );
        sqlx::query("DELETE FROM pings")
            .execute(&db)
            .await
            .expect("clear");
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    for stmt in [
        "DROP TABLE pings",
        "CREATE TABLE pings(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('mention','reply','reaction')), scope TEXT NOT NULL, server TEXT REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, actor TEXT NOT NULL, emoji TEXT, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)",
        "INSERT INTO pings(username, kind, scope, message_id, actor, created_at) SELECT 'bob', 'mention', 'c1', id, 'alice', 9 FROM messages WHERE author = 'alice'",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("add thread_root_id");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pings WHERE created_at = 9 AND thread_root_id IS NULL AND seen = 0").await,
            1,
            "a pings table without thread_root_id gains the column"
        );
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn edited_at_is_added_to_an_old_database() {
    let path = crate::db::temp_db_path("edit_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE messages DROP COLUMN edited_at",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'edited_at'"
        )
        .await,
        0
    );
    close(&db).await;
    for round in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'edited_at'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND created_at = 7"
            )
            .await,
            1
        );
        let old: i64 =
            sqlx::query("SELECT id FROM messages WHERE author = 'alice' AND created_at = 7")
                .fetch_one(&db)
                .await
                .expect("old")
                .try_get(0)
                .expect("id");
        let loaded =
            crate::api::messages::load_message(&db, old, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .expect("old message");
        match round {
            0 => {
                assert_eq!(loaded.content, "old message");
                assert_eq!(loaded.edited_at, None);
                sqlx::query(
                    "UPDATE messages SET content = 'edited old', edited_at = 9 WHERE id = $1",
                )
                .bind(old)
                .execute(&db)
                .await
                .expect("edit an old message");
            }
            _ => {
                assert_eq!(loaded.content, "edited old");
                assert_eq!(loaded.edited_at, Some(9), "the edit survives a restart");
            }
        }
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn forward_columns_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("fwd_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let cols = "('fwd_author', 'fwd_created_at', 'fwd_source_id', 'fwd_origin', 'fwd_dropped')";
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_messages_fwd_author",
        "DROP TRIGGER messages_media_release",
        "ALTER TABLE messages DROP COLUMN fwd_author",
        "ALTER TABLE messages DROP COLUMN fwd_created_at",
        "ALTER TABLE messages DROP COLUMN fwd_source_id",
        "ALTER TABLE messages DROP COLUMN fwd_origin",
        "ALTER TABLE messages DROP COLUMN fwd_dropped",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    let present =
        format!("SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name IN {cols}");
    assert_eq!(count(&db, &present).await, 0);
    close(&db).await;
    for round in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(count(&db, &present).await, 5);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('idx_messages_fwd_author', 'messages_media_release')"
            )
            .await,
            2,
            "the release trigger comes back once the forward columns exist"
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7 AND fwd_author IS NULL AND fwd_created_at IS NULL AND fwd_source_id IS NULL AND fwd_origin IS NULL AND fwd_dropped IS NULL").await,
            1
        );
        let old: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'old message'")
            .fetch_one(&db)
            .await
            .expect("old")
            .try_get(0)
            .expect("id");
        let loaded =
            crate::api::messages::load_message(&db, old, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .expect("old message");
        assert!(loaded.forward.is_none());
        if round == 0 {
            sqlx::query("INSERT INTO messages(channel_id, author, content, fwd_author, fwd_created_at, fwd_source_id, fwd_origin, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'bob', 'old message', 'alice', 7, $1, '#general · RChat', 8)")
                .bind(old)
                .execute(&db)
                .await
                .expect("forward an old message");
        }
        let copy: i64 = sqlx::query("SELECT id FROM messages WHERE author = 'bob'")
            .fetch_one(&db)
            .await
            .expect("copy")
            .try_get(0)
            .expect("id");
        let fwd = crate::api::messages::load_message(&db, copy, crate::api::messages::Quotes::Skip)
            .await
            .expect("load")
            .expect("copy")
            .forward
            .expect("forward survives a restart");
        assert_eq!((fwd.source_id, fwd.created_at), (old, 7));
        assert_eq!(fwd.origin.as_deref(), Some("#general - RChat"));
        assert_eq!(fwd.origin_channel.as_deref(), Some("general"));
        assert_eq!(fwd.origin_server.as_deref(), Some("RChat"));
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn pin_columns_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("pin_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let cols = "('pinned_at', 'pinned_by', 'pin_message_id')";
    let indexes = "('idx_messages_channel_pins', 'idx_messages_dm_pins')";
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_messages_channel_pins",
        "DROP INDEX idx_messages_dm_pins",
        "DROP INDEX idx_messages_pin_notice",
        "ALTER TABLE messages DROP COLUMN pinned_at",
        "ALTER TABLE messages DROP COLUMN pinned_by",
        "ALTER TABLE messages DROP COLUMN pin_message_id",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    let present =
        format!("SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name IN {cols}");
    let indexed = format!("SELECT COUNT(*) FROM sqlite_master WHERE name IN {indexes}");
    assert_eq!(count(&db, &present).await, 0);
    assert_eq!(count(&db, &indexed).await, 0);
    close(&db).await;
    for round in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(count(&db, &present).await, 3);
        assert_eq!(count(&db, &indexed).await, 2);
        let old: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'old message'")
            .fetch_one(&db)
            .await
            .expect("old")
            .try_get(0)
            .expect("id");
        if round == 0 {
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7 AND kind = 'user' AND pinned_at IS NULL AND pinned_by IS NULL AND pin_message_id IS NULL").await,
                1
            );
            let loaded =
                crate::api::messages::load_message(&db, old, crate::api::messages::Quotes::Skip)
                    .await
                    .expect("load")
                    .expect("old message");
            assert_eq!((loaded.pinned_at, loaded.pin_message_id), (None, None));
            sqlx::query("UPDATE messages SET pinned_at = 9000, pinned_by = 'bob' WHERE id = $1")
                .bind(old)
                .execute(&db)
                .await
                .expect("pin an old message");
            sqlx::query("INSERT INTO messages(channel_id, author, content, kind, pin_message_id, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'bob', '', 'pin', $1, 9)")
                .bind(old)
                .execute(&db)
                .await
                .expect("pin notice");
        }
        let loaded =
            crate::api::messages::load_message(&db, old, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .expect("old message");
        assert_eq!(loaded.content, "old message");
        assert_eq!(loaded.pinned_at, Some(9), "the pin survives a restart");
        let notice: i64 = sqlx::query("SELECT id FROM messages WHERE kind = 'pin'")
            .fetch_one(&db)
            .await
            .expect("notice")
            .try_get(0)
            .expect("id");
        let notice =
            crate::api::messages::load_message(&db, notice, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .expect("notice");
        assert_eq!(notice.pin_message_id, Some(old));
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn system_message_columns_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("system_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let cols = "('system_channel_id', 'join_messages', 'leave_messages')";
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_messages_system",
        "ALTER TABLE servers DROP COLUMN system_channel_id",
        "ALTER TABLE servers DROP COLUMN join_messages",
        "ALTER TABLE servers DROP COLUMN leave_messages",
        "INSERT INTO servers(name, display_name, creator, banner_color, created_at) VALUES('old', 'Old', 'alice', '#123456', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'talk', 'voice', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'chat', 'text', 3)",
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('old', 'alice', 1, 3)",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE name = 'chat'), 'alice', 'old message', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    let present = format!("SELECT COUNT(*) FROM pragma_table_info('servers') WHERE name IN {cols}");
    let indexed = "SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_messages_system'";
    assert_eq!(count(&db, &present).await, 0);
    assert_eq!(count(&db, indexed).await, 0);
    close(&db).await;
    for round in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(count(&db, &present).await, 3);
        assert_eq!(count(&db, indexed).await, 1);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM servers WHERE system_channel_id IS NULL AND join_messages = 1 AND leave_messages = 1").await,
            2,
            "existing servers default to on, in the default channel"
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM servers WHERE name = 'old' AND display_name = 'Old' AND creator = 'alice' AND banner_color = '#123456' AND created_at = 3").await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE content = 'old message' AND kind = 'user' AND created_at = 7").await,
            1
        );
        if round == 0 {
            let mut conn = db.acquire().await.expect("conn");
            let posted = crate::api::system_messages::post_system(
                &mut conn,
                "old",
                "bob",
                crate::api::system_messages::SystemKind::Join,
            )
            .await
            .expect("post");
            assert!(posted.is_some());
        }
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.name = 'chat' AND m.kind = 'join' AND m.author = 'bob' AND m.content = ''").await,
            1,
            "the join goes to the first text channel and survives a restart"
        );
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn channel_restrictions_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("restrict_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let cols = "('restrict_view', 'restrict_send')";
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE channels DROP COLUMN restrict_view",
        "ALTER TABLE channels DROP COLUMN restrict_send",
        "DELETE FROM settings WHERE key = 'restrict_backfill_v1'",
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', 'alice', 3)",
        "INSERT INTO channels(server, name, kind, slowmode_seconds, created_at) VALUES('old', 'open', 'text', 30, 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'private', 'text', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'talk', 'voice', 3)",
        "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'private'), 'u:bob', 1, 0, 1)",
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('old', 'alice', 1, 3)",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE name = 'private'), 'alice', 'old secret', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    let present =
        format!("SELECT COUNT(*) FROM pragma_table_info('channels') WHERE name IN {cols}");
    assert_eq!(count(&db, &present).await, 0);
    close(&db).await;
    for round in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(count(&db, &present).await, 2);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM channels WHERE restrict_send = 0").await,
            4
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM channels WHERE restrict_view = 0 AND name IN ('general', 'open', 'talk')").await,
            3,
            "channels without rules stay open"
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM channels WHERE name = 'private' AND restrict_view = 1"
            )
            .await,
            1 - round,
            "channels that had rules stay private; the backfill runs once"
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM channels WHERE name = 'open' AND slowmode_seconds = 30 AND created_at = 3").await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM channel_perms WHERE subject = 'u:bob' AND can_view = 1 AND can_send = 0").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM messages WHERE content = 'old secret' AND created_at = 7"
            )
            .await,
            1
        );
        if round == 0 {
            let cid = count(&db, "SELECT id FROM channels WHERE name = 'private'").await;
            let rows = sqlx::query("SELECT subject, can_view, can_send, can_read_history FROM channel_perms WHERE channel_id = $1")
                .bind(cid)
                .fetch_all(&db)
                .await
                .expect("rules");
            let rows = rows
                .iter()
                .map(|r| perm_row(r, 0))
                .collect::<sqlx::Result<Vec<_>>>()
                .expect("rows");
            let restrict = Restrict {
                view: true,
                send: false,
            };
            let carol = fold_access(&rows, &["u:carol".to_string()], false, restrict);
            let bob = fold_access(&rows, &["u:bob".to_string()], false, restrict);
            assert!(!carol.view, "the old private channel is still hidden");
            assert!(bob.view && !bob.send && bob.history);
            sqlx::query("UPDATE channels SET restrict_view = 0 WHERE name = 'private'")
                .execute(&db)
                .await
                .expect("admin opens it");
        }
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn p2p_hashes_and_the_p2p_switch_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("p2p_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE messages DROP COLUMN media_sha256",
        "DELETE FROM settings WHERE key = 'p2p_attachments'",
        "INSERT INTO settings(key, value) VALUES('asset_uploads', '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
        "INSERT INTO messages(author, content, media_id, media_filename, media_kind, media_hoster, media_size, media_mime, created_at) VALUES('alice', 'old file', 'ab', 'a.png', 'p2p', 'alice', 3, 'image/png', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    let present = "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'media_sha256'";
    assert_eq!(count(&db, present).await, 0);
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(count(&db, present).await, 1);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE content = 'old file' AND media_id = 'ab' AND media_kind = 'p2p' AND media_size = 3 AND media_sha256 IS NULL AND created_at = 7").await,
            1,
            "old P2P rows stay, without a hash (unverified)"
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM settings WHERE key = 'p2p_attachments' AND value = '1'"
            )
            .await,
            1,
            "P2P attachments are on after an upgrade"
        );
        let settings = crate::api::Settings::load(&db).await;
        assert!(settings.p2p_attachments && !settings.asset_uploads && !settings.text_only());
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn restrict_backfill_survives_an_interrupted_upgrade() {
    let path = crate::db::temp_db_path("restrict_marker");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let marker = "SELECT COUNT(*) FROM settings WHERE key = 'restrict_backfill_v1'";
    let private = "SELECT restrict_view FROM channels WHERE name = 'private'";
    let db = open(path.to_str()).await.expect("open");
    assert_eq!(count(&db, marker).await, 1, "a fresh database is marked");
    for stmt in [
        "DELETE FROM settings WHERE key = 'restrict_backfill_v1'",
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', 'alice', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'open', 'text', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'private', 'text', 3)",
        "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'private'), 'u:bob', 1, 0, 1)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert_eq!(count(&db, private).await, 0, "column added, backfill lost");
    close(&db).await;
    let db = open(path.to_str()).await.expect("reboot");
    assert_eq!(
        count(&db, private).await,
        1,
        "the missing marker runs the backfill"
    );
    assert_eq!(
        count(
            &db,
            "SELECT restrict_view FROM channels WHERE name = 'open'"
        )
        .await,
        0
    );
    assert_eq!(count(&db, marker).await, 1);
    sqlx::query("UPDATE channels SET restrict_view = 0 WHERE name = 'private'")
        .execute(&db)
        .await
        .expect("admin opens it");
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("later boot");
        assert_eq!(count(&db, private).await, 0, "the admin's opening survives");
        assert_eq!(count(&db, marker).await, 1);
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn the_sweep_keeps_the_newest_seen_pings_of_recipients_above_the_cap() {
    let path = crate::db::temp_db_path("pings_kept");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    let t = now();
    let mid = count(&db, "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'hi', 1 FROM channels WHERE server = 'rchat' RETURNING id").await;
    for (user, n) in [("bob", PINGS_KEPT + 600), ("carol", 5)] {
        sqlx::query(sqlx::AssertSqlSafe(format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {n}) INSERT INTO pings(username, kind, scope, message_id, actor, emoji, created_at, seen) SELECT '{user}', 'reaction', 'c1', $2, 'alice', 'x', $1, 1 FROM n")))
            .bind(t)
            .bind(mid)
            .execute(&db)
            .await
            .expect("seen pings");
    }
    let newest = count(&db, "SELECT MAX(id) FROM pings WHERE username = 'bob'").await;
    let swept = sweep_stale(&db, &Limits::default()).await.expect("sweep");
    assert_eq!(swept.pings, 600);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM pings WHERE username = 'bob'").await,
        PINGS_KEPT
    );
    assert_eq!(
        count(&db, "SELECT MAX(id) FROM pings WHERE username = 'bob'").await,
        newest,
        "the newest are kept"
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM pings WHERE username = 'carol'").await,
        5
    );
    assert_eq!(
        sweep_stale(&db, &Limits::default())
            .await
            .expect("again")
            .pings,
        0
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn rules_from_an_older_binary_restrict_their_channel_on_the_next_start() {
    let path = crate::db::temp_db_path("restrict_set");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let view = |name: &str| format!("SELECT restrict_view FROM channels WHERE name = '{name}'");
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'opened', 'text', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'legacy', 'text', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'later', 'voice', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'plain', 'text', 3)",
        "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history, restrict_set) VALUES((SELECT id FROM channels WHERE name = 'opened'), 'u:bob', 0, 0, 0, 1)",
        "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'legacy'), 'u:bob', 1, 1, 1)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    let db = open(path.to_str()).await.expect("after the old binary");
    assert_eq!(
        count(&db, &view("legacy")).await,
        1,
        "a rule an older binary wrote after the first backfill restricts its channel"
    );
    assert_eq!(
        count(&db, &view("opened")).await,
        0,
        "a channel with only marked rules stays open"
    );
    assert_eq!(count(&db, &view("plain")).await, 0);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM channel_perms WHERE restrict_set = 0"
        )
        .await,
        0
    );
    for stmt in [
        "UPDATE channels SET restrict_view = 0 WHERE name = 'legacy'",
        "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'later'), 'u:bob', 1, 1, 1)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("later boot");
        assert_eq!(
            count(&db, &view("legacy")).await,
            0,
            "an admin who opens it after the upgrade keeps it open"
        );
        assert_eq!(count(&db, &view("later")).await, 1, "voice channels too");
        assert_eq!(count(&db, &view("opened")).await, 0);
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn restrict_marks_are_added_to_a_database_that_was_already_upgraded() {
    let path = crate::db::temp_db_path("restrict_mark");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE channel_perms DROP COLUMN restrict_set",
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 3)",
        "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'opened', 'text', 3)",
        "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'opened'), 'u:bob', 0, 1, 1)",
        "UPDATE settings SET value = '1' WHERE key = 'schema_version'",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(
                &db,
                "SELECT restrict_view FROM channels WHERE name = 'opened'"
            )
            .await,
            0,
            "rules from a binary that knew restrict_view keep an opened channel open"
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM channel_perms WHERE restrict_set = 1"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn reply_columns_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("reply_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "ALTER TABLE messages DROP COLUMN reply_mention",
        "ALTER TABLE messages DROP COLUMN reply_to",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name IN ('reply_to', 'reply_mention')").await,
        0
    );
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7 AND reply_to IS NULL AND reply_mention = 0").await,
            1
        );
        let old: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'old message'")
            .fetch_one(&db)
            .await
            .expect("old")
            .try_get(0)
            .expect("id");
        let loaded =
            crate::api::messages::load_message(&db, old, crate::api::messages::Quotes::Since(None))
                .await
                .expect("load")
                .expect("old message");
        assert!(loaded.reply_to.is_none());
        sqlx::query("INSERT INTO messages(channel_id, author, content, reply_to, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'bob', 'new reply', $1, 8)")
            .bind(old)
            .execute(&db)
            .await
            .expect("reply to an old message");
        let reply: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'new reply'")
            .fetch_one(&db)
            .await
            .expect("reply")
            .try_get(0)
            .expect("id");
        let quoted = crate::api::messages::load_message(
            &db,
            reply,
            crate::api::messages::Quotes::Since(None),
        )
        .await
        .expect("load")
        .expect("reply")
        .reply_to
        .expect("quote");
        assert_eq!(quoted.id, old);
        assert_eq!(quoted.content, "old message");
        assert!(!quoted.deleted && !quoted.mention);
        sqlx::query("DELETE FROM messages WHERE content = 'new reply'")
            .execute(&db)
            .await
            .expect("clear");
        close(&db).await;
    }
    wipe();
}

#[tokio::test]
async fn reactions_table_is_added_to_an_old_database() {
    let path = crate::db::temp_db_path("reaction_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in [
        "DROP INDEX idx_reactions_message",
        "DROP INDEX idx_reactions_username",
        "DROP TABLE reactions",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
        "INSERT INTO pings(username, kind, scope, message_id, actor, created_at) SELECT 'alice', 'mention', 'c1', id, 'bob', 8 FROM messages WHERE content = 'old message'",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'reactions'"
        )
        .await,
        0
    );
    close(&db).await;
    for round in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7").await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM pings WHERE username = 'alice' AND created_at = 8"
            )
            .await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_reactions_%'").await,
            3
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM reactions").await,
            round,
            "rows survive a restart"
        );
        if round == 0 {
            sqlx::query("INSERT INTO reactions(message_id, username, emoji, created_at) SELECT id, 'bob', '👍', 9 FROM messages WHERE content = 'old message'")
                .execute(&db)
                .await
                .expect("react to an old message");
            assert!(
                sqlx::query("INSERT INTO reactions(message_id, username, emoji, created_at) SELECT id, 'bob', '👍', 10 FROM messages WHERE content = 'old message'")
                    .execute(&db)
                    .await
                    .is_err(),
                "one row per user and emoji"
            );
        }
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("reopen");
    sqlx::query("DELETE FROM messages WHERE content = 'old message'")
        .execute(&db)
        .await
        .expect("delete");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM reactions").await,
        0,
        "cascade"
    );
    close(&db).await;
    wipe();
}

#[tokio::test]
async fn dead_server_passwords_are_purged_after_30_days() {
    let (state, path) = temp_state("sweep_passwords").await;
    let db = &state.db;
    sqlx::query("UPDATE servers SET password_hash = '!none' WHERE name = 'rchat'")
        .execute(db)
        .await
        .expect("protect");
    let t = now();
    let old = t - SERVER_PASSWORD_KEEP - 10;
    let recent = t - 86400;
    let mut ids = Vec::new();
    for (expires, revoked, used_up) in [
        (Some(old), None, None),
        (None, Some(old), None),
        (None, None, Some(old)),
        (Some(recent), None, None),
        (None, Some(recent), None),
        (None, None, None),
    ] {
        let id: i64 = sqlx::query("INSERT INTO server_passwords(server, hash, lookup, created_at, expires_at, revoked_at, used_up_at) VALUES('rchat', 'h', $1, 0, $2, $3, $4) RETURNING id")
            .bind(format!("l{}", ids.len()))
            .bind(expires)
            .bind(revoked)
            .bind(used_up)
            .fetch_one(db)
            .await
            .expect("password")
            .try_get(0)
            .expect("id");
        ids.push(id);
    }
    for (grant, id) in [("dead", ids[4]), ("live", ids[5])] {
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id) VALUES($1, 'rchat', $2, $2, $3)")
            .bind(grant)
            .bind(t)
            .bind(id)
            .execute(db)
            .await
            .expect("grant");
    }
    let swept = sweep_stale(db, &state.limits).await.expect("sweep");
    assert_eq!((swept.server_passwords, swept.guest_grants), (3, 1));
    assert_eq!(count(db, "SELECT COUNT(*) FROM server_passwords").await, 3);
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = 'live'"
        )
        .await,
        1
    );
    done(state, path).await;
}

#[tokio::test]
async fn in_memory_databases_read_from_the_writer() {
    let db = open(Some("sqlite::memory:")).await.expect("memory");
    sqlx::query("INSERT INTO settings(key, value) VALUES('probe', '1')")
        .execute(&db)
        .await
        .expect("write");
    let state = crate::state::AppState::new(
        db.clone(),
        crate::ws::Hub::new(),
        None,
        None,
        crate::instance::Instance::ephemeral(),
    );
    assert_eq!(
        count(
            &state.read(),
            "SELECT COUNT(*) FROM settings WHERE key = 'probe'"
        )
        .await,
        1
    );
    close(&db).await;
}

#[tokio::test]
async fn purge_deletes_in_batches() {
    let (state, path) = temp_state("purge_batches").await;
    let db = &state.db;
    let cid = general_id(db).await;
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1203) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, CASE WHEN i % 3 = 0 THEN 'keep' ELSE 'gone' END, 'x', i FROM n")
        .bind(cid)
        .execute(db)
        .await
        .expect("seed");
    let purged = purge_messages(db, "author = $1", "gone")
        .await
        .expect("purge");
    assert_eq!(purged, 802);
    assert_eq!(count(db, "SELECT COUNT(*) FROM messages").await, 401);
    done(state, path).await;
}

#[test]
fn sqlite_keeps_one_writer_and_trigger_versions_track_definitions() {
    assert_eq!(writer_connections(true, Some(8)), 1);
    assert_eq!(writer_connections(true, None), 1);
    assert_eq!(writer_connections(false, Some(20)), 20);
    assert_eq!(writer_connections(false, None), 8);
    let v = trigger_version(POSTGRES_TRIGGERS);
    assert_eq!(v, trigger_version(POSTGRES_TRIGGERS));
    assert_eq!(v.len(), 16);
    assert_ne!(v, trigger_version(&POSTGRES_TRIGGERS[1..]));
}

#[tokio::test]
async fn stale_rows_are_swept() {
    let (state, path) = temp_state("sweep_stale").await;
    let db = &state.db;
    let t = now();
    let old = t - 200 * 86400;
    for (sql, at) in [
        (
            "INSERT INTO tokens(token, username, created_at) VALUES('ancient', 'a', $1)",
            old,
        ),
        (
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g1', 'rchat', $1, $1)",
            old,
        ),
        (
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g2', 'rchat', $1, $1)",
            t,
        ),
        (
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g3', 'rchat', $1, $1 + 86400 * 199)",
            old,
        ),
        (
            "INSERT INTO login_attempts(username, day, count, last_at) VALUES('a', '1', 1, $1)",
            old,
        ),
        (
            "INSERT INTO change_attempts(session, day, failures, last_at) VALUES('a', '1', 1, $1)",
            old,
        ),
        (
            "INSERT INTO change_attempts(session, day, failures, last_at) VALUES('b', '1', 1, $1)",
            t,
        ),
        (
            "INSERT INTO embeds(url, fetched_at) VALUES('https://old.example/', $1)",
            old,
        ),
        (
            "INSERT INTO embeds(url, fetched_at) VALUES('https://kept.example/', $1)",
            old,
        ),
        (
            "INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('oldlinkaaaaa', 'a', 'rc1.x', 0, $1)",
            old,
        ),
        (
            "INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('nowlinkaaaaa', 'a', 'rc1.x', 0, $1)",
            t - 1,
        ),
        (
            "INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('livelinkaaaa', 'a', 'rc1.x', 0, $1 + 600)",
            t,
        ),
        (
            "INSERT INTO audit_log(server, actor, action, created_at) VALUES('rchat', 'a', 'member.ban', $1)",
            t - AUDIT_KEEP - 1,
        ),
        (
            "INSERT INTO audit_log(server, actor, action, created_at) VALUES('rchat', 'a', 'member.kick', $1)",
            t - AUDIT_KEEP + 60,
        ),
        (
            "INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'gone', $1, 0)",
            t - TIMEOUT_KEEP - 1,
        ),
        (
            "INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'ended', $1, 0)",
            t - 5,
        ),
        (
            "INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'live', $1, 0)",
            t + 600,
        ),
        (
            "INSERT INTO bulk_delete_jobs(username, scope, status, created_at, finished_at) VALUES('a', 'c1', 'done', 0, $1)",
            t - crate::api::bulk_delete::JOB_KEEP - 1,
        ),
        (
            "INSERT INTO bulk_delete_jobs(username, scope, status, created_at, finished_at) VALUES('a', 'c2', 'cancelled', 0, $1)",
            t - 60,
        ),
        (
            "INSERT INTO bulk_delete_jobs(username, scope, status, created_at, finished_at, claimed_at) VALUES('a', 'c3', 'running', 0, NULL, $1)",
            t - crate::api::bulk_delete::JOB_KEEP - 1,
        ),
        (
            "INSERT INTO recovery_challenges(nonce, username, expires_at) VALUES('used-up', 'a', $1)",
            t - 1,
        ),
        (
            "INSERT INTO recovery_challenges(nonce, username, expires_at) VALUES('waiting', 'a', $1)",
            t,
        ),
    ] {
        sqlx::query(sql).bind(at).execute(db).await.expect(sql);
    }
    let cid = general_id(db).await;
    let mid: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'a', 'x', 1) RETURNING id")
        .bind(cid)
        .fetch_one(db)
        .await
        .expect("msg")
        .try_get(0)
        .expect("id");
    sqlx::query(
        "INSERT INTO message_embeds(message_id, ord, url) VALUES($1, 0, 'https://kept.example/')",
    )
    .bind(mid)
    .execute(db)
    .await
    .expect("embed ref");
    for (seen, at) in [(1, t), (0, old), (0, t)] {
        sqlx::query("INSERT INTO pings(username, kind, scope, message_id, actor, created_at, seen) VALUES('b', 'mention', 'c1', $1, 'a', $2, $3)")
            .bind(mid)
            .bind(at)
            .bind(seen)
            .execute(db)
            .await
            .expect("ping");
    }
    let swept = sweep_stale_at(db, &state.limits, t).await.expect("sweep");
    assert_eq!(
        swept,
        Swept {
            guest_grants: 1,
            server_passwords: 0,
            login_attempts: 1,
            password_attempts: 1,
            embeds: 1,
            pings: 1,
            config_shares: 2,
            audit_log: 1,
            member_timeouts: 1,
            bulk_delete_jobs: 1,
            webhook_deliveries: 0,
            recovery_challenges: 1,
            member_counts: 0,
        }
    );
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM recovery_challenges WHERE nonce = 'waiting'"
        )
        .await,
        count(db, "SELECT COUNT(*) FROM recovery_challenges").await
    );
    assert_eq!(
        count(db, "SELECT COUNT(*) FROM recovery_challenges").await,
        1
    );
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM member_timeouts WHERE username IN ('ended', 'live')"
        )
        .await,
        count(db, "SELECT COUNT(*) FROM member_timeouts").await
    );
    assert_eq!(count(db, "SELECT COUNT(*) FROM member_timeouts").await, 2);
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM audit_log WHERE action = 'member.kick'"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM config_shares WHERE id = 'livelinkaaaa'"
        )
        .await,
        count(db, "SELECT COUNT(*) FROM config_shares").await
    );
    assert_eq!(
        count(db, "SELECT COUNT(*) FROM tokens WHERE token = 'ancient'").await,
        1
    );
    assert_eq!(count(db, "SELECT COUNT(*) FROM guest_grants").await, 2);
    assert_eq!(count(db, "SELECT COUNT(*) FROM embeds").await, 1);
    assert_eq!(
        count(
            db,
            &format!("SELECT COUNT(*) FROM pings WHERE seen = 0 AND created_at = {t}")
        )
        .await,
        1
    );
    done(state, path).await;
}

#[tokio::test]
async fn interaction_touches_are_coalesced() {
    let (state, path) = temp_state("touch_coalesce").await;
    let db = &state.db;
    touch_interaction(db, "rchat", "a").await.expect("touch");
    sqlx::query("UPDATE interactions SET last_at = 5")
        .execute(db)
        .await
        .expect("age");
    touch_interaction(db, "rchat", "a")
        .await
        .expect("touch again");
    assert_eq!(count(db, "SELECT last_at FROM interactions").await, 5);
    touch_interaction(db, "rchat", "b")
        .await
        .expect("other user");
    assert_eq!(count(db, "SELECT COUNT(*) FROM interactions").await, 2);
    done(state, path).await;
}

#[tokio::test]
async fn secrets_are_hashed_in_place_and_newer_databases_are_refused() {
    let path = crate::db::temp_db_path("secret_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    for stmt in late_indexes(true) {
        let name = stmt
            .split_whitespace()
            .nth(5)
            .expect("index name")
            .to_string();
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP INDEX {name}")))
            .execute(&db)
            .await
            .expect("drop index");
    }
    for stmt in [
        "DELETE FROM settings WHERE key = 'schema_version'",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', 'h', 'text', 'identicon', 5)",
        "INSERT INTO tokens(token, username, created_at) VALUES('raw-token', 'alice', 5)",
        "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('club', 'Club', 'alice', 'hash', 1)",
        "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('raw-grant', 'club', 1, 1)",
        "INSERT INTO server_passwords(server, hash, lookup, created_by, created_at) VALUES('club', '$argon2id$v=19$old', 'lookup', 'alice', 1)",
    ] {
        sqlx::query(stmt).execute(&db).await.expect(stmt);
    }
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        let user = sqlx::query("SELECT u.username FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1")
            .bind(secret_key("raw-token"))
            .fetch_optional(&db)
            .await
            .expect("lookup");
        assert!(user.is_some(), "the old login still works");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM tokens WHERE token = 'raw-token'").await,
            0
        );
        assert_eq!(
            count(&db, &format!("SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = '{}' AND server = 'club' AND last_used_at = 1", secret_key("raw-grant"))).await,
            1
        );
        assert_eq!(
            count(&db, &format!("SELECT COUNT(*) FROM server_passwords WHERE hash = '{NO_EXTRA_HASH}' AND lookup = 'lookup'")).await,
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_server_passwords_revoked', 'idx_server_passwords_expires', 'idx_server_passwords_used_up', 'idx_users_display_lower', 'idx_reactions_agg', 'idx_pings_kept', 'idx_messages_pin_notice', 'idx_messages_system_channel')").await,
            8
        );
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    let db = open(path.to_str()).await.expect("open");
    sqlx::query("UPDATE settings SET value = $1 WHERE key = 'schema_version'")
        .bind((SCHEMA_VERSION + 1).to_string())
        .execute(&db)
        .await
        .expect("newer");
    close(&db).await;
    let refused = open(path.to_str())
        .await
        .map(|_| ())
        .expect_err("older build");
    assert!(refused.to_string().contains("schema version"), "{refused}");
    wipe();
}

#[tokio::test]
async fn file_names_stored_before_the_upload_limits_are_cleaned_once() {
    let path = crate::db::temp_db_path("file_name_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    let long = format!("{}\u{202e}gnp.exe", "a".repeat(300));
    for (name, kind) in [
        (long.as_str(), "server"),
        ("evil\u{202e}gnp.exe", "server"),
        ("fine.txt", "server"),
        (long.as_str(), "p2p"),
    ] {
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, media_kind, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', '', 'm', $1, $2, 1)")
            .bind(name)
            .bind(kind)
            .execute(&db)
            .await
            .expect("message");
    }
    sqlx::query("UPDATE settings SET value = '16' WHERE key = 'schema_version'")
        .execute(&db)
        .await
        .expect("old version");
    close(&db).await;
    for _ in 0..2 {
        let db = open(path.to_str()).await.expect("upgrade");
        let names: Vec<String> =
            sqlx::query_scalar("SELECT media_filename FROM messages ORDER BY id")
                .fetch_all(&db)
                .await
                .expect("names");
        assert_eq!(names[0].len(), 255);
        assert_eq!(names[0], format!("{}.exe", "a".repeat(251)));
        assert_eq!(names[1], "evilgnp.exe");
        assert_eq!(names[2], "fine.txt");
        assert_eq!(names[3], long, "P2P names stay as sent");
        assert_eq!(
            count(
                &db,
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
            )
            .await,
            SCHEMA_VERSION
        );
        close(&db).await;
    }
    wipe();
}

async fn old_report_perms(db: &Db) {
    for stmt in [
        "UPDATE settings SET value = '17' WHERE key = 'schema_version'",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'all', 1, 511, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'zero', 1, 0, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'kick', 1, 4, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'chan', 1, 1, 1)",
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'plain', 0, 511, 1)",
        "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'mod', '#ffffff', 4)",
        "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'chanrole', '#ffffff', 1)",
        "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'full', '#ffffff', 511)",
        "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'all', 'old', 7)",
    ] {
        sqlx::query(stmt).execute(db).await.expect(stmt);
    }
}

async fn upgraded_report_perms(db: &Db, mod_perms: i64) {
    assert_eq!(
        count(db, "SELECT COUNT(*) FROM messages WHERE author = 'all' AND content = 'old' AND created_at = 7").await,
        1
    );
    for (name, perms) in [
        ("all", 1023),
        ("zero", 0),
        ("kick", 516),
        ("chan", 1),
        ("plain", 511),
    ] {
        assert_eq!(
            count(
                db,
                &format!("SELECT perms FROM members WHERE username = '{name}'")
            )
            .await,
            perms,
            "{name}"
        );
    }
    for (name, perms) in [("mod", mod_perms), ("chanrole", 1), ("full", 1023)] {
        assert_eq!(
            count(
                db,
                &format!("SELECT perms FROM roles WHERE name = '{name}'")
            )
            .await,
            perms,
            "{name}"
        );
    }
    assert_eq!(
        count(
            db,
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
        )
        .await,
        SCHEMA_VERSION
    );
}

async fn report_perms_upgrade(url: &str) {
    let db = open(Some(url)).await.expect("open");
    old_report_perms(&db).await;
    close(&db).await;
    for _ in 0..2 {
        let db = open(Some(url)).await.expect("upgrade");
        upgraded_report_perms(&db, 516).await;
        close(&db).await;
    }
    let db = open(Some(url)).await.expect("open");
    sqlx::query("UPDATE roles SET perms = 4 WHERE name = 'mod'")
        .execute(&db)
        .await
        .expect("taken away by hand");
    close(&db).await;
    let db = open(Some(url)).await.expect("restart");
    upgraded_report_perms(&db, 4).await;
    close(&db).await;
}

#[tokio::test]
async fn manage_reports_is_granted_on_upgrade() {
    let path = crate::db::temp_db_path("reports_perm_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    report_perms_upgrade(path.to_str().expect("path")).await;
    wipe();
    if let Some(pg) = crate::api::test_util::pg_temp("reports_perm").await {
        report_perms_upgrade(&pg.url).await;
        drop(pg);
    }
}

async fn old_recovery_db(db: &Db) {
    for stmt in [
        "DROP INDEX idx_recovery_challenges_expires",
        "DROP TABLE recovery_challenges",
        "ALTER TABLE users DROP COLUMN recovery_pub",
        "ALTER TABLE users DROP COLUMN recovery_set_at",
        "UPDATE settings SET value = '18' WHERE key = 'schema_version'",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', 'old-hash', 'text', 'identicon', 7)",
    ] {
        sqlx::query(stmt).execute(db).await.expect(stmt);
    }
}

async fn upgraded_recovery_db(db: &Db, key: Option<&str>) {
    let row = sqlx::query("SELECT password_hash, created_at, recovery_pub, recovery_set_at FROM users WHERE username = 'alice'")
        .fetch_one(db)
        .await
        .expect("alice");
    let kept: (String, i64, Option<String>, Option<i64>) = (
        row.try_get(0).expect("password_hash"),
        row.try_get(1).expect("created_at"),
        row.try_get(2).expect("recovery_pub"),
        row.try_get(3).expect("recovery_set_at"),
    );
    assert_eq!(
        kept,
        (
            "old-hash".to_string(),
            7,
            key.map(str::to_string),
            key.map(|_| 9)
        )
    );
    let user = get_user(db, "alice").await.expect("load").expect("alice");
    assert_eq!(
        (user.recovery_pub.as_deref(), user.recovery_set_at),
        (key, key.map(|_| 9))
    );
    let index = match is_sqlite(db) {
        true => {
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_recovery_challenges_expires'"
        }
        false => {
            "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_recovery_challenges_expires'"
        }
    };
    assert_eq!(count(db, index).await, 1);
    sqlx::query(
        "INSERT INTO recovery_challenges(nonce, username, expires_at) VALUES('n1', 'alice', 9)",
    )
    .execute(db)
    .await
    .expect("new table");
    sqlx::query("DELETE FROM recovery_challenges")
        .execute(db)
        .await
        .expect("clear");
    assert_eq!(
        count(
            db,
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
        )
        .await,
        SCHEMA_VERSION
    );
}

async fn recovery_upgrade(url: &str) {
    let db = open(Some(url)).await.expect("open");
    old_recovery_db(&db).await;
    close(&db).await;
    for _ in 0..2 {
        let db = open(Some(url)).await.expect("upgrade");
        upgraded_recovery_db(&db, None).await;
        close(&db).await;
    }
    let db = open(Some(url)).await.expect("open");
    sqlx::query(
        "UPDATE users SET recovery_pub = 'key', recovery_set_at = 9 WHERE username = 'alice'",
    )
    .execute(&db)
    .await
    .expect("set a key");
    close(&db).await;
    let db = open(Some(url)).await.expect("restart");
    upgraded_recovery_db(&db, Some("key")).await;
    close(&db).await;
}

#[tokio::test]
async fn recovery_columns_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("recovery_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    recovery_upgrade(path.to_str().expect("path")).await;
    wipe();
    if let Some(pg) = crate::api::test_util::pg_temp("recovery_upgrade").await {
        recovery_upgrade(&pg.url).await;
        drop(pg);
    }
}

async fn old_instance_audit_db(db: &Db) {
    for stmt in [
        "DROP INDEX idx_instance_audit_actor",
        "DROP INDEX idx_instance_audit_target",
        "DROP TABLE instance_audit",
        "UPDATE settings SET value = '19' WHERE key = 'schema_version'",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at, recovery_pub, recovery_set_at) VALUES('alice', 'Alice', 'old-hash', 'text', 'identicon', 7, 'key', 9)",
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('bob', 'Bob', 'bob-hash', 'words', 'identicon', 8)",
    ] {
        sqlx::query(stmt).execute(db).await.expect(stmt);
    }
}

async fn upgraded_instance_audit_db(db: &Db, rows: i64) {
    let users = sqlx::query("SELECT username, display_name, password_hash, password_kind, created_at, recovery_pub, recovery_set_at FROM users WHERE username IN ('alice', 'bob') ORDER BY username")
        .fetch_all(db)
        .await
        .expect("users");
    type Kept = (
        String,
        String,
        String,
        String,
        i64,
        Option<String>,
        Option<i64>,
    );
    let kept: Vec<Kept> = users
        .iter()
        .map(|r| {
            (
                r.try_get(0).expect("username"),
                r.try_get(1).expect("display_name"),
                r.try_get(2).expect("password_hash"),
                r.try_get(3).expect("password_kind"),
                r.try_get(4).expect("created_at"),
                r.try_get(5).expect("recovery_pub"),
                r.try_get(6).expect("recovery_set_at"),
            )
        })
        .collect();
    let s = |v: &str| v.to_string();
    assert_eq!(
        kept,
        vec![
            (
                s("alice"),
                s("Alice"),
                s("old-hash"),
                s("text"),
                7,
                Some(s("key")),
                Some(9)
            ),
            (s("bob"), s("Bob"), s("bob-hash"), s("words"), 8, None, None),
        ]
    );
    for index in ["idx_instance_audit_actor", "idx_instance_audit_target"] {
        let sql = match is_sqlite(db) {
            true => format!(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = '{index}'"
            ),
            false => format!(
                "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname = '{index}'"
            ),
        };
        assert_eq!(count(db, &sql).await, 1, "{index}");
    }
    assert_eq!(count(db, "SELECT COUNT(*) FROM instance_audit").await, rows);
    crate::api::instance_audit::record(
        db,
        "alice",
        "test.action",
        Some("bob"),
        serde_json::json!({"k": 1}),
    )
    .await
    .expect("new table");
    let row = sqlx::query(
        "SELECT actor, action, target, detail FROM instance_audit ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(db)
    .await
    .expect("row");
    let got: (Option<String>, String, Option<String>, String) = (
        row.try_get(0).expect("actor"),
        row.try_get(1).expect("action"),
        row.try_get(2).expect("target"),
        row.try_get(3).expect("detail"),
    );
    assert_eq!(
        got,
        (
            Some(s("alice")),
            s("test.action"),
            Some(s("bob")),
            s("{\"k\":1}")
        )
    );
    assert_eq!(
        count(
            db,
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
        )
        .await,
        SCHEMA_VERSION
    );
}

async fn instance_audit_upgrade(url: &str) {
    let db = open(Some(url)).await.expect("open");
    old_instance_audit_db(&db).await;
    close(&db).await;
    for run in 0..2 {
        let db = open(Some(url)).await.expect("upgrade");
        upgraded_instance_audit_db(&db, run).await;
        close(&db).await;
    }
}

#[tokio::test]
async fn instance_audit_is_added_to_an_old_database() {
    const { assert!(SCHEMA_VERSION >= 20) };
    let path = crate::db::temp_db_path("instance_audit_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    instance_audit_upgrade(path.to_str().expect("path")).await;
    wipe();
    if let Some(pg) = crate::api::test_util::pg_temp("instance_audit_upgrade").await {
        instance_audit_upgrade(&pg.url).await;
        drop(pg);
    }
}

#[tokio::test]
async fn open_with_uses_the_configured_options() {
    let path = temp_db_path("open_with");
    let opts = DbOptions {
        limits: crate::limits::Limits {
            database_read_connections: Some(3),
            ..Default::default()
        },
        pepper: Some("configured".into()),
        controls: Some(
            ControlSeeds::of(&[
                ("GUESTS_ENABLED", " Off "),
                ("P2P_ATTACHMENTS", "off"),
                ("OUTGOING_WEBHOOKS", "on"),
            ])
            .expect("controls"),
        ),
    };
    let db = open_with(path.to_str(), &opts).await.expect("open");
    assert_eq!(pepper(&db).await.expect("pepper"), b"configured");
    assert_eq!(reader(&db).options().get_max_connections(), 3);
    for (key, on) in [
        ("guests_enabled", false),
        ("p2p_attachments", false),
        ("outgoing_webhooks", true),
    ] {
        assert_eq!(setting_on(&db, key).await.expect(key), on, "{key}");
    }
    let stored: String = sqlx::query("SELECT value FROM settings WHERE key = 'password_pepper'")
        .fetch_one(&db)
        .await
        .expect("stored pepper")
        .try_get(0)
        .expect("value");
    assert_ne!(stored, "configured");
    close(&db).await;
    let db = open(path.to_str()).await.expect("reopen");
    assert_eq!(pepper(&db).await.expect("pepper"), stored.into_bytes());
    assert!(!setting_on(&db, "guests_enabled").await.expect("kept"));
    close(&db).await;
    let _ = std::fs::remove_file(&path);
}

/// An old database: no feature switch rows and no env records yet, older switches set away from
/// their defaults, and a message.
async fn old_feature_settings(db: &Db) {
    use crate::api::features::{Feature, Registration};
    let keys: Vec<String> = Feature::ALL
        .into_iter()
        .map(|f| format!("'{}'", f.key()))
        .chain([format!("'{}'", Registration::KEY)])
        .collect();
    for stmt in [
        format!("DELETE FROM settings WHERE key IN ({})", keys.join(", ")),
        "DELETE FROM settings WHERE key LIKE 'env%'".to_string(),
        "UPDATE settings SET value = '0' WHERE key = 'guests_enabled'".to_string(),
        "UPDATE settings SET value = '1' WHERE key = 'outgoing_webhooks'".to_string(),
        "UPDATE settings SET value = '0' WHERE key = 'profanity_links'".to_string(),
        "UPDATE settings SET value = '1' WHERE key = 'profanity_filter'".to_string(),
        format!(
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES({}, 'alice', 'old', 7)",
            general_id(db).await
        ),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(stmt.clone()))
            .execute(db)
            .await
            .expect(&stmt);
    }
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM settings WHERE key = 'p2p' OR key = 'registration'"
        )
        .await,
        0
    );
}

/// The switches hold the env's values, and nothing older changed.
async fn seeded_feature_settings(db: &Db, round: usize) {
    use crate::api::Settings;
    use crate::api::features::{Feature, Registration};
    let s = Settings::load(db).await;
    for f in Feature::ALL {
        let want = match f {
            Feature::P2p | Feature::Widgets | Feature::PasswordLogin => false,
            Feature::E2ee | Feature::Sfu => true,
            _ => f.default_on(),
        };
        assert_eq!(s.on(f), want, "{f:?} after start {round}");
        assert_eq!(
            count(
                db,
                &format!(
                    "SELECT COUNT(*) FROM settings WHERE key = '{}' AND value = '{}'",
                    f.key(),
                    u8::from(want)
                )
            )
            .await,
            1,
            "{f:?} is stored once"
        );
    }
    assert_eq!(s.registration, Registration::Sso, "after start {round}");
    assert_eq!(s.upload_expiry_max_days, 0, "after start {round}");
    assert!(!s.guests_enabled && s.outgoing_webhooks && !s.profanity_targets.links);
    assert!(s.profanity_filter && s.profanity_targets.messages);
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old' AND created_at = 7"
        )
        .await,
        1
    );
}

/// A release that adds switches writes their env values at its first start, records the env of
/// the older ones without touching what the admin page chose, and changes nothing at the next
/// start with the same env.
#[tokio::test]
async fn new_switches_take_the_env_on_an_old_database_and_older_ones_stay() {
    let env = env_opts(&[
        ("FEATURE_P2P", "off"),
        ("WIDGETS", "off"),
        ("AUTH_PASSWORD_LOGIN", "off"),
        ("E2EE", "on"),
        ("FEATURE_SFU", "on"),
        ("AUTH_REGISTRATION", "sso"),
        ("GUESTS_ENABLED", "on"),
        ("OUTGOING_WEBHOOKS", "off"),
        ("PROFANITY_TARGETS", "all"),
        ("UPLOAD_EXPIRY_MAX_DAYS", "30"),
    ]);
    let path = temp_db_path("feature_seeds");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    let db = open(path.to_str()).await.expect("open");
    old_feature_settings(&db).await;
    close(&db).await;
    for round in 0..2 {
        let db = open_with(path.to_str(), &env).await.expect("upgrade");
        seeded_feature_settings(&db, round).await;
        assert_eq!(take_config_start(&db).changes, [], "start {round}");
        close(&db).await;
    }
    wipe();
    if let Some(pg) = crate::api::test_util::pg_temp("feature_seeds").await {
        let db = open(Some(pg.url.as_str())).await.expect("open postgres");
        old_feature_settings(&db).await;
        close(&db).await;
        for round in 0..2 {
            let db = open_with(Some(pg.url.as_str()), &env)
                .await
                .expect("upgrade postgres");
            seeded_feature_settings(&db, round).await;
            close(&db).await;
        }
        drop(pg);
    }
}

const OTHER_INSTANCES: &str = "client_other_instances";

/// The switch as stored (one value per row) and as `GET /api/settings` sends it.
async fn other_instances(db: &Db) -> (Vec<String>, serde_json::Value) {
    let stored = sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(OTHER_INSTANCES)
        .fetch_all(db)
        .await
        .expect("rows")
        .iter()
        .map(|r| r.try_get::<String, _>(0).expect("value"))
        .collect();
    let sent = serde_json::to_value(crate::api::Settings::load(db).await).expect("json");
    (stored, sent[OTHER_INSTANCES].clone())
}

/// A database from before the switch: no row for it, no env records, other settings changed,
/// and a message.
async fn before_other_instances(db: &Db) {
    for stmt in [
        format!("DELETE FROM settings WHERE key = '{OTHER_INSTANCES}'"),
        "DELETE FROM settings WHERE key LIKE 'env%'".to_string(),
        "UPDATE settings SET value = '0' WHERE key = 'p2p'".to_string(),
        "UPDATE settings SET value = '0' WHERE key = 'guests_enabled'".to_string(),
        "UPDATE settings SET value = 'sso' WHERE key = 'registration'".to_string(),
        format!(
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES({}, 'alice', 'old', 7)",
            general_id(db).await
        ),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(stmt.clone()))
            .execute(db)
            .await
            .expect(&stmt);
    }
}

async fn other_instances_upgrade(fresh: Option<&str>, off: Option<&str>, old: Option<&str>) {
    use crate::api::features::Registration;
    let seeded_off = env_opts(&[("FEATURE_CLIENT_OTHER_INSTANCES", "off")]);
    let unset = env_opts(&[]);
    let on = (vec!["1".to_string()], serde_json::json!(true));

    let db = open(fresh).await.expect("fresh");
    assert_eq!(other_instances(&db).await, on, "a fresh database");
    close(&db).await;

    let db = open_with(off, &seeded_off).await.expect("fresh, off");
    assert_eq!(
        other_instances(&db).await,
        (vec!["0".to_string()], serde_json::json!(false)),
        "the env seed"
    );
    close(&db).await;

    let db = open(old).await.expect("old");
    before_other_instances(&db).await;
    assert_eq!(other_instances(&db).await.0, Vec::<String>::new());
    close(&db).await;
    let off = (vec!["0".to_string()], serde_json::json!(false));
    let rounds = [
        (&unset, &on, "the default"),
        (&unset, &on, "the default again"),
        (&seeded_off, &off, "set in the env later, it applies"),
        (&seeded_off, &off, "and stays"),
    ];
    for (round, (opts, want, why)) in rounds.into_iter().enumerate() {
        let db = open_with(old, opts).await.expect("upgrade");
        assert_eq!(&other_instances(&db).await, want, "start {round}: {why}");
        let s = crate::api::Settings::load(&db).await;
        assert!(!s.p2p && !s.guests_enabled && s.password_login, "{round}");
        assert_eq!(s.registration, Registration::Sso, "after start {round}");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old' AND created_at = 7"
            )
            .await,
            1
        );
        close(&db).await;
    }
}

#[tokio::test]
async fn the_other_instances_switch_is_seeded_on_new_and_old_databases() {
    let paths = [
        "other_instances_fresh",
        "other_instances_off",
        "other_instances_old",
    ]
    .map(crate::db::temp_db_path);
    let wipe = || {
        for path in &paths {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        }
    };
    wipe();
    let [fresh, off, old] = &paths;
    other_instances_upgrade(fresh.to_str(), off.to_str(), old.to_str()).await;
    wipe();
    let pg = |tag| crate::api::test_util::pg_temp(tag);
    if let (Some(fresh), Some(off), Some(old)) = (
        pg("other_instances_fresh").await,
        pg("other_instances_off").await,
        pg("other_instances_old").await,
    ) {
        other_instances_upgrade(Some(&fresh.url), Some(&off.url), Some(&old.url)).await;
        drop((fresh, off, old));
    }
}

async fn old_upload_expiry_db(db: &Db) {
    let now = now();
    let release: &[&str] = match is_sqlite(db) {
        true => &["DROP TRIGGER messages_media_release"],
        false => &[
            "DROP TRIGGER messages_media_release ON messages",
            "DROP FUNCTION rchat_media_release()",
            "DELETE FROM settings WHERE key = 'trigger_version'",
        ],
    };
    for stmt in release.iter().map(|s| s.to_string()).chain([
        "DROP INDEX idx_media_default_expiry".to_string(),
        "DROP INDEX idx_media_timed_expiry".to_string(),
        "DROP INDEX idx_media_kept".to_string(),
        "ALTER TABLE media DROP COLUMN ttl".to_string(),
        "ALTER TABLE servers DROP COLUMN upload_expiry".to_string(),
        "UPDATE settings SET value = '20' WHERE key = 'schema_version'".to_string(),
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 7)".to_string(),
        "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 7)".to_string(),
        format!(
            "INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES('{}', 'old.txt', 'text/plain', 1, NULL, 'alice', {})",
            "a".repeat(32),
            now - 2 * 86400
        ),
        format!(
            "INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES('{}', 'new.txt', 'text/plain', 1, NULL, 'alice', {})",
            "b".repeat(32),
            now - 60
        ),
    ]) {
        sqlx::query(sqlx::AssertSqlSafe(stmt.clone()))
            .execute(db)
            .await
            .expect(&stmt);
    }
    for (id, at) in [("a", now - 2 * 86400), ("b", now - 60)] {
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, media_kind, media_expires_at, created_at) SELECT id, 'alice', '', $1, 'f.txt', 'server', $2, $3 FROM channels WHERE server = 'club'")
            .bind(id.repeat(32))
            .bind(at + 86400)
            .bind(at)
            .execute(db)
            .await
            .expect("message with a file");
    }
}

async fn upgraded_upload_expiry_db(db: &Db, choice: Option<i64>) {
    assert_eq!(count(db, STORED_SCHEMA).await, SCHEMA_VERSION);
    let stored: Option<i64> = sqlx::query("SELECT upload_expiry FROM servers WHERE name = 'club'")
        .fetch_one(db)
        .await
        .expect("club")
        .try_get(0)
        .expect("upload_expiry");
    assert_eq!(stored, choice);
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM servers WHERE upload_expiry IS NULL AND name <> 'club'"
        )
        .await,
        count(db, "SELECT COUNT(*) FROM servers WHERE name <> 'club'").await
    );
    assert_eq!(
        count(db, "SELECT COUNT(*) FROM media WHERE ttl IS NULL").await,
        count(db, "SELECT COUNT(*) FROM media").await
    );
    let (indexes, trigger) = match is_sqlite(db) {
        true => (
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_media_default_expiry', 'idx_media_timed_expiry', 'idx_media_kept')",
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_media_release'",
        ),
        false => (
            "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('idx_media_default_expiry', 'idx_media_timed_expiry', 'idx_media_kept')",
            "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'messages_media_release'",
        ),
    };
    assert_eq!(count(db, indexes).await, 3);
    assert_eq!(count(db, trigger).await, 1);
    assert_eq!(
        count(
            db,
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
        )
        .await,
        SCHEMA_VERSION
    );
}

const STORED_SCHEMA: &str =
    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'";

async fn upload_expiry_upgrade(url: &str) {
    let db = open(Some(url)).await.expect("open");
    old_upload_expiry_db(&db).await;
    assert!(
        count(&db, STORED_SCHEMA).await < SCHEMA_VERSION,
        "the old database is at 20, the instance audit log"
    );
    close(&db).await;
    for _ in 0..2 {
        let db = open(Some(url)).await.expect("upgrade");
        upgraded_upload_expiry_db(&db, None).await;
        close(&db).await;
    }
    let db = open(Some(url)).await.expect("open");
    crate::api::media::sweep(&db, None).await.expect("sweep");
    assert_eq!(
        count(
            &db,
            &format!("SELECT COUNT(*) FROM media WHERE id = '{}'", "a".repeat(32))
        )
        .await,
        0,
        "an old file past the default time goes"
    );
    assert_eq!(
        count(
            &db,
            &format!("SELECT COUNT(*) FROM media WHERE id = '{}'", "b".repeat(32))
        )
        .await,
        1,
        "a new one stays"
    );
    sqlx::query("UPDATE servers SET upload_expiry = 0 WHERE name = 'club'")
        .execute(&db)
        .await
        .expect("keep files");
    close(&db).await;
    let db = open(Some(url)).await.expect("restart");
    upgraded_upload_expiry_db(&db, Some(0)).await;
    close(&db).await;
}

#[tokio::test]
async fn upload_expiry_columns_are_added_to_an_old_database() {
    let path = crate::db::temp_db_path("upload_expiry_upgrade");
    let wipe = || {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    };
    wipe();
    upload_expiry_upgrade(path.to_str().expect("path")).await;
    wipe();
    if let Some(pg) = crate::api::test_util::pg_temp("upload_expiry_upgrade").await {
        upload_expiry_upgrade(&pg.url).await;
        drop(pg);
    }
}

/// The database options of an env given as pairs, as the server reads them at start.
fn env_opts(pairs: &[(&str, &str)]) -> DbOptions {
    crate::config::AppConfig::from_map(pairs)
        .expect("config")
        .db_options()
}

async fn stored(db: &Db, key: &str) -> Option<String> {
    sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await
        .expect("setting")
        .map(|r| r.try_get(0).expect("value"))
}

/// What the admin page does: writes `value` over the stored one.
async fn page_sets(db: &Db, key: &str, value: &str) {
    let n = sqlx::query("UPDATE settings SET value = $1 WHERE key = $2")
        .bind(value)
        .bind(key)
        .execute(db)
        .await
        .expect("page change")
        .rows_affected();
    assert_eq!(n, 1, "{key} is stored");
}

/// One start with the env `pairs`: what it did to `keys` (stored value, record), and the
/// changes it reports.
async fn start(
    url: &str,
    pairs: &[(&str, &str)],
    keys: &[&str],
) -> (Vec<(Option<String>, Option<String>)>, Vec<ConfigChange>) {
    let db = open_with(Some(url), &env_opts(pairs)).await.expect("start");
    let mut seen = Vec::new();
    for key in keys {
        seen.push((
            stored(&db, key).await,
            stored(&db, &format!("env:{key}")).await,
        ));
    }
    let changes = take_config_start(&db).changes;
    assert_eq!(stored(&db, "env:records").await.as_deref(), Some("1"));
    close(&db).await;
    (seen, changes)
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
    if let Some(pg) = crate::api::test_util::pg_temp(tag).await {
        body(pg.url.clone()).await;
        drop(pg);
    }
}

/// The instance audit log as (actor, action, target, detail), oldest first.
async fn config_audit(db: &Db) -> Vec<(Option<String>, String, Option<String>, serde_json::Value)> {
    sqlx::query("SELECT actor, action, target, detail FROM instance_audit ORDER BY id")
        .fetch_all(db)
        .await
        .expect("audit")
        .iter()
        .map(|r| {
            let detail: String = r.try_get(3).expect("detail");
            (
                r.try_get(0).expect("actor"),
                r.try_get(1).expect("action"),
                r.try_get(2).expect("target"),
                serde_json::from_str(&detail).expect("json"),
            )
        })
        .collect()
}

fn pair(value: &str, record: Option<&str>) -> (Option<String>, Option<String>) {
    (Some(value.to_string()), record.map(str::to_string))
}

fn change(key: &'static str, from: &str, to: &str) -> ConfigChange {
    ConfigChange {
        key,
        from: from.to_string(),
        to: to.to_string(),
        flips: false,
    }
}

#[tokio::test]
async fn a_set_env_value_is_written_and_recorded_at_the_first_start() {
    on_each_database("env_first", |url| async move {
        let env = [("FEATURE_P2P", "off"), ("AUTH_REGISTRATION", "closed")];
        let keys = ["p2p", "registration", "sfu", "asset_uploads"];
        for round in 0..2 {
            let (seen, changes) = start(&url, &env, &keys).await;
            assert_eq!(
                seen,
                [
                    pair("0", Some("0")),
                    pair("closed", Some("closed")),
                    pair("0", None),
                    pair("1", None),
                ],
                "start {round}"
            );
            assert_eq!(changes, [], "start {round}: a first value is not a change");
        }
    })
    .await;
}

#[tokio::test]
async fn unset_controls_hold_their_defaults_without_records() {
    use crate::api::controls::Control;
    on_each_database("env_unset", |url| async move {
        for round in 0..2 {
            let db = open_with(Some(&url), &env_opts(&[])).await.expect("start");
            for c in Control::all() {
                let rows: std::collections::HashMap<String, String> = {
                    let mut rows = std::collections::HashMap::new();
                    for key in c.keys() {
                        if let Some(value) = stored(&db, key).await {
                            rows.insert(key.to_string(), value);
                        }
                    }
                    rows
                };
                assert_eq!(rows.len(), c.keys().len(), "{}: every row", c.key);
                assert_eq!(
                    c.read(&rows).as_deref(),
                    Some(c.default),
                    "{} after start {round}",
                    c.key
                );
            }
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM settings WHERE key LIKE 'env:%' AND key <> 'env:records'"
                )
                .await,
                0
            );
            assert_eq!(take_config_start(&db).changes, []);
            close(&db).await;
        }
    })
    .await;
}

#[tokio::test]
async fn an_unchanged_env_value_leaves_a_page_change_standing() {
    on_each_database("env_unchanged", |url| async move {
        let env = [("FEATURE_P2P", "off"), ("AUTH_REGISTRATION", "open")];
        let keys = ["p2p", "registration"];
        start(&url, &env, &keys).await;
        let db = open_with(Some(&url), &env_opts(&env)).await.expect("run");
        page_sets(&db, "p2p", "1").await;
        page_sets(&db, "registration", "sso").await;
        close(&db).await;
        for round in 0..2 {
            let (seen, changes) = start(&url, &env, &keys).await;
            assert_eq!(
                seen,
                [pair("1", Some("0")), pair("sso", Some("open"))],
                "start {round}"
            );
            assert_eq!(changes, [], "start {round}");
        }
    })
    .await;
}

#[tokio::test]
async fn a_changed_env_value_is_applied_once() {
    on_each_database("env_changed", |url| async move {
        let keys = ["registration", "p2p", "sfu"];
        let first = [("AUTH_REGISTRATION", "open"), ("FEATURE_P2P", "on")];
        start(&url, &first, &keys).await;
        let db = open_with(Some(&url), &env_opts(&first)).await.expect("run");
        page_sets(&db, "registration", "sso").await;
        page_sets(&db, "p2p", "0").await;
        page_sets(&db, "sfu", "1").await;
        sqlx::query("UPDATE settings SET value = '0' WHERE key = 'env_at:registration'")
            .execute(&db)
            .await
            .expect("an old record");
        close(&db).await;

        let second = [
            ("AUTH_REGISTRATION", "closed"),
            ("FEATURE_P2P", "on"),
            ("FEATURE_SFU", "off"),
        ];
        let (seen, changes) = start(&url, &second, &keys).await;
        assert_eq!(
            seen,
            [
                pair("closed", Some("closed")),
                pair("0", Some("1")),
                pair("0", Some("0")),
            ],
            "the changed value and the newly set one are written, the unchanged one is not"
        );
        assert_eq!(
            changes,
            [
                change("sfu", "1", "0"),
                change("registration", "sso", "closed")
            ]
        );

        let db = open_with(Some(&url), &env_opts(&second))
            .await
            .expect("run");
        let row = |key: &str, from: &str, to: &str| {
            (
                None,
                "settings.config".to_string(),
                Some(key.to_string()),
                serde_json::json!({"key": key, "from": from, "to": to, "by": "config"}),
            )
        };
        assert_eq!(
            config_audit(&db).await,
            [
                row("sfu", "on", "off"),
                row("registration", "sso", "closed")
            ],
            "the audit log notes what the config changed, with no actor"
        );
        page_sets(&db, "registration", "open").await;
        close(&db).await;
        for round in 0..2 {
            let (seen, changes) = start(&url, &second, &keys).await;
            assert_eq!(seen[0], pair("open", Some("closed")), "start {round}");
            assert_eq!(changes, [], "start {round}: config is applied once");
        }
    })
    .await;
}

#[tokio::test]
async fn a_start_soon_after_another_value_is_flagged() {
    on_each_database("env_flips", |url| async move {
        let keys = ["registration"];
        start(&url, &[("AUTH_REGISTRATION", "open")], &keys).await;
        let (seen, changes) = start(&url, &[("AUTH_REGISTRATION", "closed")], &keys).await;
        assert_eq!(seen, [pair("closed", Some("closed"))]);
        assert_eq!(
            changes,
            [ConfigChange {
                flips: true,
                ..change("registration", "open", "closed")
            }],
            "another copy recorded open in the last 10 minutes"
        );
        let closed = env_opts(&[("AUTH_REGISTRATION", "closed")]);
        let db = open_with(Some(&url), &closed).await.expect("run");
        let recent = now() - 540;
        page_sets(&db, "env_at:registration", &recent.to_string()).await;
        close(&db).await;
        let sso = [("AUTH_REGISTRATION", "sso")];
        let (_, changes) = start(&url, &sso, &keys).await;
        assert!(changes[0].flips, "9 minutes ago is recent");
        let db = open_with(Some(&url), &env_opts(&sso)).await.expect("run");
        let old = now() - 660;
        page_sets(&db, "env_at:registration", &old.to_string()).await;
        close(&db).await;
        let (_, changes) = start(&url, &[("AUTH_REGISTRATION", "open")], &keys).await;
        assert_eq!(changes, [change("registration", "sso", "open")]);
    })
    .await;
}

#[tokio::test]
async fn the_first_start_with_records_only_records() {
    on_each_database("env_upgrade", |url| async move {
        let env = [
            ("FEATURE_P2P", "on"),
            ("AUTH_REGISTRATION", "open"),
            ("GUESTS_ENABLED", "true"),
            ("PROFANITY_TARGETS", "all"),
        ];
        let keys = [
            "p2p",
            "registration",
            "guests_enabled",
            "profanity_links",
            "sfu",
        ];
        let db = open_with(Some(&url), &env_opts(&env)).await.expect("old");
        for (key, value) in [
            ("p2p", "0"),
            ("registration", "sso"),
            ("guests_enabled", "0"),
            ("profanity_links", "0"),
            ("sfu", "1"),
        ] {
            page_sets(&db, key, value).await;
        }
        sqlx::query("DELETE FROM settings WHERE key LIKE 'env%'")
            .execute(&db)
            .await
            .expect("an old release has no records");
        sqlx::query(
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', 'old', 7)",
        )
        .bind(general_id(&db).await)
        .execute(&db)
        .await
        .expect("old message");
        close(&db).await;

        for round in 0..2 {
            let (seen, changes) = start(&url, &env, &keys).await;
            assert_eq!(
                seen,
                [
                    pair("0", Some("1")),
                    pair("sso", Some("open")),
                    pair("0", Some("1")),
                    pair("0", None),
                    pair("1", None),
                ],
                "start {round}: the page's values stay and the env is recorded"
            );
            assert_eq!(changes, [], "start {round}");
        }
        let db = open_with(Some(&url), &env_opts(&env)).await.expect("run");
        assert_eq!(
            stored(&db, "env:profanity_targets").await.as_deref(),
            Some("all")
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old' AND created_at = 7"
            )
            .await,
            1
        );
        page_sets(&db, "env_at:registration", "0").await;
        assert_eq!(config_audit(&db).await, [], "recording changes nothing");
        close(&db).await;

        let mut changed = env;
        changed[1] = ("AUTH_REGISTRATION", "closed");
        let (seen, changes) = start(&url, &changed, &keys).await;
        assert_eq!(
            seen,
            [
                pair("0", Some("1")),
                pair("closed", Some("closed")),
                pair("0", Some("1")),
                pair("0", None),
                pair("1", None),
            ],
            "only the changed variable applies"
        );
        assert_eq!(changes, [change("registration", "sso", "closed")]);
    })
    .await;
}

#[tokio::test]
async fn an_unset_env_value_drops_its_record() {
    on_each_database("env_dropped", |url| async move {
        let keys = ["p2p"];
        let off = [("FEATURE_P2P", "off")];
        start(&url, &off, &keys).await;
        for round in 0..2 {
            let (seen, changes) = start(&url, &[], &keys).await;
            assert_eq!(seen, [pair("0", None)], "start {round}: the value stays");
            assert_eq!(changes, []);
        }
        let db = open(Some(&url)).await.expect("run");
        assert_eq!(stored(&db, "env_at:p2p").await, None);
        page_sets(&db, "p2p", "1").await;
        close(&db).await;
        let (seen, changes) = start(&url, &off, &keys).await;
        assert_eq!(
            seen,
            [pair("0", Some("0"))],
            "set again, it applies though it is the old value"
        );
        assert_eq!(changes, [change("p2p", "1", "0")]);
    })
    .await;
}

#[tokio::test]
async fn pinned_controls_follow_the_env_at_every_start() {
    on_each_database("env_pinned", |url| async move {
        let keys = ["p2p", "registration"];
        let pinned = [
            ("FEATURE_P2P", "off"),
            ("AUTH_REGISTRATION", "open"),
            ("SETTINGS_PINNED", "FEATURE_P2P"),
        ];
        let (seen, changes) = start(&url, &pinned, &keys).await;
        assert_eq!(seen, [pair("0", Some("0")), pair("open", Some("open"))]);
        assert_eq!(changes, []);
        for round in 0..2 {
            let db = open_with(Some(&url), &env_opts(&pinned))
                .await
                .expect("run");
            assert_eq!(stored(&db, "env:pinned").await.as_deref(), Some("p2p"));
            page_sets(&db, "p2p", "1").await;
            page_sets(&db, "registration", "sso").await;
            close(&db).await;
            let (seen, changes) = start(&url, &pinned, &keys).await;
            assert_eq!(
                seen,
                [pair("0", Some("0")), pair("sso", Some("open"))],
                "start {round}: the pinned one goes back, the other stays"
            );
            assert_eq!(changes, [change("p2p", "1", "0")], "start {round}");
        }
        let all = [
            ("FEATURE_P2P", "off"),
            ("AUTH_REGISTRATION", "open"),
            ("SETTINGS_PINNED", "all"),
        ];
        let (seen, _) = start(&url, &all, &keys).await;
        assert_eq!(seen, [pair("0", Some("0")), pair("open", Some("open"))]);
        let db = open_with(Some(&url), &env_opts(&all)).await.expect("run");
        assert_eq!(
            stored(&db, "env:pinned").await.as_deref(),
            Some("p2p,registration")
        );
        page_sets(&db, "p2p", "1").await;
        close(&db).await;
        let unpinned = [("FEATURE_P2P", "off"), ("AUTH_REGISTRATION", "open")];
        let (seen, changes) = start(&url, &unpinned, &keys).await;
        assert_eq!(seen[0], pair("1", Some("0")), "no pin, so the page wins");
        assert_eq!(changes, []);
        let db = open_with(Some(&url), &env_opts(&unpinned))
            .await
            .expect("run");
        assert_eq!(stored(&db, "env:pinned").await, None);
        close(&db).await;
    })
    .await;
}

#[tokio::test]
async fn profanity_targets_follow_the_same_rules_row_by_row() {
    on_each_database("env_targets", |url| async move {
        let keys = [
            "profanity_messages",
            "profanity_links",
            "profanity_bios",
            "profanity_targets",
        ];
        let some = [("PROFANITY_TARGETS", "messages,links")];
        let (seen, _) = start(&url, &some, &keys).await;
        assert_eq!(
            seen,
            [
                pair("1", None),
                pair("1", None),
                pair("0", None),
                (None, Some("messages,links".to_string())),
            ]
        );
        let db = open_with(Some(&url), &env_opts(&some)).await.expect("run");
        page_sets(&db, "profanity_bios", "1").await;
        sqlx::query("DELETE FROM settings WHERE key = 'profanity_usernames'")
            .execute(&db)
            .await
            .expect("a target from a later release");
        close(&db).await;
        let (seen, changes) = start(&url, &some, &keys).await;
        assert_eq!(seen[2], pair("1", None), "the page's change stays");
        assert_eq!(changes, []);
        let db = open_with(Some(&url), &env_opts(&some)).await.expect("run");
        assert_eq!(
            stored(&db, "profanity_usernames").await.as_deref(),
            Some("0"),
            "a missing row takes the env value"
        );
        page_sets(&db, "env_at:profanity_targets", "0").await;
        close(&db).await;
        let (seen, changes) = start(&url, &[("PROFANITY_TARGETS", "none")], &keys).await;
        assert_eq!(
            seen,
            [
                pair("0", None),
                pair("0", None),
                pair("0", None),
                (None, Some("none".to_string())),
            ]
        );
        assert_eq!(
            changes,
            [change("profanity_targets", "messages,links,bios", "none")]
        );
    })
    .await;
}

/// Every row the controls and the server config's records keep, in key order.
async fn control_table(db: &Db) -> Vec<(String, String)> {
    use crate::api::controls::Control;
    let keys: Vec<&str> = Control::all().iter().flat_map(|c| c.keys()).collect();
    sqlx::query("SELECT key, value FROM settings ORDER BY key")
        .fetch_all(db)
        .await
        .expect("settings")
        .iter()
        .map(|r| {
            (
                r.try_get::<String, _>(0).expect("key"),
                r.try_get::<String, _>(1).expect("value"),
            )
        })
        .filter(|(key, _)| key.starts_with("env") || keys.contains(&key.as_str()))
        .collect()
}

#[tokio::test]
async fn a_tool_open_leaves_the_controls_and_their_records_alone() {
    use crate::api::features::Registration;
    on_each_database("env_tool", |url| async move {
        let db = super::open(Some(&url))
            .await
            .expect("a tool, before any start");
        assert_eq!(
            control_table(&db).await,
            [],
            "it writes no control and no record"
        );
        let read = crate::api::Settings::load(&db).await;
        assert!(read.p2p && read.registration == Registration::Open);
        assert_eq!(take_config_start(&db), ConfigStart::default());
        close(&db).await;

        let env = [
            ("FEATURE_P2P", "off"),
            ("AUTH_REGISTRATION", "closed"),
            ("SETTINGS_PINNED", "FEATURE_P2P"),
        ];
        let keys = ["p2p", "registration"];
        let (seen, changes) = start(&url, &env, &keys).await;
        assert_eq!(
            seen,
            [pair("0", Some("0")), pair("closed", Some("closed"))],
            "the first server start after it still takes its env"
        );
        assert_eq!(changes, []);
        let db = open_with(Some(&url), &env_opts(&env)).await.expect("run");
        page_sets(&db, "registration", "sso").await;
        let before = control_table(&db).await;
        assert!(before.contains(&("env:pinned".to_string(), "p2p".to_string())));
        close(&db).await;

        for round in 0..2 {
            let db = super::open(Some(&url)).await.expect("a tool");
            assert_eq!(control_table(&db).await, before, "tool open {round}");
            assert_eq!(take_config_start(&db), ConfigStart::default());
            close(&db).await;
        }
        let (seen, changes) = start(&url, &env, &keys).await;
        assert_eq!(
            seen,
            [pair("0", Some("0")), pair("sso", Some("closed"))],
            "the next server start finds its records, so the page's choice stands"
        );
        assert_eq!(changes, []);
    })
    .await;
}

#[tokio::test]
async fn a_start_that_leaves_a_recently_set_value_unset_is_reported() {
    on_each_database("env_forgotten", |url| async move {
        let both = [("FEATURE_P2P", "off"), ("AUTH_REGISTRATION", "closed")];
        let one = [("AUTH_REGISTRATION", "closed")];
        start(&url, &both, &[]).await;
        for (round, forgotten) in [vec!["p2p"], vec![]].into_iter().enumerate() {
            let db = open_with(Some(&url), &env_opts(&one)).await.expect("start");
            let started = take_config_start(&db);
            assert_eq!(
                started.forgotten, forgotten,
                "start {round} without FEATURE_P2P"
            );
            assert_eq!(started.changes, []);
            close(&db).await;
        }
        start(&url, &both, &[]).await;
        let db = open_with(Some(&url), &env_opts(&both)).await.expect("run");
        let old = now() - 660;
        page_sets(&db, "env_at:p2p", &old.to_string()).await;
        close(&db).await;
        let db = open_with(Some(&url), &env_opts(&one)).await.expect("start");
        assert_eq!(
            take_config_start(&db),
            ConfigStart::default(),
            "a value another start set 11 minutes ago is not reported"
        );
        assert_eq!(stored(&db, "env:p2p").await, None);
        close(&db).await;
    })
    .await;
}

/// A database from before the controls `keys` existed: no rows for them and no env records, an
/// older switch changed in the admin page, and a message.
async fn before_controls(url: &str, keys: &[&str]) {
    let db = open(Some(url)).await.expect("old");
    for key in keys {
        sqlx::query("DELETE FROM settings WHERE key = $1")
            .bind(*key)
            .execute(&db)
            .await
            .expect("no row yet");
    }
    sqlx::query("DELETE FROM settings WHERE key LIKE 'env%'")
        .execute(&db)
        .await
        .expect("no records yet");
    page_sets(&db, "p2p", "0").await;
    sqlx::query(
        "INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, 'alice', 'old', 7 WHERE NOT EXISTS(SELECT 1 FROM messages WHERE author = 'alice' AND content = 'old')",
    )
    .bind(general_id(&db).await)
    .execute(&db)
    .await
    .expect("old message");
    close(&db).await;
}

/// What an upgrade must leave alone: the page's older choice and the message.
async fn kept_through_the_upgrade(url: &str, env: &[(&str, &str)]) {
    let db = open_with(Some(url), &env_opts(env)).await.expect("run");
    assert!(!crate::api::Settings::load(&db).await.p2p);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old' AND created_at = 7"
        )
        .await,
        1
    );
    close(&db).await;
}

/// New controls on an old database: with the env silent they get their defaults; set in the env
/// at the release's first start they take the env value; set later, the env value applies as a
/// change. `set` is (env name, env value, stored value) per key.
async fn controls_reach_an_old_database(
    tag: &str,
    keys: &'static [&'static str],
    defaults: &'static [&'static str],
    set: &'static [(&'static str, &'static str, &'static str)],
) {
    on_each_database(tag, |url| async move {
        let env: Vec<(&str, &str)> = set.iter().map(|(name, value, _)| (*name, *value)).collect();
        let from_env: Vec<_> = set
            .iter()
            .map(|(_, _, stored)| pair(stored, Some(stored)))
            .collect();
        before_controls(&url, keys).await;
        for round in 0..2 {
            let (seen, changes) = start(&url, &env, keys).await;
            assert_eq!(seen, from_env, "start {round}: the env value");
            assert_eq!(changes, [], "start {round}");
        }
        kept_through_the_upgrade(&url, &env).await;

        before_controls(&url, keys).await;
        let silent: Vec<_> = defaults.iter().map(|d| pair(d, None)).collect();
        for round in 0..2 {
            let (seen, changes) = start(&url, &[], keys).await;
            assert_eq!(seen, silent, "start {round}: the defaults");
            assert_eq!(changes, [], "start {round}");
        }
        let (seen, changes) = start(&url, &env, keys).await;
        assert_eq!(seen, from_env, "set later, the env applies");
        let want: Vec<ConfigChange> = keys
            .iter()
            .zip(defaults)
            .zip(set)
            .filter(|((_, default), (_, _, stored))| **default != *stored)
            .map(|((key, default), (_, _, stored))| change(key, default, stored))
            .collect();
        assert_eq!(changes, want);
        kept_through_the_upgrade(&url, &env).await;
    })
    .await;
}

#[tokio::test]
async fn the_upload_expiry_cap_reaches_an_old_database() {
    controls_reach_an_old_database(
        "cap_control",
        &["upload_expiry_max_days"],
        &["0"],
        &[("UPLOAD_EXPIRY_MAX_DAYS", " 30 ", "30")],
    )
    .await;
}

#[tokio::test]
async fn server_creation_controls_are_added_to_an_old_database() {
    controls_reach_an_old_database(
        "creation_controls",
        &["server_creation", "server_creators"],
        &["everyone", ""],
        &[
            ("SERVER_CREATION", "some", "some"),
            ("SERVER_CREATORS", " bob, lobby:Staff ", "bob,lobby:Staff"),
        ],
    )
    .await;
}

#[tokio::test]
async fn server_joining_controls_are_added_to_an_old_database() {
    controls_reach_an_old_database(
        "joining_controls",
        &["server_joining", "server_search"],
        &["everyone", "1"],
        &[
            ("SERVER_JOINING", "invites", "invites"),
            ("SERVER_SEARCH", "off", "0"),
        ],
    )
    .await;
}

#[tokio::test]
async fn dm_and_friend_controls_are_added_to_an_old_database() {
    controls_reach_an_old_database(
        "dm_controls",
        &["dm_creation", "friend_requests"],
        &["everyone", "1"],
        &[
            ("DM_CREATION", "friends", "friends"),
            ("FEATURE_FRIEND_REQUESTS", "off", "0"),
        ],
    )
    .await;
}
