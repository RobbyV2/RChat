use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::Arc;

use crate::api::AppState;
use crate::models::{
    channel::Channel, message::MessageWithSender, server::Server, server_member::ServerMember,
};
use crate::utils::error::{AppError, AppResult};
use crate::utils::helpers::json_list;

#[derive(Deserialize)]
struct GetMessagesQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize)]
struct LookupServerRequest {
    server_name: String,
}

#[derive(Serialize)]
struct ServerInfo {
    name: String,
    creator_username: String,
    created_at: String,
    member_count: i64,
    channel_count: i64,
}

async fn lookup_server(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LookupServerRequest>,
) -> AppResult<Json<ServerInfo>> {
    let server = sqlx::query_as::<_, Server>(
        "SELECT * FROM servers WHERE LOWER(name) = LOWER(?) AND is_active = 1",
    )
    .bind(&req.server_name)
    .fetch_optional(state.db.as_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Server not found".to_string()))?;

    let member_count =
        sqlx::query("SELECT COUNT(*) as count FROM server_members WHERE server_name = ?")
            .bind(&server.name)
            .fetch_one(state.db.as_ref())
            .await?
            .get::<i64, _>("count");

    let channel_count = sqlx::query("SELECT COUNT(*) as count FROM channels WHERE server_name = ?")
        .bind(&server.name)
        .fetch_one(state.db.as_ref())
        .await?
        .get::<i64, _>("count");

    Ok(Json(ServerInfo {
        name: server.name,
        creator_username: server.creator_username,
        created_at: server.created_at,
        member_count,
        channel_count,
    }))
}

async fn list_channels(
    State(state): State<Arc<AppState>>,
    Path(server_name): Path<String>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let channels = sqlx::query_as::<_, Channel>(
        "SELECT * FROM channels WHERE server_name = ? ORDER BY position",
    )
    .bind(&server_name)
    .fetch_all(state.db.as_ref())
    .await?;

    Ok(json_list(channels))
}

async fn get_messages(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
    Query(query): Query<GetMessagesQuery>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let limit = query.limit.unwrap_or(50).min(100);
    let offset = query.offset.unwrap_or(0);

    let messages = sqlx::query_as::<_, MessageWithSender>(
        "SELECT m.*, u.profile_type as sender_profile_type, u.avatar_color as sender_avatar_color
         FROM messages m
         JOIN users u ON m.sender_username = u.username
         WHERE m.channel_id = ? AND m.is_deleted = 0
         ORDER BY m.created_at DESC
         LIMIT ? OFFSET ?",
    )
    .bind(&channel_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(state.db.as_ref())
    .await?;

    let mut messages_with_attachments = Vec::new();
    for message_with_sender in messages {
        let mut message_json = serde_json::to_value(&message_with_sender).map_err(|e| {
            crate::utils::error::AppError::Internal(format!("Failed to serialize message: {}", e))
        })?;

        let attachments = sqlx::query(
            "SELECT f.id as file_id, f.original_name, f.content_type, f.size, f.download_count
             FROM file_attachments fa
             JOIN files f ON fa.file_id = f.id
             WHERE fa.message_id = ? AND f.is_deleted = 0
             ORDER BY fa.position",
        )
        .bind(&message_with_sender.message.id)
        .fetch_all(state.db.as_ref())
        .await?;

        if !attachments.is_empty() {
            let attachment_list: Vec<serde_json::Value> = attachments
                .into_iter()
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

            message_json["attachments"] = serde_json::Value::Array(attachment_list);
        }

        messages_with_attachments.push(message_json);
    }

    Ok(Json(messages_with_attachments))
}

async fn list_members(
    State(state): State<Arc<AppState>>,
    Path(server_name): Path<String>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let members = sqlx::query_as::<_, ServerMember>(
        "SELECT sm.*, u.profile_type, u.avatar_color 
         FROM server_members sm
         JOIN users u ON sm.username = u.username
         WHERE sm.server_name = ? 
         ORDER BY sm.username",
    )
    .bind(&server_name)
    .fetch_all(state.db.as_ref())
    .await?;

    Ok(json_list(members))
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/servers/lookup", post(lookup_server))
        .route("/servers/:server_name/channels", get(list_channels))
        .route("/servers/:server_name/members", get(list_members))
        .route("/channels/:channel_id/messages", get(get_messages))
        .with_state(state)
}
