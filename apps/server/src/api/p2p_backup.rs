use std::collections::{BTreeMap, BTreeSet};

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sqlx::{AnyConnection, Row};
use utoipa::{IntoParams, ToSchema};

use crate::api::access::not_found;
use crate::api::media::{Held, declared_length, read_raw, reading_slot, reserve, send_held};
use crate::api::rare::{self, Rare};
use crate::api::reauth::{AuthedSession, Purpose, ReAuth, ReAuthBody, Session, check_at};
use crate::api::{ApiError, ApiErrorBody, Authed, OkResp, Settings, bad, ok};
use crate::db::{Db, PURGE_BATCH, PURGING_HASH, User, now};
use crate::state::AppState;

/// The newest versions of an identity's backup that are always kept.
pub const BACKUP_LAST: usize = 3;
/// UTC days back from today whose first version is kept.
pub const BACKUP_DAYS: i64 = 30;
/// Most P2P identities one account keeps backups of.
pub const BACKUP_IDENTITIES: usize = 8;

const DAY_SECS: i64 = 86400;
const VERSION_HEADER: &str = "x-backup-version";
const BAD_IK: &str = "ik must be a base64url Ed25519 public key";

/// The latest version of one P2P identity's backup.
#[derive(Debug, PartialEq, Serialize, ToSchema)]
pub struct BackupEntry {
    /// The P2P identity key the backup belongs to: an Ed25519 public key, base64url without
    /// padding (43 characters).
    #[schema(example = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")]
    pub ik: String,
    /// Its number: 1 for the first upload of this `ik`, then one more for each upload.
    pub version: i64,
    /// Its size in bytes.
    pub size: i64,
    /// When it was uploaded.
    pub updated_at: i64,
}

/// One kept version of a P2P backup.
#[derive(Debug, PartialEq, Serialize, ToSchema)]
pub struct BackupVersion {
    /// Its number.
    pub version: i64,
    /// Its size in bytes.
    pub size: i64,
    /// When it was uploaded.
    pub updated_at: i64,
}

/// The number of an uploaded version.
#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PutParams {
    /// The latest version's number plus 1, or 1 for the first upload of this `ik`.
    #[param(example = 1)]
    version: i64,
}

/// Deleting P2P backup versions.
#[derive(Deserialize, ToSchema)]
pub struct BackupDelete {
    /// How you confirm it: the password or words, or a `phrase` proof with purpose `p2p-data`
    /// and the `ik` as context. `fresh_session` is refused.
    pub reauth: ReAuthBody,
}

/// A stored version: its number, size in bytes and upload time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Stored {
    pub version: i64,
    pub size: i64,
    pub at: i64,
}

/// The versions of one identity, in upload order, kept at `t`: the last 3, the first version of
/// each UTC day from the day of `t` back 30 days, and the newest version older than those.
pub(crate) fn kept(versions: &[Stored], t: i64) -> Vec<Stored> {
    let day = |v: &Stored| v.at.div_euclid(DAY_SECS);
    let from = t.div_euclid(DAY_SECS) - BACKUP_DAYS;
    let mut keep: BTreeSet<i64> = versions
        .iter()
        .rev()
        .take(BACKUP_LAST)
        .map(|v| v.version)
        .collect();
    let mut days = BTreeSet::new();
    for v in versions {
        if days.insert(day(v)) && day(v) >= from {
            keep.insert(v.version);
        }
    }
    if let Some(v) = versions.iter().rev().find(|v| day(v) < from) {
        keep.insert(v.version);
    }
    versions
        .iter()
        .filter(|v| keep.contains(&v.version))
        .copied()
        .collect()
}

/// The versions an account keeps at `t` once `new` is stored for `ik`, by identity, or `None`
/// when they would take more than `total` bytes (0: no total). `account` holds each identity's
/// versions in upload order.
pub(crate) fn admit(
    account: &BTreeMap<String, Vec<Stored>>,
    ik: &str,
    new: Stored,
    t: i64,
    total: u64,
) -> Option<BTreeMap<String, Vec<Stored>>> {
    let mut next = account.clone();
    next.entry(ik.to_string()).or_default().push(new);
    for versions in next.values_mut() {
        *versions = kept(versions, t);
    }
    let used: u64 = next.values().flatten().map(|v| v.size as u64).sum();
    (total == 0 || used <= total).then_some(next)
}

fn capable(state: &AppState) -> Result<u64, ApiError> {
    match state.limits.p2p_backup_bytes() {
        0 => Err(not_found()),
        max => Ok(max),
    }
}

fn check_ik(ik: &str) -> Result<(), ApiError> {
    crate::identity::p2p_key(ik)
        .map(|_| ())
        .ok_or_else(|| bad(BAD_IK))
}

fn stale(latest: i64) -> ApiError {
    ApiError::conflict(
        StatusCode::CONFLICT,
        format!("Backup version must be {}", latest + 1),
    )
}

/// Why an upload was refused: its number is not the latest one plus 1, with the latest one, or
/// another error.
#[derive(Debug)]
pub(crate) enum PutError {
    Stale(i64),
    Other(ApiError),
}

impl From<ApiError> for PutError {
    fn from(e: ApiError) -> Self {
        PutError::Other(e)
    }
}

impl From<sqlx::Error> for PutError {
    fn from(e: sqlx::Error) -> Self {
        PutError::Other(e.into())
    }
}

impl IntoResponse for PutError {
    fn into_response(self) -> Response {
        match self {
            PutError::Stale(latest) => (
                [(
                    HeaderName::from_static(VERSION_HEADER),
                    HeaderValue::from(latest),
                )],
                stale(latest),
            )
                .into_response(),
            PutError::Other(e) => e.into_response(),
        }
    }
}

fn too_large() -> ApiError {
    ApiError::limit(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Backup too large",
        "p2p_backup_max_mib",
    )
}

fn full() -> ApiError {
    ApiError::limit(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Backup storage full",
        "p2p_backup_total_mib",
    )
}

fn too_many() -> ApiError {
    ApiError::limit(
        StatusCode::CONFLICT,
        "Too many P2P backups",
        "p2p_backup_identities",
    )
}

fn sending(ApiError(code, msg, reason): ApiError) -> ApiError {
    match code {
        StatusCode::TOO_MANY_REQUESTS => ApiError(
            code,
            "Too many backup transfers at once, try again in a moment".to_string(),
            reason,
        ),
        StatusCode::SERVICE_UNAVAILABLE => ApiError(
            code,
            "Too many transfers right now, try again in a moment".to_string(),
            reason,
        ),
        _ => ApiError(code, msg, reason),
    }
}

/// Room for sending a stored version of `size` bytes, taken as for an upload body: one of the
/// account's places among its uploads at once and room in the upload buffer.
async fn room_to_send(
    state: &AppState,
    username: &str,
    size: i64,
    max: u64,
) -> Result<Held, ApiError> {
    let size = u64::try_from(size).unwrap_or(0);
    let body = usize::try_from(max.max(size)).unwrap_or(usize::MAX);
    let slot = reading_slot(&state.db, username).map_err(sending)?;
    reserve(slot, Some(size), body, true).await.map_err(sending)
}

/// `data` as version `version`, holding `held` while it is sent.
fn blob(version: i64, data: Vec<u8>, held: Held) -> Response {
    let size = data.len();
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (header::CONTENT_LENGTH, HeaderValue::from(size)),
            (
                HeaderName::from_static(VERSION_HEADER),
                HeaderValue::from(version),
            ),
        ],
        send_held(data, held),
    )
        .into_response()
}

/// Sends version `version` of `ik`, of `size` bytes, in room taken for it.
async fn send(
    state: &AppState,
    username: &str,
    ik: &str,
    Stored {
        version,
        size,
        at: _,
    }: Stored,
    max: u64,
) -> Result<Response, ApiError> {
    let held = room_to_send(state, username, size, max).await?;
    let row = sqlx::query(
        "SELECT data FROM p2p_backups WHERE username = $1 AND ik = $2 AND version = $3",
    )
    .bind(username)
    .bind(ik)
    .bind(version)
    .fetch_optional(&state.read())
    .await?
    .ok_or_else(not_found)?;
    Ok(blob(version, row.try_get(0)?, held))
}

/// On Postgres, holds the account's backups until the transaction ends, so uploads and deletes
/// of one account run one after another (SQLite has one writer).
pub(crate) async fn lock(conn: &mut AnyConnection, username: &str) -> sqlx::Result<()> {
    if conn.backend_name() == "PostgreSQL" {
        sqlx::query("SELECT COUNT(*) FROM pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("p2p backup:{username}"))
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Whether the account of `user` still exists and is not being deleted. On Postgres this holds
/// its row until the transaction ends, so deleting the account waits for it.
pub(crate) async fn live(conn: &mut AnyConnection, user: &User) -> sqlx::Result<bool> {
    let changed = sqlx::query("UPDATE users SET username = username WHERE username = $1 AND created_at = $2 AND password_hash <> $3")
        .bind(&user.username)
        .bind(user.created_at)
        .bind(PURGING_HASH)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    Ok(changed > 0)
}

/// How many identities other than `ik` the account holds backups of.
async fn others(db: &Db, username: &str, ik: &str) -> sqlx::Result<usize> {
    let n: i64 =
        sqlx::query("SELECT COUNT(DISTINCT ik) FROM p2p_backups WHERE username = $1 AND ik <> $2")
            .bind(username)
            .bind(ik)
            .fetch_one(db)
            .await?
            .try_get(0)?;
    Ok(usize::try_from(n).unwrap_or(usize::MAX))
}

async fn latest(conn: &mut AnyConnection, username: &str, ik: &str) -> sqlx::Result<i64> {
    Ok(
        sqlx::query("SELECT latest FROM p2p_backup_seq WHERE username = $1 AND ik = $2")
            .bind(username)
            .bind(ik)
            .fetch_optional(&mut *conn)
            .await?
            .map(|r| r.try_get(0))
            .transpose()?
            .unwrap_or(0),
    )
}

fn stored_of(row: &sqlx::any::AnyRow, at: usize) -> sqlx::Result<Stored> {
    Ok(Stored {
        version: row.try_get(at)?,
        size: row.try_get(at + 1)?,
        at: row.try_get(at + 2)?,
    })
}

async fn versions(conn: &mut AnyConnection, username: &str, ik: &str) -> sqlx::Result<Vec<Stored>> {
    sqlx::query("SELECT version, size, updated_at FROM p2p_backups WHERE username = $1 AND ik = $2 ORDER BY version")
        .bind(username)
        .bind(ik)
        .fetch_all(&mut *conn)
        .await?
        .iter()
        .map(|r| stored_of(r, 0))
        .collect()
}

async fn account(
    conn: &mut AnyConnection,
    username: &str,
) -> sqlx::Result<BTreeMap<String, Vec<Stored>>> {
    let rows = sqlx::query("SELECT ik, version, size, updated_at FROM p2p_backups WHERE username = $1 ORDER BY ik, version")
        .bind(username)
        .fetch_all(&mut *conn)
        .await?;
    let mut out: BTreeMap<String, Vec<Stored>> = BTreeMap::new();
    for row in &rows {
        out.entry(row.try_get(0)?)
            .or_default()
            .push(stored_of(row, 1)?);
    }
    Ok(out)
}

/// The numbers of the versions in `all` that are not in `keep`.
fn gone<'a>(all: &'a [Stored], keep: &'a [Stored]) -> impl Iterator<Item = i64> + 'a {
    all.iter().filter(|v| !keep.contains(v)).map(|v| v.version)
}

async fn drop_versions(
    conn: &mut AnyConnection,
    username: &str,
    ik: &str,
    gone: impl Iterator<Item = i64>,
) -> sqlx::Result<u64> {
    let mut n = 0;
    for version in gone {
        n +=
            sqlx::query("DELETE FROM p2p_backups WHERE username = $1 AND ik = $2 AND version = $3")
                .bind(username)
                .bind(ik)
                .bind(version)
                .execute(&mut *conn)
                .await?
                .rows_affected();
    }
    Ok(n)
}

/// Deletes the versions of `ik` that have aged out at `t`, under the account's lock. Returns the
/// kept ones and how many went.
async fn drop_aged(db: &Db, username: &str, ik: &str, t: i64) -> sqlx::Result<(Vec<Stored>, u64)> {
    let mut tx = db.begin().await?;
    lock(&mut tx, username).await?;
    let all = versions(&mut tx, username, ik).await?;
    let keep = kept(&all, t);
    let n = drop_versions(&mut tx, username, ik, gone(&all, &keep)).await?;
    tx.commit().await?;
    Ok((keep, n))
}

/// The versions of `ik` kept at `t`. Reads them without the writer, which it takes only to
/// delete those that aged out.
async fn prune(state: &AppState, username: &str, ik: &str, t: i64) -> sqlx::Result<Vec<Stored>> {
    let all = versions(&mut *state.read().acquire().await?, username, ik).await?;
    let keep = kept(&all, t);
    match keep.len() == all.len() {
        true => Ok(keep),
        false => Ok(drop_aged(&state.db, username, ik, t).await?.0),
    }
}

/// Deletes the versions that have aged out at `t`. Returns how many.
pub(crate) async fn sweep(db: &Db, t: i64) -> sqlx::Result<u64> {
    let cutoff = (t.div_euclid(DAY_SECS) - BACKUP_DAYS) * DAY_SECS;
    let mut total = 0;
    loop {
        let rows = sqlx::query("SELECT o.username, o.ik FROM p2p_backups o WHERE o.updated_at < $1 GROUP BY o.username, o.ik HAVING COUNT(*) > 1 AND (SELECT COUNT(*) FROM p2p_backups a WHERE a.username = o.username AND a.ik = o.ik) > $2 LIMIT $3")
            .bind(cutoff)
            .bind(BACKUP_LAST as i64)
            .bind(PURGE_BATCH)
            .fetch_all(db)
            .await?;
        let mut pass = 0;
        for row in &rows {
            let (username, ik): (String, String) = (row.try_get(0)?, row.try_get(1)?);
            pass += drop_aged(db, &username, &ik, t).await?.1;
        }
        total += pass;
        if (rows.len() as i64) < PURGE_BATCH || pass == 0 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

/// List your P2P backups
///
/// The latest version of each P2P identity's backup stored for your account, newest first: at
/// most 8 identities. The instance keeps sealed blobs it can't open, per account and identity
/// key. Works while the `p2p_backup` or `p2p` switch of `GET /api/v1/settings` is off. Answers
/// 404 when the instance keeps no P2P backups (`features.p2p_backup` of `GET /api/v1/instance` is
/// false). Requires a bearer token; guests can't call it. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/me/p2p_backup", tag = "Account", responses((status = 200, description = "The latest version of each identity's backup, newest first", body = Vec<BackupEntry>), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: the instance keeps no P2P backups", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn list_backups(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Vec<BackupEntry>>, ApiError> {
    capable(&state)?;
    let rows = sqlx::query("SELECT b.ik, b.version, b.size, b.updated_at FROM p2p_backups b JOIN (SELECT ik, MAX(version) AS latest FROM p2p_backups WHERE username = $1 GROUP BY ik) m ON m.ik = b.ik AND m.latest = b.version WHERE b.username = $1 ORDER BY b.updated_at DESC, b.ik")
        .bind(&user.username)
        .fetch_all(&state.read())
        .await?;
    let entries = rows
        .iter()
        .map(|r| {
            let Stored { version, size, at } = stored_of(r, 1)?;
            Ok(BackupEntry {
                ik: r.try_get(0)?,
                version,
                size,
                updated_at: at,
            })
        })
        .collect::<sqlx::Result<Vec<_>>>()?;
    Ok(Json(entries))
}

/// Get a P2P backup
///
/// The latest version of the backup of the P2P identity `ik`, as stored: the sealed blob, with
/// its number in the `X-Backup-Version` header (the number it was sealed for). A download holds
/// room in the instance's upload buffer and one of your account's 3 places for uploads at once
/// until it is sent. One that takes nothing for 30 seconds or runs over 10 minutes is cut off
/// short of its `Content-Length`. Works while the `p2p_backup` or `p2p` switch of
/// `GET /api/v1/settings` is off. Requires a bearer token; guests can't call it. General
/// rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/me/p2p_backup/{ik}", tag = "Account", params(("ik" = String, Path, description = "The P2P identity key: an Ed25519 public key, base64url without padding (43 characters)")), responses((status = 200, description = "The latest version's bytes", content_type = "application/octet-stream", body = Vec<u8>, headers(("x-backup-version" = i64, description = "The number of the version returned"))), (status = 400, description = "`ik must be a base64url Ed25519 public key`", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: your account holds no backup for this `ik`, or the instance keeps no P2P backups", body = ApiErrorBody), (status = 429, description = "Your backup downloads and uploads already hold 3 places or your share of the upload buffer (JSON `Too many backup transfers at once, try again in a moment`), or too many requests in the general bucket (plain text)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "`Too many transfers right now, try again in a moment`: the upload buffer is full, or the token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn get_backup(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(ik): Path<String>,
) -> Result<Response, ApiError> {
    let max = capable(&state)?;
    check_ik(&ik)?;
    let row = sqlx::query("SELECT version, size, updated_at FROM p2p_backups WHERE username = $1 AND ik = $2 ORDER BY version DESC LIMIT 1")
        .bind(&user.username)
        .bind(&ik)
        .fetch_optional(&state.read())
        .await?
        .ok_or_else(not_found)?;
    send(&state, &user.username, &ik, stored_of(&row, 0)?, max).await
}

/// List the versions of a P2P backup
///
/// The kept versions of the backup of the P2P identity `ik`, newest first, after removing those
/// that aged out. Versions leave only with time: kept are the last 3, the first version
/// uploaded on each UTC day from today back 30 days, and the newest version older than those,
/// at most 35. Works while the `p2p_backup` or `p2p` switch of `GET /api/v1/settings` is off.
/// Requires a bearer token; guests can't call it. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/me/p2p_backup/{ik}/versions", tag = "Account", params(("ik" = String, Path, description = "The P2P identity key: an Ed25519 public key, base64url without padding (43 characters)")), responses((status = 200, description = "The kept versions, newest first", body = Vec<BackupVersion>), (status = 400, description = "`ik must be a base64url Ed25519 public key`", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: your account holds no backup for this `ik`, or the instance keeps no P2P backups", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn list_versions(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(ik): Path<String>,
) -> Result<Json<Vec<BackupVersion>>, ApiError> {
    list_versions_at(&state, &user.username, &ik, now()).await
}

pub(crate) async fn list_versions_at(
    state: &AppState,
    username: &str,
    ik: &str,
    t: i64,
) -> Result<Json<Vec<BackupVersion>>, ApiError> {
    capable(state)?;
    check_ik(ik)?;
    let kept = prune(state, username, ik, t).await?;
    if kept.is_empty() {
        return Err(not_found());
    }
    Ok(Json(
        kept.iter()
            .rev()
            .map(|&Stored { version, size, at }| BackupVersion {
                version,
                size,
                updated_at: at,
            })
            .collect(),
    ))
}

/// Get a version of a P2P backup
///
/// One kept version of the backup of the P2P identity `ik`: the sealed blob as stored, with its
/// number in the `X-Backup-Version` header. A download holds room in the instance's upload
/// buffer and one of your account's 3 places for uploads at once until it is sent. One that
/// takes nothing for 30 seconds or runs over 10 minutes is cut off short of its
/// `Content-Length`. Works while the `p2p_backup` or `p2p` switch of `GET /api/v1/settings` is
/// off. Requires a bearer token; guests can't call it. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/me/p2p_backup/{ik}/versions/{version}", tag = "Account", params(("ik" = String, Path, description = "The P2P identity key: an Ed25519 public key, base64url without padding (43 characters)"), ("version" = i64, Path, description = "The version's number")), responses((status = 200, description = "The version's bytes", content_type = "application/octet-stream", body = Vec<u8>, headers(("x-backup-version" = i64, description = "The number of the version returned"))), (status = 400, description = "`ik must be a base64url Ed25519 public key`. A version that is not a number gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: the version aged out, was deleted or was never stored, or the instance keeps no P2P backups", body = ApiErrorBody), (status = 429, description = "Your backup downloads and uploads already hold 3 places or your share of the upload buffer (JSON `Too many backup transfers at once, try again in a moment`), or too many requests in the general bucket (plain text)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "`Too many transfers right now, try again in a moment`: the upload buffer is full, or the token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn get_version(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((ik, version)): Path<(String, i64)>,
) -> Result<Response, ApiError> {
    get_version_at(&state, &user.username, &ik, version, now()).await
}

pub(crate) async fn get_version_at(
    state: &AppState,
    username: &str,
    ik: &str,
    version: i64,
    t: i64,
) -> Result<Response, ApiError> {
    let max = capable(state)?;
    check_ik(ik)?;
    let kept = prune(state, username, ik, t).await?;
    let found = kept.into_iter().find(|v| v.version == version);
    send(state, username, ik, found.ok_or_else(not_found)?, max).await
}

/// Upload a P2P backup version
///
/// Stores the body, a sealed blob (`application/octet-stream`) of at most `limits.p2p_backup_bytes`
/// bytes, as version `version` of the backup of the P2P identity `ik`. The first upload of an `ik`
/// is version 1 and each later one the latest number plus 1; a number is never reused, also after
/// its version or the whole backup was deleted. Another number answers 409 with the latest number
/// in `X-Backup-Version` (0 when the account never backed up this `ik`). An account keeps backups of at most 8 P2P identities: a first
/// upload for another answers 409. No re-auth. Versions leave only with time: besides those that
/// aged out, an upload drops only a version of the current UTC day that is neither that day's first
/// nor among the last 3. Refused with 413 when the version is over `limits.p2p_backup_bytes`
/// (`Backup too large`) or when the versions your account keeps over all its identities would pass
/// `limits.p2p_backup_total_bytes` (`Backup storage full`); a refusal removes nothing. Up to 3
/// uploads and backup downloads per account are read at once, counted with media uploads in the
/// instance's upload buffer; a body that sends nothing for 30 seconds or takes over 10 minutes is
/// dropped with 408. Answers 404 while the `p2p_backup` or `p2p` switch of `GET /api/v1/settings`
/// is off, when your account is being deleted, and when the instance keeps no P2P backups. Requires
/// a bearer token; guests can't call it. Strict and general rate-limit buckets.
/// Uploads are rare requests: at most `RARE_REQUESTS_PER_HOUR` (20) an hour and
/// `RARE_REQUESTS_PER_DAY` (100) a day per account by default, over all its identities. An upload
/// refused by another limit or while the server is busy (429, 503) does not count.
#[utoipa::path(put, path = "/api/v1/me/p2p_backup/{ik}", tag = "Account", params(("ik" = String, Path, description = "The P2P identity key: an Ed25519 public key, base64url without padding (43 characters)"), PutParams), request_body(content = Vec<u8>, content_type = "application/octet-stream", description = "The sealed blob"), responses((status = 200, description = "Stored as the latest version", body = BackupEntry), (status = 400, description = "`ik must be a base64url Ed25519 public key`, or the body could not be read. A missing or non-numeric `version` gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: the `p2p_backup` or `p2p` switch is off, your account is being deleted, or the instance keeps no P2P backups", body = ApiErrorBody), (status = 408, description = "`The upload stopped sending data`: the body sent nothing for 30 seconds or took over 10 minutes", body = ApiErrorBody), (status = 409, description = "`Backup version must be {n}`: `version` is not the latest number plus 1, with the number it must be and the latest number in `X-Backup-Version`, or `Too many P2P backups`: your account keeps backups of 8 other identities", body = ApiErrorBody, headers(("x-backup-version" = i64, description = "With `Backup version must be {n}`: the latest number, n - 1"))), (status = 413, description = "`Backup too large`: over `limits.p2p_backup_bytes`, or `Backup storage full`: the versions your account keeps would pass `limits.p2p_backup_total_bytes`. Nothing is removed", body = ApiErrorBody), (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. 3 of your uploads and backup downloads, or uploads holding your share of the upload buffer, are already being read (JSON `Too many uploads at once: ...`), or too many requests in the strict or general bucket (plain text)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "`Too many uploads right now, try again in a moment`: the upload buffer is full, or the token could not be checked (the database is unavailable)", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_backup(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(ik): Path<String>,
    Query(PutParams { version }): Query<PutParams>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<BackupEntry>, PutError> {
    let held = rare::hold(&state, Rare::P2pBackup, Some(&user))?;
    let declared = declared_length(&headers);
    let answer = put_at(&state, &user, &ik, version, declared, body, now()).await;
    held.answered(match &answer {
        Err(PutError::Other(e)) => Some(e),
        Ok(_) | Err(PutError::Stale(_)) => None,
    });
    answer
}

pub(crate) async fn put_at(
    state: &AppState,
    user: &User,
    ik: &str,
    version: i64,
    declared: Option<u64>,
    body: Body,
    t: i64,
) -> Result<Json<BackupEntry>, PutError> {
    let max = capable(state)?;
    let username = user.username.as_str();
    let settings = Settings::cached(&state.db).await;
    if !(settings.p2p_backup && settings.p2p) {
        return Err(not_found().into());
    }
    check_ik(ik)?;
    let read = state.read();
    let early = latest(&mut *read.acquire().await?, username, ik).await?;
    if version != early + 1 {
        return Err(PutError::Stale(early));
    }
    if others(&read, username, ik).await? >= BACKUP_IDENTITIES {
        return Err(too_many().into());
    }
    if declared.is_some_and(|n| n > max) {
        return Err(too_large().into());
    }
    let max = usize::try_from(max).unwrap_or(usize::MAX);
    let held = reserve(reading_slot(&state.db, username)?, declared, max, true).await?;
    let data = read_raw(body, max, held, too_large).await?;
    let new = Stored {
        version,
        size: data.data.len() as i64,
        at: t,
    };
    let mut tx = state.db.begin().await?;
    lock(&mut tx, username).await?;
    if !live(&mut tx, user).await? {
        return Err(not_found().into());
    }
    let latest = latest(&mut tx, username, ik).await?;
    if version != latest + 1 {
        return Err(PutError::Stale(latest));
    }
    let stored = account(&mut tx, username).await?;
    if stored.keys().filter(|each| *each != ik).count() >= BACKUP_IDENTITIES {
        return Err(too_many().into());
    }
    let total = state.limits.p2p_backup_total_bytes();
    let next = admit(&stored, ik, new, t, total).ok_or_else(full)?;
    sqlx::query("INSERT INTO p2p_backup_seq(username, ik, latest) VALUES($1, $2, $3) ON CONFLICT(username, ik) DO UPDATE SET latest = excluded.latest")
        .bind(username)
        .bind(ik)
        .bind(version)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO p2p_backups(username, ik, version, size, updated_at, data) VALUES($1, $2, $3, $4, $5, $6)")
        .bind(username)
        .bind(ik)
        .bind(version)
        .bind(new.size)
        .bind(t)
        .bind(&data.data)
        .execute(&mut *tx)
        .await?;
    for (each, versions) in &stored {
        let keep = next.get(each).map(Vec::as_slice).unwrap_or_default();
        drop_versions(&mut tx, username, each, gone(versions, keep)).await?;
    }
    tx.commit().await?;
    Ok(Json(BackupEntry {
        ik: ik.to_string(),
        version,
        size: new.size,
        updated_at: t,
    }))
}

async fn holds(db: &Db, username: &str, ik: &str, version: Option<i64>) -> sqlx::Result<bool> {
    Ok(sqlx::query("SELECT version FROM p2p_backups WHERE username = $1 AND ik = $2 AND ($3 IS NULL OR version = $3) LIMIT 1")
        .bind(username)
        .bind(ik)
        .bind(version)
        .fetch_optional(db)
        .await?
        .is_some())
}

/// Delete a version of a P2P backup
///
/// Deletes one version of the backup of the P2P identity `ik`. Its number is never used again;
/// deleting the last one deletes the backup. Confirm with the
/// password or words, or a `phrase` proof by the account's backup phrase (purpose `p2p-data`,
/// context the `ik`) over a challenge from `POST /api/v1/auth/recovery/challenge`;
/// `fresh_session` is refused. Password and phrase tries share the pace of password changes: one
/// every 3 seconds per session, and 50 wrong ones a UTC day. Works while the `p2p_backup` or
/// `p2p` switch of `GET /api/v1/settings` is off. Requires a bearer token; guests can't call it.
/// Strict and general rate-limit buckets.
#[utoipa::path(delete, path = "/api/v1/me/p2p_backup/{ik}/versions/{version}", tag = "Account", params(("ik" = String, Path, description = "The P2P identity key: an Ed25519 public key, base64url without padding (43 characters)"), ("version" = i64, Path, description = "The version's number")), request_body = BackupDelete, responses((status = 200, description = "The version is deleted", body = OkResp), (status = 400, description = "`ik must be a base64url Ed25519 public key`, or not exactly one way to confirm in `reauth`. A version that is not a number, malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token (`Unauthorized`), `Wrong password`, `Wrong backup phrase` (no phrase set, a used, expired or foreign nonce, or a signature over another purpose or `ik`), or `Confirm with your password` (`fresh_session`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such version of a backup of your account, or the instance keeps no P2P backups", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 423, description = "Changes from this session locked for the day (UTC) after 50 wrong passwords or phrases", body = ApiErrorBody), (status = 429, description = "Less than 3 seconds since this session's last try (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket (plain text)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn delete_version(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Path((ik, version)): Path<(String, i64)>,
    Json(req): Json<BackupDelete>,
) -> Result<Json<OkResp>, ApiError> {
    delete_at(&state, session, &ik, Some(version), req, now()).await
}

/// Delete a P2P backup
///
/// Deletes every version of the backup of the P2P identity `ik`; the next upload takes the next
/// number (the 409 of `PUT` gives it).
/// Confirm with the password or words, or a `phrase` proof by the account's backup phrase
/// (purpose `p2p-data`, context the `ik`) over a challenge from
/// `POST /api/v1/auth/recovery/challenge`; `fresh_session` is refused. Password and phrase tries
/// share the pace of password changes: one every 3 seconds per session, and 50 wrong ones a UTC
/// day. Works while the `p2p_backup` or `p2p` switch of `GET /api/v1/settings` is off. Requires a
/// bearer token; guests can't call it. Strict and general rate-limit buckets.
#[utoipa::path(delete, path = "/api/v1/me/p2p_backup/{ik}", tag = "Account", params(("ik" = String, Path, description = "The P2P identity key: an Ed25519 public key, base64url without padding (43 characters)")), request_body = BackupDelete, responses((status = 200, description = "Every version is deleted", body = OkResp), (status = 400, description = "`ik must be a base64url Ed25519 public key`, or not exactly one way to confirm in `reauth`. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token (`Unauthorized`), `Wrong password`, `Wrong backup phrase` (no phrase set, a used, expired or foreign nonce, or a signature over another purpose or `ik`), or `Confirm with your password` (`fresh_session`)", body = ApiErrorBody), (status = 404, description = "`Not found`: your account holds no backup for this `ik`, or the instance keeps no P2P backups", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 423, description = "Changes from this session locked for the day (UTC) after 50 wrong passwords or phrases", body = ApiErrorBody), (status = 429, description = "Less than 3 seconds since this session's last try (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket (plain text)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn delete_backup(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Path(ik): Path<String>,
    Json(req): Json<BackupDelete>,
) -> Result<Json<OkResp>, ApiError> {
    delete_at(&state, session, &ik, None, req, now()).await
}

/// Deletes `version` of the backup of `ik`, or every version, after re-auth.
pub(crate) async fn delete_at(
    state: &AppState,
    session: Session,
    ik: &str,
    version: Option<i64>,
    req: BackupDelete,
    t: i64,
) -> Result<Json<OkResp>, ApiError> {
    capable(state)?;
    check_ik(ik)?;
    let username = session.user.username.clone();
    if !holds(&state.read(), &username, ik, version).await? {
        return Err(not_found());
    }
    let BackupDelete { reauth } = req;
    let purpose = Purpose::P2pData { ik: ik.to_string() };
    check_at(state, &session, ReAuth::try_from(reauth)?, purpose, t).await?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, &username).await?;
    let gone = sqlx::query(
        "DELETE FROM p2p_backups WHERE username = $1 AND ik = $2 AND ($3 IS NULL OR version = $3)",
    )
    .bind(&username)
    .bind(ik)
    .bind(version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if gone == 0 {
        return Err(not_found());
    }
    tx.commit().await?;
    Ok(ok())
}

#[cfg(test)]
mod tests;
