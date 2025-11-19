use crate::database::DbPool;
use crate::models::login_attempt::LoginAttempt;
use crate::models::user::{CreateUserRequest, PasswordType, User, UserResponse};
use crate::services::direct_message::get_or_create_dm;
use crate::services::word_sequence::get_word_sequence_for_username;
use crate::utils::crypto::{hash_password, verify_password};
use crate::utils::error::{AppError, AppResult};
use crate::utils::jwt::JwtService;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterResponse {
    pub user: UserResponse,
    pub token: String,
    pub word_sequence: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: Option<String>,
    pub word_sequence: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginResponse {
    pub user: UserResponse,
    pub token: String,
}

pub fn generate_word_sequence_for_username(username: &str) -> Vec<String> {
    get_word_sequence_for_username(username)
}

fn validate_password(password: &str) -> AppResult<()> {
    if password.is_empty() {
        return Err(AppError::Validation("Password cannot be empty".to_string()));
    }

    if password.len() > 128 {
        return Err(AppError::Validation(
            "Password must be at most 128 characters long".to_string(),
        ));
    }

    Ok(())
}

async fn validate_username(pool: &DbPool, username: &str) -> AppResult<()> {
    if username.is_empty() {
        return Err(AppError::Validation("Username cannot be empty".to_string()));
    }

    if username.len() > 64 {
        return Err(AppError::Validation(
            "Username must be at most 64 characters long".to_string(),
        ));
    }

    if crate::services::profanity::contains_profanity(username) {
        return Err(AppError::Validation(
            "Username contains inappropriate language".to_string(),
        ));
    }

    let is_banned = sqlx::query(
        "SELECT COUNT(*) as count FROM banned_usernames WHERE LOWER(username) = LOWER(?)",
    )
    .bind(username)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("count");

    if is_banned > 0 {
        return Err(AppError::BadRequest(
            "Username is permanently banned".to_string(),
        ));
    }

    Ok(())
}

pub async fn register_user(
    pool: &DbPool,
    request: CreateUserRequest,
    jwt_service: &JwtService,
) -> AppResult<RegisterResponse> {
    validate_username(pool, &request.username).await?;

    let total_users = sqlx::query("SELECT COUNT(*) as count FROM users WHERE username != 'system'")
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("count");

    let is_first_user = total_users == 0;

    let username_exists =
        sqlx::query("SELECT COUNT(*) as count FROM users WHERE LOWER(username) = LOWER(?)")
            .bind(&request.username)
            .fetch_one(pool.as_ref())
            .await?
            .get::<i64, _>("count");

    if username_exists > 0 {
        return Err(AppError::BadRequest("Username already exists".to_string()));
    }

    let (password_type, password_hash, word_sequence) =
        match (&request.password, &request.word_sequence) {
            (Some(password), None) => {
                validate_password(password)?;
                let hash = hash_password(password)?;
                (PasswordType::Text, hash, None)
            }
            (None, Some(words)) => {
                if words.len() != 7 {
                    return Err(AppError::Validation(
                        "Word sequence must contain exactly 7 words".to_string(),
                    ));
                }
                let password_str = words.join(" ");
                let hash = hash_password(&password_str)?;
                (PasswordType::WordSequence, hash, Some(words.clone()))
            }
            _ => {
                return Err(AppError::BadRequest(
                    "Must provide either password or word sequence".to_string(),
                ));
            }
        };

    let user = User::new(
        request.username.clone(),
        password_hash,
        password_type,
        word_sequence.clone(),
        request.profile_type,
        is_first_user,
    );

    sqlx::query(
        "INSERT INTO users (username, password_hash, password_type, word_sequence, profile_type, avatar_color, created_at, login_attempts, account_locked, is_admin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&user.username)
    .bind(&user.password_hash)
    .bind(&user.password_type)
    .bind(&user.word_sequence)
    .bind(&user.profile_type)
    .bind(&user.avatar_color)
    .bind(&user.created_at)
    .bind(user.login_attempts)
    .bind(user.account_locked)
    .bind(user.is_admin)
    .execute(pool.as_ref())
    .await?;

    crate::services::server::join_server(pool, "RChat".to_string(), user.username.clone())
        .await
        .map_err(|e| {
            tracing::error!(
                "Failed to auto-join user {} to RChat server: {}",
                user.username,
                e
            );
            e
        })?;

    // Auto-create self-DM
    if let Err(e) = get_or_create_dm(pool, user.username.clone(), user.username.clone()).await {
        tracing::warn!("Failed to create self-DM for user {}: {}", user.username, e);
    }

    let token = jwt_service.generate_token(&user.username)?;

    Ok(RegisterResponse {
        user: UserResponse::from(user),
        token,
        word_sequence,
    })
}

pub async fn login_user(
    pool: &DbPool,
    request: LoginRequest,
    ip_address: String,
    jwt_service: &JwtService,
) -> AppResult<LoginResponse> {
    let last_attempt = sqlx::query(
        "SELECT timestamp FROM login_attempts WHERE username = ? ORDER BY timestamp DESC LIMIT 1",
    )
    .bind(&request.username)
    .fetch_optional(pool.as_ref())
    .await?;

    if let Some(row) = last_attempt {
        let last_timestamp: String = row.get("timestamp");
        if let Ok(last_time) = chrono::DateTime::parse_from_rfc3339(&last_timestamp) {
            let elapsed = Utc::now().signed_duration_since(last_time.with_timezone(&Utc));
            if elapsed.num_seconds() < 3 {
                return Err(AppError::RateLimitExceeded);
            }
        }
    }

    let user_result =
        sqlx::query_as::<_, User>("SELECT * FROM users WHERE LOWER(username) = LOWER(?)")
            .bind(&request.username)
            .fetch_optional(pool.as_ref())
            .await?;

    let user = match user_result {
        Some(u) => u,
        None => {
            let attempt = LoginAttempt::new(
                request.username.clone(),
                ip_address,
                false,
                None,
                Some("User not found".to_string()),
            );
            save_login_attempt(pool, &attempt).await?;
            return Err(AppError::Auth("Invalid credentials".to_string()));
        }
    };

    if user.is_locked() {
        return Err(AppError::Auth(
            "Account is locked. Try again later.".to_string(),
        ));
    }

    let password_to_verify = match (&request.password, &request.word_sequence) {
        (Some(password), None) => password.clone(),
        (None, Some(words)) => words.join(" "),
        _ => {
            return Err(AppError::BadRequest(
                "Must provide either password or word sequence".to_string(),
            ));
        }
    };

    let is_valid = verify_password(&password_to_verify, &user.password_hash)?;

    if !is_valid {
        let new_attempts = user.login_attempts + 1;
        let (locked, lock_until) = if new_attempts >= 1000 {
            let lock_time = Utc::now() + Duration::hours(24);
            (1, Some(lock_time.to_rfc3339()))
        } else {
            (0, None)
        };

        sqlx::query(
            "UPDATE users SET login_attempts = ?, account_locked = ?, lock_until = ? WHERE username = ?",
        )
        .bind(new_attempts)
        .bind(locked)
        .bind(&lock_until)
        .bind(&user.username)
        .execute(pool.as_ref())
        .await?;

        let attempt = LoginAttempt::new(
            request.username.clone(),
            ip_address,
            false,
            Some(user.username.clone()),
            Some("Invalid password".to_string()),
        );
        save_login_attempt(pool, &attempt).await?;

        return Err(AppError::Auth("Invalid credentials".to_string()));
    }

    sqlx::query("UPDATE users SET login_attempts = 0, account_locked = 0, lock_until = NULL, last_login = ? WHERE username = ?")
        .bind(Utc::now().to_rfc3339())
        .bind(&user.username)
        .execute(pool.as_ref())
        .await?;

    let attempt = LoginAttempt::new(
        request.username.clone(),
        ip_address,
        true,
        Some(user.username.clone()),
        None,
    );
    save_login_attempt(pool, &attempt).await?;

    // Ensure user is in RChat server (safety net)
    if let Err(e) =
        crate::services::server::join_server(pool, "RChat".to_string(), user.username.clone()).await
    {
        tracing::warn!(
            "Failed to ensure RChat membership for {}: {}",
            user.username,
            e
        );
    }

    let token = jwt_service.generate_token(&user.username)?;

    Ok(LoginResponse {
        user: UserResponse::from(user),
        token,
    })
}

async fn save_login_attempt(pool: &DbPool, attempt: &LoginAttempt) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO login_attempts (id, username, ip_address, success, timestamp, attempted_username, failure_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&attempt.id)
    .bind(&attempt.username)
    .bind(&attempt.ip_address)
    .bind(attempt.success)
    .bind(&attempt.timestamp)
    .bind(&attempt.attempted_username)
    .bind(&attempt.failure_reason)
    .execute(pool.as_ref())
    .await?;

    Ok(())
}
