use axum::{
    extract::{Request, State},
    http::header,
    middleware::Next,
    response::Response,
};
use sqlx::Row;
use std::sync::Arc;

use crate::api::AppState;
use crate::utils::error::AppError;

pub const AUTH_USERNAME_HEADER: &str = "x-username";

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    let token = auth_header
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Auth("Missing or invalid authorization header".to_string()))?;

    let username = state
        .jwt_service
        .extract_username(token)
        .map_err(|e| AppError::Auth(format!("Invalid token: {}", e)))?;

    // Check if user still exists (not banned)
    let user_exists = sqlx::query("SELECT COUNT(*) as count FROM users WHERE username = ?")
        .bind(&username)
        .fetch_one(state.db.as_ref())
        .await
        .map_err(|_| AppError::Internal("Database error during auth check".to_string()))?
        .get::<i64, _>("count");

    if user_exists == 0 {
        return Err(AppError::Auth("User no longer exists".to_string()));
    }

    request.headers_mut().insert(
        AUTH_USERNAME_HEADER,
        username
            .parse()
            .map_err(|_| AppError::Internal("Failed to set username header".to_string()))?,
    );

    Ok(next.run(request).await)
}
