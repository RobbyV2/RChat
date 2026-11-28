use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{AnyConnection, Row};
use utoipa::ToSchema;

use crate::api::access::not_found;
use crate::api::features::Feature;
use crate::api::p2p_backup::{live, lock};
use crate::api::policy::{effective, refused};
use crate::api::rare::{self, Rare};
use crate::api::reauth::{AuthedSession, Purpose, ReAuth, ReAuthBody, Session, check_at};
use crate::api::{ApiError, ApiErrorBody, Authed, OkResp, ok};
use crate::db::User;
use crate::p2p_chain::{self, ChainError};
use crate::state::AppState;

/// Most bytes of the body of a `PUT`.
pub const RECORD_BYTES: usize = 16 * 1024;
/// Most P2P identities one account keeps records of.
pub const RECORD_IDENTITIES: usize = 8;

const BAD_IK: &str = "ik must be a base64url Ed25519 public key";
const BAD_RECORD: &str = "That isn't a valid P2P identity record";

/// The public record of a P2P identity made with a backup phrase: its creation record and its
/// chain.
#[derive(Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct IdentityRecord {
    /// The P2P identity key: an Ed25519 public key, base64url without padding (43 characters).
    #[schema(example = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")]
    pub ik: String,
    /// The creation record `{v, ik, n, rk, pk, at, sig_ik, sig_rk}`, as it was sent.
    #[schema(value_type = Object)]
    pub cr: Value,
    /// The chain records `{v, ik, n, prev, pk, keep, at, sig}` (a reset also `rk` and
    /// `sig_next`, a removal `rk: ""`), each once, in order of `n`.
    #[schema(value_type = Vec<Object>)]
    pub chain: Vec<Value>,
    /// When it was last stored.
    pub updated_at: i64,
}

/// Storing a P2P identity record.
#[derive(Deserialize, ToSchema)]
pub struct IdentityPut {
    /// The creation record of the identity `ik`.
    #[schema(value_type = Object)]
    pub cr: Value,
    /// Every chain record of the identity, in any order.
    #[schema(value_type = Vec<Object>)]
    pub chain: Vec<Value>,
    /// Needed only to replace the stored record with one that lacks some of it: the password or
    /// words, or a `phrase` proof with purpose `p2p-data` and the `ik` as context.
    /// `fresh_session` is refused. Checked whenever it is given.
    #[serde(default)]
    pub reauth: Option<ReAuthBody>,
}

/// Deleting a P2P identity record.
#[derive(Deserialize, ToSchema)]
pub struct IdentityDelete {
    /// How you confirm it: the password or words, or a `phrase` proof with purpose `p2p-data`
    /// and the `ik` as context. `fresh_session` is refused.
    pub reauth: ReAuthBody,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    cr: Value,
    chain: Vec<Value>,
}

/// The routes are on while the instance keeps P2P backups or the badge route is: the `p2p`
/// switch.
async fn on(state: &AppState, user: &User) -> Result<(), ApiError> {
    if state.limits.p2p_backup_bytes() > 0 || effective(&state.db, Some(user)).await.p2p() {
        return Ok(());
    }
    Err(refused(Feature::P2p.key(), not_found()))
}

fn check_ik(ik: &str) -> Result<(), ApiError> {
    crate::identity::p2p_key(ik)
        .map(|_| ())
        .ok_or_else(|| ApiError::invalid(BAD_IK, "ik"))
}

fn invalid(field: &str) -> ApiError {
    ApiError::invalid(BAD_RECORD, field)
}

fn too_large() -> ApiError {
    ApiError::limit(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Identity record too large",
        "p2p_identity_record_bytes",
    )
}

fn too_many() -> ApiError {
    ApiError::limit(
        StatusCode::CONFLICT,
        "Too many P2P identity records",
        "p2p_identity_records",
    )
}

fn not_an_append() -> ApiError {
    ApiError::conflict(
        StatusCode::CONFLICT,
        "The stored record holds records this one lacks",
    )
}

fn record_of(ik: String, text: &str, updated_at: i64) -> Result<IdentityRecord, ApiError> {
    let Stored { cr, chain } = serde_json::from_str(text).map_err(ApiError::internal)?;
    Ok(IdentityRecord {
        ik,
        cr,
        chain,
        updated_at,
    })
}

async fn stored(
    conn: &mut AnyConnection,
    username: &str,
    ik: &str,
) -> sqlx::Result<Option<String>> {
    sqlx::query("SELECT record FROM p2p_identities WHERE username = $1 AND ik = $2")
        .bind(username)
        .bind(ik)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.try_get(0))
        .transpose()
}

/// List your P2P identity records
///
/// The public records of the P2P identities stored for your account, newest first: at most 8.
/// A record is the identity's creation record and chain, the signed history of its backup
/// phrase and primary keys, which a restore from the phrase starts from. The app stores one
/// only while the identity's backup or account badge is on. Answers 404 when the instance keeps
/// no P2P backups (`features.p2p_backup` of `GET /api/v1/instance` is false) and the `p2p`
/// switch of `GET /api/v1/settings` is off. Requires a bearer token; guests can't call it.
/// General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/me/p2p_identity", tag = "Account", responses((status = 200, description = "The stored records, newest first", body = Vec<IdentityRecord>), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found` with reason `off_site` and control `p2p`: the instance keeps no P2P backups and the `p2p` switch is off", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn list_identities(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Vec<IdentityRecord>>, ApiError> {
    on(&state, &user).await?;
    let rows = sqlx::query("SELECT ik, record, updated_at FROM p2p_identities WHERE username = $1 ORDER BY updated_at DESC, ik")
        .bind(&user.username)
        .fetch_all(&state.read())
        .await?;
    let records = rows
        .iter()
        .map(|r| {
            let text: String = r.try_get(1)?;
            record_of(r.try_get(0)?, &text, r.try_get(2)?)
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(records))
}

/// Get a P2P identity record
///
/// The record of the P2P identity `ik` stored for your account. Requires a bearer token; guests
/// can't call it. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/me/p2p_identity/{ik}", tag = "Account", params(("ik" = String, Path, description = "The P2P identity key: an Ed25519 public key, base64url without padding (43 characters)")), responses((status = 200, description = "The stored record", body = IdentityRecord), (status = 400, description = "`ik must be a base64url Ed25519 public key`", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: your account holds no record for this `ik`, or the instance keeps no P2P backups and the `p2p` switch is off", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn get_identity(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(ik): Path<String>,
) -> Result<Json<IdentityRecord>, ApiError> {
    on(&state, &user).await?;
    check_ik(&ik)?;
    let row = sqlx::query(
        "SELECT record, updated_at FROM p2p_identities WHERE username = $1 AND ik = $2",
    )
    .bind(&user.username)
    .bind(&ik)
    .fetch_optional(&state.read())
    .await?
    .ok_or_else(not_found)?;
    let text: String = row.try_get(0)?;
    Ok(Json(record_of(ik, &text, row.try_get(1)?)?))
}

/// Store a P2P identity record
///
/// Stores the creation record and chain of the P2P identity `ik` for your account. The body is
/// JSON of at most 16 KiB. The chain is checked: the creation record is signed by `ik` and by
/// its recovery key, and every chain record follows a record of the chain and is signed by the
/// recovery key in force there. The first `PUT` of an `ik` creates its record; an account keeps
/// records of at most 8 identities. Without `reauth` a `PUT` only adds: it must have the stored
/// creation record and every stored chain record, else it answers 409 and nothing changes (read
/// the record, add what you lack and send it again). With `reauth` it replaces the stored
/// record. Password and phrase tries share the pace of password changes: one every 3 seconds
/// per session, and 50 wrong ones a UTC day. Answers 404 when your account is being deleted.
/// Requires a bearer token; guests can't call it. Strict and general rate-limit buckets.
/// Records are rare requests: at most `RARE_REQUESTS_PER_HOUR` (20) an hour and
/// `RARE_REQUESTS_PER_DAY` (100) a day per account by default, over all its identities. A wrong
/// password or phrase, or a refusal by another limit or while the server is busy (423, 429,
/// 503), does not count.
#[utoipa::path(put, path = "/api/v1/me/p2p_identity/{ik}", tag = "Account", params(("ik" = String, Path, description = "The P2P identity key: an Ed25519 public key, base64url without padding (43 characters)")), request_body = IdentityPut, responses((status = 200, description = "The record as stored", body = IdentityRecord), (status = 400, description = "`ik must be a base64url Ed25519 public key`, `That isn't a valid P2P identity record` (the body is not this JSON, the creation record is not one of this `ik` or a chain record doesn't verify; the reason's `field` is `body`, `cr` or `chain`), or not exactly one way to confirm in `reauth`", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token (`Unauthorized`), `Wrong password`, `Wrong backup phrase` (no phrase set, a used, expired or foreign nonce, or a signature over another purpose or `ik`), or `Confirm with your password` (`fresh_session`)", body = ApiErrorBody), (status = 404, description = "`Not found`: your account is being deleted, or the instance keeps no P2P backups and the `p2p` switch is off", body = ApiErrorBody), (status = 409, description = "`The stored record holds records this one lacks`: without `reauth` the stored creation record and every stored chain record must be in the body, or `Too many P2P identity records`: your account keeps records of 8 other identities", body = ApiErrorBody), (status = 413, description = "`Identity record too large`: the body is over 16 KiB", body = ApiErrorBody), (status = 423, description = "Changes from this session locked for the day (UTC) after 50 wrong passwords or phrases", body = ApiErrorBody), (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. Less than 3 seconds since this session's last try (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket", body = ApiErrorBody), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_identity(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Path(ik): Path<String>,
    body: Body,
) -> Result<Json<IdentityRecord>, ApiError> {
    let held = rare::hold(&state, Rare::P2pIdentity, Some(&session.user))?;
    let answer = put_at(&state, session, &ik, body, state.clock.unix()).await;
    match &answer {
        Err(ApiError(StatusCode::UNAUTHORIZED, _, _)) => drop(held),
        Ok(_) | Err(_) => held.answered(answer.as_ref().err()),
    }
    answer
}

pub(crate) async fn put_at(
    state: &AppState,
    session: Session,
    ik: &str,
    body: Body,
    t: i64,
) -> Result<Json<IdentityRecord>, ApiError> {
    on(state, &session.user).await?;
    check_ik(ik)?;
    let body = to_bytes(body, RECORD_BYTES)
        .await
        .map_err(|_| too_large())?;
    let IdentityPut { cr, chain, reauth } =
        serde_json::from_slice(&body).map_err(|_| invalid("body"))?;
    let offered = p2p_chain::verify(ik, &cr, &chain).map_err(|e| match e {
        ChainError::Creation => invalid("cr"),
        ChainError::Record(_) => invalid("chain"),
    })?;
    let confirmed = match reauth {
        Some(reauth) => {
            let purpose = Purpose::P2pData { ik: ik.to_string() };
            check_at(state, &session, ReAuth::try_from(reauth)?, purpose, t).await?;
            true
        }
        None => false,
    };
    let chain: Vec<Value> = offered
        .records()
        .into_iter()
        .map(|i| chain[i].clone())
        .collect();
    let record = Stored { cr, chain };
    let text = serde_json::to_string(&record).map_err(ApiError::internal)?;
    let username = session.user.username.as_str();
    let mut tx = state.db.begin().await?;
    lock(&mut tx, username).await?;
    if !live(&mut tx, &session.user).await? {
        return Err(not_found());
    }
    match stored(&mut tx, username, ik).await? {
        Some(old) => {
            let extends = serde_json::from_str::<Stored>(&old)
                .ok()
                .and_then(|Stored { cr, chain }| p2p_chain::read(&cr, &chain).ok())
                .is_some_and(|old| offered.extends(&old));
            if !(extends || confirmed) {
                return Err(not_an_append());
            }
        }
        None => {
            let held: i64 = sqlx::query("SELECT COUNT(*) FROM p2p_identities WHERE username = $1")
                .bind(username)
                .fetch_one(&mut *tx)
                .await?
                .try_get(0)?;
            if usize::try_from(held).unwrap_or(usize::MAX) >= RECORD_IDENTITIES {
                return Err(too_many());
            }
        }
    }
    sqlx::query("INSERT INTO p2p_identities(username, ik, record, updated_at) VALUES($1, $2, $3, $4) ON CONFLICT(username, ik) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at")
        .bind(username)
        .bind(ik)
        .bind(&text)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let Stored { cr, chain } = record;
    Ok(Json(IdentityRecord {
        ik: ik.to_string(),
        cr,
        chain,
        updated_at: t,
    }))
}

/// Delete a P2P identity record
///
/// Deletes the record of the P2P identity `ik` stored for your account. Confirm with the
/// password or words, or a `phrase` proof by the account's backup phrase (purpose `p2p-data`,
/// context the `ik`) over a challenge from `POST /api/v1/auth/recovery/challenge`;
/// `fresh_session` is refused. Password and phrase tries share the pace of password changes: one
/// every 3 seconds per session, and 50 wrong ones a UTC day. Requires a bearer token; guests
/// can't call it. Strict and general rate-limit buckets.
#[utoipa::path(delete, path = "/api/v1/me/p2p_identity/{ik}", tag = "Account", params(("ik" = String, Path, description = "The P2P identity key: an Ed25519 public key, base64url without padding (43 characters)")), request_body = IdentityDelete, responses((status = 200, description = "The record is deleted", body = OkResp), (status = 400, description = "`ik must be a base64url Ed25519 public key`, or not exactly one way to confirm in `reauth`. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token (`Unauthorized`), `Wrong password`, `Wrong backup phrase` (no phrase set, a used, expired or foreign nonce, or a signature over another purpose or `ik`), or `Confirm with your password` (`fresh_session`)", body = ApiErrorBody), (status = 404, description = "`Not found`: your account holds no record for this `ik`, or the instance keeps no P2P backups and the `p2p` switch is off", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 423, description = "Changes from this session locked for the day (UTC) after 50 wrong passwords or phrases", body = ApiErrorBody), (status = 429, description = "Less than 3 seconds since this session's last try (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket", body = ApiErrorBody), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn delete_identity(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Path(ik): Path<String>,
    Json(req): Json<IdentityDelete>,
) -> Result<Json<OkResp>, ApiError> {
    delete_at(&state, session, &ik, req, state.clock.unix()).await
}

pub(crate) async fn delete_at(
    state: &AppState,
    session: Session,
    ik: &str,
    req: IdentityDelete,
    t: i64,
) -> Result<Json<OkResp>, ApiError> {
    on(state, &session.user).await?;
    check_ik(ik)?;
    let username = session.user.username.clone();
    if stored(&mut *state.read().acquire().await?, &username, ik)
        .await?
        .is_none()
    {
        return Err(not_found());
    }
    let IdentityDelete { reauth } = req;
    let purpose = Purpose::P2pData { ik: ik.to_string() };
    check_at(state, &session, ReAuth::try_from(reauth)?, purpose, t).await?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, &username).await?;
    let gone = sqlx::query("DELETE FROM p2p_identities WHERE username = $1 AND ik = $2")
        .bind(&username)
        .bind(ik)
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
