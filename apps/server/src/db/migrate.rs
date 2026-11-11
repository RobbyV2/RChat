use std::collections::HashMap;

use sha2::{Digest, Sha256};
use sqlx::{AnyConnection, Row};

use super::schema::{POSTGRES_SCHEMA, POSTGRES_TRIGGERS, SQLITE_SCHEMA, SQLITE_TRIGGERS};
use super::secrets::secret_key;
use super::{NO_EXTRA_HASH, now};
use crate::api::access::perms::{ALL_PERMS, PRE_REPORT_PERMS, Perm};
use crate::api::controls::{Control, ControlSeeds};

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
    ("messages", "fwd_author TEXT"),
    ("messages", "fwd_created_at {INT}"),
    ("messages", "fwd_source_id {INT}"),
    ("messages", "fwd_origin TEXT"),
    ("messages", "fwd_dropped TEXT"),
    ("messages", "pinned_at {INT}"),
    ("messages", "pinned_by TEXT"),
    ("messages", "pin_message_id {INT}"),
    ("servers", "system_channel_id {INT}"),
    ("servers", "join_messages {INT} NOT NULL DEFAULT 1"),
    ("servers", "leave_messages {INT} NOT NULL DEFAULT 1"),
    ("channels", "restrict_view {INT} NOT NULL DEFAULT 0"),
    ("channels", "restrict_send {INT} NOT NULL DEFAULT 0"),
    ("messages", "media_sha256 TEXT"),
    ("channel_perms", "restrict_set {INT} NOT NULL DEFAULT 0"),
    ("guest_grants", "network TEXT"),
    ("messages", "call_kind TEXT"),
    ("messages", "call_video {INT}"),
    ("channels", "topic TEXT"),
    ("channels", "category_id {INT}"),
    ("channels", "position {INT} NOT NULL DEFAULT 0"),
    ("servers", "layout_version {INT} NOT NULL DEFAULT 0"),
    ("roles", "mentionable {INT} NOT NULL DEFAULT 0"),
    ("messages", "group_mentions TEXT"),
    ("audit_log", "actor TEXT"),
    ("audit_log", "staff {INT} NOT NULL DEFAULT 0"),
    ("audit_log", "target_kind TEXT"),
    ("audit_log", "target_id {INT}"),
    ("audit_log", "target_name TEXT"),
    ("audit_log", "target_staff {INT} NOT NULL DEFAULT 0"),
    ("audit_log", "details TEXT NOT NULL DEFAULT '{}'"),
    ("users", "presence_seq {INT} NOT NULL DEFAULT 0"),
    ("dms", "closed_a {INT} NOT NULL DEFAULT 0"),
    ("dms", "closed_b {INT} NOT NULL DEFAULT 0"),
    ("polls", "version {INT} NOT NULL DEFAULT 0"),
    ("bulk_delete_jobs", "channel_id {INT}"),
    (
        "bulk_delete_jobs",
        "status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','cancelled','failed'))",
    ),
    ("bulk_delete_jobs", "except_ids TEXT NOT NULL DEFAULT '[]'"),
    ("bulk_delete_jobs", "after_id {INT} NOT NULL DEFAULT 0"),
    ("bulk_delete_jobs", "upto_id {INT} NOT NULL DEFAULT 0"),
    ("bulk_delete_jobs", "cursor_id {INT} NOT NULL DEFAULT 0"),
    ("bulk_delete_jobs", "estimate {INT} NOT NULL DEFAULT 0"),
    ("bulk_delete_jobs", "deleted {INT} NOT NULL DEFAULT 0"),
    ("bulk_delete_jobs", "skipped {INT} NOT NULL DEFAULT 0"),
    ("bulk_delete_jobs", "authors TEXT NOT NULL DEFAULT '{}'"),
    ("bulk_delete_jobs", "staff {INT} NOT NULL DEFAULT 0"),
    ("bulk_delete_jobs", "author_filter TEXT"),
    ("bulk_delete_jobs", "audit_id {INT}"),
    ("bulk_delete_jobs", "error TEXT"),
    ("bulk_delete_jobs", "claimed_at {INT} NOT NULL DEFAULT 0"),
    ("bulk_delete_jobs", "finished_at {INT}"),
    ("messages", "webhook_id {INT}"),
    ("messages", "webhook_name TEXT"),
    ("messages", "webhook_avatar TEXT"),
    ("messages", "webhook_embeds TEXT"),
    ("media", "charged_to TEXT"),
    ("media", "charged_server TEXT"),
    ("users", "recovery_pub TEXT"),
    ("users", "recovery_set_at {INT}"),
    ("servers", "upload_expiry {INT}"),
    ("media", "ttl {INT}"),
    ("media", "kept_by TEXT"),
    ("servers", "upload_expiry_by TEXT"),
    ("users", "username_key TEXT"),
    ("users", "username_key_alt TEXT"),
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
    (
        "channel_perms",
        "restrict_set",
        "UPDATE channel_perms SET restrict_set = 1 WHERE EXISTS(SELECT 1 FROM settings WHERE key = 'restrict_backfill_v1')",
    ),
    (
        "channels",
        "position",
        "UPDATE channels SET position = (SELECT COUNT(*) FROM channels c WHERE c.server = channels.server AND ((c.kind = 'text' AND channels.kind <> 'text') OR (c.kind = channels.kind AND c.id < channels.id)))",
    ),
    (
        "media",
        "kept_by",
        "UPDATE media SET kept_by = (SELECT c.server FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.media_id = media.id AND m.media_kind = 'server' AND m.media_removed = 0 AND m.fwd_created_at IS NULL ORDER BY m.id LIMIT 1) WHERE ttl = 0 OR ttl > 86400",
    ),
    (
        "servers",
        "upload_expiry_by",
        "UPDATE servers SET upload_expiry_by = creator WHERE (upload_expiry = 0 OR upload_expiry > 86400) AND EXISTS(SELECT 1 FROM users u WHERE u.username = servers.creator AND u.password_hash <> '!purging' AND u.created_at <= servers.created_at + 600)",
    ),
];

const RESTRICT_BACKFILL: &str = "restrict_backfill_v1";

/// Set once the names of deleted accounts were cleared from `servers.creator`, `media.charged_to`
/// and `here_pings`: names no account has, and names registered again more than ten minutes after
/// the row was made. Since then the purge of an account clears them with it.
const CREATOR_CLEANUP: &str = "creator_cleanup_v1";

/// The newest schema this binary knows. Raise it with every schema change (new tables, columns,
/// indexes or data conversions), or older binaries of this line keep starting on a database they
/// do not understand. A database marked with a newer version was upgraded by a newer binary,
/// and this one refuses to start on it.
/// 1: hashed secrets and the 0.3.0 indexes. 2: `channel_perms.restrict_set` and
/// `guest_grants.network`. 3: channel categories and channel positions. 4: group mentions
/// (`group_pings`, `here_pings`, `roles.mentionable`, `messages.group_mentions`) and the Mention
/// everyone permission bit. 5: the audit log (`audit_log`) and the View audit log permission bit.
/// 6: `users.presence_seq`, the version of the appear-offline setting. 7: timeouts
/// (`member_timeouts`) and the Timeout members permission bit.
/// 8: `dms.closed_a` and `dms.closed_b`.
/// 9: `blocks`.
/// 10: `friends`, `friend_requests`, `friend_pings` and `privacy`.
/// 11: polls (`polls`, `poll_options`, `poll_votes`, `poll_snapshots`).
/// 12: `group_pings_read` (group mentions marked read in the inbox) and the
/// `group_pings(server, created_at, message_id)` index.
/// 13: bulk delete jobs (`bulk_delete_jobs`).
/// 14: webhooks (`webhooks`, `outgoing_webhooks`, `webhook_deliveries`, the `messages.webhook_*`
/// columns) and the Manage webhooks permission bit.
/// 15: `preview_images` (the cache of link preview images served by the instance).
/// 16: `media.charged_to` and `media.charged_server` (webhook uploads count against the
/// webhook's owner and its server's webhooks).
/// 17: stored names of uploaded files cleaned like new uploads (`messages.media_filename`).
/// 18: the Manage reports permission bit.
/// 19: recovery phrase columns (`users.recovery_pub`, `users.recovery_set_at`) and
/// `recovery_challenges`.
/// 20: the instance audit log (`instance_audit`).
/// 21: per-server upload expiry (`servers.upload_expiry`), `media.ttl` with its sweep and cap
/// indexes, and the `messages_media_release` trigger.
/// 22: `media.kept_by` (a file kept longer than the default counts against its server),
/// `servers.upload_expiry_by` (the account charged for a server's longer choice), their indexes
/// and the indexes of the upload budget sums.
/// 23: the look-alike keys of usernames (`users.username_key`, `users.username_key_alt`).
pub const SCHEMA_VERSION: i64 = 23;

/// Indexes on columns that `MIGRATIONS` may add, created after `reconcile_columns`.
pub(super) fn late_indexes(is_sqlite: bool) -> [&'static str; 19] {
    [
        "CREATE INDEX IF NOT EXISTS idx_users_username_key ON users(username_key)",
        "CREATE INDEX IF NOT EXISTS idx_users_username_key_alt ON users(username_key_alt)",
        "CREATE INDEX IF NOT EXISTS idx_server_passwords_revoked ON server_passwords(revoked_at) WHERE revoked_at IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_server_passwords_expires ON server_passwords(expires_at) WHERE expires_at IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_server_passwords_used_up ON server_passwords(used_up_at) WHERE used_up_at IS NOT NULL",
        match is_sqlite {
            true => {
                "CREATE INDEX IF NOT EXISTS idx_users_display_lower ON users(lower(display_name))"
            }
            false => {
                "CREATE INDEX IF NOT EXISTS idx_users_display_lower ON users((lower(display_name) COLLATE \"C\"))"
            }
        },
        "CREATE INDEX IF NOT EXISTS idx_reactions_agg ON reactions(message_id, emoji, created_at, username)",
        "CREATE INDEX IF NOT EXISTS idx_pings_kept ON pings(username, id) WHERE seen <> 0",
        "CREATE INDEX IF NOT EXISTS idx_messages_system_channel ON messages(channel_id, created_at) WHERE kind IN ('join','leave')",
        "CREATE INDEX IF NOT EXISTS idx_messages_pin_notice ON messages(pin_message_id, created_at) WHERE kind = 'pin'",
        "CREATE INDEX IF NOT EXISTS idx_guest_grants_network ON guest_grants(server, network) WHERE network IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_media_default_expiry ON media(uploaded_at) WHERE ttl IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_media_timed_expiry ON media((uploaded_at + ttl)) WHERE ttl > 0",
        "CREATE INDEX IF NOT EXISTS idx_media_kept ON media(ttl) WHERE ttl IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_media_kept_by ON media(kept_by, size) WHERE kept_by IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_media_uploader ON media(uploader, uploaded_at)",
        "CREATE INDEX IF NOT EXISTS idx_media_charged_to ON media(charged_to, uploaded_at) WHERE charged_to IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_media_charged_server ON media(charged_server, uploaded_at) WHERE charged_server IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_servers_upload_expiry_by ON servers(upload_expiry_by) WHERE upload_expiry_by IS NOT NULL",
    ]
}

async fn stored_setting(conn: &mut AnyConnection, key: &str) -> sqlx::Result<Option<String>> {
    sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.try_get(0))
        .transpose()
}

async fn store_setting(conn: &mut AnyConnection, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

async fn seed_setting(conn: &mut AnyConnection, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING")
        .bind(key)
        .bind(value)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

pub(super) async fn schema_version(conn: &mut AnyConnection) -> anyhow::Result<i64> {
    let have = stored_setting(conn, "schema_version").await?;
    Ok(have.and_then(|v| v.trim().parse().ok()).unwrap_or(0))
}

const HASH_BATCH: i64 = 500;

/// Replaces stored session tokens and guest grants that are still raw with their
/// `secret_key`. Keyed on the stored form, so rows that an older binary writes are converted
/// on the next start. The clients keep their raw values, which still match.
async fn hash_stored_secrets(conn: &mut AnyConnection) -> anyhow::Result<()> {
    for (table, col) in [("tokens", "token"), ("guest_grants", "\"grant\"")] {
        let mut total = 0;
        loop {
            let sql = format!(
                "SELECT {col} FROM {table} WHERE substr({col}, 1, 2) <> 'h:' LIMIT {HASH_BATCH}"
            );
            let raw: Vec<String> = sqlx::query(sqlx::AssertSqlSafe(sql))
                .fetch_all(&mut *conn)
                .await?
                .iter()
                .map(|r| r.try_get(0))
                .collect::<Result<_, _>>()?;
            if raw.is_empty() {
                break;
            }
            let update = format!("UPDATE {table} SET {col} = $1 WHERE {col} = $2");
            for value in &raw {
                sqlx::query(sqlx::AssertSqlSafe(update.clone()))
                    .bind(secret_key(value))
                    .bind(value)
                    .execute(&mut *conn)
                    .await?;
            }
            total += raw.len();
        }
        if total > 0 {
            tracing::info!("hashed {total} stored {table} rows");
        }
    }
    Ok(())
}

/// Stores the look-alike keys (`names::username_keys`) of usernames that have none: accounts
/// from before the columns existed. Keyed on the stored form, so an account that was written
/// without keys gets them on the next start. Keys made by another `names::KEY_VERSION` are all
/// made again.
async fn key_usernames(conn: &mut AnyConnection) -> anyhow::Result<()> {
    const VERSION: &str = "username_key_version";
    let current = crate::api::names::KEY_VERSION.to_string();
    if stored_setting(conn, VERSION).await?.as_deref() != Some(current.as_str()) {
        sqlx::query(
            "UPDATE users SET username_key = NULL, username_key_alt = NULL WHERE username_key IS NOT NULL",
        )
        .execute(&mut *conn)
        .await?;
        store_setting(conn, VERSION, &current).await?;
    }
    let mut total = 0;
    loop {
        let names: Vec<String> =
            sqlx::query("SELECT username FROM users WHERE username_key IS NULL LIMIT 500")
                .fetch_all(&mut *conn)
                .await?
                .iter()
                .map(|r| r.try_get(0))
                .collect::<Result<_, _>>()?;
        if names.is_empty() {
            break;
        }
        for name in &names {
            let (key, alt) = crate::api::names::username_keys(name);
            sqlx::query(
                "UPDATE users SET username_key = $1, username_key_alt = $2 WHERE username = $3",
            )
            .bind(key)
            .bind(alt)
            .bind(name)
            .execute(&mut *conn)
            .await?;
        }
        total += names.len();
    }
    if total > 0 {
        tracing::info!("stored the name keys of {total} usernames");
    }
    Ok(())
}

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

/// Every permission before `MentionEveryone` existed.
const OLD_ALL_PERMS: i64 = 31;
/// Every permission before `ViewAuditLog` existed.
const PRE_AUDIT_PERMS: i64 = 63;
/// Every permission before `TimeoutMembers` existed.
const PRE_TIMEOUT_PERMS: i64 = 127;
/// Every permission before `ManageWebhooks` existed.
const PRE_WEBHOOK_PERMS: i64 = 255;

pub fn trigger_version(stmts: &[&str]) -> String {
    let hash = Sha256::digest(stmts.join(";\n").as_bytes());
    hash.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

async fn postgres_triggers(conn: &mut AnyConnection) -> anyhow::Result<()> {
    let want = trigger_version(POSTGRES_TRIGGERS);
    if stored_setting(conn, "trigger_version").await?.as_deref() == Some(want.as_str()) {
        return Ok(());
    }
    for stmt in POSTGRES_TRIGGERS {
        sqlx::query(*stmt).execute(&mut *conn).await?;
    }
    store_setting(conn, "trigger_version", &want).await?;
    tracing::info!("installed database triggers version {want}");
    Ok(())
}

pub(super) async fn init_schema(
    conn: &mut AnyConnection,
    is_sqlite: bool,
    controls: Option<&ControlSeeds>,
) -> anyhow::Result<ConfigStart> {
    let schema = match is_sqlite {
        true => SQLITE_SCHEMA,
        false => POSTGRES_SCHEMA,
    };
    let (tables, rest): (Vec<&str>, Vec<&str>) = schema
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .partition(|s| s.starts_with("CREATE TABLE"));
    sqlx::query("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .execute(&mut *conn)
        .await?;
    let version = schema_version(conn).await?;
    if version > SCHEMA_VERSION {
        anyhow::bail!(
            "the database has schema version {version}, but this build only knows version {SCHEMA_VERSION}. A newer release upgraded it. Run that release or a newer one"
        );
    }
    for stmt in tables {
        sqlx::query(stmt).execute(&mut *conn).await?;
    }
    let added = reconcile_columns(conn, is_sqlite).await?;
    for stmt in rest {
        sqlx::query(stmt).execute(&mut *conn).await?;
    }
    for stmt in late_indexes(is_sqlite) {
        sqlx::query(stmt).execute(&mut *conn).await?;
    }
    hash_stored_secrets(conn).await?;
    key_usernames(conn).await?;
    sqlx::query("UPDATE server_passwords SET hash = $1 WHERE hash <> $1")
        .bind(NO_EXTRA_HASH)
        .execute(&mut *conn)
        .await?;
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
    if stored_setting(conn, RESTRICT_BACKFILL).await?.is_none() {
        let n = sqlx::query("UPDATE channels SET restrict_view = 1 WHERE restrict_view = 0 AND EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = channels.id)")
            .execute(&mut *conn)
            .await?
            .rows_affected();
        seed_setting(conn, RESTRICT_BACKFILL, "1").await?;
        tracing::info!("backfilled channels.restrict_view on {n} channels with rules");
    }
    if stored_setting(conn, CREATOR_CLEANUP).await?.is_none() {
        let servers = sqlx::query("UPDATE servers SET creator = NULL WHERE creator IS NOT NULL AND NOT EXISTS(SELECT 1 FROM users u WHERE u.username = servers.creator AND u.created_at <= servers.created_at + 600)")
            .execute(&mut *conn)
            .await?
            .rows_affected();
        let files = sqlx::query("UPDATE media SET charged_to = NULL WHERE charged_to IS NOT NULL AND NOT EXISTS(SELECT 1 FROM users u WHERE u.username = media.charged_to AND u.created_at <= media.uploaded_at + 600)")
            .execute(&mut *conn)
            .await?
            .rows_affected();
        let pings = sqlx::query("DELETE FROM here_pings WHERE NOT EXISTS(SELECT 1 FROM users u JOIN group_pings g ON g.id = here_pings.ping_id WHERE u.username = here_pings.username AND u.created_at <= g.created_at + 600)")
            .execute(&mut *conn)
            .await?
            .rows_affected();
        seed_setting(conn, CREATOR_CLEANUP, "1").await?;
        if servers + files + pings > 0 {
            tracing::info!(
                "cleared the creator of {servers} servers, the owner of {files} webhook files and {pings} @here pings left by deleted accounts"
            );
        }
    }
    restrict_old_rules(conn).await?;
    if version < 4 {
        let n = sqlx::query("UPDATE members SET perms = $1 WHERE is_admin <> 0 AND perms = $2")
            .bind(PRE_AUDIT_PERMS)
            .bind(OLD_ALL_PERMS)
            .execute(&mut *conn)
            .await?
            .rows_affected();
        if n > 0 {
            tracing::info!("gave {n} admins with every permission the Mention everyone permission");
        }
    }
    if version < 5 {
        let n = sqlx::query("UPDATE members SET perms = $1 WHERE is_admin <> 0 AND perms = $2")
            .bind(PRE_TIMEOUT_PERMS)
            .bind(PRE_AUDIT_PERMS)
            .execute(&mut *conn)
            .await?
            .rows_affected();
        if n > 0 {
            tracing::info!("gave {n} admins with every permission the View audit log permission");
        }
    }
    if version < 7 {
        let n = sqlx::query("UPDATE members SET perms = $1 WHERE is_admin <> 0 AND perms = $2")
            .bind(PRE_WEBHOOK_PERMS)
            .bind(PRE_TIMEOUT_PERMS)
            .execute(&mut *conn)
            .await?
            .rows_affected();
        if n > 0 {
            tracing::info!("gave {n} admins with every permission the Timeout members permission");
        }
    }
    if version < 12 {
        sqlx::query("DELETE FROM pings WHERE seen = 3")
            .execute(&mut *conn)
            .await?;
    }
    if version < 14 {
        let n = sqlx::query("UPDATE members SET perms = $1 WHERE is_admin <> 0 AND perms = $2")
            .bind(PRE_REPORT_PERMS)
            .bind(PRE_WEBHOOK_PERMS)
            .execute(&mut *conn)
            .await?
            .rows_affected();
        if n > 0 {
            tracing::info!("gave {n} admins with every permission the Manage webhooks permission");
        }
    }
    if version < 17 {
        clean_file_names(conn).await?;
    }
    if version < 18 {
        grant_manage_reports(conn).await?;
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
    let started = match controls {
        Some(controls) => apply_controls(conn, controls).await?,
        None => ConfigStart::default(),
    };
    for (key, value) in [
        ("instance_id", crate::identity::random_id()),
        ("instance_signing_key", crate::identity::new_seed()),
        ("password_pepper", crate::api::auth::new_token()),
        ("relay_secret", crate::api::auth::new_token()),
        ("p2p_secret", crate::api::auth::new_token()),
    ] {
        seed_setting(conn, key, &value).await?;
    }
    store_setting(conn, "schema_version", &SCHEMA_VERSION.to_string()).await?;
    Ok(started)
}

/// Gives Manage reports to admins with every permission, and to every admin permission set and
/// role that includes Kick.
async fn grant_manage_reports(conn: &mut AnyConnection) -> anyhow::Result<()> {
    let (reports, kick) = (Perm::ManageReports as i64, Perm::Kick as i64);
    let n = sqlx::query("UPDATE members SET perms = $1 WHERE is_admin <> 0 AND perms = $2")
        .bind(ALL_PERMS)
        .bind(PRE_REPORT_PERMS)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if n > 0 {
        tracing::info!("gave {n} admins with every permission the Manage reports permission");
    }
    let n = sqlx::query("UPDATE members SET perms = perms | $1 WHERE is_admin <> 0 AND perms <> 0 AND (perms & $2) <> 0 AND (perms & $1) = 0")
        .bind(reports)
        .bind(kick)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if n > 0 {
        tracing::info!("gave {n} admins with Kick the Manage reports permission");
    }
    let n = sqlx::query(
        "UPDATE roles SET perms = perms | $1 WHERE (perms & $2) <> 0 AND (perms & $1) = 0",
    )
    .bind(reports)
    .bind(kick)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if n > 0 {
        tracing::info!("gave {n} roles with Kick the Manage reports permission");
    }
    Ok(())
}

/// Names of files uploaded before 0.3.0 were stored as sent. Cleans them like new uploads
/// (`media::clean_filename`: no control or bidi override characters, at most 255 bytes). P2P
/// file names stay as their sender wrote them.
async fn clean_file_names(conn: &mut AnyConnection) -> anyhow::Result<()> {
    let mut after = 0i64;
    let mut cleaned = 0u64;
    loop {
        let rows = sqlx::query("SELECT id, media_filename FROM messages WHERE id > $1 AND media_filename IS NOT NULL AND media_filename <> '' AND media_kind = 'server' ORDER BY id LIMIT 500")
            .bind(after)
            .fetch_all(&mut *conn)
            .await?;
        let Some(last) = rows.last() else {
            break;
        };
        after = last.try_get(0)?;
        for row in &rows {
            let (id, name): (i64, String) = (row.try_get(0)?, row.try_get(1)?);
            let clean = crate::api::media::clean_filename(&name);
            if clean != name {
                sqlx::query("UPDATE messages SET media_filename = $1 WHERE id = $2")
                    .bind(clean)
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
                cleaned += 1;
            }
        }
    }
    if cleaned > 0 {
        tracing::info!("cleaned {cleaned} stored file names");
    }
    Ok(())
}

/// Rules that a binary without `restrict_view` wrote (`restrict_set` = 0) made their channel
/// private there, so the channel needs the view restriction here too. Runs at every start, so
/// rules that an older binary adds after the first upgrade are covered as well. Rules this
/// binary writes are marked, so a channel an admin opened stays open.
async fn restrict_old_rules(conn: &mut AnyConnection) -> sqlx::Result<()> {
    let n = sqlx::query("UPDATE channels SET restrict_view = 1 WHERE restrict_view = 0 AND EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = channels.id AND cp.restrict_set = 0)")
        .execute(&mut *conn)
        .await?
        .rows_affected();
    sqlx::query("UPDATE channel_perms SET restrict_set = 1 WHERE restrict_set = 0")
        .execute(&mut *conn)
        .await?;
    if n > 0 {
        tracing::info!("restricted {n} channels with rules from an older binary");
    }
    Ok(())
}

/// A stored control that a start changed because the server config changed or pins it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigChange {
    pub key: &'static str,
    /// The stored value before.
    pub from: String,
    pub to: String,
    /// Another start recorded a different env value in the last 10 minutes.
    pub flips: bool,
}

/// What a start did to the stored controls.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfigStart {
    /// The stored values it changed because the server config changed or pins them.
    pub changes: Vec<ConfigChange>,
    /// Controls this start's env leaves unset although another start set them in the last 10
    /// minutes: copies are running with different settings.
    pub forgotten: Vec<&'static str>,
}

/// Set once a start has recorded the env values of the controls.
const RECORDS: &str = "env:records";
/// The keys of the pinned controls, comma separated.
pub(crate) const PINNED: &str = "env:pinned";
/// How recent a record of another env value is for `ConfigChange::flips`.
const FLIP_SECS: i64 = 600;

async fn drop_setting(conn: &mut AnyConnection, key: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM settings WHERE key = $1")
        .bind(key)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

/// Brings the stored controls in line with the server config. A control the env sets is
/// written when nothing is stored, when the env value differs from the one recorded at the
/// last start that set it (`env:<key>`), when it was unset at a start with records and is set
/// again, or when it is pinned. Otherwise the stored value stays, so a change made in the admin
/// page stands. The first start with records only records. Unset controls lose their record
/// and get their default when nothing is stored. Each change of a stored value is noted in the
/// instance audit log as `settings.config`, made by the server config. Only a server start
/// runs this: a tool that opens the database without the server's env must leave the records
/// alone, or the next start would apply its env over what the admin page chose.
async fn apply_controls(
    conn: &mut AnyConnection,
    seeds: &ControlSeeds,
) -> sqlx::Result<ConfigStart> {
    let mut table = HashMap::new();
    for row in sqlx::query("SELECT key, value FROM settings")
        .fetch_all(&mut *conn)
        .await?
    {
        table.insert(row.try_get::<String, _>(0)?, row.try_get::<String, _>(1)?);
    }
    let records = table.contains_key(RECORDS);
    let t = now();
    let recent = |at_key: &str| {
        table
            .get(at_key)
            .and_then(|at| at.parse::<i64>().ok())
            .is_some_and(|at| t - at < FLIP_SECS)
    };
    let (mut changes, mut forgotten) = (Vec::new(), Vec::new());
    for control in Control::all() {
        let stored = control.read(&table);
        let (record_key, at_key) = (
            format!("env:{}", control.key),
            format!("env_at:{}", control.key),
        );
        let record = table.get(&record_key);
        let env = seeds.value(control.key);
        if let (Some(env), Some(stored)) = (env, &stored) {
            let changed = match record {
                Some(record) => record != env,
                None => records,
            };
            if (changed || seeds.pins(control.key)) && stored != env {
                for (key, value) in control.rows(env) {
                    store_setting(conn, key, &value).await?;
                }
                crate::api::instance_audit::record_config(
                    conn,
                    "settings.config",
                    Some(control.key),
                    serde_json::json!({
                        "key": control.key,
                        "from": control.shown(stored),
                        "to": control.shown(env),
                    }),
                    t,
                )
                .await?;
                changes.push(ConfigChange {
                    key: control.key,
                    from: stored.clone(),
                    to: env.to_string(),
                    flips: record.is_some_and(|record| record != env) && recent(&at_key),
                });
            }
        }
        for (key, value) in control.rows(env.unwrap_or(control.default)) {
            seed_setting(conn, key, &value).await?;
        }
        match (env, record) {
            (Some(env), Some(record)) if record == env => {}
            (Some(env), _) => {
                store_setting(conn, &record_key, env).await?;
                store_setting(conn, &at_key, &t.to_string()).await?;
            }
            (None, Some(_)) => {
                if recent(&at_key) {
                    forgotten.push(control.key);
                }
                drop_setting(conn, &record_key).await?;
                drop_setting(conn, &at_key).await?;
            }
            (None, None) => {}
        }
    }
    match seeds.pinned.is_empty() {
        true => drop_setting(conn, PINNED).await?,
        false => store_setting(conn, PINNED, &seeds.pinned.join(",")).await?,
    }
    seed_setting(conn, RECORDS, "1").await?;
    Ok(ConfigStart { changes, forgotten })
}
