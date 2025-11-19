use crate::database::DbPool;
use crate::models::direct_message::DirectMessage;
use crate::utils::error::{AppError, AppResult};
use sqlx::Row;

pub async fn get_or_create_dm(
    pool: &DbPool,
    username1: String,
    username2: String,
) -> AppResult<DirectMessage> {
    let user_exists = sqlx::query("SELECT COUNT(*) as count FROM users WHERE username = ?")
        .bind(&username2)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("count");

    if user_exists == 0 {
        return Err(AppError::NotFound("User not found".to_string()));
    }

    let (mut uname1, mut uname2) = (username1, username2);
    if uname1 > uname2 {
        std::mem::swap(&mut uname1, &mut uname2);
    }

    let existing = sqlx::query_as::<_, DirectMessage>(
        "SELECT * FROM direct_messages WHERE username1 = ? AND username2 = ?",
    )
    .bind(&uname1)
    .bind(&uname2)
    .fetch_optional(pool.as_ref())
    .await?;

    if let Some(dm) = existing {
        return Ok(dm);
    }

    let dm = DirectMessage::new(uname1.clone(), uname2.clone());

    sqlx::query(
        "INSERT INTO direct_messages (id, username1, username2, created_at, message_count, is_active)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&dm.id)
    .bind(&dm.username1)
    .bind(&dm.username2)
    .bind(&dm.created_at)
    .bind(dm.message_count)
    .bind(dm.is_active)
    .execute(pool.as_ref())
    .await?;

    Ok(dm)
}

pub async fn get_user_dms(pool: &DbPool, username: &str) -> AppResult<Vec<DirectMessage>> {
    let dms = sqlx::query_as::<_, DirectMessage>(
        "SELECT * FROM direct_messages WHERE (username1 = ? OR username2 = ?) AND is_active = 1 ORDER BY last_message_at DESC"
    )
    .bind(username)
    .bind(username)
    .fetch_all(pool.as_ref())
    .await?;

    Ok(dms)
}
