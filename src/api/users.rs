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
use crate::services::user_moderation::site_ban_user;
use crate::utils::error::{AppError, AppResult};
use crate::utils::helpers::{extract_username, system_username};
use crate::websocket::events::ServerMessage;

#[derive(Deserialize)]
struct ListParams {
    limit: Option<i64>,
    offset: Option<i64>,
    q: Option<String>,
}

async fn ban_user_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let requester_username = extract_username(&headers).unwrap_or_else(system_username);
    site_ban_user(&state.db, &username, &requester_username).await?;

    state
        .ws_manager
        .broadcast(ServerMessage::UserBanned {
            username: username.clone(),
        })
        .await;
    Ok(Json(serde_json::json!({ "success": true })))
}

async fn list_users_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> AppResult<Json<serde_json::Value>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);

    let is_site_admin = sqlx::query("SELECT is_admin FROM users WHERE username = ?")
        .bind(&username)
        .fetch_one(state.db.as_ref())
        .await?
        .get::<i64, _>("is_admin");

    if is_site_admin == 0 {
        return Err(AppError::Unauthorized(
            "Site admin privileges required".to_string(),
        ));
    }

    let limit = params.limit.unwrap_or(50);
    let offset = params.offset.unwrap_or(0);
    let search = params.q.unwrap_or_default();
    let search_pattern = format!("%{}%", search);

    let total = sqlx::query(
        "SELECT COUNT(*) as count FROM users WHERE username != 'system' AND username LIKE ?",
    )
    .bind(&search_pattern)
    .fetch_one(state.db.as_ref())
    .await?
    .get::<i64, _>("count");

    let users = sqlx::query(
        "SELECT username, is_admin, created_at FROM users WHERE username != 'system' AND username LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(&search_pattern)
    .bind(limit)
    .bind(offset)
    .fetch_all(state.db.as_ref())
    .await?;

    let user_list: Vec<serde_json::Value> = users
        .iter()
        .map(|row| {
            serde_json::json!({
                "username": row.get::<String, _>("username"),
                "is_admin": row.get::<i64, _>("is_admin"),
                "created_at": row.get::<String, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "users": user_list,
        "total": total
    })))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_users_handler))
        .route("/:username/ban", post(ban_user_handler))
}
