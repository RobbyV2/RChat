use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;

use crate::database::DbPool;
use crate::models::user::{CreateUserRequest, ProfileType};
use crate::services::auth::{
    LoginRequest, generate_word_sequence_for_username, login_user, register_user,
};
use crate::utils::error::AppResult;
use crate::utils::jwt::JwtService;
use crate::websocket::connection::ConnectionManager;
use crate::websocket::events::ServerMessage;
use sqlx::Row;

pub struct AppState {
    pub db: DbPool,
    pub jwt_service: Arc<JwtService>,
    pub ws_manager: Arc<ConnectionManager>,
}

async fn health_check() -> &'static str {
    "OK"
}

use axum::extract::Query;

#[derive(Deserialize)]
struct WordSequenceQuery {
    username: String,
}

async fn get_word_sequence(Query(query): Query<WordSequenceQuery>) -> Json<Vec<String>> {
    Json(generate_word_sequence_for_username(&query.username))
}

#[derive(Deserialize)]
struct RegisterRequestPayload {
    username: String,
    password: Option<String>,
    word_sequence: Option<Vec<String>>,
    profile_type: String,
    avatar_color: Option<String>,
}

async fn register(
    State(state): State<Arc<AppState>>,
    ConnectInfo(_addr): ConnectInfo<SocketAddr>,
    Json(payload): Json<RegisterRequestPayload>,
) -> AppResult<Json<serde_json::Value>> {
    let profile_type = match payload.profile_type.as_str() {
        "identicon" => {
            let data = crate::services::avatar::generate_identicon_data(&payload.username);
            ProfileType::Identicon(data)
        }
        "person" => {
            let color = payload.avatar_color.unwrap_or_else(|| {
                let hash = crate::services::avatar::generate_identicon_data(&payload.username);
                crate::services::avatar::get_random_color_from_hash(&hash)
            });
            ProfileType::Person(color)
        }
        _ => {
            return Err(crate::utils::error::AppError::BadRequest(
                "Invalid profile type".to_string(),
            ));
        }
    };

    let request = CreateUserRequest {
        username: payload.username,
        password: payload.password,
        word_sequence: payload.word_sequence,
        profile_type,
    };

    let response = register_user(&state.db, request, &state.jwt_service).await?;

    // Broadcast member joined event for RChat
    state
        .ws_manager
        .broadcast(ServerMessage::ServerMemberJoined {
            server_name: "RChat".to_string(),
            username: response.user.username.clone(),
        })
        .await;

    // Broadcast stats update for RChat
    if let Ok(stats) =
        sqlx::query("SELECT member_count, channel_count FROM servers WHERE name = 'RChat'")
            .fetch_one(state.db.as_ref())
            .await
    {
        let member_count = stats.get("member_count");
        let channel_count = stats.get("channel_count");

        state
            .ws_manager
            .broadcast(ServerMessage::ServerStatsUpdated {
                server_name: "RChat".to_string(),
                member_count,
                channel_count,
            })
            .await;
    }

    Ok(Json(serde_json::to_value(response).unwrap()))
}

async fn login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(payload): Json<LoginRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let ip = addr.ip().to_string();
    let response = login_user(&state.db, payload, ip, &state.jwt_service).await?;
    Ok(Json(serde_json::to_value(response).unwrap()))
}

async fn logout() -> StatusCode {
    StatusCode::OK
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/word-sequence", get(get_word_sequence))
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .with_state(state)
}
