use axum::{
    Json, Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::IntoResponse,
    routing::{delete, get, post},
};
use base64::Engine;
use serde::Deserialize;
use std::sync::Arc;
use tokio::fs;

use crate::api::AppState;
use crate::services::file_storage::{delete_file, get_file_path, list_user_files, save_file};
use crate::utils::error::{AppError, AppResult};
use crate::utils::helpers::{json_list, json_response, system_username};
use crate::websocket::events::ServerMessage;

#[derive(Deserialize)]
struct UploadRequest {
    name: String,
    content_type: String,
    data: String,
}

async fn upload(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UploadRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let uploader_username = system_username();

    let data = base64::engine::general_purpose::STANDARD
        .decode(&req.data)
        .map_err(|e| AppError::BadRequest(format!("Invalid base64: {}", e)))?;

    let file = save_file(
        &state.db,
        req.name,
        req.content_type,
        data,
        uploader_username,
    )
    .await?;

    Ok(json_response(&file))
}

async fn download(
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let (path, file) = get_file_path(&state.db, &file_id).await?;

    let contents = fs::read(&path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read file: {}", e)))?;

    let content_disposition = format!("inline; filename=\"{}\"", file.original_name);

    let new_download_count = file.download_count + 1;
    let ws_event = ServerMessage::FileDownloaded {
        file_id: file_id.clone(),
        download_count: new_download_count,
    };
    state.ws_manager.broadcast(ws_event).await;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, file.content_type),
            (header::CONTENT_DISPOSITION, content_disposition),
        ],
        contents,
    ))
}

async fn list_files(State(state): State<Arc<AppState>>) -> AppResult<Json<Vec<serde_json::Value>>> {
    let username = system_username();
    let files = list_user_files(&state.db, &username).await?;
    Ok(json_list(files))
}

async fn remove_file(
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let username = system_username();
    delete_file(&state.db, &file_id, &username).await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/files", post(upload))
        .route("/files", get(list_files))
        .route("/files/:file_id", delete(remove_file))
        .with_state(state)
}

pub fn public_routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/:file_id", get(download))
        .with_state(state)
}
