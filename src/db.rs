use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::any::{AnyPoolOptions, AnyRow, install_default_drivers};
use sqlx::{AnyConnection, AnyPool, Row};

pub type Db = AnyPool;

const SCHEMA_LOCK: i64 = 0x7263_6861_7400;

const SQLITE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  password_kind TEXT NOT NULL CHECK(password_kind IN ('text','words')),
  avatar_kind TEXT NOT NULL CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, banner_color TEXT, bio TEXT,
  is_site_admin INTEGER NOT NULL DEFAULT 0, appear_offline INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY, day TEXT NOT NULL, count INTEGER NOT NULL, last_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS change_attempts(session TEXT PRIMARY KEY, day TEXT NOT NULL, failures INTEGER NOT NULL, last_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS banned_usernames(username TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS pending_purges(kind TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, key));
CREATE TABLE IF NOT EXISTS servers(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, creator TEXT, password_hash TEXT, member_count INTEGER NOT NULL DEFAULT 0, banner_color TEXT, name_color TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice')), slowmode_seconds INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(server, name));
CREATE TABLE IF NOT EXISTS members(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, perms INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, joined_via INTEGER, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS roles(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, perms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_roles(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(server, username, role_id));
CREATE TABLE IF NOT EXISTS channel_perms(channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, subject TEXT NOT NULL, can_view INTEGER NOT NULL DEFAULT 1, can_send INTEGER NOT NULL DEFAULT 1, can_read_history INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(channel_id, subject));
CREATE TABLE IF NOT EXISTS dms(id INTEGER PRIMARY KEY AUTOINCREMENT, user_a TEXT NOT NULL, user_b TEXT NOT NULL, last_message_id INTEGER NOT NULL DEFAULT 0, UNIQUE(user_a, user_b));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, dm_id INTEGER REFERENCES dms(id) ON DELETE CASCADE, thread_root_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, author TEXT NOT NULL, content TEXT NOT NULL, media_id TEXT, media_filename TEXT, media_removed INTEGER NOT NULL DEFAULT 0, media_spoiler INTEGER NOT NULL DEFAULT 0, media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p')), media_hoster TEXT, media_expires_at INTEGER, media_size INTEGER, media_mime TEXT, kind TEXT NOT NULL DEFAULT 'user', call_answered_at INTEGER, call_ended_at INTEGER, call_outcome TEXT, reply_to INTEGER, reply_mention INTEGER NOT NULL DEFAULT 0, edited_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB, uploader TEXT, uploaded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media_chunks(media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(media_id, seq));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeds(url TEXT PRIMARY KEY, site_name TEXT, title TEXT, description TEXT, image_url TEXT, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS message_embeds(message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, ord INTEGER NOT NULL, url TEXT NOT NULL, banner_removed INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(message_id, ord));
CREATE TABLE IF NOT EXISTS interactions(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS guest_grants(\"grant\" TEXT PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL DEFAULT 0, password_id INTEGER);
CREATE TABLE IF NOT EXISTS server_passwords(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, label TEXT, hash TEXT NOT NULL, lookup TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, used_up_at INTEGER, UNIQUE(server, lookup));
CREATE TABLE IF NOT EXISTS read_state(username TEXT NOT NULL, scope TEXT NOT NULL, last_read INTEGER NOT NULL, PRIMARY KEY(username, scope));
CREATE TABLE IF NOT EXISTS server_bans(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, banned_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS pings(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('mention','reply','reaction')), scope TEXT NOT NULL, server TEXT REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, thread_root_id INTEGER, actor TEXT NOT NULL, emoji TEXT, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reactions(message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, username TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_id, username, emoji));
CREATE INDEX IF NOT EXISTS idx_members_username ON members(username);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_dm_id ON messages(dm_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author);
CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_top ON messages(channel_id, id) WHERE thread_root_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_dms_user_b ON dms(user_b);
CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_channel_author ON messages(channel_id, author, id);
CREATE INDEX IF NOT EXISTS idx_message_embeds_url ON message_embeds(url);
CREATE INDEX IF NOT EXISTS idx_user_roles_username ON user_roles(username);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server, id);
CREATE INDEX IF NOT EXISTS idx_tokens_username ON tokens(username);
CREATE INDEX IF NOT EXISTS idx_guest_grants_server ON guest_grants(server);
CREATE INDEX IF NOT EXISTS idx_guest_grants_used ON guest_grants(last_used_at);
CREATE INDEX IF NOT EXISTS idx_guest_grants_password ON guest_grants(password_id) WHERE password_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_server_passwords_server ON server_passwords(server, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_last ON login_attempts(last_at);
CREATE INDEX IF NOT EXISTS idx_change_attempts_last ON change_attempts(last_at);
CREATE INDEX IF NOT EXISTS idx_users_purging ON users(username) WHERE password_hash = '!purging';
CREATE INDEX IF NOT EXISTS idx_embeds_fetched ON embeds(fetched_at);
CREATE INDEX IF NOT EXISTS idx_channel_perms_subject ON channel_perms(subject);
CREATE INDEX IF NOT EXISTS idx_interactions_username ON interactions(username);
CREATE INDEX IF NOT EXISTS idx_interactions_recent ON interactions(server, last_at, username);
CREATE INDEX IF NOT EXISTS idx_server_bans_recent ON server_bans(server, created_at, username);
CREATE INDEX IF NOT EXISTS idx_members_user_joined ON members(username, joined_at, server);
CREATE INDEX IF NOT EXISTS idx_servers_creator ON servers(creator, name);
CREATE INDEX IF NOT EXISTS idx_dms_a_latest ON dms(user_a, last_message_id, id);
CREATE INDEX IF NOT EXISTS idx_dms_b_latest ON dms(user_b, last_message_id, id);
CREATE INDEX IF NOT EXISTS idx_members_admins ON members(server, username) WHERE is_admin <> 0;
CREATE INDEX IF NOT EXISTS idx_pings_user ON pings(username, seen, id);
CREATE INDEX IF NOT EXISTS idx_pings_message ON pings(message_id);
CREATE INDEX IF NOT EXISTS idx_pings_created ON pings(created_at);
CREATE INDEX IF NOT EXISTS idx_pings_seen ON pings(id) WHERE seen <> 0;
CREATE INDEX IF NOT EXISTS idx_pings_actor ON pings(actor);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, emoji, created_at);
CREATE INDEX IF NOT EXISTS idx_reactions_username ON reactions(username);
";

const POSTGRES_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  password_kind TEXT NOT NULL CHECK(password_kind IN ('text','words')),
  avatar_kind TEXT NOT NULL CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, banner_color TEXT, bio TEXT,
  is_site_admin BIGINT NOT NULL DEFAULT 0, appear_offline BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY, day TEXT NOT NULL, count BIGINT NOT NULL, last_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS change_attempts(session TEXT PRIMARY KEY, day TEXT NOT NULL, failures BIGINT NOT NULL, last_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS banned_usernames(username TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS pending_purges(kind TEXT NOT NULL, key TEXT NOT NULL, created_at BIGINT NOT NULL, claimed_at BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(kind, key));
CREATE TABLE IF NOT EXISTS servers(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, creator TEXT, password_hash TEXT, member_count BIGINT NOT NULL DEFAULT 0, banner_color TEXT, name_color TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS channels(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice')), slowmode_seconds BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, UNIQUE(server, name));
CREATE TABLE IF NOT EXISTS members(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, is_admin BIGINT NOT NULL DEFAULT 0, perms BIGINT NOT NULL DEFAULT 0, joined_at BIGINT NOT NULL, joined_via BIGINT, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS roles(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, perms BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_roles(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(server, username, role_id));
CREATE TABLE IF NOT EXISTS channel_perms(channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, subject TEXT NOT NULL, can_view BIGINT NOT NULL DEFAULT 1, can_send BIGINT NOT NULL DEFAULT 1, can_read_history BIGINT NOT NULL DEFAULT 1, PRIMARY KEY(channel_id, subject));
CREATE TABLE IF NOT EXISTS dms(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, last_message_id BIGINT NOT NULL DEFAULT 0, UNIQUE(user_a, user_b));
CREATE TABLE IF NOT EXISTS messages(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE, dm_id BIGINT REFERENCES dms(id) ON DELETE CASCADE, thread_root_id BIGINT REFERENCES messages(id) ON DELETE CASCADE, author TEXT NOT NULL, content TEXT NOT NULL, media_id TEXT, media_filename TEXT, media_removed BIGINT NOT NULL DEFAULT 0, media_spoiler BIGINT NOT NULL DEFAULT 0, media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p')), media_hoster TEXT, media_expires_at BIGINT, media_size BIGINT, media_mime TEXT, kind TEXT NOT NULL DEFAULT 'user', call_answered_at BIGINT, call_ended_at BIGINT, call_outcome TEXT, reply_to BIGINT, reply_mention BIGINT NOT NULL DEFAULT 0, edited_at BIGINT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, data BYTEA, uploader TEXT, uploaded_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS media_chunks(media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, seq BIGINT NOT NULL, data BYTEA NOT NULL, PRIMARY KEY(media_id, seq));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeds(url TEXT PRIMARY KEY, site_name TEXT, title TEXT, description TEXT, image_url TEXT, fetched_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS message_embeds(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, ord BIGINT NOT NULL, url TEXT NOT NULL, banner_removed BIGINT NOT NULL DEFAULT 0, removed BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(message_id, ord));
CREATE TABLE IF NOT EXISTS interactions(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, last_at BIGINT NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS guest_grants(\"grant\" TEXT PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, created_at BIGINT NOT NULL, last_used_at BIGINT NOT NULL DEFAULT 0, password_id BIGINT);
CREATE TABLE IF NOT EXISTS server_passwords(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, label TEXT, hash TEXT NOT NULL, lookup TEXT NOT NULL, created_by TEXT, created_at BIGINT NOT NULL, expires_at BIGINT, max_uses BIGINT, uses BIGINT NOT NULL DEFAULT 0, revoked_at BIGINT, used_up_at BIGINT, UNIQUE(server, lookup));
CREATE TABLE IF NOT EXISTS read_state(username TEXT NOT NULL, scope TEXT NOT NULL, last_read BIGINT NOT NULL, PRIMARY KEY(username, scope));
CREATE TABLE IF NOT EXISTS server_bans(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, banned_by TEXT, created_at BIGINT NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS pings(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('mention','reply','reaction')), scope TEXT NOT NULL, server TEXT REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, thread_root_id BIGINT, actor TEXT NOT NULL, emoji TEXT, created_at BIGINT NOT NULL, seen BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reactions(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, username TEXT NOT NULL, emoji TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(message_id, username, emoji));
CREATE INDEX IF NOT EXISTS idx_members_username ON members(username);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_dm_id ON messages(dm_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author);
CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_top ON messages(channel_id, id) WHERE thread_root_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_dms_user_b ON dms(user_b);
CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_channel_author ON messages(channel_id, author, id);
CREATE INDEX IF NOT EXISTS idx_message_embeds_url ON message_embeds(url);
CREATE INDEX IF NOT EXISTS idx_user_roles_username ON user_roles(username);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server, id);
CREATE INDEX IF NOT EXISTS idx_tokens_username ON tokens(username);
CREATE INDEX IF NOT EXISTS idx_guest_grants_server ON guest_grants(server);
CREATE INDEX IF NOT EXISTS idx_guest_grants_used ON guest_grants(last_used_at);
CREATE INDEX IF NOT EXISTS idx_guest_grants_password ON guest_grants(password_id) WHERE password_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_server_passwords_server ON server_passwords(server, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_last ON login_attempts(last_at);
CREATE INDEX IF NOT EXISTS idx_change_attempts_last ON change_attempts(last_at);
CREATE INDEX IF NOT EXISTS idx_users_purging ON users(username) WHERE password_hash = '!purging';
CREATE INDEX IF NOT EXISTS idx_embeds_fetched ON embeds(fetched_at);
CREATE INDEX IF NOT EXISTS idx_channel_perms_subject ON channel_perms(subject);
CREATE INDEX IF NOT EXISTS idx_interactions_username ON interactions(username);
CREATE INDEX IF NOT EXISTS idx_interactions_recent ON interactions(server, last_at, username);
CREATE INDEX IF NOT EXISTS idx_server_bans_recent ON server_bans(server, created_at, username);
CREATE INDEX IF NOT EXISTS idx_members_user_joined ON members(username, joined_at, server);
CREATE INDEX IF NOT EXISTS idx_servers_creator ON servers(creator, name);
CREATE INDEX IF NOT EXISTS idx_dms_a_latest ON dms(user_a, last_message_id, id);
CREATE INDEX IF NOT EXISTS idx_dms_b_latest ON dms(user_b, last_message_id, id);
CREATE INDEX IF NOT EXISTS idx_members_name_c ON members(server, (username COLLATE \"C\"));
CREATE INDEX IF NOT EXISTS idx_members_admins_c ON members(server, (username COLLATE \"C\")) WHERE is_admin <> 0;
CREATE INDEX IF NOT EXISTS idx_pings_user ON pings(username, seen, id);
CREATE INDEX IF NOT EXISTS idx_pings_message ON pings(message_id);
CREATE INDEX IF NOT EXISTS idx_pings_created ON pings(created_at);
CREATE INDEX IF NOT EXISTS idx_pings_seen ON pings(id) WHERE seen <> 0;
CREATE INDEX IF NOT EXISTS idx_pings_actor ON pings(actor);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, emoji, created_at);
CREATE INDEX IF NOT EXISTS idx_reactions_username ON reactions(username);
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

const SQLITE_TRIGGERS: &[&str] = &[
    "CREATE TRIGGER IF NOT EXISTS messages_dm_latest_insert AFTER INSERT ON messages WHEN new.dm_id IS NOT NULL BEGIN UPDATE dms SET last_message_id = new.id WHERE id = new.dm_id AND last_message_id < new.id; END",
    "CREATE TRIGGER IF NOT EXISTS messages_dm_latest_delete AFTER DELETE ON messages WHEN old.dm_id IS NOT NULL BEGIN UPDATE dms SET last_message_id = COALESCE((SELECT MAX(id) FROM messages WHERE dm_id = old.dm_id), 0) WHERE id = old.dm_id AND last_message_id = old.id; END",
    "CREATE TRIGGER IF NOT EXISTS members_count_insert AFTER INSERT ON members BEGIN UPDATE servers SET member_count = member_count + 1 WHERE name = new.server; END",
    "CREATE TRIGGER IF NOT EXISTS members_count_delete AFTER DELETE ON members BEGIN UPDATE servers SET member_count = member_count - 1 WHERE name = old.server; END",
];

const POSTGRES_TRIGGERS: &[&str] = &[
    "CREATE OR REPLACE FUNCTION rchat_dm_latest_insert() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE dms SET last_message_id = NEW.id WHERE id = NEW.dm_id AND last_message_id < NEW.id; RETURN NULL; END $f$",
    "CREATE OR REPLACE FUNCTION rchat_dm_latest_delete() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE dms SET last_message_id = COALESCE((SELECT MAX(id) FROM messages WHERE dm_id = OLD.dm_id), 0) WHERE id = OLD.dm_id AND last_message_id = OLD.id; RETURN NULL; END $f$",
    "CREATE OR REPLACE FUNCTION rchat_members_count_insert() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE servers SET member_count = member_count + 1 WHERE name = NEW.server; RETURN NULL; END $f$",
    "CREATE OR REPLACE FUNCTION rchat_members_count_delete() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE servers SET member_count = member_count - 1 WHERE name = OLD.server; RETURN NULL; END $f$",
    "DROP TRIGGER IF EXISTS messages_dm_latest_insert ON messages",
    "CREATE TRIGGER messages_dm_latest_insert AFTER INSERT ON messages FOR EACH ROW WHEN (NEW.dm_id IS NOT NULL) EXECUTE FUNCTION rchat_dm_latest_insert()",
    "DROP TRIGGER IF EXISTS messages_dm_latest_delete ON messages",
    "CREATE TRIGGER messages_dm_latest_delete AFTER DELETE ON messages FOR EACH ROW WHEN (OLD.dm_id IS NOT NULL) EXECUTE FUNCTION rchat_dm_latest_delete()",
    "DROP TRIGGER IF EXISTS members_count_insert ON members",
    "CREATE TRIGGER members_count_insert AFTER INSERT ON members FOR EACH ROW EXECUTE FUNCTION rchat_members_count_insert()",
    "DROP TRIGGER IF EXISTS members_count_delete ON members",
    "CREATE TRIGGER members_count_delete AFTER DELETE ON members FOR EACH ROW EXECUTE FUNCTION rchat_members_count_delete()",
];

static FTS_READY: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
static READERS: LazyLock<Mutex<HashMap<String, Db>>> = LazyLock::new(Default::default);
static PEPPERS: LazyLock<Mutex<HashMap<String, Vec<u8>>>> = LazyLock::new(Default::default);

pub async fn pepper(db: &Db) -> sqlx::Result<Vec<u8>> {
    let key = pool_key(db);
    if let Some(pepper) = PEPPERS.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Ok(pepper);
    }
    let value: String = sqlx::query("SELECT value FROM settings WHERE key = 'password_pepper'")
        .fetch_one(db)
        .await?
        .try_get(0)?;
    let pepper = value.into_bytes();
    if let Ok(mut peppers) = PEPPERS.lock() {
        peppers.insert(key, pepper.clone());
    }
    Ok(pepper)
}

pub fn reader(db: &Db) -> Db {
    READERS
        .lock()
        .ok()
        .and_then(|readers| readers.get(&pool_key(db)).cloned())
        .unwrap_or_else(|| db.clone())
}

pub async fn close(db: &Db) {
    if let Ok(mut peppers) = PEPPERS.lock() {
        peppers.remove(&pool_key(db));
    }
    let read = READERS
        .lock()
        .ok()
        .and_then(|mut readers| readers.remove(&pool_key(db)));
    if let Some(read) = read {
        read.close().await;
    }
    db.close().await;
}

pub(crate) fn pool_key(db: &Db) -> String {
    db.connect_options().database_url.to_string()
}

pub fn is_sqlite(db: &Db) -> bool {
    db.connect_options()
        .database_url
        .scheme()
        .starts_with("sqlite")
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

async fn guarded(conn: &mut AnyConnection, stmt: &'static str) -> Result<(), sqlx::Error> {
    let mut savepoint = sqlx::Connection::begin(&mut *conn).await?;
    sqlx::query(stmt).execute(&mut *savepoint).await?;
    savepoint.commit().await
}

async fn postgres_search_index(conn: &mut AnyConnection) {
    if let Err(e) = guarded(conn, "CREATE EXTENSION IF NOT EXISTS pg_trgm").await {
        tracing::warn!("pg_trgm unavailable, search falls back to unindexed LIKE: {e}");
        return;
    }
    for stmt in POSTGRES_SEARCH {
        if let Err(e) = guarded(conn, stmt).await {
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
    ("users", "bio TEXT"),
    ("media", "uploader TEXT"),
    ("dms", "last_message_id {INT} NOT NULL DEFAULT 0"),
    ("servers", "member_count {INT} NOT NULL DEFAULT 0"),
    ("servers", "banner_color TEXT"),
    ("servers", "name_color TEXT"),
    ("guest_grants", "last_used_at {INT} NOT NULL DEFAULT 0"),
    ("members", "joined_via {INT}"),
    ("pings", "thread_root_id {INT}"),
    ("guest_grants", "password_id {INT}"),
    ("messages", "reply_to {INT}"),
    ("messages", "reply_mention {INT} NOT NULL DEFAULT 0"),
    ("messages", "edited_at {INT}"),
];

const BACKFILLS: &[(&str, &str, &str)] = &[
    (
        "dms",
        "last_message_id",
        "UPDATE dms SET last_message_id = COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.dm_id = dms.id), 0)",
    ),
    (
        "servers",
        "member_count",
        "UPDATE servers SET member_count = (SELECT COUNT(*) FROM members m WHERE m.server = servers.name)",
    ),
    (
        "guest_grants",
        "last_used_at",
        "UPDATE guest_grants SET last_used_at = $1",
    ),
];

async fn reconcile_columns(
    conn: &mut AnyConnection,
    is_sqlite: bool,
) -> anyhow::Result<Vec<(&'static str, String)>> {
    let int = match is_sqlite {
        true => "INTEGER",
        false => "BIGINT",
    };
    let mut added = Vec::new();
    for (table, col) in MIGRATIONS {
        let coldef = col.replace("{INT}", int);
        let name = coldef.split_whitespace().next().unwrap_or(&coldef);
        if !is_sqlite {
            let present = sqlx::query(
                "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
            )
            .bind(*table)
            .bind(name)
            .fetch_optional(&mut *conn)
            .await?
            .is_some();
            if present {
                continue;
            }
        }
        let sql = format!("ALTER TABLE {table} ADD COLUMN {coldef}");
        match sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await
        {
            Ok(_) => {
                tracing::info!("added missing column {table}.{name}");
                added.push((*table, name.to_string()));
            }
            Err(e)
                if matches!(&e, sqlx::Error::Database(d)
                    if d.message().contains("duplicate column")
                        || d.message().contains("already exists")) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(added)
}

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
}

pub const ALL_PERMS: i64 = 31;

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

pub fn fold_access<'a>(
    rows: impl IntoIterator<Item = &'a PermRow>,
    subjects: &[String],
    manages: bool,
) -> ChannelAccess {
    if manages {
        return ChannelAccess::all(true);
    }
    let mut acc = ChannelAccess::all(false);
    for row in rows {
        let PermRow {
            subject,
            view,
            send,
            history,
        } = row;
        if subjects.contains(subject) {
            acc.view |= *view;
            acc.send |= *send;
            acc.history |= *history;
        }
    }
    match acc.view {
        true => acc,
        false => ChannelAccess::all(false),
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

const TOUCH_EVERY: Duration = Duration::from_secs(60);
const TOUCH_MAX: usize = 100_000;

type Touched = HashMap<(String, String, String), Instant>;

static TOUCHED: LazyLock<Mutex<Touched>> = LazyLock::new(Default::default);

fn recently_touched(db: &Db, server: &str, username: &str) -> bool {
    let key = (pool_key(db), server.to_string(), username.to_string());
    let Ok(mut map) = TOUCHED.lock() else {
        return false;
    };
    if map.get(&key).is_some_and(|at| at.elapsed() < TOUCH_EVERY) {
        return true;
    }
    if map.len() >= TOUCH_MAX {
        map.retain(|_, at| at.elapsed() < TOUCH_EVERY);
        if map.len() >= TOUCH_MAX {
            map.clear();
        }
    }
    map.insert(key, Instant::now());
    false
}

pub async fn touch_interaction(db: &Db, server: &str, username: &str) -> sqlx::Result<()> {
    if recently_touched(db, server, username) {
        return Ok(());
    }
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

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn env_num<T: std::str::FromStr>(key: &str) -> Option<T> {
    std::env::var(key).ok().and_then(|v| v.trim().parse().ok())
}

pub fn trigger_version(stmts: &[&str]) -> String {
    let hash = Sha256::digest(stmts.join(";\n").as_bytes());
    hash.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

async fn postgres_triggers(conn: &mut AnyConnection) -> anyhow::Result<()> {
    let want = trigger_version(POSTGRES_TRIGGERS);
    let have: Option<String> =
        sqlx::query("SELECT value FROM settings WHERE key = 'trigger_version'")
            .fetch_optional(&mut *conn)
            .await?
            .map(|r| r.try_get(0))
            .transpose()?;
    if have.as_deref() == Some(want.as_str()) {
        return Ok(());
    }
    for stmt in POSTGRES_TRIGGERS {
        sqlx::query(*stmt).execute(&mut *conn).await?;
    }
    sqlx::query("INSERT INTO settings(key, value) VALUES('trigger_version', $1) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(&want)
        .execute(&mut *conn)
        .await?;
    tracing::info!("installed database triggers version {want}");
    Ok(())
}

async fn init_schema(conn: &mut AnyConnection, is_sqlite: bool) -> anyhow::Result<()> {
    let schema = match is_sqlite {
        true => SQLITE_SCHEMA,
        false => POSTGRES_SCHEMA,
    };
    let (tables, rest): (Vec<&str>, Vec<&str>) = schema
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .partition(|s| s.starts_with("CREATE TABLE"));
    for stmt in tables {
        sqlx::query(stmt).execute(&mut *conn).await?;
    }
    let added = reconcile_columns(conn, is_sqlite).await?;
    for stmt in rest {
        sqlx::query(stmt).execute(&mut *conn).await?;
    }
    match is_sqlite {
        true => {
            for stmt in SQLITE_TRIGGERS {
                sqlx::query(*stmt).execute(&mut *conn).await?;
            }
        }
        false => postgres_triggers(conn).await?,
    }
    for (table, col, sql) in BACKFILLS {
        if added.iter().any(|(t, c)| t == table && c == col) {
            let query = sqlx::query(*sql);
            let query = match sql.contains("$1") {
                true => query.bind(now()),
                false => query,
            };
            query.execute(&mut *conn).await?;
            tracing::info!("backfilled {table}.{col}");
        }
    }
    let t = now();
    sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES('rchat', 'RChat', NULL, $1) ON CONFLICT(name) DO NOTHING")
        .bind(t)
        .execute(&mut *conn)
        .await?;
    sqlx::query("INSERT INTO channels(server, name, created_at) SELECT 'rchat', 'general', $1 WHERE NOT EXISTS(SELECT 1 FROM channels WHERE server = 'rchat')")
        .bind(t)
        .execute(&mut *conn)
        .await?;
    let guests = match std::env::var("GUESTS_ENABLED") {
        Ok(v) if matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "off") => "0",
        _ => "1",
    };
    sqlx::query(
        "INSERT INTO settings(key, value) VALUES('guests_enabled', $1) ON CONFLICT(key) DO NOTHING",
    )
    .bind(guests)
    .execute(&mut *conn)
    .await?;
    let profanity = crate::api::profanity_seed(
        std::env::var("PROFANITY_FILTER").ok().as_deref(),
        std::env::var("PROFANITY_TARGETS").ok().as_deref(),
    );
    seed_settings(&mut *conn, &profanity).await?;
    for (key, value) in [
        ("instance_id", crate::identity::random_id()),
        ("instance_signing_key", crate::identity::new_seed()),
        ("password_pepper", crate::api::auth::new_token()),
    ] {
        sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING")
            .bind(key)
            .bind(value)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

pub(crate) async fn seed_settings(
    conn: &mut AnyConnection,
    pairs: &[(&str, bool)],
) -> sqlx::Result<()> {
    for (key, on) in pairs {
        sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING")
            .bind(*key)
            .bind(match on {
                true => "1",
                false => "0",
            })
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
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
    let max = env_num::<u32>("DATABASE_MAX_CONNECTIONS");
    if is_sqlite && max.is_some_and(|n| n != 1) {
        tracing::warn!(
            "DATABASE_MAX_CONNECTIONS is ignored for sqlite: it has a single writer; use DATABASE_READ_CONNECTIONS for reads"
        );
    }
    let mut options = AnyPoolOptions::new().max_connections(writer_connections(is_sqlite, max));
    if let Some(min) = env_num("DATABASE_MIN_CONNECTIONS") {
        options = options.min_connections(min);
    }
    if let Some(secs) = env_num("DATABASE_ACQUIRE_TIMEOUT_SECS") {
        options = options.acquire_timeout(Duration::from_secs(secs));
    }
    let pool = options
        .after_connect(move |conn, _| {
            Box::pin(async move {
                if is_sqlite {
                    for pragma in [
                        "PRAGMA journal_mode=WAL",
                        "PRAGMA foreign_keys=ON",
                        "PRAGMA busy_timeout=5000",
                        "PRAGMA synchronous=NORMAL",
                        "PRAGMA mmap_size=268435456",
                    ] {
                        sqlx::query(pragma).execute(&mut *conn).await?;
                    }
                }
                Ok(())
            })
        })
        .connect(&url)
        .await?;
    match is_sqlite {
        true => {
            let mut tx = pool.begin().await?;
            init_schema(&mut tx, true).await?;
            tx.commit().await?;
        }
        false => {
            let mut tx = pool.begin().await?;
            sqlx::query("SELECT COUNT(*) FROM pg_advisory_xact_lock($1)")
                .bind(SCHEMA_LOCK)
                .execute(&mut *tx)
                .await?;
            init_schema(&mut tx, false).await?;
            postgres_search_index(&mut tx).await;
            tx.commit().await?;
        }
    }
    match is_sqlite {
        true => {
            if let Err(e) = sqlite_search_index(&pool).await {
                tracing::warn!("FTS5 trigram unavailable, search falls back to LIKE: {e}");
            }
            set_fts(&pool, probe_fts(&pool).await);
            let in_memory = url.contains(":memory:") || url.contains("mode=memory");
            let readers = match in_memory {
                true => 0,
                false => env_num("DATABASE_READ_CONNECTIONS").unwrap_or_else(|| {
                    std::thread::available_parallelism()
                        .map(|n| n.get() as u32)
                        .unwrap_or(4)
                        .clamp(2, 8)
                }),
            };
            if readers > 0 {
                let read = open_reader(&url, readers).await?;
                if let Ok(mut map) = READERS.lock() {
                    map.insert(pool_key(&pool), read);
                }
            }
        }
        false => set_fts(&pool, false),
    }
    pepper(&pool).await?;
    Ok(pool)
}

pub fn writer_connections(is_sqlite: bool, configured: Option<u32>) -> u32 {
    match (is_sqlite, configured) {
        (true, _) => 1,
        (false, Some(n)) => n,
        (false, None) => 8,
    }
}

async fn open_reader(url: &str, max: u32) -> anyhow::Result<Db> {
    let mut options = AnyPoolOptions::new().max_connections(max);
    if let Some(secs) = env_num("DATABASE_ACQUIRE_TIMEOUT_SECS") {
        options = options.acquire_timeout(Duration::from_secs(secs));
    }
    Ok(options
        .after_connect(|conn, _| {
            Box::pin(async move {
                for pragma in [
                    "PRAGMA busy_timeout=5000",
                    "PRAGMA query_only=ON",
                    "PRAGMA mmap_size=268435456",
                ] {
                    sqlx::query(pragma).execute(&mut *conn).await?;
                }
                Ok(())
            })
        })
        .connect(url)
        .await?)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub guest_grants: u64,
    pub server_passwords: u64,
    pub login_attempts: u64,
    pub password_attempts: u64,
    pub embeds: u64,
    pub pings: u64,
}

async fn delete_batched(db: &Db, sql: &'static str, cutoff: i64) -> sqlx::Result<u64> {
    let mut total = 0;
    loop {
        let n = sqlx::query(sql)
            .bind(cutoff)
            .bind(PURGE_BATCH)
            .execute(db)
            .await?
            .rows_affected();
        total += n;
        if n < PURGE_BATCH as u64 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

fn days(key: &str, default: i64) -> i64 {
    env_num::<i64>(key).unwrap_or(default).max(1) * 86400
}

pub fn guest_grant_ttl() -> i64 {
    days("GUEST_GRANT_DAYS", 30)
}

pub const GRANT_TOUCH_SECS: i64 = 86400;

static GRANT_TOUCHES: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(Default::default);

pub const GRANT_TOUCHES_MAX: usize = 10_000;

#[cfg(test)]
pub(crate) fn grant_touch_queued(db: &Db, grant: &str) -> bool {
    GRANT_TOUCHES
        .lock()
        .ok()
        .and_then(|touches| touches.get(&pool_key(db)).map(|set| set.contains(grant)))
        .unwrap_or(false)
}

pub fn queue_grant_touches(db: &Db, grants: impl IntoIterator<Item = String>) {
    if let Ok(mut touches) = GRANT_TOUCHES.lock() {
        let queued = touches.entry(pool_key(db)).or_default();
        for grant in grants {
            if queued.len() >= GRANT_TOUCHES_MAX {
                break;
            }
            queued.insert(grant);
        }
    }
}

pub async fn flush_grant_touches(db: &Db) -> sqlx::Result<u64> {
    let grants: Vec<String> = GRANT_TOUCHES
        .lock()
        .ok()
        .and_then(|mut touches| touches.remove(&pool_key(db)))
        .map(|set| set.into_iter().collect())
        .unwrap_or_default();
    let t = now();
    let cutoff = t - guest_grant_ttl();
    let mut total = 0;
    for (i, chunk) in grants.chunks(100).enumerate() {
        let sql = format!(
            "UPDATE guest_grants SET last_used_at = $1 WHERE last_used_at <= $2 AND (last_used_at >= $3 OR (last_used_at = 0 AND created_at >= $3)) AND \"grant\" IN ({})",
            (0..chunk.len())
                .map(|i| format!("${}", i + 4))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(t)
            .bind(t - GRANT_TOUCH_SECS)
            .bind(cutoff);
        for grant in chunk {
            query = query.bind(grant);
        }
        match query.execute(db).await {
            Ok(done) => total += done.rows_affected(),
            Err(e) => {
                queue_grant_touches(db, grants.chunks(100).skip(i).flatten().cloned());
                return Err(e);
            }
        }
    }
    Ok(total)
}

pub const SERVER_PASSWORD_KEEP: i64 = 30 * 86400;

pub const PING_KEEP: i64 = 30 * 86400;

pub async fn sweep_stale(db: &Db) -> sqlx::Result<Swept> {
    let t = now();
    let stale_grants = delete_batched(
        db,
        "DELETE FROM guest_grants WHERE \"grant\" IN (SELECT \"grant\" FROM guest_grants WHERE last_used_at < $1 AND (last_used_at > 0 OR created_at < $1) LIMIT $2)",
        t - guest_grant_ttl(),
    )
    .await?;
    let ended_grants = delete_batched(
        db,
        "DELETE FROM guest_grants WHERE \"grant\" IN (SELECT g.\"grant\" FROM guest_grants g WHERE g.password_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM server_passwords p WHERE p.id = g.password_id AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > $1)) LIMIT $2)",
        t,
    )
    .await?;
    Ok(Swept {
        guest_grants: stale_grants + ended_grants,
        server_passwords: delete_batched(
            db,
            "DELETE FROM server_passwords WHERE id IN (SELECT id FROM server_passwords WHERE revoked_at < $1 OR expires_at < $1 OR used_up_at < $1 LIMIT $2)",
            t - SERVER_PASSWORD_KEEP,
        )
        .await?,
        login_attempts: delete_batched(
            db,
            "DELETE FROM login_attempts WHERE username IN (SELECT username FROM login_attempts WHERE last_at < $1 LIMIT $2)",
            t - 2 * 86400,
        )
        .await?,
        password_attempts: delete_batched(
            db,
            "DELETE FROM change_attempts WHERE session IN (SELECT session FROM change_attempts WHERE last_at < $1 LIMIT $2)",
            t - 2 * 86400,
        )
        .await?,
        embeds: delete_batched(
            db,
            "DELETE FROM embeds WHERE url IN (SELECT e.url FROM embeds e WHERE e.fetched_at < $1 AND NOT EXISTS(SELECT 1 FROM message_embeds me WHERE me.url = e.url) LIMIT $2)",
            t - days("EMBED_CACHE_DAYS", 30),
        )
        .await?,
        pings: delete_batched(
            db,
            "DELETE FROM pings WHERE id IN (SELECT id FROM pings WHERE (seen <> 0 AND seen <> 2) OR created_at < $1 LIMIT $2)",
            t - PING_KEEP,
        )
        .await?,
    })
}

pub const PURGE_BATCH: i64 = 500;

pub async fn purge_messages(db: &Db, cond: &'static str, key: &str) -> sqlx::Result<u64> {
    let sql = format!(
        "DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE {cond} LIMIT {PURGE_BATCH})"
    );
    let mut total = 0;
    loop {
        let n = sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
            .bind(key)
            .execute(db)
            .await?
            .rows_affected();
        total += n;
        if n == 0 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{add_member, done, temp_state};

    async fn general_id(db: &Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id")
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

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value")
    }

    #[tokio::test]
    async fn reader_pool_reads_committed_writes_and_refuses_writes() {
        let (state, path) = temp_state("reader_pool").await;
        let read = state.read();
        assert!(
            sqlx::query("INSERT INTO settings(key, value) VALUES('x', '1')")
                .execute(&read)
                .await
                .is_err(),
            "reader must be query_only"
        );
        let mut tx = state.db.begin().await.expect("begin");
        sqlx::query("INSERT INTO settings(key, value) VALUES('held', '1')")
            .execute(&mut *tx)
            .await
            .expect("write in open tx");
        let started = Instant::now();
        assert_eq!(
            count(&read, "SELECT COUNT(*) FROM settings WHERE key = 'held'").await,
            0
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "readers do not wait for an open write transaction"
        );
        tx.commit().await.expect("commit");
        assert_eq!(
            count(&read, "SELECT COUNT(*) FROM settings WHERE key = 'held'").await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn triggers_keep_dm_latest_and_member_counts() {
        let (state, path) = temp_state("triggers").await;
        let db = &state.db;
        let dm: i64 = sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('a', 'b') RETURNING id")
            .fetch_one(db)
            .await
            .expect("dm")
            .try_get(0)
            .expect("id");
        let mut ids = Vec::new();
        for _ in 0..3 {
            let id: i64 = sqlx::query("INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'a', 'x', 1) RETURNING id")
                .bind(dm)
                .fetch_one(db)
                .await
                .expect("msg")
                .try_get(0)
                .expect("id");
            ids.push(id);
        }
        let latest = || async {
            count(
                db,
                &format!("SELECT last_message_id FROM dms WHERE id = {dm}"),
            )
            .await
        };
        assert_eq!(latest().await, ids[2]);
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(ids[2])
            .execute(db)
            .await
            .expect("delete latest");
        assert_eq!(latest().await, ids[1]);
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(ids[0])
            .execute(db)
            .await
            .expect("delete older");
        assert_eq!(latest().await, ids[1]);
        sqlx::query("DELETE FROM messages WHERE dm_id = $1")
            .bind(dm)
            .execute(db)
            .await
            .expect("delete all");
        assert_eq!(latest().await, 0);
        let members =
            || async { count(db, "SELECT member_count FROM servers WHERE name = 'rchat'").await };
        assert_eq!(members().await, 0);
        for name in ["x", "y", "z"] {
            add_member(db, "rchat", name, 0, 0, now()).await;
        }
        sqlx::query("INSERT INTO members(server, username, joined_at) VALUES('rchat', 'x', 1) ON CONFLICT(server, username) DO NOTHING")
            .execute(db)
            .await
            .expect("duplicate join");
        assert_eq!(members().await, 3);
        sqlx::query("DELETE FROM members WHERE server = 'rchat' AND username = 'y'")
            .execute(db)
            .await
            .expect("leave");
        assert_eq!(members().await, 2);
        sqlx::query("INSERT INTO servers(name, display_name, created_at) VALUES('old', 'Old', 1)")
            .execute(db)
            .await
            .expect("server");
        add_member(db, "old", "x", 1, 0, now()).await;
        sqlx::query("UPDATE servers SET name = 'new' WHERE name = 'old'")
            .execute(db)
            .await
            .expect("rename");
        assert_eq!(
            count(db, "SELECT member_count FROM servers WHERE name = 'new'").await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn new_columns_are_backfilled_on_existing_databases() {
        let path = std::env::temp_dir().join(format!("rchat_backfill_{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP TRIGGER messages_dm_latest_insert",
            "DROP TRIGGER messages_dm_latest_delete",
            "DROP TRIGGER members_count_insert",
            "DROP TRIGGER members_count_delete",
            "DROP INDEX idx_dms_a_latest",
            "DROP INDEX idx_dms_b_latest",
            "DROP INDEX idx_guest_grants_used",
            "ALTER TABLE dms DROP COLUMN last_message_id",
            "ALTER TABLE servers DROP COLUMN member_count",
            "ALTER TABLE guest_grants DROP COLUMN last_used_at",
            "INSERT INTO dms(user_a, user_b) VALUES('a', 'b')",
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'a', 'x', 1)",
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'b', 'y', 2)",
            "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'a', 1)",
            "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'b', 1)",
            "INSERT INTO guest_grants(\"grant\", server, created_at) VALUES('g', 'rchat', 77)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        let db = open(path.to_str()).await.expect("reopen");
        assert_eq!(
            count(&db, "SELECT last_message_id FROM dms WHERE id = 1").await,
            2
        );
        assert_eq!(
            count(&db, "SELECT member_count FROM servers WHERE name = 'rchat'").await,
            2
        );
        assert!(count(&db, "SELECT last_used_at FROM guest_grants").await >= now() - 60);
        add_member(&db, "rchat", "c", 0, 0, now()).await;
        assert_eq!(
            count(&db, "SELECT member_count FROM servers WHERE name = 'rchat'").await,
            3
        );
        close(&db).await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[tokio::test]
    async fn existing_users_get_an_empty_bio_column() {
        let path = std::env::temp_dir().join(format!("rchat_bio_col_{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE users DROP COLUMN bio",
            "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('old', 'old', '', 'text', 'identicon', 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert!(
            sqlx::query("SELECT bio FROM users")
                .fetch_all(&db)
                .await
                .is_err()
        );
        close(&db).await;
        let db = open(path.to_str()).await.expect("reopen");
        let old = get_user(&db, "old").await.expect("load").expect("old");
        assert_eq!(old.bio, None);
        sqlx::query("UPDATE users SET bio = 'hi' WHERE username = 'old'")
            .execute(&db)
            .await
            .expect("write bio");
        let old = get_user(&db, "old").await.expect("load").expect("old");
        assert_eq!(old.bio.as_deref(), Some("hi"));
        close(&db).await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[tokio::test]
    async fn existing_servers_get_empty_color_columns() {
        let path =
            std::env::temp_dir().join(format!("rchat_server_colors_{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE servers DROP COLUMN banner_color",
            "ALTER TABLE servers DROP COLUMN name_color",
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', NULL, 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert!(
            sqlx::query("SELECT banner_color FROM servers")
                .fetch_all(&db)
                .await
                .is_err()
        );
        close(&db).await;
        let db = open(path.to_str()).await.expect("reopen");
        let row = sqlx::query("SELECT banner_color, name_color FROM servers WHERE name = 'old'")
            .fetch_one(&db)
            .await
            .expect("colors");
        assert_eq!(row.try_get::<Option<String>, _>(0).expect("banner"), None);
        assert_eq!(row.try_get::<Option<String>, _>(1).expect("name"), None);
        sqlx::query("UPDATE servers SET banner_color = '#123456', name_color = '#abcdef' WHERE name = 'old'")
            .execute(&db)
            .await
            .expect("write colors");
        close(&db).await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[tokio::test]
    async fn an_interrupted_migration_still_backfills_on_the_next_boot() {
        let path = std::env::temp_dir().join(format!("rchat_migrate_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP TRIGGER messages_dm_latest_insert",
            "DROP TRIGGER messages_dm_latest_delete",
            "DROP INDEX idx_dms_a_latest",
            "DROP INDEX idx_dms_b_latest",
            "ALTER TABLE dms DROP COLUMN last_message_id",
            "INSERT INTO dms(user_a, user_b) VALUES('a', 'b')",
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'a', 'x', 1)",
            "CREATE TABLE idx_dms_a_latest(x INTEGER)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        assert!(open(path.to_str()).await.is_err());
        let raw = AnyPoolOptions::new()
            .max_connections(1)
            .connect(&format!("sqlite://{}", path.display()))
            .await
            .expect("raw");
        let cols = sqlx::query("SELECT name FROM pragma_table_info('dms')")
            .fetch_all(&raw)
            .await
            .expect("columns");
        assert!(!cols.iter().any(|r| {
            r.try_get::<String, _>(0)
                .is_ok_and(|c| c == "last_message_id")
        }));
        sqlx::query("DROP TABLE idx_dms_a_latest")
            .execute(&raw)
            .await
            .expect("unblock");
        raw.close().await;
        let db = open(path.to_str()).await.expect("reopen");
        assert_eq!(
            count(&db, "SELECT last_message_id FROM dms WHERE id = 1").await,
            1
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn server_passwords_migrate_onto_an_old_database() {
        let path = std::env::temp_dir().join(format!("rchat_pw_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_guest_grants_password",
            "DROP INDEX idx_server_passwords_server",
            "DROP TABLE server_passwords",
            "ALTER TABLE members DROP COLUMN joined_via",
            "ALTER TABLE guest_grants DROP COLUMN password_id",
            "DELETE FROM settings WHERE key = 'password_pepper'",
            "UPDATE settings SET value = 'old-instance' WHERE key = 'instance_id'",
            "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('club', 'Club', 'alice', 'hash', 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', 'alice', 1, 0, 5)",
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g', 'club', 1, 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        let mut peppers = Vec::new();
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM members WHERE server = 'club' AND username = 'alice' AND joined_via IS NULL AND joined_at = 5 AND is_admin = 1").await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = 'g' AND password_id IS NULL AND last_used_at = 1").await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM servers WHERE name = 'club' AND password_hash = 'hash' AND member_count = 1").await,
                1
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM server_passwords").await, 0);
            sqlx::query("INSERT INTO server_passwords(server, hash, lookup, created_at) VALUES('club', 'h', 'l', 1)")
                .execute(&db)
                .await
                .expect("new table");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM server_passwords WHERE uses = 0 AND label IS NULL AND expires_at IS NULL AND max_uses IS NULL AND revoked_at IS NULL AND used_up_at IS NULL").await,
                1
            );
            sqlx::query("DELETE FROM server_passwords")
                .execute(&db)
                .await
                .expect("clear");
            let instance: String =
                sqlx::query("SELECT value FROM settings WHERE key = 'instance_id'")
                    .fetch_one(&db)
                    .await
                    .expect("instance")
                    .try_get(0)
                    .expect("value");
            assert_eq!(instance, "old-instance");
            let p = pepper(&db).await.expect("pepper");
            assert_eq!(p.len(), 64);
            peppers.push(p);
            close(&db).await;
        }
        assert_eq!(peppers[0], peppers[1], "the pepper is inserted once");
        wipe();
    }

    #[tokio::test]
    async fn pings_table_is_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_ping_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_pings_user",
            "DROP INDEX idx_pings_message",
            "DROP INDEX idx_pings_created",
            "DROP INDEX idx_pings_seen",
            "DROP INDEX idx_pings_actor",
            "DROP TABLE pings",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'hi @bob', 7)",
            "INSERT INTO read_state(username, scope, last_read) VALUES('bob', 'c1', 3)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'pings'"
            )
            .await,
            0
        );
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'hi @bob' AND created_at = 7").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM read_state WHERE username = 'bob' AND last_read = 3"
                )
                .await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_pings_%'").await,
                5
            );
            sqlx::query("INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at) SELECT 'bob', 'mention', 'c' || channel_id, 'rchat', id, 'alice', 8 FROM messages WHERE author = 'alice'")
                .execute(&db)
                .await
                .expect("ping on an old message");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM pings WHERE seen = 0 AND emoji IS NULL AND thread_root_id IS NULL AND kind = 'mention'").await,
                1
            );
            assert!(
                sqlx::query("INSERT INTO pings(username, kind, scope, message_id, actor, created_at) VALUES('bob', 'other', 'c1', 1, 'alice', 8)")
                    .execute(&db)
                    .await
                    .is_err(),
                "kind is checked"
            );
            sqlx::query("DELETE FROM pings")
                .execute(&db)
                .await
                .expect("clear");
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        for stmt in [
            "DROP TABLE pings",
            "CREATE TABLE pings(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('mention','reply','reaction')), scope TEXT NOT NULL, server TEXT REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, actor TEXT NOT NULL, emoji TEXT, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)",
            "INSERT INTO pings(username, kind, scope, message_id, actor, created_at) SELECT 'bob', 'mention', 'c1', id, 'alice', 9 FROM messages WHERE author = 'alice'",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("add thread_root_id");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM pings WHERE created_at = 9 AND thread_root_id IS NULL AND seen = 0").await,
                1,
                "a pings table without thread_root_id gains the column"
            );
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn edited_at_is_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_edit_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE messages DROP COLUMN edited_at",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'edited_at'"
            )
            .await,
            0
        );
        close(&db).await;
        for round in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'edited_at'"
                )
                .await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND created_at = 7"
                )
                .await,
                1
            );
            let old: i64 =
                sqlx::query("SELECT id FROM messages WHERE author = 'alice' AND created_at = 7")
                    .fetch_one(&db)
                    .await
                    .expect("old")
                    .try_get(0)
                    .expect("id");
            let loaded =
                crate::api::messages::load_message(&db, old, crate::api::messages::Quotes::Skip)
                    .await
                    .expect("load")
                    .expect("old message");
            match round {
                0 => {
                    assert_eq!(loaded.content, "old message");
                    assert_eq!(loaded.edited_at, None);
                    sqlx::query(
                        "UPDATE messages SET content = 'edited old', edited_at = 9 WHERE id = $1",
                    )
                    .bind(old)
                    .execute(&db)
                    .await
                    .expect("edit an old message");
                }
                _ => {
                    assert_eq!(loaded.content, "edited old");
                    assert_eq!(loaded.edited_at, Some(9), "the edit survives a restart");
                }
            }
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn reply_columns_are_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_reply_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE messages DROP COLUMN reply_mention",
            "ALTER TABLE messages DROP COLUMN reply_to",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name IN ('reply_to', 'reply_mention')").await,
            0
        );
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7 AND reply_to IS NULL AND reply_mention = 0").await,
                1
            );
            let old: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'old message'")
                .fetch_one(&db)
                .await
                .expect("old")
                .try_get(0)
                .expect("id");
            let loaded = crate::api::messages::load_message(
                &db,
                old,
                crate::api::messages::Quotes::Since(None),
            )
            .await
            .expect("load")
            .expect("old message");
            assert!(loaded.reply_to.is_none());
            sqlx::query("INSERT INTO messages(channel_id, author, content, reply_to, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'bob', 'new reply', $1, 8)")
                .bind(old)
                .execute(&db)
                .await
                .expect("reply to an old message");
            let reply: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'new reply'")
                .fetch_one(&db)
                .await
                .expect("reply")
                .try_get(0)
                .expect("id");
            let quoted = crate::api::messages::load_message(
                &db,
                reply,
                crate::api::messages::Quotes::Since(None),
            )
            .await
            .expect("load")
            .expect("reply")
            .reply_to
            .expect("quote");
            assert_eq!(quoted.id, old);
            assert_eq!(quoted.content, "old message");
            assert!(!quoted.deleted && !quoted.mention);
            sqlx::query("DELETE FROM messages WHERE content = 'new reply'")
                .execute(&db)
                .await
                .expect("clear");
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn reactions_table_is_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_reaction_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_reactions_message",
            "DROP INDEX idx_reactions_username",
            "DROP TABLE reactions",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
            "INSERT INTO pings(username, kind, scope, message_id, actor, created_at) SELECT 'alice', 'mention', 'c1', id, 'bob', 8 FROM messages WHERE content = 'old message'",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'reactions'"
            )
            .await,
            0
        );
        close(&db).await;
        for round in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM pings WHERE username = 'alice' AND created_at = 8"
                )
                .await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_reactions_%'").await,
                2
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM reactions").await,
                round,
                "rows survive a restart"
            );
            if round == 0 {
                sqlx::query("INSERT INTO reactions(message_id, username, emoji, created_at) SELECT id, 'bob', '👍', 9 FROM messages WHERE content = 'old message'")
                    .execute(&db)
                    .await
                    .expect("react to an old message");
                assert!(
                    sqlx::query("INSERT INTO reactions(message_id, username, emoji, created_at) SELECT id, 'bob', '👍', 10 FROM messages WHERE content = 'old message'")
                        .execute(&db)
                        .await
                        .is_err(),
                    "one row per user and emoji"
                );
            }
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        sqlx::query("DELETE FROM messages WHERE content = 'old message'")
            .execute(&db)
            .await
            .expect("delete");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM reactions").await,
            0,
            "cascade"
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn dead_server_passwords_are_purged_after_30_days() {
        let (state, path) = temp_state("sweep_passwords").await;
        let db = &state.db;
        sqlx::query("UPDATE servers SET password_hash = '!none' WHERE name = 'rchat'")
            .execute(db)
            .await
            .expect("protect");
        let t = now();
        let old = t - SERVER_PASSWORD_KEEP - 10;
        let recent = t - 86400;
        let mut ids = Vec::new();
        for (expires, revoked, used_up) in [
            (Some(old), None, None),
            (None, Some(old), None),
            (None, None, Some(old)),
            (Some(recent), None, None),
            (None, Some(recent), None),
            (None, None, None),
        ] {
            let id: i64 = sqlx::query("INSERT INTO server_passwords(server, hash, lookup, created_at, expires_at, revoked_at, used_up_at) VALUES('rchat', 'h', $1, 0, $2, $3, $4) RETURNING id")
                .bind(format!("l{}", ids.len()))
                .bind(expires)
                .bind(revoked)
                .bind(used_up)
                .fetch_one(db)
                .await
                .expect("password")
                .try_get(0)
                .expect("id");
            ids.push(id);
        }
        for (grant, id) in [("dead", ids[4]), ("live", ids[5])] {
            sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id) VALUES($1, 'rchat', $2, $2, $3)")
                .bind(grant)
                .bind(t)
                .bind(id)
                .execute(db)
                .await
                .expect("grant");
        }
        let swept = sweep_stale(db).await.expect("sweep");
        assert_eq!((swept.server_passwords, swept.guest_grants), (3, 1));
        assert_eq!(count(db, "SELECT COUNT(*) FROM server_passwords").await, 3);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = 'live'"
            )
            .await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn in_memory_databases_read_from_the_writer() {
        let db = open(Some("sqlite::memory:")).await.expect("memory");
        sqlx::query("INSERT INTO settings(key, value) VALUES('probe', '1')")
            .execute(&db)
            .await
            .expect("write");
        let state = crate::state::AppState::new(
            db.clone(),
            crate::ws::Hub::new(),
            None,
            None,
            crate::instance::Instance::ephemeral(),
        );
        assert_eq!(
            count(
                &state.read(),
                "SELECT COUNT(*) FROM settings WHERE key = 'probe'"
            )
            .await,
            1
        );
        close(&db).await;
    }

    #[tokio::test]
    async fn purge_deletes_in_batches() {
        let (state, path) = temp_state("purge_batches").await;
        let db = &state.db;
        let cid = general_id(db).await;
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1203) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, CASE WHEN i % 3 = 0 THEN 'keep' ELSE 'gone' END, 'x', i FROM n")
            .bind(cid)
            .execute(db)
            .await
            .expect("seed");
        let purged = purge_messages(db, "author = $1", "gone")
            .await
            .expect("purge");
        assert_eq!(purged, 802);
        assert_eq!(count(db, "SELECT COUNT(*) FROM messages").await, 401);
        done(state, path).await;
    }

    #[test]
    fn sqlite_keeps_one_writer_and_trigger_versions_track_definitions() {
        assert_eq!(writer_connections(true, Some(8)), 1);
        assert_eq!(writer_connections(true, None), 1);
        assert_eq!(writer_connections(false, Some(20)), 20);
        assert_eq!(writer_connections(false, None), 8);
        let v = trigger_version(POSTGRES_TRIGGERS);
        assert_eq!(v, trigger_version(POSTGRES_TRIGGERS));
        assert_eq!(v.len(), 16);
        assert_ne!(v, trigger_version(&POSTGRES_TRIGGERS[1..]));
    }

    #[tokio::test]
    async fn stale_rows_are_swept() {
        let (state, path) = temp_state("sweep_stale").await;
        let db = &state.db;
        let t = now();
        let old = t - 200 * 86400;
        for (sql, at) in [
            (
                "INSERT INTO tokens(token, username, created_at) VALUES('ancient', 'a', $1)",
                old,
            ),
            (
                "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g1', 'rchat', $1, $1)",
                old,
            ),
            (
                "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g2', 'rchat', $1, $1)",
                t,
            ),
            (
                "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g3', 'rchat', $1, $1 + 86400 * 199)",
                old,
            ),
            (
                "INSERT INTO login_attempts(username, day, count, last_at) VALUES('a', '1', 1, $1)",
                old,
            ),
            (
                "INSERT INTO change_attempts(session, day, failures, last_at) VALUES('a', '1', 1, $1)",
                old,
            ),
            (
                "INSERT INTO change_attempts(session, day, failures, last_at) VALUES('b', '1', 1, $1)",
                t,
            ),
            (
                "INSERT INTO embeds(url, fetched_at) VALUES('https://old.example/', $1)",
                old,
            ),
            (
                "INSERT INTO embeds(url, fetched_at) VALUES('https://kept.example/', $1)",
                old,
            ),
        ] {
            sqlx::query(sql).bind(at).execute(db).await.expect(sql);
        }
        let cid = general_id(db).await;
        let mid: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'a', 'x', 1) RETURNING id")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("msg")
            .try_get(0)
            .expect("id");
        sqlx::query("INSERT INTO message_embeds(message_id, ord, url) VALUES($1, 0, 'https://kept.example/')")
            .bind(mid)
            .execute(db)
            .await
            .expect("embed ref");
        for (seen, at) in [(1, t), (0, old), (0, t)] {
            sqlx::query("INSERT INTO pings(username, kind, scope, message_id, actor, created_at, seen) VALUES('b', 'mention', 'c1', $1, 'a', $2, $3)")
                .bind(mid)
                .bind(at)
                .bind(seen)
                .execute(db)
                .await
                .expect("ping");
        }
        let swept = sweep_stale(db).await.expect("sweep");
        assert_eq!(
            swept,
            Swept {
                guest_grants: 1,
                server_passwords: 0,
                login_attempts: 1,
                password_attempts: 1,
                embeds: 1,
                pings: 2,
            }
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM tokens WHERE token = 'ancient'").await,
            1
        );
        assert_eq!(count(db, "SELECT COUNT(*) FROM guest_grants").await, 2);
        assert_eq!(count(db, "SELECT COUNT(*) FROM embeds").await, 1);
        assert_eq!(
            count(
                db,
                &format!("SELECT COUNT(*) FROM pings WHERE seen = 0 AND created_at = {t}")
            )
            .await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn interaction_touches_are_coalesced() {
        let (state, path) = temp_state("touch_coalesce").await;
        let db = &state.db;
        touch_interaction(db, "rchat", "a").await.expect("touch");
        sqlx::query("UPDATE interactions SET last_at = 5")
            .execute(db)
            .await
            .expect("age");
        touch_interaction(db, "rchat", "a")
            .await
            .expect("touch again");
        assert_eq!(count(db, "SELECT last_at FROM interactions").await, 5);
        touch_interaction(db, "rchat", "b")
            .await
            .expect("other user");
        assert_eq!(count(db, "SELECT COUNT(*) FROM interactions").await, 2);
        done(state, path).await;
    }
}
