use crate::{
    database::DbPool,
    models::message::{Message, MessageWithSender},
    utils::error::{AppError, AppResult},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageTarget {
    Channel,
    DirectMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageRequest {
    pub target_type: MessageTarget,
    pub target_id: String,
    pub content: String,
    pub content_type: String,
    pub file_id: Option<String>,
}

pub async fn send_message(
    pool: &DbPool,
    request: SendMessageRequest,
    sender_username: &str,
) -> AppResult<MessageWithSender> {
    match request.target_type {
        MessageTarget::Channel => {
            send_channel_message(
                pool,
                &request.target_id,
                sender_username,
                &request.content,
                &request.content_type,
                request.file_id.as_deref(),
            )
            .await
        }
        MessageTarget::DirectMessage => {
            send_dm_message(
                pool,
                &request.target_id,
                sender_username,
                &request.content,
                &request.content_type,
                request.file_id.as_deref(),
            )
            .await
        }
    }
}

async fn send_channel_message(
    pool: &DbPool,
    channel_id: &str,
    sender_username: &str,
    content: &str,
    content_type: &str,
    file_id: Option<&str>,
) -> AppResult<MessageWithSender> {
    let channel = sqlx::query("SELECT * FROM channels WHERE id = ?")
        .bind(channel_id)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Channel not found".to_string()))?;

    let server_name = channel.get::<String, _>("server_name");

    let is_member = sqlx::query(
        "SELECT COUNT(*) as count FROM server_members WHERE server_name = ? AND username = ?",
    )
    .bind(&server_name)
    .bind(sender_username)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("count");

    if is_member == 0 {
        return Err(AppError::Unauthorized(
            "You must be a member of the server to send messages".to_string(),
        ));
    }

    // Profanity filtering for channel messages
    let (censored_text, has_profanity) = crate::services::profanity::filter_profanity(content);
    let (filter_status, filtered_content) = if has_profanity {
        ("filtered", Some(censored_text))
    } else {
        ("clean", None)
    };

    let message_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let message = Message {
        id: message_id.clone(),
        channel_id: Some(channel_id.to_string()),
        dm_id: None,
        sender_username: sender_username.to_string(),
        content: content.to_string(),
        filtered_content,
        content_type: content_type.to_string(),
        created_at: now.clone(),
        edited_at: None,
        is_deleted: 0,
        filter_status: filter_status.to_string(),
    };

    sqlx::query(
        "INSERT INTO messages (id, channel_id, sender_username, content, filtered_content, content_type, created_at, filter_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&message.id)
    .bind(&message.channel_id)
    .bind(&message.sender_username)
    .bind(&message.content)
    .bind(&message.filtered_content)
    .bind(&message.content_type)
    .bind(&message.created_at)
    .bind(&message.filter_status)
    .execute(pool.as_ref())
    .await?;

    if let Some(fid) = file_id {
        sqlx::query(
            "INSERT INTO file_attachments (file_id, message_id, position) VALUES (?, ?, 0)",
        )
        .bind(fid)
        .bind(&message.id)
        .execute(pool.as_ref())
        .await?;
    }

    let sender_info =
        sqlx::query("SELECT profile_type, avatar_color FROM users WHERE username = ?")
            .bind(sender_username)
            .fetch_one(pool.as_ref())
            .await?;

    let profile_type: String = sender_info.get("profile_type");
    let avatar_color: Option<String> = sender_info.get("avatar_color");

    Ok(MessageWithSender {
        message,
        sender_profile_type: profile_type,
        sender_avatar_color: avatar_color,
    })
}

async fn send_dm_message(
    pool: &DbPool,
    dm_id: &str,
    sender_username: &str,
    content: &str,
    content_type: &str,
    file_id: Option<&str>,
) -> AppResult<MessageWithSender> {
    let dm = sqlx::query("SELECT * FROM direct_messages WHERE id = ?")
        .bind(dm_id)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Direct message conversation not found".to_string()))?;

    let username1 = dm.get::<String, _>("username1");
    let username2 = dm.get::<String, _>("username2");

    if sender_username != username1 && sender_username != username2 {
        return Err(AppError::Unauthorized(
            "You are not part of this conversation".to_string(),
        ));
    }

    let message_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let message = Message {
        id: message_id.clone(),
        channel_id: None,
        dm_id: Some(dm_id.to_string()),
        sender_username: sender_username.to_string(),
        content: content.to_string(),
        filtered_content: None,
        content_type: content_type.to_string(),
        created_at: now.clone(),
        edited_at: None,
        is_deleted: 0,
        filter_status: "clean".to_string(),
    };

    sqlx::query(
        "INSERT INTO messages (id, dm_id, sender_username, content, content_type, created_at, filter_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&message.id)
    .bind(&message.dm_id)
    .bind(&message.sender_username)
    .bind(&message.content)
    .bind(&message.content_type)
    .bind(&message.created_at)
    .bind(&message.filter_status)
    .execute(pool.as_ref())
    .await?;

    if let Some(fid) = file_id {
        sqlx::query(
            "INSERT INTO file_attachments (file_id, message_id, position) VALUES (?, ?, 0)",
        )
        .bind(fid)
        .bind(&message.id)
        .execute(pool.as_ref())
        .await?;
    }

    let sender_info =
        sqlx::query("SELECT profile_type, avatar_color FROM users WHERE username = ?")
            .bind(sender_username)
            .fetch_one(pool.as_ref())
            .await?;

    let profile_type: String = sender_info.get("profile_type");
    let avatar_color: Option<String> = sender_info.get("avatar_color");

    Ok(MessageWithSender {
        message,
        sender_profile_type: profile_type,
        sender_avatar_color: avatar_color,
    })
}

pub async fn get_messages(
    pool: &DbPool,
    target_type: MessageTarget,
    target_id: &str,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<serde_json::Value>> {
    let messages = match target_type {
        MessageTarget::Channel => sqlx::query_as::<_, MessageWithSender>(
            "SELECT m.*, u.profile_type as sender_profile_type, u.avatar_color as sender_avatar_color 
             FROM messages m 
             JOIN users u ON m.sender_username = u.username
             WHERE m.channel_id = ? AND m.is_deleted = 0 
             ORDER BY m.created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(target_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool.as_ref())
        .await?,
        MessageTarget::DirectMessage => {
            sqlx::query_as::<_, MessageWithSender>(
                "SELECT m.*, u.profile_type as sender_profile_type, u.avatar_color as sender_avatar_color
                 FROM messages m
                 JOIN users u ON m.sender_username = u.username
                 WHERE m.dm_id = ? AND m.is_deleted = 0 
                 ORDER BY m.created_at DESC LIMIT ? OFFSET ?",
            )
            .bind(target_id)
            .bind(limit)
            .bind(offset)
            .fetch_all(pool.as_ref())
            .await?
        }
    };

    let mut result = Vec::new();

    for msg in messages {
        let attachments = sqlx::query(
            "SELECT f.id as file_id, f.original_name, f.content_type, f.size, f.download_count
             FROM file_attachments fa
             JOIN files f ON fa.file_id = f.id
             WHERE fa.message_id = ? AND f.is_deleted = 0",
        )
        .bind(&msg.message.id)
        .fetch_all(pool.as_ref())
        .await?;

        let attachment_list: Vec<serde_json::Value> = attachments
            .iter()
            .map(|row| {
                serde_json::json!({
                    "file_id": row.get::<String, _>("file_id"),
                    "original_name": row.get::<String, _>("original_name"),
                    "content_type": row.get::<String, _>("content_type"),
                    "size": row.get::<i64, _>("size"),
                    "download_count": row.get::<i64, _>("download_count"),
                })
            })
            .collect();

        let mut msg_json = serde_json::to_value(&msg).unwrap();
        if let Some(obj) = msg_json.as_object_mut() {
            // Flatten the 'message' field if MessageWithSender has nested 'message'
            // Wait, MessageWithSender has #[serde(flatten)] pub message: Message
            // So msg_json ALREADY has fields at top level.
            // But 'message' field might be present if flatten didn't work as expected with to_value?
            // No, serde(flatten) works.
            obj.insert(
                "attachments".to_string(),
                serde_json::Value::Array(attachment_list),
            );
        }
        result.push(msg_json);
    }

    Ok(result)
}

pub async fn delete_message(
    pool: &DbPool,
    target_type: MessageTarget,
    target_id: &str,
    message_id: &str,
    requester_username: &str,
) -> AppResult<Message> {
    let message = sqlx::query_as::<_, Message>("SELECT * FROM messages WHERE id = ?")
        .bind(message_id)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Message not found".to_string()))?;

    // Check target consistency
    match target_type {
        MessageTarget::Channel => {
            if message.channel_id.as_deref() != Some(target_id) {
                return Err(AppError::BadRequest(
                    "Message does not belong to this channel".to_string(),
                ));
            }
        }
        MessageTarget::DirectMessage => {
            if message.dm_id.as_deref() != Some(target_id) {
                return Err(AppError::BadRequest(
                    "Message does not belong to this DM".to_string(),
                ));
            }
        }
    }

    let mut authorized = false;

    // 1. Check if user is sender
    if message.sender_username == requester_username {
        authorized = true;
    } else {
        // 2. Check if user is Site Admin
        let is_site_admin = sqlx::query("SELECT is_admin FROM users WHERE username = ?")
            .bind(requester_username)
            .fetch_one(pool.as_ref())
            .await?
            .get::<i64, _>("is_admin");

        if is_site_admin == 1 {
            authorized = true;
        } else if let MessageTarget::Channel = target_type {
            // 3. If Channel, check if Server Admin
            let channel = sqlx::query("SELECT server_name FROM channels WHERE id = ?")
                .bind(target_id)
                .fetch_optional(pool.as_ref())
                .await?
                .ok_or_else(|| AppError::NotFound("Channel not found".to_string()))?;

            let server_name: String = channel.get("server_name");

            let member = sqlx::query(
                "SELECT role FROM server_members WHERE server_name = ? AND username = ?",
            )
            .bind(&server_name)
            .bind(requester_username)
            .fetch_optional(pool.as_ref())
            .await?;

            if let Some(row) = member {
                let role: String = row.get("role");
                if role == "admin" {
                    authorized = true;
                }
            }
        }
    }

    if authorized {
        sqlx::query("UPDATE messages SET is_deleted = 1 WHERE id = ?")
            .bind(message_id)
            .execute(pool.as_ref())
            .await?;
        return Ok(message);
    }

    Err(AppError::Unauthorized(
        "You do not have permission to delete this message".to_string(),
    ))
}
