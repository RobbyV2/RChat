use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Serialize;
use sqlx::Row;

use crate::api::access::not_found;
use crate::api::admin::require_site_admin;
use crate::api::features::Feature;
use crate::api::temp_passwords::{self, Issued, Issuer};
use crate::api::{ApiError, Authed, OkResp, Settings, UserRef, ok};
use crate::db::{get_user, now, temp_password};
use crate::state::AppState;
use crate::ws::WsEvent;

/// The answer to issuing a temporary password while nobody can sign in with a password.
pub(crate) const PASSWORDS_OFF: &str = "Password sign-in is off";
/// The answer to issuing a temporary password for the caller's own account.
pub(crate) const OWN_PASSWORD: &str = "Use Settings to change your own password";

/// Refuses while password sign-in is off: a temporary password could not sign in.
pub(crate) async fn passwords_on(state: &AppState) -> Result<Settings, ApiError> {
    let settings = Settings::cached(&state.db).await;
    match settings.password_login {
        true => Ok(settings),
        false => Err(ApiError::off_site(
            StatusCode::BAD_REQUEST,
            PASSWORDS_OFF,
            Feature::PasswordLogin.key(),
        )),
    }
}

/// Issue a new temporary password for an account
///
/// Replaces the account's password with a generated temporary one, ends every session of the
/// account and closes its connections. The password is in this answer only: the instance keeps
/// its hash. It signs in for `temp_password_hours`, and the account must then choose its own
/// (`password_change`). The backup phrase stays. Refused for the caller's own account (400) and
/// while `password_login` is off (400, reason `off_site`). Strict rate-limit bucket.
pub(crate) async fn reset_password(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<Issued>, ApiError> {
    require_site_admin(&user)?;
    let key = username.to_lowercase();
    if key == user.username {
        return Err(ApiError::invalid(OWN_PASSWORD, "username"));
    }
    let settings = passwords_on(&state).await?;
    let issued = temp_passwords::reset(
        &state.db,
        &key,
        Issuer::Account(&user.username),
        settings.temp_password_hours,
        now(),
    )
    .await?;
    state
        .hub
        .broadcast(WsEvent::TokensRevoked { username: key });
    Ok(Json(issued))
}

/// Sign an account out everywhere
///
/// Ends every session of the account and closes its connections. The password stays.
pub(crate) async fn sign_out(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let Some(target) = get_user(&state.db, &username).await? else {
        return Err(not_found());
    };
    let mut tx = state.db.begin().await?;
    let ended = sqlx::query("DELETE FROM tokens WHERE username = $1")
        .bind(&target.username)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    crate::api::instance_audit::record_in(
        &mut tx,
        &user.username,
        "user.sign_out",
        Some(&target.username),
        serde_json::json!({ "sessions": ended }),
        now(),
    )
    .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::TokensRevoked {
        username: target.username,
    });
    Ok(ok())
}

/// The temporary password of an account in the account view.
#[derive(Serialize)]
pub struct Temporary {
    pub issued_at: i64,
    pub expires_at: Option<i64>,
    /// Whether it has expired.
    pub expired: bool,
}

/// One account as the site administration page shows it.
#[derive(Serialize)]
pub struct AdminUser {
    pub user: UserRef,
    pub created_at: i64,
    /// How the account signs in: `text` or `words`.
    pub sign_in: String,
    /// Set while the account's password is a temporary one.
    pub temporary: Option<Temporary>,
    /// Whether the account has a backup phrase.
    pub phrase: bool,
    /// Open sessions.
    pub sessions: i64,
    /// Servers the account is a member of.
    pub servers: i64,
}

/// Get one account
///
/// How the account signs in, whether its password is a temporary one, whether it has a backup
/// phrase, and how many sessions and servers it has.
pub(crate) async fn get_account(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<AdminUser>, ApiError> {
    require_site_admin(&user)?;
    let db = &state.read();
    let Some(target) = get_user(db, &username).await? else {
        return Err(not_found());
    };
    let t = now();
    let temporary = temp_password(db, &target.username)
        .await?
        .map(|temp| Temporary {
            issued_at: temp.issued_at,
            expires_at: temp.expires_at,
            expired: temp.expired(t),
        });
    let count = |sql: &'static str| {
        let name = target.username.clone();
        async move {
            sqlx::query(sql)
                .bind(name)
                .fetch_one(db)
                .await?
                .try_get::<i64, _>(0)
        }
    };
    let sessions = count("SELECT COUNT(*) FROM tokens WHERE username = $1").await?;
    let servers = count("SELECT COUNT(*) FROM members m JOIN servers s ON s.name = m.server WHERE m.username = $1 AND COALESCE(s.password_hash, '') <> '!purging'").await?;
    Ok(Json(AdminUser {
        user: UserRef::from_user(&target),
        created_at: target.created_at,
        sign_in: target.password_kind.clone(),
        temporary,
        phrase: target.recovery_pub.is_some(),
        sessions,
        servers,
    }))
}
