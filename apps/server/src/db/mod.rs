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
pub use pool::{Db, close, is_sqlite, open, reader, writer_connections};
pub use schema::has_fts;
#[cfg(test)]
pub(crate) use schema::set_fts;
pub use secrets::{env_secret, pepper, secret_key};
#[cfg(test)]
pub(crate) use sweep::KEPT_USERS_SQL;
pub use sweep::{
    AUDIT_KEEP, PING_KEEP, PINGS_KEPT, PURGE_BATCH, SERVER_PASSWORD_KEEP, Swept, TIMEOUT_KEEP,
    guest_grant_ttl, purge_messages, sweep_stale,
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

/// `server`: uploaded through `POST /api/media` and stored by the instance. `p2p`: kept in the
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Perm {
    ManageChannels = 1,
    DeleteMessages = 2,
    Kick = 4,
    DeleteServer = 8,
    ManageAdmins = 16,
    MentionEveryone = 32,
    ViewAuditLog = 64,
    TimeoutMembers = 128,
    ManageWebhooks = 256,
}

pub const ALL_PERMS: i64 = 511;

pub fn perm_bits(is_admin: bool, perms: i64, roles: i64) -> i64 {
    match (is_admin, perms) {
        (true, 0) => ALL_PERMS,
        (true, p) => p & ALL_PERMS,
        (false, _) => roles & ALL_PERMS,
    }
}

pub fn can_moderate(actor: i64, actor_site_admin: bool, target: i64) -> bool {
    actor_site_admin || ((target & !actor) == 0 && target != actor)
}

pub fn can_grant(actor: i64, actor_site_admin: bool, perms: i64) -> bool {
    actor_site_admin || (perms & ALL_PERMS & !actor) == 0
}

#[derive(Clone, Copy)]
pub struct ChannelAccess {
    pub view: bool,
    pub send: bool,
    pub history: bool,
}

impl ChannelAccess {
    pub fn all(v: bool) -> ChannelAccess {
        ChannelAccess {
            view: v,
            send: v,
            history: v,
        }
    }
}

pub async fn perm_subjects(
    db: &Db,
    server: Option<&str>,
    username: &str,
) -> sqlx::Result<Vec<String>> {
    let rows = match server {
        Some(server) => {
            sqlx::query("SELECT role_id FROM user_roles WHERE server = $1 AND username = $2")
                .bind(server)
                .bind(username)
                .fetch_all(db)
                .await?
        }
        None => {
            sqlx::query("SELECT role_id FROM user_roles WHERE username = $1")
                .bind(username)
                .fetch_all(db)
                .await?
        }
    };
    let mut subjects = Vec::with_capacity(rows.len() + 1);
    subjects.push(format!("u:{username}"));
    for r in &rows {
        subjects.push(format!("r:{}", r.try_get::<i64, _>(0)?));
    }
    Ok(subjects)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PermRow {
    pub subject: String,
    pub view: bool,
    pub send: bool,
    pub history: bool,
}

pub fn perm_row(r: &AnyRow, at: usize) -> sqlx::Result<PermRow> {
    Ok(PermRow {
        subject: r.try_get(at)?,
        view: r.try_get::<i64, _>(at + 1)? != 0,
        send: r.try_get::<i64, _>(at + 2)? != 0,
        history: r.try_get::<i64, _>(at + 3)? != 0,
    })
}

/// Which actions of a channel need an explicit allow from one of its rules (`restrict_view`,
/// `restrict_send`).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Restrict {
    pub view: bool,
    pub send: bool,
}

impl Restrict {
    pub fn read(r: &AnyRow, at: usize) -> sqlx::Result<Restrict> {
        Ok(Restrict {
            view: r.try_get::<i64, _>(at)? != 0,
            send: r.try_get::<i64, _>(at + 1)? != 0,
        })
    }
}

/// The channel rule: managers pass. Otherwise each action is allowed by any rule matching one of
/// `subjects` that allows it; without a matching rule, actions are allowed unless the channel
/// restricts them (history only follows view). No view means nothing.
pub fn fold_access<'a>(
    rows: impl IntoIterator<Item = &'a PermRow>,
    subjects: &[String],
    manages: bool,
    restrict: Restrict,
) -> ChannelAccess {
    if manages {
        return ChannelAccess::all(true);
    }
    let mut matched = false;
    let mut acc = ChannelAccess::all(false);
    for row in rows {
        let PermRow {
            subject,
            view,
            send,
            history,
        } = row;
        if subjects.contains(subject) {
            matched = true;
            acc.view |= *view;
            acc.send |= *send;
            acc.history |= *history;
        }
    }
    let Restrict {
        view: restrict_view,
        send: restrict_send,
    } = restrict;
    let acc = match matched {
        true => acc,
        false => ChannelAccess {
            view: !restrict_view,
            send: !restrict_send,
            history: true,
        },
    };
    match acc.view {
        true => acc,
        false => ChannelAccess::all(false),
    }
}

/// Whether taking `rule` away from a member can widen their access: for a member it was the only
/// match for, it allows less than a member matching no rule gets in that channel. Deleting or
/// unassigning a role with such a rule needs Manage channels.
pub fn rule_narrows(rule: &PermRow, restrict: Restrict) -> bool {
    let subject = [rule.subject.clone()];
    let ChannelAccess {
        view,
        send,
        history,
    } = fold_access([rule], &subject, false, restrict);
    let open = fold_access([], &subject, false, restrict);
    (open.view && !view) || (open.send && !send) || (open.history && !history)
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
