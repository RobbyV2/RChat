use crate::database::DbPool;
use crate::models::server::Server;
use crate::models::server_member::{ServerMember, ServerRole};
use crate::services::channel::create_channel;
use crate::utils::error::{AppError, AppResult};
use crate::utils::validation::validate_server_name;
use sqlx::Row;

pub async fn create_server(
    pool: &DbPool,
    name: String,
    creator_username: String,
) -> AppResult<Server> {
    validate_server_name(&name)?;

    let exists = sqlx::query("SELECT COUNT(*) as count FROM servers WHERE name = ?")
        .bind(&name)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("count");

    if exists > 0 {
        return Err(AppError::BadRequest(
            "Server name already exists".to_string(),
        ));
    }

    let server = Server::new(name, creator_username.clone());

    sqlx::query(
        "INSERT INTO servers (name, creator_username, created_at, is_active, member_count, channel_count)
         VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(&server.name)
    .bind(&server.creator_username)
    .bind(&server.created_at)
    .bind(server.is_active)
    .bind(1)
    .bind(0)
    .execute(pool.as_ref())
    .await?;

    let member = ServerMember::new(server.name.clone(), creator_username, ServerRole::Admin);

    sqlx::query(
        "INSERT INTO server_members (server_name, username, role, joined_at, last_seen, is_online)
         VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(is_online) FROM server_members WHERE username = ?), 0))",
    )
    .bind(&member.server_name)
    .bind(&member.username)
    .bind(&member.role)
    .bind(&member.joined_at)
    .bind(&member.last_seen)
    .bind(&member.username)
    .execute(pool.as_ref())
    .await?;

    create_channel(pool, server.name.clone(), "general".to_string()).await?;

    Ok(server)
}

pub async fn join_server(
    pool: &DbPool,
    server_name: String,
    username: String,
) -> AppResult<Server> {
    let server = sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE LOWER(name) = LOWER(?)")
        .bind(&server_name)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Server not found".to_string()))?;

    // Check if user is banned from this server
    let is_banned = sqlx::query(
        "SELECT COUNT(*) as count FROM server_bans WHERE server_name = ? AND username = ?",
    )
    .bind(&server.name)
    .bind(&username)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("count");

    if is_banned > 0 {
        return Err(AppError::Forbidden(
            "You are banned from this server".to_string(),
        ));
    }

    let member_exists = sqlx::query(
        "SELECT COUNT(*) as count FROM server_members WHERE server_name = ? AND username = ?",
    )
    .bind(&server.name)
    .bind(&username)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("count");

    if member_exists > 0 {
        return Ok(server);
    }

    let member = ServerMember::new(server.name.clone(), username, ServerRole::Member);

    sqlx::query(
        "INSERT INTO server_members (server_name, username, role, joined_at, last_seen, is_online)
         VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(is_online) FROM server_members WHERE username = ?), 0))",
    )
    .bind(&member.server_name)
    .bind(&member.username)
    .bind(&member.role)
    .bind(&member.joined_at)
    .bind(&member.last_seen)
    .bind(&member.username)
    .execute(pool.as_ref())
    .await?;

    // Trigger handles member_count update

    Ok(server)
}

pub async fn get_user_servers(pool: &DbPool, username: &str) -> AppResult<Vec<Server>> {
    let servers = sqlx::query_as::<_, Server>(
        "SELECT
            s.name,
            s.creator_username,
            s.created_at,
            s.is_active,
            (SELECT COUNT(*) FROM server_members WHERE server_name = s.name) as member_count,
            (SELECT COUNT(*) FROM channels WHERE server_name = s.name) as channel_count
         FROM servers s
         JOIN server_members sm ON s.name = sm.server_name
         WHERE sm.username = ? AND s.is_active = 1
         ORDER BY sm.position ASC, s.created_at DESC",
    )
    .bind(username)
    .fetch_all(pool.as_ref())
    .await?;

    Ok(servers)
}

pub async fn get_server_members(pool: &DbPool, server_name: &str) -> AppResult<Vec<ServerMember>> {
    let members = sqlx::query_as::<_, ServerMember>(
        "SELECT sm.*, u.profile_type, u.avatar_color 
         FROM server_members sm
         JOIN users u ON sm.username = u.username
         WHERE sm.server_name = ? 
         ORDER BY sm.joined_at",
    )
    .bind(server_name)
    .fetch_all(pool.as_ref())
    .await?;

    Ok(members)
}

pub async fn remove_member(
    pool: &DbPool,
    server_name: &str,
    username: &str,
    requester_username: &str,
) -> AppResult<()> {
    if server_name == "RChat" {
        return Err(AppError::BadRequest(
            "Cannot leave the RChat server - all users must remain in RChat".to_string(),
        ));
    }

    let is_self_removal = username == requester_username;

    if !is_self_removal {
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
                    "Admin privileges required to remove other members".to_string(),
                ));
            }
        }
    }

    let server = sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE name = ?")
        .bind(server_name)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Server not found".to_string()))?;

    if server.creator_username == username {
        return Err(AppError::BadRequest(
            "Cannot remove server creator".to_string(),
        ));
    }

    sqlx::query("DELETE FROM server_members WHERE server_name = ? AND username = ?")
        .bind(server_name)
        .bind(username)
        .execute(pool.as_ref())
        .await?;

    // Trigger handles member_count update

    Ok(())
}

pub async fn update_member_role(
    pool: &DbPool,
    server_name: &str,
    username: &str,
    new_role: &str,
    requester_username: &str,
) -> AppResult<()> {
    if new_role != "member" && new_role != "admin" {
        return Err(AppError::BadRequest("Invalid role".to_string()));
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
                "Admin privileges required".to_string(),
            ));
        }
    }

    let server = sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE name = ?")
        .bind(server_name)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Server not found".to_string()))?;

    if server.creator_username == username {
        return Err(AppError::BadRequest(
            "Cannot modify creator role".to_string(),
        ));
    }

    sqlx::query("UPDATE server_members SET role = ? WHERE server_name = ? AND username = ?")
        .bind(new_role)
        .bind(server_name)
        .bind(username)
        .execute(pool.as_ref())
        .await?;

    Ok(())
}

pub async fn delete_server(
    pool: &DbPool,
    server_name: &str,
    requester_username: &str,
) -> AppResult<()> {
    if server_name == "RChat" {
        return Err(AppError::BadRequest(
            "Cannot delete the RChat server".to_string(),
        ));
    }

    let server = sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE name = ?")
        .bind(server_name)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Server not found".to_string()))?;

    let is_site_admin = sqlx::query("SELECT is_admin FROM users WHERE username = ?")
        .bind(requester_username)
        .fetch_one(pool.as_ref())
        .await?
        .get::<i64, _>("is_admin");

    if is_site_admin == 0 && server.creator_username != requester_username {
        return Err(AppError::Unauthorized(
            "Only server creator or site admin can delete server".to_string(),
        ));
    }

    // Hard delete server - Cascades to channels, messages, members, bans
    sqlx::query("DELETE FROM servers WHERE name = ?")
        .bind(server_name)
        .execute(pool.as_ref())
        .await?;

    Ok(())
}

pub async fn sync_server_counts(pool: &DbPool) -> AppResult<()> {
    // Recalculate member_count for all servers
    sqlx::query(
        "UPDATE servers 
         SET member_count = (
             SELECT COUNT(*) 
             FROM server_members 
             WHERE server_members.server_name = servers.name
         )",
    )
    .execute(pool.as_ref())
    .await?;

    // Recalculate channel_count for all servers
    sqlx::query(
        "UPDATE servers 
         SET channel_count = (
             SELECT COUNT(*) 
             FROM channels 
             WHERE channels.server_name = servers.name AND channels.is_active = 1
         )",
    )
    .execute(pool.as_ref())
    .await?;

    tracing::info!("Server counts synced successfully");
    Ok(())
}

pub async fn reorder_servers(
    pool: &DbPool,
    username: &str,
    server_names: Vec<String>,
) -> AppResult<()> {
    for (index, server_name) in server_names.iter().enumerate() {
        sqlx::query(
            "UPDATE server_members SET position = ? WHERE username = ? AND server_name = ?",
        )
        .bind(index as i64)
        .bind(username)
        .bind(server_name)
        .execute(pool.as_ref())
        .await?;
    }
    Ok(())
}

pub async fn transfer_ownership(
    pool: &DbPool,
    server_name: &str,
    new_owner_username: &str,
    requester_username: &str,
) -> AppResult<()> {
    let server = sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE name = ?")
        .bind(server_name)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Server not found".to_string()))?;

    if server.creator_username != requester_username {
        return Err(AppError::Unauthorized(
            "Only the server creator can transfer ownership".to_string(),
        ));
    }

    if new_owner_username == requester_username {
        return Err(AppError::BadRequest(
            "Cannot transfer ownership to yourself".to_string(),
        ));
    }

    let new_owner_member = sqlx::query(
        "SELECT COUNT(*) as count FROM server_members WHERE server_name = ? AND username = ?",
    )
    .bind(server_name)
    .bind(new_owner_username)
    .fetch_one(pool.as_ref())
    .await?
    .get::<i64, _>("count");

    if new_owner_member == 0 {
        return Err(AppError::BadRequest(
            "New owner must be a member of the server".to_string(),
        ));
    }

    // 1. Update server creator
    sqlx::query("UPDATE servers SET creator_username = ? WHERE name = ?")
        .bind(new_owner_username)
        .bind(server_name)
        .execute(pool.as_ref())
        .await?;

    // 2. Promote new owner to admin
    sqlx::query("UPDATE server_members SET role = 'admin' WHERE server_name = ? AND username = ?")
        .bind(server_name)
        .bind(new_owner_username)
        .execute(pool.as_ref())
        .await?;

    // 3. Demote old owner to member
    sqlx::query("UPDATE server_members SET role = 'member' WHERE server_name = ? AND username = ?")
        .bind(server_name)
        .bind(requester_username)
        .execute(pool.as_ref())
        .await?;

    Ok(())
}
