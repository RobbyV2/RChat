use crate::database::DbPool;
use crate::models::channel::Channel;
use crate::models::server::Server;
use crate::utils::error::AppResult;
use sqlx::Row;

pub async fn ensure_rchat_server(pool: &DbPool) -> AppResult<()> {
    let exists = sqlx::query("SELECT COUNT(*) as count FROM servers WHERE name = 'RChat'")
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("count");

    if exists > 0 {
        tracing::info!("RChat server already exists");
        return Ok(());
    }

    tracing::info!("Creating RChat server");

    let server = Server::new("RChat".to_string(), "system".to_string());

    sqlx::query(
        "INSERT INTO servers (name, creator_username, created_at, is_active, member_count, channel_count)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&server.name)
    .bind(&server.creator_username)
    .bind(&server.created_at)
    .bind(server.is_active)
    .bind(0)
    .bind(0)
    .execute(pool.as_ref())
    .await?;

    let channel = Channel::new(server.name.clone(), "general".to_string(), 0);

    sqlx::query(
        "INSERT INTO channels (id, server_name, name, created_at, is_active, message_count, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&channel.id)
    .bind(&channel.server_name)
    .bind(&channel.name)
    .bind(&channel.created_at)
    .bind(channel.is_active)
    .bind(channel.message_count)
    .bind(channel.position)
    .execute(pool.as_ref())
    .await?;

    sqlx::query("UPDATE servers SET channel_count = 1 WHERE name = ?")
        .bind(&server.name)
        .execute(pool.as_ref())
        .await?;

    tracing::info!("RChat server and general channel created successfully");

    Ok(())
}
