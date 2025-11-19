use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::{delete, get, patch, post},
};
use serde::Deserialize;
use sqlx::Row;
use std::sync::Arc;

use crate::api::AppState;
use crate::services::server::{
    create_server, delete_server, get_server_members, get_user_servers, join_server,
    update_member_role,
};
use crate::services::user_moderation::server_ban_user;
use crate::utils::error::AppResult;
use crate::utils::helpers::{extract_username, json_list, json_response, system_username};
use crate::websocket::events::ServerMessage;

#[derive(Deserialize)]
struct CreateServerRequest {
    name: String,
}

#[derive(Deserialize)]
struct JoinServerRequest {
    server_name: String,
}

#[derive(Deserialize)]
struct UpdateMemberRoleRequest {
    role: String,
}

async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CreateServerRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let creator_username = extract_username(&headers).unwrap_or_else(system_username);
    let server = create_server(&state.db, req.name, creator_username.clone()).await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ServerCreated {
            server_name: server.name.clone(),
            owner_username: creator_username,
        })
        .await;

    Ok(json_response(&server))
}

async fn join(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<JoinServerRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);
    let server = join_server(&state.db, req.server_name, username.clone()).await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ServerMemberJoined {
            server_name: server.name.clone(),
            username,
        })
        .await;

    let stats = sqlx::query("SELECT member_count, channel_count FROM servers WHERE name = ?")
        .bind(&server.name)
        .fetch_one(state.db.as_ref())
        .await?;

    let member_count = stats.get("member_count");
    let channel_count = stats.get("channel_count");

    tracing::info!(
        "Broadcasting ServerStatsUpdated for '{}': members={}, channels={}",
        server.name,
        member_count,
        channel_count
    );

    state
        .ws_manager
        .broadcast(ServerMessage::ServerStatsUpdated {
            server_name: server.name.clone(),
            member_count,
            channel_count,
        })
        .await;

    Ok(json_response(&server))
}

async fn list_servers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);
    let servers = get_user_servers(&state.db, &username).await?;
    Ok(json_list(servers))
}

async fn list_members(
    State(state): State<Arc<AppState>>,
    Path(server_name): Path<String>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let members = get_server_members(&state.db, &server_name).await?;
    Ok(json_list(members))
}

async fn remove_server_member(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((server_name, username)): Path<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    let requester_username = extract_username(&headers).unwrap_or_else(system_username);
    server_ban_user(
        &state.db,
        &server_name,
        &username,
        &requester_username,
        None,
    )
    .await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ServerMemberLeft {
            server_name: server_name.clone(),
            username: username.clone(),
        })
        .await;

    let stats = sqlx::query("SELECT member_count, channel_count FROM servers WHERE name = ?")
        .bind(&server_name)
        .fetch_one(state.db.as_ref())
        .await?;

    let member_count = stats.get("member_count");
    let channel_count = stats.get("channel_count");

    tracing::info!(
        "Broadcasting ServerStatsUpdated for '{}' after member removal: members={}, channels={}",
        server_name,
        member_count,
        channel_count
    );

    state
        .ws_manager
        .broadcast(ServerMessage::ServerStatsUpdated {
            server_name,
            member_count,
            channel_count,
        })
        .await;

    Ok(Json(serde_json::json!({ "success": true })))
}

async fn update_member(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((server_name, username)): Path<(String, String)>,
    Json(req): Json<UpdateMemberRoleRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let requester_username = extract_username(&headers).unwrap_or_else(system_username);
    update_member_role(
        &state.db,
        &server_name,
        &username,
        &req.role,
        &requester_username,
    )
    .await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ServerMemberRoleUpdated {
            server_name: server_name.clone(),
            username: username.clone(),
            new_role: req.role,
        })
        .await;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
struct ReorderServersRequest {
    server_names: Vec<String>,
}

async fn reorder(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ReorderServersRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);
    crate::services::server::reorder_servers(&state.db, &username, req.server_names).await?;
    Ok(Json(serde_json::json!({ "success": true })))
}

async fn delete_server_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_name): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let requester_username = extract_username(&headers).unwrap_or_else(system_username);
    delete_server(&state.db, &server_name, &requester_username).await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ServerDeleted {
            server_name: server_name.clone(),
        })
        .await;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
struct TransferOwnershipRequest {
    new_owner: String,
}

async fn transfer_ownership_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_name): Path<String>,
    Json(req): Json<TransferOwnershipRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let requester_username = extract_username(&headers).unwrap_or_else(system_username);

    crate::services::server::transfer_ownership(
        &state.db,
        &server_name,
        &req.new_owner,
        &requester_username,
    )
    .await?;

    state
        .ws_manager
        .broadcast(ServerMessage::ServerMemberRoleUpdated {
            server_name: server_name.clone(),
            username: req.new_owner.clone(),
            new_role: "admin".to_string(),
        })
        .await;

    state
        .ws_manager
        .broadcast(ServerMessage::ServerMemberRoleUpdated {
            server_name: server_name.clone(),
            username: requester_username.clone(),
            new_role: "member".to_string(),
        })
        .await;

    Ok(Json(serde_json::json!({ "success": true })))
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", post(create))
        .route("/", get(list_servers))
        .route("/reorder", post(reorder))
        .route("/join", post(join))
        .route("/:server_name", delete(delete_server_handler))
        .route("/:server_name/members", get(list_members))
        .route(
            "/:server_name/transfer-ownership",
            post(transfer_ownership_handler),
        )
        .route(
            "/:server_name/members/:username",
            delete(remove_server_member),
        )
        .route("/:server_name/members/:username", patch(update_member))
        .with_state(state)
}
