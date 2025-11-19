use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
};
use std::sync::Arc;

use crate::api::AppState;
use crate::services::user_moderation::site_ban_user;
use crate::utils::error::{AppError, AppResult};
use crate::utils::helpers::{extract_username, system_username};
use crate::websocket::events::ServerMessage;
use sqlx::Row;

async fn list_all_servers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<serde_json::Value>>> {
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

    let servers = sqlx::query(
        "SELECT
            s.name,
            s.creator_username,
            s.created_at,
            COUNT(DISTINCT sm.username) as member_count,
            COUNT(DISTINCT c.id) as channel_count
         FROM servers s
         LEFT JOIN server_members sm ON s.name = sm.server_name
         LEFT JOIN channels c ON s.name = c.server_name
         WHERE s.is_active = 1
         GROUP BY s.name
         ORDER BY s.created_at DESC",
    )
    .fetch_all(state.db.as_ref())
    .await?;

    let server_list: Vec<serde_json::Value> = servers
        .iter()
        .map(|row| {
            serde_json::json!({
                "name": row.get::<String, _>("name"),
                "creator_username": row.get::<String, _>("creator_username"),
                "created_at": row.get::<String, _>("created_at"),
                "member_count": row.get::<i64, _>("member_count"),
                "channel_count": row.get::<i64, _>("channel_count"),
            })
        })
        .collect();

    Ok(Json(server_list))
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

    Ok(Json(serde_json::json!({"success": true})))
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/servers", get(list_all_servers))
        .route("/users/:username/ban", post(ban_user_handler))
        .with_state(state)
}
