mod migrate;
mod pool;
mod schema;
mod secrets;
mod sweep;
mod touch;

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

#[cfg(test)]
pub(crate) use migrate::seed_settings;
pub use migrate::{SCHEMA_VERSION, trigger_version};
pub(crate) use pool::pool_key;
#[cfg(test)]
pub(crate) use pool::temp_db_path;
pub use pool::{Db, DbOptions, close, is_sqlite, open, open_with, reader, writer_connections};
pub use schema::has_fts;
#[cfg(test)]
pub(crate) use schema::set_fts;
pub use secrets::{pepper, secret_key};
#[cfg(test)]
pub(crate) use sweep::KEPT_USERS_SQL;
pub use sweep::{
    AUDIT_KEEP, PING_KEEP, PINGS_KEPT, PURGE_BATCH, SERVER_PASSWORD_KEEP, Swept, TIMEOUT_KEEP,
    purge_messages, sweep_stale,
};
#[cfg(test)]
pub(crate) use touch::grant_touch_queued;
pub use touch::{
    GRANT_TOUCH_SECS, GRANT_TOUCHES_MAX, flush_grant_touches, queue_grant_touches,
    touch_interaction,
};

/// Placeholder for `server_passwords.hash`: extra passwords are checked through `lookup`
/// only, so no second verifier is kept.
pub const NO_EXTRA_HASH: &str = "!lookup";

/// How an avatar is drawn: `identicon` is a pattern generated from the username, `color` is a
/// solid `avatar_color` circle.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AvatarKind {
    Identicon,
    Color,
}

impl AvatarKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AvatarKind::Identicon => "identicon",
            AvatarKind::Color => "color",
        }
    }

    pub fn parse(s: &str) -> sqlx::Result<AvatarKind> {
        match s {
            "identicon" => Ok(AvatarKind::Identicon),
            "color" => Ok(AvatarKind::Color),
            other => Err(sqlx::Error::Decode(
                format!("invalid avatar_kind: {other}").into(),
            )),
        }
    }
}

/// `text` channels hold messages; `voice` channels hold voice and video calls.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    Text,
    Voice,
}

impl ChannelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelKind::Text => "text",
            ChannelKind::Voice => "voice",
        }
    }

    pub fn parse(s: &str) -> sqlx::Result<ChannelKind> {
        match s {
            "text" => Ok(ChannelKind::Text),
            "voice" => Ok(ChannelKind::Voice),
            other => Err(sqlx::Error::Decode(
                format!("invalid channel kind: {other}").into(),
            )),
        }
    }
}

/// `server`: uploaded through `POST /api/v1/media` and stored by the instance. `p2p`: kept in the
/// sender's browser and shared peer to peer while they are online; the server stores only the
/// metadata.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Server,
    P2p,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Server => "server",
            MediaKind::P2p => "p2p",
        }
    }

    pub fn parse(s: &str) -> sqlx::Result<MediaKind> {
        match s {
            "server" => Ok(MediaKind::Server),
            "p2p" => Ok(MediaKind::P2p),
            other => Err(sqlx::Error::Decode(
                format!("invalid media kind: {other}").into(),
            )),
        }
    }
}

#[derive(Clone)]
pub struct User {
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub password_kind: String,
    pub avatar_kind: AvatarKind,
    pub avatar_color: Option<String>,
    pub banner_color: Option<String>,
    pub bio: Option<String>,
    pub is_site_admin: bool,
    pub appear_offline: bool,
    pub created_at: i64,
    pub recovery_pub: Option<String>,
    pub recovery_set_at: Option<i64>,
}

impl User {
    pub fn from_row(row: &AnyRow) -> sqlx::Result<User> {
        Ok(User {
            username: row.try_get("username")?,
            display_name: row.try_get("display_name")?,
            password_hash: row.try_get("password_hash")?,
            password_kind: row.try_get("password_kind")?,
            avatar_kind: AvatarKind::parse(&row.try_get::<String, _>("avatar_kind")?)?,
            avatar_color: row.try_get("avatar_color")?,
            banner_color: row.try_get("banner_color")?,
            bio: row.try_get("bio")?,
            is_site_admin: row.try_get::<i64, _>("is_site_admin")? != 0,
            appear_offline: row.try_get::<i64, _>("appear_offline")? != 0,
            created_at: row.try_get("created_at")?,
            recovery_pub: row.try_get("recovery_pub")?,
            recovery_set_at: row.try_get("recovery_set_at")?,
        })
    }
}

pub const PURGING_HASH: &str = "!purging";

pub const NO_PERMANENT_HASH: &str = "!none";

pub const LIVE_DM: &str = "NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username IN (user_a, user_b) AND pu.password_hash = '!purging')";

pub const LIVE_AUTHOR: &str = "NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username = m.author AND pu.password_hash = '!purging')";

pub async fn get_user<'e, E>(ex: E, username: &str) -> sqlx::Result<Option<User>>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    sqlx::query("SELECT * FROM users WHERE username = $1 AND password_hash <> '!purging'")
        .bind(username.to_lowercase())
        .fetch_optional(ex)
        .await?
        .as_ref()
        .map(User::from_row)
        .transpose()
}

pub async fn user_row<'e, E>(ex: E, username: &str) -> sqlx::Result<Option<User>>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    sqlx::query("SELECT * FROM users WHERE username = $1")
        .bind(username.to_lowercase())
        .fetch_optional(ex)
        .await?
        .as_ref()
        .map(User::from_row)
        .transpose()
}

pub async fn setting_on<'e, E>(ex: E, key: &str) -> sqlx::Result<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row = sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(ex)
        .await?;
    Ok(match row {
        Some(row) => row.try_get::<String, _>(0)? == "1",
        None => true,
    })
}

/// Locks the row of `server` until the transaction ends (on Postgres; SQLite has one writer).
/// A transaction that locks a server row takes this lock before it writes anything else, so
/// joins, leaves and system messages of one server queue instead of deadlocking.
pub async fn lock_server(conn: &mut AnyConnection, server: &str) -> sqlx::Result<()> {
    if conn.backend_name() == "PostgreSQL" {
        sqlx::query("SELECT 1 FROM servers WHERE name = $1 FOR NO KEY UPDATE")
            .bind(server)
            .fetch_optional(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Moves `servers.member_count` by `delta`, in the transaction that added or removed that many
/// member rows of `server`, after its `lock_server`.
pub async fn shift_member_count(
    conn: &mut AnyConnection,
    server: &str,
    delta: i64,
) -> sqlx::Result<()> {
    if delta != 0 {
        sqlx::query("UPDATE servers SET member_count = member_count + $1 WHERE name = $2")
            .bind(delta)
            .bind(server)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Sets `servers.member_count` from the member rows, counting under the server lock, for changes
/// that span servers without their locks (hiding an account) and for the sweep.
pub async fn recount_members(db: &Db, server: &str) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    lock_server(&mut tx, server).await?;
    sqlx::query("UPDATE servers SET member_count = (SELECT COUNT(*) FROM members m WHERE m.server = $1) WHERE name = $1")
        .bind(server)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
