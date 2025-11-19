use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{delete, get, post},
};
use serde::Deserialize;
use std::sync::Arc;

use crate::api::AppState;
use crate::services::user_moderation::site_ban_user;
use crate::utils::error::{AppError, AppResult};
use crate::utils::helpers::{extract_username, system_username};
use crate::websocket::events::ServerMessage;
use sqlx::Row;

#[derive(Deserialize)]
struct ListParams {
    limit: Option<i64>,
    offset: Option<i64>,
    q: Option<String>,
}

async fn check_admin(pool: &crate::database::DbPool, username: &str) -> AppResult<()> {
    let is_site_admin = sqlx::query("SELECT is_admin FROM users WHERE username = ?")
        .bind(username)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("is_admin");

    if is_site_admin == 0 {
        return Err(AppError::Unauthorized(
            "Site admin privileges required".to_string(),
        ));
    }
    Ok(())
}

async fn list_all_servers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> AppResult<Json<serde_json::Value>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);
    check_admin(&state.db, &username).await?;

    let limit = params.limit.unwrap_or(50);
    let offset = params.offset.unwrap_or(0);
    let search = params.q.unwrap_or_default();
    let search_pattern = format!("%{}%", search);

    let total =
        sqlx::query("SELECT COUNT(*) as count FROM servers WHERE is_active = 1 AND name LIKE ?")
            .bind(&search_pattern)
            .fetch_one(state.db.as_ref())
            .await?
            .get::<i64, _>("count");

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
         WHERE s.is_active = 1 AND s.name LIKE ?
         GROUP BY s.name
         ORDER BY s.created_at DESC
         LIMIT ? OFFSET ?",
    )
    .bind(&search_pattern)
    .bind(limit)
    .bind(offset)
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

    Ok(Json(serde_json::json!({
        "servers": server_list,
        "total": total
    })))
}

async fn get_banned_users(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> AppResult<Json<serde_json::Value>> {
    let username = extract_username(&headers).unwrap_or_else(system_username);
    check_admin(&state.db, &username).await?;

    let limit = params.limit.unwrap_or(50);
    let offset = params.offset.unwrap_or(0);
    let search = params.q.unwrap_or_default();
    let search_pattern = format!("%{}%", search);

    let total = sqlx::query("SELECT COUNT(*) as count FROM banned_usernames WHERE username LIKE ?")
        .bind(&search_pattern)
        .fetch_one(state.db.as_ref())
        .await?
        .get::<i64, _>("count");

    let banned_users = sqlx::query(
        "SELECT * FROM banned_usernames WHERE username LIKE ? ORDER BY banned_at DESC LIMIT ? OFFSET ?"
    )
    .bind(&search_pattern)
    .bind(limit)
    .bind(offset)
    .fetch_all(state.db.as_ref())
    .await?;

    let list: Vec<serde_json::Value> = banned_users
        .iter()
        .map(|row| {
            serde_json::json!({
                "username": row.get::<String, _>("username"),
                "banned_at": row.get::<String, _>("banned_at"),
                "banned_by": row.get::<String, _>("banned_by"),
                "reason": row.try_get::<String, _>("reason").ok(),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "banned_users": list,
        "total": total
    })))
}

async fn unban_user_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let requester_username = extract_username(&headers).unwrap_or_else(system_username);
    check_admin(&state.db, &requester_username).await?;

    sqlx::query("DELETE FROM banned_usernames WHERE username = ?")
        .bind(&username)
        .execute(state.db.as_ref())
        .await?;

    Ok(Json(serde_json::json!({"success": true})))
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
        .route("/banned-users", get(get_banned_users))
        .route("/banned-users/:username", delete(unban_user_handler))
        .with_state(state)
}
