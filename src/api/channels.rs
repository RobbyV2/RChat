use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{delete, get, patch, post},
};
use serde::Deserialize;
use sqlx::Row;
use std::sync::Arc;

use crate::api::AppState;
use crate::services::channel::{
    create_channel, delete_channel, get_server_channels, rename_channel,
};
use crate::utils::error::AppResult;
use crate::utils::helpers::{json_list, json_response};
use crate::websocket::events::ServerMessage;

#[derive(Deserialize)]
struct CreateChannelRequest {
    name: String,
}

#[derive(Deserialize)]
struct RenameChannelRequest {
    name: String,
}

async fn create(
    State(state): State<Arc<AppState>>,
    Path(server_name): Path<String>,
    Json(req): Json<CreateChannelRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let channel = create_channel(&state.db, server_name.clone(), req.name).await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ChannelCreated {
            server_name: server_name.clone(),
            channel_id: channel.id.clone(),
            channel_name: channel.name.clone(),
        })
        .await;

    let stats = sqlx::query("SELECT member_count, channel_count FROM servers WHERE name = ?")
        .bind(&server_name)
        .fetch_one(state.db.as_ref())
        .await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ServerStatsUpdated {
            server_name,
            member_count: stats.get("member_count"),
            channel_count: stats.get("channel_count"),
        })
        .await;

    Ok(json_response(&channel))
}

async fn list(
    State(state): State<Arc<AppState>>,
    Path(server_name): Path<String>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let channels = get_server_channels(&state.db, &server_name).await?;
    Ok(json_list(channels))
}

async fn remove(
    State(state): State<Arc<AppState>>,
    Path((server_name, channel_id)): Path<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    delete_channel(&state.db, &channel_id, &server_name).await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ChannelDeleted {
            server_name: server_name.clone(),
            channel_id,
        })
        .await;

    let stats = sqlx::query("SELECT member_count, channel_count FROM servers WHERE name = ?")
        .bind(&server_name)
        .fetch_one(state.db.as_ref())
        .await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ServerStatsUpdated {
            server_name,
            member_count: stats.get("member_count"),
            channel_count: stats.get("channel_count"),
        })
        .await;

    Ok(Json(serde_json::json!({"success": true})))
}

async fn rename(
    State(state): State<Arc<AppState>>,
    Path((server_name, channel_id)): Path<(String, String)>,
    Json(req): Json<RenameChannelRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let channel = rename_channel(&state.db, &channel_id, req.name.clone()).await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ChannelRenamed {
            server_name,
            channel_id,
            new_name: req.name,
        })
        .await;

    Ok(json_response(&channel))
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/servers/:server_name/channels", post(create))
        .route("/servers/:server_name/channels", get(list))
        .route("/servers/:server_name/channels/:channel_id", delete(remove))
        .route("/servers/:server_name/channels/:channel_id", patch(rename))
        .with_state(state)
}
