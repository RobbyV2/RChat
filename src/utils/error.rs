use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("Authorization error: {0}")]
    Unauthorized(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Internal server error: {0}")]
    Internal(String),

    #[error("Rate limit exceeded")]
    RateLimitExceeded,

    #[error("File error: {0}")]
    File(String),

    #[error("Validation error: {0}")]
    Validation(String),
}

#[derive(Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
    pub message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_type, message) = match self {
            AppError::Database(ref e) => {
                tracing::error!("Database error: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "database_error",
                    self.to_string(),
                )
            }
            AppError::Auth(ref msg) => {
                tracing::debug!("Auth error: {}", msg);
                (StatusCode::UNAUTHORIZED, "auth_error", msg.clone())
            }
            AppError::Unauthorized(ref msg) => {
                tracing::debug!("Unauthorized: {}", msg);
                (StatusCode::UNAUTHORIZED, "unauthorized", msg.clone())
            }
            AppError::Forbidden(ref msg) => {
                tracing::debug!("Forbidden: {}", msg);
                (StatusCode::FORBIDDEN, "forbidden", msg.clone())
            }
            AppError::NotFound(ref msg) => {
                tracing::debug!("Not found: {}", msg);
                (StatusCode::NOT_FOUND, "not_found", msg.clone())
            }
            AppError::BadRequest(ref msg) => {
                tracing::debug!("Bad request: {}", msg);
                (StatusCode::BAD_REQUEST, "bad_request", msg.clone())
            }
            AppError::Internal(ref msg) => {
                tracing::error!("Internal error: {}", msg);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    msg.clone(),
                )
            }
            AppError::RateLimitExceeded => {
                tracing::debug!("Rate limit exceeded");
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limit_exceeded",
                    "Too many requests, please try again later".to_string(),
                )
            }
            AppError::File(ref msg) => {
                tracing::debug!("File error: {}", msg);
                (StatusCode::BAD_REQUEST, "file_error", msg.clone())
            }
            AppError::Validation(ref msg) => {
                (StatusCode::BAD_REQUEST, "validation_error", msg.clone())
            }
        };

        let body = Json(ErrorResponse {
            error: error_type.to_string(),
            message,
        });

        (status, body).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
