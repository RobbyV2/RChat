use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{delete, get, post},
};
use serde::Deserialize;
use std::sync::Arc;

use crate::api::AppState;
use crate::services::messaging::{
    MessageTarget, SendMessageRequest, delete_message, get_messages, send_message,
};
use crate::utils::error::AppResult;
use crate::utils::helpers::{extract_username, json_list, system_username};
use crate::websocket::events::ServerMessage;

#[derive(Deserialize)]
struct GetMessagesQuery {
    target_type: String,
    target_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn send_message_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<SendMessageRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);

    let message_result = send_message(&state.db, req.clone(), &username).await?;
    let message = &message_result.message;

    use sqlx::Row;
    let attachments = sqlx::query(
        "SELECT f.id as file_id, f.original_name, f.content_type, f.size 
         FROM file_attachments fa 
         JOIN files f ON fa.file_id = f.id 
         WHERE fa.message_id = ? AND f.is_deleted = 0",
    )
    .bind(&message.id)
    .fetch_all(state.db.as_ref())
    .await?;

    let attachment_list: Vec<serde_json::Value> = attachments
        .iter()
        .map(|row| {
            serde_json::json!({
                "file_id": row.get::<String, _>("file_id"),
                "original_name": row.get::<String, _>("original_name"),
                "content_type": row.get::<String, _>("content_type"),
                "size": row.get::<i64, _>("size"),
            })
        })
        .collect();

    let ws_event = match req.target_type {
        MessageTarget::Channel => ServerMessage::NewMessage {
            message_id: message.id.clone(),
            channel_id: message.channel_id.clone().unwrap_or_default(),
            sender_username: message.sender_username.clone(),
            content: message.content.clone(),
            filtered_content: message.filtered_content.clone(),
            content_type: message.content_type.clone(),
            filter_status: message.filter_status.clone(),
            created_at: message.created_at.clone(),
            sender_profile_type: Some(message_result.sender_profile_type.clone()),
            sender_avatar_color: message_result.sender_avatar_color.clone(),
            attachments: Some(attachment_list.clone()),
        },
        MessageTarget::DirectMessage => ServerMessage::NewDmMessage {
            message_id: message.id.clone(),
            dm_id: message.dm_id.clone().unwrap_or_default(),
            sender_username: message.sender_username.clone(),
            content: message.content.clone(),
            filtered_content: message.filtered_content.clone(),
            content_type: message.content_type.clone(),
            filter_status: message.filter_status.clone(),
            created_at: message.created_at.clone(),
            sender_profile_type: Some(message_result.sender_profile_type.clone()),
            sender_avatar_color: message_result.sender_avatar_color.clone(),
            attachments: Some(attachment_list.clone()),
        },
    };

    state.ws_manager.broadcast(ws_event).await;

    let mut response_json = serde_json::to_value(&message_result).unwrap();
    if let Some(obj) = response_json.as_object_mut() {
        obj.insert(
            "attachments".to_string(),
            serde_json::Value::Array(attachment_list),
        );
    }

    Ok(Json(response_json))
}

async fn get_messages_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GetMessagesQuery>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let target_type = match query.target_type.as_str() {
        "channel" => MessageTarget::Channel,
        "dm" | "direct_message" => MessageTarget::DirectMessage,
        _ => {
            return Err(crate::utils::error::AppError::BadRequest(
                "Invalid target_type. Must be 'channel' or 'dm'".to_string(),
            ));
        }
    };

    let limit = query.limit.unwrap_or(50);
    let offset = query.offset.unwrap_or(0);

    let messages = get_messages(&state.db, target_type, &query.target_id, limit, offset).await?;
    Ok(json_list(messages))
}

async fn delete_channel_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((channel_id, message_id)): Path<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);

    let message = delete_message(
        &state.db,
        MessageTarget::Channel,
        &channel_id,
        &message_id,
        &username,
    )
    .await?;

    state
        .ws_manager
        .broadcast(ServerMessage::MessageDeleted {
            message_id: message.id,
            channel_id: message.channel_id,
            dm_id: message.dm_id,
        })
        .await;

    Ok(Json(serde_json::json!({"success": true})))
}

async fn delete_dm_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((dm_id, message_id)): Path<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);

    let message = delete_message(
        &state.db,
        MessageTarget::DirectMessage,
        &dm_id,
        &message_id,
        &username,
    )
    .await?;

    state
        .ws_manager
        .broadcast(ServerMessage::MessageDeleted {
            message_id: message.id,
            channel_id: message.channel_id,
            dm_id: message.dm_id,
        })
        .await;

    Ok(Json(serde_json::json!({"success": true})))
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", post(send_message_handler))
        .route("/", get(get_messages_handler))
        .route(
            "/channels/:channel_id/messages/:message_id",
            delete(delete_channel_message),
        )
        .route(
            "/dms/:dm_id/messages/:message_id",
            delete(delete_dm_message),
        )
        .with_state(state)
}
