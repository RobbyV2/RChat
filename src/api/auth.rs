use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::sync::Semaphore;
use utoipa::ToSchema;

use crate::api::dms::dm_page;
use crate::api::servers::{OkResp, ok};
use crate::api::servers::{Page, my_servers_page};
use crate::api::{
    ApiError, Authed, DmSummary, LIST_PAGE, Member, NAME_MAX, ProfanityTarget, ServerSummary,
    UserRef, check_len, check_profanity, request_token, valid_color,
};
use crate::db::{AvatarKind, Db, User, get_user, now};
use crate::state::AppState;
use crate::ws::WsEvent;

#[derive(Serialize, ToSchema)]
pub struct Me {
    pub username: String,
    pub display_name: String,
    pub avatar_kind: AvatarKind,
    pub avatar_color: Option<String>,
    pub banner_color: Option<String>,
    pub bio: Option<String>,
    pub is_site_admin: bool,
    pub appear_offline: bool,
    #[schema(schema_with = password_kind_schema)]
    pub password_kind: String,
    pub servers: Vec<ServerSummary>,
    pub servers_more: bool,
    pub servers_cursor: Option<String>,
    pub dms: Vec<DmSummary>,
    pub dms_more: bool,
    pub dms_cursor: Option<String>,
}

fn password_kind_schema() -> utoipa::openapi::Object {
    utoipa::openapi::ObjectBuilder::new()
        .schema_type(utoipa::openapi::Type::String)
        .enum_values(Some(["text", "words"]))
        .description(Some("How the account signs in: a text password or 7 words"))
        .build()
}

#[derive(Serialize, ToSchema)]
pub struct AuthResp {
    pub token: String,
    pub user: Me,
}

#[derive(Serialize, ToSchema)]
pub struct WordsResp {
    pub words: Vec<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct RegisterReq {
    username: String,
    password: Option<String>,
    words: Option<Vec<String>>,
    avatar_kind: AvatarKind,
    avatar_color: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct LoginReq {
    username: String,
    password: Option<String>,
    words: Option<Vec<String>>,
}

#[derive(Deserialize, ToSchema)]
pub struct Secret {
    password: Option<String>,
    words: Option<Vec<String>>,
}

#[derive(Deserialize, ToSchema)]
pub struct PasswordChange {
    current: Secret,
    new: Secret,
}

fn word_set(username: &str) -> Vec<String> {
    let seed: [u8; 32] = Sha256::digest(username.to_lowercase().as_bytes()).into();
    let mut rng = ChaCha8Rng::from_seed(seed);
    rand::seq::index::sample(&mut rng, memorable_wordlist::WORDS.len(), 20)
        .into_iter()
        .map(|i| memorable_wordlist::WORDS[i].to_string())
        .collect()
}

static HASHING: LazyLock<Semaphore> = LazyLock::new(|| {
    Semaphore::new(
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4),
    )
});

const VERIFIED_TTL: Duration = Duration::from_secs(60);
const VERIFIED_MAX: usize = 4096;

type Verified = HashMap<[u8; 32], (Instant, bool)>;

static VERIFIED: LazyLock<Mutex<Verified>> = LazyLock::new(Default::default);

async fn off_runtime<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError> {
    let _permit = HASHING
        .acquire()
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?;
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))
}

fn hash_now(secret: &str) -> Result<String, ApiError> {
    match Argon2::default().hash_password(secret.as_bytes()) {
        Ok(hash) => Ok(hash.to_string()),
        Err(e) => Err(anyhow::anyhow!(e).into()),
    }
}

fn verify_now(secret: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(secret.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

pub(crate) async fn hash_password(secret: &str) -> Result<String, ApiError> {
    let secret = secret.to_string();
    off_runtime(move || hash_now(&secret)).await?
}

pub(crate) async fn verify_password(secret: &str, hash: &str) -> bool {
    let (secret, hash) = (secret.to_string(), hash.to_string());
    off_runtime(move || verify_now(&secret, &hash))
        .await
        .unwrap_or(false)
}

pub(crate) async fn verify_password_cached(secret: &str, hash: &str) -> bool {
    let mut digest = Sha256::new();
    digest.update(hash.as_bytes());
    digest.update([0u8]);
    digest.update(secret.as_bytes());
    let key: [u8; 32] = digest.finalize().into();
    let hit = VERIFIED.lock().ok().and_then(|cache| {
        cache
            .get(&key)
            .filter(|(at, _)| at.elapsed() < VERIFIED_TTL)
            .map(|(_, ok)| *ok)
    });
    if let Some(ok) = hit {
        return ok;
    }
    let ok = verify_password(secret, hash).await;
    if let Ok(mut cache) = VERIFIED.lock() {
        if cache.len() >= VERIFIED_MAX {
            cache.retain(|_, (at, _)| at.elapsed() < VERIFIED_TTL);
        }
        if cache.len() < VERIFIED_MAX {
            cache.insert(key, (Instant::now(), ok));
        }
    }
    ok
}

pub(crate) fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn bad(msg: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.to_string())
}

fn check_avatar(
    avatar_kind: AvatarKind,
    avatar_color: Option<String>,
) -> Result<Option<String>, ApiError> {
    match (avatar_kind, avatar_color) {
        (AvatarKind::Identicon, _) => Ok(None),
        (AvatarKind::Color, Some(color)) if valid_color(&color) => Ok(Some(color.to_lowercase())),
        (AvatarKind::Color, _) => Err(bad("Invalid avatar color")),
    }
}

fn secret_from(
    username: &str,
    password: Option<String>,
    words: Option<Vec<String>>,
    validate_words: bool,
) -> Result<(String, &'static str), ApiError> {
    match (password, words) {
        (Some(password), None) => Ok((password, "text")),
        (None, Some(words)) => {
            let words: Vec<String> = words.into_iter().map(|w| w.to_lowercase()).collect();
            if validate_words {
                let set = word_set(username);
                if words.len() != 7 || words.iter().any(|w| !set.contains(w)) {
                    return Err(bad("Pick 7 words from your word set"));
                }
            }
            Ok((words.join(" "), "words"))
        }
        (_, _) => Err(bad("Provide exactly one of password or words")),
    }
}

pub(crate) async fn me_payload(db: &Db, user: &User) -> Result<Me, ApiError> {
    let Page {
        items: servers,
        more: servers_more,
        next: servers_cursor,
    } = my_servers_page(db, &user.username, 0, None, LIST_PAGE).await?;
    let Page {
        items: dms,
        more: dms_more,
        next: dms_cursor,
    } = dm_page(db, &user.username, 0, None, LIST_PAGE).await?;
    Ok(Me {
        username: user.username.clone(),
        display_name: user.display_name.clone(),
        avatar_kind: user.avatar_kind,
        avatar_color: user.avatar_color.clone(),
        banner_color: user.banner_color.clone(),
        bio: user.bio.clone(),
        is_site_admin: user.is_site_admin,
        appear_offline: user.appear_offline,
        password_kind: user.password_kind.clone(),
        servers,
        servers_more,
        servers_cursor,
        dms,
        dms_more,
        dms_cursor,
    })
}

#[utoipa::path(get, path = "/api/auth/words/{username}", params(("username" = String, Path)), responses((status = 200, description = "The 20 candidate words derived deterministically from the username; word-based accounts pick 7 of them", body = WordsResp)))]
pub(crate) async fn words(Path(username): Path<String>) -> Json<WordsResp> {
    Json(WordsResp {
        words: word_set(&username),
    })
}

#[utoipa::path(post, path = "/api/auth/register", request_body = RegisterReq, responses((status = 200, description = "Account created; returns a session token and the new user's profile", body = AuthResp)))]
pub(crate) async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterReq>,
) -> Result<Json<AuthResp>, ApiError> {
    let RegisterReq {
        username,
        password,
        words,
        avatar_kind,
        avatar_color,
    } = req;
    if username.trim().is_empty() {
        return Err(bad("Username required"));
    }
    check_len(&username, NAME_MAX, "Username")?;
    if username.contains('@') {
        return Err(bad("Usernames can't contain @"));
    }
    if password.as_deref() == Some("") {
        return Err(bad("Password required"));
    }
    let key = username.to_lowercase();
    let (secret, password_kind) = secret_from(&username, password, words, true)?;
    let avatar_color = check_avatar(avatar_kind, avatar_color)?;
    check_profanity(&state.db, ProfanityTarget::Usernames, &username).await?;
    let password_hash = hash_password(&secret).await?;
    let mut tx = state.db.begin().await?;
    let banned = sqlx::query("SELECT 1 FROM banned_usernames WHERE username = $1")
        .bind(&key)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
    if banned {
        return Err(bad("Username is banned"));
    }
    if crate::db::user_row(&mut *tx, &key).await?.is_some() {
        return Err(bad("Username is taken"));
    }
    let user_count: i64 = sqlx::query("SELECT COUNT(*) FROM (SELECT 1 FROM users LIMIT 1) t")
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    let t = now();
    sqlx::query(
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, avatar_color, is_site_admin, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&key)
    .bind(&username)
    .bind(&password_hash)
    .bind(password_kind)
    .bind(avatar_kind.as_str())
    .bind(&avatar_color)
    .bind(i64::from(user_count == 0))
    .bind(t)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, $2)",
    )
    .bind(&key)
    .bind(t)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO dms(user_a, user_b) VALUES($1, $2)")
        .bind(&key)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    let token = new_token();
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, $3)")
        .bind(&token)
        .bind(&key)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let user = match get_user(&state.db, &key).await? {
        Some(user) => user,
        None => return Err(anyhow::anyhow!("user missing after insert").into()),
    };
    let me = me_payload(&state.db, &user).await?;
    state.hub.broadcast(WsEvent::MemberJoined {
        server: "rchat".to_string(),
        member: Member {
            user: UserRef::from_user(&user),
            is_admin: false,
            is_creator: false,
            online: false,
            perms: 0,
            role_ids: Vec::new(),
        },
    });
    state.hub.broadcast(WsEvent::UserRegistered {
        user: UserRef::from_user(&user),
    });
    Ok(Json(AuthResp { token, user: me }))
}

async fn throttle_attempt(db: &Db, key: &str, t: i64) -> Result<(), ApiError> {
    let day = (t / 86400).to_string();
    let admitted = sqlx::query(
        "INSERT INTO login_attempts(username, day, count, last_at) VALUES($1, $2, 1, $3) ON CONFLICT(username) DO UPDATE SET count = CASE WHEN login_attempts.day = excluded.day THEN login_attempts.count + 1 ELSE 1 END, day = excluded.day, last_at = excluded.last_at WHERE login_attempts.day <> excluded.day OR excluded.last_at - login_attempts.last_at >= 3 RETURNING count",
    )
    .bind(key)
    .bind(&day)
    .bind(t)
    .fetch_optional(db)
    .await?;
    let count: i64 = match &admitted {
        Some(row) => row.try_get(0)?,
        None => sqlx::query("SELECT count FROM login_attempts WHERE username = $1")
            .bind(key)
            .fetch_one(db)
            .await?
            .try_get(0)?,
    };
    match (count > 1000, admitted.is_some()) {
        (true, _) => Err(ApiError(
            StatusCode::LOCKED,
            "Account locked for the day".to_string(),
        )),
        (false, true) => Ok(()),
        (false, false) => Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Wait 3 seconds between attempts".to_string(),
        )),
    }
}

pub(crate) const PASSWORD_FAILURES_MAX: i64 = 50;

fn session_key(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

async fn throttle_change(db: &Db, key: &str, t: i64) -> Result<(), ApiError> {
    let day = (t / 86400).to_string();
    let admitted = sqlx::query(
        "INSERT INTO change_attempts(session, day, failures, last_at) VALUES($1, $2, 0, $3) ON CONFLICT(session) DO UPDATE SET failures = CASE WHEN change_attempts.day = excluded.day THEN change_attempts.failures ELSE 0 END, day = excluded.day, last_at = excluded.last_at WHERE change_attempts.day <> excluded.day OR excluded.last_at - change_attempts.last_at >= 3 RETURNING failures",
    )
    .bind(key)
    .bind(&day)
    .bind(t)
    .fetch_optional(db)
    .await?;
    match admitted {
        None => Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Wait 3 seconds between attempts".to_string(),
        )),
        Some(row) if row.try_get::<i64, _>(0)? >= PASSWORD_FAILURES_MAX => Err(ApiError(
            StatusCode::LOCKED,
            "Too many wrong passwords today".to_string(),
        )),
        Some(_) => Ok(()),
    }
}

async fn note_change_failure(db: &Db, key: &str) -> Result<(), ApiError> {
    sqlx::query("UPDATE change_attempts SET failures = failures + 1 WHERE session = $1")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

fn invalid_credentials() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "Invalid credentials".to_string())
}

async fn issue_token(db: &Db, user: &User, t: i64) -> Result<String, ApiError> {
    let token = new_token();
    let mut tx = db.begin().await?;
    let held = sqlx::query(
        "UPDATE users SET password_hash = password_hash WHERE username = $1 AND password_hash = $2",
    )
    .bind(&user.username)
    .bind(&user.password_hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if held != 1 {
        return Err(invalid_credentials());
    }
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, $3)")
        .bind(&token)
        .bind(&user.username)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(token)
}

fn wrong_password() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "Wrong password".to_string())
}

#[utoipa::path(post, path = "/api/auth/login", request_body = LoginReq, responses((status = 200, description = "Credentials accepted; returns a new session token and the user's profile", body = AuthResp)))]
pub(crate) async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginReq>,
) -> Result<Json<AuthResp>, ApiError> {
    let LoginReq {
        username,
        password,
        words,
    } = req;
    let key = username.to_lowercase();
    let db = &state.db;
    let t = now();
    throttle_attempt(db, &key, t).await?;
    let (secret, _) = secret_from(&username, password, words, false)?;
    let user = match get_user(db, &key).await? {
        Some(user) if verify_password(&secret, &user.password_hash).await => user,
        _ => return Err(invalid_credentials()),
    };
    let token = issue_token(db, &user, t).await?;
    let me = me_payload(db, &user).await?;
    Ok(Json(AuthResp { token, user: me }))
}

#[utoipa::path(get, path = "/api/me", responses((status = 200, description = "The signed-in user's profile with the first page (50) of joined servers and of DMs; `servers_more`/`dms_more` say whether `/api/me/servers` and `/api/dms` have more, and `servers_cursor`/`dms_cursor` are the `cursor` values for their next pages (null when there are no more)", body = Me)), security(("bearer" = [])))]
pub(crate) async fn me(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Me>, ApiError> {
    Ok(Json(me_payload(&state.read(), &user).await?))
}

#[utoipa::path(post, path = "/api/me/password", request_body(content = PasswordChange, description = "`current` and `new` each take exactly one of `password` (any non-empty text) or `words` (7 words, in order, from the account's word set). Switching between text and words is allowed"), responses((status = 200, description = "Password changed. Every other login token of the account is revoked and their live connections close; the token used for this request stays valid", body = OkResp), (status = 400, description = "Missing or invalid new password"), (status = 401, description = "Wrong current password"), (status = 423, description = "Password changes from this session locked for the day after 50 wrong current passwords (separate from the login lockout; other sessions are unaffected)"), (status = 429, description = "One attempt every 3 seconds per session")), security(("bearer" = [])))]
pub(crate) async fn change_password(
    State(state): State<AppState>,
    Authed(user): Authed,
    headers: HeaderMap,
    Json(req): Json<PasswordChange>,
) -> Result<Json<OkResp>, ApiError> {
    let PasswordChange { current, new } = req;
    let Secret {
        password: new_password,
        words: new_words,
    } = new;
    if new_password.as_deref() == Some("") {
        return Err(bad("Password required"));
    }
    let (new_secret, new_kind) = secret_from(&user.username, new_password, new_words, true)?;
    let Secret { password, words } = current;
    let (secret, _) = secret_from(&user.username, password, words, false)?;
    let t = now();
    let token = request_token(&headers).unwrap_or_default();
    let session = session_key(&token);
    throttle_change(&state.db, &session, t).await?;
    if !verify_password(&secret, &user.password_hash).await {
        note_change_failure(&state.db, &session).await?;
        return Err(wrong_password());
    }
    let hash = hash_password(&new_secret).await?;
    let mut tx = state.db.begin().await?;
    let changed = sqlx::query(
        "UPDATE users SET password_hash = $1, password_kind = $2 WHERE username = $3 AND password_hash = $4",
    )
    .bind(&hash)
    .bind(new_kind)
    .bind(&user.username)
    .bind(&user.password_hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed != 1 {
        return Err(wrong_password());
    }
    sqlx::query("DELETE FROM tokens WHERE username = $1 AND token <> $2")
        .bind(&user.username)
        .bind(&token)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::TokensRevoked {
        username: user.username.clone(),
    });
    Ok(ok())
}

#[utoipa::path(post, path = "/api/auth/logout", responses((status = 200, description = "Signed out: the login token used for this request is revoked and its live connections close; the account's other sessions stay signed in", body = OkResp), (status = 401, description = "Not signed in")), security(("bearer" = [])))]
pub(crate) async fn logout(
    State(state): State<AppState>,
    Authed(user): Authed,
    headers: HeaderMap,
) -> Result<Json<OkResp>, ApiError> {
    let token = request_token(&headers).unwrap_or_default();
    let revoked = sqlx::query("DELETE FROM tokens WHERE token = $1 AND username = $2")
        .bind(&token)
        .bind(&user.username)
        .execute(&state.db)
        .await?
        .rows_affected();
    if revoked > 0 {
        state.hub.broadcast(WsEvent::TokensRevoked {
            username: user.username.clone(),
        });
    }
    Ok(ok())
}

fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize, ToSchema)]
pub struct MePatch {
    avatar_kind: Option<AvatarKind>,
    avatar_color: Option<String>,
    appear_offline: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    #[schema(value_type = Option<String>)]
    banner_color: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[schema(value_type = Option<String>)]
    bio: Option<Option<String>>,
}

#[derive(Serialize, ToSchema)]
pub struct MeUpdated {
    #[serde(flatten)]
    pub user: UserRef,
    pub banner_color: Option<String>,
    pub bio: Option<String>,
    pub appear_offline: bool,
}

pub const BIO_MAX: usize = 190;

pub fn clean_bio(text: &str) -> Result<Option<String>, ApiError> {
    let kept: String = text
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect();
    let mut out = String::with_capacity(kept.len());
    let mut newlines = 0;
    for c in kept.trim().chars() {
        newlines = match c {
            '\n' => newlines + 1,
            _ => 0,
        };
        if newlines <= 2 {
            out.push(c);
        }
    }
    match out.chars().count() {
        0 => Ok(None),
        n if n > BIO_MAX => Err(bad(&format!(
            "Description must be at most {BIO_MAX} characters"
        ))),
        _ => Ok(Some(out)),
    }
}

fn check_banner(color: Option<String>) -> Result<Option<String>, ApiError> {
    match color {
        None => Ok(None),
        Some(color) if valid_color(&color) => Ok(Some(color.to_lowercase())),
        Some(_) => Err(bad("Invalid banner color")),
    }
}

#[utoipa::path(patch, path = "/api/me", request_body(content = MePatch, description = "Every field is optional and only the fields present change. `banner_color` is a `#rrggbb` color, or `null` to go back to the default derived from the avatar. `bio` is the profile description: trimmed, control characters other than newlines removed, 3 or more newlines in a row collapsed to 2, at most 190 characters; empty or `null` clears it. It is checked by the profanity filter (`bios` target)"), responses((status = 200, description = "Avatar, banner color, description and/or appear-offline preference updated; returns the user's public profile plus their banner color, description and appear-offline flag", body = MeUpdated), (status = 400, description = "Invalid color, description too long, or description blocked by the profanity filter")), security(("bearer" = [])))]
pub(crate) async fn patch_me(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<MePatch>,
) -> Result<Json<MeUpdated>, ApiError> {
    let MePatch {
        avatar_kind,
        avatar_color,
        appear_offline,
        banner_color,
        bio,
    } = req;
    let avatar = match avatar_kind {
        Some(kind) => Some((kind, check_avatar(kind, avatar_color)?)),
        None => None,
    };
    let banner = match banner_color {
        Some(color) => Some(check_banner(color)?),
        None => None,
    };
    let bio = match bio {
        Some(text) => {
            let text = clean_bio(text.as_deref().unwrap_or(""))?;
            if let Some(text) = &text {
                check_profanity(&state.db, ProfanityTarget::Bios, text).await?;
            }
            Some(text)
        }
        None => None,
    };
    let mut tx = state.db.begin().await?;
    if let Some((kind, color)) = &avatar {
        sqlx::query("UPDATE users SET avatar_kind = $1, avatar_color = $2 WHERE username = $3")
            .bind(kind.as_str())
            .bind(color)
            .bind(&user.username)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(color) = &banner {
        sqlx::query("UPDATE users SET banner_color = $1 WHERE username = $2")
            .bind(color)
            .bind(&user.username)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(text) = &bio {
        sqlx::query("UPDATE users SET bio = $1 WHERE username = $2")
            .bind(text)
            .bind(&user.username)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(hidden) = appear_offline {
        sqlx::query("UPDATE users SET appear_offline = $1 WHERE username = $2")
            .bind(i64::from(hidden))
            .bind(&user.username)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let stored = get_user(&state.db, &user.username)
        .await?
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let user_ref = UserRef::from_user(&stored);
    if avatar.is_some() || bio.as_ref().is_some_and(|b| *b != user.bio) {
        state.hub.broadcast(WsEvent::UserUpdated {
            user: user_ref.clone(),
            scope: crate::ws::user_scope(&state.read(), &stored.username).await,
        });
    }
    if appear_offline.is_some() {
        state.hub.broadcast(WsEvent::PresenceMode {
            username: stored.username.clone(),
            appear_offline: stored.appear_offline,
        });
    }
    Ok(Json(MeUpdated {
        user: user_ref,
        banner_color: stored.banner_color,
        bio: stored.bio,
        appear_offline: stored.appear_offline,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{done, temp_state};
    use crate::state::AppState;

    #[test]
    fn word_set_deterministic() {
        let a = word_set("Alice");
        assert_eq!(a, word_set("alice"));
        assert_eq!(a.len(), 20);
        let distinct: std::collections::HashSet<&String> = a.iter().collect();
        assert_eq!(distinct.len(), 20);
        assert_ne!(a, word_set("bob"));
    }

    async fn register_text(state: &AppState, name: &str) -> Result<Json<AuthResp>, ApiError> {
        register(
            State(state.clone()),
            Json(RegisterReq {
                username: name.to_string(),
                password: Some("a".to_string()),
                words: None,
                avatar_kind: AvatarKind::Identicon,
                avatar_color: None,
            }),
        )
        .await
    }

    #[tokio::test]
    async fn word_register_login_roundtrip() {
        let (state, path) = temp_state("word_auth").await;
        let words = word_set("Wendy");
        let picked = words[..7].to_vec();
        let resp = register(
            State(state.clone()),
            Json(RegisterReq {
                username: "Wendy".to_string(),
                password: None,
                words: Some(picked.clone()),
                avatar_kind: AvatarKind::Identicon,
                avatar_color: None,
            }),
        )
        .await
        .expect("register")
        .0;
        assert_eq!(resp.user.username, "wendy");
        assert!(!resp.token.is_empty());
        let bad_words = register(
            State(state.clone()),
            Json(RegisterReq {
                username: "mallory".to_string(),
                password: None,
                words: Some(vec!["definitelynotintheset".to_string(); 7]),
                avatar_kind: AvatarKind::Identicon,
                avatar_color: None,
            }),
        )
        .await;
        assert!(matches!(
            bad_words,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        let shouted: Vec<String> = picked.iter().map(|w| w.to_uppercase()).collect();
        let ok = login(
            State(state.clone()),
            Json(LoginReq {
                username: "WENDY".to_string(),
                password: None,
                words: Some(shouted),
            }),
        )
        .await
        .expect("login")
        .0;
        assert!(!ok.token.is_empty());
        done(state, path).await;
    }

    #[tokio::test]
    async fn empty_password_rejected() {
        let (state, path) = temp_state("empty_password").await;
        let empty = register(
            State(state.clone()),
            Json(RegisterReq {
                username: "erin".to_string(),
                password: Some(String::new()),
                words: None,
                avatar_kind: AvatarKind::Identicon,
                avatar_color: None,
            }),
        )
        .await;
        assert!(matches!(empty, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        assert!(get_user(&state.db, "erin").await.expect("lookup").is_none());
        let _ = register_text(&state, "erin").await.expect("non-empty ok");
        done(state, path).await;
    }

    #[tokio::test]
    async fn new_usernames_cannot_contain_at() {
        let (state, path) = temp_state("username_at").await;
        for name in ["admin@localhost", "bob@other.example", "@", "a@"] {
            let res = register_text(&state, name).await;
            assert!(
                matches!(&res, Err(ApiError(StatusCode::BAD_REQUEST, m)) if m.contains('@')),
                "{name}"
            );
        }
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('old@name', 'old@name', '', 'text', 'identicon', 0)")
            .execute(&state.db)
            .await
            .expect("legacy user");
        assert!(
            get_user(&state.db, "old@name")
                .await
                .expect("lookup")
                .is_some()
        );
        let _ = register_text(&state, "plain").await.expect("plain ok");
        done(state, path).await;
    }

    #[tokio::test]
    async fn username_length_limit() {
        let (state, path) = temp_state("username_len").await;
        let max = "é".repeat(NAME_MAX);
        let ok = register_text(&state, &max)
            .await
            .expect("100 code points ok");
        assert_eq!(ok.0.user.username.chars().count(), NAME_MAX);
        for len in [NAME_MAX + 1, 1001, 5001] {
            let long = register_text(&state, &"a".repeat(len)).await;
            assert!(
                matches!(long, Err(ApiError(StatusCode::BAD_REQUEST, _))),
                "{len}"
            );
        }
        let count: i64 = sqlx::query("SELECT COUNT(*) FROM users")
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value");
        assert_eq!(count, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn login_throttle() {
        let (state, path) = temp_state("throttle").await;
        let _ = register_text(&state, "tom").await.expect("register");
        let attempt = |password: &str| {
            let state = state.clone();
            let password = password.to_string();
            async move {
                login(
                    State(state),
                    Json(LoginReq {
                        username: "tom".to_string(),
                        password: Some(password),
                        words: None,
                    }),
                )
                .await
            }
        };
        let _ = attempt("a").await.expect("first login");
        let fast = attempt("a").await;
        assert!(matches!(
            fast,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
        ));
        sqlx::query(
            "UPDATE login_attempts SET count = 1000, last_at = last_at - 10 WHERE username = 'tom'",
        )
        .execute(&state.db)
        .await
        .expect("prime attempts");
        let locked = attempt("a").await;
        assert!(matches!(locked, Err(ApiError(StatusCode::LOCKED, _))));
        done(state, path).await;
    }

    fn text(password: &str) -> Secret {
        Secret {
            password: Some(password.to_string()),
            words: None,
        }
    }

    fn picked(words: &[String]) -> Secret {
        Secret {
            password: None,
            words: Some(words.to_vec()),
        }
    }

    async fn change(
        state: &AppState,
        name: &str,
        token: &str,
        current: Secret,
        new: Secret,
    ) -> Result<Json<OkResp>, ApiError> {
        let user = get_user(&state.db, name)
            .await
            .expect("load user")
            .expect("user exists");
        change_as(state, user, token, current, new).await
    }

    async fn change_as(
        state: &AppState,
        user: User,
        token: &str,
        current: Secret,
        new: Secret,
    ) -> Result<Json<OkResp>, ApiError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().expect("header"),
        );
        change_password(
            State(state.clone()),
            Authed(user),
            headers,
            Json(PasswordChange { current, new }),
        )
        .await
    }

    async fn rewind(state: &AppState) {
        for table in ["login_attempts", "change_attempts"] {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE {table} SET last_at = last_at - 10"
            )))
            .execute(&state.db)
            .await
            .expect("rewind attempts");
        }
    }

    async fn failures(state: &AppState, token: &str) -> i64 {
        sqlx::query("SELECT failures FROM change_attempts WHERE session = $1")
            .bind(session_key(token))
            .fetch_optional(&state.db)
            .await
            .expect("failures")
            .map(|r| r.try_get(0).expect("failures"))
            .unwrap_or(0)
    }

    async fn tokens_of(state: &AppState, name: &str) -> Vec<String> {
        let rows = sqlx::query("SELECT token FROM tokens WHERE username = $1 ORDER BY token")
            .bind(name)
            .fetch_all(&state.db)
            .await
            .expect("tokens");
        rows.iter().map(|r| r.try_get(0).expect("token")).collect()
    }

    async fn attempts(state: &AppState, name: &str) -> i64 {
        sqlx::query("SELECT count FROM login_attempts WHERE username = $1")
            .bind(name)
            .fetch_optional(&state.db)
            .await
            .expect("attempts")
            .map(|r| r.try_get(0).expect("count"))
            .unwrap_or(0)
    }

    async fn add_token(state: &AppState, name: &str, token: &str) {
        sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, 0)")
            .bind(token)
            .bind(name)
            .execute(&state.db)
            .await
            .expect("insert token");
    }

    #[tokio::test]
    async fn password_change_switches_kinds_and_revokes_other_tokens() {
        let (state, path) = temp_state("password_change").await;
        let other = register_text(&state, "bob").await.expect("bob").0.token;
        let mine = register_text(&state, "Tina")
            .await
            .expect("register")
            .0
            .token;
        add_token(&state, "tina", "stale").await;
        let mut rx = state.hub.subscribe();
        let words = word_set("tina");
        let seven: Vec<String> = words[3..10].iter().rev().cloned().collect();
        let _ = change(&state, "tina", &mine, text("a"), picked(&seven))
            .await
            .expect("text to words");
        let user = get_user(&state.db, "tina")
            .await
            .expect("load")
            .expect("tina");
        assert_eq!(user.password_kind, "words");
        assert!(verify_password(&seven.join(" "), &user.password_hash).await);
        assert!(!verify_password("a", &user.password_hash).await);
        assert_eq!(tokens_of(&state, "tina").await, vec![mine.clone()]);
        assert_eq!(tokens_of(&state, "bob").await, vec![other]);
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::TokensRevoked { username }) if username == "tina"
        ));
        let me = me_payload(&state.db, &user).await.expect("me");
        assert_eq!(me.password_kind, "words");
        rewind(&state).await;
        let shouted: Vec<String> = seven.iter().map(|w| w.to_uppercase()).collect();
        let second = login(
            State(state.clone()),
            Json(LoginReq {
                username: "tina".to_string(),
                password: None,
                words: Some(shouted.clone()),
            }),
        )
        .await
        .expect("login with words")
        .0
        .token;
        rewind(&state).await;
        let _ = change(&state, "tina", &second, picked(&shouted), text("new pass"))
            .await
            .expect("words to text");
        let user = get_user(&state.db, "tina")
            .await
            .expect("load")
            .expect("tina");
        assert_eq!(user.password_kind, "text");
        assert!(verify_password("new pass", &user.password_hash).await);
        assert_eq!(tokens_of(&state, "tina").await, vec![second]);
        rewind(&state).await;
        let ok = login(
            State(state.clone()),
            Json(LoginReq {
                username: "tina".to_string(),
                password: Some("new pass".to_string()),
                words: None,
            }),
        )
        .await;
        assert!(ok.is_ok());
        done(state, path).await;
    }

    #[tokio::test]
    async fn password_change_rejects_wrong_current_and_bad_new() {
        let (state, path) = temp_state("password_change_reject").await;
        let mine = register_text(&state, "uma")
            .await
            .expect("register")
            .0
            .token;
        add_token(&state, "uma", "other").await;
        let before = tokens_of(&state, "uma").await;
        let hash = get_user(&state.db, "uma")
            .await
            .expect("load")
            .expect("uma")
            .password_hash;
        let words = word_set("uma");
        let wrong = change(&state, "uma", &mine, text("nope"), text("b")).await;
        assert!(
            matches!(&wrong, Err(ApiError(StatusCode::UNAUTHORIZED, m)) if m == "Wrong password")
        );
        assert_eq!(failures(&state, &mine).await, 1);
        let fast = change(&state, "uma", &mine, text("a"), text("b")).await;
        assert!(matches!(
            fast,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
        ));
        assert_eq!(failures(&state, &mine).await, 1);
        rewind(&state).await;
        let wrong_words = change(&state, "uma", &mine, picked(&words[..7]), text("b")).await;
        assert!(matches!(
            wrong_words,
            Err(ApiError(StatusCode::UNAUTHORIZED, _))
        ));
        assert_eq!(failures(&state, &mine).await, 2);
        rewind(&state).await;
        let invalid = [
            text(""),
            picked(&words[..6]),
            picked(
                &[
                    vec!["definitelynotintheset".to_string()],
                    words[..6].to_vec(),
                ]
                .concat(),
            ),
            Secret {
                password: None,
                words: None,
            },
            Secret {
                password: Some("b".to_string()),
                words: Some(words[..7].to_vec()),
            },
        ];
        for new in invalid {
            let res = change(&state, "uma", &mine, text("a"), new).await;
            assert!(matches!(res, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        }
        let no_current = change(
            &state,
            "uma",
            &mine,
            Secret {
                password: None,
                words: None,
            },
            text("b"),
        )
        .await;
        assert!(matches!(
            no_current,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        assert_eq!(failures(&state, &mine).await, 2);
        assert_eq!(attempts(&state, "uma").await, 0);
        let user = get_user(&state.db, "uma")
            .await
            .expect("load")
            .expect("uma");
        assert_eq!(user.password_hash, hash);
        assert_eq!(user.password_kind, "text");
        assert_eq!(tokens_of(&state, "uma").await, before);
        sqlx::query("UPDATE change_attempts SET failures = 50 WHERE session = $1")
            .bind(session_key(&mine))
            .execute(&state.db)
            .await
            .expect("prime failures");
        rewind(&state).await;
        let locked = change(&state, "uma", &mine, text("a"), text("b")).await;
        assert!(matches!(locked, Err(ApiError(StatusCode::LOCKED, _))));
        assert_eq!(failures(&state, "other").await, 0);
        let owner = change(&state, "uma", "other", text("a"), text("b")).await;
        assert!(owner.is_ok());
        assert_eq!(tokens_of(&state, "uma").await, vec!["other".to_string()]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn racing_password_changes_keep_one_winner_and_its_token() {
        let (state, path) = temp_state("password_race").await;
        let mine = register_text(&state, "vic")
            .await
            .expect("register")
            .0
            .token;
        add_token(&state, "vic", "thief").await;
        let stale = get_user(&state.db, "vic")
            .await
            .expect("load")
            .expect("vic");
        let (a, b) = tokio::join!(
            change_as(&state, stale.clone(), &mine, text("a"), text("p1")),
            change_as(&state, stale.clone(), "thief", text("a"), text("p2")),
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let left = tokens_of(&state, "vic").await;
        assert_eq!(left.len(), 1);
        let user = get_user(&state.db, "vic")
            .await
            .expect("load")
            .expect("vic");
        let winner = match a.is_ok() {
            true => (mine.clone(), "p1"),
            false => ("thief".to_string(), "p2"),
        };
        assert_eq!(left, vec![winner.0]);
        assert!(verify_password(winner.1, &user.password_hash).await);
        sqlx::query("DELETE FROM tokens WHERE username = 'vic'")
            .execute(&state.db)
            .await
            .expect("reset tokens");
        add_token(&state, "vic", "first").await;
        add_token(&state, "vic", "second").await;
        let stale = user;
        rewind(&state).await;
        let _ = change_as(&state, stale.clone(), "first", text(winner.1), text("p3"))
            .await
            .expect("first change");
        rewind(&state).await;
        let late = change_as(&state, stale, "second", text(winner.1), text("p4")).await;
        assert!(
            matches!(&late, Err(ApiError(StatusCode::UNAUTHORIZED, m)) if m == "Wrong password")
        );
        assert_eq!(tokens_of(&state, "vic").await, vec!["first".to_string()]);
        let user = get_user(&state.db, "vic")
            .await
            .expect("load")
            .expect("vic");
        assert!(verify_password("p3", &user.password_hash).await);
        done(state, path).await;
    }

    #[tokio::test]
    async fn login_verified_against_old_hash_gets_no_token() {
        let (state, path) = temp_state("login_stale").await;
        let mine = register_text(&state, "lou")
            .await
            .expect("register")
            .0
            .token;
        let stale = get_user(&state.db, "lou")
            .await
            .expect("load")
            .expect("lou");
        let _ = change(&state, "lou", &mine, text("a"), text("b"))
            .await
            .expect("change");
        let late = issue_token(&state.db, &stale, now()).await;
        assert!(
            matches!(&late, Err(ApiError(StatusCode::UNAUTHORIZED, m)) if m == "Invalid credentials")
        );
        assert_eq!(tokens_of(&state, "lou").await, vec![mine]);
        let fresh = get_user(&state.db, "lou")
            .await
            .expect("load")
            .expect("lou");
        let token = issue_token(&state.db, &fresh, now())
            .await
            .expect("fresh hash issues");
        assert!(tokens_of(&state, "lou").await.contains(&token));
        done(state, path).await;
    }

    #[tokio::test]
    async fn throttle_admits_one_of_concurrent_attempts() {
        let (state, path) = temp_state("throttle_race").await;
        let t = now();
        let tries: Vec<_> = (0..12)
            .map(|_| {
                let db = state.db.clone();
                tokio::spawn(async move { throttle_attempt(&db, "zed", t).await })
            })
            .collect();
        let mut admitted = 0;
        for task in tries {
            match task.await.expect("join") {
                Ok(()) => admitted += 1,
                Err(ApiError(status, _)) => assert_eq!(status, StatusCode::TOO_MANY_REQUESTS),
            }
        }
        assert_eq!(admitted, 1);
        assert_eq!(attempts(&state, "zed").await, 1);
        assert!(throttle_attempt(&state.db, "zed", t + 3).await.is_ok());
        assert!(matches!(
            throttle_attempt(&state.db, "zed", t + 86400 * 2).await,
            Ok(())
        ));
        assert_eq!(attempts(&state, "zed").await, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn login_lockout_does_not_block_password_change() {
        let (state, path) = temp_state("lockout_change").await;
        let mine = register_text(&state, "ann")
            .await
            .expect("register")
            .0
            .token;
        add_token(&state, "ann", "thief").await;
        let t = now();
        for n in 0..1001 {
            let _ = throttle_attempt(&state.db, "ann", t + 3 * n).await;
        }
        let locked = login(
            State(state.clone()),
            Json(LoginReq {
                username: "ann".to_string(),
                password: Some("a".to_string()),
                words: None,
            }),
        )
        .await;
        assert!(matches!(locked, Err(ApiError(StatusCode::LOCKED, _))));
        let _ = change(&state, "ann", &mine, text("a"), text("b"))
            .await
            .expect("change despite login lockout");
        assert_eq!(tokens_of(&state, "ann").await, vec![mine]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn gap_rejected_logins_are_not_counted() {
        let (state, path) = temp_state("gap_uncounted").await;
        let t = now();
        assert!(throttle_attempt(&state.db, "gus", t).await.is_ok());
        for _ in 0..50 {
            assert!(matches!(
                throttle_attempt(&state.db, "gus", t).await,
                Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
            ));
        }
        assert_eq!(attempts(&state, "gus").await, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn logout_revokes_only_the_current_token() {
        let (state, path) = temp_state("logout").await;
        let mine = register_text(&state, "lea")
            .await
            .expect("register")
            .0
            .token;
        add_token(&state, "lea", "phone").await;
        let user = get_user(&state.db, "lea")
            .await
            .expect("load")
            .expect("lea");
        let mut rx = state.hub.subscribe();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {mine}").parse().expect("header"),
        );
        let _ = logout(State(state.clone()), Authed(user), headers)
            .await
            .expect("logout");
        assert_eq!(tokens_of(&state, "lea").await, vec!["phone".to_string()]);
        assert!(crate::api::user_for_token(&state, &mine).await.is_none());
        assert!(crate::api::user_for_token(&state, "phone").await.is_some());
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::TokensRevoked { username }) if username == "lea"
        ));
        done(state, path).await;
    }

    #[tokio::test]
    async fn appear_offline_persists() {
        let (state, path) = temp_state("appear_offline").await;
        let _ = register_text(&state, "olive").await.expect("register");
        let mut rx = state.hub.subscribe();
        let patch =
            |avatar_kind: Option<AvatarKind>, avatar_color: Option<&str>, appear_offline| {
                let state = state.clone();
                let avatar_color = avatar_color.map(str::to_string);
                async move {
                    let user = get_user(&state.db, "olive")
                        .await
                        .expect("load user")
                        .expect("user exists");
                    patch_me(
                        State(state),
                        Authed(user),
                        Json(MePatch {
                            avatar_kind,
                            avatar_color,
                            appear_offline,
                            banner_color: None,
                            bio: None,
                        }),
                    )
                    .await
                    .expect("patch me")
                }
            };
        let stored = |state: AppState| async move {
            let user = get_user(&state.db, "olive")
                .await
                .expect("load user")
                .expect("user exists");
            me_payload(&state.db, &user)
                .await
                .expect("me payload")
                .appear_offline
        };
        assert!(!stored(state.clone()).await);
        let _ = patch(None, None, Some(true)).await;
        assert!(stored(state.clone()).await);
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::PresenceMode { username, appear_offline: true }) if username == "olive"
        ));
        let _ = patch(Some(AvatarKind::Identicon), None, None).await;
        assert!(stored(state.clone()).await);
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::UserUpdated { user: _, scope: _ })
        ));
        let _ = patch(None, None, Some(false)).await;
        assert!(!stored(state.clone()).await);
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::PresenceMode {
                username: _,
                appear_offline: false
            })
        ));
        let both = patch(Some(AvatarKind::Color), Some("#ABCDEF"), Some(true))
            .await
            .0;
        assert_eq!(both.user.avatar_color.as_deref(), Some("#abcdef"));
        assert!(stored(state.clone()).await);
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::UserUpdated { user, scope: _ }) if user.avatar_color.as_deref() == Some("#abcdef")
        ));
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::PresenceMode {
                username: _,
                appear_offline: true
            })
        ));
        done(state, path).await;
    }

    #[test]
    fn bio_is_cleaned_and_limited() {
        assert_eq!(clean_bio("").expect("empty"), None);
        assert_eq!(clean_bio(" \n\t \n ").expect("blank"), None);
        assert_eq!(
            clean_bio("  hi\u{7} there \u{200b}\r\n").expect("trim"),
            Some("hi there \u{200b}".to_string())
        );
        assert_eq!(
            clean_bio("a\n\n\n\n\nb\n\nc\nd").expect("newlines"),
            Some("a\n\nb\n\nc\nd".to_string())
        );
        assert_eq!(
            clean_bio("a\r\n\r\n\r\nb").expect("crlf"),
            Some("a\n\nb".to_string())
        );
        let max = "é".repeat(BIO_MAX);
        assert_eq!(clean_bio(&max).expect("max"), Some(max.clone()));
        assert_eq!(
            clean_bio(&format!("  {max}\n\n\n")).expect("trimmed to max"),
            Some(max.clone())
        );
        assert!(matches!(
            clean_bio(&format!("{max}x")),
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        assert_eq!(
            clean_bio(&format!("{}\n\n\n\n{}", "a".repeat(94), "b".repeat(94)))
                .expect("collapsed fits")
                .map(|b| b.chars().count()),
            Some(190)
        );
        assert_eq!(
            clean_bio("\u{a0}\u{2003}hi\u{3000}\u{2029}").expect("unicode spaces"),
            Some("hi".to_string())
        );
        assert_eq!(
            clean_bio(" \u{feff} ").expect("bom kept"),
            Some("\u{feff}".to_string())
        );
        let edged = format!("\u{feff}{}\u{200b}", "a".repeat(BIO_MAX - 2));
        assert_eq!(edged.chars().count(), BIO_MAX);
        assert_eq!(
            clean_bio(&format!(" {edged}\n")).expect("edged fits"),
            Some(edged.clone())
        );
        for over in [format!("\u{feff}{edged}"), format!("{edged}\u{2060}")] {
            assert!(matches!(
                clean_bio(&over),
                Err(ApiError(StatusCode::BAD_REQUEST, _))
            ));
        }
    }

    #[tokio::test]
    async fn bio_is_saved_shown_and_broadcast() {
        let (state, path) = temp_state("bio_patch").await;
        let _ = register_text(&state, "bea").await.expect("register");
        let mut rx = state.hub.subscribe();
        let patch = |body: &str| {
            let state = state.clone();
            let body = body.to_string();
            async move {
                let user = get_user(&state.db, "bea")
                    .await
                    .expect("load user")
                    .expect("user exists");
                let req: MePatch = serde_json::from_str(&body).expect("patch body");
                patch_me(State(state), Authed(user), Json(req))
                    .await
                    .map(|r| r.0.bio)
            }
        };
        let shown = |state: AppState| async move {
            let user = get_user(&state.db, "bea")
                .await
                .expect("load user")
                .expect("user exists");
            let me = me_payload(&state.db, &user).await.expect("me").bio;
            let profile = crate::api::users::profile(
                State(state.clone()),
                crate::api::MaybeAuthed(None),
                HeaderMap::new(),
                axum::extract::Path("bea".to_string()),
                axum::extract::Query(serde_json::from_str("{}").expect("empty profile query")),
            )
            .await
            .expect("profile")
            .0
            .bio;
            assert_eq!(me, profile);
            me
        };
        assert_eq!(shown(state.clone()).await, None);
        assert_eq!(
            patch(r#"{"bio":"  Hello\n\n\n\nworld \u0007"}"#)
                .await
                .expect("set"),
            Some("Hello\n\nworld".to_string())
        );
        assert_eq!(
            shown(state.clone()).await.as_deref(),
            Some("Hello\n\nworld")
        );
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::UserUpdated { user, scope: _ }) if user.username == "bea"
        ));
        assert_eq!(
            patch(r#"{"appear_offline":false}"#)
                .await
                .expect("other field")
                .as_deref(),
            Some("Hello\n\nworld")
        );
        assert!(!matches!(
            rx.try_recv(),
            Ok(WsEvent::UserUpdated { user: _, scope: _ })
        ));
        assert_eq!(
            patch(r#"{"bio":"Hello\n\nworld  "}"#)
                .await
                .expect("unchanged")
                .as_deref(),
            Some("Hello\n\nworld")
        );
        assert!(rx.try_recv().is_err());
        let long = format!(r#"{{"bio":"{}"}}"#, "x".repeat(BIO_MAX + 1));
        assert!(matches!(
            patch(&long).await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        assert!(matches!(
            patch(r#"{"bio":"what the fuck"}"#).await,
            Err(ApiError(StatusCode::BAD_REQUEST, e)) if e.contains("profanity")
        ));
        assert_eq!(
            shown(state.clone()).await.as_deref(),
            Some("Hello\n\nworld")
        );
        sqlx::query("UPDATE settings SET value = '0' WHERE key = 'profanity_bios'")
            .execute(&state.db)
            .await
            .expect("bios off");
        crate::api::Settings::forget(&state.db);
        assert_eq!(
            patch(r#"{"bio":"what the fuck"}"#)
                .await
                .expect("bios target off")
                .as_deref(),
            Some("what the fuck")
        );
        assert!(
            check_profanity(&state.db, ProfanityTarget::Messages, "fuck")
                .await
                .is_err()
        );
        sqlx::query("UPDATE settings SET value = '1' WHERE key = 'profanity_bios'")
            .execute(&state.db)
            .await
            .expect("bios on");
        crate::api::Settings::forget(&state.db);
        assert_eq!(patch(r#"{"bio":"   "}"#).await.expect("blank"), None);
        assert_eq!(shown(state.clone()).await, None);
        while rx.try_recv().is_ok() {}
        assert_eq!(patch(r#"{"bio":null}"#).await.expect("still empty"), None);
        assert!(rx.try_recv().is_err());
        let _ = patch(r#"{"bio":"back"}"#).await.expect("set again");
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::UserUpdated { user, scope: _ }) if user.username == "bea"
        ));
        assert_eq!(patch(r#"{"bio":null}"#).await.expect("null"), None);
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::UserUpdated { user, scope: _ }) if user.username == "bea"
        ));
        assert_eq!(shown(state.clone()).await, None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn guests_cannot_set_a_bio() {
        use crate::server::client_ip::ProxyTrust;
        let (state, path) = temp_state("bio_guest").await;
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app = crate::api::routes(
            state.clone(),
            &crate::config::Roles::ALL,
            crate::server::client_ip::ClientIp(trusted),
        )
        .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
        });
        let client = reqwest::Client::new();
        for grant in [None, Some("some-guest-grant")] {
            let mut req = client
                .patch(format!("http://{addr}/me"))
                .header("content-type", "application/json")
                .body(r#"{"bio":"hi"}"#);
            if let Some(grant) = grant {
                req = req.header("x-guest-grant", grant);
            }
            let res = req.send().await.expect("request");
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{grant:?}");
        }
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn cached_verification_tracks_the_hash() {
        let hash = hash_password("pw").await.expect("hash");
        assert!(verify_password_cached("pw", &hash).await);
        assert!(!verify_password_cached("nope", &hash).await);
        assert!(verify_password_cached("pw", &hash).await);
        let other = hash_password("pw2").await.expect("hash");
        assert!(!verify_password_cached("pw", &other).await);
        assert!(verify_password_cached("pw2", &other).await);
    }
}
