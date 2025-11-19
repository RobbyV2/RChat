use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
};
use serde::Deserialize;
use sqlx::Row;
use std::sync::Arc;

use crate::api::AppState;
use crate::models::message::ContentType;
use crate::services::chat::create_message;
use crate::services::direct_message::{get_or_create_dm, get_user_dms};
use crate::utils::error::AppResult;
use crate::utils::helpers::{extract_username, json_list, json_response, system_username};
use crate::websocket::events::ServerMessage;

#[derive(Deserialize)]
struct CreateDmRequest {
    other_username: String,
}

#[derive(Deserialize)]
struct SendDmMessageRequest {
    content: String,
    content_type: Option<String>,
}

#[derive(Deserialize)]
struct GetMessagesQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn create_or_get_dm(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CreateDmRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);
    let dm = get_or_create_dm(&state.db, username.clone(), req.other_username.clone()).await?;

    let ws_message = ServerMessage::DmCreated {
        dm_id: dm.id.clone(),
        username1: username,
        username2: req.other_username,
    };
    state.ws_manager.broadcast(ws_message).await;

    Ok(json_response(&dm))
}

async fn list_dms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);
    let dms = get_user_dms(&state.db, &username).await?;
    Ok(json_list(dms))
}

async fn send_dm_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(dm_id): Path<String>,
    Json(req): Json<SendDmMessageRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let sender_username = extract_username(&headers).unwrap_or_else(system_username);

    let content_type = match req.content_type.as_deref() {
        Some("markdown") => ContentType::Markdown,
        _ => ContentType::Text,
    };

    let message = create_message(
        &state.db,
        None,
        Some(dm_id.clone()),
        sender_username.clone(),
        req.content,
        content_type,
    )
    .await?;

    let sender_info =
        sqlx::query("SELECT profile_type, avatar_color FROM users WHERE username = ?")
            .bind(&sender_username)
            .fetch_one(state.db.as_ref())
            .await?;
    let profile_type: String = sender_info.get("profile_type");
    let avatar_color: Option<String> = sender_info.get("avatar_color");

    let ws_message = ServerMessage::NewDmMessage {
        message_id: message.id.clone(),
        dm_id: dm_id.clone(),
        sender_username: sender_username.clone(),
        content: message.content.clone(),
        filtered_content: message.filtered_content.clone(),
        content_type: message.content_type.clone(),
        filter_status: message.filter_status.clone(),
        created_at: message.created_at.clone(),
        sender_profile_type: Some(profile_type),
        sender_avatar_color: avatar_color,
        attachments: None,
    };

    state.ws_manager.broadcast(ws_message).await;

    Ok(json_response(&message))
}

async fn get_dm_messages(
    State(state): State<Arc<AppState>>,
    Path(dm_id): Path<String>,
    Query(query): Query<GetMessagesQuery>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let limit = query.limit.unwrap_or(50).min(100);
    let offset = query.offset.unwrap_or(0);

    let messages = sqlx::query_as::<_, crate::models::message::Message>(
        "SELECT * FROM messages WHERE dm_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .bind(&dm_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(state.db.as_ref())
    .await?;

    Ok(json_list(messages))
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", post(create_or_get_dm))
        .route("/", get(list_dms))
        .route("/:dm_id/messages", post(send_dm_message))
        .route("/:dm_id/messages", get(get_dm_messages))
        .with_state(state)
}
