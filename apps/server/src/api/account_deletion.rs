use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::reauth::{AuthedSession, Purpose, ReAuth, ReAuthBody, Session, check_at};
use crate::api::{ApiError, ApiErrorBody, Authed, OkResp, ok, unauthorized};
use crate::db::{Db, PURGING_HASH, User};
use crate::sso::Sso;
use crate::state::AppState;
use crate::ws::WsEvent;

/// How long an account waits between asking to be deleted and its deletion.
pub const GRACE_SECS: i64 = 14 * 86400;

/// The one answer to an account that may not delete itself.
pub(crate) const REFUSED: &str = "This account can't be deleted on this site";

const OWN: &str = "kind = 'user' AND key = $1 AND self_requested = 1";

/// The confirmation of an account deletion.
#[derive(Deserialize, ToSchema)]
pub struct DeleteAccount {
    /// How you confirm.
    reauth: ReAuthBody,
}

/// An account that waits to be deleted.
#[derive(Serialize, ToSchema)]
pub struct DeletionPending {
    /// When the account is deleted (Unix seconds).
    delete_at: i64,
}

fn refusal() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, REFUSED.to_string(), None)
}

/// Whether `user` may not delete itself: it is the only site admin that stays, or a sign-in
/// provider that creates accounts manages it.
pub(crate) async fn refused(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    sso: &Sso,
    user: &User,
) -> sqlx::Result<bool> {
    if user.is_site_admin {
        let others: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM users WHERE is_site_admin = 1 AND username <> $1 AND password_hash <> $2 AND suspended_at IS NULL AND username NOT IN (SELECT key FROM pending_purges WHERE kind = 'user' AND self_requested = 1)",
        )
        .bind(&user.username)
        .bind(PURGING_HASH)
        .fetch_one(&mut **tx)
        .await?;
        if others == 0 {
            return Ok(true);
        }
    }
    let directory: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scim_users WHERE username = $1")
        .bind(&user.username)
        .fetch_one(&mut **tx)
        .await?;
    if directory > 0 {
        return Ok(true);
    }
    let links = sqlx::query("SELECT provider FROM sso_links WHERE username = $1")
        .bind(&user.username)
        .fetch_all(&mut **tx)
        .await?;
    for link in &links {
        let provider: String = link.try_get(0)?;
        if provisions(sso, &provider) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether the provider `id` creates accounts here, at sign-in or through its directory.
fn provisions(sso: &Sso, id: &str) -> bool {
    let directory = sso
        .config
        .scim
        .as_ref()
        .is_some_and(|scim| scim.provider.as_deref() == Some(id));
    directory
        || sso
            .config
            .providers
            .iter()
            .any(|p| p.id == id && p.auto_create)
}

/// Calls off the deletion the account `key` asked for. `false` when none was waiting.
pub(crate) async fn cancel_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    key: &str,
) -> sqlx::Result<bool> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DELETE FROM pending_purges WHERE {OWN}"
    )))
    .bind(key)
    .execute(&mut **tx)
    .await
    .map(|done| done.rows_affected() > 0)
}

/// When the account `key` is deleted at its own request, or `None` when it did not ask.
pub(crate) async fn due(db: &Db, key: &str) -> sqlx::Result<Option<i64>> {
    let asked: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT created_at FROM pending_purges WHERE {OWN}"
    )))
    .bind(key)
    .fetch_optional(db)
    .await?;
    Ok(asked.map(|at| at.saturating_add(GRACE_SECS)))
}

/// Delete your account
///
/// Schedules the deletion of the calling account for 14 days later and signs it out
/// everywhere: every session of the account is revoked, this one too, and its WebSocket
/// connections close. Until then the account stays as it is. Signing in again with the
/// password or a provider keeps the account; so does `DELETE /api/v1/me/delete` from a session
/// opened another way. After the 14 days the account, its messages, its direct messages and
/// the P2P backups and P2P identities this instance holds for it are deleted. Confirm with the
/// account password or words, a fresh confirmation from a linked provider, or a `phrase` proof
/// (purpose `delete_account`, empty context) over a challenge from
/// `POST /api/v1/auth/recovery/challenge`; `fresh_session` is refused. Password and phrase
/// tries share the pace of password changes. Some accounts can't be deleted this way; they get
/// one answer that does not say why. Requires a bearer token. Strict and general rate-limit
/// buckets.
#[utoipa::path(post, path = "/api/v1/me/delete", tag = "Account", request_body = DeleteAccount, responses((status = 200, description = "The deletion is scheduled and every session of the account is revoked", body = DeletionPending), (status = 400, description = "Not exactly one way to confirm in `reauth`. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "Missing, unknown or just revoked bearer token (`Unauthorized`), `Wrong password`, `Wrong backup phrase`, `Change your temporary password first`, or `Confirm with your password` (`fresh_session`)", body = ApiErrorBody), (status = 403, description = "`This account can't be deleted on this site`", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 423, description = "Changes from this session locked for the day (UTC) after 50 wrong passwords or phrases", body = ApiErrorBody), (status = 429, description = "Less than 3 seconds since this session's last try (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket", body = ApiErrorBody), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn request(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Json(req): Json<DeleteAccount>,
) -> Result<Json<DeletionPending>, ApiError> {
    request_at(&state, session, req, state.clock.unix()).await
}

pub(crate) async fn request_at(
    state: &AppState,
    session: Session,
    req: DeleteAccount,
    t: i64,
) -> Result<Json<DeletionPending>, ApiError> {
    let DeleteAccount { reauth } = req;
    let reauth = ReAuth::try_from(reauth)?;
    let mut tx = state.db.begin().await?;
    let barred = refused(&mut tx, &state.sso, &session.user).await?;
    tx.rollback().await?;
    if barred {
        return Err(refusal());
    }
    check_at(state, &session, reauth, Purpose::DeleteAccount, t).await?;
    let Session {
        user,
        token: _,
        created_at: _,
    } = session;
    let mut tx = state.db.begin().await?;
    let held = sqlx::query(
        "UPDATE users SET password_hash = password_hash WHERE username = $1 AND password_hash = $2 AND suspended_at IS NULL",
    )
    .bind(&user.username)
    .bind(&user.password_hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if held != 1 {
        return Err(unauthorized());
    }
    if refused(&mut tx, &state.sso, &user).await? {
        return Err(refusal());
    }
    sqlx::query(
        "INSERT INTO pending_purges(kind, key, created_at, claimed_at, self_requested) VALUES('user', $1, $2, 0, 1) ON CONFLICT(kind, key) DO NOTHING",
    )
    .bind(&user.username)
    .bind(t)
    .execute(&mut *tx)
    .await?;
    let asked: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT created_at FROM pending_purges WHERE {OWN}"
    )))
    .bind(&user.username)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM tokens WHERE username = $1")
        .bind(&user.username)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::TokensRevoked {
        username: user.username,
    });
    Ok(Json(DeletionPending {
        delete_at: asked.saturating_add(GRACE_SECS),
    }))
}

/// Keep your account
///
/// Calls off the deletion the calling account asked for with `POST /api/v1/me/delete`.
/// Succeeds when none was waiting. Requires a bearer token. Strict and general rate-limit
/// buckets.
#[utoipa::path(delete, path = "/api/v1/me/delete", tag = "Account", responses((status = 200, description = "The account is not waiting to be deleted", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the strict or general bucket", body = ApiErrorBody), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn cancel(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<OkResp>, ApiError> {
    let mut tx = state.db.begin().await?;
    cancel_in(&mut tx, &user.username).await?;
    tx.commit().await?;
    Ok(ok())
}

#[cfg(test)]
mod tests;
