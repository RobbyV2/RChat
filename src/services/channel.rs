use crate::database::DbPool;
use crate::models::channel::Channel;
use crate::utils::error::{AppError, AppResult};
use crate::utils::validation::validate_channel_name;
use sqlx::Row;

pub async fn create_channel(
    pool: &DbPool,
    server_name: String,
    name: String,
) -> AppResult<Channel> {
    validate_channel_name(&name)?;

    let max_position = sqlx::query(
        "SELECT COALESCE(MAX(position), -1) as max_pos FROM channels WHERE server_name = ?",
    )
    .bind(&server_name)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("max_pos");

    let channel = Channel::new(server_name.clone(), name, max_position + 1);

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

    sqlx::query("UPDATE servers SET channel_count = channel_count + 1 WHERE name = ?")
        .bind(&server_name)
        .execute(pool.as_ref())
        .await?;

    Ok(channel)
}

pub async fn get_server_channels(pool: &DbPool, server_name: &str) -> AppResult<Vec<Channel>> {
    let channels = sqlx::query_as::<_, Channel>(
        "SELECT * FROM channels WHERE server_name = ? AND is_active = 1 ORDER BY position ASC",
    )
    .bind(server_name)
    .fetch_all(pool.as_ref())
    .await?;

    Ok(channels)
}

pub async fn delete_channel(pool: &DbPool, channel_id: &str, server_name: &str) -> AppResult<()> {
    let channel_count = sqlx::query(
        "SELECT COUNT(*) as count FROM channels WHERE server_name = ? AND is_active = 1",
    )
    .bind(server_name)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("count");

    if channel_count <= 1 {
        return Err(AppError::BadRequest(
            "Cannot delete the last channel".to_string(),
        ));
    }

    sqlx::query("UPDATE channels SET is_active = 0 WHERE id = ?")
        .bind(channel_id)
        .execute(pool.as_ref())
        .await?;

    sqlx::query("UPDATE servers SET channel_count = channel_count - 1 WHERE name = ?")
        .bind(server_name)
        .execute(pool.as_ref())
        .await?;

    Ok(())
}

pub async fn rename_channel(
    pool: &DbPool,
    channel_id: &str,
    new_name: String,
) -> AppResult<Channel> {
    validate_channel_name(&new_name)?;

    sqlx::query("UPDATE channels SET name = ? WHERE id = ?")
        .bind(&new_name)
        .bind(channel_id)
        .execute(pool.as_ref())
        .await?;

    let updated_channel = sqlx::query_as::<_, Channel>("SELECT * FROM channels WHERE id = ?")
        .bind(channel_id)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Channel not found".to_string()))?;

    Ok(updated_channel)
}
