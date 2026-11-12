use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::perms::Perm;
use crate::api::access::{Proof, ServerAccess, resolve_server};
use crate::api::audit;
use crate::api::media::MEDIA_TTL_SECS;
use crate::api::{ApiError, ApiErrorBody, Authed, Settings, bad, placeholders};
use crate::db::{Db, User};
use crate::limits::Limits;
use crate::state::AppState;
use crate::ws::WsEvent;

/// Shortest custom time a server can keep its files, in seconds (1 hour).
pub const CUSTOM_MIN: i64 = 3600;
/// Longest custom time, in seconds (365 days).
pub const CUSTOM_MAX: i64 = 365 * DAY;
/// Most days an operator can cap server choices at; 0 is no cap.
pub const CAP_DAYS_MAX: i64 = 365;
/// The `settings` key of the cap.
pub const CAP_KEY: &str = "upload_expiry_max_days";
const DAY: i64 = 86400;

/// How a server keeps uploaded files.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExpiryMode {
    /// The instance's time (`limits.media_retention_secs`, 1 day).
    Default,
    /// `seconds` after upload.
    Custom,
    /// Kept until removed, when the instance allows it (`upload_expiry_max_days` is 0).
    Never,
}

/// A server's choice for how long uploaded files stay.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct UploadExpiry {
    /// `default`, `custom` or `never`.
    pub mode: ExpiryMode,
    /// Seconds after upload for `custom`, 3600 (1 hour) to 31536000 (365 days); `null`
    /// otherwise.
    #[serde(default)]
    pub seconds: Option<i64>,
}

impl UploadExpiry {
    pub const DEFAULT: UploadExpiry = UploadExpiry {
        mode: ExpiryMode::Default,
        seconds: None,
    };

    /// From `servers.upload_expiry`: `NULL` the instance default, 0 never, else seconds.
    pub fn from_stored(value: Option<i64>) -> UploadExpiry {
        match value {
            None => UploadExpiry::DEFAULT,
            Some(0) => UploadExpiry {
                mode: ExpiryMode::Never,
                seconds: None,
            },
            Some(s) => UploadExpiry {
                mode: ExpiryMode::Custom,
                seconds: Some(s),
            },
        }
    }

    pub fn stored(self) -> Option<i64> {
        let UploadExpiry { mode, seconds } = self;
        match mode {
            ExpiryMode::Default => None,
            ExpiryMode::Never => Some(0),
            ExpiryMode::Custom => seconds,
        }
    }

    /// The `media.ttl` of a file posted in a server with this choice, under the instance cap
    /// (`cap_days`, 0 for none): `None` for the instance default, `Some(0)` kept until removed,
    /// else seconds after upload.
    pub fn ttl(self, cap_days: i64) -> Option<i64> {
        let cap = cap_days.max(0) * DAY;
        let UploadExpiry { mode, seconds } = self;
        match mode {
            ExpiryMode::Default => None,
            ExpiryMode::Never if cap > 0 => Some(cap),
            ExpiryMode::Never => Some(0),
            ExpiryMode::Custom => seconds.map(|s| match cap > 0 && s > cap {
                true => cap,
                false => s,
            }),
        }
    }

    /// Seconds a file stays under this choice with no cap, to compare two choices: the largest
    /// number when it is kept until removed.
    fn span(self) -> i64 {
        match self.ttl(0) {
            None => MEDIA_TTL_SECS,
            Some(0) => i64::MAX,
            Some(s) => s,
        }
    }

    /// Seconds a new file stays, `None` when it is kept until removed.
    pub fn lifetime(self, cap_days: i64) -> Option<i64> {
        match self.ttl(cap_days) {
            None => Some(MEDIA_TTL_SECS),
            Some(0) => None,
            Some(s) => Some(s),
        }
    }
}

/// When a file uploaded at `uploaded_at` with `media.ttl` value `ttl` goes, `None` if kept.
pub fn deadline(uploaded_at: i64, ttl: Option<i64>) -> Option<i64> {
    match ttl {
        None => Some(uploaded_at + MEDIA_TTL_SECS),
        Some(0) => None,
        Some(s) => Some(uploaded_at + s),
    }
}

/// Whether a `media.ttl` keeps a file longer than the instance default.
pub fn extends(ttl: Option<i64>) -> bool {
    match ttl {
        None => false,
        Some(0) => true,
        Some(s) => s > MEDIA_TTL_SECS,
    }
}

/// On Postgres, holds the kept space of `server` until the transaction ends, so the posts and
/// setting changes that count it run one after another (SQLite has one writer). Take it before
/// reading the server's choice.
pub(crate) async fn lock_kept(conn: &mut sqlx::AnyConnection, server: &str) -> sqlx::Result<()> {
    if conn.backend_name() == "PostgreSQL" {
        sqlx::query("SELECT COUNT(*) FROM pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("media kept:{server}"))
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Bytes of the files `server` keeps longer than the instance default (`media.kept_by`).
pub(crate) async fn kept_bytes(conn: &mut sqlx::AnyConnection, server: &str) -> sqlx::Result<i64> {
    sqlx::query("SELECT CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM media WHERE kept_by = $1")
        .bind(server)
        .fetch_one(&mut *conn)
        .await?
        .try_get(0)
}

/// The account charged for the longer choice of `server` (`servers.upload_expiry_by`): whoever
/// set it, or lengthened it last. `None` when the server keeps nothing longer, or when that
/// account is gone and nobody has set the choice since.
async fn owner_of(conn: &mut sqlx::AnyConnection, server: &str) -> sqlx::Result<Option<String>> {
    let row = sqlx::query("SELECT upload_expiry_by FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(match row {
        Some(r) => r.try_get(0)?,
        None => None,
    })
}

/// Bytes of the files kept longer than the instance default by all servers whose choice `owner`
/// is charged for.
async fn owner_bytes(conn: &mut sqlx::AnyConnection, owner: &str) -> sqlx::Result<i64> {
    sqlx::query("SELECT CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM media WHERE kept_by IN (SELECT name FROM servers WHERE upload_expiry_by = $1)")
        .bind(owner)
        .fetch_one(&mut *conn)
        .await?
        .try_get(0)
}

/// The two limits a file kept longer than the instance default must fit, in bytes (0 for
/// none): its server's, and that of the account charged for the server's choice across all
/// servers it is charged for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct KeptLimits {
    pub server: i64,
    pub owner: i64,
}

impl KeptLimits {
    pub(crate) fn of(limits: &Limits) -> KeptLimits {
        KeptLimits {
            server: limits.upload_server_kept_bytes(),
            owner: limits.upload_owner_kept_bytes(),
        }
    }
}

/// What is used of the kept space of a server and of the account charged for its choice. A
/// server with nobody charged has only its own.
struct Room {
    server: i64,
    owner: Option<i64>,
    limits: KeptLimits,
}

impl Room {
    /// The room left in `server`. On Postgres it holds the kept space of the charged account
    /// until the transaction ends, so posts and setting changes in different servers charged
    /// to one account run one after another. Call it after `lock_kept`.
    async fn of(
        conn: &mut sqlx::AnyConnection,
        server: &str,
        limits: KeptLimits,
    ) -> sqlx::Result<Room> {
        let owner = match limits.owner > 0 {
            true => owner_of(conn, server).await?,
            false => None,
        };
        if let Some(owner) = &owner
            && conn.backend_name() == "PostgreSQL"
        {
            sqlx::query("SELECT COUNT(*) FROM pg_advisory_xact_lock(hashtextextended($1, 0))")
                .bind(format!("media kept owner:{owner}"))
                .execute(&mut *conn)
                .await?;
        }
        let used = kept_bytes(conn, server).await?;
        let owner = match &owner {
            Some(owner) => Some(owner_bytes(conn, owner).await?),
            None => None,
        };
        Ok(Room {
            server: used,
            owner,
            limits,
        })
    }

    /// Counts `size` more bytes when they fit both limits.
    fn take(&mut self, size: i64) -> bool {
        let KeptLimits { server, owner } = self.limits;
        let fits = (server <= 0 || self.server.saturating_add(size) <= server)
            && self
                .owner
                .is_none_or(|used| used.saturating_add(size) <= owner);
        if fits {
            self.server = self.server.saturating_add(size);
            self.owner = self.owner.map(|used| used.saturating_add(size));
        }
        fits
    }
}

async fn choice_of(conn: &mut sqlx::AnyConnection, server: &str) -> sqlx::Result<UploadExpiry> {
    let row = sqlx::query("SELECT upload_expiry FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(match row {
        Some(r) => UploadExpiry::from_stored(r.try_get(0)?),
        None => UploadExpiry::DEFAULT,
    })
}

/// How a file posted now is kept: its `media.ttl`, and the server charged for it when that is
/// longer than the instance default (`media.kept_by`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Keep {
    pub ttl: Option<i64>,
    pub server: Option<String>,
}

/// How upload `media` posted in channel `id` is kept: per its server's choice under the cap, or
/// for the instance default when the choice is longer and the kept space of the server or of
/// the account charged for the choice (`limits`) has no room for the file. Call it in the
/// transaction that posts the file.
pub(crate) async fn keep_in(
    conn: &mut sqlx::AnyConnection,
    id: i64,
    media: &str,
    cap_days: i64,
    limits: KeptLimits,
) -> sqlx::Result<Keep> {
    let row = sqlx::query("SELECT server FROM channels WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(Keep::default());
    };
    let server: String = row.try_get(0)?;
    // Nothing is charged at the default or a shorter time, so such a post takes no lock. A
    // longer choice is read again under the lock, which a setting change holds too.
    let ttl = choice_of(conn, &server).await?.ttl(cap_days);
    if !extends(ttl) {
        return Ok(Keep { ttl, server: None });
    }
    lock_kept(conn, &server).await?;
    let ttl = choice_of(conn, &server).await?.ttl(cap_days);
    if !extends(ttl) {
        return Ok(Keep { ttl, server: None });
    }
    let size = sqlx::query("SELECT size FROM media WHERE id = $1")
        .bind(media)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(size) = size else {
        return Ok(Keep::default());
    };
    let size: i64 = size.try_get(0)?;
    let fits = Room::of(conn, &server, limits).await?.take(size);
    Ok(match fits {
        true => Keep {
            ttl,
            server: Some(server),
        },
        false => Keep::default(),
    })
}

/// The files a server keeps longer than the instance default (`limits.media_retention_secs`),
/// counted against the instance's limit for one server.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct KeptSpace {
    /// Bytes of the files the server keeps longer than the instance default.
    pub bytes: i64,
    /// Most bytes one server may keep that way (`UPLOAD_SERVER_KEPT_MIB`); 0 for no limit.
    pub limit: i64,
    /// Whether a file of the largest upload size (or of the whole limit, if smaller) no longer
    /// fits. A new file that does not fit is not refused: it stays for the instance default
    /// instead, until space frees up.
    pub full: bool,
}

/// The files kept longer than the instance default by all servers whose longer choice one
/// account is charged for, counted against the instance's limit for one account. The account
/// charged for a server is whoever set its longer choice or lengthened it last.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct OwnerKept {
    /// Bytes of those files across the servers the account is charged for. `null` unless you
    /// are that account.
    pub bytes: Option<i64>,
    /// Most bytes the servers charged to one account may keep that way together
    /// (`UPLOAD_OWNER_KEPT_MIB`); 0 for no limit.
    pub limit: i64,
    /// Whether a file of the largest upload size (or of the whole limit, if smaller) no longer
    /// fits. A new file that does not fit is not refused: it stays for the instance default
    /// instead, until space frees up.
    pub full: bool,
}

/// What a change of the upload expiry did to the files already posted in the server.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Extended {
    /// Files that now stay longer than the instance default and did not before.
    pub files: i64,
    /// Their bytes.
    pub bytes: i64,
    /// Files left at the instance default because the kept space of the server or of the
    /// account charged for its choice is full.
    pub left_files: i64,
    /// Their bytes.
    pub left_bytes: i64,
}

/// A server's upload expiry and what it means for new files now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct UploadExpiryState {
    /// The server's choice.
    pub upload_expiry: UploadExpiry,
    /// Seconds new files stay after upload, after the instance cap; `null` when they are kept
    /// until removed. A file that does not fit the kept space stays for the instance default.
    pub upload_ttl: Option<i64>,
    /// The server's kept space.
    pub kept: KeptSpace,
    /// The kept space of the account charged for this server's longer choice, across all
    /// servers it is charged for, which a file must fit too. `null` when nobody is charged: the
    /// server keeps nothing longer, or the account that set its choice is gone and nobody has
    /// set it since. Such a server has only its own kept space.
    pub owner_kept: Option<OwnerKept>,
    /// After a change: what it did to the files already posted. Left out when reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extended: Option<Extended>,
}

impl KeptSpace {
    pub fn of(bytes: i64, limits: &Limits) -> KeptSpace {
        let limit = limits.upload_server_kept_bytes();
        KeptSpace {
            bytes,
            limit,
            full: kept_full(bytes, limit, limits),
        }
    }
}

/// Whether a file of the largest upload size, or of the whole `limit` when that is smaller, no
/// longer fits next to `bytes`.
fn kept_full(bytes: i64, limit: i64, limits: &Limits) -> bool {
    let largest = limits.upload_bytes().min(i64::MAX as usize) as i64;
    limit > 0 && bytes.saturating_add(largest.min(limit)) > limit
}

/// The kept space of `server` and of the account charged for its choice, now. That account's
/// bytes are only for `viewer` when that is the account.
async fn kept_spaces(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    viewer: Option<&str>,
    limits: &Limits,
) -> sqlx::Result<(KeptSpace, Option<OwnerKept>)> {
    let kept = KeptSpace::of(kept_bytes(conn, server).await?, limits);
    let owner = match owner_of(conn, server).await? {
        Some(owner) => {
            let bytes = owner_bytes(conn, &owner).await?;
            let limit = limits.upload_owner_kept_bytes();
            Some(OwnerKept {
                bytes: (viewer == Some(owner.as_str())).then_some(bytes),
                limit,
                full: kept_full(bytes, limit, limits),
            })
        }
        None => None,
    };
    Ok((kept, owner))
}

pub(crate) async fn stored(db: &Db, server: &str) -> Result<UploadExpiry, ApiError> {
    let row = sqlx::query("SELECT upload_expiry FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(db)
        .await?
        .ok_or_else(crate::api::access::not_found)?;
    Ok(UploadExpiry::from_stored(row.try_get(0)?))
}

/// The originals (not forwards) of the live server files posted in `server`.
const POSTED_IN: &str = "SELECT m.media_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server = $2 AND m.media_kind = 'server' AND m.media_removed = 0 AND m.fwd_created_at IS NULL AND m.media_id IS NOT NULL";

/// Files given a longer time in one statement.
const EXTEND_BATCH: usize = 200;

/// Gives the files posted in `server` the `ttl` of its choice, and their messages (forwards
/// included) the matching expiry time. A `ttl` longer than the instance default counts against
/// the kept space of the server and of the account charged for the choice (`limits`): the
/// files it keeps already follow the new time, then the others are extended newest first
/// until one does not fit either limit, and the rest stay for the instance default. Nothing is
/// shortened or removed for room. Call it in a transaction, after `lock_kept`.
pub(crate) async fn retime(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    ttl: Option<i64>,
    limits: KeptLimits,
) -> sqlx::Result<Extended> {
    let mut extended = Extended::default();
    match extends(ttl) {
        false => {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE media SET ttl = $1, kept_by = NULL WHERE id IN ({POSTED_IN})"
            )))
            .bind(ttl)
            .bind(server)
            .execute(&mut *conn)
            .await?;
        }
        true => {
            let posted = POSTED_IN.replace("$2", "$1");
            // A file kept longer with no charge (written by a process of an older build) is
            // charged from now, whatever the room: it is never shortened for room.
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE media SET kept_by = $1 WHERE kept_by IS NULL AND (ttl = 0 OR ttl > $2) AND id IN ({posted})"
            )))
            .bind(server)
            .bind(MEDIA_TTL_SECS)
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE media SET ttl = $1 WHERE kept_by = $2")
                .bind(ttl)
                .bind(server)
                .execute(&mut *conn)
                .await?;
            let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT id, size FROM media WHERE kept_by IS NULL AND id IN ({posted}) ORDER BY uploaded_at DESC, id DESC"
            )))
            .bind(server)
            .fetch_all(&mut *conn)
            .await?;
            let mut room = Room::of(conn, server, limits).await?;
            let mut fits = Vec::new();
            let mut full = false;
            for row in &rows {
                let (id, size): (String, i64) = (row.try_get(0)?, row.try_get(1)?);
                full = full || !room.take(size);
                match full {
                    true => {
                        extended.left_files += 1;
                        extended.left_bytes += size;
                    }
                    false => {
                        extended.files += 1;
                        extended.bytes += size;
                        fits.push(id);
                    }
                }
            }
            for ids in fits.chunks(EXTEND_BATCH) {
                let sql = format!(
                    "UPDATE media SET ttl = $1, kept_by = $2 WHERE id IN ({})",
                    placeholders(3, ids.len())
                );
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(ttl).bind(server);
                for id in ids {
                    query = query.bind(id.clone());
                }
                query.execute(&mut *conn).await?;
            }
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE media SET ttl = NULL WHERE kept_by IS NULL AND ttl IS NOT NULL AND id IN ({posted})"
            )))
            .bind(server)
            .execute(&mut *conn)
            .await?;
        }
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE messages SET media_expires_at = (SELECT CASE WHEN md.ttl = 0 THEN NULL ELSE md.uploaded_at + COALESCE(md.ttl, $1) END FROM media md WHERE md.id = messages.media_id) WHERE media_kind = 'server' AND media_removed = 0 AND media_id IN ({POSTED_IN})"
    )))
    .bind(MEDIA_TTL_SECS)
    .bind(server)
    .execute(&mut *conn)
    .await?;
    Ok(extended)
}

/// After the operator changes the cap: every server with its own choice gets it again under
/// the new cap, within the kept space of the server and of the account charged for its choice
/// (`limits`).
pub(crate) async fn retime_all(db: &Db, cap_days: i64, limits: KeptLimits) -> sqlx::Result<()> {
    let rows = sqlx::query("SELECT name FROM servers WHERE upload_expiry IS NOT NULL")
        .fetch_all(db)
        .await?;
    for row in rows {
        let name: String = row.try_get(0)?;
        let mut tx = db.begin().await?;
        lock_kept(&mut tx, &name).await?;
        let choice = choice_of(&mut tx, &name).await?;
        retime(&mut tx, &name, choice.ttl(cap_days), limits).await?;
        tx.commit().await?;
    }
    let mut conn = db.acquire().await?;
    clamp(&mut conn, cap_days).await?;
    Ok(())
}

/// After a start changed the stored cap from the server config: the files are re-timed under
/// the cap the config asked for (`to`, as stored), the way a change in the admin page does it:
/// through `retime_all`, within the kept space the same config gives a server and the account
/// charged for its choice.
/// A value that is no number is no cap read, and nothing is shortened.
pub(crate) async fn retime_from_config(db: &Db, to: &str) -> sqlx::Result<()> {
    match crate::api::controls::number(CAP_KEY, Some(to)) {
        Some(days) => retime_all(db, days, KeptLimits::of(&crate::db::opened_limits(db))).await,
        None => {
            tracing::warn!(
                "the upload expiry cap from the server config is not a number, the files wait"
            );
            Ok(())
        }
    }
}

/// The cap as stored (0 for none), or `None` when it can't be read or is not a number. Steps that
/// shorten or delete files skip a cap they could not read rather than use a fail-closed one.
pub(crate) async fn stored_cap(conn: &mut sqlx::AnyConnection) -> Option<i64> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(CAP_KEY)
        .fetch_optional(&mut *conn)
        .await;
    let value = match row {
        Ok(None) => return Some(0),
        Ok(Some(row)) => row.try_get::<String, _>(0).ok(),
        Err(e) => {
            tracing::warn!("the upload expiry cap could not be read, the files wait: {e}");
            return None;
        }
    };
    let days = value.and_then(|v| v.trim().parse::<i64>().ok());
    if days.is_none() {
        tracing::warn!("the stored upload expiry cap is not a number, the files wait");
    }
    days.map(|d| d.clamp(0, CAP_DAYS_MAX))
}

/// Files kept longer than the cap (`cap_days`, 0 for none) or until removed get the cap,
/// wherever they were posted, and their messages the matching time. A cap no longer than the
/// instance default leaves them charged to no server. Returns how many changed.
pub(crate) async fn clamp(conn: &mut sqlx::AnyConnection, cap_days: i64) -> sqlx::Result<u64> {
    if cap_days <= 0 {
        return Ok(0);
    }
    let cap = cap_days * DAY;
    sqlx::query("UPDATE messages SET media_expires_at = (SELECT md.uploaded_at + $1 FROM media md WHERE md.id = messages.media_id) WHERE media_kind = 'server' AND media_removed = 0 AND media_id IN (SELECT id FROM media WHERE ttl IS NOT NULL AND (ttl = 0 OR ttl > $1))")
        .bind(cap)
        .execute(&mut *conn)
        .await?;
    Ok(sqlx::query(
        "UPDATE media SET ttl = $1, kept_by = CASE WHEN $1 > $2 THEN kept_by ELSE NULL END WHERE ttl IS NOT NULL AND (ttl = 0 OR ttl > $1)",
    )
    .bind(cap)
    .bind(MEDIA_TTL_SECS)
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

/// File `id` lost its original message: it goes like any other upload, counts against no
/// server, and the messages still carrying it (forwards) show that time. The database does the
/// same when an original is deleted (`messages_media_release`).
pub(crate) async fn release(conn: &mut sqlx::AnyConnection, id: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE messages SET media_expires_at = (SELECT uploaded_at + $2 FROM media WHERE id = $1) WHERE media_id = $1 AND media_kind = 'server' AND media_removed = 0 AND EXISTS(SELECT 1 FROM media WHERE id = $1 AND ttl IS NOT NULL)")
        .bind(id)
        .bind(MEDIA_TTL_SECS)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE media SET ttl = NULL, kept_by = NULL WHERE id = $1 AND ttl IS NOT NULL")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn manage(state: &AppState, user: &User, name: &str) -> Result<ServerAccess, ApiError> {
    let access = resolve_server(&state.db, name, Some(user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::DeleteServer).await?;
    Ok(access)
}

/// Get a server's upload expiry
///
/// How long files uploaded in the server stay, what that means for new files under the
/// instance's cap, and the kept space. `kept` is the bytes of the files the server keeps longer
/// than the instance default (`limits.media_retention_secs`), against the instance's limit for
/// one server (`UPLOAD_SERVER_KEPT_MIB`, 8 GiB unless set, 0 for none). `owner_kept` is the
/// same for all servers whose longer choice the same account is charged for, against the limit
/// for one account (`UPLOAD_OWNER_KEPT_MIB`, 16 GiB unless set, 0 for none). The account
/// charged is whoever set the longer choice or lengthened it last; only that account reads its
/// `bytes`, others with the permission read whether it is full, and nobody is told who it is.
/// Members read the choice in the server detail, and whether such limits exist in
/// `limits.upload_kept_limited` of `GET /api/v1/instance`. Requires the Delete server
/// permission. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/upload_expiry",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "The setting", body = UploadExpiryState),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn get_upload_expiry(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<UploadExpiryState>, ApiError> {
    let access = manage(&state, &user, &name).await?;
    let choice = stored(&state.db, access.name()).await?;
    let mut conn = state.db.acquire().await?;
    let (kept, owner_kept) = kept_spaces(
        &mut conn,
        access.name(),
        Some(&user.username),
        &state.limits,
    )
    .await?;
    drop(conn);
    let settings = Settings::cached(&state.db).await;
    Ok(Json(UploadExpiryState {
        upload_expiry: choice,
        upload_ttl: choice.lifetime(settings.upload_expiry_max_days),
        kept,
        owner_kept,
        extended: None,
    }))
}

/// Set a server's upload expiry
///
/// Chooses how long files uploaded in the server stay: the instance default, a custom time
/// (`seconds`, 3600 to 31536000) or `never` (kept until removed). While the instance has a cap
/// (`upload_expiry_max_days` in `GET /api/v1/settings`, 0 for none), `never` and longer times are
/// refused; a choice saved before the cap was lowered is shortened to it. Applies to files
/// already posted in the server too: their messages get the new expiry time, and files past it
/// are removed by the next sweep. Files in DMs keep the instance default.
///
/// A time longer than the instance default counts against the server's kept space (`kept`) and
/// against the space of one account across servers (`owner_kept`), not against the people who
/// uploaded the files. That account is you when you set a longer time where none was set, or
/// lengthen it; shortening it leaves the account as it was, and the default or a shorter time
/// charges nobody. The files the server keeps already follow the new time. The others are
/// extended newest first until one does not fit either space, and the rest stay for the
/// instance default; `extended` says how many of each. Nothing is removed for room, and a
/// later upload that does not fit is not refused: it stays for the instance default. Only the
/// site operator changes the limits (`UPLOAD_SERVER_KEPT_MIB`, `UPLOAD_OWNER_KEPT_MIB`).
///
/// Requires the Delete server permission. Emits `upload_expiry_changed` to the server's
/// members, who load the server again. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/v1/servers/{name}/upload_expiry",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = UploadExpiry,
    responses(
        (status = 200, description = "The setting after the change, with `extended`", body = UploadExpiryState),
        (status = 400, description = "`seconds` missing or outside 3600 to 31536000 for `custom`, or given for another mode; `This instance keeps files at most N days` for `never` or a longer time while the instance has a cap. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn set_upload_expiry(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<UploadExpiry>,
) -> Result<Json<UploadExpiryState>, ApiError> {
    let access = manage(&state, &user, &name).await?;
    let UploadExpiry { mode, seconds } = req;
    match (mode, seconds) {
        (ExpiryMode::Custom, Some(s)) if (CUSTOM_MIN..=CUSTOM_MAX).contains(&s) => {}
        (ExpiryMode::Custom, _) => {
            return Err(bad("Choose a time from 1 hour to 365 days"));
        }
        (ExpiryMode::Default | ExpiryMode::Never, None) => {}
        (ExpiryMode::Default | ExpiryMode::Never, Some(_)) => {
            return Err(bad("Only a custom expiry takes seconds"));
        }
    }
    let key = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::DeleteServer).await?;
    let settings = Settings::cached(&state.db).await;
    let cap = settings.upload_expiry_max_days;
    if cap > 0 && (mode == ExpiryMode::Never || seconds.is_some_and(|s| s > cap * DAY)) {
        let days = match cap {
            1 => "1 day".to_string(),
            n => format!("{n} days"),
        };
        return Err(bad(&format!("This instance keeps files at most {days}")));
    }
    let limits = KeptLimits::of(&state.limits);
    let mut tx = state.db.begin().await?;
    lock_kept(&mut tx, &key).await?;
    let was = choice_of(&mut tx, &key).await?;
    // Whoever sets a longer time, or lengthens it, is charged for it from then on. Shortening
    // it charges nobody new, and a time no longer than the default charges nobody.
    let charged = match (extends(req.ttl(0)), owner_of(&mut tx, &key).await?) {
        (false, _) => None,
        (true, Some(by)) if req.span() <= was.span() => Some(by),
        (true, _) => Some(user.username.clone()),
    };
    sqlx::query("UPDATE servers SET upload_expiry = $1, upload_expiry_by = $2 WHERE name = $3")
        .bind(req.stored())
        .bind(charged)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    let extended = retime(&mut tx, &key, req.ttl(cap), limits).await?;
    let details = audit::Details::new().change("upload_expiry", audit_value(was), audit_value(req));
    if details.has_changes() {
        audit::record(
            &mut tx,
            audit::Entry::new(&key, &actor, audit::Action::ServerUpdate)
                .target(audit::Target::server(&access.lite().display_name))
                .details(details),
        )
        .await?;
    }
    let (kept, owner_kept) =
        kept_spaces(&mut tx, &key, Some(&user.username), &state.limits).await?;
    tx.commit().await?;
    state
        .hub
        .broadcast(WsEvent::UploadExpiryChanged { server: key });
    Ok(Json(UploadExpiryState {
        upload_expiry: req,
        upload_ttl: req.lifetime(cap),
        kept,
        owner_kept,
        extended: Some(extended),
    }))
}

fn audit_value(choice: UploadExpiry) -> serde_json::Value {
    let UploadExpiry { mode, seconds } = choice;
    match (mode, seconds) {
        (ExpiryMode::Custom, Some(s)) => s.into(),
        (ExpiryMode::Never, _) => "never".into(),
        (ExpiryMode::Default | ExpiryMode::Custom, _) => "default".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{ExpiryMode, UploadExpiry};

    const fn custom(s: i64) -> UploadExpiry {
        UploadExpiry {
            mode: ExpiryMode::Custom,
            seconds: Some(s),
        }
    }
    const NEVER: UploadExpiry = UploadExpiry {
        mode: ExpiryMode::Never,
        seconds: None,
    };

    #[test]
    fn each_mode_gives_its_file_lifetime_under_the_cap() {
        let day = 86400;
        for (choice, cap, ttl, lifetime) in [
            (UploadExpiry::DEFAULT, 0, None, Some(day)),
            (UploadExpiry::DEFAULT, 1, None, Some(day)),
            (custom(3600), 0, Some(3600), Some(3600)),
            (custom(3600), 1, Some(3600), Some(3600)),
            (custom(30 * day), 0, Some(30 * day), Some(30 * day)),
            (custom(30 * day), 7, Some(7 * day), Some(7 * day)),
            (custom(7 * day), 7, Some(7 * day), Some(7 * day)),
            (NEVER, 0, Some(0), None),
            (NEVER, 90, Some(90 * day), Some(90 * day)),
        ] {
            assert_eq!(choice.ttl(cap), ttl, "{choice:?} cap {cap}");
            assert_eq!(choice.lifetime(cap), lifetime, "{choice:?} cap {cap}");
        }
    }

    #[test]
    fn only_a_time_past_the_default_is_charged_to_the_server() {
        for (ttl, kept) in [
            (None, false),
            (Some(3600), false),
            (Some(86400), false),
            (Some(86401), true),
            (Some(0), true),
        ] {
            assert_eq!(super::extends(ttl), kept, "{ttl:?}");
        }
    }

    #[test]
    fn the_instance_says_whether_kept_files_are_limited() {
        let limited = |server, owner| {
            crate::instance::Limits::of(&crate::limits::Limits {
                upload_server_kept_mib: server,
                upload_owner_kept_mib: owner,
                ..crate::limits::Limits::default()
            })
            .upload_kept_limited
        };
        assert!(limited(8192, 16384));
        assert!(limited(1, 0));
        assert!(limited(0, 1));
        assert!(
            !limited(0, 0),
            "with no limit every file gets its server's time"
        );
    }

    #[test]
    fn the_stored_column_round_trips() {
        for (choice, stored) in [
            (UploadExpiry::DEFAULT, None),
            (NEVER, Some(0)),
            (custom(7200), Some(7200)),
        ] {
            assert_eq!(choice.stored(), stored);
            assert_eq!(UploadExpiry::from_stored(stored), choice);
        }
    }

    use axum::Json;
    use axum::extract::{Path, State};
    use axum::http::StatusCode;
    use sqlx::Row;

    use super::{
        CUSTOM_MAX, CUSTOM_MIN, Extended, KeptSpace, OwnerKept, UploadExpiryState,
        get_upload_expiry, set_upload_expiry,
    };
    use crate::api::access::perms::ALL_PERMS;
    use crate::api::media::{
        Charge, MEDIA_TTL_SECS, check_budget, save_upload, save_within, store_media, sweep,
    };
    use crate::api::messages::{SendReq, insert_message, send_channel_message, send_dm_message};
    use crate::api::test_util::{add_member, done, mem_user, pg_done, pg_state, temp_state};
    use crate::api::{ApiError, Authed, Settings};
    use crate::db::{Db, now};
    use crate::limits::Limits;
    use crate::state::AppState;

    const DAY: i64 = 86400;
    const KIB: i64 = 1024;

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    /// Server `club` made by alice (all permissions), with bob as a plain member; returns its
    /// text channel.
    async fn club(state: &AppState) -> i64 {
        let db = &state.db;
        for name in ["alice", "bob", "carol"] {
            exec(db, &format!("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('{name}', '{name}', 'x', 'text', 'identicon', 1)")).await;
        }
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 1)").await;
        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('hidden', 'Hidden', 'alice', 'x', 1)").await;
        exec(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 1)",
        )
        .await;
        add_member(db, "club", "alice", 1, ALL_PERMS, 1).await;
        add_member(db, "club", "bob", 0, 0, 1).await;
        add_member(db, "hidden", "alice", 1, ALL_PERMS, 1).await;
        sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id")
    }

    fn req(content: &str, media_id: Option<String>) -> Json<SendReq> {
        Json(SendReq {
            content: content.to_string(),
            media_id,
            media_spoiler: None,
            p2p: None,
            reply_to: None,
            mention_reply: false,
            forward_of: None,
            poll: None,
        })
    }

    async fn upload(state: &AppState, who: &str) -> String {
        save_upload(state, "a.txt", "text/plain", b"x", who, Charge::own(who))
            .await
            .expect("upload")
            .0
    }

    async fn post_file(state: &AppState, cid: i64) -> (String, i64, Option<i64>) {
        let id = upload(state, "alice").await;
        let m = send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user("alice", false)),
            req("", Some(id.clone())),
        )
        .await
        .expect("send")
        .0;
        let expires = m.media.as_ref().and_then(|x| x.expires_at);
        (id, m.id, expires)
    }

    async fn ttl(db: &Db, id: &str) -> Option<Option<i64>> {
        sqlx::query("SELECT ttl FROM media WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await
            .expect("media")
            .map(|r| r.try_get(0).expect("ttl"))
    }

    async fn age(db: &Db, id: &str, secs: i64) {
        sqlx::query("UPDATE media SET uploaded_at = $1 WHERE id = $2")
            .bind(now() - secs)
            .bind(id)
            .execute(db)
            .await
            .expect("age");
    }

    async fn set(
        state: &AppState,
        who: &str,
        server: &str,
        choice: UploadExpiry,
    ) -> Result<UploadExpiryState, ApiError> {
        set_upload_expiry(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path(server.to_string()),
            Json(choice),
        )
        .await
        .map(|j| j.0)
    }

    /// The same state with `mib` MiB of kept space for each server (0 for no limit), none for
    /// owners, and uploads of at most 1 MiB.
    fn kept_limit(state: AppState, mib: u64) -> AppState {
        kept_limits(state, mib, 0)
    }

    /// `kept_limit` with `owner` MiB of kept space for the servers of one owner together.
    fn kept_limits(state: AppState, server: u64, owner: u64) -> AppState {
        state.with_limits(std::sync::Arc::new(Limits {
            upload_server_kept_mib: server,
            upload_owner_kept_mib: owner,
            upload_max_mib: 1,
            ..Limits::default()
        }))
    }

    /// Server `name` made by `owner` (all permissions) with bob as a plain member, after `club`;
    /// returns its text channel.
    async fn server_of(db: &Db, name: &str, owner: Option<&str>) -> i64 {
        let creator = owner.map_or("NULL".to_string(), |o| format!("'{o}'"));
        exec(db, &format!("INSERT INTO servers(name, display_name, creator, created_at) VALUES('{name}', '{name}', {creator}, 1)")).await;
        exec(
            db,
            &format!(
                "INSERT INTO channels(server, name, created_at) VALUES('{name}', 'general', 1)"
            ),
        )
        .await;
        if let Some(owner) = owner {
            add_member(db, name, owner, 1, ALL_PERMS, 1).await;
        }
        add_member(db, name, "bob", 0, 0, 1).await;
        sqlx::query("SELECT id FROM channels WHERE server = $1")
            .bind(name)
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id")
    }

    /// What `who`, a manager of `server`, reads as its upload expiry.
    async fn space(state: &AppState, who: &str, server: &str) -> UploadExpiryState {
        get_upload_expiry(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path(server.to_string()),
        )
        .await
        .expect("get")
        .0
    }

    /// Files and bytes kept longer than the default by `servers` together.
    async fn kept_in(db: &Db, servers: &[&str]) -> (i64, i64) {
        let list: Vec<String> = servers.iter().map(|s| format!("'{s}'")).collect();
        let row = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*), CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM media WHERE kept_by IN ({})",
            list.join(", ")
        )))
        .fetch_one(db)
        .await
        .expect("kept");
        (row.get(0), row.get(1))
    }

    /// A file of `size` bytes uploaded by `who` `ago` seconds ago, not posted yet.
    async fn stored(state: &AppState, who: &str, size: i64, ago: i64) -> String {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let id = format!("{n:032x}");
        store_media(
            &state.db,
            &id,
            "a.bin",
            "application/octet-stream",
            size,
            None,
            who,
            now() - ago,
        )
        .await
        .expect("store");
        id
    }

    /// `stored`, posted by `who` in channel `cid`: the file and its message.
    async fn post_sized(
        state: &AppState,
        cid: i64,
        who: &str,
        size: i64,
        ago: i64,
    ) -> (String, i64) {
        let id = stored(state, who, size, ago).await;
        let m = send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user(who, false)),
            req("", Some(id.clone())),
        )
        .await
        .expect("send")
        .0;
        (id, m.id)
    }

    async fn kept_by(db: &Db, id: &str) -> Option<String> {
        sqlx::query("SELECT kept_by FROM media WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("media")
            .try_get(0)
            .expect("kept_by")
    }

    async fn kept(state: &AppState) -> KeptSpace {
        get_upload_expiry(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".into()),
        )
        .await
        .expect("get")
        .0
        .kept
    }

    async fn delete_message(db: &Db, id: i64) {
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(id)
            .execute(db)
            .await
            .expect("delete");
    }

    async fn message_expiry(db: &Db, id: i64) -> Option<i64> {
        sqlx::query("SELECT media_expires_at FROM messages WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("expiry")
    }

    #[tokio::test]
    async fn files_follow_their_server_choice_and_the_sweep_honors_it() {
        let (state, path) = temp_state("upload_expiry_modes").await;
        let db = &state.db;
        let cid = club(&state).await;
        let (file, msg, expires) = post_file(&state, cid).await;
        assert_eq!(ttl(db, &file).await, Some(None), "the instance default");
        let uploaded: i64 = sqlx::query("SELECT uploaded_at FROM media WHERE id = $1")
            .bind(&file)
            .fetch_one(db)
            .await
            .expect("media")
            .try_get(0)
            .expect("uploaded_at");
        assert_eq!(expires, Some(uploaded + MEDIA_TTL_SECS));

        let kept = set(&state, "alice", "club", NEVER).await.expect("never");
        assert_eq!((kept.upload_expiry, kept.upload_ttl), (NEVER, None));
        assert_eq!(ttl(db, &file).await, Some(Some(0)));
        assert_eq!(message_expiry(db, msg).await, None);
        age(db, &file, 30 * DAY).await;
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(0)),
            "never: the sweep keeps it"
        );

        let (fresh, fresh_msg, fresh_expires) = post_file(&state, cid).await;
        assert_eq!(ttl(db, &fresh).await, Some(Some(0)));
        assert_eq!(fresh_expires, None);

        let hour = set(&state, "alice", "club", custom(3600))
            .await
            .expect("custom");
        assert_eq!(hour.upload_ttl, Some(3600));
        assert_eq!(ttl(db, &fresh).await, Some(Some(3600)));
        assert!(message_expiry(db, fresh_msg).await.is_some());
        sweep(db, None).await.expect("sweep");
        assert_eq!(ttl(db, &file).await, None, "past a custom time: removed");
        assert_eq!(ttl(db, &fresh).await, Some(Some(3600)), "inside it: kept");
        let removed: i64 = sqlx::query("SELECT media_removed FROM messages WHERE id = $1")
            .bind(msg)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("removed");
        assert_eq!(removed, 1);

        set(&state, "alice", "club", UploadExpiry::DEFAULT)
            .await
            .expect("default");
        assert_eq!(ttl(db, &fresh).await, Some(None));
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_instance_cap_shortens_choices_now_and_later() {
        let (state, path) = temp_state("upload_expiry_cap").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, _, _) = post_file(&state, cid).await;
        assert_eq!(ttl(db, &file).await, Some(Some(0)));
        let admin = |body: serde_json::Value| {
            crate::api::admin::patch_settings(
                State(state.clone()),
                Authed(mem_user("root", true)),
                Json(serde_json::from_value(body).expect("patch")),
            )
        };
        let capped = admin(serde_json::json!({"upload_expiry_max_days": 7}))
            .await
            .expect("cap");
        assert_eq!(capped.0.upload_expiry_max_days, 7);
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "a lowered cap applies to kept files"
        );
        let state_now = get_upload_expiry(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".into()),
        )
        .await
        .expect("get")
        .0;
        assert_eq!(
            (state_now.upload_expiry, state_now.upload_ttl),
            (NEVER, Some(7 * DAY))
        );
        let (later, _, expires) = post_file(&state, cid).await;
        assert_eq!(ttl(db, &later).await, Some(Some(7 * DAY)));
        assert!(expires.is_some());
        let _ = admin(serde_json::json!({"upload_expiry_max_days": 0}))
            .await
            .expect("no cap");
        assert_eq!(
            ttl(db, &later).await,
            Some(Some(0)),
            "lifting the cap gives the choice back"
        );
        let _ = admin(serde_json::json!({"upload_expiry_max_days": 7}))
            .await
            .expect("cap again");
        let refused = |r: Result<UploadExpiryState, ApiError>| matches!(r, Err(ApiError(StatusCode::BAD_REQUEST, m)) if m == "This instance keeps files at most 7 days");
        assert!(refused(set(&state, "alice", "club", NEVER).await));
        assert!(refused(set(&state, "alice", "club", custom(8 * DAY)).await));
        set(&state, "alice", "club", custom(7 * DAY))
            .await
            .expect("at the cap");
        set(&state, "alice", "club", custom(3 * DAY))
            .await
            .expect("under it");
        assert_eq!(ttl(db, &later).await, Some(Some(3 * DAY)));
        for bad in [-1, 366] {
            assert!(
                admin(serde_json::json!({"upload_expiry_max_days": bad}))
                    .await
                    .is_err()
            );
        }
        Settings::forget(db);
        done(state, path).await;
    }

    #[tokio::test]
    async fn only_managers_change_it_and_others_get_uniform_404s() {
        let (state, path) = temp_state("upload_expiry_gate").await;
        club(&state).await;
        let code = |r: Result<UploadExpiryState, ApiError>| r.err().map(|ApiError(c, _)| c);
        assert_eq!(
            code(set(&state, "bob", "club", NEVER).await),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            code(set(&state, "carol", "hidden", NEVER).await),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            code(set(&state, "carol", "nowhere", NEVER).await),
            Some(StatusCode::NOT_FOUND)
        );
        let get = get_upload_expiry(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path("club".into()),
        )
        .await;
        assert!(matches!(get, Err(ApiError(StatusCode::FORBIDDEN, _))));
        for bad in [
            custom(3599),
            custom(CUSTOM_MAX + 1),
            UploadExpiry {
                mode: ExpiryMode::Custom,
                seconds: None,
            },
            UploadExpiry {
                mode: ExpiryMode::Never,
                seconds: Some(3600),
            },
        ] {
            assert_eq!(
                code(set(&state, "alice", "club", bad).await),
                Some(StatusCode::BAD_REQUEST),
                "{bad:?}"
            );
        }
        assert_eq!(
            code(set(&state, "carol", "hidden", custom(1)).await),
            Some(StatusCode::NOT_FOUND)
        );
        assert!(
            set(&state, "alice", "club", custom(CUSTOM_MIN))
                .await
                .is_ok()
        );
        let detail = crate::api::servers::get_server(
            State(state.clone()),
            crate::api::MaybeAuthed(Some(mem_user("bob", false))),
            axum::http::HeaderMap::new(),
            Path("club".into()),
        )
        .await
        .expect("detail")
        .0;
        assert_eq!(detail.upload_expiry, custom(CUSTOM_MIN));
        assert_eq!(detail.upload_ttl, Some(CUSTOM_MIN));
        done(state, path).await;
    }

    #[tokio::test]
    async fn dms_keep_the_default_and_a_deleted_message_lets_its_file_go() {
        let (state, path) = temp_state("upload_expiry_dm").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let id = upload(&state, "alice").await;
        let sent = send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            req("", Some(id.clone())),
        )
        .await
        .expect("dm file")
        .0;
        assert_eq!(ttl(db, &id).await, Some(None));
        assert!(sent.media.and_then(|m| m.expires_at).is_some());

        let (kept, msg, _) = post_file(&state, cid).await;
        age(db, &kept, 3 * DAY).await;
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(msg)
            .execute(db)
            .await
            .expect("delete");
        assert_eq!(ttl(db, &kept).await, Some(None), "its last message is gone");
        sweep(db, None).await.expect("sweep");
        assert_eq!(ttl(db, &kept).await, None);
        done(state, path).await;
    }

    /// alice's file posted in a never server, forwarded by her to her DM with bob.
    async fn kept_and_forwarded(state: &AppState) -> (String, i64, i64) {
        let db = &state.db;
        let cid = club(state).await;
        set(state, "alice", "club", NEVER).await.expect("never");
        let (file, original, _) = post_file(state, cid).await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let mut fwd = req("", None);
        fwd.0.forward_of = Some(original);
        let copy = send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            fwd,
        )
        .await
        .expect("forward")
        .0;
        assert_eq!(
            copy.media.as_ref().map(|m| m.id.clone()),
            Some(file.clone())
        );
        (file, original, copy.id)
    }

    #[tokio::test]
    async fn deleting_the_original_lets_a_forwarded_file_go_and_frees_the_kept_space() {
        let (state, path) = temp_state("upload_expiry_release_original").await;
        let db = &state.db;
        let (file, original, copy) = kept_and_forwarded(&state).await;
        age(db, &file, 3 * DAY).await;
        assert_eq!(kept_by(db, &file).await.as_deref(), Some("club"));
        assert_eq!(kept(&state).await.bytes, 1, "a forward charges nobody else");
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(original)
            .execute(db)
            .await
            .expect("delete the original");
        assert_eq!(
            ttl(db, &file).await,
            Some(None),
            "the forward does not keep it"
        );
        let uploaded: i64 = sqlx::query("SELECT uploaded_at FROM media WHERE id = $1")
            .bind(&file)
            .fetch_one(db)
            .await
            .expect("media")
            .try_get(0)
            .expect("uploaded_at");
        assert_eq!(message_expiry(db, copy).await, Some(uploaded + DAY));
        assert_eq!(kept_by(db, &file).await, None);
        assert_eq!(kept(&state).await.bytes, 0);
        assert!(check_budget(db, Charge::own("alice"), 1, 1).await.is_ok());
        sweep(db, None).await.expect("sweep");
        assert_eq!(ttl(db, &file).await, None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn removing_the_original_attachment_lets_a_forwarded_file_go() {
        let (state, path) = temp_state("upload_expiry_release_attachment").await;
        let db = &state.db;
        let (file, original, copy) = kept_and_forwarded(&state).await;
        let _ = crate::api::media::delete_media(
            State(state.clone()),
            Path(original),
            Authed(mem_user("alice", false)),
        )
        .await
        .expect("remove the attachment");
        assert_eq!(ttl(db, &file).await, Some(None));
        assert_eq!(kept_by(db, &file).await, None);
        assert_eq!(kept(&state).await.bytes, 0);
        assert!(message_expiry(db, copy).await.is_some());
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_cap_reaches_every_kept_file_even_one_saved_from_a_stale_cache() {
        let (state, path) = temp_state("upload_expiry_cap_everywhere").await;
        let db = &state.db;
        let (file, _, copy) = kept_and_forwarded(&state).await;
        let (stray, _, _) = post_file(&state, club_channel(db).await).await;
        exec(
            db,
            "UPDATE settings SET value = '7' WHERE key = 'upload_expiry_max_days'",
        )
        .await;
        Settings::forget(db);
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "the sweep applies the cap"
        );
        assert_eq!(ttl(db, &stray).await, Some(Some(7 * DAY)));
        assert!(message_expiry(db, copy).await.is_some());
        exec(db, "UPDATE media SET ttl = 0").await;
        let _ = crate::api::admin::patch_settings(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Json(
                serde_json::from_value(serde_json::json!({"upload_expiry_max_days": 5}))
                    .expect("patch"),
            ),
        )
        .await
        .expect("cap");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(5 * DAY)),
            "setting the cap applies it at once"
        );
        assert_eq!(ttl(db, &stray).await, Some(Some(5 * DAY)));
        Settings::forget(db);
        done(state, path).await;
    }

    async fn removed(db: &Db, id: i64) -> i64 {
        sqlx::query("SELECT media_removed FROM messages WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("removed")
    }

    #[tokio::test]
    async fn unreadable_settings_never_shorten_a_kept_file() {
        let (state, path) = temp_state("upload_expiry_unreadable").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, msg, _) = post_file(&state, cid).await;
        age(db, &file, 10 * DAY).await;
        Settings::forget(db);
        exec(db, "ALTER TABLE settings RENAME TO settings_away").await;
        sweep(db, None).await.expect("sweep");
        exec(db, "ALTER TABLE settings_away RENAME TO settings").await;
        assert_eq!(ttl(db, &file).await, Some(Some(0)), "the file stays kept");
        assert_eq!(removed(db, msg).await, 0);
        exec(
            db,
            "UPDATE settings SET value = '7' WHERE key = 'upload_expiry_max_days'",
        )
        .await;
        Settings::forget(db);
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            None,
            "a cap that was read still applies"
        );
        assert_eq!(removed(db, msg).await, 1);
        Settings::forget(db);
        done(state, path).await;
    }

    #[tokio::test]
    async fn setting_the_cap_retimes_with_the_value_asked_for() {
        let (state, path) = temp_state("upload_expiry_cap_asked").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, msg, _) = post_file(&state, cid).await;
        age(db, &file, 3 * DAY).await;
        // The stored cap reads back as nonsense, which settings take as a 1 day cap.
        exec(db, "CREATE TRIGGER garble AFTER UPDATE ON settings WHEN new.key = 'upload_expiry_max_days' AND new.value = '7' BEGIN UPDATE settings SET value = 'x' WHERE key = 'upload_expiry_max_days'; END").await;
        let _ = crate::api::admin::patch_settings(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Json(
                serde_json::from_value(serde_json::json!({"upload_expiry_max_days": 7}))
                    .expect("patch"),
            ),
        )
        .await
        .expect("cap");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "the cap asked for"
        );
        Settings::forget(db);
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "a cap that reads as nonsense is not applied"
        );
        assert_eq!(removed(db, msg).await, 0);
        Settings::forget(db);
        done(state, path).await;
    }

    #[tokio::test]
    async fn members_hear_that_the_expiry_changed() {
        let (state, path) = temp_state("upload_expiry_event").await;
        club(&state).await;
        let mut rx = state.hub.subscribe();
        set(&state, "alice", "club", NEVER).await.expect("never");
        let mut heard = false;
        while let Ok(ev) = rx.try_recv() {
            heard |= matches!(ev, crate::ws::WsEvent::UploadExpiryChanged { ref server } if server == "club");
        }
        assert!(heard);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_cap_that_cannot_be_read_is_no_cap_and_shortens_nothing() {
        use super::{CAP_DAYS_MAX, CAP_KEY};
        use crate::api::controls::{Control, Kind, ROWS_SQL, number};
        let line = Control::find(CAP_KEY).expect("the cap has its registry line");
        assert_eq!(
            (line.env, line.kind, line.default),
            (
                "UPLOAD_EXPIRY_MAX_DAYS",
                Kind::Number {
                    min: 0,
                    max: CAP_DAYS_MAX
                },
                "0"
            )
        );
        assert!(
            ROWS_SQL.contains("'upload_expiry_max_days'"),
            "settings read its row"
        );
        for (stored, read) in [
            (None, Some(0)),
            (Some("7"), Some(7)),
            (Some(" 30 "), Some(30)),
            (Some("999"), Some(CAP_DAYS_MAX)),
            (Some("x"), None),
            (Some(""), None),
            (Some("1.5"), None),
        ] {
            assert_eq!(number(CAP_KEY, stored), read, "{stored:?}");
        }
        assert_eq!(
            number("upload_expiry_cap", Some("7")),
            None,
            "a key without a registry line is no cap read"
        );
        assert_eq!(number("p2p", Some("1")), None, "nor is a switch");

        let (state, path) = temp_state("upload_expiry_no_cap_read").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, msg, _) = post_file(&state, cid).await;
        age(db, &file, 10 * DAY).await;
        exec(
            db,
            "UPDATE settings SET value = '7' WHERE key = 'upload_expiry_max_days'",
        )
        .await;
        Settings::forget(db);
        assert_eq!(
            Settings::load(db).await.upload_expiry_max_days,
            7,
            "a stored cap is read, never taken for no cap"
        );
        exec(
            db,
            "UPDATE settings SET value = 'x' WHERE key = 'upload_expiry_max_days'",
        )
        .await;
        Settings::forget(db);
        assert_eq!(
            Settings::load(db).await.upload_expiry_max_days,
            1,
            "one that can't be read is not taken for no cap either"
        );
        super::retime_from_config(db, "x")
            .await
            .expect("no cap read");
        sweep(db, None).await.expect("sweep");
        assert_eq!(ttl(db, &file).await, Some(Some(0)), "nothing is shortened");
        assert_eq!(removed(db, msg).await, 0, "and nothing is deleted");
        super::retime_from_config(db, "7")
            .await
            .expect("a cap the config asked for");
        assert_eq!(ttl(db, &file).await, Some(Some(7 * DAY)));
        Settings::forget(db);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_member_of_a_never_server_can_upload_again_after_a_day() {
        let (state, path) = temp_state("kept_review_case").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, _) = post_sized(&state, cid, "bob", 4 * KIB, 0).await;
        let budget = 4 * KIB as u64;
        let again = || {
            save_within(
                &state,
                "b.bin",
                "application/octet-stream",
                b"y",
                "bob",
                Charge::own("bob"),
                budget,
            )
        };
        assert!(
            matches!(
                again().await,
                Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
            ),
            "the budget is used up on the first day"
        );
        age(db, &file, DAY + 1).await;
        again()
            .await
            .expect("a day later bob uploads again, anywhere");
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(0)),
            "the file is still there"
        );
        assert_eq!(kept_by(db, &file).await.as_deref(), Some("club"));
        assert_eq!(kept(&state).await.bytes, 4 * KIB, "charged to the server");
        exec(db, "DELETE FROM members WHERE username = 'bob'").await;
        exec(
            db,
            "INSERT INTO server_bans(server, username, created_at) VALUES('club', 'bob', 1)",
        )
        .await;
        assert_eq!(
            kept(&state).await.bytes,
            4 * KIB,
            "an uploader who left or was banned changes nothing"
        );
        assert_eq!(ttl(db, &file).await, Some(Some(0)));
        done(state, path).await;
    }

    #[tokio::test]
    async fn an_account_is_charged_for_the_default_lifetime_or_less() {
        let (state, path) = temp_state("kept_account_window").await;
        let db = &state.db;
        let cid = club(&state).await;
        for (choice, ages) in [
            (UploadExpiry::DEFAULT, [(DAY - 60, true), (DAY + 1, false)]),
            (custom(3600), [(3540, true), (3601, false)]),
            (custom(7 * DAY), [(DAY - 60, true), (DAY + 1, false)]),
            (NEVER, [(DAY - 60, true), (DAY + 1, false)]),
        ] {
            set(&state, "alice", "club", choice).await.expect("choice");
            let (file, msg) = post_sized(&state, cid, "bob", 1, 0).await;
            for (secs, counted) in ages {
                age(db, &file, secs).await;
                assert_eq!(
                    check_budget(db, Charge::own("bob"), 1, 1).await.is_err(),
                    counted,
                    "{choice:?} after {secs} s"
                );
            }
            delete_message(db, msg).await;
            exec(db, "DELETE FROM media").await;
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_server_at_its_kept_budget_gives_new_files_the_default_lifetime() {
        let (state, path) = temp_state("kept_full").await;
        let state = kept_limit(state, 1);
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        assert_eq!(
            kept(&state).await,
            KeptSpace {
                bytes: 0,
                limit: 1024 * KIB,
                full: false
            }
        );
        let (first, first_msg) = post_sized(&state, cid, "bob", 600 * KIB, 0).await;
        assert_eq!(ttl(db, &first).await, Some(Some(0)));
        assert_eq!(kept_by(db, &first).await.as_deref(), Some("club"));
        assert_eq!(message_expiry(db, first_msg).await, None);
        let (second, second_msg) = post_sized(&state, cid, "bob", 600 * KIB, 0).await;
        assert_eq!(
            ttl(db, &second).await,
            Some(None),
            "no room: posted, with the default lifetime"
        );
        assert_eq!(kept_by(db, &second).await, None);
        assert!(message_expiry(db, second_msg).await.is_some());
        let (small, _) = post_sized(&state, cid, "bob", 100 * KIB, 0).await;
        assert_eq!(
            ttl(db, &small).await,
            Some(Some(0)),
            "a file that fits is kept"
        );
        assert_eq!(
            kept(&state).await,
            KeptSpace {
                bytes: 700 * KIB,
                limit: 1024 * KIB,
                full: true
            }
        );
        age(db, &first, 30 * DAY).await;
        age(db, &second, DAY - 60).await;
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &first).await,
            Some(Some(0)),
            "a full budget deletes nothing"
        );
        assert_eq!(ttl(db, &second).await, Some(None));
        delete_message(db, first_msg).await;
        assert_eq!(kept(&state).await.bytes, 100 * KIB, "space frees up");
        let (third, _) = post_sized(&state, cid, "bob", 600 * KIB, 0).await;
        assert_eq!(ttl(db, &third).await, Some(Some(0)));
        assert_eq!(kept(&state).await.bytes, 700 * KIB);
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_kept_space_reads_full_when_the_largest_upload_no_longer_fits() {
        let (state, path) = temp_state("kept_reads_full").await;
        let state = kept_limit(state, 4);
        let cid = club(&state).await;
        set(&state, "alice", "club", custom(7 * DAY))
            .await
            .expect("a week");
        post_sized(&state, cid, "bob", 3 * 1024 * KIB, 0).await;
        assert!(!kept(&state).await.full, "one more upload of 1 MiB fits");
        post_sized(&state, cid, "bob", 1, 0).await;
        assert_eq!(
            kept(&state).await,
            KeptSpace {
                bytes: 3 * 1024 * KIB + 1,
                limit: 4 * 1024 * KIB,
                full: true
            }
        );
        set(&state, "alice", "club", UploadExpiry::DEFAULT)
            .await
            .expect("default");
        assert!(!kept(&state).await.full, "nothing is kept longer any more");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_kept_limit_below_the_largest_upload_is_not_full_while_empty() {
        let (state, path) = temp_state("kept_small_limit").await;
        let state = state.with_limits(std::sync::Arc::new(Limits {
            upload_server_kept_mib: 1,
            upload_owner_kept_mib: 1,
            upload_max_mib: 4,
            ..Limits::default()
        }));
        let cid = club(&state).await;
        let never = set(&state, "alice", "club", NEVER).await.expect("never");
        assert!(!never.kept.full, "an empty space is not full");
        assert_eq!(never.owner_kept.map(|o| o.full), Some(false));
        post_sized(&state, cid, "bob", 1, 0).await;
        let after = space(&state, "alice", "club").await;
        assert!(
            after.kept.full,
            "a file as large as the space no longer fits"
        );
        assert_eq!(after.owner_kept.map(|o| o.full), Some(true));
        done(state, path).await;
    }

    #[tokio::test]
    async fn lengthening_extends_the_newest_files_until_the_budget_is_reached() {
        let (state, path) = temp_state("kept_lengthen").await;
        let state = kept_limit(state, 1);
        let db = &state.db;
        let cid = club(&state).await;
        let (a, a_msg) = post_sized(&state, cid, "bob", 100 * KIB, 4 * 3600).await;
        let (b, _) = post_sized(&state, cid, "bob", 500 * KIB, 3 * 3600).await;
        let (c, c_msg) = post_sized(&state, cid, "bob", 500 * KIB, 2 * 3600).await;
        let (d, d_msg) = post_sized(&state, cid, "alice", 300 * KIB, 3600).await;
        let never = set(&state, "alice", "club", NEVER).await.expect("never");
        assert_eq!(
            never.extended,
            Some(Extended {
                files: 2,
                bytes: 800 * KIB,
                left_files: 2,
                left_bytes: 600 * KIB
            }),
            "newest first, and it stops at the first file that does not fit"
        );
        assert_eq!(never.kept.bytes, 800 * KIB);
        for (id, is_kept) in [(&d, true), (&c, true), (&b, false), (&a, false)] {
            assert_eq!(ttl(db, id).await, Some(is_kept.then_some(0)), "{id}");
            assert_eq!(kept_by(db, id).await.is_some(), is_kept, "{id}");
        }
        assert_eq!(message_expiry(db, d_msg).await, None);
        assert!(message_expiry(db, a_msg).await.is_some());

        let month = set(&state, "alice", "club", custom(30 * DAY))
            .await
            .expect("a month");
        assert_eq!(
            month.extended,
            Some(Extended {
                files: 0,
                bytes: 0,
                left_files: 2,
                left_bytes: 600 * KIB
            })
        );
        assert_eq!(ttl(db, &d).await, Some(Some(30 * DAY)));
        assert_eq!(ttl(db, &c).await, Some(Some(30 * DAY)));
        assert_eq!(ttl(db, &b).await, Some(None));
        assert_eq!(kept(&state).await.bytes, 800 * KIB);

        delete_message(db, c_msg).await;
        let again = set(&state, "alice", "club", NEVER).await.expect("never");
        assert_eq!(
            again.extended,
            Some(Extended {
                files: 2,
                bytes: 600 * KIB,
                left_files: 0,
                left_bytes: 0
            }),
            "freed space takes the files left out before"
        );
        assert_eq!(again.kept.bytes, 900 * KIB);
        for id in [&a, &b, &d] {
            assert_eq!(ttl(db, id).await, Some(Some(0)), "{id}");
        }

        let back = set(&state, "alice", "club", UploadExpiry::DEFAULT)
            .await
            .expect("default");
        assert_eq!(back.extended, Some(Extended::default()));
        assert_eq!(back.kept.bytes, 0);
        for id in [&a, &b, &d] {
            assert_eq!(ttl(db, id).await, Some(None), "{id}");
            assert_eq!(kept_by(db, id).await, None, "{id}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_kept_file_keeps_its_place_when_newer_files_did_not_fit() {
        let (state, path) = temp_state("kept_keeps_place").await;
        let state = kept_limit(state, 1);
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (old, _) = post_sized(&state, cid, "bob", 900 * KIB, 0).await;
        age(db, &old, 40 * DAY).await;
        let (new, _) = post_sized(&state, cid, "bob", 900 * KIB, 60).await;
        assert_eq!(ttl(db, &new).await, Some(None));
        let month = set(&state, "alice", "club", custom(60 * DAY))
            .await
            .expect("two months");
        assert_eq!(
            month.extended,
            Some(Extended {
                files: 0,
                bytes: 0,
                left_files: 1,
                left_bytes: 900 * KIB
            })
        );
        assert_eq!(ttl(db, &old).await, Some(Some(60 * DAY)));
        assert_eq!(kept_by(db, &old).await.as_deref(), Some("club"));
        assert_eq!(ttl(db, &new).await, Some(None));
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &old).await,
            Some(Some(60 * DAY)),
            "nothing is deleted for a newer file"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_limit_at_0_keeps_every_file_and_still_counts_them() {
        let (state, path) = temp_state("kept_no_limit").await;
        let gib = 1024 * 1024 * KIB;
        let cid = club(&state).await;
        assert_eq!(
            kept(&state).await,
            KeptSpace {
                bytes: 0,
                limit: 8 * gib,
                full: false
            },
            "8 GiB unless set"
        );
        assert_eq!(
            space(&state, "alice", "club").await.owner_kept,
            None,
            "nobody is charged before someone chooses a longer time"
        );
        let week = set(&state, "alice", "club", custom(7 * DAY))
            .await
            .expect("a week");
        assert_eq!(
            week.owner_kept,
            Some(OwnerKept {
                bytes: Some(0),
                limit: 16 * gib,
                full: false
            }),
            "16 GiB for an account unless set"
        );
        set(&state, "alice", "club", UploadExpiry::DEFAULT)
            .await
            .expect("default");
        let state = kept_limit(state, 0);
        let db = &state.db;
        let (a, _) = post_sized(&state, cid, "bob", 6 * gib, 60).await;
        let (b, _) = post_sized(&state, cid, "bob", 6 * gib, 30).await;
        let never = set(&state, "alice", "club", NEVER).await.expect("never");
        assert_eq!(
            never.extended,
            Some(Extended {
                files: 2,
                bytes: 12 * gib,
                left_files: 0,
                left_bytes: 0
            })
        );
        let (c, _) = post_sized(&state, cid, "bob", 9 * gib, 0).await;
        for id in [&a, &b, &c] {
            assert_eq!(ttl(db, id).await, Some(Some(0)), "{id}");
            assert_eq!(kept_by(db, id).await.as_deref(), Some("club"), "{id}");
        }
        assert_eq!(
            kept(&state).await,
            KeptSpace {
                bytes: 21 * gib,
                limit: 0,
                full: false
            }
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_default_limit_leaves_a_file_past_8_gib_at_the_default() {
        let (state, path) = temp_state("kept_default_limit").await;
        let db = &state.db;
        let gib = 1024 * 1024 * KIB;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (fits, _) = post_sized(&state, cid, "bob", 8 * gib, 0).await;
        let (over, _) = post_sized(&state, cid, "bob", 1, 0).await;
        assert_eq!(ttl(db, &fits).await, Some(Some(0)));
        assert_eq!(ttl(db, &over).await, Some(None));
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_webhook_file_is_charged_to_its_owner_for_a_day_and_then_to_the_server() {
        let (state, path) = temp_state("kept_webhook").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let hook = |account| Charge {
            account,
            hooks_of: Some("club"),
        };
        let (file, _) = save_upload(
            &state,
            "h.txt",
            "text/plain",
            b"x",
            "@webhook:1",
            hook("bob"),
        )
        .await
        .expect("webhook upload");
        insert_message(
            &state,
            Some(cid),
            None,
            None,
            &mem_user("@webhook:1", false),
            req("", Some(file.clone())).0,
            None,
            Vec::new(),
            None,
        )
        .await
        .expect("webhook post");
        let charged: (Option<String>, Option<String>) =
            sqlx::query("SELECT charged_to, charged_server FROM media WHERE id = $1")
                .bind(&file)
                .fetch_one(db)
                .await
                .map(|r| (r.get(0), r.get(1)))
                .expect("charges");
        assert_eq!(
            charged,
            (Some("bob".to_string()), Some("club".to_string())),
            "the webhook charges stay as they were"
        );
        assert_eq!(ttl(db, &file).await, Some(Some(0)));
        assert_eq!(kept_by(db, &file).await.as_deref(), Some("club"));
        let full = |charge| async move { check_budget(db, charge, 1, 1).await.is_err() };
        assert!(full(hook("bob")).await, "the owner on the first day");
        assert!(
            full(hook("carol")).await,
            "the server's webhooks together on the first day"
        );
        age(db, &file, DAY + 1).await;
        assert!(!full(hook("bob")).await, "the owner is free after a day");
        assert!(!full(hook("carol")).await, "so are the server's webhooks");
        assert_eq!(kept(&state).await.bytes, 1, "the server pays for the rest");

        let (own, _) = post_sized(&state, cid, "bob", 5, 2 * DAY).await;
        assert_eq!(kept(&state).await.bytes, 6);
        exec(
            db,
            "INSERT INTO webhooks(id, server, channel_id, name, token_hash, creator, created_at) SELECT 1, 'club', id, 'CI', 'x', 'bob', 1 FROM channels WHERE server = 'club'",
        )
        .await;
        crate::api::admin::hide_user_rows(&state, "bob", crate::api::admin::PurgeKind::User)
            .await
            .expect("bob deletes the account");
        crate::api::admin::finish_purge(&state, crate::api::admin::PurgeKind::User, "bob")
            .await
            .expect("purge");
        assert_eq!(
            ttl(db, &own).await,
            Some(None),
            "the account's own messages are purged, so its files fall back to the default"
        );
        assert_eq!(kept_by(db, &own).await, None);
        assert_eq!(ttl(db, &file).await, Some(Some(0)));
        assert_eq!(
            kept_by(db, &file).await.as_deref(),
            Some("club"),
            "the file its webhook posted stays charged to the server"
        );
        assert_eq!(kept(&state).await.bytes, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_file_that_loses_its_place_leaves_the_kept_space() {
        let (state, path) = temp_state("kept_release").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (gone, gone_msg) = post_sized(&state, cid, "bob", 3, 0).await;
        let (capped, _) = post_sized(&state, cid, "bob", 5, 0).await;
        assert_eq!(kept(&state).await.bytes, 8);
        delete_message(db, gone_msg).await;
        assert_eq!(kept_by(db, &gone).await, None, "its message was deleted");
        assert_eq!(kept(&state).await.bytes, 5);

        let admin = |days: i64| {
            crate::api::admin::patch_settings(
                State(state.clone()),
                Authed(mem_user("root", true)),
                Json(
                    serde_json::from_value(serde_json::json!({"upload_expiry_max_days": days}))
                        .expect("patch"),
                ),
            )
        };
        let _ = admin(7).await.expect("a week at most");
        assert_eq!(ttl(db, &capped).await, Some(Some(7 * DAY)));
        assert_eq!(
            kept(&state).await.bytes,
            5,
            "a cap past the default is still the server's time"
        );
        let _ = admin(1).await.expect("a day at most");
        assert_eq!(ttl(db, &capped).await, Some(Some(DAY)));
        assert_eq!(kept_by(db, &capped).await, None);
        assert_eq!(
            kept(&state).await.bytes,
            0,
            "a one day cap leaves nothing kept longer"
        );
        let _ = admin(0).await.expect("no cap");
        assert_eq!(ttl(db, &capped).await, Some(Some(0)));
        assert_eq!(
            kept(&state).await.bytes,
            5,
            "lifting the cap charges it again"
        );

        exec(db, "UPDATE media SET kept_by = 'club', ttl = 0").await;
        exec(
            db,
            "UPDATE settings SET value = '1' WHERE key = 'upload_expiry_max_days'",
        )
        .await;
        Settings::forget(db);
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            kept_by(db, &capped).await,
            None,
            "the sweep's clamp does the same"
        );
        exec(
            db,
            "UPDATE settings SET value = '0' WHERE key = 'upload_expiry_max_days'",
        )
        .await;
        Settings::forget(db);
        set(&state, "alice", "club", NEVER).await.expect("never");
        assert_eq!(kept(&state).await.bytes, 5);

        crate::db::purge_messages(
            db,
            "channel_id IN (SELECT id FROM channels WHERE server = $1)",
            "club",
        )
        .await
        .expect("the server is purged");
        assert_eq!(ttl(db, &capped).await, Some(None));
        assert_eq!(kept_by(db, &capped).await, None);
        Settings::forget(db);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_start_that_changes_the_cap_retimes_with_the_value_the_config_asked_for() {
        use crate::config::AppConfig;
        use crate::instance::{Instance, InstanceConfig};
        use crate::ws::{Hub, WsEvent};
        let (state, path) = temp_state("upload_expiry_cap_config").await;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, msg, _) = post_file(&state, cid).await;
        age(&state.db, &file, 3 * DAY).await;
        // The stored cap reads back as nonsense, which settings take as a 1 day cap.
        exec(&state.db, "CREATE TRIGGER garble AFTER UPDATE ON settings WHEN new.key = 'upload_expiry_max_days' AND new.value = '7' BEGIN UPDATE settings SET value = 'x' WHERE key = 'upload_expiry_max_days'; END").await;
        Settings::forget(&state.db);
        crate::db::close(&state.db).await;

        let opts = AppConfig::from_map(&[("UPLOAD_EXPIRY_MAX_DAYS", "7")])
            .expect("config")
            .db_options();
        let db = crate::db::open_with(path.to_str(), &opts)
            .await
            .expect("a start with the cap set in the env");
        let instance = Instance::load(&db, &InstanceConfig::default())
            .await
            .expect("instance");
        let started = AppState::new(db, Hub::new(), None, None, instance);
        let db = &started.db;
        let mut rx = started.hub.subscribe();
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(0)),
            "init leaves files alone"
        );
        crate::api::controls::config_applied(&started).await;
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "the cap the config asked for"
        );
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::SettingsChanged { settings: _ })
        ));
        Settings::forget(db);
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "a cap that reads as nonsense is not applied"
        );
        assert_eq!(removed(db, msg).await, 0);
        Settings::forget(db);
        done(started, path).await;
    }

    #[tokio::test]
    async fn a_renamed_server_keeps_its_kept_files() {
        let (state, path) = temp_state("kept_rename").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, _) = post_sized(&state, cid, "bob", 7, 0).await;
        let _ = crate::api::servers::update_server(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            Json(serde_json::from_value(serde_json::json!({"name": "Lodge"})).expect("patch")),
        )
        .await
        .expect("rename");
        assert_eq!(kept_by(db, &file).await.as_deref(), Some("lodge"));
        let space = get_upload_expiry(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("lodge".into()),
        )
        .await
        .expect("get")
        .0;
        assert_eq!(space.kept.bytes, 7);
        done(state, path).await;
    }

    #[tokio::test]
    async fn an_account_making_server_after_server_stops_at_the_owners_bound() {
        let (state, path) = temp_state("kept_owner_bound").await;
        let state = kept_limits(state, 1, 2);
        let db = &state.db;
        club(&state).await;
        let names = ["s1", "s2", "s3", "s4", "s5"];
        let mut files = Vec::new();
        let mut channels = Vec::new();
        for name in names {
            let cid = server_of(db, name, Some("alice")).await;
            set(&state, "alice", name, NEVER).await.expect("never");
            let (file, _) = post_sized(&state, cid, "alice", 900 * KIB, 0).await;
            files.push(file);
            channels.push(cid);
        }
        for (n, file) in files.iter().enumerate() {
            let is_kept = n < 2;
            assert_eq!(
                ttl(db, file).await,
                Some(is_kept.then_some(0)),
                "server {}: posted, kept longer only inside the owner's bound",
                names[n]
            );
            assert_eq!(kept_by(db, file).await.is_some(), is_kept);
        }
        assert_eq!(kept_in(db, &names).await, (2, 1800 * KIB));
        let third = space(&state, "alice", "s3").await;
        assert_eq!(
            third.kept,
            KeptSpace {
                bytes: 0,
                limit: 1024 * KIB,
                full: false
            },
            "the server itself has room"
        );
        assert_eq!(
            third.owner_kept,
            Some(OwnerKept {
                bytes: Some(1800 * KIB),
                limit: 2048 * KIB,
                full: true
            })
        );
        let (small, _) = post_sized(&state, channels[2], "bob", 200 * KIB, 0).await;
        assert_eq!(
            ttl(db, &small).await,
            Some(Some(0)),
            "a file that fits both is kept"
        );
        let (over, _) = post_sized(&state, channels[3], "bob", 100 * KIB, 0).await;
        assert_eq!(ttl(db, &over).await, Some(None));
        exec(
            db,
            &format!("UPDATE media SET uploaded_at = {}", now() - 2 * DAY),
        )
        .await;
        sweep(db, None).await.expect("sweep");
        assert!(
            check_budget(db, Charge::own("alice"), 1, 1).await.is_ok(),
            "two days later the account's own budget is free again"
        );
        for (name, cid) in names.iter().zip(&channels) {
            let (again, _) = post_sized(&state, *cid, "alice", 900 * KIB, 0).await;
            assert_eq!(ttl(db, &again).await, Some(None), "{name}: still bounded");
        }
        assert_eq!(
            kept_in(db, &names).await,
            (3, 2000 * KIB),
            "kept bytes stopped growing, and nothing kept was deleted"
        );
        done(state, path).await;
    }

    /// The account charged for the longer choice of `server`.
    async fn charged(db: &Db, server: &str) -> Option<String> {
        sqlx::query("SELECT upload_expiry_by FROM servers WHERE name = $1")
            .bind(server)
            .fetch_one(db)
            .await
            .expect("server")
            .try_get(0)
            .expect("upload_expiry_by")
    }

    #[tokio::test]
    async fn a_creator_who_handed_servers_over_is_not_charged_for_the_new_admins_choices() {
        let (state, path) = temp_state("kept_handed_over").await;
        let state = kept_limits(state, 4, 2);
        let db = &state.db;
        club(&state).await;
        let s1 = server_of(db, "s1", Some("alice")).await;
        let s2 = server_of(db, "s2", Some("alice")).await;
        let mine = server_of(db, "mine", Some("alice")).await;
        for server in ["s1", "s2"] {
            let _ = crate::api::servers::transfer_admin(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path(server.to_string()),
                Json(serde_json::from_value(serde_json::json!({"username": "bob"})).expect("body")),
            )
            .await
            .expect("alice hands the server to bob");
            exec(
                db,
                &format!("DELETE FROM members WHERE server = '{server}' AND username = 'alice'"),
            )
            .await;
            set(&state, "bob", server, NEVER)
                .await
                .expect("bob keeps files");
        }
        post_sized(&state, s1, "bob", 1000 * KIB, 0).await;
        post_sized(&state, s2, "bob", 1000 * KIB, 0).await;
        set(&state, "alice", "mine", NEVER).await.expect("never");
        let (hers, _) = post_sized(&state, mine, "alice", 100 * KIB, 0).await;
        assert_eq!(
            ttl(db, &hers).await,
            Some(Some(0)),
            "alice has her whole bound for what she chose herself"
        );
        assert_eq!(
            space(&state, "alice", "mine").await.owner_kept,
            Some(OwnerKept {
                bytes: Some(100 * KIB),
                limit: 2048 * KIB,
                full: false
            })
        );
        assert_eq!(
            space(&state, "bob", "s1").await.owner_kept,
            Some(OwnerKept {
                bytes: Some(2000 * KIB),
                limit: 2048 * KIB,
                full: true
            }),
            "bob pays for what he chose"
        );
        let (over, _) = post_sized(&state, s2, "bob", 100 * KIB, 0).await;
        assert_eq!(
            ttl(db, &over).await,
            Some(None),
            "bob's bound holds in the servers he set"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn whoever_sets_or_lengthens_the_choice_is_charged_from_then_on() {
        let (state, path) = temp_state("kept_charged").await;
        let state = kept_limits(state, 4, 2);
        let db = &state.db;
        club(&state).await;
        let cid = server_of(db, "s1", Some("alice")).await;
        add_member(db, "s1", "carol", 1, ALL_PERMS, 1).await;
        let bytes = |who: &'static str| {
            let state = state.clone();
            async move { space(&state, who, "s1").await.owner_kept.map(|o| o.bytes) }
        };
        set(&state, "alice", "s1", custom(7 * DAY))
            .await
            .expect("a week");
        post_sized(&state, cid, "bob", 900 * KIB, 0).await;
        assert_eq!(charged(db, "s1").await.as_deref(), Some("alice"));
        assert_eq!(bytes("alice").await, Some(Some(900 * KIB)));
        assert_eq!(
            bytes("carol").await,
            Some(None),
            "a co-admin reads no bytes of the charged account"
        );

        set(&state, "carol", "s1", NEVER).await.expect("never");
        assert_eq!(
            charged(db, "s1").await.as_deref(),
            Some("carol"),
            "a co-admin who lengthens it takes the charge over"
        );
        assert_eq!(bytes("carol").await, Some(Some(900 * KIB)));
        assert_eq!(bytes("alice").await, Some(None));

        set(&state, "alice", "s1", custom(30 * DAY))
            .await
            .expect("a month");
        assert_eq!(
            charged(db, "s1").await.as_deref(),
            Some("carol"),
            "shortening it charges nobody new"
        );
        set(&state, "alice", "s1", custom(30 * DAY))
            .await
            .expect("the same again");
        assert_eq!(charged(db, "s1").await.as_deref(), Some("carol"));

        set(&state, "alice", "s1", UploadExpiry::DEFAULT)
            .await
            .expect("default");
        assert_eq!(charged(db, "s1").await, None, "clearing it charges nobody");
        assert_eq!(space(&state, "carol", "s1").await.owner_kept, None);
        set(&state, "alice", "s1", custom(3600))
            .await
            .expect("an hour");
        assert_eq!(
            charged(db, "s1").await,
            None,
            "a time no longer than the default charges nobody"
        );
        set(&state, "alice", "s1", custom(2 * DAY))
            .await
            .expect("two days");
        assert_eq!(charged(db, "s1").await.as_deref(), Some("alice"));
        assert_eq!(bytes("alice").await, Some(Some(900 * KIB)));

        let _ =
            crate::api::admin::hide_user_rows(&state, "alice", crate::api::admin::PurgeKind::User)
                .await
                .expect("alice's account is deleted");
        assert_eq!(
            charged(db, "s1").await,
            None,
            "a deleted account is charged for nothing"
        );
        assert_eq!(space(&state, "carol", "s1").await.owner_kept, None);
        for _ in 0..2 {
            let (file, _) = post_sized(&state, cid, "bob", 900 * KIB, 0).await;
            assert_eq!(
                ttl(db, &file).await,
                Some(Some(2 * DAY)),
                "with nobody charged only the server's own bound holds"
            );
        }
        set(&state, "carol", "s1", custom(2 * DAY))
            .await
            .expect("carol sets the choice again");
        assert_eq!(charged(db, "s1").await.as_deref(), Some("carol"));
        assert_eq!(
            space(&state, "carol", "s1").await.owner_kept,
            Some(OwnerKept {
                bytes: Some(2700 * KIB),
                limit: 2048 * KIB,
                full: true
            }),
            "she is charged for what the server keeps, past her bound"
        );
        assert_eq!(
            kept_in(db, &["s1"]).await,
            (3, 2700 * KIB),
            "nothing is deleted"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_kept_file_written_without_its_charge_is_charged_not_shortened() {
        let (state, path) = temp_state("kept_no_charge").await;
        let state = kept_limit(state, 1);
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        post_sized(&state, cid, "bob", 900 * KIB, 0).await;
        let (stray, stray_msg) = post_sized(&state, cid, "bob", 900 * KIB, 0).await;
        assert_eq!(ttl(db, &stray).await, Some(None), "no room");
        // What a process of the previous build writes while this build upgrades the database: a
        // kept file with no charge.
        sqlx::query("UPDATE media SET ttl = 0 WHERE id = $1")
            .bind(&stray)
            .execute(db)
            .await
            .expect("kept by the old build");
        age(db, &stray, 10 * DAY).await;
        let longer = set(&state, "alice", "club", custom(60 * DAY))
            .await
            .expect("two months");
        assert_eq!(
            ttl(db, &stray).await,
            Some(Some(60 * DAY)),
            "a kept file is never shortened for room"
        );
        assert_eq!(kept_by(db, &stray).await.as_deref(), Some("club"));
        assert_eq!(
            longer.kept.bytes,
            1800 * KIB,
            "it is charged from now on, past the limit"
        );
        assert_eq!(longer.extended, Some(Extended::default()));
        sweep(db, None).await.expect("sweep");
        assert_eq!(removed(db, stray_msg).await, 0, "and never deleted");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_post_in_a_server_that_keeps_nothing_longer_takes_no_lock() {
        let Some((state, temp)) = pg_state("kept_no_lock").await else {
            return;
        };
        let cid = club(&state).await;
        let mut held = state.db.acquire().await.expect("another session");
        sqlx::query("SELECT COUNT(*) FROM pg_advisory_lock(hashtextextended($1, 0))")
            .bind("media kept:club")
            .execute(&mut *held)
            .await
            .expect("holds the kept space of club");
        let file = stored(&state, "bob", 1, 0).await;
        let posted =
            tokio::time::timeout(std::time::Duration::from_secs(20), post(&state, cid, &file))
                .await;
        sqlx::query("SELECT COUNT(*) FROM pg_advisory_unlock_all()")
            .execute(&mut *held)
            .await
            .expect("unlock");
        drop(held);
        assert_eq!(
            posted.ok(),
            Some(true),
            "a file at the default lifetime does not wait for the server's kept space"
        );
        pg_done(state, temp).await;
    }

    #[tokio::test]
    async fn lengthening_stops_at_the_owners_bound_too() {
        let (state, path) = temp_state("kept_owner_lengthen").await;
        let state = kept_limits(state, 4, 1);
        let db = &state.db;
        club(&state).await;
        let s1 = server_of(db, "s1", Some("alice")).await;
        let s2 = server_of(db, "s2", Some("alice")).await;
        set(&state, "alice", "s1", NEVER).await.expect("never");
        post_sized(&state, s1, "bob", 600 * KIB, 0).await;
        let (a, _) = post_sized(&state, s2, "bob", 300 * KIB, 2 * 3600).await;
        let (b, _) = post_sized(&state, s2, "bob", 300 * KIB, 3600).await;
        let never = set(&state, "alice", "s2", NEVER).await.expect("never");
        assert_eq!(
            never.extended,
            Some(Extended {
                files: 1,
                bytes: 300 * KIB,
                left_files: 1,
                left_bytes: 300 * KIB
            }),
            "the server has room for both, its owner for one"
        );
        assert_eq!(never.kept.bytes, 300 * KIB);
        assert_eq!(
            never.owner_kept,
            Some(OwnerKept {
                bytes: Some(900 * KIB),
                limit: 1024 * KIB,
                full: true
            })
        );
        assert_eq!(ttl(db, &b).await, Some(Some(0)), "the newest");
        assert_eq!(ttl(db, &a).await, Some(None));
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_server_made_for_someone_is_charged_to_whoever_set_its_choice() {
        let (state, path) = temp_state("kept_made_for").await;
        let state = kept_limits(state, 4, 1);
        let db = &state.db;
        club(&state).await;
        let cid = server_of(db, "commons", None).await;
        add_member(db, "commons", "carol", 1, ALL_PERMS, 1).await;
        // A longer choice with no account recorded: only the server's own bound holds.
        exec(
            db,
            "UPDATE servers SET upload_expiry = 0 WHERE name = 'commons'",
        )
        .await;
        for _ in 0..2 {
            let (file, _) = post_sized(&state, cid, "bob", 900 * KIB, 0).await;
            assert_eq!(ttl(db, &file).await, Some(Some(0)));
        }
        let commons = space(&state, "carol", "commons").await;
        assert_eq!(commons.kept.bytes, 1800 * KIB);
        assert_eq!(commons.owner_kept, None);

        let set_again = set(&state, "carol", "commons", NEVER)
            .await
            .expect("carol sets it");
        assert_eq!(charged(db, "commons").await.as_deref(), Some("carol"));
        assert_eq!(
            set_again.owner_kept,
            Some(OwnerKept {
                bytes: Some(1800 * KIB),
                limit: 1024 * KIB,
                full: true
            }),
            "the server has no creator, and whoever set its choice is charged"
        );
        let (over, _) = post_sized(&state, cid, "bob", 100 * KIB, 0).await;
        assert_eq!(
            ttl(db, &over).await,
            Some(None),
            "her bound holds although the server has room"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_owners_limit_at_0_bounds_nothing() {
        let (state, path) = temp_state("kept_owner_no_limit").await;
        let state = kept_limits(state, 1, 0);
        let db = &state.db;
        club(&state).await;
        let names = ["s1", "s2", "s3"];
        for name in names {
            let cid = server_of(db, name, Some("alice")).await;
            set(&state, "alice", name, NEVER).await.expect("never");
            let (file, _) = post_sized(&state, cid, "alice", 900 * KIB, 0).await;
            assert_eq!(ttl(db, &file).await, Some(Some(0)), "{name}");
        }
        assert_eq!(
            space(&state, "alice", "s3").await.owner_kept,
            Some(OwnerKept {
                bytes: Some(2700 * KIB),
                limit: 0,
                full: false
            })
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_start_from_config_extends_within_the_kept_space_like_the_page() {
        use crate::config::AppConfig;
        use crate::instance::{Instance, InstanceConfig};
        use crate::ws::Hub;
        let (state, path) = temp_state("kept_cap_config").await;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let cap = |state: &AppState, days: i64| {
            crate::api::admin::patch_settings(
                State(state.clone()),
                Authed(mem_user("root", true)),
                Json(
                    serde_json::from_value(serde_json::json!({"upload_expiry_max_days": days}))
                        .expect("patch"),
                ),
            )
        };
        let _ = cap(&state, 1).await.expect("a day at most");
        let (old, _) = post_sized(&state, cid, "bob", 600 * KIB, 2 * 3600).await;
        let (new, _) = post_sized(&state, cid, "bob", 600 * KIB, 3600).await;
        for id in [&old, &new] {
            assert_eq!(ttl(&state.db, id).await, Some(Some(DAY)), "{id}");
            assert_eq!(kept_by(&state.db, id).await, None, "{id}");
        }
        Settings::forget(&state.db);
        crate::db::close(&state.db).await;

        let opts = AppConfig::from_map(&[
            ("UPLOAD_EXPIRY_MAX_DAYS", "30"),
            ("UPLOAD_SERVER_KEPT_MIB", "1"),
        ])
        .expect("config")
        .db_options();
        let db = crate::db::open_with(path.to_str(), &opts)
            .await
            .expect("a start with a longer cap and 1 MiB of kept space");
        let instance = Instance::load(&db, &InstanceConfig::default())
            .await
            .expect("instance");
        let started = AppState::new(db, Hub::new(), None, None, instance)
            .with_limits(std::sync::Arc::new(opts.limits.clone()));
        let db = &started.db;
        crate::api::controls::config_applied(&started).await;
        let after = |db: &Db| {
            let (db, old, new) = (db.clone(), old.clone(), new.clone());
            async move {
                (
                    ttl(&db, &new).await,
                    kept_by(&db, &new).await,
                    ttl(&db, &old).await,
                    kept_by(&db, &old).await,
                )
            }
        };
        let newest_only = (
            Some(Some(30 * DAY)),
            Some("club".to_string()),
            Some(None),
            None,
        );
        assert_eq!(
            after(db).await,
            newest_only,
            "the start extends newest first up to the server's kept space"
        );
        let _ = cap(&started, 1).await.expect("a day at most again");
        assert_eq!(kept_by(db, &new).await, None);
        let _ = cap(&started, 30).await.expect("30 days through the page");
        assert_eq!(after(db).await, newest_only, "the page does the same");
        Settings::forget(db);
        done(started, path).await;
    }

    /// 15 files of 100 KiB posted at once in each of two never servers of one owner, who may
    /// keep 1 MiB across them.
    async fn owner_race(state: AppState) -> AppState {
        let state = kept_limits(state, 4, 1);
        club(&state).await;
        let mut channels = Vec::new();
        for name in ["s1", "s2"] {
            channels.push(server_of(&state.db, name, Some("alice")).await);
            set(&state, "alice", name, NEVER).await.expect("never");
        }
        let mut posts = Vec::new();
        for n in 0..30 {
            posts.push((channels[n % 2], stored(&state, "bob", 100 * KIB, 0).await));
        }
        let sent =
            futures_util::future::join_all(posts.iter().map(|(cid, id)| post(&state, *cid, id)))
                .await;
        assert!(sent.iter().all(|ok| *ok), "no post is refused");
        let (files, bytes) = kept_in(&state.db, &["s1", "s2"]).await;
        assert!(bytes <= 1024 * KIB, "{bytes} bytes kept past 1 MiB");
        assert_eq!(files, 10, "the owner's space is filled exactly");
        state
    }

    #[tokio::test]
    async fn two_servers_of_one_owner_never_pass_the_owners_bound_together() {
        let (state, path) = temp_state("kept_owner_race").await;
        done(owner_race(state).await, path).await;
        if let Some((state, temp)) = pg_state("kept_owner_race").await {
            pg_done(owner_race(state).await, temp).await;
        }
    }

    async fn kept_rows(db: &Db) -> (i64, i64) {
        let row = sqlx::query(
            "SELECT COUNT(*), CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM media WHERE kept_by = 'club'",
        )
        .fetch_one(db)
        .await
        .expect("kept");
        (row.get(0), row.get(1))
    }

    fn post(state: &AppState, cid: i64, id: &str) -> impl Future<Output = bool> + use<> {
        let send = send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user("bob", false)),
            req("", Some(id.to_string())),
        );
        async move { send.await.is_ok() }
    }

    /// 30 files of 100 KiB posted at once in a never server with 1 MiB of kept space.
    async fn posts_race(state: AppState) -> AppState {
        let state = kept_limit(state, 1);
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let mut ids = Vec::new();
        for _ in 0..30 {
            ids.push(stored(&state, "bob", 100 * KIB, 0).await);
        }
        let sent = futures_util::future::join_all(ids.iter().map(|id| post(&state, cid, id))).await;
        assert!(sent.iter().all(|ok| *ok), "no post is refused");
        let (files, bytes) = kept_rows(&state.db).await;
        assert!(bytes <= 1024 * KIB, "{bytes} bytes kept past 1 MiB");
        assert_eq!(files, 10, "the kept space is filled exactly");
        state
    }

    /// 20 files of 100 KiB posted while the owner moves the server, which already has 6, to never.
    async fn change_race(state: AppState) -> AppState {
        let state = kept_limit(state, 1);
        let cid = club(&state).await;
        for _ in 0..6 {
            post_sized(&state, cid, "bob", 100 * KIB, 60).await;
        }
        let mut ids = Vec::new();
        for _ in 0..20 {
            ids.push(stored(&state, "bob", 100 * KIB, 0).await);
        }
        let posts = futures_util::future::join_all(ids.iter().map(|id| post(&state, cid, id)));
        let (sent, changed) = tokio::join!(posts, set(&state, "alice", "club", NEVER));
        assert!(sent.iter().all(|ok| *ok), "no post is refused");
        changed.expect("never");
        let (files, bytes) = kept_rows(&state.db).await;
        assert!(bytes <= 1024 * KIB, "{bytes} bytes kept past 1 MiB");
        assert_eq!(files, 10, "the kept space is filled exactly");
        state
    }

    #[tokio::test]
    async fn concurrent_posts_never_pass_the_kept_budget_together() {
        let (state, path) = temp_state("kept_race").await;
        done(posts_race(state).await, path).await;
        if let Some((state, temp)) = pg_state("kept_race").await {
            pg_done(posts_race(state).await, temp).await;
        }
    }

    #[tokio::test]
    async fn a_setting_change_and_posts_never_pass_the_kept_budget_together() {
        let (state, path) = temp_state("kept_change_race").await;
        done(change_race(state).await, path).await;
        if let Some((state, temp)) = pg_state("kept_change_race").await {
            pg_done(change_race(state).await, temp).await;
        }
    }

    async fn club_channel(db: &Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id")
    }
}
