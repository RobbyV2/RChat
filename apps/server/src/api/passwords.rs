use std::collections::HashMap;
use std::sync::LazyLock;

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::{Proof, ServerAccess, Via, password_lookup, resolve_server};
use crate::api::servers::guard_rchat;
use crate::api::{
    ApiError, ApiErrorBody, Authed, JoinedVia, OkResp, bad, check_len, ok, placeholders,
};
use crate::db::{Db, NO_EXTRA_HASH, Perm, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

pub const ACTIVE_MAX: i64 = 50;
/// Most stored extra passwords per server, dead ones included. Dead ones are purged 30 days
/// after they stop working.
pub const ROWS_MAX: i64 = 500;
/// Shortest password an admin may choose. Generated passwords are always longer.
pub const SECRET_MIN: usize = 8;
const FULL: &str = "A server can have at most 50 active passwords";
pub const EXPIRY_MAX: i64 = 365 * 86400;
pub const EXPIRY_MIN: i64 = 60;
pub const USES_MAX: i64 = 10_000;
const LABEL_MAX: usize = 100;
const SECRET_MAX: usize = 200;
const LIST_MAX: i64 = 100;
const WORDS: usize = 4;

/// `live` passwords let new people join; `expired`, `used_up` and `revoked` ones no longer do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PasswordStatus {
    Live,
    Expired,
    UsedUp,
    Revoked,
}

pub fn status(
    t: i64,
    expires_at: Option<i64>,
    max_uses: Option<i64>,
    uses: i64,
    revoked: bool,
) -> PasswordStatus {
    match (revoked, max_uses, expires_at) {
        (true, _, _) => PasswordStatus::Revoked,
        (false, Some(max), _) if uses >= max => PasswordStatus::UsedUp,
        (false, _, Some(at)) if at <= t => PasswordStatus::Expired,
        (false, _, _) => PasswordStatus::Live,
    }
}

/// An extra server password. Its hash and the password itself are never returned.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct ServerPassword {
    /// Id of the password.
    pub id: i64,
    /// Label set by the admin who created it; `null` when it has none.
    pub label: Option<String>,
    /// Username of the admin who created it; `null` when that account is gone or the
    /// creator is not someone the server's members can see.
    pub created_by: Option<String>,
    /// When it was created, Unix seconds.
    pub created_at: i64,
    /// When it stops working, Unix seconds; `null` for no expiry.
    pub expires_at: Option<i64>,
    /// How many joins and guest grants it allows; `null` for unlimited.
    pub max_uses: Option<i64>,
    /// How many joins and guest grants used it.
    pub uses: i64,
    /// Whether it still works.
    pub status: PasswordStatus,
}

/// The access settings of a server.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct ServerPasswords {
    /// Whether joining needs a password. `false` for a public server.
    pub protected: bool,
    /// Whether the server has a permanent password.
    pub permanent: bool,
    /// Whether the server is closed: protected, without a permanent password and without a
    /// live extra password, so nobody new can join.
    pub closed: bool,
    /// Extra passwords, live ones first, then the most recent others, newest first within
    /// each group; at most 100. Dead passwords are purged 30 days after they stopped working.
    pub passwords: Vec<ServerPassword>,
}

/// Request body for creating an extra server password.
#[derive(Deserialize, ToSchema)]
pub struct NewPassword {
    /// Label shown in the password list and in the member list ("Joined with"). Trimmed;
    /// blank or omitted means none; at most 100 characters.
    label: Option<String>,
    /// The password. Trimmed; blank or omitted generates four random words joined by `-`. At
    /// most 200 characters, and different from the permanent password and from every other
    /// password of the server (also dead ones that are still listed).
    password: Option<String>,
    /// Seconds until it expires, 60 to 31536000 (one year). Use either this or `expires_at`;
    /// omit both for no expiry.
    expires_in: Option<i64>,
    /// When it expires, Unix seconds, at least 60 seconds and at most one year away.
    expires_at: Option<i64>,
    /// How many joins and guest grants it allows, 1 to 10000; omit for unlimited.
    max_uses: Option<i64>,
}

/// A newly created extra password, with the password itself. This is the only time the
/// password is returned.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct CreatedPassword {
    /// The new password's details (its fields appear at the top level).
    #[serde(flatten)]
    pub info: ServerPassword,
    /// The password itself.
    pub password: String,
}

static WORD_LIST: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    memorable_wordlist::WORDS
        .iter()
        .copied()
        .filter(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase()))
        .collect()
});

/// Admin-chosen passwords (permanent and extra) need at least `SECRET_MIN` characters.
pub fn check_strength(password: &str) -> Result<(), ApiError> {
    match password.trim().chars().count() < SECRET_MIN {
        true => Err(bad(
            "Use at least 8 characters, or leave it blank for a generated one",
        )),
        false => Ok(()),
    }
}

pub fn generate() -> String {
    let words = &*WORD_LIST;
    rand::seq::index::sample(&mut rand::rng(), words.len(), WORDS)
        .into_iter()
        .map(|i| words[i])
        .collect::<Vec<_>>()
        .join("-")
}

async fn manage(state: &AppState, user: &User, name: &str) -> Result<ServerAccess, ApiError> {
    guard_rchat(&name.to_lowercase())?;
    let access = resolve_server(&state.db, name, Some(user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::DeleteServer).await?;
    Ok(access)
}

fn password_row(r: &sqlx::any::AnyRow, t: i64) -> sqlx::Result<ServerPassword> {
    let (expires_at, max_uses, uses): (Option<i64>, Option<i64>, i64) =
        (r.try_get(4)?, r.try_get(5)?, r.try_get(6)?);
    let revoked = r.try_get::<Option<i64>, _>(7)?.is_some();
    Ok(ServerPassword {
        id: r.try_get(0)?,
        label: r.try_get(1)?,
        created_by: r.try_get(2)?,
        created_at: r.try_get(3)?,
        expires_at,
        max_uses,
        uses,
        status: status(t, expires_at, max_uses, uses, revoked),
    })
}

const COLUMNS: &str = "id, label, created_by, created_at, expires_at, max_uses, uses, revoked_at";

const LIVE: &str = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) AND (max_uses IS NULL OR uses < max_uses)";

async fn live_count(db: &Db, server: &str, t: i64) -> Result<i64, ApiError> {
    let sql = format!("SELECT COUNT(*) FROM server_passwords WHERE server = $1 AND {LIVE}");
    Ok(sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(server)
        .bind(t)
        .fetch_one(db)
        .await?
        .try_get(0)?)
}

/// List server passwords
///
/// Returns the access settings of the server: whether it is protected, whether it has a
/// permanent password, whether it is closed, and its extra passwords (temporary passwords and
/// tickets) with their status. Hashes and the passwords themselves are never returned.
/// Requires the Delete server permission. Not available on the rchat server. General rate-limit
/// bucket.
#[utoipa::path(
    get,
    path = "/api/servers/{name}/passwords",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "The access settings and extra passwords", body = ServerPasswords),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission, or the rchat server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_passwords(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<ServerPasswords>, ApiError> {
    let access = manage(&state, &user, &name).await?;
    let db = &state.db;
    let t = now();
    let sql = format!(
        "SELECT {COLUMNS} FROM server_passwords WHERE server = $1 ORDER BY CASE WHEN {LIVE} THEN 0 ELSE 1 END, id DESC LIMIT $3"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(access.name())
        .bind(t)
        .bind(LIST_MAX)
        .fetch_all(db)
        .await?;
    let passwords = rows
        .iter()
        .map(|r| password_row(r, t))
        .collect::<sqlx::Result<Vec<_>>>()?;
    let protected = access.lite().has_password;
    let permanent = access.has_permanent_password(db).await?;
    let live = passwords.iter().any(|p| p.status == PasswordStatus::Live);
    Ok(Json(ServerPasswords {
        protected,
        permanent,
        closed: protected && !permanent && !live,
        passwords,
    }))
}

fn expiry(
    t: i64,
    expires_in: Option<i64>,
    expires_at: Option<i64>,
) -> Result<Option<i64>, ApiError> {
    let at = match (expires_in, expires_at) {
        (Some(_), Some(_)) => return Err(bad("Use either expires_in or expires_at")),
        (Some(secs), None) => t.saturating_add(secs),
        (None, Some(at)) => at,
        (None, None) => return Ok(None),
    };
    match at.saturating_sub(t) {
        d if d < EXPIRY_MIN => Err(bad("The expiry must be at least a minute away")),
        d if d > EXPIRY_MAX => Err(bad("The expiry can be at most a year away")),
        _ => Ok(Some(at)),
    }
}

/// Create a server password
///
/// Adds an extra password to a password-protected server, next to its permanent password.
/// It can expire (`expires_in` or `expires_at`, a temporary password) and can be limited to a
/// number of uses (`max_uses`, a ticket): every join and every guest grant through it uses one,
/// invite previews do not. A blank `password` generates four random words. The response is the
/// only time the password is returned. A chosen password needs at least 8 characters. A server
/// has at most 50 live extra passwords and keeps at most 500 in all (dead ones are purged 30
/// days after they stop working). Requires the Delete server permission. Not available on the
/// rchat server. Strict and general rate-limit buckets.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/passwords",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = NewPassword,
    responses(
        (status = 200, description = "The new password, with the password itself", body = CreatedPassword),
        (status = 400, description = "The server is public, already has 50 live extra passwords or 500 stored ones, an invalid label, password (shorter than 8 characters or longer than 200), expiry or use limit, or a password the server already uses or used. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission, or the rchat server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the strict or the general bucket (plain text), or `Too many attempts. Try again later` (JSON) while the server is busy checking passwords", content((ApiErrorBody = "application/json"), (String = "text/plain")))
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_password(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<NewPassword>,
) -> Result<Json<CreatedPassword>, ApiError> {
    let NewPassword {
        label,
        password,
        expires_in,
        expires_at,
        max_uses,
    } = req;
    let access = manage(&state, &user, &name).await?;
    let db = &state.db;
    if !access.lite().has_password {
        return Err(bad("Make the server password protected first"));
    }
    let label = label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty());
    if let Some(label) = &label {
        check_len(label, LABEL_MAX, "Label")?;
    }
    let secret = match password.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            check_len(p, SECRET_MAX, "Password")?;
            check_strength(p)?;
            p.to_string()
        }
        _ => generate(),
    };
    let t = now();
    let expires_at = expiry(t, expires_in, expires_at)?;
    if let Some(max) = max_uses
        && !(1..=USES_MAX).contains(&max)
    {
        return Err(bad("Uses must be between 1 and 10000"));
    }
    if live_count(db, access.name(), t).await? >= ACTIVE_MAX {
        return Err(bad(FULL));
    }
    if access.is_permanent_password(db, &secret).await? {
        return Err(bad("That password is already in use"));
    }
    let lookup = password_lookup(db, access.name(), &secret).await?;
    let taken = sqlx::query("SELECT 1 FROM server_passwords WHERE server = $1 AND lookup = $2")
        .bind(access.name())
        .bind(&lookup)
        .fetch_optional(db)
        .await?
        .is_some();
    if taken {
        return Err(bad("That password was already used here. Pick another one"));
    }
    let created_by = match access.via() == Via::Staff
        || (user.is_site_admin
            && access.member_perms(db, &user.username).await? & Perm::DeleteServer as i64 == 0)
    {
        true => None,
        false => Some(user.username.clone()),
    };
    let mut tx = db.begin().await?;
    if !crate::db::is_sqlite(db) {
        sqlx::query("SELECT 1 FROM servers WHERE name = $1 FOR UPDATE")
            .bind(access.name())
            .execute(&mut *tx)
            .await?;
    }
    let sql = format!(
        "INSERT INTO server_passwords(server, label, hash, lookup, created_by, created_at, expires_at, max_uses) SELECT $1, $2, $3, $4, $5, $6, $7, $8 WHERE (SELECT COUNT(*) FROM server_passwords WHERE server = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $6) AND (max_uses IS NULL OR uses < max_uses)) < $9 AND (SELECT COUNT(*) FROM server_passwords WHERE server = $1) < $10 RETURNING {COLUMNS}"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(access.name())
        .bind(&label)
        .bind(NO_EXTRA_HASH)
        .bind(&lookup)
        .bind(&created_by)
        .bind(t)
        .bind(expires_at)
        .bind(max_uses)
        .bind(ACTIVE_MAX)
        .bind(ROWS_MAX)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => {
                bad("That password was already used here. Pick another one")
            }
            _ => ApiError::from(e),
        })?;
    let Some(row) = row else {
        drop(tx);
        return Err(
            match live_count(db, access.name(), t).await? >= ACTIVE_MAX {
                true => bad(FULL),
                false => {
                    bad("Too many old passwords. They are removed 30 days after they stop working")
                }
            },
        );
    };
    tx.commit().await?;
    Ok(Json(CreatedPassword {
        info: password_row(&row, t)?,
        password: secret,
    }))
}

/// Revoke a server password
///
/// Stops an extra password from letting anyone new join. Members who joined with it stay;
/// guest grants issued through it end now. The password stays listed as `revoked` until it is
/// purged 30 days later. Revoking a revoked password does nothing. Requires the Delete server
/// permission. Not available on the rchat server. Emits `server_updated` to the server, so
/// guests whose grant ended lose the server. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/servers/{name}/passwords/{id}",
    tag = "Servers",
    params(
        ("name" = String, Path, description = "Server name, case-insensitive"),
        ("id" = i64, Path, description = "Password id")
    ),
    responses(
        (status = 200, description = "Revoked", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission, or the rchat server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or `Password not found`", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn revoke_password(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<OkResp>, ApiError> {
    let access = manage(&state, &user, &name).await?;
    let mut tx = state.db.begin().await?;
    let found = sqlx::query("SELECT 1 FROM server_passwords WHERE id = $1 AND server = $2")
        .bind(id)
        .bind(access.name())
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
    if !found {
        return Err(ApiError(
            axum::http::StatusCode::NOT_FOUND,
            "Password not found".to_string(),
        ));
    }
    sqlx::query("UPDATE server_passwords SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL")
        .bind(now())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM guest_grants WHERE password_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::ServerUpdated {
        server: access.lite().clone(),
    });
    Ok(ok())
}

/// Revokes every extra password of `server` and ends the guest grants issued through them
/// (the server became public, or its lowercase name changed).
pub(crate) async fn revoke_all(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    server: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE server_passwords SET revoked_at = $1 WHERE server = $2 AND revoked_at IS NULL",
    )
    .bind(now())
    .bind(server)
    .execute(&mut **tx)
    .await?;
    sqlx::query("DELETE FROM guest_grants WHERE server = $1 AND password_id IS NOT NULL")
        .bind(server)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// The extra password each of `names` joined `server` with, when it is still listed.
pub(crate) async fn joined_via(
    db: &Db,
    server: &str,
    names: &[String],
) -> Result<HashMap<String, JoinedVia>, ApiError> {
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = format!(
        "SELECT m.username, p.id, p.label FROM members m JOIN server_passwords p ON p.id = m.joined_via AND p.server = m.server WHERE m.server = $1 AND m.username IN ({})",
        placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for name in names {
        query = query.bind(name);
    }
    let mut out = HashMap::new();
    for r in &query.fetch_all(db).await? {
        out.insert(
            r.try_get(0)?,
            JoinedVia {
                id: r.try_get(1)?,
                label: r.try_get(2)?,
            },
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_follow_revocation_uses_and_expiry() {
        let t = 1000;
        assert_eq!(status(t, None, None, 5, false), PasswordStatus::Live);
        assert_eq!(
            status(t, Some(1001), Some(3), 2, false),
            PasswordStatus::Live
        );
        assert_eq!(
            status(t, Some(1000), None, 0, false),
            PasswordStatus::Expired
        );
        assert_eq!(status(t, None, Some(1), 1, false), PasswordStatus::UsedUp);
        assert_eq!(
            status(t, Some(1), Some(1), 1, false),
            PasswordStatus::UsedUp
        );
        assert_eq!(
            status(t, Some(1), Some(1), 1, true),
            PasswordStatus::Revoked
        );
        assert_eq!(status(t, None, None, 0, true), PasswordStatus::Revoked);
    }

    #[test]
    fn expiry_is_bounded_and_single_sourced() {
        let t = 10_000;
        assert_eq!(expiry(t, None, None).ok(), Some(None));
        assert_eq!(expiry(t, Some(1800), None).ok(), Some(Some(t + 1800)));
        assert_eq!(
            expiry(t, None, Some(t + EXPIRY_MAX)).ok(),
            Some(Some(t + EXPIRY_MAX))
        );
        assert!(expiry(t, None, Some(t + EXPIRY_MAX + 1)).is_err());
        assert!(expiry(t, Some(59), None).is_err());
        assert!(expiry(t, None, Some(t - 5)).is_err());
        assert!(expiry(t, Some(i64::MAX), None).is_err());
        assert!(expiry(t, Some(i64::MIN), None).is_err());
        assert!(expiry(t, None, Some(i64::MIN)).is_err());
        assert!(expiry(t, None, Some(i64::MAX)).is_err());
        assert!(expiry(-t, None, Some(i64::MAX)).is_err());
        assert!(expiry(t, Some(60), Some(t + 60)).is_err());
    }

    #[test]
    fn generated_passwords_are_four_distinct_words() {
        for _ in 0..50 {
            let secret = generate();
            let words: Vec<&str> = secret.split('-').collect();
            assert_eq!(words.len(), WORDS);
            assert!(
                words
                    .iter()
                    .all(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase()))
            );
            let mut unique = words.clone();
            unique.sort();
            unique.dedup();
            assert_eq!(unique.len(), WORDS);
        }
        assert!(WORD_LIST.len() > 10_000);
    }
}
