use sqlx::{Pool, Sqlite, sqlite::SqlitePool};
use std::sync::Arc;

pub type DbPool = Arc<Pool<Sqlite>>;

pub async fn create_pool(database_url: &str) -> anyhow::Result<DbPool> {
    let pool = SqlitePool::connect(database_url).await?;
    run_migrations(&pool).await?;
    Ok(Arc::new(pool))
}

pub async fn run_migrations(pool: &Pool<Sqlite>) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}
