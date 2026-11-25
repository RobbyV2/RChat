use super::flow::{self, AppCode, Confirmation};
use crate::api::ApiError;
use crate::db::now;
use crate::state::AppState;
use crate::ws::WsEvent;

use crate::api::{Settings, UserRef, auth, features::Registration, names, policy::Policy};
use crate::db::{AvatarKind, Db, NO_PASSWORD_HASH, User, secret_key};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The persisted lookup key for an opaque, case-sensitive OIDC subject or session ID.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct OidcKey(String);

impl OidcKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for OidcKey {
    type Error = &'static str;

    fn try_from(encoded: String) -> Result<Self, Self::Error> {
        if encoded.len() == 64
            && encoded
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            Ok(Self(encoded))
        } else {
            Err("Invalid OIDC lookup key")
        }
    }
}

/// Hash the exact claim bytes once, including opaque IDs that already look like a digest.
pub fn oidc_key(raw: &str) -> OidcKey {
    OidcKey(hex::encode(Sha256::digest(raw.as_bytes())))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Identity {
    pub provider: String,
    pub issuer: String,
    pub subject: OidcKey,
    pub username_claim: Option<String>,
    #[serde(default)]
    pub scim_key: Option<String>,
    pub display: Option<String>,
    pub groups: Vec<String>,
    pub sid: Option<OidcKey>,
}

#[allow(clippy::large_enum_variant)] // The exchange returns the profile of the committed session.
pub enum SignIn {
    Session {
        user: User,
        created: bool,
        confirmation: Option<Confirmation>,
        token: String,
    },
    NeedsUsername {
        suggestion: Option<String>,
        reason: NameIssue,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NameIssue {
    Taken,
    Invalid,
}

pub fn clean_username(raw: &str) -> Option<String> {
    let local: String = raw
        .trim()
        .split('@')
        .next()?
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let name: String = local.trim().chars().take(crate::api::NAME_MAX).collect();
    (!name.is_empty()).then_some(name)
}

pub async fn display_from_claim(db: &Db, raw: &str) -> Result<Option<String>, ApiError> {
    if raw.contains('@') {
        return Ok(None);
    }
    let clipped: String = raw.trim().chars().take(auth::DISPLAY_NAME_MAX).collect();
    match auth::shaped_display_name(db, &clipped).await {
        Ok(name) => Ok(Some(name)),
        Err(e) if e.0 == StatusCode::BAD_REQUEST => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn user_name_key(raw: &str) -> String {
    hex::encode(Sha256::digest(raw.trim().to_lowercase().as_bytes()))
}
pub fn has_password(user: &User) -> bool {
    !user.password_hash.starts_with('!')
}
pub async fn may_set_password(state: &AppState, user: &User) -> bool {
    has_password(user) || Settings::cached(&state.db).await.password_login
}
fn forbidden(message: &str) -> ApiError {
    ApiError(StatusCode::FORBIDDEN, message.into(), None)
}
fn suspended() -> ApiError {
    forbidden("This account is suspended")
}

pub async fn sign_in(
    state: &AppState,
    id: &Identity,
    picked: Option<&str>,
) -> Result<SignIn, ApiError> {
    login(state, id, picked, None).await
}

pub async fn confirm_sign_in(
    state: &AppState,
    app: &AppCode,
    username: &str,
) -> Result<SignIn, ApiError> {
    login(state, &app.identity, None, Some((username, app))).await
}

async fn login(
    state: &AppState,
    id: &Identity,
    picked: Option<&str>,
    confirmation: Option<(&str, &AppCode)>,
) -> Result<SignIn, ApiError> {
    for _ in 0..2 {
        if let Some(result) = sign_in_once(state, id, picked, confirmation).await? {
            return Ok(result);
        }
    }
    Err(forbidden("Sign-in changed. Try again"))
}

async fn linked_username(
    conn: &mut sqlx::AnyConnection,
    id: &Identity,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT username FROM sso_links WHERE issuer=$1 AND subject=$2")
        .bind(&id.issuer)
        .bind(id.subject.as_str())
        .fetch_optional(conn)
        .await
}

// None means a link changed concurrently. Drop all tentative account writes and
// resolve the issuer/subject pair again in a new transaction.
async fn sign_in_once(
    state: &AppState,
    id: &Identity,
    picked: Option<&str>,
    confirmation: Option<(&str, &AppCode)>,
) -> Result<Option<SignIn>, ApiError> {
    let config = &state.sso.config;
    let provider = config
        .providers
        .iter()
        .find(|p| p.id == id.provider && p.issuer == id.issuer)
        .ok_or_else(|| forbidden("Unknown sign-in provider"))?;
    let settings = Settings::cached(&state.db).await;
    let display = match (&id.display, provider.sync_profile) {
        (Some(raw), true) => display_from_claim(&state.db, raw).await?,
        _ => None,
    };
    let defaults = &Policy::cached(&state.db).await.default_servers;
    let mut tx = auth::begin_account_write(&state.db).await?;
    let mut linked = linked_username(&mut tx, id).await?;
    if let Some((username, _)) = confirmation
        && linked.as_deref() != Some(username)
    {
        return Err(forbidden("Account does not match linked sign-in"));
    }
    let directory_login =
        config.scim.as_ref().and_then(|s| s.provider.as_ref()) == Some(&id.provider);
    if linked.is_none() {
        // A concurrent first login may have committed while this transaction
        // waited for registration's server and username locks.
        auth::lock_account_creation(&mut tx, defaults).await?;
        linked = linked_username(&mut tx, id).await?;
    } else if display.is_some() || directory_login {
        // Group writes enumerate cached claimants under this same lock.
        crate::db::lock_new_usernames(&mut tx).await?;
    }
    let t = now();
    let already_linked = linked.is_some();
    let mut username = linked;
    if username.is_none()
        && directory_login
        && let Some(key) = id.scim_key.as_deref()
    {
        username = sqlx::query_scalar(
            "SELECT s.username FROM scim_users s JOIN users u ON u.username = s.username
             WHERE s.user_name_key = $1 AND s.deleted_at IS NULL
             AND NOT EXISTS(SELECT 1 FROM sso_links l WHERE l.username = s.username AND l.issuer = $2)",
        )
        .bind(key)
        .bind(&id.issuer)
        .fetch_optional(&mut *tx)
        .await?;
    }
    let mut joined = None;
    let username = match username {
        Some(key) => key,
        None => {
            if !provider.auto_create || settings.registration == Registration::Closed {
                return Err(forbidden("New accounts are closed"));
            }
            let suggestion = picked
                .map(str::to_owned)
                .or_else(|| id.username_claim.as_deref().and_then(clean_username));
            let Some(name) = suggestion.as_deref() else {
                return Ok(Some(SignIn::NeedsUsername {
                    suggestion: None,
                    reason: NameIssue::Invalid,
                }));
            };
            let key = match auth::check_new_username(&mut tx, &settings, name).await {
                Ok(key) => key,
                Err(e) if picked.is_none() && e.0 == StatusCode::BAD_REQUEST => {
                    let reason = match e.1.as_str() {
                        "Username is taken"
                        | "Username is banned"
                        | "Content blocked by profanity filter" => NameIssue::Taken,
                        _ => NameIssue::Invalid,
                    };
                    return Ok(Some(SignIn::NeedsUsername { suggestion, reason }));
                }
                Err(e) => return Err(e),
            };
            let shown = match display.as_deref() {
                Some(shown) if names::refusal(&mut tx, &key, shown).await?.is_none() => shown,
                _ => name,
            };
            joined = Some(
                auth::add_account(
                    &mut tx,
                    &state.limits,
                    defaults,
                    auth::NewAccount {
                        username: &key,
                        display_name: shown,
                        password_hash: NO_PASSWORD_HASH,
                        password_kind: "text",
                        avatar_kind: AvatarKind::Identicon,
                        avatar_color: None,
                        first_is_admin: true,
                    },
                    t,
                )
                .await?,
            );
            key
        }
    };
    // Keep suspension and purge ordered with the link/profile write.
    let row = sqlx::query("UPDATE users SET suspended_at = suspended_at WHERE username=$1 AND suspended_at IS NULL AND password_hash <> '!purging' RETURNING *")
        .bind(&username).fetch_optional(&mut *tx).await?.ok_or_else(suspended)?;
    let mut user = User::from_row(&row)?;
    let changed = if !already_linked {
        sqlx::query(
            "INSERT INTO sso_links(issuer, subject, provider, username, linked_at, last_login_at)
             VALUES($1, $2, $3, $4, $5, $5) ON CONFLICT DO NOTHING",
        )
        .bind(&id.issuer)
        .bind(id.subject.as_str())
        .bind(&id.provider)
        .bind(&username)
        .bind(t)
        .execute(&mut *tx)
        .await?
    } else {
        sqlx::query(
            "UPDATE sso_links SET last_login_at=$3 WHERE issuer=$1 AND subject=$2 AND username=$4 AND (CAST($5 AS TEXT) IS NULL OR provider=$5)",
        )
        .bind(&id.issuer)
        .bind(id.subject.as_str())
        .bind(t)
        .bind(&username)
        .bind(confirmation.map(|_| id.provider.as_str()))
        .execute(&mut *tx)
        .await?
    };
    if changed.rows_affected() != 1 {
        tx.rollback().await?;
        return Ok(None);
    }
    let mut renamed = false;
    if joined.is_none()
        && let Some(name) = display
        && name != user.display_name
    {
        let taken = if name.to_lowercase() == username {
            names::three_looks(&username, &name)
                || names::capitals_pass_for_another(&mut *tx, &name, &username).await?
        } else {
            names::passes_for_another(&mut *tx, &name, &username).await?
        };
        if !taken {
            auth::update_display_name(&mut tx, &username, &name).await?;
            user.display_name = name;
            renamed = true;
        }
    }
    // The active user row and its verified link are locked until this bearer
    // commits. A subsequent purge removes the link and bearer together.
    super::groups::set_claim_groups(
        &mut tx,
        &config.group_map,
        &username,
        &id.provider,
        &id.groups,
    )
    .await?;
    let token = auth::new_token();
    sqlx::query("INSERT INTO tokens(token, username, created_at, sso_provider, sso_sid) VALUES($1,$2,$3,$4,$5)")
        .bind(secret_key(&token))
        .bind(&username)
        .bind(t)
        .bind(&id.provider)
        .bind(id.sid.as_ref().map(OidcKey::as_str))
        .execute(&mut *tx)
        .await?;
    let confirmation = if let Some((_, app)) = confirmation {
        let session_deadline = [
            state.limits.session_max_age_secs,
            state.limits.session_idle_secs,
        ]
        .into_iter()
        .filter(|limit| *limit > 0)
        .map(|limit| t.saturating_add(limit))
        .min()
        .unwrap_or(i64::MAX);
        Some(flow::issue_confirmation(&mut tx, app, &username, &token, session_deadline).await?)
    } else {
        None
    };
    tx.commit().await?;
    let created = joined.is_some();
    if let Some(joined) = joined {
        auth::announce_account(state, &user, joined).await;
    } else if renamed {
        state.hub.broadcast(WsEvent::UserUpdated {
            user: UserRef::from_user(&user),
            scope: crate::api::access::user_scope(&state.read(), &username).await,
        });
    }
    super::audit::note(
        &state.db,
        &username,
        "sso.sign_in",
        None,
        serde_json::json!({"provider":id.provider,"created":created}),
    )
    .await;
    if let Err(error) = super::groups::reconcile(state, &username).await {
        sqlx::query("DELETE FROM tokens WHERE token=$1 AND username=$2")
            .bind(secret_key(&token))
            .bind(&username)
            .execute(&state.db)
            .await?;
        return Err(error);
    }
    Ok(Some(SignIn::Session {
        user,
        created,
        confirmation,
        token,
    }))
}

/// Attach the verified identity while the ticket's originating session is still valid.
pub async fn link(
    state: &AppState,
    username: &str,
    session_key: &str,
    id: &Identity,
) -> Result<(), ApiError> {
    let mut tx = auth::begin_account_write(&state.db).await?;
    let locked = sqlx::query("UPDATE users SET suspended_at=suspended_at WHERE username=$1 AND suspended_at IS NULL AND password_hash <> '!purging'")
        .bind(username).execute(&mut *tx).await?;
    let t = now();
    let (born, used) = state.limits.session_cutoffs(t);
    let active: Option<i32> = sqlx::query_scalar("SELECT 1 FROM tokens WHERE username=$1 AND token=$2 AND created_at >= $3 AND (last_used_at >= $4 OR created_at >= $4)")
        .bind(username).bind(session_key).bind(born).bind(used).fetch_optional(&mut *tx).await?;
    if locked.rows_affected() != 1 || active.is_none() {
        return Err(super::flow::expired());
    }
    let inserted = sqlx::query("INSERT INTO sso_links(issuer,subject,provider,username,linked_at,last_login_at)
        SELECT $1,$2,$3,$4,$5,$5 WHERE NOT EXISTS (SELECT 1 FROM sso_links WHERE username=$4 AND provider=$3)
        ON CONFLICT DO NOTHING")
        .bind(&id.issuer).bind(id.subject.as_str()).bind(&id.provider).bind(username).bind(t)
        .execute(&mut *tx).await?;
    if inserted.rows_affected() == 0 {
        let owner: Option<(String, String)> = sqlx::query_as(
            "SELECT username,provider FROM sso_links WHERE issuer=$1 AND subject=$2",
        )
        .bind(&id.issuer)
        .bind(id.subject.as_str())
        .fetch_optional(&mut *tx)
        .await?;
        match owner {
            Some((actor, _)) if actor != username => {
                return Err(crate::api::bad("That sign-in belongs to another account"));
            }
            Some((_, provider)) if provider == id.provider => (),
            _ => return Err(crate::api::bad("Already linked")),
        }
    } else {
        crate::api::instance_audit::record_in(
            &mut tx,
            username,
            "sso.link",
            None,
            serde_json::json!({"provider":id.provider}),
            t,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) struct AccountLink {
    pub provider: String,
    pub linked_at: i64,
    pub can_unlink: bool,
}

pub(crate) async fn account_links<'e>(
    db: impl sqlx::Executor<'e, Database = sqlx::Any>,
    state: &AppState,
    user: &User,
) -> Result<Vec<AccountLink>, ApiError> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT provider,issuer,linked_at FROM sso_links WHERE username=$1 ORDER BY provider",
    )
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    let usable: std::collections::HashSet<&str> = rows
        .iter()
        .filter(|(id, issuer, _)| {
            state
                .sso
                .provider(id)
                .is_some_and(|p| p.config.issuer == *issuer)
        })
        .map(|(id, _, _)| id.as_str())
        .collect();
    let protected = if !has_password(user) && usable.len() == 1 {
        usable.into_iter().next().map(str::to_owned)
    } else {
        None
    };
    Ok(rows
        .into_iter()
        .map(|(provider, _, linked_at)| AccountLink {
            can_unlink: protected.as_ref() != Some(&provider),
            provider,
            linked_at,
        })
        .collect())
}

/// Serialize removals on the account so concurrent requests preserve a sign-in method.
pub async fn unlink(state: &AppState, user: &User, provider: &str) -> Result<(), ApiError> {
    let mut tx = auth::begin_account_write(&state.db).await?;
    let row = sqlx::query("UPDATE users SET suspended_at=suspended_at WHERE username=$1 AND created_at=$2 AND suspended_at IS NULL AND password_hash <> '!purging' RETURNING *")
        .bind(&user.username).bind(user.created_at).fetch_optional(&mut *tx).await?.ok_or_else(suspended)?;
    let links = account_links(&mut *tx, state, &User::from_row(&row)?).await?;
    let link = links
        .iter()
        .find(|link| link.provider == provider)
        .ok_or_else(crate::api::access::not_found)?;
    if !link.can_unlink {
        return Err(crate::api::bad("Add a password or another sign-in first"));
    }
    sqlx::query("DELETE FROM sso_links WHERE username=$1 AND provider=$2")
        .bind(&user.username)
        .bind(provider)
        .execute(&mut *tx)
        .await?;
    crate::api::instance_audit::record_in(
        &mut tx,
        &user.username,
        "sso.unlink",
        None,
        serde_json::json!({"provider":provider}),
        now(),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn set_active_in(
    tx: &mut sqlx::AnyConnection,
    username: &str,
    active: bool,
) -> sqlx::Result<bool> {
    let changed = if active {
        sqlx::query("UPDATE users SET suspended_at=NULL WHERE username=$1 AND suspended_at IS NOT NULL AND password_hash <> '!purging'").bind(username).execute(&mut *tx).await?
    } else {
        sqlx::query("UPDATE users SET suspended_at=$2 WHERE username=$1 AND suspended_at IS NULL AND password_hash <> '!purging'").bind(username).bind(now()).execute(&mut *tx).await?
    }.rows_affected() != 0;
    if changed && !active {
        sqlx::query("DELETE FROM tokens WHERE username=$1")
            .bind(username)
            .execute(tx)
            .await?;
    }
    Ok(changed)
}

pub async fn suspend(state: &AppState, username: &str) -> Result<bool, ApiError> {
    let mut tx = state.db.begin().await?;
    let changed = set_active_in(&mut tx, username, false).await?;
    tx.commit().await?;
    if changed {
        state.hub.broadcast(WsEvent::TokensRevoked {
            username: username.to_owned(),
        });
    }
    Ok(changed)
}

pub async fn unsuspend(state: &AppState, username: &str) -> Result<bool, ApiError> {
    let mut tx = state.db.begin().await?;
    let changed = set_active_in(&mut tx, username, true).await?;
    tx.commit().await?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{auth, test_util::each_db, user_for_token};
    use axum::{Json, extract::State, http::StatusCode};
    use serde_json::json;
    pub(super) async fn account(state: &AppState, name: &str) -> String {
        auth::register(
            State(state.clone()),
            Json(
                serde_json::from_value(
                    json!({"username":name,"password":"test","avatar_kind":"identicon"}),
                )
                .unwrap(),
            ),
        )
        .await
        .unwrap()
        .0
        .token
    }
    async fn login(
        state: &AppState,
        password: &str,
        at: i64,
    ) -> Result<Json<auth::AuthResp>, ApiError> {
        auth::login_at(
            state,
            serde_json::from_value(json!({"username":"alice","password":password})).unwrap(),
            at,
        )
        .await
    }
    #[tokio::test]
    async fn suspension_ends_sessions_and_refuses_sign_in() {
        for (state, db) in each_db("suspend_sessions").await {
            let first = account(&state, "alice").await;
            let other = account(&state, "bob").await;
            let t = now();
            let second = login(&state, "test", t).await.unwrap().0.token;
            let mut events = state.hub.subscribe();
            let (first_change, concurrent_change) =
                tokio::join!(suspend(&state, "alice"), suspend(&state, "alice"));
            assert_ne!(first_change.unwrap(), concurrent_change.unwrap());
            assert!(!suspend(&state, "alice").await.unwrap());
            assert!(
                matches!(events.try_recv(),Ok(WsEvent::TokensRevoked{username}) if username=="alice")
            );
            assert!(events.try_recv().is_err());
            for token in [&first, &second] {
                assert!(user_for_token(&state, token).await.unwrap().is_none());
            }
            assert!(user_for_token(&state, &other).await.unwrap().is_some());
            assert!(
                matches!(login(&state,"test",t+4).await,Err(ApiError(StatusCode::UNAUTHORIZED,s,_)) if s=="Invalid credentials")
            );
            assert!(unsuspend(&state, "alice").await.unwrap());
            assert!(!unsuspend(&state, "alice").await.unwrap());
            assert!(login(&state, "test", t + 8).await.is_ok());
            assert!(user_for_token(&state, &first).await.unwrap().is_none());
            db.done(state).await;
        }
    }
    #[tokio::test]
    async fn passwordless_accounts_never_verify() {
        for (state, db) in each_db("passwordless_signin").await {
            account(&state, "alice").await;
            sqlx::query("UPDATE users SET password_hash = $1 WHERE username = 'alice'")
                .bind(crate::db::NO_PASSWORD_HASH)
                .execute(&state.db)
                .await
                .unwrap();
            let t = now();
            for (i, secret) in ["!sso", "", "test"].iter().enumerate() {
                assert!(
                    matches!(login(&state,secret,t+i as i64*4).await,Err(ApiError(StatusCode::UNAUTHORIZED,s,_)) if s=="Invalid credentials")
                );
            }
            db.done(state).await;
        }
    }
}

#[cfg(test)]
#[path = "accounts/tests.rs"]
mod sign_in_tests;
