use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::api::access::not_found;
use crate::api::admin::require_site_admin;
use crate::api::auth::{
    NewAccount, add_account, announce_account, shaped_display_name, username_key,
};
use crate::api::features::Feature;
use crate::api::policy::Policy;
use crate::api::temp_passwords::{self, Issued, Issuer};
use crate::api::{
    ApiError, Authed, OkResp, ProfanityTarget, SERVER_ERROR, Settings, UserRef, check_profanity, ok,
};
use crate::db::{AvatarKind, get_user, temp_password};
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
        state.clock.unix(),
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
        state.clock.unix(),
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
    let t = state.clock.unix();
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

/// The most servers one request adds an account to.
pub(crate) const SERVERS_MAX: usize = 20;
/// The most roles one request gives an account in one server.
pub(crate) const ROLES_MAX: usize = 20;

/// A server to add an account to, with the roles it gets there.
#[derive(Deserialize)]
pub struct ServerEntry {
    /// The server's key or name.
    server: String,
    /// Ids of roles of that server.
    #[serde(default)]
    roles: Vec<i64>,
}

/// Request body of `POST /api/v1/admin/users`.
#[derive(Deserialize)]
pub struct NewAccountReq {
    /// The rules of `POST /api/v1/auth/register`.
    username: String,
    /// 1 to 32 characters; the username as written when left out or blank.
    #[serde(default)]
    display_name: Option<String>,
    /// Up to 20 servers to join besides the default servers.
    #[serde(default)]
    servers: Vec<ServerEntry>,
}

/// What became of one server of the request.
#[derive(Serialize)]
pub struct ServerResult {
    pub server: String,
    pub ok: bool,
    /// Why the account was not added.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A new account with its temporary password, which is in this answer only.
#[derive(Serialize)]
pub struct CreatedAccount {
    pub user: UserRef,
    pub temp_password: String,
    pub expires_at: Option<i64>,
    pub servers: Vec<ServerResult>,
}

fn entries_fit(servers: &[ServerEntry]) -> Result<(), ApiError> {
    if servers.len() > SERVERS_MAX {
        return Err(ApiError::invalid("At most 20 servers", "servers"));
    }
    if servers.iter().any(|entry| entry.roles.len() > ROLES_MAX) {
        return Err(ApiError::invalid("At most 20 roles in a server", "servers"));
    }
    Ok(())
}

/// Adds `username` to each of `servers`, one after the other. A server that fails is told in
/// its result and stops none of the others.
async fn add_to_servers(
    state: &AppState,
    admin: &crate::db::User,
    username: &str,
    servers: Vec<ServerEntry>,
) -> Vec<ServerResult> {
    let mut results = Vec::with_capacity(servers.len());
    for ServerEntry { server, roles } in servers {
        let added = crate::api::servers::add_for(state, admin, &server, username, &roles).await;
        results.push(match added {
            Ok(key) => ServerResult {
                server: key,
                ok: true,
                error: None,
            },
            Err(e) => {
                let failed = e.failed();
                let ApiError(_, error, _) = e;
                ServerResult {
                    server,
                    ok: false,
                    error: Some(match failed {
                        true => SERVER_ERROR.to_string(),
                        false => error,
                    }),
                }
            }
        });
    }
    results
}

/// Create an account
///
/// Makes an account with a generated temporary password, which is in this answer only. The
/// account joins the default servers, then each server of `servers` with the roles given for
/// it; `servers` in the answer says which of those worked, and one that failed leaves the
/// account and the others in place. The account is never a site administrator, and works in
/// every `registration` mode. Refused while `password_login` is off (400, reason `off_site`).
/// The username and display name follow the rules of sign-up. Strict rate-limit bucket.
pub(crate) async fn create_account(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<NewAccountReq>,
) -> Result<Json<CreatedAccount>, ApiError> {
    require_site_admin(&user)?;
    let NewAccountReq {
        username,
        display_name,
        servers,
    } = req;
    let settings = passwords_on(&state).await?;
    let key = username_key(&username)?;
    entries_fit(&servers)?;
    let display_name = match display_name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => shaped_display_name(&state.db, name).await?,
        Some(_) | None => username.clone(),
    };
    check_profanity(&state.db, ProfanityTarget::Usernames, &username).await?;
    let temp_password = temp_passwords::generate();
    let password_hash = crate::api::auth::hash_password(&temp_password).await?;
    let defaults = Policy::cached(&state.db).await.default_servers.clone();
    let t = state.clock.unix();
    let expires_at = temp_passwords::expiry(settings.temp_password_hours, t);
    let mut tx = state.db.begin().await?;
    let joined = add_account(
        &mut tx,
        &state.limits,
        &defaults,
        NewAccount {
            username: &key,
            display_name: &display_name,
            password_hash: &password_hash,
            password_kind: "text",
            avatar_kind: AvatarKind::Identicon,
            avatar_color: None,
            first_is_admin: false,
        },
        t,
    )
    .await?;
    temp_passwords::mark(&mut tx, &key, Some(&user.username), expires_at, t).await?;
    let asked: Vec<&str> = servers.iter().map(|entry| entry.server.as_str()).collect();
    crate::api::instance_audit::record_in(
        &mut tx,
        &user.username,
        "user.create",
        Some(&key),
        serde_json::json!({ "display_name": display_name, "servers": asked }),
        t,
    )
    .await?;
    tx.commit().await?;
    let Some(created) = get_user(&state.db, &key).await? else {
        return Err(ApiError::internal("the new account is missing"));
    };
    announce_account(&state, &created, joined).await;
    let servers = add_to_servers(&state, &user, &key, servers).await;
    Ok(Json(CreatedAccount {
        user: UserRef::from_user(&created),
        temp_password,
        expires_at,
        servers,
    }))
}

/// Request body of `POST /api/v1/admin/users/{username}/servers`.
#[derive(Deserialize)]
pub struct AddToServerReq {
    /// The server's key or name.
    server: String,
    /// Ids of roles of that server.
    #[serde(default)]
    roles: Vec<i64>,
}

/// Add an account to a server
///
/// Makes the account a member of the server, whatever `server_joining` says, and gives it the
/// roles. An account that is a member already only gets the roles. A missing server or account
/// answers 404, a role of another server 404 `Role not found`, a banned account 403.
pub(crate) async fn add_to_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
    Json(req): Json<AddToServerReq>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let AddToServerReq { server, roles } = req;
    if roles.len() > ROLES_MAX {
        return Err(ApiError::invalid("At most 20 roles in a server", "roles"));
    }
    let Some(target) = get_user(&state.db, &username).await? else {
        return Err(not_found());
    };
    let key =
        crate::api::servers::add_for(&state, &user, &server, &target.username, &roles).await?;
    crate::api::instance_audit::record(
        &state.db,
        &user.username,
        "server.add_member",
        Some(&target.username),
        serde_json::json!({ "server": key, "roles": roles }),
    )
    .await?;
    Ok(ok())
}

#[cfg(test)]
mod tests;
