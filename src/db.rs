use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::any::{AnyPoolOptions, AnyRow, install_default_drivers};
use sqlx::{AnyPool, Row};

pub type Db = AnyPool;

const SQLITE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  password_kind TEXT NOT NULL CHECK(password_kind IN ('text','words')),
  avatar_kind TEXT NOT NULL CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, banner_color TEXT,
  is_site_admin INTEGER NOT NULL DEFAULT 0, appear_offline INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY, day TEXT NOT NULL, count INTEGER NOT NULL, last_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS banned_usernames(username TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS servers(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, creator TEXT, password_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice')), slowmode_seconds INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(server, name));
CREATE TABLE IF NOT EXISTS members(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, perms INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS roles(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, perms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_roles(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(server, username, role_id));
CREATE TABLE IF NOT EXISTS channel_perms(channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, subject TEXT NOT NULL, can_view INTEGER NOT NULL DEFAULT 1, can_send INTEGER NOT NULL DEFAULT 1, can_read_history INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(channel_id, subject));
CREATE TABLE IF NOT EXISTS dms(id INTEGER PRIMARY KEY AUTOINCREMENT, user_a TEXT NOT NULL, user_b TEXT NOT NULL, UNIQUE(user_a, user_b));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, dm_id INTEGER REFERENCES dms(id) ON DELETE CASCADE, thread_root_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, author TEXT NOT NULL, content TEXT NOT NULL, media_id TEXT, media_filename TEXT, media_removed INTEGER NOT NULL DEFAULT 0, media_spoiler INTEGER NOT NULL DEFAULT 0, media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p')), media_hoster TEXT, media_expires_at INTEGER, media_size INTEGER, media_mime TEXT, kind TEXT NOT NULL DEFAULT 'user', call_answered_at INTEGER, call_ended_at INTEGER, call_outcome TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB, uploader TEXT, uploaded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeds(url TEXT PRIMARY KEY, site_name TEXT, title TEXT, description TEXT, image_url TEXT, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS message_embeds(message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, ord INTEGER NOT NULL, url TEXT NOT NULL, banner_removed INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(message_id, ord));
CREATE TABLE IF NOT EXISTS interactions(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS guest_grants(\"grant\" TEXT PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS read_state(username TEXT NOT NULL, scope TEXT NOT NULL, last_read INTEGER NOT NULL, PRIMARY KEY(username, scope));
CREATE TABLE IF NOT EXISTS server_bans(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, banned_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(server, username));
CREATE INDEX IF NOT EXISTS idx_members_username ON members(username);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_dm_id ON messages(dm_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author);
CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_top ON messages(channel_id, id) WHERE thread_root_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_dms_user_b ON dms(user_b);
CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
";

const POSTGRES_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  password_kind TEXT NOT NULL CHECK(password_kind IN ('text','words')),
  avatar_kind TEXT NOT NULL CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, banner_color TEXT,
  is_site_admin BIGINT NOT NULL DEFAULT 0, appear_offline BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY, day TEXT NOT NULL, count BIGINT NOT NULL, last_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS banned_usernames(username TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS servers(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, creator TEXT, password_hash TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS channels(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice')), slowmode_seconds BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, UNIQUE(server, name));
CREATE TABLE IF NOT EXISTS members(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, is_admin BIGINT NOT NULL DEFAULT 0, perms BIGINT NOT NULL DEFAULT 0, joined_at BIGINT NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS roles(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, perms BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_roles(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(server, username, role_id));
CREATE TABLE IF NOT EXISTS channel_perms(channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, subject TEXT NOT NULL, can_view BIGINT NOT NULL DEFAULT 1, can_send BIGINT NOT NULL DEFAULT 1, can_read_history BIGINT NOT NULL DEFAULT 1, PRIMARY KEY(channel_id, subject));
CREATE TABLE IF NOT EXISTS dms(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, UNIQUE(user_a, user_b));
CREATE TABLE IF NOT EXISTS messages(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE, dm_id BIGINT REFERENCES dms(id) ON DELETE CASCADE, thread_root_id BIGINT REFERENCES messages(id) ON DELETE CASCADE, author TEXT NOT NULL, content TEXT NOT NULL, media_id TEXT, media_filename TEXT, media_removed BIGINT NOT NULL DEFAULT 0, media_spoiler BIGINT NOT NULL DEFAULT 0, media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p')), media_hoster TEXT, media_expires_at BIGINT, media_size BIGINT, media_mime TEXT, kind TEXT NOT NULL DEFAULT 'user', call_answered_at BIGINT, call_ended_at BIGINT, call_outcome TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, data BYTEA, uploader TEXT, uploaded_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeds(url TEXT PRIMARY KEY, site_name TEXT, title TEXT, description TEXT, image_url TEXT, fetched_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS message_embeds(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, ord BIGINT NOT NULL, url TEXT NOT NULL, banner_removed BIGINT NOT NULL DEFAULT 0, removed BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(message_id, ord));
CREATE TABLE IF NOT EXISTS interactions(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, last_at BIGINT NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS guest_grants(\"grant\" TEXT PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS read_state(username TEXT NOT NULL, scope TEXT NOT NULL, last_read BIGINT NOT NULL, PRIMARY KEY(username, scope));
CREATE TABLE IF NOT EXISTS server_bans(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, banned_by TEXT, created_at BIGINT NOT NULL, PRIMARY KEY(server, username));
CREATE INDEX IF NOT EXISTS idx_members_username ON members(username);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_dm_id ON messages(dm_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author);
CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_top ON messages(channel_id, id) WHERE thread_root_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_dms_user_b ON dms(user_b);
CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
";

const SQLITE_SEARCH: &[&str] = &[
    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id', tokenize='trigram')",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES(new.id, new.content); END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content); END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content); INSERT INTO messages_fts(rowid, content) VALUES(new.id, new.content); END",
];

const POSTGRES_SEARCH: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages USING gin (lower(content) gin_trgm_ops)",
    "CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users USING gin (lower(username) gin_trgm_ops)",
    "CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm ON users USING gin (lower(display_name) gin_trgm_ops)",
    "CREATE INDEX IF NOT EXISTS idx_servers_name_trgm ON servers USING gin (lower(name) gin_trgm_ops)",
    "CREATE INDEX IF NOT EXISTS idx_servers_display_name_trgm ON servers USING gin (lower(display_name) gin_trgm_ops)",
];

static FTS_READY: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

fn pool_key(db: &Db) -> String {
    db.connect_options().database_url.to_string()
}

pub fn has_fts(db: &Db) -> bool {
    FTS_READY
        .lock()
        .is_ok_and(|ready| ready.contains(&pool_key(db)))
}

pub(crate) fn set_fts(db: &Db, ready: bool) {
    if let Ok(mut set) = FTS_READY.lock() {
        match ready {
            true => {
                set.insert(pool_key(db));
            }
            false => {
                set.remove(&pool_key(db));
            }
        }
    }
}

async fn probe_fts(db: &Db) -> bool {
    db.connect_options()
        .database_url
        .scheme()
        .starts_with("sqlite")
        && sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
            .fetch_optional(db)
            .await
            .is_ok_and(|r| r.is_some())
}

async fn sqlite_search_index(pool: &Db) -> anyhow::Result<()> {
    let existed = probe_fts(pool).await;
    let mut tx = pool.begin().await?;
    for stmt in SQLITE_SEARCH {
        sqlx::query(*stmt).execute(&mut *tx).await?;
    }
    if !existed {
        sqlx::query("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if !existed {
        tracing::info!("built message search index");
    }
    Ok(())
}

async fn postgres_search_index(pool: &Db) {
    if let Err(e) = sqlx::query("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        .execute(pool)
        .await
    {
        tracing::warn!("pg_trgm unavailable, search falls back to unindexed LIKE: {e}");
        return;
    }
    for stmt in POSTGRES_SEARCH {
        if let Err(e) = sqlx::query(*stmt).execute(pool).await {
            tracing::warn!("search index not created: {e}");
        }
    }
}

const MIGRATIONS: &[(&str, &str)] = &[
    ("servers", "password_hash TEXT"),
    ("members", "perms {INT} NOT NULL DEFAULT 0"),
    (
        "channels",
        "kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice'))",
    ),
    ("channels", "slowmode_seconds {INT} NOT NULL DEFAULT 0"),
    ("messages", "media_spoiler {INT} NOT NULL DEFAULT 0"),
    (
        "messages",
        "media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p'))",
    ),
    ("messages", "media_hoster TEXT"),
    ("messages", "media_expires_at {INT}"),
    ("messages", "media_size {INT}"),
    ("messages", "media_mime TEXT"),
    ("messages", "kind TEXT NOT NULL DEFAULT 'user'"),
    ("messages", "call_answered_at {INT}"),
    ("messages", "call_ended_at {INT}"),
    ("messages", "call_outcome TEXT"),
    ("users", "appear_offline {INT} NOT NULL DEFAULT 0"),
    ("users", "banner_color TEXT"),
    ("media", "uploader TEXT"),
];

async fn reconcile_columns(pool: &Db, is_sqlite: bool) -> anyhow::Result<()> {
    let int = match is_sqlite {
        true => "INTEGER",
        false => "BIGINT",
    };
    for (table, col) in MIGRATIONS {
        let coldef = col.replace("{INT}", int);
        let sql = format!("ALTER TABLE {table} ADD COLUMN {coldef}");
        match sqlx::query(sqlx::AssertSqlSafe(sql)).execute(pool).await {
            Ok(_) => {
                let name = coldef.split_whitespace().next().unwrap_or(&coldef);
                tracing::info!("added missing column {table}.{name}");
            }
            Err(e)
                if matches!(&e, sqlx::Error::Database(d)
                    if d.message().contains("duplicate column")
                        || d.message().contains("already exists")) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

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

pub struct User {
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub password_kind: String,
    pub avatar_kind: AvatarKind,
    pub avatar_color: Option<String>,
    pub banner_color: Option<String>,
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
            is_site_admin: row.try_get::<i64, _>("is_site_admin")? != 0,
            appear_offline: row.try_get::<i64, _>("appear_offline")? != 0,
            created_at: row.try_get("created_at")?,
        })
    }
}

pub async fn get_user<'e, E>(ex: E, username: &str) -> sqlx::Result<Option<User>>
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
}

pub const ALL_PERMS: i64 = 31;

pub async fn effective_perms(db: &Db, server: &str, user: &User) -> sqlx::Result<i64> {
    match user.is_site_admin {
        true => Ok(ALL_PERMS),
        false => member_perms(db, server, &user.username).await,
    }
}

pub async fn member_perms(db: &Db, server: &str, username: &str) -> sqlx::Result<i64> {
    let row =
        sqlx::query("SELECT is_admin, perms FROM members WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(username)
            .fetch_optional(db)
            .await?;
    let Some(r) = row else {
        return Ok(0);
    };
    let (is_admin, perms): (i64, i64) = (r.try_get(0)?, r.try_get(1)?);
    if is_admin != 0 {
        return Ok(match perms {
            0 => ALL_PERMS,
            p => p & ALL_PERMS,
        });
    }
    let rows = sqlx::query("SELECT r.perms FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username = $2")
        .bind(server)
        .bind(username)
        .fetch_all(db)
        .await?;
    let mut acc = 0i64;
    for r in &rows {
        acc |= r.try_get::<i64, _>(0)?;
    }
    Ok(acc & ALL_PERMS)
}

pub fn can_moderate(actor: i64, actor_site_admin: bool, target: i64) -> bool {
    actor_site_admin || ((target & !actor) == 0 && target != actor)
}

pub async fn has_perm(db: &Db, server: &str, user: &User, perm: Perm) -> bool {
    effective_perms(db, server, user)
        .await
        .is_ok_and(|p| p & perm as i64 != 0)
}

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

pub async fn channel_access(
    db: &Db,
    server: &str,
    channel_id: i64,
    user: Option<&User>,
) -> sqlx::Result<ChannelAccess> {
    let rows = sqlx::query(
        "SELECT subject, can_view, can_send, can_read_history FROM channel_perms WHERE channel_id = $1",
    )
    .bind(channel_id)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(ChannelAccess::all(true));
    }
    let user = match user {
        Some(u) => u,
        None => return Ok(ChannelAccess::all(false)),
    };
    if effective_perms(db, server, user).await? & Perm::ManageChannels as i64 != 0 {
        return Ok(ChannelAccess::all(true));
    }
    let mut subjects = vec![format!("u:{}", user.username)];
    let role_rows =
        sqlx::query("SELECT role_id FROM user_roles WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(&user.username)
            .fetch_all(db)
            .await?;
    for r in &role_rows {
        subjects.push(format!("r:{}", r.try_get::<i64, _>(0)?));
    }
    let mut acc = ChannelAccess::all(false);
    for r in &rows {
        let subject: String = r.try_get(0)?;
        if subjects.contains(&subject) {
            acc.view |= r.try_get::<i64, _>(1)? != 0;
            acc.send |= r.try_get::<i64, _>(2)? != 0;
            acc.history |= r.try_get::<i64, _>(3)? != 0;
        }
    }
    match acc.view {
        true => Ok(acc),
        false => Ok(ChannelAccess::all(false)),
    }
}

pub async fn channel_viewable(
    db: &Db,
    server: &str,
    channel_id: i64,
    username: Option<&str>,
) -> bool {
    let user = match username {
        Some(name) => match get_user(db, name).await {
            Ok(u) => u,
            Err(_) => return false,
        },
        None => None,
    };
    channel_access(db, server, channel_id, user.as_ref())
        .await
        .is_ok_and(|a| a.view)
}

pub async fn setting_on<'e, E>(ex: E, key: &str) -> bool
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    match sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(ex)
        .await
    {
        Ok(Some(row)) => row
            .try_get::<String, _>(0)
            .map(|v| v == "1")
            .unwrap_or(true),
        _ => true,
    }
}

pub async fn touch_interaction(db: &Db, server: &str, username: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO interactions(server, username, last_at) VALUES($1, $2, $3) ON CONFLICT(server, username) DO UPDATE SET last_at = excluded.last_at",
    )
    .bind(server)
    .bind(username)
    .bind(now())
    .execute(db)
    .await
    .map(|_| ())
}

pub async fn is_banned(db: &Db, server: &str, username: &str) -> sqlx::Result<bool> {
    Ok(
        sqlx::query("SELECT 1 FROM server_bans WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(username)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub async fn open(database_url: Option<&str>) -> anyhow::Result<Db> {
    install_default_drivers();
    let url = match database_url {
        Some(u)
            if u.starts_with("postgres://")
                || u.starts_with("postgresql://")
                || u.starts_with("sqlite:") =>
        {
            u.to_string()
        }
        Some(path) => format!("sqlite://{path}?mode=rwc"),
        None => "sqlite://rchat.db?mode=rwc".to_string(),
    };
    let is_sqlite = url.starts_with("sqlite:");
    let pool = AnyPoolOptions::new()
        .max_connections(match is_sqlite {
            true => 1,
            false => 8,
        })
        .after_connect(move |conn, _| {
            Box::pin(async move {
                if is_sqlite {
                    sqlx::query("PRAGMA journal_mode=WAL")
                        .execute(&mut *conn)
                        .await?;
                    sqlx::query("PRAGMA foreign_keys=ON")
                        .execute(&mut *conn)
                        .await?;
                }
                Ok(())
            })
        })
        .connect(&url)
        .await?;
    let schema = match is_sqlite {
        true => SQLITE_SCHEMA,
        false => POSTGRES_SCHEMA,
    };
    for stmt in schema.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        sqlx::query(stmt).execute(&pool).await?;
    }
    reconcile_columns(&pool, is_sqlite).await?;
    match is_sqlite {
        true => {
            if let Err(e) = sqlite_search_index(&pool).await {
                tracing::warn!("FTS5 trigram unavailable, search falls back to LIKE: {e}");
            }
            set_fts(&pool, probe_fts(&pool).await);
        }
        false => {
            postgres_search_index(&pool).await;
            set_fts(&pool, false);
        }
    }
    let t = now();
    sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES('rchat', 'RChat', NULL, $1) ON CONFLICT(name) DO NOTHING")
        .bind(t)
        .execute(&pool)
        .await?;
    sqlx::query("INSERT INTO channels(server, name, created_at) SELECT 'rchat', 'general', $1 WHERE NOT EXISTS(SELECT 1 FROM channels WHERE server = 'rchat')")
        .bind(t)
        .execute(&pool)
        .await?;
    let guests = match std::env::var("GUESTS_ENABLED") {
        Ok(v) if matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "off") => "0",
        _ => "1",
    };
    sqlx::query(
        "INSERT INTO settings(key, value) VALUES('guests_enabled', $1) ON CONFLICT(key) DO NOTHING",
    )
    .bind(guests)
    .execute(&pool)
    .await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};

    async fn general_id(db: &Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id")
    }

    #[tokio::test]
    async fn effective_perms_matrix() {
        let (state, path) = temp_state("perm_matrix").await;
        let db = &state.db;
        let t = now();
        add_member(db, "rchat", "full", 1, 0, t).await;
        add_member(db, "rchat", "narrow", 1, Perm::Kick as i64, t).await;
        add_member(db, "rchat", "roled", 0, 0, t).await;
        add_member(db, "rchat", "plain", 0, 0, t).await;
        for perms in [Perm::ManageChannels as i64, Perm::Kick as i64] {
            let role_id: i64 = sqlx::query(
                "INSERT INTO roles(server, name, color, perms) VALUES('rchat', $1, '#ffffff', $2) RETURNING id",
            )
            .bind(format!("role{perms}"))
            .bind(perms)
            .fetch_one(db)
            .await
            .expect("insert role")
            .try_get(0)
            .expect("role id");
            sqlx::query(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'roled', $1)",
            )
            .bind(role_id)
            .execute(db)
            .await
            .expect("assign role");
        }
        let cases: [(&str, bool, i64); 5] = [
            ("site", true, ALL_PERMS),
            ("full", false, ALL_PERMS),
            ("narrow", false, Perm::Kick as i64),
            (
                "roled",
                false,
                Perm::ManageChannels as i64 | Perm::Kick as i64,
            ),
            ("plain", false, 0),
        ];
        for (name, site_admin, expected) in cases {
            let got = effective_perms(db, "rchat", &mem_user(name, site_admin))
                .await
                .expect("effective_perms");
            assert_eq!(got, expected, "user {name}");
        }
        done(state, path).await;
    }

    #[test]
    fn moderation_needs_a_strict_superset() {
        let kick = Perm::Kick as i64;
        let channels = Perm::ManageChannels as i64;
        let cases: [(i64, bool, i64, bool); 9] = [
            (kick, false, 0, true),
            (kick, false, kick, false),
            (kick, false, ALL_PERMS, false),
            (kick, false, channels, false),
            (kick | channels, false, channels, true),
            (kick | channels, false, kick, true),
            (ALL_PERMS, false, ALL_PERMS, false),
            (ALL_PERMS, false, ALL_PERMS & !channels, true),
            (ALL_PERMS, true, ALL_PERMS, true),
        ];
        for (actor, site_admin, target, expected) in cases {
            assert_eq!(
                can_moderate(actor, site_admin, target),
                expected,
                "actor {actor} site admin {site_admin} target {target}"
            );
        }
    }

    #[tokio::test]
    async fn member_perms_ignore_site_admin_and_non_members() {
        let (state, path) = temp_state("member_perms").await;
        let db = &state.db;
        add_member(db, "rchat", "root", 0, 0, now()).await;
        add_member(db, "rchat", "narrow", 1, Perm::Kick as i64, now()).await;
        assert_eq!(member_perms(db, "rchat", "root").await.expect("root"), 0);
        assert_eq!(
            effective_perms(db, "rchat", &mem_user("root", true))
                .await
                .expect("root effective"),
            ALL_PERMS
        );
        assert_eq!(
            member_perms(db, "rchat", "narrow").await.expect("narrow"),
            Perm::Kick as i64
        );
        assert_eq!(member_perms(db, "rchat", "ghost").await.expect("ghost"), 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn channel_access_private() {
        let (state, path) = temp_state("chan_access").await;
        let db = &state.db;
        let cid = general_id(db).await;
        let open = channel_access(db, "rchat", cid, None).await.expect("open");
        assert!(open.view && open.send && open.history);
        sqlx::query(
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 0)",
        )
        .bind(cid)
        .execute(db)
        .await
        .expect("insert perm");
        add_member(db, "rchat", "carol", 1, 0, now()).await;
        let alice = channel_access(db, "rchat", cid, Some(&mem_user("alice", false)))
            .await
            .expect("alice");
        assert!(alice.view && alice.send && !alice.history);
        let bob = channel_access(db, "rchat", cid, Some(&mem_user("bob", false)))
            .await
            .expect("bob");
        assert!(!bob.view && !bob.send && !bob.history);
        let guest = channel_access(db, "rchat", cid, None).await.expect("guest");
        assert!(!guest.view && !guest.send && !guest.history);
        let carol = channel_access(db, "rchat", cid, Some(&mem_user("carol", false)))
            .await
            .expect("carol");
        assert!(carol.view && carol.send && carol.history);
        done(state, path).await;
    }
}
