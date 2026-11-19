use std::sync::LazyLock;

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

use crate::api::access::not_found;
use crate::api::dms::{DmOrder, dm_page};
use crate::api::names::Refusal;
use crate::api::rare::{self, Rare};
use crate::api::servers::{Page, my_servers_page};
use crate::api::system_messages::{SystemKind, announce_system, post_system};
use crate::api::{
    ApiError, ApiErrorBody, Authed, DmSummary, LIST_PAGE, Member, NAME_MAX, OkResp,
    ProfanityTarget, ServerSummary, Settings, UserRef, bad, check_len, check_profanity, names, ok,
    request_token, valid_color,
};
use crate::db::{
    AvatarKind, Db, NotAdded, User, get_user, lock_server, now, secret_key, shift_member_count,
};
use crate::state::AppState;
use crate::ws::WsEvent;

/// The signed-in user's own account, with the first page of their servers and DMs.
#[derive(Serialize, ToSchema)]
pub struct Me {
    /// Lowercase username, the account's unique key.
    #[schema(example = "alice")]
    pub username: String,
    /// The name shown for the user: the username as registered until they change it.
    #[schema(example = "Alice")]
    pub display_name: String,
    /// Avatar style: a generated identicon or a solid color.
    pub avatar_kind: AvatarKind,
    /// Lowercase `#rrggbb` avatar color when `avatar_kind` is `color`. For identicons it is the
    /// chosen background color, or null for the default background.
    #[schema(example = "#3366ff")]
    pub avatar_color: Option<String>,
    /// Lowercase `#rrggbb` profile banner color; null means the default derived from the avatar.
    #[schema(example = "#112233")]
    pub banner_color: Option<String>,
    /// Profile description (at most 190 characters, may contain newlines); null when unset.
    pub bio: Option<String>,
    #[schema(ignore)]
    pub is_site_admin: bool,
    /// Whether the user chose to appear offline: others do not see them as online.
    pub appear_offline: bool,
    #[schema(schema_with = password_kind_schema)]
    pub password_kind: String,
    /// First page (up to 50) of the servers the user has joined, oldest join first.
    pub servers: Vec<ServerSummary>,
    /// Whether more joined servers follow; fetch them from `GET /api/v1/me/servers`.
    pub servers_more: bool,
    /// `cursor` value for the next page of `GET /api/v1/me/servers`; null when there are no more.
    pub servers_cursor: Option<String>,
    /// First page (up to 50) of the user's DM conversations: the self DM first, then by latest
    /// message, newest first.
    pub dms: Vec<DmSummary>,
    /// Whether more DMs follow; fetch them from `GET /api/v1/dms`.
    pub dms_more: bool,
    /// `cursor` value for the next page of `GET /api/v1/dms`; null when there are no more.
    pub dms_cursor: Option<String>,
    /// Whether this account may create servers (`server_creation` in `GET /api/v1/settings`
    /// applied to it).
    pub can_create_servers: bool,
}

fn password_kind_schema() -> utoipa::openapi::Object {
    utoipa::openapi::ObjectBuilder::new()
        .schema_type(utoipa::openapi::Type::String)
        .enum_values(Some(["text", "words"]))
        .description(Some("How the account signs in: a text password or 7 words"))
        .build()
}

/// A new session and the account it belongs to.
#[derive(Serialize, ToSchema)]
pub struct AuthResp {
    /// Session token (64 hex characters). Send it as `Authorization: Bearer <token>`. It does
    /// not expire; it stays valid until logout, a password change from another session or a
    /// recovery.
    pub token: String,
    /// The signed-in user's account, as returned by `GET /api/v1/me`.
    pub user: Me,
}

/// The candidate words of a word-password account.
#[derive(Serialize, ToSchema)]
pub struct WordsResp {
    /// 20 distinct lowercase words, derived deterministically from the lowercase username.
    #[schema(example = json!(["apple", "river", "stone"]))]
    pub words: Vec<String>,
}

/// A new account. Give exactly one of `password` or `words`.
#[derive(Deserialize, ToSchema)]
pub struct RegisterReq {
    /// 1 to 100 characters, not blank, without `@`, control, format or invisible characters,
    /// variation selectors, spaces other than U+0020 or spaces at either end. Unique
    /// case-insensitively and in look-alike characters: a name that passes for another account's
    /// username or a banned one is refused. The given case becomes the display name. Checked by
    /// the profanity filter (`usernames` target).
    #[schema(example = "Alice")]
    username: String,
    /// A non-empty text password. Omit when using `words`.
    password: Option<String>,
    /// Exactly 7 words picked from `GET /api/v1/auth/words/{username}` (case-insensitive). Their
    /// order matters: logging in needs the same words in the same order. Omit when using
    /// `password`.
    words: Option<Vec<String>>,
    /// Avatar style.
    avatar_kind: AvatarKind,
    /// `#rrggbb` color, stored lowercase. Required when `avatar_kind` is `color`. For
    /// `identicon` it is the optional background color; omit it for the default background.
    #[schema(example = "#3366ff")]
    avatar_color: Option<String>,
}

/// Login credentials. Give exactly one of `password` or `words`.
#[derive(Deserialize, ToSchema)]
pub struct LoginReq {
    /// Username, case-insensitive. A name that passes for exactly one account's username in
    /// look-alike characters signs in to that account.
    #[schema(example = "alice")]
    username: String,
    /// The text password. Omit when using `words`.
    password: Option<String>,
    /// The account's 7 words in the order they were chosen (case-insensitive). Omit when using
    /// `password`.
    words: Option<Vec<String>>,
}

/// A password: exactly one of `password` or `words`.
#[derive(Deserialize, ToSchema)]
pub struct Secret {
    /// A text password (a new one must not be empty). Omit when using `words`.
    pub(crate) password: Option<String>,
    /// 7 words, case-insensitive and in order. For a new password they must come from
    /// `GET /api/v1/auth/words/{username}`. Omit when using `password`.
    pub(crate) words: Option<Vec<String>>,
}

/// A password change.
#[derive(Deserialize, ToSchema)]
pub struct PasswordChange {
    /// The account's current password or words.
    current: Secret,
    /// The new password or words. Either kind is allowed, regardless of the current one.
    new: Secret,
    /// `false` also removes the account's backup phrase. Omit or `true` to keep it.
    keep_recovery: Option<bool>,
}

fn word_set(username: &str) -> Vec<String> {
    let seed: [u8; 32] = Sha256::digest(username.to_lowercase().as_bytes()).into();
    let mut rng = ChaCha8Rng::from_seed(seed);
    rand::seq::index::sample(&mut rng, memorable_wordlist::WORDS.len(), 20)
        .into_iter()
        .map(|i| memorable_wordlist::WORDS[i].to_string())
        .collect()
}

/// Argon2 work runs under one budget. `Account` work (login, registration, password changes)
/// may use every permit, `Server` work (server passwords) only the shared ones, so that a flood
/// of server password attempts can not stop people from signing in. `Server` work waits in a
/// bounded queue and is refused when the queue is full.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Work {
    Account,
    Server,
}

fn cores() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

pub(crate) fn reserved_permits(cores: usize) -> usize {
    (cores / 4).max(1)
}

static SHARED: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(cores().saturating_sub(reserved_permits(cores())).max(1)));
static RESERVED: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(reserved_permits(cores())));
static SERVER_WAITING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub(crate) const SERVER_QUEUE_MAX: usize = 64;

/// Places in the server work queue (waiting or running) per client address (an IPv6 /64) and
/// per wider network (IPv4 /24, IPv6 /48), so that many addresses of one network can not fill it.
static SERVER_ADDRESS: LazyLock<crate::api::budget::Slots> =
    LazyLock::new(|| crate::api::budget::Slots::new(SERVER_ADDRESS_MAX));
static SERVER_NETWORK: LazyLock<crate::api::budget::Slots> =
    LazyLock::new(|| crate::api::budget::Slots::new(SERVER_NETWORK_MAX));

pub(crate) const SERVER_ADDRESS_MAX: usize = 16;
pub(crate) const SERVER_NETWORK_MAX: usize = 32;

/// The per-address and per-network places of the current client, if it has an address.
fn client_slots() -> Result<Vec<crate::api::budget::Slot>, ApiError> {
    use crate::api::budget::{client, group, slow_down, wide};
    let Some(ip) = client() else {
        return Ok(Vec::new());
    };
    let address = SERVER_ADDRESS.enter(group(ip).to_string());
    let network = SERVER_NETWORK.enter(wide(ip).to_string());
    match (address, network) {
        (Some(a), Some(n)) => Ok(vec![a, n]),
        (_, _) => Err(slow_down()),
    }
}

/// A place in a bounded wait queue; dropping it leaves the queue.
struct Waiting(&'static std::sync::atomic::AtomicUsize);

impl Waiting {
    fn enter(queue: &'static std::sync::atomic::AtomicUsize, max: usize) -> Option<Waiting> {
        use std::sync::atomic::Ordering;
        match queue.fetch_add(1, Ordering::SeqCst) < max {
            true => Some(Waiting(queue)),
            false => {
                queue.fetch_sub(1, Ordering::SeqCst);
                None
            }
        }
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::from(anyhow::anyhow!("{e}"))
}

async fn off_runtime<T: Send + 'static>(
    work: Work,
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError> {
    let _held = match work {
        Work::Account => tokio::select! {
            p = SHARED.acquire() => (p.map_err(internal)?, Vec::new()),
            p = RESERVED.acquire() => (p.map_err(internal)?, Vec::new()),
        },
        Work::Server => {
            let slots = client_slots()?;
            let Some(waiting) = Waiting::enter(&SERVER_WAITING, SERVER_QUEUE_MAX) else {
                return Err(crate::api::budget::slow_down());
            };
            let permit = SHARED.acquire().await.map_err(internal)?;
            drop(waiting);
            (permit, slots)
        }
    };
    tokio::task::spawn_blocking(job).await.map_err(internal)
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
    hash_in(Work::Account, secret).await
}

#[cfg(test)]
thread_local! {
    static HASH_RUNS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn hash_runs() -> u64 {
    HASH_RUNS.with(|c| c.get())
}

pub(crate) async fn hash_in(work: Work, secret: &str) -> Result<String, ApiError> {
    #[cfg(test)]
    HASH_RUNS.with(|c| c.set(c.get() + 1));
    let secret = secret.to_string();
    off_runtime(work, move || hash_now(&secret)).await?
}

#[cfg(test)]
thread_local! {
    static VERIFY_RUNS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn verify_runs() -> u64 {
    VERIFY_RUNS.with(|c| c.get())
}

pub(crate) async fn verify_password(secret: &str, hash: &str) -> bool {
    verify_in(Work::Account, secret, hash)
        .await
        .unwrap_or(false)
}

pub(crate) async fn verify_in(work: Work, secret: &str, hash: &str) -> Result<bool, ApiError> {
    #[cfg(test)]
    VERIFY_RUNS.with(|c| c.set(c.get() + 1));
    let (secret, hash) = (secret.to_string(), hash.to_string());
    off_runtime(work, move || verify_now(&secret, &hash)).await
}

#[cfg(test)]
thread_local! {
    static DERIVE_RUNS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn derive_runs() -> u64 {
    DERIVE_RUNS.with(|c| c.get())
}

/// Argon2id of `secret` under a fixed `salt`, with the same parameters as `verify_password`,
/// hex-encoded. Deterministic, so it can be looked up.
pub(crate) async fn derive_key(secret: &str, salt: [u8; 16]) -> Result<String, ApiError> {
    #[cfg(test)]
    DERIVE_RUNS.with(|c| c.set(c.get() + 1));
    let secret = secret.to_string();
    off_runtime(Work::Server, move || {
        let mut out = [0u8; 32];
        Argon2::default()
            .hash_password_into(secret.as_bytes(), &salt, &mut out)
            .map(|()| hex::encode(out))
            .map_err(|e| ApiError::from(anyhow::anyhow!(e)))
    })
    .await?
}

static DUMMY_HASH: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

pub(crate) async fn dummy_hash() -> &'static str {
    match DUMMY_HASH
        .get_or_try_init(|| hash_password_owned(new_token()))
        .await
    {
        Ok(hash) => hash.as_str(),
        Err(_) => "",
    }
}

async fn hash_password_owned(secret: String) -> Result<String, ApiError> {
    hash_password(&secret).await
}

pub(crate) fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn wait_between() -> ApiError {
    ApiError::rate("Wait 3 seconds between attempts", Some(3))
}

fn check_avatar(
    avatar_kind: AvatarKind,
    avatar_color: Option<String>,
) -> Result<Option<String>, ApiError> {
    match (avatar_kind, avatar_color) {
        (AvatarKind::Identicon, None) => Ok(None),
        (AvatarKind::Identicon | AvatarKind::Color, Some(color)) if valid_color(&color) => {
            Ok(Some(color.to_lowercase()))
        }
        (AvatarKind::Identicon, Some(_)) | (AvatarKind::Color, _) => {
            Err(bad("Invalid avatar color"))
        }
    }
}

pub(crate) const PICK_WORDS: &str = "Pick 7 words from your word set";

/// Whether every word of a `words` secret from `secret_from` is in the word set of `username`.
pub(crate) fn in_word_set(username: &str, secret: &str) -> bool {
    let set = word_set(username);
    secret.split(' ').all(|w| set.iter().any(|s| s == w))
}

pub(crate) fn secret_from(
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
                    return Err(bad(PICK_WORDS));
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
    } = dm_page(db, &user.username, DmOrder::default(), 0, None, LIST_PAGE).await?;
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
        can_create_servers: crate::api::policy::effective(db, Some(user))
            .await
            .can_create_servers()
            .await?,
    })
}

/// Get the word set for a username
///
/// Returns the 20 candidate words for word-based passwords. The set is derived
/// deterministically from the lowercase username, so it is the same on every call and exists
/// for any username, registered or not. Accounts pick 7 of these words at registration or when
/// changing their password. No authentication. Strict and general rate-limit buckets.
#[utoipa::path(get, path = "/api/v1/auth/words/{username}", tag = "Auth", params(("username" = String, Path, description = "Any username, case-insensitive; it does not have to exist")), responses((status = 200, description = "The 20 candidate words derived deterministically from the username; word-based accounts pick 7 of them", body = WordsResp), (status = 429, description = "Too many requests in the strict bucket", body = ApiErrorBody)), security(()))]
pub(crate) async fn words(Path(username): Path<String>) -> Json<WordsResp> {
    Json(WordsResp {
        words: word_set(&username),
    })
}

/// The default servers in the order a sign-up locks them: by key, so two sign-ups that read
/// the list before and after a reorder never wait on each other.
fn lock_order(defaults: &[String]) -> Vec<&str> {
    let mut keys: Vec<&str> = defaults.iter().map(String::as_str).collect();
    keys.sort_unstable();
    keys.dedup();
    keys
}

/// Create an account
///
/// Registers a user with either a text password or 7 words from their word set, signs them in
/// and returns a session token. The new user joins the instance's default servers in their
/// order (`rchat` unless the instance changed the list; each emits `member_joined` to its
/// members and to the user, plus its join message as `message` when join messages are on) and
/// gets their self DM. A default server that is missing, or that bans the username, is skipped. Answers 404 unless `registration` is `open` and
/// `password_login` is on in `GET /api/v1/settings`. No authentication.
/// Strict and general rate-limit buckets.
/// Sign-ups are rare requests: at most `RARE_REQUESTS_PER_HOUR` (20) an hour and
/// `RARE_REQUESTS_PER_DAY` (100) a day per client address (an IPv6 /64 counts as one) by default,
/// whatever the username.
#[utoipa::path(post, path = "/api/v1/auth/register", tag = "Auth", request_body = RegisterReq, responses((status = 200, description = "Account created; returns a session token and the new user's profile", body = AuthResp), (status = 400, description = "Blank (also a name of only marks or variation selectors), too long (over 100 characters, also in lower case), NUL-containing, `@`-containing or profanity-filtered username; a username that holds control, format or invisible characters (`Username has invalid characters`); one that holds a variation selector or a space other than U+0020, starts or ends with a space, or is or passes for another account's username in another case or in look-alike characters, or mixes letters so that it would pass for more names than an account stores (a capital that passes for l next to a Cherokee letter, for example) (`Username is taken`); one that is or passes for a banned username (`Username is banned`); empty password; not exactly one of `password` and `words`; words that are not 7 words from the word set; a missing or invalid avatar color for `color` avatars; or an invalid background color for `identicon` avatars. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 404, description = "`Not found`: password sign-up is off (`registration` is not `open`, or `password_login` is off)", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. Too many requests in the strict bucket", body = ApiErrorBody)), security(()))]
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
    if !Settings::cached(&state.db).await.password_signup() {
        return Err(not_found());
    }
    rare::take(&state, Rare::SignUp, None)?;
    if username.trim().is_empty() || username.contains('\0') {
        return Err(bad("Username required"));
    }
    check_len(&username, NAME_MAX, "Username")?;
    let key = username.to_lowercase();
    check_len(&key, NAME_MAX, "Username")?;
    if username.contains('@') {
        return Err(bad("Usernames can't contain @"));
    }
    if username.chars().any(names::hidden_char) {
        return Err(bad("Username has invalid characters"));
    }
    if names::name_keys(&username).iter().any(String::is_empty) {
        return Err(bad("Username required"));
    }
    if password.as_deref() == Some("") {
        return Err(bad("Password required"));
    }
    let (secret, password_kind) = secret_from(&username, password, words, true)?;
    let avatar_color = check_avatar(avatar_kind, avatar_color)?;
    check_profanity(&state.db, ProfanityTarget::Usernames, &username).await?;
    let password_hash = hash_password(&secret).await?;
    let defaults = crate::api::policy::Policy::cached(&state.db)
        .await
        .default_servers
        .clone();
    let mut tx = state.db.begin().await?;
    for server in lock_order(&defaults) {
        lock_server(&mut tx, server).await?;
    }
    let user_count: i64 = sqlx::query("SELECT COUNT(*) FROM (SELECT 1 FROM users LIMIT 1) t")
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    let t = now();
    crate::db::insert_user(
        &mut tx,
        crate::db::NewUser {
            username: &key,
            display_name: &username,
            password_hash: &password_hash,
            password_kind,
            avatar_kind: avatar_kind.as_str(),
            avatar_color: avatar_color.as_deref(),
            is_site_admin: user_count == 0,
            created_at: t,
        },
    )
    .await?;
    let mut joined = Vec::new();
    for server in &defaults {
        let inserted = sqlx::query(
            "INSERT INTO members(server, username, is_admin, joined_at) SELECT s.name, $2, 0, $3 FROM servers s WHERE s.name = $1 AND COALESCE(s.password_hash, '') <> '!purging' AND NOT EXISTS(SELECT 1 FROM server_bans b WHERE b.server = s.name AND b.username = $2)",
        )
        .bind(server)
        .bind(&key)
        .bind(t)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if inserted == 0 {
            continue;
        }
        shift_member_count(&mut tx, server, 1).await?;
        let notice = post_system(&mut tx, server, &key, SystemKind::Join).await?;
        joined.push((server.clone(), notice));
    }
    sqlx::query("INSERT INTO dms(user_a, user_b) VALUES($1, $2)")
        .bind(&key)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    let token = new_token();
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, $3)")
        .bind(secret_key(&token))
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
    for (server, notice) in joined {
        state.hub.broadcast(WsEvent::MemberJoined {
            server: server.clone(),
            member: Member {
                user: UserRef::from_user(&user),
                is_admin: false,
                is_creator: false,
                online: false,
                perms: 0,
                role_ids: Vec::new(),
                joined_via: None,
                timeout: None,
            },
        });
        announce_system(&state, &server, notice).await;
    }
    state.hub.broadcast(WsEvent::UserRegistered {
        user: UserRef::from_user(&user),
    });
    Ok(Json(AuthResp { token, user: me }))
}

/// Paces and counts one login or recovery attempt under each of `rows`, in that order, in one
/// transaction: admitted only when every row had no attempt in the last 3 seconds, so a refused
/// attempt counts nowhere. Over 1000 attempts today in any row answers 423.
pub(crate) async fn throttle_attempt(
    db: &Db,
    rows: &[impl AsRef<str>],
    t: i64,
) -> Result<(), ApiError> {
    let day = (t / 86400).to_string();
    let mut tx = db.begin().await?;
    crate::db::light(db, &mut tx).await?;
    let (mut admitted, mut locked) = (true, false);
    for row in rows {
        let counted = sqlx::query(
            "INSERT INTO login_attempts(username, day, count, last_at) VALUES($1, $2, 1, $3) ON CONFLICT(username) DO UPDATE SET count = CASE WHEN login_attempts.day = excluded.day THEN login_attempts.count + 1 ELSE 1 END, day = excluded.day, last_at = excluded.last_at WHERE login_attempts.day <> excluded.day OR excluded.last_at - login_attempts.last_at >= 3 RETURNING count",
        )
        .bind(row.as_ref())
        .bind(&day)
        .bind(t)
        .fetch_optional(&mut *tx)
        .await?;
        let count: i64 = match &counted {
            Some(r) => r.try_get(0)?,
            None => sqlx::query("SELECT count FROM login_attempts WHERE username = $1")
                .bind(row.as_ref())
                .fetch_one(&mut *tx)
                .await?
                .try_get(0)?,
        };
        admitted &= counted.is_some();
        locked |= count > 1000;
    }
    match admitted {
        true => tx.commit().await?,
        false => tx.rollback().await?,
    }
    match (locked, admitted) {
        (true, _) => Err(ApiError(
            StatusCode::LOCKED,
            "Account locked for the day".to_string(),
            None,
        )),
        (false, true) => Ok(()),
        (false, false) => Err(wait_between()),
    }
}

pub(crate) const PASSWORD_FAILURES_MAX: i64 = 50;

pub(crate) fn session_key(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(crate) async fn throttle_change(db: &Db, key: &str, t: i64) -> Result<(), ApiError> {
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
        None => Err(wait_between()),
        Some(row) if row.try_get::<i64, _>(0)? >= PASSWORD_FAILURES_MAX => Err(ApiError(
            StatusCode::LOCKED,
            "Too many wrong passwords today".to_string(),
            None,
        )),
        Some(_) => Ok(()),
    }
}

pub(crate) async fn note_change_failure(db: &Db, key: &str) -> Result<(), ApiError> {
    sqlx::query("UPDATE change_attempts SET failures = failures + 1 WHERE session = $1")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

fn invalid_credentials() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        "Invalid credentials".to_string(),
        None,
    )
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
        .bind(secret_key(&token))
        .bind(&user.username)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(token)
}

fn wrong_password() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "Wrong password".to_string(), None)
}

/// Log in
///
/// Checks the username and password (or words) and returns a new session token; existing
/// sessions stay valid. The account is the one with that username in any case, else the one
/// account whose username the name passes for in look-alike characters; a name that passes for
/// several accounts fails like a wrong password. Each account, whatever name reaches it, admits
/// one login or recovery attempt every 3 seconds and at most 1000 login and recovery attempts
/// per UTC day (successful ones included); after that it is locked until the next UTC day. Each
/// look-alike key of the name given is paced and counted the same way, and an attempt is admitted
/// only when the account and every key admit it. Names over 100 characters answer 401 at once.
/// Throttled attempts are not checked. No authentication. Strict and general rate-limit buckets.
#[utoipa::path(post, path = "/api/v1/auth/login", tag = "Auth", request_body = LoginReq, responses((status = 200, description = "Credentials accepted; returns a new session token and the user's profile", body = AuthResp), (status = 400, description = "Not exactly one of `password` and `words`. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "Unknown username, a name that passes for several accounts, a name over 100 characters, or wrong password (`Invalid credentials`)", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 423, description = "Over 1000 login and recovery attempts today (UTC) for this account or a look-alike key of the name given; locked until the next day", body = ApiErrorBody), (status = 429, description = "Less than 3 seconds since the last login or recovery attempt for this account or a look-alike key of the name given (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket", body = ApiErrorBody)), security(()))]
pub(crate) async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginReq>,
) -> Result<Json<AuthResp>, ApiError> {
    login_at(&state, req, now()).await
}

pub(crate) async fn login_at(
    state: &AppState,
    req: LoginReq,
    t: i64,
) -> Result<Json<AuthResp>, ApiError> {
    let LoginReq {
        username,
        password,
        words,
    } = req;
    if username.contains('\0') || username.chars().count() > NAME_MAX {
        return Err(invalid_credentials());
    }
    let db = &state.db;
    let account = names::sign_in_account(db, &username).await?;
    throttle_attempt(db, &names::pace_keys(account.as_ref(), &username), t).await?;
    let (secret, _) = secret_from(&username, password, words, false)?;
    let hash = match &account {
        Some(user) => user.password_hash.as_str(),
        None => dummy_hash().await,
    };
    let user = match (verify_password(&secret, hash).await, account) {
        (true, Some(user)) => user,
        (_, _) => return Err(invalid_credentials()),
    };
    let token = issue_token(db, &user, t).await?;
    let me = me_payload(db, &user).await?;
    Ok(Json(AuthResp { token, user: me }))
}

/// Get the signed-in account
///
/// Returns the signed-in user's account and preferences together with the first page (50) of
/// their joined servers and of their DMs. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/me", tag = "Account", responses((status = 200, description = "The signed-in user's profile with the first page (50) of joined servers and of DMs; `servers_more`/`dms_more` say whether `/api/v1/me/servers` and `/api/v1/dms` have more, and `servers_cursor`/`dms_cursor` are the `cursor` values for their next pages (null when there are no more)", body = Me), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody), (status = 503, description = "The token could not be checked (the database is unavailable). The session is not ended; retry later", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn me(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Me>, ApiError> {
    Ok(Json(me_payload(&state.read(), &user).await?))
}

/// Change the password
///
/// Replaces the account's password or words after checking the current one. Every other session
/// token of the account is revoked and its WebSocket connections close; the token used for this
/// request stays valid. The backup phrase stays unless `keep_recovery` is `false`. Each session
/// admits one attempt every 3 seconds, and after 50 wrong current passwords in a UTC day it may not
/// change the password again until the next day (other sessions and logins are unaffected).
/// Requires a bearer token. Strict and general rate-limit buckets.
/// Password changes are rare requests: at most `RARE_REQUESTS_PER_HOUR` (20) an hour and
/// `RARE_REQUESTS_PER_DAY` (100) a day per account by default. Only changes confirmed with the
/// current password count; past the limit every try is refused.
#[utoipa::path(post, path = "/api/v1/me/password", tag = "Account", request_body(content = PasswordChange, description = "`current` and `new` each take exactly one of `password` (any non-empty text) or `words` (7 words, in order, from the account's word set). Switching between text and words is allowed"), responses((status = 200, description = "Password changed. Every other login token of the account is revoked and their live connections close; the token used for this request stays valid. With `keep_recovery: false` the backup phrase is removed too", body = OkResp), (status = 400, description = "Empty new password, new words that are not 7 words from the word set, or not exactly one of `password` and `words` in `current` or `new`. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token (`Unauthorized`), or wrong current password (`Wrong password`)", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 423, description = "Password changes from this session locked for the day (UTC) after 50 wrong current passwords (separate from the login lockout; other sessions are unaffected)", body = ApiErrorBody), (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. Less than 3 seconds since this session's last attempt (JSON `Wait 3 seconds between attempts`), or too many requests in the strict or general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn change_password(
    State(state): State<AppState>,
    Authed(user): Authed,
    headers: HeaderMap,
    Json(req): Json<PasswordChange>,
) -> Result<Json<OkResp>, ApiError> {
    change_password_at(&state, user, &headers, req, now()).await
}

async fn change_password_at(
    state: &AppState,
    user: User,
    headers: &HeaderMap,
    req: PasswordChange,
    t: i64,
) -> Result<Json<OkResp>, ApiError> {
    let PasswordChange {
        current,
        new,
        keep_recovery,
    } = req;
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
    let token = request_token(headers).unwrap_or_default();
    let session = session_key(&token);
    rare::check(state, Rare::Password, Some(&user))?;
    throttle_change(&state.db, &session, t).await?;
    if !verify_password(&secret, &user.password_hash).await {
        note_change_failure(&state.db, &session).await?;
        return Err(wrong_password());
    }
    rare::take(state, Rare::Password, Some(&user))?;
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
    if keep_recovery == Some(false) {
        sqlx::query(
            "UPDATE users SET recovery_pub = NULL, recovery_set_at = NULL WHERE username = $1",
        )
        .bind(&user.username)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("DELETE FROM tokens WHERE username = $1 AND token <> $2")
        .bind(&user.username)
        .bind(secret_key(&token))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::TokensRevoked {
        username: user.username.clone(),
    });
    Ok(ok())
}

/// Log out
///
/// Revokes the session token used for this request and closes its WebSocket connections. The
/// account's other sessions stay signed in. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/auth/logout", tag = "Auth", responses((status = 200, description = "Signed out: the login token used for this request is revoked and its live connections close; the account's other sessions stay signed in", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn logout(
    State(state): State<AppState>,
    Authed(user): Authed,
    headers: HeaderMap,
) -> Result<Json<OkResp>, ApiError> {
    let token = request_token(&headers).unwrap_or_default();
    let revoked = sqlx::query("DELETE FROM tokens WHERE token = $1 AND username = $2")
        .bind(secret_key(&token))
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

pub(crate) fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Changes to the signed-in account. Every field is optional; omitted fields stay unchanged.
#[derive(Deserialize, ToSchema)]
pub struct MePatch {
    /// New avatar style. Omit to keep the current avatar (and ignore `avatar_color`).
    avatar_kind: Option<AvatarKind>,
    /// `#rrggbb` color, stored lowercase. Required when `avatar_kind` is `color`. For
    /// `identicon` it is the optional background color; omit it (or send `null`) for the
    /// default background. Ignored when `avatar_kind` is omitted.
    #[schema(example = "#3366ff")]
    avatar_color: Option<String>,
    /// Appear offline to others (`true`) or show real presence again (`false`).
    appear_offline: Option<bool>,
    /// The name shown for you, 1 to 32 characters after trimming, without control, format or
    /// invisible characters, never passing for the instance staff or for another account's
    /// username, and checked by the profanity filter (`usernames` target). Not unique, and never
    /// used for mentions or sign-in. Omit to keep it.
    #[schema(example = "Alice")]
    display_name: Option<String>,
    /// `#rrggbb` banner color, stored lowercase; `null` resets it to the default derived from
    /// the avatar. Omit to keep it.
    #[serde(default, deserialize_with = "present")]
    #[schema(value_type = Option<String>, example = "#112233")]
    banner_color: Option<Option<String>>,
    /// Profile description, at most 190 characters (code points) after cleanup: trimmed,
    /// control characters other than newlines dropped, runs of 3 or more newlines cut to 2.
    /// Empty or `null` clears it. Omit to keep it.
    #[serde(default, deserialize_with = "present")]
    #[schema(value_type = Option<String>)]
    bio: Option<Option<String>>,
}

/// The signed-in user's public profile after an update, plus their own settings.
#[derive(Serialize, ToSchema)]
pub struct MeUpdated {
    #[serde(flatten)]
    pub user: UserRef,
    /// Lowercase `#rrggbb` banner color; null means the default derived from the avatar.
    pub banner_color: Option<String>,
    /// Profile description as stored after cleanup; null when unset.
    pub bio: Option<String>,
    /// Whether the user appears offline to others.
    pub appear_offline: bool,
}

pub const BIO_MAX: usize = 190;

pub const DISPLAY_NAME_MAX: usize = 32;

const USERNAME_TAKEN: &str = "Username is taken";

const USERNAME_BANNED: &str = "Username is banned";

impl From<NotAdded> for ApiError {
    fn from(e: NotAdded) -> ApiError {
        match e {
            NotAdded::Refused(Refusal::Taken) => bad(USERNAME_TAKEN),
            NotAdded::Refused(Refusal::Banned) => bad(USERNAME_BANNED),
            NotAdded::Db(e) => e.into(),
        }
    }
}

/// A display name as stored: trimmed, 1 to `DISPLAY_NAME_MAX` characters, no control, format or
/// invisible characters, not passing for the instance staff, through the name profanity filter.
/// A new name can not pass for another account's username (`names::name_keys`); the user's own
/// username in any case and the name they already have are theirs to keep, unless that case
/// gives the username three looks (`names::three_looks`) or its capitals add a key to the
/// username's own keys that passes for another account's username
/// (`names::capitals_pass_for_another`). Checking any other new name is a rare request.
pub(crate) async fn clean_display_name(
    state: &AppState,
    user: &User,
    raw: &str,
) -> Result<String, ApiError> {
    let db = &state.db;
    let name = raw.trim().to_string();
    check_len(&name, DISPLAY_NAME_MAX, "Display name")?;
    if names::name_keys(&name).iter().any(String::is_empty) {
        return Err(bad("Display name required"));
    }
    if name.chars().any(names::hidden_char) {
        return Err(bad("Display name has invalid characters"));
    }
    if names::passes_for_staff(&name) {
        return Err(bad("That name is reserved"));
    }
    check_profanity(db, ProfanityTarget::Usernames, &name).await?;
    let refused = match (
        name == user.display_name,
        name.to_lowercase() == user.username,
    ) {
        (true, _) => false,
        (false, false) => {
            rare::take(state, Rare::DisplayName, Some(user))?;
            names::passes_for_another(db, &name, &user.username).await?
        }
        (false, true) => {
            names::three_looks(&user.username, &name)
                || names::capitals_pass_for_another(db, &name, &user.username).await?
        }
    };
    if refused {
        return Err(bad(USERNAME_TAKEN));
    }
    Ok(name)
}

pub fn clean_bio(text: &str) -> Result<Option<String>, ApiError> {
    clean_multiline(text, BIO_MAX, "Description")
}

pub fn clean_multiline(text: &str, max: usize, what: &str) -> Result<Option<String>, ApiError> {
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
        n if n > max => Err(bad(&format!("{what} must be at most {max} characters"))),
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

/// Update the signed-in account
///
/// Changes the display name, avatar, banner color, profile description and/or appear-offline
/// preference; fields left out stay as they are. A new avatar, display name or description
/// emits `user_updated` to users who share a server or DM with the user; changing `appear_offline`
/// emits `presence_mode` to the user's own connections, and the user then shows as offline
/// (or online again) to others. Banner color changes emit no event. A `display_name` answers
/// 404 while the `display_names` switch of `GET /api/v1/settings` is off, and then nothing
/// changes. Requires a bearer token. General rate-limit bucket.
/// A new `display_name` is a rare request: each account may try at most `RARE_REQUESTS_PER_HOUR`
/// (20) an hour and `RARE_REQUESTS_PER_DAY` (100) a day by default, taken or free; your own
/// username and the name you have don't count.
#[utoipa::path(patch, path = "/api/v1/me", tag = "Account", request_body(content = MePatch, description = "Every field is optional and only the fields present change. `avatar_color` is only read together with `avatar_kind`: the color of a `color` avatar, or the background of an `identicon` (left out or `null`: the default background). `banner_color` is a `#rrggbb` color, or `null` to go back to the default derived from the avatar. `bio` is the profile description: trimmed, control characters other than newlines removed, 3 or more newlines in a row collapsed to 2, at most 190 characters; empty or `null` clears it. It is checked by the profanity filter (`bios` target). `display_name` is trimmed, 1 to 32 characters, and checked by the profanity filter (`usernames` target)"), responses((status = 200, description = "Display name, avatar, banner color, description and/or appear-offline preference updated; returns the user's public profile plus their banner color, description and appear-offline flag", body = MeUpdated), (status = 400, description = "Invalid or missing avatar color for a `color` avatar, invalid background color for an `identicon`, invalid banner color, description over 190 characters, description blocked by the profanity filter, or a display name that is blank, over 32 characters, holds control, format or invisible characters (`Display name has invalid characters`), passes for the instance staff (`That name is reserved`), is blocked by the profanity filter, or is new and passes for another account's username, also in another case or in look-alike characters (`Username is taken`; your own username in another case is accepted unless its capitals pass for another account's username or make it pass for more names than an account stores; the name you already have is accepted). Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: `display_name` was sent while the `display_names` switch is off", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn patch_me(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<MePatch>,
) -> Result<Json<MeUpdated>, ApiError> {
    let MePatch {
        avatar_kind,
        avatar_color,
        appear_offline,
        display_name,
        banner_color,
        bio,
    } = req;
    let display_name = match display_name {
        Some(_) if !Settings::cached(&state.db).await.display_names => return Err(not_found()),
        Some(raw) => Some(clean_display_name(&state, &user, &raw).await?),
        None => None,
    };
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
    if let Some(name) = &display_name {
        let (key, alt) = names::username_keys(&user.username, name);
        sqlx::query(
            "UPDATE users SET display_name = $1, username_key = $2, username_key_alt = $3 WHERE username = $4",
        )
        .bind(name)
        .bind(key)
        .bind(alt)
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
        sqlx::query(
            "UPDATE users SET appear_offline = $1, presence_seq = presence_seq + 1 WHERE username = $2",
        )
            .bind(i64::from(hidden))
            .bind(&user.username)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let stored = get_user(&state.db, &user.username)
        .await?
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Unauthorized".to_string(), None))?;
    let user_ref = UserRef::from_user(&stored);
    let renamed = display_name
        .as_ref()
        .is_some_and(|n| *n != user.display_name);
    if avatar.is_some() || renamed || bio.as_ref().is_some_and(|b| *b != user.bio) {
        state.hub.broadcast(WsEvent::UserUpdated {
            user: user_ref.clone(),
            scope: crate::api::access::user_scope(&state.read(), &stored.username).await,
        });
    }
    if appear_offline.is_some()
        && let Some((hidden, seq)) =
            crate::api::access::presence_mode(&state.db, &stored.username).await?
    {
        state.hub.broadcast(WsEvent::PresenceMode {
            username: stored.username.clone(),
            appear_offline: hidden,
            seq,
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
    use crate::api::test_util::{done, pg_done, pg_state, temp_state};
    use crate::state::AppState;

    #[test]
    fn sign_ups_lock_the_default_servers_in_one_order() {
        let list = |keys: &[&str]| keys.iter().map(|k| k.to_string()).collect::<Vec<_>>();
        assert_eq!(
            lock_order(&list(&["lounge", "alpha", "rchat"])),
            ["alpha", "lounge", "rchat"]
        );
        assert_eq!(
            lock_order(&list(&["rchat", "alpha", "lounge"])),
            lock_order(&list(&["lounge", "rchat", "alpha"])),
            "a sign-up that read the list before a reorder locks like one that read it after"
        );
        assert_eq!(lock_order(&list(&["a", "b", "a"])), ["a", "b"]);
        assert!(lock_order(&[]).is_empty());
    }

    #[tokio::test]
    async fn one_network_can_not_fill_the_server_queue() {
        use crate::api::budget::as_client;
        let ip = |s: &str| -> std::net::IpAddr { s.parse().expect("ip") };
        let mut held = Vec::new();
        for _ in 0..SERVER_ADDRESS_MAX {
            held.push(
                as_client(ip("2001:db8:5555:1::1"), async { client_slots() })
                    .await
                    .expect("place"),
            );
        }
        assert!(
            as_client(ip("2001:db8:5555:1::2"), async { client_slots() })
                .await
                .is_err(),
            "one /64 holds at most its share"
        );
        for n in 2..20 {
            let other = ip(&format!("2001:db8:5555:{n}::1"));
            match as_client(other, async { client_slots() }).await {
                Ok(slots) => held.push(slots),
                Err(_) => break,
            }
        }
        assert_eq!(
            held.len(),
            SERVER_NETWORK_MAX,
            "one /48 holds at most its share"
        );
        assert!(
            as_client(ip("2001:db8:6666::1"), async { client_slots() })
                .await
                .is_ok(),
            "other networks still get places"
        );
        held.clear();
        assert!(
            as_client(ip("2001:db8:5555:1::1"), async { client_slots() })
                .await
                .is_ok()
        );
    }

    #[test]
    fn server_argon2_work_waits_in_a_bounded_queue_and_logins_keep_a_share() {
        static QUEUE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let held: Vec<Waiting> = (0..3).filter_map(|_| Waiting::enter(&QUEUE, 3)).collect();
        assert_eq!(held.len(), 3);
        assert!(Waiting::enter(&QUEUE, 3).is_none(), "a full queue refuses");
        drop(held);
        assert!(
            Waiting::enter(&QUEUE, 3).is_some(),
            "leaving frees the places"
        );
        assert_eq!(QUEUE.load(std::sync::atomic::Ordering::SeqCst), 0);
        for cores in [1, 2, 4, 8, 64] {
            let reserved = reserved_permits(cores);
            assert!(reserved >= 1 && reserved < cores.max(2), "{cores}");
        }
    }

    #[tokio::test]
    async fn session_tokens_are_stored_hashed() {
        let (state, path) = temp_state("token_hash").await;
        let Json(resp) = register_text(&state, "hana").await.expect("register");
        let stored: String = sqlx::query("SELECT token FROM tokens WHERE username = 'hana'")
            .fetch_one(&state.db)
            .await
            .expect("token")
            .try_get(0)
            .expect("value");
        assert_ne!(stored, resp.token);
        assert_eq!(stored, secret_key(&resp.token));
        assert!(
            crate::api::user_for_token(&state, &resp.token)
                .await
                .expect("lookup")
                .is_some()
        );
        assert!(
            crate::api::user_for_token(&state, &stored)
                .await
                .expect("lookup")
                .is_none(),
            "the stored value is not a token"
        );
        done(state, path).await;
    }

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
            Err(ApiError(StatusCode::BAD_REQUEST, _, _))
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
    async fn password_sign_up_follows_registration_and_password_login() {
        let (state, path) = temp_state("sign_up_switches").await;
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let switch = |body: serde_json::Value| {
            let state = state.clone();
            async move {
                let _ = crate::api::admin::patch_settings(
                    State(state),
                    root(),
                    Json(serde_json::from_value(body).expect("patch")),
                )
                .await
                .expect("patch");
            }
        };
        let not_found = |res: Result<Json<AuthResp>, ApiError>| matches!(res, Err(ApiError(StatusCode::NOT_FOUND, ref m, _)) if m == "Not found");
        let _ = register_text(&state, "alice")
            .await
            .expect("open by default");
        for (body, open) in [
            (serde_json::json!({"registration": "sso"}), false),
            (serde_json::json!({"registration": "closed"}), false),
            (
                serde_json::json!({"registration": "open", "password_login": false}),
                false,
            ),
            (serde_json::json!({"password_login": true}), true),
        ] {
            switch(body.clone()).await;
            let blank = register_text(&state, " ").await;
            let made = register_text(&state, &format!("u{}", body.to_string().len())).await;
            match open {
                true => {
                    assert!(matches!(
                        blank,
                        Err(ApiError(StatusCode::BAD_REQUEST, _, _))
                    ));
                    assert!(made.is_ok(), "{body}");
                }
                false => {
                    assert!(not_found(blank), "{body}: before any other check");
                    assert!(not_found(made), "{body}");
                }
            }
        }
        switch(serde_json::json!({"registration": "closed", "password_login": false})).await;
        let back = login(
            State(state.clone()),
            Json(LoginReq {
                username: "alice".to_string(),
                password: Some("a".to_string()),
                words: None,
            }),
        )
        .await
        .expect("existing passwords still sign in");
        assert!(!back.token.is_empty());
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
        assert!(matches!(
            empty,
            Err(ApiError(StatusCode::BAD_REQUEST, _, _))
        ));
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
                matches!(&res, Err(ApiError(StatusCode::BAD_REQUEST, m, _)) if m.contains('@')),
                "{name}"
            );
        }
        crate::db::NewUser::plain("old@name").add(&state.db).await;
        assert!(
            get_user(&state.db, "old@name")
                .await
                .expect("lookup")
                .is_some()
        );
        let _ = register_text(&state, "plain").await.expect("plain ok");
        done(state, path).await;
    }

    /// One character of each kind a new name may not hold: the format characters (zero width,
    /// joiners, the byte order mark, the soft hyphen, the bidi controls), then control
    /// characters, the separators, a private-use and an unassigned code point, and a filler
    /// that renders as nothing.
    const HIDDEN: [(&str, char); 25] = [
        ("word joiner", '\u{2060}'),
        ("zero width space", '\u{200b}'),
        ("zero width non-joiner", '\u{200c}'),
        ("zero width joiner", '\u{200d}'),
        ("byte order mark", '\u{feff}'),
        ("soft hyphen", '\u{ad}'),
        ("left-to-right mark", '\u{200e}'),
        ("right-to-left mark", '\u{200f}'),
        ("Arabic letter mark", '\u{61c}'),
        ("left-to-right embedding", '\u{202a}'),
        ("right-to-left embedding", '\u{202b}'),
        ("pop directional formatting", '\u{202c}'),
        ("left-to-right override", '\u{202d}'),
        ("right-to-left override", '\u{202e}'),
        ("left-to-right isolate", '\u{2066}'),
        ("right-to-left isolate", '\u{2067}'),
        ("first strong isolate", '\u{2068}'),
        ("pop directional isolate", '\u{2069}'),
        ("tab", '\t'),
        ("line feed", '\n'),
        ("line separator", '\u{2028}'),
        ("paragraph separator", '\u{2029}'),
        ("private use", '\u{e000}'),
        ("unassigned", '\u{378}'),
        ("Hangul filler", '\u{3164}'),
    ];

    const HIDDEN_REFUSED: &str = "Username has invalid characters";

    /// What a sign-up was refused with: the status, the text and whether it has no reason.
    fn sign_up_refusal(
        res: Result<Json<AuthResp>, ApiError>,
    ) -> Option<(StatusCode, String, bool)> {
        match res {
            Ok(_) => None,
            Err(ApiError(code, text, reason)) => Some((code, text, reason.is_none())),
        }
    }

    #[tokio::test]
    async fn sign_up_refuses_usernames_with_format_or_other_hidden_characters() {
        let (state, path) = temp_state("username_hidden").await;
        let state = crate::api::rare::tests::unlimited(state);
        let refused = |text: &str| Some((StatusCode::BAD_REQUEST, text.to_string(), true));
        for (what, c) in HIDDEN {
            for name in [format!("{c}bob"), format!("bo{c}b"), format!("bob{c}")] {
                assert_eq!(
                    sign_up_refusal(register_text(&state, &name).await),
                    refused(HIDDEN_REFUSED),
                    "{what}: {name:?}"
                );
            }
            let alone = match c.is_whitespace() {
                true => "Username required",
                false => HIDDEN_REFUSED,
            };
            assert_eq!(
                sign_up_refusal(register_text(&state, &c.to_string()).await),
                refused(alone),
                "{what} alone"
            );
        }
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM users").await,
            0,
            "a refused name makes no account"
        );
        for name in [
            "Zo\u{eb}",
            "\u{540d}\u{524d}",
            "o\u{301}k",
            "a b",
            "\u{1f642}",
            "\u{2615}",
        ] {
            let made = register_text(&state, name)
                .await
                .unwrap_or_else(|e| panic!("{name:?} signs up: {e:?}"));
            assert_eq!(made.0.user.username, name.to_lowercase());
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn stored_usernames_with_format_characters_sign_in() {
        let (state, path) = temp_state("username_hidden_stored").await;
        let state = crate::api::rare::tests::unlimited(state);
        let hash = hash_password("pw").await.expect("hash");
        let mut t = now();
        let stored = [
            ("word joiner", '\u{2060}'),
            ("zero width space", '\u{200b}'),
            ("zero width joiner", '\u{200d}'),
            ("byte order mark", '\u{feff}'),
            ("right-to-left override", '\u{202e}'),
        ];
        for (what, c) in stored {
            let name = format!("bo{c}b");
            crate::db::NewUser::plain(&name)
                .hash(&hash)
                .at(1)
                .add(&state.db)
                .await;
            // The names share a look-alike key, and with it the pace of sign-ins.
            t += 10;
            let Json(AuthResp { token, user }) = login_at(
                &state,
                LoginReq {
                    username: name.clone(),
                    password: Some("pw".to_string()),
                    words: None,
                },
                t,
            )
            .await
            .unwrap_or_else(|e| panic!("{what}: {name:?} signs in: {e:?}"));
            assert_eq!(user.username, name, "{what}");
            let session = crate::api::user_for_token(&state, &token)
                .await
                .expect("lookup")
                .expect("session");
            assert_eq!(session.username, name, "{what}");
            assert_eq!(
                sign_up_refusal(register_text(&state, &name).await),
                Some((StatusCode::BAD_REQUEST, HIDDEN_REFUSED.to_string(), true)),
                "{what}: nobody signs up under the stored name"
            );
        }
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM users").await,
            stored.len() as i64,
            "the stored accounts are kept"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_name_change_refuses_format_and_other_hidden_characters() {
        let (state, path) = temp_state("display_name_hidden").await;
        let state = crate::api::rare::tests::unlimited(state);
        let _ = register_text(&state, "Alice").await.expect("alice");
        let old = "bo\u{2060}b";
        crate::db::NewUser::plain(old).at(1).add(&state.db).await;
        let rename = |who: &'static str, name: String| {
            let state = state.clone();
            async move {
                let user = get_user(&state.db, who).await.expect("load").expect("user");
                let req: MePatch =
                    serde_json::from_value(serde_json::json!({ "display_name": name }))
                        .expect("patch body");
                patch_me(State(state), Authed(user), Json(req))
                    .await
                    .map(|r| r.0.user.display_name)
                    .map_err(|ApiError(code, text, reason)| (code, text, reason.is_none()))
            }
        };
        let refused = Err((
            StatusCode::BAD_REQUEST,
            "Display name has invalid characters".to_string(),
            true,
        ));
        for (what, c) in HIDDEN {
            let name = format!("Al{c}ice");
            assert_eq!(
                rename("alice", name.clone()).await,
                refused,
                "{what}: {name:?}"
            );
        }
        assert_eq!(
            rename(old, old.to_string()).await,
            refused,
            "an account's own stored username with one is no new name either"
        );
        assert_eq!(rename(old, "Bob".to_string()).await, Ok("Bob".to_string()));
        let shown = |who: &'static str| {
            let state = state.clone();
            async move {
                get_user(&state.db, who)
                    .await
                    .expect("load")
                    .expect("user")
                    .display_name
            }
        };
        assert_eq!(shown("alice").await, "Alice");
        assert_eq!(shown(old).await, "Bob");
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
                matches!(long, Err(ApiError(StatusCode::BAD_REQUEST, _, _))),
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
        let attempt = |password: &str, t: i64| {
            let state = state.clone();
            let password = password.to_string();
            async move {
                login_at(
                    &state,
                    LoginReq {
                        username: "tom".to_string(),
                        password: Some(password),
                        words: None,
                    },
                    t,
                )
                .await
            }
        };
        let _ = attempt("a", CLOCK).await.expect("first login");
        let fast = attempt("a", CLOCK + 2).await;
        assert!(matches!(
            fast,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _, _))
        ));
        assert_eq!(attempts(&state, "tom").await, 1);
        let wrong = attempt("b", CLOCK + 3).await;
        assert!(matches!(
            wrong,
            Err(ApiError(StatusCode::UNAUTHORIZED, _, _))
        ));
        sqlx::query("UPDATE login_attempts SET count = 1000 WHERE username = 'tom'")
            .execute(&state.db)
            .await
            .expect("prime attempts");
        let locked = attempt("a", CLOCK + 6).await;
        assert!(matches!(locked, Err(ApiError(StatusCode::LOCKED, _, _))));
        done(state, path).await;
    }

    async fn count(state: &AppState, sql: &'static str) -> i64 {
        sqlx::query(sql)
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value")
    }

    async fn nul_login(state: &AppState) -> ApiError {
        login_at(
            state,
            LoginReq {
                username: "ali\0ce".to_string(),
                password: Some("a".to_string()),
                words: None,
            },
            CLOCK,
        )
        .await
        .err()
        .expect("login refused")
    }

    async fn nul_names_are_refused(state: &AppState) {
        let users = count(state, "SELECT COUNT(*) FROM users").await;
        let ApiError(code, msg, _) = register_text(state, "ali\0ce")
            .await
            .err()
            .expect("register refused");
        assert_eq!(
            (code, msg.as_str()),
            (StatusCode::BAD_REQUEST, "Username required")
        );
        assert_eq!(count(state, "SELECT COUNT(*) FROM users").await, users);
        let ApiError(code, msg, _) = nul_login(state).await;
        assert_eq!(
            (code, msg.as_str()),
            (StatusCode::UNAUTHORIZED, "Invalid credentials")
        );
        assert_eq!(count(state, "SELECT COUNT(*) FROM login_attempts").await, 0);
        let _ = register_text(state, "alice").await.expect("alice");
    }

    #[tokio::test]
    async fn a_nul_in_a_username_is_refused_on_both_databases() {
        let (state, path) = temp_state("auth_nul").await;
        nul_names_are_refused(&state).await;
        crate::db::NewUser::plain("ali\0ce")
            .hash(&hash_password("a").await.expect("hash"))
            .at(1)
            .add(&state.db)
            .await;
        let ApiError(code, msg, _) = nul_login(&state).await;
        assert_eq!(
            (code, msg.as_str()),
            (StatusCode::UNAUTHORIZED, "Invalid credentials")
        );
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM login_attempts").await,
            0
        );
        done(state, path).await;
        if let Some((state, pg)) = pg_state("auth_nul").await {
            nul_names_are_refused(&state).await;
            pg_done(state, pg).await;
        }
    }

    const CLOCK: i64 = 20_000 * 86400 + 3600;

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

    async fn change_at(
        state: &AppState,
        token: &str,
        current: Secret,
        new: Secret,
        t: i64,
    ) -> Result<Json<OkResp>, ApiError> {
        let user = get_user(&state.db, "uma")
            .await
            .expect("load user")
            .expect("user exists");
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().expect("header"),
        );
        change_password_at(
            state,
            user,
            &headers,
            PasswordChange {
                current,
                new,
                keep_recovery: None,
            },
            t,
        )
        .await
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
            Json(PasswordChange {
                current,
                new,
                keep_recovery: None,
            }),
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
            .bind(secret_key(token))
            .bind(name)
            .execute(&state.db)
            .await
            .expect("insert token");
    }

    #[tokio::test]
    async fn password_change_keeps_the_phrase_unless_told() {
        let (state, path) = temp_state("password_change_phrase").await;
        let token = register_text(&state, "uma").await.expect("uma").0.token;
        let key = crate::api::test_util::PHRASE_KEY;
        sqlx::query(
            "UPDATE users SET recovery_pub = $1, recovery_set_at = 7 WHERE username = 'uma'",
        )
        .bind(key)
        .execute(&state.db)
        .await
        .expect("phrase");
        let phrase = || async {
            let user = get_user(&state.db, "uma")
                .await
                .expect("load")
                .expect("uma");
            (user.recovery_pub, user.recovery_set_at)
        };
        let change_with = |current: &'static str, new: &'static str, keep: Option<bool>, t: i64| {
            let state = state.clone();
            let token = token.clone();
            async move {
                let user = get_user(&state.db, "uma")
                    .await
                    .expect("load")
                    .expect("uma");
                let mut headers = HeaderMap::new();
                headers.insert(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {token}").parse().expect("header"),
                );
                change_password_at(
                    &state,
                    user,
                    &headers,
                    PasswordChange {
                        current: text(current),
                        new: text(new),
                        keep_recovery: keep,
                    },
                    t,
                )
                .await
            }
        };
        let t = now();
        let _ = change_with("a", "b", None, t).await.expect("absent keeps");
        assert_eq!(phrase().await, (Some(key.to_string()), Some(7)));
        let _ = change_with("b", "c", Some(true), t + 3)
            .await
            .expect("true keeps");
        assert_eq!(phrase().await, (Some(key.to_string()), Some(7)));
        let ApiError(code, _, _) = change_with("wrong", "d", Some(false), t + 6)
            .await
            .err()
            .expect("wrong password");
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        assert_eq!(phrase().await, (Some(key.to_string()), Some(7)));
        let _ = change_with("c", "d", Some(false), t + 9)
            .await
            .expect("false removes");
        assert_eq!(phrase().await, (None, None));
        let user = get_user(&state.db, "uma")
            .await
            .expect("load")
            .expect("uma");
        assert!(verify_password("d", &user.password_hash).await);
        let body: PasswordChange = serde_json::from_value(serde_json::json!({
            "current": {"password": "d"},
            "new": {"password": "e"},
        }))
        .expect("old clients send no keep_recovery");
        assert_eq!(body.keep_recovery, None);
        done(state, path).await;
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
        assert_eq!(tokens_of(&state, "tina").await, vec![secret_key(&mine)]);
        assert_eq!(tokens_of(&state, "bob").await, vec![secret_key(&other)]);
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
        assert_eq!(tokens_of(&state, "tina").await, vec![secret_key(&second)]);
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
        let wrong = change_at(&state, &mine, text("nope"), text("b"), CLOCK).await;
        assert!(
            matches!(&wrong, Err(ApiError(StatusCode::UNAUTHORIZED, m, _)) if m == "Wrong password")
        );
        assert_eq!(failures(&state, &mine).await, 1);
        let fast = change_at(&state, &mine, text("a"), text("b"), CLOCK + 2).await;
        assert!(matches!(
            fast,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _, _))
        ));
        assert_eq!(failures(&state, &mine).await, 1);
        let wrong_words = change_at(&state, &mine, picked(&words[..7]), text("b"), CLOCK + 3).await;
        assert!(matches!(
            wrong_words,
            Err(ApiError(StatusCode::UNAUTHORIZED, _, _))
        ));
        assert_eq!(failures(&state, &mine).await, 2);
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
            let res = change_at(&state, &mine, text("a"), new, CLOCK + 6).await;
            assert!(matches!(res, Err(ApiError(StatusCode::BAD_REQUEST, _, _))));
        }
        let no_current = change_at(
            &state,
            &mine,
            Secret {
                password: None,
                words: None,
            },
            text("b"),
            CLOCK + 6,
        )
        .await;
        assert!(matches!(
            no_current,
            Err(ApiError(StatusCode::BAD_REQUEST, _, _))
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
        let locked = change_at(&state, &mine, text("a"), text("b"), CLOCK + 6).await;
        assert!(matches!(locked, Err(ApiError(StatusCode::LOCKED, _, _))));
        assert_eq!(failures(&state, "other").await, 0);
        let owner = change_at(&state, "other", text("a"), text("b"), CLOCK).await;
        assert!(owner.is_ok());
        assert_eq!(tokens_of(&state, "uma").await, vec![secret_key("other")]);
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
        assert_eq!(left, vec![secret_key(&winner.0)]);
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
            matches!(&late, Err(ApiError(StatusCode::UNAUTHORIZED, m, _)) if m == "Wrong password")
        );
        assert_eq!(tokens_of(&state, "vic").await, vec![secret_key("first")]);
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
            matches!(&late, Err(ApiError(StatusCode::UNAUTHORIZED, m, _)) if m == "Invalid credentials")
        );
        assert_eq!(tokens_of(&state, "lou").await, vec![secret_key(&mine)]);
        let fresh = get_user(&state.db, "lou")
            .await
            .expect("load")
            .expect("lou");
        let token = issue_token(&state.db, &fresh, now())
            .await
            .expect("fresh hash issues");
        assert!(tokens_of(&state, "lou").await.contains(&secret_key(&token)));
        done(state, path).await;
    }

    #[tokio::test]
    async fn throttle_admits_one_of_concurrent_attempts() {
        let (state, path) = temp_state("throttle_race").await;
        let t = now();
        let tries: Vec<_> = (0..12)
            .map(|_| {
                let db = state.db.clone();
                tokio::spawn(async move { throttle_attempt(&db, &["zed"], t).await })
            })
            .collect();
        let mut admitted = 0;
        for task in tries {
            match task.await.expect("join") {
                Ok(()) => admitted += 1,
                Err(ApiError(status, _, _)) => assert_eq!(status, StatusCode::TOO_MANY_REQUESTS),
            }
        }
        assert_eq!(admitted, 1);
        assert_eq!(attempts(&state, "zed").await, 1);
        assert!(throttle_attempt(&state.db, &["zed"], t + 3).await.is_ok());
        assert!(matches!(
            throttle_attempt(&state.db, &["zed"], t + 86400 * 2).await,
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
        for n in 0..1001 {
            let _ = throttle_attempt(&state.db, &["ann"], CLOCK + 3 * n).await;
        }
        let locked = login_at(
            &state,
            LoginReq {
                username: "ann".to_string(),
                password: Some("a".to_string()),
                words: None,
            },
            CLOCK + 3 * 1001,
        )
        .await;
        assert!(matches!(locked, Err(ApiError(StatusCode::LOCKED, _, _))));
        let _ = change(&state, "ann", &mine, text("a"), text("b"))
            .await
            .expect("change despite login lockout");
        assert_eq!(tokens_of(&state, "ann").await, vec![secret_key(&mine)]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn gap_rejected_logins_are_not_counted() {
        let (state, path) = temp_state("gap_uncounted").await;
        let t = now();
        assert!(throttle_attempt(&state.db, &["gus"], t).await.is_ok());
        for _ in 0..50 {
            assert!(matches!(
                throttle_attempt(&state.db, &["gus"], t).await,
                Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _, _))
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
        assert_eq!(tokens_of(&state, "lea").await, vec![secret_key("phone")]);
        assert!(
            crate::api::user_for_token(&state, &mine)
                .await
                .expect("lookup")
                .is_none()
        );
        assert!(
            crate::api::user_for_token(&state, "phone")
                .await
                .expect("lookup")
                .is_some()
        );
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
                            display_name: None,
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
            Ok(WsEvent::PresenceMode { username, appear_offline: true, seq: 1 }) if username == "olive"
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
                appear_offline: false,
                seq: 2
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
                appear_offline: true,
                seq: 3
            })
        ));
        done(state, path).await;
    }

    #[tokio::test]
    async fn identicon_background_is_validated() {
        let (state, path) = temp_state("identicon_background").await;
        let _ = register_text(&state, "ivy").await.expect("register");
        let mut rx = state.hub.subscribe();
        let patch = |avatar_kind: AvatarKind, avatar_color: Option<&str>| {
            let state = state.clone();
            let avatar_color = avatar_color.map(str::to_string);
            async move {
                let user = get_user(&state.db, "ivy")
                    .await
                    .expect("load user")
                    .expect("user exists");
                patch_me(
                    State(state),
                    Authed(user),
                    Json(MePatch {
                        avatar_kind: Some(avatar_kind),
                        avatar_color,
                        appear_offline: None,
                        display_name: None,
                        banner_color: None,
                        bio: None,
                    }),
                )
                .await
            }
        };
        let stored = |state: AppState| async move {
            let user = get_user(&state.db, "ivy")
                .await
                .expect("load user")
                .expect("user exists");
            (user.avatar_kind, user.avatar_color)
        };
        let set = patch(AvatarKind::Identicon, Some("#ABCDEF"))
            .await
            .expect("background")
            .0;
        assert_eq!(set.user.avatar_kind, AvatarKind::Identicon);
        assert_eq!(set.user.avatar_color.as_deref(), Some("#abcdef"));
        assert_eq!(
            stored(state.clone()).await,
            (AvatarKind::Identicon, Some("#abcdef".to_string()))
        );
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::UserUpdated { user, scope: _ })
                if user.avatar_kind == AvatarKind::Identicon
                    && user.avatar_color.as_deref() == Some("#abcdef")
        ));
        for color in [
            "red", "#12345", "#1234567", "abcdef", "#gggggg", "", "#abcde ",
        ] {
            let ApiError(status, message, _) = patch(AvatarKind::Identicon, Some(color))
                .await
                .err()
                .unwrap_or_else(|| panic!("{color:?} accepted"));
            assert_eq!(status, StatusCode::BAD_REQUEST, "{color:?}");
            assert_eq!(message, "Invalid avatar color", "{color:?}");
        }
        assert_eq!(
            stored(state.clone()).await,
            (AvatarKind::Identicon, Some("#abcdef".to_string()))
        );
        let cleared = patch(AvatarKind::Identicon, None).await.expect("default").0;
        assert_eq!(cleared.user.avatar_color, None);
        assert_eq!(stored(state.clone()).await, (AvatarKind::Identicon, None));
        let fresh = register(
            State(state.clone()),
            Json(RegisterReq {
                username: "June".to_string(),
                password: Some("a".to_string()),
                words: None,
                avatar_kind: AvatarKind::Identicon,
                avatar_color: Some("#00FF7f".to_string()),
            }),
        )
        .await
        .expect("register with background")
        .0;
        assert_eq!(fresh.user.avatar_kind, AvatarKind::Identicon);
        assert_eq!(fresh.user.avatar_color.as_deref(), Some("#00ff7f"));
        let refused = register(
            State(state.clone()),
            Json(RegisterReq {
                username: "Kit".to_string(),
                password: Some("a".to_string()),
                words: None,
                avatar_kind: AvatarKind::Identicon,
                avatar_color: Some("blue".to_string()),
            }),
        )
        .await;
        assert!(matches!(
            refused,
            Err(ApiError(StatusCode::BAD_REQUEST, message, _)) if message == "Invalid avatar color"
        ));
        assert!(get_user(&state.db, "kit").await.expect("lookup").is_none());
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
            Err(ApiError(StatusCode::BAD_REQUEST, _, _))
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
                Err(ApiError(StatusCode::BAD_REQUEST, _, _))
            ));
        }
    }

    #[tokio::test]
    async fn bio_is_saved_shown_and_broadcast() {
        let (state, path) = temp_state("bio_patch").await;
        crate::api::test_util::profanity_on(&state.db).await;
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
                crate::api::MaybeAuthed(Some(user.clone())),
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
            Err(ApiError(StatusCode::BAD_REQUEST, _, _))
        ));
        assert!(matches!(
            patch(r#"{"bio":"what the fuck"}"#).await,
            Err(ApiError(StatusCode::BAD_REQUEST, e, _)) if e.contains("profanity")
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
            None,
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
    async fn display_names_change_but_never_sign_in_or_mention() {
        let (state, path) = temp_state("display_names").await;
        crate::api::test_util::profanity_on(&state.db).await;
        let _ = register_text(&state, "Alice").await.expect("alice");
        let _ = register_text(&state, "bob").await.expect("bob");
        let mut rx = state.hub.subscribe();
        let patch = |name: &'static str, body: String| {
            let state = state.clone();
            async move {
                let user = get_user(&state.db, name)
                    .await
                    .expect("load user")
                    .expect("user exists");
                let req: MePatch = serde_json::from_str(&body).expect("patch body");
                patch_me(State(state), Authed(user), Json(req))
                    .await
                    .map(|r| r.0.user.display_name)
            }
        };
        let named = |name: &str| serde_json::json!({ "display_name": name }).to_string();
        let stored = |name: &'static str| {
            let state = state.clone();
            async move {
                get_user(&state.db, name)
                    .await
                    .expect("load")
                    .expect("user")
                    .display_name
            }
        };
        assert_eq!(stored("alice").await, "Alice");
        assert_eq!(
            patch("alice", named("  Ally  ")).await.expect("set"),
            "Ally"
        );
        assert_eq!(stored("alice").await, "Ally");
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::UserUpdated { user, scope: _ })
                if user.username == "alice" && user.display_name == "Ally"
        ));
        assert_eq!(patch("alice", named("Ally")).await.expect("same"), "Ally");
        assert!(rx.try_recv().is_err(), "unchanged: no event");
        assert_eq!(
            patch("bob", named("Ally")).await.expect("not unique"),
            "Ally"
        );
        let max = "\u{1f600}".repeat(DISPLAY_NAME_MAX);
        assert_eq!(patch("bob", named(&max)).await.expect("32 characters"), max);
        let bad = |code: StatusCode, msg: &str| Err::<String, _>((code, msg.to_string()));
        let refused = |r: Result<String, ApiError>| r.map_err(|ApiError(c, m, _)| (c, m));
        for (body, want) in [
            (named(""), "Display name required"),
            (named("   "), "Display name required"),
            (named("\u{301}\u{301}"), "Display name required"),
            (
                named(&"a".repeat(33)),
                "Display name must be at most 32 characters",
            ),
            (
                named(&"\u{301}".repeat(33)),
                "Display name must be at most 32 characters",
            ),
            (named("a\u{200b}b"), "Display name has invalid characters"),
            (named("a\nb"), "Display name has invalid characters"),
            (named("Bob\u{1d159}"), "Display name has invalid characters"),
            (
                named("ali\u{202e}ce"),
                "Display name has invalid characters",
            ),
            (named("Instance Staff"), "That name is reserved"),
            (
                named("\u{ff29}\u{ff2e}\u{ff33}\u{ff34}\u{ff21}\u{ff2e}\u{ff23}\u{ff25} staff"),
                "That name is reserved",
            ),
            (
                named("what the fuck"),
                "Content blocked by profanity filter",
            ),
        ] {
            assert_eq!(
                refused(patch("alice", body.clone()).await),
                bad(StatusCode::BAD_REQUEST, want),
                "{body}"
            );
        }
        assert_eq!(stored("alice").await, "Ally");
        let login = |username: &str| LoginReq {
            username: username.to_string(),
            password: Some("a".to_string()),
            words: None,
        };
        let t = now();
        assert!(login_at(&state, login("ally"), t).await.is_err());
        let Json(AuthResp { user, .. }) = login_at(&state, login("alice"), t + 3)
            .await
            .expect("sign in by username");
        assert_eq!(
            (user.username.as_str(), user.display_name.as_str()),
            ("alice", "Ally")
        );
        let found = crate::api::pings::mentioned_users(
            &state.db,
            &["ally".to_string(), "alice".to_string()],
            "bob",
        )
        .await
        .expect("mentions");
        assert_eq!(found, ["alice"]);
        sqlx::query("INSERT INTO settings(key, value) VALUES('display_names', '0') ON CONFLICT(key) DO UPDATE SET value = '0'")
            .execute(&state.db)
            .await
            .expect("switch off");
        crate::api::Settings::forget(&state.db);
        let both = r##"{"display_name":"Al","banner_color":"#112233"}"##.to_string();
        assert_eq!(
            refused(patch("alice", both).await),
            bad(StatusCode::NOT_FOUND, "Not found")
        );
        let user = get_user(&state.db, "alice")
            .await
            .expect("load")
            .expect("alice");
        assert_eq!(
            (user.display_name.as_str(), user.banner_color),
            ("Ally", None)
        );
        assert_eq!(
            patch("alice", r##"{"banner_color":"#112233"}"##.to_string())
                .await
                .expect("other fields still change"),
            "Ally"
        );
        done(state, path).await;
    }

    async fn patch_as(
        state: &AppState,
        name: &str,
        body: serde_json::Value,
    ) -> Result<MeUpdated, (StatusCode, String)> {
        let user = get_user(&state.db, name)
            .await
            .expect("load user")
            .expect("user exists");
        let req: MePatch = serde_json::from_value(body).expect("patch body");
        patch_me(State(state.clone()), Authed(user), Json(req))
            .await
            .map(|Json(updated)| updated)
            .map_err(|ApiError(code, msg, _)| (code, msg))
    }

    async fn display_names_keep_off_other_usernames(state: &AppState) {
        for name in ["Alice", "bob", "carol", "Mom"] {
            let _ = register_text(state, name).await.expect(name);
        }
        let admin = get_user(&state.db, "alice")
            .await
            .expect("load")
            .expect("alice");
        assert!(admin.is_site_admin, "the first account is the hidden admin");
        let keys =
            sqlx::query("SELECT username_key, username_key_alt FROM users WHERE username = 'mom'")
                .fetch_one(&state.db)
                .await
                .expect("keys");
        assert_eq!(
            (
                keys.try_get::<Option<String>, _>(0).expect("key"),
                keys.try_get::<Option<String>, _>(1).expect("alt")
            ),
            (Some("rnorn".to_string()), None),
            "sign-up stores the keys"
        );
        let named = |name: &str| serde_json::json!({ "display_name": name });
        let shown = |name: &'static str| async move {
            get_user(&state.db, name)
                .await
                .expect("load")
                .expect("user")
                .display_name
        };
        let taken = || Err((StatusCode::BAD_REQUEST, "Username is taken".to_string()));
        let reserved = || Err((StatusCode::BAD_REQUEST, "That name is reserved".to_string()));
        let name_of = |r: Result<MeUpdated, (StatusCode, String)>| r.map(|u| u.user.display_name);
        for name in [
            "bob",
            "Bob",
            "BOB",
            " bob ",
            "b0b",
            "B\u{43e}b",
            "\u{ff42}\u{ff4f}\u{ff42}",
            "bo\u{301}b",
            "MOM",
            "rnorn",
            "\u{39c}om",
            "\u{13b7}o\u{13b7}",
            "\u{a4df}OM",
            "alice",
            "ALICE",
            "AIice",
        ] {
            assert_eq!(
                name_of(patch_as(state, "carol", named(name)).await),
                taken(),
                "{name:?}"
            );
        }
        assert_eq!(shown("carol").await, "carol");
        for name in ["Carol", "CAROL", "Car0l", "Carol B", "Bobby"] {
            assert_eq!(
                name_of(patch_as(state, "carol", named(name)).await),
                Ok(name.to_string()),
                "{name:?}"
            );
        }
        for who in ["alice", "carol"] {
            assert_eq!(
                name_of(patch_as(state, who, named("Instance Staff")).await),
                reserved(),
                "{who}"
            );
        }
        let _ = register_text(state, "Instance staff")
            .await
            .expect("usernames are not checked against the staff name");
        for who in ["alice", "carol", "instance staff"] {
            assert_eq!(
                name_of(patch_as(state, who, named("Instance Staff")).await),
                reserved(),
                "{who}"
            );
        }

        assert_eq!(
            name_of(patch_as(state, "carol", named("Dave")).await),
            Ok("Dave".to_string())
        );
        let Json(AuthResp { user: dave, .. }) = register_text(state, "dave")
            .await
            .expect("a username that someone shows as their name is free");
        assert_eq!(dave.username, "dave");
        assert_eq!(shown("carol").await, "Dave");
        let both = serde_json::json!({ "display_name": "Dave", "bio": "still me" });
        let kept = patch_as(state, "carol", both).await.expect("the same name");
        assert_eq!(
            (kept.user.display_name.as_str(), kept.bio.as_deref()),
            ("Dave", Some("still me"))
        );
        for name in ["dave", "DAVE", "Dav\u{435}"] {
            assert_eq!(
                name_of(patch_as(state, "carol", named(name)).await),
                taken(),
                "{name:?}"
            );
        }
        assert_eq!(shown("carol").await, "Dave");

        sqlx::query("UPDATE users SET display_name = 'bob' WHERE username = 'carol'")
            .execute(&state.db)
            .await
            .expect("a name stored before the rule");
        let Json(AuthResp { user: old, .. }) = login_at(
            state,
            LoginReq {
                username: "carol".to_string(),
                password: Some("a".to_string()),
                words: None,
            },
            now(),
        )
        .await
        .expect("sign in");
        assert_eq!(old.display_name, "bob");
        let bio = serde_json::json!({ "bio": "other fields change" });
        let edited = patch_as(state, "carol", bio).await.expect("bio");
        assert_eq!(
            (edited.user.display_name.as_str(), edited.bio.as_deref()),
            ("bob", Some("other fields change"))
        );
        assert_eq!(
            name_of(patch_as(state, "carol", named("bob")).await),
            Ok("bob".to_string()),
            "unchanged"
        );
        assert_eq!(
            name_of(patch_as(state, "carol", named("Bob")).await),
            taken()
        );
        assert_eq!(shown("carol").await, "bob");

        crate::db::NewUser::plain("car0l")
            .at(1)
            .add(&state.db)
            .await;
        assert_eq!(
            name_of(patch_as(state, "carol", named("Carol")).await),
            Ok("Carol".to_string()),
            "your own username is yours"
        );
        assert_eq!(
            name_of(patch_as(state, "carol", named("Car0l")).await),
            taken()
        );
        assert_eq!(
            name_of(patch_as(state, "car0l", named("Carol")).await),
            taken()
        );

        crate::db::NewUser::plain("zed\u{200b}")
            .at(1)
            .add(&state.db)
            .await;
        assert_eq!(
            name_of(patch_as(state, "carol", named("Zed")).await),
            taken(),
            "a username that hides a character passes for its visible spelling"
        );
    }

    #[tokio::test]
    async fn a_display_name_never_passes_for_another_username() {
        let (state, path) = temp_state("display_clash").await;
        let state = crate::api::rare::tests::unlimited(state);
        display_names_keep_off_other_usernames(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("display_clash").await {
            let state = crate::api::rare::tests::unlimited(state);
            display_names_keep_off_other_usernames(&state).await;
            pg_done(state, pg).await;
        }
    }

    type AccountRow = (String, String, String, Option<String>, Option<String>);

    async fn account_rows(state: &AppState) -> Vec<AccountRow> {
        sqlx::query("SELECT username, display_name, password_hash, username_key, username_key_alt FROM users WHERE username <> 'eve' ORDER BY username")
            .fetch_all(&state.db)
            .await
            .expect("accounts")
            .iter()
            .map(|r| {
                (
                    r.try_get(0).expect("username"),
                    r.try_get(1).expect("display_name"),
                    r.try_get(2).expect("password_hash"),
                    r.try_get(3).expect("username_key"),
                    r.try_get(4).expect("username_key_alt"),
                )
            })
            .collect()
    }

    async fn look_alike_usernames_are_refused(state: &AppState) {
        for name in [
            "Root", "mom", "bob", "alice", "lan", "Eve", "Mike", "SAM", "Max",
        ] {
            let _ = register_text(state, name).await.expect(name);
        }
        let root = get_user(&state.db, "root")
            .await
            .expect("load")
            .expect("root");
        assert!(root.is_site_admin, "the first account is the hidden admin");
        let ban = serde_json::from_value(serde_json::json!({ "username": "eve" })).expect("ban");
        let _ = crate::api::admin::ban_user(State(state.clone()), Authed(root), Json(ban))
            .await
            .expect("ban eve");
        let hash = hash_password("old").await.expect("hash");
        for name in [
            "b\u{43e}b",
            "zed\u{200b}",
            "\u{200f}amy",
            "bea\u{2060}",
            "cy\u{ad}d",
            "kay\u{1d159}",
        ] {
            crate::db::NewUser::plain(name)
                .hash(&hash)
                .at(1)
                .add(&state.db)
                .await;
        }
        let before = account_rows(state).await;
        let taken = (StatusCode::BAD_REQUEST, USERNAME_TAKEN.to_string());
        let banned = (StatusCode::BAD_REQUEST, "Username is banned".to_string());
        let invalid = (StatusCode::BAD_REQUEST, HIDDEN_REFUSED.to_string());
        for (name, answer) in [
            ("mom", &taken),
            ("MOM", &taken),
            ("Bob", &taken),
            ("b\u{43e}b", &taken),
            ("rnom", &taken),
            ("RNOM", &taken),
            ("b0b", &taken),
            ("B0B", &taken),
            ("AIice", &taken),
            ("Ian", &taken),
            ("\u{ff4d}\u{ff4f}\u{ff4d}", &taken),
            ("\u{ff22}\u{ff2f}\u{ff22}", &taken),
            ("b\u{3bf}b", &taken),
            ("\u{391}lice", &taken),
            ("\u{430}lice", &taken),
            ("B\u{41e}B", &taken),
            ("bo\u{301}b", &taken),
            ("a\u{308}lice", &taken),
            ("bo\u{200b}b", &invalid),
            ("bob\u{2060}", &invalid),
            ("\u{200f}bob", &invalid),
            ("bob\u{202e}", &invalid),
            ("zara\u{200d}", &invalid),
            ("\u{200e}zara", &invalid),
            ("zara\u{ad}", &invalid),
            ("zed", &taken),
            ("ZED", &taken),
            ("z\u{435}d", &taken),
            ("amy", &taken),
            ("bea", &taken),
            ("cyd", &taken),
            ("kay", &taken),
            ("bob\u{1d159}", &invalid),
            ("\u{1d159}bob", &invalid),
            ("b\u{1d159}ob", &invalid),
            ("bo\u{200a}b", &taken),
            ("bo\u{2009}b", &taken),
            ("bo\u{202f}b", &taken),
            ("bo\u{2006}b", &taken),
            ("bo\u{a0}b", &taken),
            ("zara\u{fe0f}", &taken),
            ("kim\u{e0100}", &taken),
            ("lee\u{2003}", &taken),
            ("joe ", &taken),
            ("\u{3000}ann", &taken),
            ("\u{a0}ann", &taken),
            ("Root", &taken),
            ("R00T", &taken),
            ("\u{39c}ike", &taken),
            ("\u{41c}ike", &taken),
            ("\u{a4df}ike", &taken),
            ("\u{39c}IKE", &taken),
            ("\u{39c}om", &taken),
            ("\u{13b7}o\u{13b7}", &taken),
            ("SA\u{39c}", &taken),
            ("\u{41c}ax", &taken),
            ("b\u{f8}b", &taken),
            ("eve", &banned),
            ("EVE", &banned),
            ("\u{435}ve", &banned),
            ("Ev\u{435}", &banned),
            ("e\u{301}ve", &banned),
            ("e\u{200b}ve", &invalid),
        ] {
            let hashes = hash_runs();
            let refused = register_text(state, name)
                .await
                .err()
                .map(|ApiError(code, msg, _)| (code, msg));
            assert_eq!(refused.as_ref(), Some(answer), "{name:?}");
            let cost = match answer == &invalid {
                true => 0,
                false => 1,
            };
            assert_eq!(
                hash_runs() - hashes,
                cost,
                "{name:?} costs what a free name costs, or nothing when its characters refuse it"
            );
        }
        assert_eq!(
            account_rows(state).await,
            before,
            "no account is added, and collisions from before stay as they are"
        );
        for name in ["zara", "Bobby", "momo", "Alicia", "Ivan", "Bo B"] {
            let hashes = hash_runs();
            let Json(AuthResp { user, .. }) = register_text(state, name).await.expect(name);
            assert_eq!(hash_runs() - hashes, 1, "{name:?}");
            assert_eq!(user.username, name.to_lowercase());
        }
        for (name, answer) in [
            ("\u{301}", "Username required"),
            ("\u{301}\u{fe0f}", "Username required"),
            (" \u{20dd} ", "Username required"),
            ("\u{200b}", HIDDEN_REFUSED),
            ("\u{3164}\u{2060}", HIDDEN_REFUSED),
        ] {
            assert_eq!(
                register_text(state, name)
                    .await
                    .err()
                    .map(|ApiError(code, msg, _)| (code, msg)),
                Some((StatusCode::BAD_REQUEST, answer.to_string())),
                "{name:?} looks like no name"
            );
        }
        for name in ["ZARA", "z\u{430}ra", "zar\u{430}\u{301}"] {
            assert_eq!(
                register_text(state, name)
                    .await
                    .err()
                    .map(|ApiError(code, msg, _)| (code, msg)),
                Some(taken.clone()),
                "{name:?}"
            );
        }
    }

    #[tokio::test]
    async fn sign_up_refuses_look_alike_usernames() {
        let (state, path) = temp_state("signup_lookalike").await;
        let state = crate::api::rare::tests::unlimited(state);
        look_alike_usernames_are_refused(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("signup_lookalike").await {
            let state = crate::api::rare::tests::unlimited(state);
            look_alike_usernames_are_refused(&state).await;
            pg_done(state, pg).await;
        }
    }

    /// Look-alike pairs whose look comes from the capitals of one of them: a capital I passes
    /// for l, and Greek and Cyrillic capitals pass for Latin ones only before case folding.
    const CAPITAL_PAIRS: [(&str, &str); 9] = [
        ("Ian", "lan"),
        ("AIice", "Alice"),
        ("\u{392}ob", "Bob"),
        ("\u{39c}ike", "Mike"),
        ("\u{412}en", "Ben"),
        ("\u{422}om", "Tom"),
        ("\u{41d}ank", "Hank"),
        ("\u{39a}ate", "Kate"),
        ("\u{39d}ina", "Nina"),
    ];

    /// Look-alike pairs whose look comes from the lower case of one of them: a Cherokee capital
    /// passes for a Latin letter only as a small letter (U+13A4 for o, U+13B1 for r).
    const SMALL_LETTER_PAIRS: [(&str, &str); 10] = [
        ("B\u{13a4}B", "Bob"),
        ("\u{13b1}ose", "rose"),
        ("D\u{13a4}N", "Don"),
        ("\u{13aa}nn", "\u{1d00}nn"),
        ("\u{13b7}ia", "\u{28d}ia"),
        ("ab\u{13a0}", "ab\u{1d05}"),
        ("ab\u{13a1}", "ab\u{280}"),
        ("ab\u{13a2}", "ab\u{442}"),
        ("cd\u{13a2}", "cd\u{3c4}"),
        ("ef\u{13a2}", "ef\u{4ad}"),
    ];

    /// Look-alike pairs whose look compatibility normalization would hide: a long s is an f, and
    /// the lunate sigmas (U+03F2, U+03F9) are c and C.
    const OWN_LOOK_PAIRS: [(&str, &str); 5] = [
        ("\u{3f2}arol", "Carol"),
        ("\u{3f9}hris", "Chris"),
        ("Mar\u{3f2}", "Marc"),
        ("\u{17f}red", "Fred"),
        ("je\u{17f}\u{17f}", "JEFF"),
    ];

    /// A banned account and its look-alike, for each set of pairs, with both in capitals.
    const BANNED_PAIRS: [(&str, &str, [&str; 2]); 3] = [
        ("\u{412}ic", "Bic", ["BIC", "\u{412}IC"]),
        ("\u{13b1}ic", "ric", ["RIC", "\u{13b1}IC"]),
        ("\u{3f9}ole", "Cole", ["COLE", "\u{3f9}OLE"]),
    ];

    fn refused(r: Result<Json<AuthResp>, ApiError>) -> Option<(StatusCode, String)> {
        r.err().map(|ApiError(code, msg, _)| (code, msg))
    }

    async fn either_spelling_first_is_refused(
        state: &AppState,
        pairs: &[(&'static str, &'static str)],
        (who, twin, capitals): (&str, &str, [&str; 2]),
        first_is_capital: bool,
    ) {
        let taken = (StatusCode::BAD_REQUEST, USERNAME_TAKEN.to_string());
        let banned = (StatusCode::BAD_REQUEST, USERNAME_BANNED.to_string());
        let _ = register_text(state, "Root").await.expect("root");
        let order = |(capital, plain): &(&'static str, &'static str)| match first_is_capital {
            true => (*capital, *plain),
            false => (*plain, *capital),
        };
        for (first, _) in pairs.iter().map(order) {
            let _ = register_text(state, first).await.expect(first);
        }
        for (first, then) in pairs.iter().map(order) {
            let hashes = hash_runs();
            assert_eq!(
                refused(register_text(state, then).await),
                Some(taken.clone()),
                "{first:?} then {then:?}"
            );
            assert_eq!(
                hash_runs() - hashes,
                1,
                "{then:?} costs what a free name costs"
            );
        }

        let root = get_user(&state.db, "root")
            .await
            .expect("load")
            .expect("root");
        let (who, twin) = match first_is_capital {
            true => (who, twin),
            false => (twin, who),
        };
        let _ = register_text(state, who).await.expect(who);
        let ban = serde_json::json!({ "username": who.to_lowercase() });
        let ban = serde_json::from_value(ban).expect("ban");
        let _ = crate::api::admin::ban_user(State(state.clone()), Authed(root), Json(ban))
            .await
            .expect("ban");
        for name in [who, twin].into_iter().chain(capitals) {
            assert_eq!(
                refused(register_text(state, name).await),
                Some(banned.clone()),
                "{name:?} after a ban of {who:?}"
            );
        }
    }

    #[tokio::test]
    async fn refusal_does_not_depend_on_which_spelling_came_first() {
        let sets: [&[(&str, &str)]; 3] = [&CAPITAL_PAIRS, &SMALL_LETTER_PAIRS, &OWN_LOOK_PAIRS];
        for (pairs, ban) in sets.into_iter().zip(BANNED_PAIRS) {
            for first_is_capital in [true, false] {
                let (state, path) = temp_state("signup_either_first").await;
                let state = crate::api::rare::tests::unlimited(state);
                either_spelling_first_is_refused(&state, pairs, ban, first_is_capital).await;
                done(state, path).await;
                if let Some((state, pg)) = pg_state("signup_either_first").await {
                    let state = crate::api::rare::tests::unlimited(state);
                    either_spelling_first_is_refused(&state, pairs, ban, first_is_capital).await;
                    pg_done(state, pg).await;
                }
            }
        }
    }

    async fn a_long_s_is_not_an_s(state: &AppState) {
        let taken = Some((StatusCode::BAD_REQUEST, USERNAME_TAKEN.to_string()));
        for name in ["sam", "\u{17f}am", "\u{17f}ue", "Sue"] {
            let _ = register_text(state, name).await.expect(name);
        }
        for name in ["fam", "FUE"] {
            assert_eq!(refused(register_text(state, name).await), taken, "{name:?}");
        }
    }

    #[tokio::test]
    async fn a_long_s_signs_up_next_to_an_s() {
        let (state, path) = temp_state("signup_long_s").await;
        let state = crate::api::rare::tests::unlimited(state);
        a_long_s_is_not_an_s(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("signup_long_s").await {
            let state = crate::api::rare::tests::unlimited(state);
            a_long_s_is_not_an_s(&state).await;
            pg_done(state, pg).await;
        }
    }

    /// Names with three looks (as typed, in lower case and case-folded), each with a plain twin
    /// of its lowercase username.
    const THREE_LOOK_PAIRS: [(&str, &str); 3] = [
        ("\u{13a4}lIvia", "olivia"),
        ("\u{13b1}Iley", "riley"),
        ("\u{3d2}Iq", "Yiq"),
    ];

    async fn three_looks_are_refused(state: &AppState, plain_first: bool) {
        let taken = Some((StatusCode::BAD_REQUEST, USERNAME_TAKEN.to_string()));
        let _ = register_text(state, "Root").await.expect("root");
        for (three, plain) in THREE_LOOK_PAIRS {
            if plain_first {
                let _ = register_text(state, plain).await.expect(plain);
            }
            let hashes = hash_runs();
            assert_eq!(
                refused(register_text(state, three).await),
                taken,
                "{three:?}, after {plain:?}: {plain_first}"
            );
            assert_eq!(
                hash_runs() - hashes,
                1,
                "{three:?} costs what a free name costs"
            );
            assert!(
                get_user(&state.db, three).await.expect("load").is_none(),
                "{three:?}"
            );
            if !plain_first {
                let _ = register_text(state, plain).await.expect(plain);
            }
        }
    }

    #[tokio::test]
    async fn names_with_three_looks_can_not_sign_up() {
        for plain_first in [false, true] {
            let (state, path) = temp_state("signup_three_looks").await;
            let state = crate::api::rare::tests::unlimited(state);
            three_looks_are_refused(&state, plain_first).await;
            done(state, path).await;
            if let Some((state, pg)) = pg_state("signup_three_looks").await {
                let state = crate::api::rare::tests::unlimited(state);
                three_looks_are_refused(&state, plain_first).await;
                pg_done(state, pg).await;
            }
        }
    }

    async fn three_look_accounts_stay(state: &AppState) {
        let taken = || Err((StatusCode::BAD_REQUEST, USERNAME_TAKEN.to_string()));
        let named = |name: &str| serde_json::json!({ "display_name": name });
        let name_of = |r: Result<MeUpdated, (StatusCode, String)>| r.map(|u| u.user.display_name);
        let hash = hash_password("old").await.expect("hash");
        let accounts = [
            ("\u{13a4}lIve", "\u{ab74}live"),
            ("\u{13b1}Ivy", "\u{ab81}ivy"),
            ("\u{3d2}Iz", "\u{3d2}iz"),
        ];
        for (shown, username) in accounts {
            crate::db::NewUser::plain(username)
                .shown(shown)
                .hash(&hash)
                .at(1)
                .add(&state.db)
                .await;
        }
        let mut t = CLOCK;
        for (shown, username) in accounts {
            for typed in [shown, username] {
                t += 10;
                assert_eq!(
                    sign_in(state, typed, "old", t).await,
                    Ok(username.to_string()),
                    "{typed:?}"
                );
            }
            assert_eq!(
                name_of(patch_as(state, username, named(shown)).await),
                Ok(shown.to_string()),
                "{shown:?} keeps its name"
            );
        }

        let _ = register_text(state, "\u{ab74}lin")
            .await
            .expect("a Cherokee small letter");
        assert_eq!(
            name_of(patch_as(state, "\u{ab74}lin", named("\u{13a4}lIn")).await),
            taken(),
            "capitals that give the username three looks"
        );
        assert_eq!(
            refused(register_text(state, "olin").await),
            Some((StatusCode::BAD_REQUEST, USERNAME_TAKEN.to_string())),
            "the look of its lower case stays stored"
        );
        assert_eq!(
            name_of(patch_as(state, "\u{ab74}lin", named("\u{13a4}lin")).await),
            Ok("\u{13a4}lin".to_string()),
            "a Cherokee capital alone"
        );
    }

    #[tokio::test]
    async fn accounts_with_three_looks_stay() {
        let (state, path) = temp_state("three_look_accounts").await;
        let state = crate::api::rare::tests::unlimited(state);
        three_look_accounts_stay(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("three_look_accounts").await {
            let state = crate::api::rare::tests::unlimited(state);
            three_look_accounts_stay(&state).await;
            pg_done(state, pg).await;
        }
    }

    async fn display_name_capitals_count(state: &AppState) {
        let taken = || Err((StatusCode::BAD_REQUEST, USERNAME_TAKEN.to_string()));
        let named = |name: &str| serde_json::json!({ "display_name": name });
        let name_of = |r: Result<MeUpdated, (StatusCode, String)>| r.map(|u| u.user.display_name);
        for name in ["ida", "lan", "ian"] {
            let _ = register_text(state, name).await.expect(name);
        }
        assert_eq!(
            name_of(patch_as(state, "ida", named("Ida")).await),
            Ok("Ida".to_string())
        );
        assert_eq!(
            refused(register_text(state, "lda").await),
            Some((StatusCode::BAD_REQUEST, USERNAME_TAKEN.to_string())),
            "the username shown as Ida passes for lda"
        );
        assert_eq!(
            name_of(patch_as(state, "ida", named("Ida B")).await),
            Ok("Ida B".to_string())
        );
        let _ = register_text(state, "lda")
            .await
            .expect("not shown as Ida any more");
        assert_eq!(
            name_of(patch_as(state, "ida", named("Ida")).await),
            taken(),
            "its capitals pass for lda now"
        );
        assert_eq!(
            name_of(patch_as(state, "ian", named("Ian")).await),
            taken(),
            "Ian passes for lan"
        );
        assert_eq!(name_of(patch_as(state, "ian", named("IAN")).await), taken());
        assert_eq!(
            name_of(patch_as(state, "lan", named("LAN")).await),
            Ok("LAN".to_string()),
            "the username in capitals that pass for nobody else"
        );

        let _ = register_text(state, "carol").await.expect("carol");
        for name in ["\u{456}an", "car0l"] {
            crate::db::NewUser::plain(name).at(1).add(&state.db).await;
        }
        assert_eq!(
            name_of(patch_as(state, "ian", named("Ian")).await),
            taken(),
            "Ian passes for lan, whatever else ian passes for"
        );
        assert_eq!(
            name_of(patch_as(state, "\u{456}an", named("\u{406}an")).await),
            taken(),
            "a Cyrillic capital that passes for l"
        );
        assert_eq!(
            name_of(patch_as(state, "carol", named("Carol")).await),
            Ok("Carol".to_string()),
            "capitals that add no look"
        );
        let keys =
            sqlx::query("SELECT username_key, username_key_alt FROM users WHERE username = 'ian'")
                .fetch_one(&state.db)
                .await
                .expect("ian");
        assert_eq!(
            (
                keys.try_get::<String, _>(0).expect("key"),
                keys.try_get::<Option<String>, _>(1).expect("alt")
            ),
            ("ian".to_string(), None),
            "a refused name leaves the keys as they are"
        );
    }

    #[tokio::test]
    async fn a_display_name_in_capitals_keys_the_username() {
        let (state, path) = temp_state("display_capitals").await;
        let state = crate::api::rare::tests::unlimited(state);
        display_name_capitals_count(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("display_capitals").await {
            let state = crate::api::rare::tests::unlimited(state);
            display_name_capitals_count(&state).await;
            pg_done(state, pg).await;
        }
    }

    async fn sign_in(
        state: &AppState,
        username: &str,
        password: &str,
        t: i64,
    ) -> Result<String, (StatusCode, String)> {
        let req = LoginReq {
            username: username.to_string(),
            password: Some(password.to_string()),
            words: None,
        };
        login_at(state, req, t)
            .await
            .map(|Json(AuthResp { user, .. })| user.username)
            .map_err(|ApiError(code, msg, _)| (code, msg))
    }

    async fn counts(state: &AppState, sql: &'static str) -> Vec<(String, i64)> {
        let mut rows = sqlx::query(sql)
            .fetch_all(&state.db)
            .await
            .expect(sql)
            .iter()
            .map(|r| (r.try_get(0).expect("name"), r.try_get(1).expect("count")))
            .collect::<Vec<_>>();
        rows.sort();
        rows
    }

    async fn look_alikes_sign_in_to_one_account(state: &AppState) {
        for name in ["Root", "mom", "Mike", "Ian", "\u{392}en"] {
            let _ = register_text(state, name).await.expect(name);
        }
        sqlx::query("DELETE FROM tokens")
            .execute(&state.db)
            .await
            .expect("no sign-up sessions");
        let hash = hash_password("old").await.expect("hash");
        for name in [
            "bob",
            "b\u{43e}b",
            "gone",
            "g0ne",
            "zed\u{200b}",
            "kay\u{1d159}",
        ] {
            crate::db::NewUser::plain(name)
                .hash(&hash)
                .at(1)
                .add(&state.db)
                .await;
        }
        sqlx::query("UPDATE users SET password_hash = '!purging' WHERE username = 'gone'")
            .execute(&state.db)
            .await
            .expect("an account being deleted");
        let attempts = || counts(state, "SELECT username, count FROM login_attempts");
        let sessions = || {
            counts(
                state,
                "SELECT username, COUNT(*) FROM tokens GROUP BY username",
            )
        };
        let wait = || {
            Err((
                StatusCode::TOO_MANY_REQUESTS,
                "Wait 3 seconds between attempts".to_string(),
            ))
        };
        let wrong = || Err((StatusCode::UNAUTHORIZED, "Invalid credentials".to_string()));
        let locked = || Err((StatusCode::LOCKED, "Account locked for the day".to_string()));
        let ok = |name: &str| Ok(name.to_string());
        let one = |name: &str, n: i64| (name.to_string(), n);

        let t = CLOCK;
        assert_eq!(sign_in(state, "rnom", "a", t).await, ok("mom"));
        assert_eq!(sign_in(state, "M0M", "a", t + 1).await, wait());
        assert_eq!(sign_in(state, "m\u{43e}m", "b", t + 3).await, wrong());
        assert_eq!(
            sign_in(state, "\u{ff4d}\u{ff4f}\u{ff4d}", "a", t + 6).await,
            ok("mom")
        );
        assert_eq!(
            attempts().await,
            vec![one("@rnorn", 3), one("mom", 3)],
            "every spelling counts against the account and its look-alike key"
        );
        assert_eq!(sessions().await, vec![one("mom", 2)]);
        sqlx::query("UPDATE login_attempts SET count = 1000 WHERE username = 'mom'")
            .execute(&state.db)
            .await
            .expect("the day's budget");
        for (n, name) in (3i64..).zip(["rnom", "MOM", "mom", "m\u{43e}m"]) {
            assert_eq!(
                sign_in(state, name, "a", t + 3 * n).await,
                locked(),
                "{name:?}"
            );
        }
        assert_eq!(
            attempts().await,
            vec![one("@rnorn", 7), one("mom", 1004)],
            "one lockout"
        );

        let t = t + 100;
        for (n, name) in (0i64..).zip(["B0B", "b\u{3bf}b", "Bo\u{301}b"]) {
            assert_eq!(
                sign_in(state, name, "old", t + 3 * n).await,
                wrong(),
                "{name:?} passes for two accounts"
            );
        }
        for (n, (name, account)) in
            (0i64..).zip([("bob", "bob"), ("BOB", "bob"), ("b\u{43e}b", "b\u{43e}b")])
        {
            assert_eq!(
                sign_in(state, name, "old", t + 20 + 3 * n).await,
                ok(account),
                "{name:?}: the exact username is that account"
            );
        }
        assert_eq!(
            attempts().await,
            vec![
                one("@bob", 6),
                one("@rnorn", 7),
                one("bob", 2),
                one("b\u{43e}b", 1),
                one("mom", 1004),
            ],
            "a name that passes for several accounts counts under its look-alike key only"
        );
        assert_eq!(
            sessions().await,
            vec![one("bob", 2), one("b\u{43e}b", 1), one("mom", 2)]
        );

        let t = t + 100;
        let admin = login_at(
            state,
            LoginReq {
                username: "R00T".to_string(),
                password: Some("a".to_string()),
                words: None,
            },
            t,
        )
        .await
        .expect("the admin signs in like anyone");
        assert_eq!(
            (admin.user.username.as_str(), admin.user.is_site_admin),
            ("root", true)
        );
        assert_eq!(sign_in(state, "R0OT", "b", t + 3).await, wrong());
        crate::db::NewUser::plain("r\u{43e}\u{43e}t")
            .hash(&hash)
            .at(1)
            .add(&state.db)
            .await;
        assert_eq!(
            sign_in(state, "R00T", "a", t + 6).await,
            wrong(),
            "two accounts pass for it now"
        );
        assert_eq!(sign_in(state, "root", "a", t + 9).await, ok("root"));
        assert_eq!(
            sign_in(state, "r\u{43e}\u{43e}t", "old", t + 12).await,
            ok("r\u{43e}\u{43e}t")
        );

        let t = t + 100;
        for (n, name) in (0i64..).zip(["zed", "ZED", "z\u{435}d", "zed\u{200b}"]) {
            assert_eq!(
                sign_in(state, name, "old", t + 3 * n).await,
                ok("zed\u{200b}"),
                "{name:?}: the visible spelling of a username that hides a character"
            );
        }
        let zed = counts(
            state,
            "SELECT username, count FROM login_attempts WHERE username LIKE 'z%'",
        )
        .await;
        assert_eq!(zed, vec![one("zed\u{200b}", 4)]);
        for (n, name) in (0i64..).zip(["kay", "KAY"]) {
            assert_eq!(
                sign_in(state, name, "old", t + 3 * n).await,
                ok("kay\u{1d159}"),
                "{name:?}: a username that ends in a blank symbol"
            );
        }
        for (n, name) in (0i64..).zip(["\u{a4df}ike", "\u{39c}IKE", "\u{41c}ike"]) {
            assert_eq!(
                sign_in(state, name, "a", t + 20 + 3 * n).await,
                ok("mike"),
                "{name:?}: a capital that passes for M"
            );
        }
        for (n, (name, account)) in (0i64..).zip([
            ("lan", "ian"),
            ("LAN", "ian"),
            ("1an", "ian"),
            ("Ben", "\u{3b2}en"),
            ("BEN", "\u{3b2}en"),
        ]) {
            assert_eq!(
                sign_in(state, name, "a", t + 40 + 3 * n).await,
                ok(account),
                "{name:?}: the capitals of the name it signed up with"
            );
        }

        let t = t + 100;
        let long = "m".repeat(NAME_MAX + 1);
        for (n, (name, password, answer)) in (0i64..).zip([
            ("mom", "a", locked()),
            ("rnom", "a", locked()),
            ("bob", "old", ok("bob")),
            ("b\u{43e}b", "wrong", wrong()),
            ("r00t", "a", wrong()),
            ("root", "wrong", wrong()),
            ("R0OT", "wrong", wrong()),
            ("nobody", "a", wrong()),
            ("n0b0dy", "a", wrong()),
            ("B0B", "old", wrong()),
            ("gone", "old", wrong()),
            ("g0ne", "old", ok("g0ne")),
            ("g\u{43e}ne", "old", ok("g0ne")),
        ]) {
            let runs = verify_runs();
            let got = sign_in(state, name, password, t + 3 * n).await;
            let checks = verify_runs() - runs;
            let want = match answer == locked() {
                true => 0,
                false => 1,
            };
            assert_eq!(got, answer, "{name:?}");
            assert_eq!(checks, want, "{name:?}: one password check, like any name");
        }
        let paced = attempts().await;
        let hidden = format!("mom{}", "\u{200b}".repeat(NAME_MAX - 2));
        for name in [long.as_str(), hidden.as_str()] {
            let runs = verify_runs();
            assert_eq!(sign_in(state, name, "a", t + 60).await, wrong(), "{name:?}");
            assert_eq!(verify_runs() - runs, 0, "over 100 characters: no account");
        }
        assert_eq!(
            attempts().await,
            paced,
            "names over 100 characters are not paced"
        );
        let stretched = format!("{}\u{130}", "a".repeat(NAME_MAX - 1));
        assert_eq!(
            register_text(state, &stretched)
                .await
                .err()
                .map(|ApiError(code, msg, _)| (code, msg)),
            Some((
                StatusCode::BAD_REQUEST,
                "Username must be at most 100 characters".to_string()
            )),
            "its lowercase is longer, and only names up to 100 characters sign in"
        );
        let stored = stretched.to_lowercase();
        crate::db::NewUser::plain(&stored)
            .hash(&hash)
            .at(1)
            .add(&state.db)
            .await;
        let found = names::sign_in_account(&state.db, &stored)
            .await
            .expect("lookup")
            .map(|user| user.username);
        assert_eq!(found, None, "over 100 characters: no lookup");
        assert_eq!(
            sign_in(state, &stretched, "old", t + 70).await,
            Ok(stored),
            "an account from before the length rule, by the name it signed up with"
        );
    }

    #[tokio::test]
    async fn sign_in_with_a_look_alike_reaches_one_account() {
        let (state, path) = temp_state("signin_lookalike").await;
        look_alikes_sign_in_to_one_account(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("signin_lookalike").await {
            look_alikes_sign_in_to_one_account(&state).await;
            pg_done(state, pg).await;
        }
    }

    async fn sign_in_words_as(
        state: &AppState,
        name: &str,
        picked: &[String],
        t: i64,
    ) -> Result<String, (StatusCode, String)> {
        let req = LoginReq {
            username: name.to_string(),
            password: None,
            words: Some(picked.iter().map(|w| w.to_uppercase()).collect()),
        };
        login_at(state, req, t)
            .await
            .map(|Json(AuthResp { user, .. })| user.username)
            .map_err(|ApiError(code, msg, _)| (code, msg))
    }

    async fn word_sets_are_those_of_the_name_typed(state: &AppState) {
        let set = |name: &str| words(Path(name.to_string()));
        let new = set("Sam").await.0.words;
        assert_eq!(new, word_set("sam"));
        let picked = new[3..10].to_vec();
        let _ = register(
            State(state.clone()),
            Json(RegisterReq {
                username: "Sam".to_string(),
                password: None,
                words: Some(picked.clone()),
                avatar_kind: AvatarKind::Identicon,
                avatar_color: None,
            }),
        )
        .await
        .expect("sign-up with the words of the name");
        let spellings = [
            "Sam",
            "sam",
            "Sarn",
            "s\u{430}m",
            "sa\u{200b}m",
            "\u{ff53}\u{ff41}\u{ff4d}",
        ];
        for (n, name) in (0i64..).zip(spellings) {
            assert_eq!(
                set(name).await.0.words,
                word_set(name),
                "{name:?}: the set of the name typed, whatever account it reaches"
            );
            assert_eq!(
                sign_in_words_as(state, name, &picked, CLOCK + 3 * n).await,
                Ok("sam".to_string()),
                "{name:?}: the account's words sign in through the API"
            );
        }
        let long = "\u{fdfa}".repeat(7000);
        assert_eq!(
            set(&long).await.0.words,
            word_set(&long),
            "no lookup and no keys"
        );
    }

    #[tokio::test]
    async fn word_sets_show_no_account() {
        let (state, path) = temp_state("words_typed").await;
        word_sets_are_those_of_the_name_typed(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("words_typed").await {
            word_sets_are_those_of_the_name_typed(&state).await;
            pg_done(state, pg).await;
        }
    }

    async fn every_row_or_none(state: &AppState) {
        let rows = || counts(state, "SELECT username, count FROM login_attempts");
        let code = |r: Result<(), ApiError>| r.map_err(|ApiError(code, _, _)| code);
        let wait = Err(StatusCode::TOO_MANY_REQUESTS);
        let locked = Err(StatusCode::LOCKED);
        let one = |name: &str, n: i64| (name.to_string(), n);
        let t = CLOCK;
        assert_eq!(
            code(throttle_attempt(&state.db, &["@a", "b"], t).await),
            Ok(())
        );
        assert_eq!(
            code(throttle_attempt(&state.db, &["b", "c"], t + 1).await),
            wait
        );
        assert_eq!(
            code(throttle_attempt(&state.db, &["@a", "c"], t + 2).await),
            wait
        );
        assert_eq!(
            rows().await,
            vec![one("@a", 1), one("b", 1)],
            "a refused attempt counts nowhere"
        );
        assert_eq!(
            code(throttle_attempt(&state.db, &["c"], t + 2).await),
            Ok(())
        );
        sqlx::query("UPDATE login_attempts SET count = 1000 WHERE username = 'c'")
            .execute(&state.db)
            .await
            .expect("the day of c");
        assert_eq!(
            code(throttle_attempt(&state.db, &["b", "c"], t + 5).await),
            locked,
            "over the day in one row"
        );
        assert_eq!(
            code(throttle_attempt(&state.db, &["b", "d"], t + 6).await),
            wait
        );
        assert_eq!(
            code(throttle_attempt(&state.db, &["c", "e"], t + 6).await),
            locked,
            "a locked row answers locked, also when it is too soon"
        );
        assert_eq!(
            rows().await,
            vec![one("@a", 1), one("b", 2), one("c", 1001)]
        );
    }

    #[tokio::test]
    async fn an_attempt_counts_under_every_row_or_none() {
        let (state, path) = temp_state("throttle_rows").await;
        every_row_or_none(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("throttle_rows").await {
            every_row_or_none(&state).await;
            pg_done(state, pg).await;
        }
    }

    async fn pace_shows_no_account(state: &AppState) {
        let _ = register_text(state, "mom").await.expect("mom");
        let wait = || {
            Err((
                StatusCode::TOO_MANY_REQUESTS,
                "Wait 3 seconds between attempts".to_string(),
            ))
        };
        let wrong = || Err((StatusCode::UNAUTHORIZED, "Invalid credentials".to_string()));
        let pairs = [
            ("xyz", "xyz\u{200b}", wait()),
            ("mom", "rn0m", wait()),
            ("sue", "SU\u{435}", wait()),
            ("\u{13b7}o\u{13b7}", "mom", wait()),
            ("mom", "\u{13b7}o\u{13b7}", wait()),
            ("\u{13b7}e\u{13b7}", "mem", wait()),
        ];
        for (n, (first, then, answer)) in (0i64..).zip(pairs) {
            let t = CLOCK + 10 * n;
            assert_eq!(sign_in(state, first, "x", t).await, wrong(), "{first:?}");
            assert_eq!(
                sign_in(state, then, "x", t + 1).await,
                answer,
                "{first:?} then {then:?}"
            );
        }
        let mut rows = sqlx::query("SELECT username, count FROM login_attempts")
            .fetch_all(&state.db)
            .await
            .expect("attempts")
            .iter()
            .map(|r| {
                let name: String = r.try_get(0).expect("name");
                (name, r.try_get::<i64, _>(1).expect("count"))
            })
            .collect::<Vec<_>>();
        rows.sort();
        assert_eq!(
            rows,
            [
                ("@rnern", 1),
                ("@rnorn", 3),
                ("@sue", 1),
                ("@xyz", 1),
                ("mom", 3)
            ]
            .map(|(name, count)| (name.to_string(), count)),
            "a name counts under its keys, and under the account it reaches"
        );

        let capitals = [
            ("bob", "\u{392}ob"),
            ("\u{392}ob", "bob"),
            ("alice", "AIice"),
            ("AIice", "alice"),
            ("max", "\u{39c}ax"),
            ("tom", "\u{422}om"),
            ("kate", "\u{39a}ate"),
            ("hank", "\u{397}ank"),
            ("nina", "\u{39d}ina"),
        ];
        for accounts in [false, true] {
            if accounts {
                for name in ["bob", "alice", "max", "tom", "kate", "hank", "nina"] {
                    let _ = register_text(state, name).await.expect(name);
                }
            }
            for (n, (first, then)) in (0i64..).zip(capitals) {
                let t = CLOCK + 1000 * (1 + i64::from(accounts)) + 10 * n;
                assert_eq!(sign_in(state, first, "x", t).await, wrong(), "{first:?}");
                assert_eq!(
                    sign_in(state, then, "x", t + 1).await,
                    wait(),
                    "{first:?} then {then:?}, with the accounts: {accounts}"
                );
            }
        }

        let _ = register_text(state, "dan").await.expect("dan");
        let spellings = [
            "dan",
            "DAN",
            "d\u{430}n",
            "dan\u{200b}",
            "\u{ff44}\u{ff41}\u{ff4e}",
            "da\u{301}n",
            "Dan",
            "\u{111}an",
        ];
        let at_once = |t: i64| {
            spellings.map(|name| {
                let state = state.clone();
                tokio::spawn(async move { sign_in(&state, name, "x", t).await })
            })
        };
        let mut answers = Vec::new();
        for task in at_once(CLOCK + 5000) {
            answers.push(task.await.expect("join"));
        }
        assert_eq!(
            (
                answers.iter().filter(|a| **a == wrong()).count(),
                answers.iter().filter(|a| **a == wait()).count()
            ),
            (1, 7),
            "one of every spelling at once: {answers:?}"
        );
        sqlx::query("UPDATE login_attempts SET count = 1000 WHERE username = 'dan'")
            .execute(&state.db)
            .await
            .expect("the day of dan");
        let locked = Err((StatusCode::LOCKED, "Account locked for the day".to_string()));
        for task in at_once(CLOCK + 5010) {
            assert_eq!(task.await.expect("join"), locked);
        }
    }

    #[tokio::test]
    async fn the_pace_shows_no_account() {
        let (state, path) = temp_state("pace_no_account").await;
        pace_shows_no_account(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("pace_no_account").await {
            pace_shows_no_account(&state).await;
            pg_done(state, pg).await;
        }
    }
}
