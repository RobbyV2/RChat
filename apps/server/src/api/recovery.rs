use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::api::access::not_found;
use crate::api::auth::{
    AuthResp, Secret, hash_password, me_payload, new_token, secret_from, throttle_attempt,
};
use crate::api::reauth::{
    AuthedSession, NONCE_TTL_SECS, Purpose, RECOVER, ReAuth, ReAuthBody, Session, check_at,
    issue_nonce, phrase_sig_ok, take_nonce,
};
use crate::api::{ApiError, ApiErrorBody, NAME_MAX, Settings, bad, check_len, unauthorized};
use crate::db::{User, get_user, now, secret_key};
use crate::state::AppState;
use crate::ws::WsEvent;

/// The account a recovery challenge is for.
#[derive(Deserialize, ToSchema)]
pub struct ChallengeReq {
    /// 1 to 100 characters, case-insensitive. It does not have to exist.
    #[schema(example = "alice")]
    username: String,
}

/// A single-use challenge to sign with a backup phrase.
#[derive(Serialize, ToSchema)]
pub struct Challenge {
    /// 32 random bytes as base64url without padding (43 characters).
    nonce: String,
    /// The lowercase username. Signatures cover this form.
    #[schema(example = "alice")]
    username: String,
    /// When the nonce stops working, 300 seconds after it was issued.
    expires_at: i64,
}

/// Get a recovery challenge
///
/// Issues a nonce to sign with a backup phrase. It works once, for this username only, for 300
/// seconds. The answer looks the same whether or not the account exists or has a backup phrase.
/// Sign these bytes with the account key of the phrase (Ed25519): `rchat-recovery1`, a zero
/// byte, the purpose, a zero byte, the returned `username`, a zero byte, the nonce, a zero byte
/// and the context. Send the signature as base64url without padding. No authentication. Strict
/// and general rate-limit buckets.
#[utoipa::path(post, path = "/api/v1/auth/recovery/challenge", tag = "Auth", request_body = ChallengeReq, responses((status = 200, description = "A new nonce for this username, valid once until `expires_at`", body = Challenge), (status = 400, description = "Blank, too long (over 100 characters) or NUL-containing username. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the strict or general bucket", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn challenge(
    State(state): State<AppState>,
    Json(req): Json<ChallengeReq>,
) -> Result<Json<Challenge>, ApiError> {
    challenge_at(&state, req, now()).await
}

async fn challenge_at(
    state: &AppState,
    req: ChallengeReq,
    t: i64,
) -> Result<Json<Challenge>, ApiError> {
    let ChallengeReq { username } = req;
    if username.trim().is_empty() || username.contains('\0') {
        return Err(bad("Username required"));
    }
    check_len(&username, NAME_MAX, "Username")?;
    let username = username.to_lowercase();
    let nonce = issue_nonce(&state.db, &username, t).await?;
    Ok(Json(Challenge {
        nonce,
        username,
        expires_at: t + NONCE_TTL_SECS,
    }))
}

/// A recovery sign-in: a backup phrase signature over a fresh challenge, and a new password.
#[derive(Deserialize, ToSchema)]
pub struct RecoverReq {
    /// The username the challenge was issued for, case-insensitive.
    #[schema(example = "alice")]
    pub username: String,
    /// The nonce from `POST /api/v1/auth/recovery/challenge` for this username.
    pub nonce: String,
    /// The Ed25519 signature by the account key of the backup phrase over the challenge, with
    /// purpose `recover` and an empty context, as base64url without padding (86 characters).
    pub sig: String,
    /// The new password or words, with the rules of registration.
    pub new: Secret,
}

const NO_PHRASE: &str = "oXJCZk2tDDQf5yZ1GJ1xwFPccKmoe_Y-41erQ5o9Azw";

fn wrong_phrase() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        "Wrong username or backup phrase".to_string(),
    )
}

/// Sign in with a backup phrase
///
/// Proves the account's backup phrase with a signature over a challenge from
/// `POST /api/v1/auth/recovery/challenge` (purpose `recover`, empty context), replaces the password
/// or words, and returns a new session token. Every other session of the account is revoked and
/// its WebSocket connections close. The backup phrase stays set. An unknown account, one without
/// a backup phrase, a used, expired or foreign nonce and a wrong signature all answer the same
/// 401. Recovery and login share each username's pace: one attempt every 3 seconds and at most
/// 1000 a UTC day. An invalid new password answers 400 and leaves the nonce unused. No
/// authentication. Strict and general rate-limit buckets.
#[utoipa::path(post, path = "/api/v1/auth/recovery", tag = "Auth", request_body = RecoverReq, responses((status = 200, description = "Recovered: the password is replaced, every other session of the account is revoked and its live connections close, and the new session token is returned. The backup phrase stays set", body = AuthResp), (status = 400, description = "Empty new password, new words that are not 7 words from the word set, or not exactly one of `password` and `words` in `new`; the nonce stays unused. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "`Wrong username or backup phrase`: an unknown account, one without a backup phrase, a used, expired or foreign nonce, or a wrong signature. The nonce is used up", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 423, description = "Over 1000 login and recovery attempts for this username today (UTC); locked until the next day", body = ApiErrorBody), (status = 429, description = "Less than 3 seconds since the last login or recovery attempt for this username (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket (plain text)", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(()))]
pub(crate) async fn recover(
    State(state): State<AppState>,
    Json(req): Json<RecoverReq>,
) -> Result<Json<AuthResp>, ApiError> {
    recover_at(&state, req, now()).await
}

pub(crate) async fn recover_at(
    state: &AppState,
    req: RecoverReq,
    t: i64,
) -> Result<Json<AuthResp>, ApiError> {
    let RecoverReq {
        username,
        nonce,
        sig,
        new: Secret { password, words },
    } = req;
    if username.contains('\0') || username.chars().count() > NAME_MAX {
        return Err(wrong_phrase());
    }
    let key = username.to_lowercase();
    let db = &state.db;
    throttle_attempt(db, &key, t).await?;
    if password.as_deref() == Some("") {
        return Err(bad("Password required"));
    }
    let (secret, password_kind) = secret_from(&key, password, words, true)?;
    let fresh = take_nonce(db, &key, &nonce, t).await?;
    let user = get_user(db, &key).await?;
    let phrase = user.as_ref().and_then(|user| user.recovery_pub.as_deref());
    let signed =
        fresh && phrase_sig_ok(phrase.unwrap_or(NO_PHRASE), RECOVER, &key, &nonce, "", &sig);
    let user = match (signed && phrase.is_some(), user) {
        (true, Some(user)) => user,
        (_, _) => return Err(wrong_phrase()),
    };
    let password_hash = hash_password(&secret).await?;
    let token = new_token();
    let mut tx = db.begin().await?;
    let changed = sqlx::query(
        "UPDATE users SET password_hash = $1, password_kind = $2 WHERE username = $3 AND password_hash = $4 AND recovery_pub = $5",
    )
    .bind(&password_hash)
    .bind(password_kind)
    .bind(&key)
    .bind(&user.password_hash)
    .bind(&user.recovery_pub)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed != 1 {
        return Err(wrong_phrase());
    }
    sqlx::query("DELETE FROM tokens WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, $3)")
        .bind(secret_key(&token))
        .bind(&key)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .hub
        .broadcast(WsEvent::TokensRevoked { username: key });
    let user = User {
        password_hash,
        password_kind: password_kind.to_string(),
        ..user
    };
    let me = me_payload(db, &user).await?;
    Ok(Json(AuthResp { token, user: me }))
}

/// Whether the account has a backup phrase. The key itself is never returned.
#[derive(Serialize, ToSchema)]
pub struct RecoveryStatus {
    /// A backup phrase is set.
    pub set: bool,
    /// When it was set; null when none is set.
    pub set_at: Option<i64>,
    /// Whether this session may set a phrase with `fresh_session` alone. Always false: setting
    /// a phrase, the first one included, needs the password or words.
    pub fresh_session: bool,
}

/// A new backup phrase for the account.
#[derive(Deserialize, ToSchema)]
pub struct RecoverySet {
    /// The account key of the new phrase: an Ed25519 public key as base64url without padding
    /// (43 characters).
    #[schema(example = "IOGfm4VeaU9qsds79702OGowi43niF7E3YP1w8Qi4qM")]
    pub key: String,
    /// How you confirm it: the password or words, or a `phrase` proof by the current phrase with
    /// purpose `set` and the new `key` as context. `fresh_session` is refused.
    pub reauth: ReAuthBody,
}

/// Removing the account's backup phrase.
#[derive(Deserialize, ToSchema)]
pub struct RecoveryRemove {
    /// How you confirm it: the password or words, or a `phrase` proof with purpose `remove` and
    /// an empty context.
    pub reauth: ReAuthBody,
}

const BAD_KEY: &str = "key must be a base64url Ed25519 public key";

pub(crate) fn status_of(user: &User) -> RecoveryStatus {
    let set = user.recovery_pub.is_some();
    RecoveryStatus {
        set,
        set_at: user.recovery_set_at.filter(|_| set),
        fresh_session: false,
    }
}

async fn holds(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    username: &str,
    token: &str,
) -> Result<bool, ApiError> {
    Ok(
        sqlx::query("SELECT username FROM tokens WHERE token = $1 AND username = $2")
            .bind(secret_key(token))
            .bind(username)
            .fetch_optional(&mut **tx)
            .await?
            .is_some(),
    )
}

/// Get the backup phrase status
///
/// Whether the account has a backup phrase and since when. The key is never returned. Works while
/// the `backup_phrase` switch of `GET /api/v1/settings` is off. Requires a bearer token; guests
/// can't call it. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/me/recovery", tag = "Account", responses((status = 200, description = "Whether a backup phrase is set and since when; `fresh_session` is always false", body = RecoveryStatus), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn status(AuthedSession(session): AuthedSession) -> Json<RecoveryStatus> {
    Json(status_of(&session.user))
}

/// Set or reset the backup phrase
///
/// Stores the account key of a new backup phrase, replacing any earlier one. The phrase itself
/// never reaches the server. Confirm with the password or words, the first phrase included, or with
/// a `phrase` proof by the current phrase (purpose `set`, context the new `key`) over a challenge
/// from `POST /api/v1/auth/recovery/challenge`; `fresh_session` is refused. Every other session of
/// the account is revoked and its WebSocket connections close; this one stays. Password and phrase
/// tries share the pace of password changes: one every 3 seconds per session, and 50 wrong ones a
/// UTC day. Answers 404 while the `backup_phrase` switch of `GET /api/v1/settings` is off. Requires
/// a bearer token. Strict and general rate-limit buckets.
#[utoipa::path(put, path = "/api/v1/me/recovery", tag = "Account", request_body = RecoverySet, responses((status = 200, description = "The new phrase is set. Every other session of the account is revoked and its live connections close", body = RecoveryStatus), (status = 400, description = "`key must be a base64url Ed25519 public key`, or not exactly one way to confirm in `reauth`. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "Missing, unknown or just revoked bearer token (`Unauthorized`), `Wrong password`, `Wrong backup phrase` (no phrase set, a used, expired or foreign nonce, or a wrong signature), or `Confirm with your password` (`fresh_session`)", body = ApiErrorBody), (status = 404, description = "`Not found`: the `backup_phrase` switch is off", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 423, description = "Changes from this session locked for the day (UTC) after 50 wrong passwords or phrases", body = ApiErrorBody), (status = 429, description = "Less than 3 seconds since this session's last try (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket (plain text)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn set_phrase(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Json(req): Json<RecoverySet>,
) -> Result<Json<RecoveryStatus>, ApiError> {
    set_phrase_at(&state, session, req, now()).await
}

pub(crate) async fn set_phrase_at(
    state: &AppState,
    session: Session,
    req: RecoverySet,
    t: i64,
) -> Result<Json<RecoveryStatus>, ApiError> {
    let RecoverySet { key, reauth } = req;
    if !Settings::cached(&state.db).await.backup_phrase {
        return Err(not_found());
    }
    if crate::identity::p2p_key(&key).is_none() {
        return Err(bad(BAD_KEY));
    }
    let reauth = ReAuth::try_from(reauth)?;
    let purpose = Purpose::SetPhrase { key: key.clone() };
    check_at(state, &session, reauth, purpose, t).await?;
    let Session {
        user,
        token,
        created_at: _,
    } = session;
    let mut tx = state.db.begin().await?;
    let stored =
        sqlx::query("UPDATE users SET recovery_pub = $1, recovery_set_at = $2 WHERE username = $3")
            .bind(&key)
            .bind(t)
            .bind(&user.username)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if stored != 1 || !holds(&mut tx, &user.username, &token).await? {
        return Err(unauthorized());
    }
    sqlx::query("DELETE FROM tokens WHERE username = $1 AND token <> $2")
        .bind(&user.username)
        .bind(secret_key(&token))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::TokensRevoked {
        username: user.username,
    });
    Ok(Json(RecoveryStatus {
        set: true,
        set_at: Some(t),
        fresh_session: false,
    }))
}

/// Remove the backup phrase
///
/// Clears the account's backup phrase, so it no longer signs in or confirms anything. Confirm
/// with the password or words, or a `phrase` proof by the current phrase (purpose `remove`,
/// empty context) over a challenge from `POST /api/v1/auth/recovery/challenge`; `fresh_session` is
/// refused. Other sessions stay signed in. Password and phrase tries share the pace of password
/// changes. Works while the `backup_phrase` switch of `GET /api/v1/settings` is off. Requires a
/// bearer token. Strict and general rate-limit buckets.
#[utoipa::path(delete, path = "/api/v1/me/recovery", tag = "Account", request_body = RecoveryRemove, responses((status = 200, description = "No backup phrase is set now", body = RecoveryStatus), (status = 400, description = "Not exactly one way to confirm in `reauth`. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "Missing, unknown or just revoked bearer token (`Unauthorized`), `Wrong password`, `Wrong backup phrase`, or `Confirm with your password` (`fresh_session`)", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 423, description = "Changes from this session locked for the day (UTC) after 50 wrong passwords or phrases", body = ApiErrorBody), (status = 429, description = "Less than 3 seconds since this session's last try (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket (plain text)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn remove_phrase(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Json(req): Json<RecoveryRemove>,
) -> Result<Json<RecoveryStatus>, ApiError> {
    remove_phrase_at(&state, session, req, now()).await
}

pub(crate) async fn remove_phrase_at(
    state: &AppState,
    session: Session,
    req: RecoveryRemove,
    t: i64,
) -> Result<Json<RecoveryStatus>, ApiError> {
    let RecoveryRemove { reauth } = req;
    let reauth = ReAuth::try_from(reauth)?;
    check_at(state, &session, reauth, Purpose::RemovePhrase, t).await?;
    let Session {
        user,
        token,
        created_at: _,
    } = session;
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET recovery_pub = NULL, recovery_set_at = NULL WHERE username = $1")
        .bind(&user.username)
        .execute(&mut *tx)
        .await?;
    if !holds(&mut tx, &user.username, &token).await? {
        return Err(unauthorized());
    }
    tx.commit().await?;
    Ok(Json(RecoveryStatus {
        set: false,
        set_at: None,
        fresh_session: false,
    }))
}

#[cfg(test)]
mod tests {
    use axum::Json;
    use axum::http::StatusCode;
    use serde_json::json;
    use sqlx::Row;

    use super::*;
    use crate::api::auth::{WordsResp, login_at, session_key, verify_password};
    use crate::api::reauth::{
        NONCE_TTL_SECS, Purpose, ReAuth, Session, check_at, phrase_checks, take_nonce,
    };
    use crate::api::session_for_token;
    use crate::api::test_util::{
        PHRASE_KEY as KEY, done, pg_done, pg_state, phrase_sign, temp_state, test_grant,
    };
    use crate::db::{get_user, secret_key};
    use crate::ws::WsEvent;

    const T: i64 = 20_000 * 86400 + 3600;

    fn req(username: &str) -> ChallengeReq {
        ChallengeReq {
            username: username.to_string(),
        }
    }

    async fn rows(state: &AppState) -> i64 {
        sqlx::query("SELECT COUNT(*) FROM recovery_challenges")
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value")
    }

    #[tokio::test]
    async fn challenges_look_the_same_for_any_account() {
        let (state, path) = temp_state("recovery_challenge").await;
        for (name, key) in [("alice", Some(KEY)), ("bob", None)] {
            sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at, recovery_pub) VALUES($1, $1, 'x', 'text', 'identicon', 1, $2)")
                .bind(name)
                .bind(key)
                .execute(&state.db)
                .await
                .expect("user");
        }
        let mut nonces = Vec::new();
        for name in ["alice", "Bob", "nobody"] {
            let Json(challenge) = challenge_at(&state, req(name), T).await.expect(name);
            let shape = serde_json::to_value(&challenge).expect("json");
            let mut keys: Vec<&String> = shape.as_object().expect("object").keys().collect();
            keys.sort();
            assert_eq!(keys, ["expires_at", "nonce", "username"], "{name}");
            let Challenge {
                nonce,
                username,
                expires_at,
            } = challenge;
            assert_eq!(nonce.len(), 43, "{name}");
            assert!(
                nonce
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
                "{nonce}"
            );
            assert_eq!(expires_at, T + 300);
            assert_eq!(expires_at, T + NONCE_TTL_SECS);
            assert_eq!(username, name.to_lowercase());
            nonces.push((username, nonce));
        }
        assert_eq!(rows(&state).await, 3, "a row for every name");
        for (username, nonce) in &nonces {
            assert!(
                take_nonce(&state.db, username, nonce, T)
                    .await
                    .expect("take"),
                "{username}"
            );
        }
        let longest = "a".repeat(100);
        let Json(longest) = challenge_at(&state, req(&longest), T)
            .await
            .expect("100 characters");
        assert_eq!(longest.username.len(), 100);
        for name in ["a".repeat(101), String::new(), "  ".to_string()] {
            let ApiError(code, _) = challenge_at(&state, req(&name), T)
                .await
                .err()
                .expect("refused");
            assert_eq!(code, StatusCode::BAD_REQUEST, "{name:?}");
        }
        assert_eq!(rows(&state).await, 1);
        done(state, path).await;
    }

    async fn nul_bytes_are_refused(state: &AppState) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at, recovery_pub) VALUES('alice', 'alice', 'x', 'text', 'identicon', 1, $1)")
            .bind(KEY)
            .execute(&state.db)
            .await
            .expect("user");
        let ApiError(code, msg) = challenge_at(state, req("ali\0ce"), T)
            .await
            .err()
            .expect("refused");
        assert_eq!(
            (code, msg.as_str()),
            (StatusCode::BAD_REQUEST, "Username required")
        );
        assert_eq!(rows(state).await, 0);
        let Json(Challenge { nonce, .. }) = challenge_at(state, req("alice"), T)
            .await
            .expect("challenge");
        let nul = format!("{}\0", "A".repeat(42));
        assert!(
            !take_nonce(&state.db, "ali\0ce", &nonce, T)
                .await
                .expect("take")
        );
        assert!(!take_nonce(&state.db, "alice", &nul, T).await.expect("take"));
        let user = get_user(&state.db, "alice")
            .await
            .expect("load")
            .expect("alice");
        let session = Session {
            user,
            token: "tok-alice".to_string(),
            created_at: T,
        };
        let proof = ReAuth::Phrase {
            nonce: nul,
            sig: "A".repeat(86),
        };
        let ApiError(code, msg) = check_at(state, &session, proof, Purpose::RemovePhrase, T)
            .await
            .expect_err("refused");
        assert_eq!(
            (code, msg.as_str()),
            (StatusCode::UNAUTHORIZED, "Wrong backup phrase")
        );
        let failures: i64 = sqlx::query("SELECT failures FROM change_attempts WHERE session = $1")
            .bind(session_key("tok-alice"))
            .fetch_one(&state.db)
            .await
            .expect("counted")
            .try_get(0)
            .expect("failures");
        assert_eq!(failures, 1);
        assert!(
            take_nonce(&state.db, "alice", &nonce, T)
                .await
                .expect("take")
        );
    }

    #[tokio::test]
    async fn a_nul_byte_is_refused_on_both_databases() {
        let (state, path) = temp_state("recovery_nul").await;
        nul_bytes_are_refused(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("recovery_nul").await {
            nul_bytes_are_refused(&state).await;
            pg_done(state, pg).await;
        }
    }

    const WRONG: &str = "Wrong username or backup phrase";

    fn sign(purpose: &str, username: &str, nonce: &str) -> String {
        phrase_sign(purpose, username, nonce, "")
    }

    fn secret(value: serde_json::Value) -> Secret {
        serde_json::from_value(value).expect("secret")
    }

    fn text(password: &str) -> Secret {
        secret(json!({ "password": password }))
    }

    async fn add_user(state: &AppState, name: &str, password: &str, key: Option<&str>) {
        let hash = hash_password(password).await.expect("hash");
        add_hashed(state, name, &hash, key).await;
    }

    async fn add_hashed(state: &AppState, name: &str, hash: &str, key: Option<&str>) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at, recovery_pub, recovery_set_at) VALUES($1, $1, $2, 'text', 'identicon', 1, $3, $4)")
            .bind(name)
            .bind(hash)
            .bind(key)
            .bind(key.map(|_| 2i64))
            .execute(&state.db)
            .await
            .expect("insert user");
    }

    async fn add_token(state: &AppState, name: &str, token: &str) {
        sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, 5)")
            .bind(secret_key(token))
            .bind(name)
            .execute(&state.db)
            .await
            .expect("insert token");
    }

    async fn tokens_of(state: &AppState, name: &str) -> Vec<String> {
        let rows = sqlx::query("SELECT token FROM tokens WHERE username = $1 ORDER BY token")
            .bind(name)
            .fetch_all(&state.db)
            .await
            .expect("tokens");
        rows.iter().map(|r| r.try_get(0).expect("token")).collect()
    }

    async fn nonce_for(state: &AppState, name: &str, t: i64) -> String {
        let Json(Challenge { nonce, .. }) =
            challenge_at(state, req(name), t).await.expect("challenge");
        nonce
    }

    fn recovery(username: &str, nonce: &str, sig: &str, new: Secret) -> RecoverReq {
        RecoverReq {
            username: username.to_string(),
            nonce: nonce.to_string(),
            sig: sig.to_string(),
            new,
        }
    }

    async fn login_with(
        state: &AppState,
        name: &str,
        secret: serde_json::Value,
        t: i64,
    ) -> Result<Json<AuthResp>, ApiError> {
        let mut body = secret;
        body["username"] = serde_json::Value::from(name);
        login_at(state, serde_json::from_value(body).expect("login"), t).await
    }

    fn refusal(result: Result<Json<AuthResp>, ApiError>) -> (StatusCode, String) {
        let ApiError(code, msg) = result.err().expect("refused");
        (code, msg)
    }

    fn wrong() -> (StatusCode, String) {
        (StatusCode::UNAUTHORIZED, WRONG.to_string())
    }

    fn revoked(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
        let mut names = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let WsEvent::TokensRevoked { username } = event {
                names.push(username);
            }
        }
        names
    }

    #[tokio::test]
    async fn recovery_signs_in_and_ends_every_old_session() {
        let (state, path) = temp_state("recovery_sign_in").await;
        add_user(&state, "alice", "old pass", Some(KEY)).await;
        add_user(&state, "bob", "bob pass", Some(KEY)).await;
        add_token(&state, "alice", "thief").await;
        add_token(&state, "alice", "laptop").await;
        add_token(&state, "bob", "bob-phone").await;
        let mut rx = state.hub.subscribe();
        let nonce = nonce_for(&state, "Alice", T).await;
        let sig = sign(RECOVER, "alice", &nonce);
        let Json(AuthResp { token, user }) =
            recover_at(&state, recovery("Alice", &nonce, &sig, text("new pass")), T)
                .await
                .expect("recovered");
        assert_eq!(token.len(), 64);
        assert_eq!(user.username, "alice");
        assert_eq!(user.password_kind, "text");
        assert_eq!(tokens_of(&state, "alice").await, vec![secret_key(&token)]);
        assert_eq!(
            tokens_of(&state, "bob").await,
            vec![secret_key("bob-phone")]
        );
        for old in ["thief", "laptop"] {
            assert!(
                session_for_token(&state, old)
                    .await
                    .expect("lookup")
                    .is_none(),
                "{old}"
            );
        }
        let (me, created_at) = session_for_token(&state, &token)
            .await
            .expect("lookup")
            .expect("new session");
        assert_eq!((me.username.as_str(), created_at), ("alice", T));
        assert_eq!(revoked(&mut rx), ["alice"]);
        assert_eq!(me.recovery_pub.as_deref(), Some(KEY));
        assert_eq!(me.recovery_set_at, Some(2));
        assert_eq!(
            refusal(login_with(&state, "alice", json!({"password": "old pass"}), T + 3).await),
            (StatusCode::UNAUTHORIZED, "Invalid credentials".to_string())
        );
        let Json(AuthResp { token: second, .. }) =
            login_with(&state, "alice", json!({"password": "new pass"}), T + 6)
                .await
                .expect("new password");
        let replay = recover_at(
            &state,
            recovery("Alice", &nonce, &sig, text("thief pass")),
            T + 9,
        )
        .await;
        assert_eq!(refusal(replay), wrong());
        let mut both = vec![secret_key(&token), secret_key(&second)];
        both.sort();
        assert_eq!(tokens_of(&state, "alice").await, both);
        assert!(revoked(&mut rx).is_empty());
        done(state, path).await;
    }

    async fn failures_look_the_same(state: &AppState) {
        add_user(state, "alice", "a", Some(KEY)).await;
        add_user(state, "bob", "b", None).await;
        add_token(state, "alice", "laptop").await;
        let hash = get_user(&state.db, "alice")
            .await
            .expect("load")
            .expect("alice")
            .password_hash;
        let mut rx = state.hub.subscribe();
        let longest = test_grant("longest").repeat(2)[..100].to_string();
        let mut tries = Vec::new();
        for (case, name, signer, purpose, odd_sig) in [
            ("unknown user", "nobody", "nobody", RECOVER, None),
            (
                "longest unknown name",
                longest.as_str(),
                longest.as_str(),
                RECOVER,
                None,
            ),
            ("no key", "bob", "bob", RECOVER, None),
            ("wrong purpose", "alice", "alice", "remove", None),
            ("other name signed", "alice", "bob", RECOVER, None),
            (
                "malformed sig",
                "alice",
                "alice",
                RECOVER,
                Some("not-base64".to_string()),
            ),
            ("zero sig", "alice", "alice", RECOVER, Some("A".repeat(86))),
            (
                "padded sig",
                "alice",
                "alice",
                RECOVER,
                Some("=".repeat(88)),
            ),
        ] {
            let nonce = nonce_for(state, name, T).await;
            let sig = odd_sig.unwrap_or_else(|| sign(purpose, signer, &nonce));
            tries.push((case, recovery(name, &nonce, &sig, text("x")), T, 1));
        }
        let foreign = nonce_for(state, "mallory", T).await;
        let sig = sign(RECOVER, "alice", &foreign);
        tries.push((
            "nonce of another name",
            recovery("alice", &foreign, &sig, text("x")),
            T,
            0,
        ));
        let made_up = "A".repeat(43);
        let sig = sign(RECOVER, "alice", &made_up);
        tries.push((
            "made-up nonce",
            recovery("alice", &made_up, &sig, text("x")),
            T,
            0,
        ));
        for (case, len) in [
            ("101 characters", 101),
            ("2816 characters", 2816),
            ("12800 characters", 12800),
        ] {
            let hex: String = (0..len / 64 + 1)
                .map(|i| test_grant(&i.to_string()))
                .collect();
            let name = &hex[..len];
            let sig = sign(RECOVER, name, &made_up);
            tries.push((case, recovery(name, &made_up, &sig, text("x")), T, 0));
        }
        let nonce = nonce_for(state, "alice", T).await;
        let sig = sign(RECOVER, "alice", &nonce);
        tries.push((
            "nul in name",
            recovery("ali\0ce", &nonce, &sig, text("x")),
            T,
            0,
        ));
        tries.push((
            "expired",
            recovery("alice", &nonce, &sig, text("x")),
            T + 301,
            0,
        ));
        let mut answers = Vec::new();
        for (n, (case, attempt, at, checks)) in (0i64..).zip(tries) {
            let before = phrase_checks();
            let ApiError(code, msg) = recover_at(state, attempt, at + 3 * n)
                .await
                .err()
                .expect(case);
            answers.push((case, (code, msg), phrase_checks() - before, checks));
        }
        for (case, answer, checked, checks) in answers {
            assert_eq!(answer, wrong(), "{case}");
            assert_eq!(checked, checks, "{case}: signature checks");
        }
        let long_keys: i64 =
            sqlx::query("SELECT COUNT(*) FROM login_attempts WHERE LENGTH(username) > 100")
                .fetch_one(&state.db)
                .await
                .expect("count")
                .try_get(0)
                .expect("count value");
        assert_eq!(long_keys, 0, "names over 100 characters are not paced");
        let longest_paced: i64 =
            sqlx::query("SELECT COUNT(*) FROM login_attempts WHERE username = $1")
                .bind(&longest)
                .fetch_one(&state.db)
                .await
                .expect("count")
                .try_get(0)
                .expect("count value");
        assert_eq!(longest_paced, 1);
        let user = get_user(&state.db, "alice")
            .await
            .expect("load")
            .expect("alice");
        assert_eq!(user.password_hash, hash);
        assert_eq!(tokens_of(state, "alice").await, vec![secret_key("laptop")]);
        assert!(revoked(&mut rx).is_empty());
    }

    #[tokio::test]
    async fn every_failure_looks_the_same() {
        let (state, path) = temp_state("recovery_uniform").await;
        failures_look_the_same(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("recovery_uniform").await {
            failures_look_the_same(&state).await;
            pg_done(state, pg).await;
        }
    }

    #[tokio::test]
    async fn recovery_and_login_share_the_pace() {
        let (state, path) = temp_state("recovery_pace").await;
        add_user(&state, "alice", "a", Some(KEY)).await;
        let nonce = nonce_for(&state, "alice", T).await;
        let sig = sign(RECOVER, "alice", &nonce);
        let _ = recover_at(&state, recovery("ALICE", &nonce, &sig, text("b")), T)
            .await
            .expect("recovered");
        let wait = (
            StatusCode::TOO_MANY_REQUESTS,
            "Wait 3 seconds between attempts".to_string(),
        );
        assert_eq!(
            refusal(login_with(&state, "Alice", json!({"password": "b"}), T + 1).await),
            wait
        );
        let _ = login_with(&state, "alice", json!({"password": "b"}), T + 4)
            .await
            .expect("login");
        let nonce = nonce_for(&state, "alice", T + 5).await;
        let sig = sign(RECOVER, "alice", &nonce);
        let early = recover_at(&state, recovery("alice", &nonce, &sig, text("c")), T + 5).await;
        assert_eq!(refusal(early), wait);
        let _ = recover_at(&state, recovery("alice", &nonce, &sig, text("c")), T + 7)
            .await
            .expect("the nonce was not used");
        sqlx::query("UPDATE login_attempts SET count = 1000 WHERE username = 'alice'")
            .execute(&state.db)
            .await
            .expect("prime the day");
        let nonce = nonce_for(&state, "alice", T + 10).await;
        let sig = sign(RECOVER, "alice", &nonce);
        let locked = recover_at(&state, recovery("alice", &nonce, &sig, text("d")), T + 10).await;
        assert_eq!(
            refusal(locked),
            (StatusCode::LOCKED, "Account locked for the day".to_string())
        );
        let count: i64 = sqlx::query("SELECT count FROM login_attempts WHERE username = 'alice'")
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value");
        assert_eq!(count, 1001);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_bad_new_password_keeps_the_nonce() {
        let (state, path) = temp_state("recovery_bad_new").await;
        add_user(&state, "alice", "a", Some(KEY)).await;
        add_token(&state, "alice", "laptop").await;
        let nonce = nonce_for(&state, "alice", T).await;
        let sig = sign(RECOVER, "alice", &nonce);
        let Json(WordsResp { words }) =
            crate::api::auth::words(axum::extract::Path("alice".to_string())).await;
        let mut t = T;
        for (new, msg) in [
            (text(""), "Password required"),
            (
                secret(json!({})),
                "Provide exactly one of password or words",
            ),
            (
                secret(json!({"password": "x", "words": words[..7]})),
                "Provide exactly one of password or words",
            ),
            (
                secret(json!({"words": words[..6]})),
                "Pick 7 words from your word set",
            ),
            (
                secret(json!({"words": ["definitelynotaword", "a", "b", "c", "d", "e", "f"]})),
                "Pick 7 words from your word set",
            ),
        ] {
            let res = recover_at(&state, recovery("alice", &nonce, &sig, new), t).await;
            assert_eq!(refusal(res), (StatusCode::BAD_REQUEST, msg.to_string()));
            t += 3;
        }
        assert_eq!(tokens_of(&state, "alice").await, vec![secret_key("laptop")]);
        let _ = recover_at(&state, recovery("alice", &nonce, &sig, text("good")), t)
            .await
            .expect("the nonce still works");
        assert_eq!(tokens_of(&state, "alice").await.len(), 1);
        assert!(
            !tokens_of(&state, "alice")
                .await
                .contains(&secret_key("laptop"))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn word_passwords_can_be_set_by_recovery() {
        let (state, path) = temp_state("recovery_words").await;
        add_user(&state, "alice", "a", Some(KEY)).await;
        let Json(WordsResp { words }) =
            crate::api::auth::words(axum::extract::Path("alice".to_string())).await;
        let seven: Vec<String> = words[2..9].iter().map(|w| w.to_uppercase()).collect();
        let nonce = nonce_for(&state, "alice", T).await;
        let sig = sign(RECOVER, "alice", &nonce);
        let Json(AuthResp { user, .. }) = recover_at(
            &state,
            recovery("alice", &nonce, &sig, secret(json!({"words": seven}))),
            T,
        )
        .await
        .expect("recovered");
        assert_eq!(user.password_kind, "words");
        let stored = get_user(&state.db, "alice")
            .await
            .expect("load")
            .expect("alice");
        assert_eq!(stored.password_kind, "words");
        assert!(verify_password(&words[2..9].join(" "), &stored.password_hash).await);
        let _ = login_with(&state, "alice", json!({"words": seven}), T + 3)
            .await
            .expect("login with the words");
        assert_eq!(
            refusal(login_with(&state, "alice", json!({"password": "a"}), T + 6).await),
            (StatusCode::UNAUTHORIZED, "Invalid credentials".to_string())
        );
        done(state, path).await;
    }

    async fn one_of_two_racing_recoveries_wins(state: &AppState) {
        add_user(state, "alice", "a", Some(KEY)).await;
        let tomorrow = T + 86400;
        let first = nonce_for(state, "alice", T).await;
        let second = nonce_for(state, "alice", tomorrow - 10).await;
        let (a, b) = tokio::join!(
            recover_at(
                state,
                recovery("alice", &first, &sign(RECOVER, "alice", &first), text("p1")),
                T,
            ),
            recover_at(
                state,
                recovery(
                    "alice",
                    &second,
                    &sign(RECOVER, "alice", &second),
                    text("p2")
                ),
                tomorrow,
            ),
        );
        let (winner, password, loser) = match (a, b) {
            (Ok(Json(won)), Err(lost)) => (won, "p1", lost),
            (Err(lost), Ok(Json(won))) => (won, "p2", lost),
            (_, _) => panic!("exactly one recovery wins"),
        };
        let ApiError(code, msg) = loser;
        assert_eq!((code, msg), wrong());
        assert_eq!(
            tokens_of(state, "alice").await,
            vec![secret_key(&winner.token)]
        );
        let user = get_user(&state.db, "alice")
            .await
            .expect("load")
            .expect("alice");
        assert!(verify_password(password, &user.password_hash).await);
        assert_eq!(user.recovery_pub.as_deref(), Some(KEY));
    }

    #[tokio::test]
    async fn racing_recoveries_of_one_account_keep_one_winner() {
        let (state, path) = temp_state("recovery_race").await;
        one_of_two_racing_recoveries_wins(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("recovery_race").await {
            one_of_two_racing_recoveries_wins(&state).await;
            pg_done(state, pg).await;
        }
    }

    #[tokio::test]
    async fn a_reset_phrase_stops_the_old_one() {
        let (state, path) = temp_state("recovery_reset").await;
        add_user(&state, "alice", "a", Some(KEY)).await;
        let nonce = nonce_for(&state, "alice", T).await;
        let sig = sign(RECOVER, "alice", &nonce);
        sqlx::query("UPDATE users SET recovery_pub = '2Rd0E35G1_IAGOrmcRFbBetgSdlSqRK04n1s5rgrekE' WHERE username = 'alice'")
            .execute(&state.db)
            .await
            .expect("reset");
        let stale = recover_at(&state, recovery("alice", &nonce, &sig, text("b")), T).await;
        assert_eq!(refusal(stale), wrong());
        sqlx::query(
            "UPDATE users SET recovery_pub = NULL, recovery_set_at = NULL WHERE username = 'alice'",
        )
        .execute(&state.db)
        .await
        .expect("remove");
        let nonce = nonce_for(&state, "alice", T + 3).await;
        let sig = sign(RECOVER, "alice", &nonce);
        let removed = recover_at(&state, recovery("alice", &nonce, &sig, text("b")), T + 3).await;
        assert_eq!(refusal(removed), wrong());
        sqlx::query("UPDATE users SET password_hash = '!purging', recovery_pub = $1 WHERE username = 'alice'")
            .bind(KEY)
            .execute(&state.db)
            .await
            .expect("purging");
        let nonce = nonce_for(&state, "alice", T + 6).await;
        let sig = sign(RECOVER, "alice", &nonce);
        let purging = recover_at(&state, recovery("alice", &nonce, &sig, text("b")), T + 6).await;
        assert_eq!(refusal(purging), wrong());
        let hash: String = sqlx::query("SELECT password_hash FROM users WHERE username = 'alice'")
            .fetch_one(&state.db)
            .await
            .expect("hash")
            .try_get(0)
            .expect("hash value");
        assert_eq!(hash, "!purging");
        done(state, path).await;
    }

    async fn fifty_recover_at_once(state: &AppState) {
        let hash = hash_password("old").await.expect("hash");
        let names: Vec<String> = (0..50).map(|i| format!("user{i:02}")).collect();
        let mut tries = Vec::new();
        for name in &names {
            add_hashed(state, name, &hash, Some(KEY)).await;
            add_token(state, name, &format!("old-{name}")).await;
            let nonce = nonce_for(state, name, T).await;
            let sig = sign(RECOVER, name, &nonce);
            tries.push(recovery(name, &nonce, &sig, text(&format!("new {name}"))));
        }
        let results = futures_util::future::join_all(
            tries
                .into_iter()
                .map(|attempt| recover_at(state, attempt, T)),
        )
        .await;
        for (name, result) in names.iter().zip(results) {
            let Json(AuthResp { token, user }) = match result {
                Ok(done) => done,
                Err(ApiError(code, msg)) => panic!("{name}: {code} {msg}"),
            };
            assert_eq!(&user.username, name);
            assert_eq!(tokens_of(state, name).await, vec![secret_key(&token)]);
        }
    }

    #[tokio::test]
    async fn concurrent_recoveries_never_500() {
        let (state, path) = temp_state("recovery_many").await;
        fifty_recover_at_once(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("recovery_many").await {
            fifty_recover_at_once(&state).await;
            pg_done(state, pg).await;
        }
    }

    const NEW_KEY: &str = "2Rd0E35G1_IAGOrmcRFbBetgSdlSqRK04n1s5rgrekE";
    const BAD_KEY: &str = "key must be a base64url Ed25519 public key";

    async fn session_of(state: &AppState, name: &str, token: &str, created_at: i64) -> Session {
        let user = get_user(&state.db, name)
            .await
            .expect("load")
            .expect("user exists");
        Session {
            user,
            token: token.to_string(),
            created_at,
        }
    }

    fn reauth(value: serde_json::Value) -> ReAuthBody {
        serde_json::from_value(value).expect("reauth")
    }

    fn set_to(key: &str, how: serde_json::Value) -> RecoverySet {
        RecoverySet {
            key: key.to_string(),
            reauth: reauth(how),
        }
    }

    fn remove_by(how: serde_json::Value) -> RecoveryRemove {
        RecoveryRemove {
            reauth: reauth(how),
        }
    }

    fn proof(purpose: &str, nonce: &str, context: &str) -> serde_json::Value {
        json!({"phrase": {"nonce": nonce, "sig": phrase_sign(purpose, "alice", nonce, context)}})
    }

    fn shown(result: Result<Json<RecoveryStatus>, ApiError>) -> serde_json::Value {
        let Json(status) = result.unwrap_or_else(|ApiError(code, msg)| panic!("{code} {msg}"));
        serde_json::to_value(status).expect("json")
    }

    fn denied(result: Result<Json<RecoveryStatus>, ApiError>) -> (StatusCode, String) {
        let ApiError(code, msg) = result.err().expect("refused");
        (code, msg)
    }

    fn says(code: StatusCode, msg: &str) -> (StatusCode, String) {
        (code, msg.to_string())
    }

    async fn stored(state: &AppState) -> (Option<String>, Option<i64>) {
        let user = get_user(&state.db, "alice")
            .await
            .expect("load")
            .expect("alice");
        (user.recovery_pub, user.recovery_set_at)
    }

    async fn change_failures(state: &AppState, token: &str) -> i64 {
        sqlx::query("SELECT failures FROM change_attempts WHERE session = $1")
            .bind(session_key(token))
            .fetch_optional(&state.db)
            .await
            .expect("failures")
            .map(|r| r.try_get(0).expect("failures"))
            .unwrap_or(0)
    }

    #[tokio::test]
    async fn a_first_set_needs_the_password_and_revokes_other_sessions() {
        let (state, path) = temp_state("phrase_first_set").await;
        add_user(&state, "alice", "pw", None).await;
        add_user(&state, "bob", "pw", None).await;
        for (name, token) in [("alice", "tok-a"), ("alice", "tok-b"), ("bob", "tok-bob")] {
            add_token(&state, name, token).await;
        }
        let mut rx = state.hub.subscribe();
        let a = || session_of(&state, "alice", "tok-a", T - 10);
        let both = || {
            let mut both = vec![secret_key("tok-a"), secret_key("tok-b")];
            both.sort();
            both
        };
        assert_eq!(
            serde_json::to_value(status_of(&a().await.user)).expect("json"),
            json!({"set": false, "set_at": null, "fresh_session": false})
        );
        assert_eq!(
            denied(
                set_phrase_at(
                    &state,
                    a().await,
                    set_to(KEY, json!({"fresh_session": true})),
                    T
                )
                .await
            ),
            says(StatusCode::UNAUTHORIZED, "Confirm with your password")
        );
        assert_eq!(stored(&state).await, (None, None));
        assert_eq!(tokens_of(&state, "alice").await, both());
        assert!(revoked(&mut rx).is_empty());
        assert_eq!(change_failures(&state, "tok-a").await, 0);
        assert_eq!(
            shown(
                set_phrase_at(&state, a().await, set_to(KEY, json!({"password": "pw"})), T).await
            ),
            json!({"set": true, "set_at": T, "fresh_session": false})
        );
        assert_eq!(stored(&state).await, (Some(KEY.to_string()), Some(T)));
        assert_eq!(tokens_of(&state, "alice").await, vec![secret_key("tok-a")]);
        assert_eq!(tokens_of(&state, "bob").await, vec![secret_key("tok-bob")]);
        assert_eq!(revoked(&mut rx), ["alice"]);
        assert!(
            session_for_token(&state, "tok-b")
                .await
                .expect("lookup")
                .is_none()
        );
        let (me, _) = session_for_token(&state, "tok-a")
            .await
            .expect("lookup")
            .expect("this session stays");
        assert_eq!(me.recovery_pub.as_deref(), Some(KEY));
        assert_eq!(
            serde_json::to_value(status_of(&a().await.user)).expect("json"),
            json!({"set": true, "set_at": T, "fresh_session": false})
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn reset_needs_password_or_current_phrase() {
        let (state, path) = temp_state("phrase_reset").await;
        add_user(&state, "alice", "pw", Some(KEY)).await;
        add_token(&state, "alice", "tok-a").await;
        let a = || session_of(&state, "alice", "tok-a", T - 10);
        assert_eq!(
            denied(
                set_phrase_at(
                    &state,
                    a().await,
                    set_to(NEW_KEY, json!({"fresh_session": true})),
                    T
                )
                .await
            ),
            says(StatusCode::UNAUTHORIZED, "Confirm with your password")
        );
        assert_eq!(stored(&state).await, (Some(KEY.to_string()), Some(2)));
        let nonce = nonce_for(&state, "alice", T).await;
        assert_eq!(
            denied(
                set_phrase_at(
                    &state,
                    a().await,
                    set_to(NEW_KEY, proof("set", &nonce, KEY)),
                    T
                )
                .await
            ),
            says(StatusCode::UNAUTHORIZED, "Wrong backup phrase"),
            "the proof covers the new key"
        );
        let nonce = nonce_for(&state, "alice", T + 3).await;
        assert_eq!(
            shown(
                set_phrase_at(
                    &state,
                    a().await,
                    set_to(NEW_KEY, proof("set", &nonce, NEW_KEY)),
                    T + 3
                )
                .await
            ),
            json!({"set": true, "set_at": T + 3, "fresh_session": false})
        );
        assert_eq!(
            stored(&state).await,
            (Some(NEW_KEY.to_string()), Some(T + 3))
        );
        assert_eq!(
            denied(
                set_phrase_at(
                    &state,
                    a().await,
                    set_to(KEY, json!({"password": "PW"})),
                    T + 6
                )
                .await
            ),
            says(StatusCode::UNAUTHORIZED, "Wrong password")
        );
        assert_eq!(change_failures(&state, "tok-a").await, 2);
        let _ = shown(
            set_phrase_at(
                &state,
                a().await,
                set_to(KEY, json!({"password": "pw"})),
                T + 9,
            )
            .await,
        );
        assert_eq!(stored(&state).await, (Some(KEY.to_string()), Some(T + 9)));
        assert_eq!(tokens_of(&state, "alice").await, vec![secret_key("tok-a")]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn remove_needs_password_or_phrase() {
        let (state, path) = temp_state("phrase_remove").await;
        add_user(&state, "alice", "pw", Some(KEY)).await;
        add_token(&state, "alice", "tok-a").await;
        add_token(&state, "alice", "tok-b").await;
        let mut rx = state.hub.subscribe();
        let a = || session_of(&state, "alice", "tok-a", T - 10);
        assert_eq!(
            denied(
                remove_phrase_at(
                    &state,
                    a().await,
                    remove_by(json!({"fresh_session": true})),
                    T
                )
                .await
            ),
            says(StatusCode::UNAUTHORIZED, "Confirm with your password")
        );
        let nonce = nonce_for(&state, "alice", T).await;
        assert_eq!(
            denied(
                remove_phrase_at(
                    &state,
                    a().await,
                    remove_by(proof("set", &nonce, "")),
                    T + 3
                )
                .await
            ),
            says(StatusCode::UNAUTHORIZED, "Wrong backup phrase")
        );
        assert_eq!(stored(&state).await, (Some(KEY.to_string()), Some(2)));
        let nonce = nonce_for(&state, "alice", T + 6).await;
        assert_eq!(
            shown(
                remove_phrase_at(
                    &state,
                    a().await,
                    remove_by(proof("remove", &nonce, "")),
                    T + 6
                )
                .await
            ),
            json!({"set": false, "set_at": null, "fresh_session": false})
        );
        assert_eq!(stored(&state).await, (None, None));
        let mut both = vec![secret_key("tok-a"), secret_key("tok-b")];
        both.sort();
        assert_eq!(
            tokens_of(&state, "alice").await,
            both,
            "other sessions stay"
        );
        assert!(revoked(&mut rx).is_empty());
        let old = session_of(&state, "alice", "tok-a", T - 2000).await;
        assert_eq!(
            shown(remove_phrase_at(&state, old, remove_by(json!({"password": "pw"})), T + 9).await),
            json!({"set": false, "set_at": null, "fresh_session": false})
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn status_never_carries_a_key() {
        let (state, path) = temp_state("phrase_status").await;
        add_user(&state, "alice", "pw", Some(KEY)).await;
        add_token(&state, "alice", "tok-a").await;
        let a = session_of(&state, "alice", "tok-a", T - 10).await;
        let status = serde_json::to_value(status_of(&a.user)).expect("json");
        let mut keys: Vec<&String> = status.as_object().expect("object").keys().collect();
        keys.sort();
        assert_eq!(keys, ["fresh_session", "set", "set_at"]);
        assert_eq!(
            status,
            json!({"set": true, "set_at": 2, "fresh_session": false})
        );
        assert!(!status.to_string().contains(KEY));
        let nonce = nonce_for(&state, "alice", T).await;
        let set = shown(
            set_phrase_at(&state, a, set_to(NEW_KEY, proof("set", &nonce, NEW_KEY)), T).await,
        );
        assert!(!set.to_string().contains(NEW_KEY));
        done(state, path).await;
    }

    #[tokio::test]
    async fn bad_keys_are_refused() {
        let (state, path) = temp_state("phrase_bad_keys").await;
        add_user(&state, "alice", "pw", None).await;
        add_token(&state, "alice", "tok-a").await;
        let weak = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        assert!(crate::identity::p2p_key(weak).is_none());
        for (n, key) in (0i64..).zip([
            String::new(),
            KEY[..42].to_string(),
            weak.to_string(),
            format!("{KEY}="),
            format!("{KEY}A"),
            NEW_KEY.replace('_', "/"),
        ]) {
            for how in [json!({"fresh_session": true}), json!({"password": "wrong"})] {
                let a = session_of(&state, "alice", "tok-a", T - 10).await;
                assert_eq!(
                    denied(set_phrase_at(&state, a, set_to(&key, how), T + 3 * n).await),
                    says(StatusCode::BAD_REQUEST, BAD_KEY),
                    "{key:?}"
                );
            }
        }
        assert_eq!(change_failures(&state, "tok-a").await, 0, "not paced");
        assert_eq!(stored(&state).await, (None, None));
        let a = session_of(&state, "alice", "tok-a", T - 10).await;
        assert_eq!(
            denied(set_phrase_at(&state, a, set_to(KEY, json!({})), T).await),
            says(
                StatusCode::BAD_REQUEST,
                "Confirm with exactly one of password, words, phrase or fresh_session"
            )
        );
        done(state, path).await;
    }

    async fn one_of_two_racing_sets_wins(state: &AppState) {
        add_user(state, "alice", "pw", None).await;
        add_token(state, "alice", "tok-a").await;
        add_token(state, "alice", "tok-b").await;
        let a = session_of(state, "alice", "tok-a", 5).await;
        let b = session_of(state, "alice", "tok-b", 5).await;
        let (first, second) = tokio::join!(
            set_phrase_at(state, a, set_to(KEY, json!({"password": "pw"})), T),
            set_phrase_at(state, b, set_to(NEW_KEY, json!({"password": "pw"})), T),
        );
        let (key, token, lost) = match (first, second) {
            (Ok(_), Err(lost)) => (KEY, "tok-a", lost),
            (Err(lost), Ok(_)) => (NEW_KEY, "tok-b", lost),
            (a, b) => panic!("exactly one set wins: {:?} {:?}", a.is_ok(), b.is_ok()),
        };
        let ApiError(code, msg) = lost;
        assert_eq!(
            (code, msg.as_str()),
            (StatusCode::UNAUTHORIZED, "Unauthorized")
        );
        assert_eq!(stored(state).await, (Some(key.to_string()), Some(T)));
        assert_eq!(tokens_of(state, "alice").await, vec![secret_key(token)]);
    }

    #[tokio::test]
    async fn two_sessions_set_at_once() {
        let (state, path) = temp_state("phrase_race").await;
        one_of_two_racing_sets_wins(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("phrase_race").await {
            one_of_two_racing_sets_wins(&state).await;
            pg_done(state, pg).await;
        }
    }

    #[tokio::test]
    async fn a_revoked_session_changes_nothing() {
        let (state, path) = temp_state("phrase_revoked").await;
        add_user(&state, "alice", "pw", Some(KEY)).await;
        let a = session_of(&state, "alice", "gone", T - 10).await;
        assert_eq!(
            denied(set_phrase_at(&state, a, set_to(NEW_KEY, json!({"password": "pw"})), T).await),
            says(StatusCode::UNAUTHORIZED, "Unauthorized")
        );
        let a = session_of(&state, "alice", "gone", T - 10).await;
        assert_eq!(
            denied(remove_phrase_at(&state, a, remove_by(json!({"password": "pw"})), T + 3).await),
            says(StatusCode::UNAUTHORIZED, "Unauthorized")
        );
        assert_eq!(stored(&state).await, (Some(KEY.to_string()), Some(2)));
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_switch_stops_new_phrases_but_never_removal_or_recovery() {
        let (state, path) = temp_state("phrase_switch").await;
        add_user(&state, "alice", "pw", None).await;
        add_token(&state, "alice", "tok-a").await;
        sqlx::query("INSERT INTO settings(key, value) VALUES('backup_phrase', '0') ON CONFLICT(key) DO UPDATE SET value = '0'")
            .execute(&state.db)
            .await
            .expect("switch off");
        crate::api::Settings::forget(&state.db);
        let a = || session_of(&state, "alice", "tok-a", T - 10);
        assert_eq!(
            denied(
                set_phrase_at(
                    &state,
                    a().await,
                    set_to(KEY, json!({"fresh_session": true})),
                    T
                )
                .await
            ),
            says(StatusCode::NOT_FOUND, "Not found")
        );
        assert_eq!(
            denied(set_phrase_at(&state, a().await, set_to("", json!({"password": "x"})), T).await),
            says(StatusCode::NOT_FOUND, "Not found")
        );
        assert_eq!(change_failures(&state, "tok-a").await, 0);
        assert_eq!(stored(&state).await, (None, None));
        sqlx::query(
            "UPDATE users SET recovery_pub = $1, recovery_set_at = 7 WHERE username = 'alice'",
        )
        .bind(KEY)
        .execute(&state.db)
        .await
        .expect("an earlier phrase");
        assert_eq!(
            serde_json::to_value(status_of(&a().await.user)).expect("json"),
            json!({"set": true, "set_at": 7, "fresh_session": false})
        );
        let nonce = nonce_for(&state, "alice", T).await;
        let Json(AuthResp { token, .. }) = recover_at(
            &state,
            recovery(
                "alice",
                &nonce,
                &sign(RECOVER, "alice", &nonce),
                text("new"),
            ),
            T,
        )
        .await
        .expect("recovery still works");
        let fresh = session_of(&state, "alice", &token, T).await;
        assert_eq!(
            shown(
                remove_phrase_at(&state, fresh, remove_by(json!({"password": "new"})), T + 3).await
            ),
            json!({"set": false, "set_at": null, "fresh_session": false})
        );
        assert_eq!(stored(&state).await, (None, None));
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_phrase_routes_work_over_http() {
        use crate::config::{AppConfig, Roles};
        let (state, path) = temp_state("phrase_http").await;
        let config = AppConfig {
            roles: Roles {
                web: false,
                ..Roles::ALL
            },
            ..AppConfig::defaults()
        };
        let app = crate::server::build_router(None, None, &config, state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        let base = format!("http://{addr}/api");
        let client = reqwest::Client::new();
        let read = |res: reqwest::Response| async move {
            serde_json::from_slice::<serde_json::Value>(&res.bytes().await.expect("body"))
                .expect("json")
        };
        let registered = read(
            client
                .post(format!("{base}/auth/register"))
                .header("content-type", "application/json")
                .body(
                    json!({"username": "Alice", "password": "pw", "avatar_kind": "identicon"})
                        .to_string(),
                )
                .send()
                .await
                .expect("register"),
        )
        .await;
        let token = registered["token"].as_str().expect("token").to_string();
        let call = |method: reqwest::Method, body: Option<serde_json::Value>, auth: bool| {
            let mut req = client.request(method, format!("{base}/me/recovery"));
            if auth {
                req = req.bearer_auth(&token);
            }
            if let Some(body) = body {
                req = req
                    .header("content-type", "application/json")
                    .body(body.to_string());
            }
            req.send()
        };
        let res = call(reqwest::Method::GET, None, true).await.expect("get");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            read(res).await,
            json!({"set": false, "set_at": null, "fresh_session": false})
        );
        let res = call(reqwest::Method::GET, None, false).await.expect("get");
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let res = call(
            reqwest::Method::PUT,
            Some(json!({"key": KEY, "reauth": {"fresh_session": true}})),
            true,
        )
        .await
        .expect("put");
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            read(res).await,
            json!({"error": "Confirm with your password"})
        );
        let res = call(
            reqwest::Method::PUT,
            Some(json!({"key": KEY, "reauth": {"password": "pw"}})),
            true,
        )
        .await
        .expect("put");
        assert_eq!(res.status(), StatusCode::OK);
        let set = read(res).await;
        assert_eq!(
            (&set["set"], &set["fresh_session"]),
            (&json!(true), &json!(false))
        );
        assert_eq!(
            get_user(&state.db, "alice")
                .await
                .expect("load")
                .expect("alice")
                .recovery_pub
                .as_deref(),
            Some(KEY)
        );
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let res = call(
            reqwest::Method::DELETE,
            Some(json!({"reauth": {"password": "pw"}})),
            true,
        )
        .await
        .expect("delete");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            read(res).await,
            json!({"set": false, "set_at": null, "fresh_session": false})
        );
        let mut limited = 0;
        for _ in 0..35 {
            let res = call(reqwest::Method::DELETE, Some(json!({"reauth": {}})), false)
                .await
                .expect("delete");
            if res.status() == StatusCode::TOO_MANY_REQUESTS {
                limited += 1;
            }
        }
        assert!(limited >= 1, "DELETE is in the strict bucket");
        let mut put_limited = 0;
        for _ in 0..5 {
            let res = call(reqwest::Method::PUT, Some(json!({})), false)
                .await
                .expect("put");
            if res.status() == StatusCode::TOO_MANY_REQUESTS {
                put_limited += 1;
            }
        }
        assert!(put_limited >= 3, "PUT is in the strict bucket");
        for _ in 0..3 {
            let res = call(reqwest::Method::GET, None, true).await.expect("get");
            assert_eq!(
                res.status(),
                StatusCode::OK,
                "GET is not in the strict bucket"
            );
        }
        server.abort();
        done(state, path).await;
    }
}
