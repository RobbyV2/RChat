//! `server db ...`: commands on the instance's database.

use clap::Subcommand;

use crate::config::AppConfig;
use crate::db::DbOptions;

#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum DbCommand {
    /// Rewrite the SQLite database so the pages deleted or rewritten text left behind are gone
    /// from the file. Stop the server first. Postgres: run VACUUM FULL (or pg_repack) instead.
    Compact,
}

pub async fn run(config: &AppConfig, command: DbCommand) -> anyhow::Result<String> {
    match command {
        DbCommand::Compact => compact(config).await,
    }
}

async fn compact(config: &AppConfig) -> anyhow::Result<String> {
    let Some(file) = crate::db::sqlite_file(config.database_url.as_deref()) else {
        anyhow::bail!(
            "db compact works on SQLite. On Postgres run VACUUM FULL (or pg_repack) on the database instead"
        );
    };
    let size = |path: &std::path::Path| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let before = size(&file);
    let opts = DbOptions {
        controls: None,
        ..config.db_options()
    };
    let db = crate::db::open_with(config.database_url.as_deref(), &opts).await?;
    let done = async {
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&db)
            .await?;
        sqlx::query("VACUUM").execute(&db).await?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&db)
            .await
    }
    .await;
    crate::db::close(&db).await;
    done?;
    Ok(format!(
        "Compacted {}: {} bytes before, {} now.",
        file.display(),
        before,
        size(&file)
    ))
}
