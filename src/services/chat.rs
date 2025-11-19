use crate::database::DbPool;
use crate::models::message::{ContentType, FilterStatus, Message};
use crate::services::profanity::filter_profanity;
use crate::utils::error::{AppError, AppResult};
use sqlx::Row;

pub async fn create_message(
    pool: &DbPool,
    channel_id: Option<String>,
    dm_id: Option<String>,
    sender_username: String,
    content: String,
    content_type: ContentType,
) -> AppResult<Message> {
    if content.trim().is_empty() {
        return Err(AppError::Validation(
            "Message content cannot be empty".to_string(),
        ));
    }

    if content.len() > 4000 {
        return Err(AppError::Validation(
            "Message content too long (max 4000 chars)".to_string(),
        ));
    }

    let (filtered_content, has_profanity) = if channel_id.is_some() {
        filter_profanity(&content)
    } else {
        (content.clone(), false)
    };
    let filter_status = if has_profanity {
        FilterStatus::Filtered
    } else {
        FilterStatus::Clean
    };

    let final_filtered = if has_profanity {
        Some(filtered_content)
    } else {
        None
    };

    let message = Message::new(
        channel_id.clone(),
        dm_id.clone(),
        sender_username,
        content,
        content_type,
        filter_status,
        final_filtered,
    );

    sqlx::query(
        "INSERT INTO messages (id, channel_id, dm_id, sender_username, content, filtered_content, content_type, created_at, is_deleted, filter_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&message.id)
    .bind(&message.channel_id)
    .bind(&message.dm_id)
    .bind(&message.sender_username)
    .bind(&message.content)
    .bind(&message.filtered_content)
    .bind(&message.content_type)
    .bind(&message.created_at)
    .bind(message.is_deleted)
    .bind(&message.filter_status)
    .execute(pool.as_ref())
    .await?;

    if let Some(cid) = &channel_id {
        sqlx::query("UPDATE channels SET message_count = message_count + 1 WHERE id = ?")
            .bind(cid)
            .execute(pool.as_ref())
            .await?;
    }

    if let Some(did) = &dm_id {
        sqlx::query("UPDATE direct_messages SET message_count = message_count + 1, last_message_at = ? WHERE id = ?")
            .bind(&message.created_at)
            .bind(did)
            .execute(pool.as_ref())
            .await?;
    }

    Ok(message)
}

pub async fn get_channel_messages(
    pool: &DbPool,
    channel_id: &str,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<Message>> {
    let messages = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE channel_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .bind(channel_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool.as_ref())
    .await?;

    Ok(messages)
}

pub async fn verify_username_exists(pool: &DbPool, username: &str) -> AppResult<bool> {
    let count = sqlx::query("SELECT COUNT(*) as count FROM users WHERE username = ?")
        .bind(username)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("count");

    Ok(count > 0)
}

pub async fn delete_message(pool: &DbPool, message_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE messages SET is_deleted = 1 WHERE id = ?")
        .bind(message_id)
        .execute(pool.as_ref())
        .await?;

    Ok(())
}
