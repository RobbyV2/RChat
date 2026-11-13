mod indexes;
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

pub use indexes::{Built, build_online};
pub(crate) use migrate::PINNED;
pub use migrate::{ConfigChange, ConfigStart, SCHEMA_VERSION, trigger_version};
#[cfg(test)]
pub(crate) use pool::open_started;
pub(crate) use pool::pool_key;
#[cfg(test)]
pub(crate) use pool::temp_db_path;
pub use pool::{
    Db, DbOptions, close, has_accounts, is_sqlite, open, open_with, opened_limits, reader,
    stored_schema_version, take_config_start, writer_connections,
};
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
    GRANT_TOUCH_SECS, GRANT_TOUCHES_MAX, flush_grant_touches, forget, queue_grant_touches,
    touch_interaction,
};

/// Placeholder for `server_passwords.hash`: extra passwords are checked through `lookup`
/// only, so no second verifier is kept.
pub const NO_EXTRA_HASH: &str = "!lookup";

/// How an avatar is drawn: `identicon` is a pattern generated from the username (on the
/// `avatar_color` background when one is set), `color` is a solid `avatar_color` circle.
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

/// The row of a new account. `username` is the lowercase name the account signs in with.
pub struct NewUser<'a> {
    pub username: &'a str,
    pub display_name: &'a str,
    pub password_hash: &'a str,
    pub password_kind: &'a str,
    pub avatar_kind: &'a str,
    pub avatar_color: Option<&'a str>,
    pub is_site_admin: bool,
    pub created_at: i64,
}

/// Inserts an account. Every account creation goes through here: it also stores the look-alike
/// keys of the username (`names::username_keys`) that display names are checked against. A test
/// (`accounts_are_only_inserted_with_their_keys`) fails on any other insert into `users`.
pub async fn insert_user<'e, E>(ex: E, user: NewUser<'_>) -> sqlx::Result<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let NewUser {
        username,
        display_name,
        password_hash,
        password_kind,
        avatar_kind,
        avatar_color,
        is_site_admin,
        created_at,
    } = user;
    let (key, alt) = crate::api::names::username_keys(username);
    sqlx::query(
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, avatar_color, is_site_admin, created_at, username_key, username_key_alt) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(username)
    .bind(display_name)
    .bind(password_hash)
    .bind(password_kind)
    .bind(avatar_kind)
    .bind(avatar_color)
    .bind(i64::from(is_site_admin))
    .bind(created_at)
    .bind(key)
    .bind(alt)
    .execute(ex)
    .await?;
    Ok(())
}

/// Accounts for tests, written the way every account is.
#[cfg(test)]
impl<'a> NewUser<'a> {
    /// `username` shown as itself, with no password and an identicon, created at 0.
    pub(crate) fn plain(username: &'a str) -> Self {
        Self {
            username,
            display_name: username,
            password_hash: "",
            password_kind: "text",
            avatar_kind: "identicon",
            avatar_color: None,
            is_site_admin: false,
            created_at: 0,
        }
    }

    pub(crate) fn shown(self, display_name: &'a str) -> Self {
        Self {
            display_name,
            ..self
        }
    }

    pub(crate) fn hash(self, password_hash: &'a str) -> Self {
        Self {
            password_hash,
            ..self
        }
    }

    pub(crate) fn kind(self, password_kind: &'a str) -> Self {
        Self {
            password_kind,
            ..self
        }
    }

    pub(crate) fn color(self, color: &'a str) -> Self {
        Self {
            avatar_kind: "color",
            avatar_color: Some(color),
            ..self
        }
    }

    pub(crate) fn admin(self, is_site_admin: bool) -> Self {
        Self {
            is_site_admin,
            ..self
        }
    }

    pub(crate) fn at(self, created_at: i64) -> Self {
        Self { created_at, ..self }
    }

    pub(crate) async fn add<'e, E>(self, ex: E)
    where
        E: sqlx::Executor<'e, Database = sqlx::Any>,
    {
        insert_user(ex, self).await.expect("user");
    }

    /// Adds the account with a recovery key, which the app sets through its own endpoint.
    pub(crate) async fn add_recoverable(self, db: &Db, key: Option<&str>, set_at: Option<i64>) {
        let username = self.username;
        self.add(db).await;
        sqlx::query("UPDATE users SET recovery_pub = $1, recovery_set_at = $2 WHERE username = $3")
            .bind(key)
            .bind(set_at)
            .bind(username)
            .execute(db)
            .await
            .expect("recovery key");
    }
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
