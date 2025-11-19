use crate::database::DbPool;
use crate::models::channel::Channel;
use crate::models::server::Server;
use crate::models::user::User;
use crate::utils::crypto::hash_password;
use crate::utils::error::AppResult;
use sqlx::Row;

const DEFAULT_SERVER_NAME: &str = "RChat";
const DEFAULT_CHANNEL_NAME: &str = "general";
const SYSTEM_USERNAME: &str = "system";

async fn ensure_internal_user(pool: &DbPool, username: &str, is_admin: bool) -> AppResult<()> {
    let exists = sqlx::query("SELECT COUNT(*) as count FROM users WHERE username = ?")
        .bind(username)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("count");

    if exists == 0 {
        let password_hash = hash_password(&format!("{}-internal-only", username))?;
        let user = User {
            username: username.to_string(),
            password_hash,
            password_type: "text".to_string(),
            word_sequence: None,
            profile_type: "identicon".to_string(),
            avatar_color: Some("#808080".to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_login: None,
            login_attempts: 0,
            account_locked: 0,
            lock_until: None,
            is_admin: if is_admin { 1 } else { 0 },
        };

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

        tracing::info!("Created {} user (admin: {})", username, is_admin);
    }

    Ok(())
}

async fn ensure_system_user(pool: &DbPool) -> AppResult<()> {
    ensure_internal_user(pool, SYSTEM_USERNAME, false).await
}

pub async fn ensure_default_server(pool: &DbPool) -> AppResult<(String, String)> {
    ensure_system_user(pool).await?;

    if let Ok(admin_user) = std::env::var("ADMIN_USERNAME") {
        ensure_internal_user(pool, &admin_user, true).await?;

        let member_exists = sqlx::query(
            "SELECT COUNT(*) as count FROM server_members WHERE server_name = ? AND username = ?",
        )
        .bind(DEFAULT_SERVER_NAME)
        .bind(&admin_user)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("count");

        if member_exists == 0
            && let Err(e) = crate::services::server::join_server(
                pool,
                DEFAULT_SERVER_NAME.to_string(),
                admin_user.clone(),
            )
            .await
        {
            tracing::warn!("Failed to auto-join admin user to RChat: {}", e);
        }
    }

    let server_exists = sqlx::query("SELECT COUNT(*) as count FROM servers WHERE name = ?")
        .bind(DEFAULT_SERVER_NAME)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("count");

    let server_name = if server_exists == 0 {
        let server = Server::new(DEFAULT_SERVER_NAME.to_string(), SYSTEM_USERNAME.to_string());

        sqlx::query(
            "INSERT INTO servers (name, creator_username, created_at, is_active, member_count, channel_count)
             VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(&server.name)
        .bind(&server.creator_username)
        .bind(&server.created_at)
        .bind(server.is_active)
        .bind(server.member_count)
        .bind(server.channel_count)
        .execute(pool.as_ref())
        .await?;

        server.name
    } else {
        DEFAULT_SERVER_NAME.to_string()
    };

    let channel_result = sqlx::query("SELECT id FROM channels WHERE server_name = ? AND name = ?")
        .bind(&server_name)
        .bind(DEFAULT_CHANNEL_NAME)
        .fetch_optional(pool.as_ref())
        .await?;

    let channel_id = if let Some(row) = channel_result {
        row.get::<String, _>("id")
    } else {
        let channel = Channel::new(server_name.clone(), DEFAULT_CHANNEL_NAME.to_string(), 0);

        sqlx::query(
            "INSERT INTO channels (id, server_name, name, created_at, is_active, message_count, position)
             VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&channel.id)
        .bind(&channel.server_name)
        .bind(&channel.name)
        .bind(&channel.created_at)
        .bind(channel.is_active)
        .bind(channel.message_count)
        .bind(channel.position)
        .execute(pool.as_ref())
        .await?;

        channel.id
    };

    Ok((server_name, channel_id))
}
