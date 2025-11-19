use crate::database::DbPool;
use crate::models::server::Server;
use crate::models::server_member::ServerMember;
use crate::utils::error::{AppError, AppResult};
use sqlx::Row;

pub async fn site_ban_user(
    pool: &DbPool,
    target_username: &str,
    requester_username: &str,
) -> AppResult<()> {
    let requester_is_admin =
        sqlx::query("SELECT is_admin FROM users WHERE LOWER(username) = LOWER(?)")
            .bind(requester_username)
            .fetch_optional(pool.as_ref())
            .await?
            .and_then(|row| row.try_get::<i64, _>("is_admin").ok())
            .unwrap_or(0);

    if requester_is_admin == 0 {
        return Err(AppError::Forbidden(
            "Only site admins can site-ban users".to_string(),
        ));
    }

    let user_exists =
        sqlx::query("SELECT COUNT(*) as count FROM users WHERE LOWER(username) = LOWER(?)")
            .bind(target_username)
            .fetch_one(pool.as_ref())
            .await?
            .get::<i64, _>("count");

    if user_exists == 0 {
        return Err(AppError::NotFound("User not found".to_string()));
    }

    if target_username.eq_ignore_ascii_case(requester_username) {
        return Err(AppError::BadRequest("Cannot ban yourself".to_string()));
    }

    sqlx::query("INSERT INTO banned_usernames (username, banned_by, reason) VALUES (?, ?, ?)")
        .bind(target_username)
        .bind(requester_username)
        .bind("Site ban")
        .execute(pool.as_ref())
        .await?;

    sqlx::query("DELETE FROM messages WHERE LOWER(sender_username) = LOWER(?)")
        .bind(target_username)
        .execute(pool.as_ref())
        .await?;

    sqlx::query("DELETE FROM server_members WHERE LOWER(username) = LOWER(?)")
        .bind(target_username)
        .execute(pool.as_ref())
        .await?;

    sqlx::query(
        "DELETE FROM direct_messages WHERE LOWER(username1) = LOWER(?) OR LOWER(username2) = LOWER(?)",
    )
    .bind(target_username)
    .bind(target_username)
    .execute(pool.as_ref())
    .await?;

    sqlx::query("DELETE FROM files WHERE LOWER(uploader_username) = LOWER(?)")
        .bind(target_username)
        .execute(pool.as_ref())
        .await?;

    sqlx::query("DELETE FROM users WHERE LOWER(username) = LOWER(?)")
        .bind(target_username)
        .execute(pool.as_ref())
        .await?;

    Ok(())
}

pub async fn server_ban_user(
    pool: &DbPool,
    server_name: &str,
    target_username: &str,
    requester_username: &str,
    reason: Option<String>,
) -> AppResult<()> {
    if server_name == "RChat" {
        return Err(AppError::BadRequest(
            "Cannot ban users from RChat server".to_string(),
        ));
    }

    let server = sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE name = ?")
        .bind(server_name)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Server not found".to_string()))?;

    if server.creator_username == target_username {
        return Err(AppError::BadRequest("Cannot ban server owner".to_string()));
    }

    let is_site_admin = sqlx::query("SELECT is_admin FROM users WHERE username = ?")
        .bind(requester_username)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("is_admin");

    if is_site_admin == 0 {
        let requester_member = sqlx::query_as::<_, ServerMember>(
            "SELECT * FROM server_members WHERE server_name = ? AND username = ?",
        )
        .bind(server_name)
        .bind(requester_username)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::Unauthorized("Not a member of this server".to_string()))?;

        if requester_member.role != "admin" {
            return Err(AppError::Unauthorized(
                "Server admin privileges required".to_string(),
            ));
        }
    }

    // Check if already banned
    let banned = sqlx::query(
        "SELECT COUNT(*) as count FROM server_bans WHERE server_name = ? AND username = ?",
    )
    .bind(server_name)
    .bind(target_username)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("count");

    if banned > 0 {
        return Err(AppError::BadRequest("User is already banned".to_string()));
    }

    sqlx::query(
        "INSERT INTO server_bans (server_name, username, banned_by, reason, banned_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .bind(server_name)
    .bind(target_username)
    .bind(requester_username)
    .bind(reason)
    .execute(pool.as_ref())
    .await?;

    sqlx::query("DELETE FROM server_members WHERE server_name = ? AND username = ?")
        .bind(server_name)
        .bind(target_username)
        .execute(pool.as_ref())
        .await?;

    Ok(())
}
