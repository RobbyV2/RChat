use serde::Serialize;
use sqlx::Row;

use super::indexes::ONLINE_INDEXES;
use super::pool::{ConnectionBudget, Db, connection_budget, is_sqlite};
use super::replica::ReplicaStatus;
use crate::state::AppState;

#[derive(Serialize)]
pub(crate) struct PoolStatus {
    max: u32,
    in_use: usize,
    idle: usize,
}

fn pool(db: &Db) -> PoolStatus {
    let size = db.size() as usize;
    let idle = db.num_idle().min(size);
    PoolStatus {
        max: db.options().get_max_connections(),
        in_use: size - idle,
        idle,
    }
}

#[derive(Serialize)]
pub(crate) struct IndexStatus {
    name: String,
    state: &'static str,
    percent: Option<i64>,
    size_mib: i64,
}

async fn online_indexes(db: &Db) -> sqlx::Result<Vec<IndexStatus>> {
    let names = ONLINE_INDEXES
        .iter()
        .map(|index| format!("('{}')", index.name))
        .collect::<Vec<_>>()
        .join(",");
    let query = format!("WITH wanted(name) AS (VALUES {names})
        SELECT name, i.indisvalid, p.pid::bigint, CASE WHEN p.blocks_total > 0 THEN LEAST(100, 100*p.blocks_done/p.blocks_total)::bigint END,
        COALESCE(pg_relation_size(i.indexrelid),0)::bigint / 1048576 FROM wanted
        LEFT JOIN pg_index i ON i.indexrelid = to_regclass(quote_ident(name))
        LEFT JOIN pg_stat_progress_create_index p ON p.index_relid = i.indexrelid AND p.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
        ORDER BY name");
    sqlx::query(sqlx::AssertSqlSafe(query))
        .fetch_all(db)
        .await?
        .iter()
        .map(|row| {
            let building = row.try_get::<Option<i64>, _>(2)?.is_some();
            let valid = row.try_get::<Option<bool>, _>(1)?;
            let state = match (building, valid) {
                (true, _) => "building",
                (_, Some(true)) => "valid",
                (_, Some(false)) => "invalid",
                (_, None) => "missing",
            };
            Ok(IndexStatus {
                name: row.try_get(0)?,
                state,
                percent: row.try_get(3)?,
                size_mib: row.try_get(4)?,
            })
        })
        .collect()
}

#[derive(Serialize)]
pub(crate) struct DatabaseStatus {
    kind: &'static str,
    version: String,
    schema_version: i64,
    pool: PoolStatus,
    reader: Option<PoolStatus>,
    connections: Option<ConnectionBudget>,
    light_commits: Option<&'static str>,
    statement_timeout_secs: Option<u64>,
    replicas: Vec<ReplicaStatus>,
    online_indexes: Vec<IndexStatus>,
}

pub(crate) async fn database_status(state: &AppState) -> sqlx::Result<DatabaseStatus> {
    let db = &state.db;
    let sqlite = is_sqlite(db);
    let version_query = if sqlite {
        "SELECT sqlite_version()"
    } else {
        "SELECT current_setting('server_version')"
    };
    let version = sqlx::query(sqlx::AssertSqlSafe(version_query))
        .fetch_one(db)
        .await?
        .try_get(0)?;
    let schema_version =
        sqlx::query("SELECT CAST(value AS BIGINT) FROM settings WHERE key='schema_version'")
            .fetch_one(db)
            .await?
            .try_get(0)?;
    Ok(DatabaseStatus {
        kind: if sqlite { "sqlite" } else { "postgres" },
        version,
        schema_version,
        pool: pool(db),
        reader: super::pool::separate_reader(db).as_ref().map(pool),
        connections: connection_budget(db).await?,
        light_commits: (!sqlite).then(|| super::pool::light_mode(db)),
        statement_timeout_secs: (!sqlite).then_some(state.limits.database_statement_timeout_secs),
        replicas: state.replicas.status(),
        online_indexes: if sqlite {
            Vec::new()
        } else {
            online_indexes(db).await?
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::each_db;

    #[tokio::test]
    async fn database_kind_schema_and_pools_match_the_running_copy() {
        for (state, temp) in each_db("database_status").await {
            let status = database_status(&state).await.unwrap();
            assert_eq!(status.schema_version, super::super::SCHEMA_VERSION);
            assert_eq!(status.pool.max, state.db.options().get_max_connections());
            assert_eq!(status.connections.is_none(), is_sqlite(&state.db));
            assert_eq!(status.online_indexes.is_empty(), is_sqlite(&state.db));
            assert!(
                status
                    .online_indexes
                    .iter()
                    .all(|index| index.state == "building" || index.percent.is_none())
            );
            assert!(!status.version.is_empty());
            temp.done(state).await;
        }
    }
}
