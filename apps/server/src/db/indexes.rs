use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use sqlx::{AnyConnection, Connection, Row};

use super::pool::{Db, is_sqlite, pool_key};
use crate::limits::Limits;

/// An index that Postgres builds without stopping writes to its table. SQLite, and Postgres
/// on a table under `ONLINE_ROWS` rows, build it inside the schema init. On a bigger Postgres
/// table `build_online` builds it after the start with `CREATE INDEX CONCURRENTLY`.
pub(super) struct OnlineIndex {
    pub name: &'static str,
    pub table: &'static str,
    /// What follows `CREATE INDEX [CONCURRENTLY] IF NOT EXISTS <name>`.
    pub body: &'static str,
    /// Indexes dropped once this one is valid.
    pub replaces: &'static [&'static str],
    /// The Postgres extension the index needs. SQLite skips an index that needs one.
    pub extension: Option<&'static str>,
}

/// Every index added to a table that can be big (`messages`, `reactions`, `members`,
/// `read_state`, `audit_log`, `pings`, `group_pings`, `here_pings`, `message_embeds`,
/// `poll_votes`, `media`), every index that replaces or drops another, and the trigram indexes.
pub(super) const ONLINE_INDEXES: &[OnlineIndex] = &[
    OnlineIndex {
        name: "idx_messages_content_trgm",
        table: "messages",
        body: "ON messages USING gin (lower(content) gin_trgm_ops)",
        replaces: &[],
        extension: Some("pg_trgm"),
    },
    OnlineIndex {
        name: "idx_users_username_trgm",
        table: "users",
        body: "ON users USING gin (lower(username) gin_trgm_ops)",
        replaces: &[],
        extension: Some("pg_trgm"),
    },
    OnlineIndex {
        name: "idx_users_display_name_trgm",
        table: "users",
        body: "ON users USING gin (lower(display_name) gin_trgm_ops)",
        replaces: &[],
        extension: Some("pg_trgm"),
    },
    OnlineIndex {
        name: "idx_servers_name_trgm",
        table: "servers",
        body: "ON servers USING gin (lower(name) gin_trgm_ops)",
        replaces: &[],
        extension: Some("pg_trgm"),
    },
    OnlineIndex {
        name: "idx_servers_display_name_trgm",
        table: "servers",
        body: "ON servers USING gin (lower(display_name) gin_trgm_ops)",
        replaces: &[],
        extension: Some("pg_trgm"),
    },
    OnlineIndex {
        name: "idx_media_kept_by",
        table: "media",
        body: "ON media(kept_by, size) WHERE kept_by IS NOT NULL",
        replaces: &[],
        extension: None,
    },
    OnlineIndex {
        name: "idx_media_uploader",
        table: "media",
        body: "ON media(uploader, uploaded_at)",
        replaces: &[],
        extension: None,
    },
    OnlineIndex {
        name: "idx_media_charged_to",
        table: "media",
        body: "ON media(charged_to, uploaded_at) WHERE charged_to IS NOT NULL",
        replaces: &[],
        extension: None,
    },
    OnlineIndex {
        name: "idx_media_charged_server",
        table: "media",
        body: "ON media(charged_server, uploaded_at) WHERE charged_server IS NOT NULL",
        replaces: &[],
        extension: None,
    },
    OnlineIndex {
        name: "idx_members_user_joined",
        table: "members",
        body: "ON members(username, joined_at, server)",
        replaces: &["idx_members_username"],
        extension: None,
    },
    OnlineIndex {
        name: "idx_dms_b_latest",
        table: "dms",
        body: "ON dms(user_b, last_message_id, id)",
        replaces: &["idx_dms_user_b"],
        extension: None,
    },
    OnlineIndex {
        name: "idx_reactions_agg",
        table: "reactions",
        body: "ON reactions(message_id, emoji, created_at, username)",
        replaces: &["idx_reactions_message"],
        extension: None,
    },
    OnlineIndex {
        name: "idx_group_pings_server_time",
        table: "group_pings",
        body: "ON group_pings(server, created_at, message_id)",
        replaces: &["idx_group_pings_server"],
        extension: None,
    },
    OnlineIndex {
        name: "idx_pings_server",
        table: "pings",
        body: "ON pings(server)",
        replaces: &[],
        extension: None,
    },
    OnlineIndex {
        name: "idx_messages_dm",
        table: "messages",
        body: "ON messages(dm_id, id) WHERE dm_id IS NOT NULL",
        replaces: &["idx_messages_dm_id"],
        extension: None,
    },
    OnlineIndex {
        name: "idx_messages_thread",
        table: "messages",
        body: "ON messages(thread_root_id, id) WHERE thread_root_id IS NOT NULL",
        replaces: &["idx_messages_thread_root"],
        extension: None,
    },
];

/// Rows from which a Postgres table gets its online indexes after the start.
pub(super) const ONLINE_ROWS: i64 = 100_000;

const INDEX_LOCK: i64 = 0x7263_6861_7401;

/// What one `build_online` did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Built {
    /// Another copy holds the build lock, so this one did nothing.
    pub busy: bool,
    pub built: Vec<&'static str>,
    pub dropped: Vec<&'static str>,
    /// Indexes whose extension is missing.
    pub skipped: Vec<&'static str>,
    /// Indexes whose build or drops failed. The next start tries again.
    pub failed: Vec<&'static str>,
}

async fn sql(conn: &mut AnyConnection, stmt: String) -> sqlx::Result<()> {
    sqlx::query(sqlx::AssertSqlSafe(stmt))
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

async fn guarded(conn: &mut AnyConnection, stmt: String) -> sqlx::Result<()> {
    let mut savepoint = Connection::begin(&mut *conn).await?;
    sql(&mut savepoint, stmt).await?;
    savepoint.commit().await
}

/// `None`: no such index. `Some(false)`: an interrupted concurrent build left it invalid.
async fn index_valid(conn: &mut AnyConnection, name: &str) -> sqlx::Result<Option<bool>> {
    sqlx::query("SELECT CAST(CASE WHEN i.indisvalid THEN 1 ELSE 0 END AS BIGINT) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = $1")
        .bind(name)
        .fetch_optional(&mut *conn)
        .await?
        .map(|row| row.try_get::<i64, _>(0).map(|valid| valid != 0))
        .transpose()
}

async fn has_extension(conn: &mut AnyConnection, name: &str) -> sqlx::Result<bool> {
    Ok(sqlx::query("SELECT 1 FROM pg_extension WHERE extname = $1")
        .bind(name)
        .fetch_optional(&mut *conn)
        .await?
        .is_some())
}

/// Whether `table` has at least `ONLINE_ROWS` rows: by the planner's estimate, else by
/// counting up to that many.
async fn is_big(conn: &mut AnyConnection, table: &str) -> sqlx::Result<bool> {
    let estimate: Option<i64> = sqlx::query("SELECT CAST(c.reltuples AS BIGINT) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = $1")
        .bind(table)
        .fetch_optional(&mut *conn)
        .await?
        .map(|row| row.try_get(0))
        .transpose()?;
    if estimate.is_some_and(|rows| rows >= ONLINE_ROWS) {
        return Ok(true);
    }
    let counted: i64 = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM (SELECT 1 FROM {table} LIMIT {ONLINE_ROWS}) rows"
    )))
    .fetch_one(&mut *conn)
    .await?
    .try_get(0)?;
    Ok(counted >= ONLINE_ROWS)
}

/// The name of the index `stmt` creates, when it is `CREATE [UNIQUE] INDEX IF NOT EXISTS <name>`.
fn created_name(stmt: &str) -> Option<&str> {
    let words: Vec<&str> = stmt.split_whitespace().take(7).collect();
    match words.as_slice() {
        ["CREATE", "INDEX", "IF", "NOT", "EXISTS", name, ..]
        | ["CREATE", "UNIQUE", "INDEX", "IF", "NOT", "EXISTS", name, ..] => Some(name),
        _ => None,
    }
}

/// Runs the schema statements `stmts`, leaving out on Postgres each `CREATE INDEX IF NOT EXISTS`
/// of an index that exists: the statement takes its table's lock first, so it would wait for a
/// concurrent build on that table, and every write to the table would wait behind it.
pub(super) async fn create_indexes(
    conn: &mut AnyConnection,
    is_sqlite: bool,
    stmts: impl IntoIterator<Item = &str>,
) -> sqlx::Result<()> {
    let existing: HashSet<String> = match is_sqlite {
        true => HashSet::new(),
        false => sqlx::query("SELECT CAST(c.relname AS TEXT) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'i'")
            .fetch_all(&mut *conn)
            .await?
            .iter()
            .map(|row| row.try_get(0))
            .collect::<Result<_, _>>()?,
    };
    for stmt in stmts {
        if created_name(stmt).is_some_and(|name| existing.contains(name)) {
            continue;
        }
        sql(conn, stmt.to_string()).await?;
    }
    Ok(())
}

/// The part of `entries` the schema init builds, in its transaction: all of them on SQLite, and
/// on Postgres those of tables under `ONLINE_ROWS` rows.
pub(super) async fn build_inline(
    conn: &mut AnyConnection,
    is_sqlite: bool,
    entries: &[OnlineIndex],
) -> anyhow::Result<()> {
    let mut big: HashMap<&str, bool> = HashMap::new();
    for OnlineIndex {
        name,
        table,
        body,
        replaces,
        extension,
    } in entries
    {
        if is_sqlite {
            if extension.is_none() {
                sql(conn, format!("CREATE INDEX IF NOT EXISTS {name} {body}")).await?;
                for old in *replaces {
                    sql(conn, format!("DROP INDEX IF EXISTS {old}")).await?;
                }
            }
            continue;
        }
        if let Some(extension) = extension
            && let Err(e) =
                guarded(conn, format!("CREATE EXTENSION IF NOT EXISTS {extension}")).await
        {
            tracing::warn!("{extension} unavailable, index {name} not created: {e}");
            continue;
        }
        let big = match big.get(table) {
            Some(big) => *big,
            None => {
                let counted = is_big(conn, table).await?;
                big.insert(table, counted);
                counted
            }
        };
        if big {
            continue;
        }
        let state = index_valid(conn, name).await?;
        if state == Some(false) {
            sql(conn, format!("DROP INDEX IF EXISTS {name}")).await?;
        }
        if state != Some(true)
            && let Err(e) = guarded(conn, format!("CREATE INDEX IF NOT EXISTS {name} {body}")).await
        {
            tracing::warn!("index {name} not created: {e}");
            continue;
        }
        for old in *replaces {
            if index_valid(conn, old).await?.is_some() {
                sql(conn, format!("DROP INDEX IF EXISTS {old}")).await?;
            }
        }
    }
    Ok(())
}

/// How long a copy that found the build lock taken waits before it tries again.
const BUILD_RETRY: Duration = Duration::from_secs(60);

/// Builds the online indexes the schema init left out, one at a time, without stopping writes.
/// Only the copy that gets the build lock works; another tries again every minute until it gets
/// the lock. Does nothing on SQLite.
pub async fn build_online(db: &Db, limits: &Limits) -> anyhow::Result<Built> {
    build_when_free(db, limits, ONLINE_INDEXES, BUILD_RETRY).await
}

pub(super) async fn build_when_free(
    db: &Db,
    limits: &Limits,
    entries: &[OnlineIndex],
    every: Duration,
) -> anyhow::Result<Built> {
    loop {
        let done = build(db, limits, entries).await?;
        if !done.busy {
            return Ok(done);
        }
        tokio::time::sleep(every).await;
    }
}

pub(super) async fn build(
    db: &Db,
    limits: &Limits,
    entries: &[OnlineIndex],
) -> anyhow::Result<Built> {
    if is_sqlite(db) {
        return Ok(Built::default());
    }
    let mut conn = AnyConnection::connect(&pool_key(db)).await?;
    let locked: i64 =
        sqlx::query("SELECT CAST(CASE WHEN pg_try_advisory_lock($1) THEN 1 ELSE 0 END AS BIGINT)")
            .bind(INDEX_LOCK)
            .fetch_one(&mut conn)
            .await?
            .try_get(0)?;
    if locked == 0 {
        conn.close().await?;
        return Ok(Built {
            busy: true,
            ..Built::default()
        });
    }
    sql(&mut conn, "SET statement_timeout = 0".to_string()).await?;
    sql(
        &mut conn,
        format!(
            "SET maintenance_work_mem = '{}MB'",
            limits.database_index_build_mib
        ),
    )
    .await?;
    let mut done = Built::default();
    for entry in entries {
        if let Err(e) = build_one(&mut conn, entry, &mut done).await {
            tracing::warn!("online index {} failed: {e}", entry.name);
            done.failed.push(entry.name);
        }
    }
    sqlx::query("SELECT COUNT(*) FROM pg_advisory_unlock($1)")
        .bind(INDEX_LOCK)
        .execute(&mut conn)
        .await?;
    conn.close().await?;
    Ok(done)
}

async fn build_one(
    conn: &mut AnyConnection,
    entry: &OnlineIndex,
    done: &mut Built,
) -> sqlx::Result<()> {
    let OnlineIndex {
        name,
        table: _,
        body,
        replaces,
        extension,
    } = entry;
    let state = index_valid(conn, name).await?;
    if state != Some(true) {
        if let Some(extension) = extension
            && !has_extension(conn, extension).await?
        {
            tracing::warn!("{extension} unavailable, index {name} not created");
            done.skipped.push(name);
            return Ok(());
        }
        if state == Some(false) {
            sql(conn, format!("DROP INDEX CONCURRENTLY IF EXISTS {name}")).await?;
        }
        let started = Instant::now();
        sql(
            conn,
            format!("CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} {body}"),
        )
        .await?;
        tracing::info!(
            "built index {name} in {:.1} s",
            started.elapsed().as_secs_f64()
        );
        done.built.push(name);
    }
    for old in *replaces {
        if index_valid(conn, old).await?.is_some() {
            sql(conn, format!("DROP INDEX CONCURRENTLY IF EXISTS {old}")).await?;
            tracing::info!("dropped index {old}, replaced by {name}");
            done.dropped.push(old);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
