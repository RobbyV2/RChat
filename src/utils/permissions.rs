use crate::{database::DbPool, utils::error::AppError};
use anyhow::Result;
use sqlx::Row;

pub async fn check_site_admin(pool: &DbPool, username: &str) -> Result<bool, AppError> {
    let is_admin = sqlx::query("SELECT is_admin FROM users WHERE username = ?")
        .bind(username)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("is_admin");

    Ok(is_admin == 1)
}

pub async fn check_server_admin(
    pool: &DbPool,
    username: &str,
    server_name: &str,
) -> Result<bool, AppError> {
    let count = sqlx::query(
        "SELECT COUNT(*) as count FROM server_members
         WHERE server_name = ? AND username = ? AND role = 'admin'",
    )
    .bind(server_name)
    .bind(username)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("count");

    Ok(count > 0)
}

pub async fn check_channel_admin(
    pool: &DbPool,
    username: &str,
    channel_id: &str,
) -> Result<bool, AppError> {
    let count = sqlx::query(
        "SELECT COUNT(*) as count FROM server_members sm
         JOIN channels c ON sm.server_name = c.server_name
         WHERE c.id = ? AND sm.username = ? AND sm.role = 'admin'",
    )
    .bind(channel_id)
    .bind(username)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("count");

    Ok(count > 0)
}

pub async fn require_admin(
    pool: &DbPool,
    username: &str,
    server_name: Option<&str>,
    channel_id: Option<&str>,
) -> Result<(), AppError> {
    let is_site_admin = check_site_admin(pool, username).await?;
    if is_site_admin {
        return Ok(());
    }

    match (server_name, channel_id) {
        (Some(server), _) => {
            let is_server_admin = check_server_admin(pool, username, server).await?;
            if !is_server_admin {
                return Err(AppError::Unauthorized(
                    "Server admin privileges required".to_string(),
                ));
            }
        }
        (None, Some(channel)) => {
            let is_channel_admin = check_channel_admin(pool, username, channel).await?;
            if !is_channel_admin {
                return Err(AppError::Unauthorized(
                    "Channel admin privileges required".to_string(),
                ));
            }
        }
        (None, None) => {
            return Err(AppError::Unauthorized(
                "Site admin privileges required".to_string(),
            ));
        }
    }

    Ok(())
}
