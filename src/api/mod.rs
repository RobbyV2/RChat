pub mod admin;
pub mod auth;
pub mod dms;
pub mod embeds;
pub mod health;
pub mod instance;
pub mod media;
pub mod messages;
pub mod openapi;
pub mod servers;
pub mod users;

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use rustrict::CensorStr;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tower_governor::{GovernorLayer, governor::GovernorConfigBuilder};
use utoipa::ToSchema;

use crate::config::Roles;
use crate::db::{AvatarKind, ChannelKind, Db, MediaKind, User, get_user, pool_key};
use crate::server::client_ip::ClientIp;
use crate::state::AppState;

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let ApiError(status, error) = self;
        (status, axum::Json(serde_json::json!({ "error": error }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> ApiError {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> ApiError {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct UserRef {
    pub username: String,
    pub display_name: String,
    pub avatar_kind: AvatarKind,
    pub avatar_color: Option<String>,
}

impl UserRef {
    pub fn from_user(user: &User) -> UserRef {
        UserRef {
            username: user.username.clone(),
            display_name: user.display_name.clone(),
            avatar_kind: user.avatar_kind,
            avatar_color: user.avatar_color.clone(),
        }
    }
}

pub fn missing_user(username: &str) -> UserRef {
    UserRef {
        username: username.to_string(),
        display_name: username.to_string(),
        avatar_kind: AvatarKind::Color,
        avatar_color: Some("#9e9e9e".to_string()),
    }
}

pub async fn user_ref(db: &Db, username: &str) -> UserRef {
    match get_user(db, username).await {
        Ok(Some(user)) => UserRef::from_user(&user),
        _ => missing_user(username),
    }
}

pub(crate) fn placeholders(first: usize, count: usize) -> String {
    (first..first + count)
        .map(|n| format!("${n}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn row_user_ref(r: &sqlx::any::AnyRow) -> sqlx::Result<UserRef> {
    Ok(UserRef {
        username: r.try_get(0)?,
        display_name: r.try_get(1)?,
        avatar_kind: AvatarKind::parse(&r.try_get::<String, _>(2)?)?,
        avatar_color: r.try_get(3)?,
    })
}

pub async fn user_refs(db: &Db, names: &[String]) -> HashMap<String, UserRef> {
    let mut keys: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
    keys.sort();
    keys.dedup();
    let mut found: HashMap<String, UserRef> = HashMap::with_capacity(keys.len());
    for chunk in keys.chunks(500) {
        let sql = format!(
            "SELECT username, display_name, avatar_kind, avatar_color FROM users WHERE username IN ({})",
            placeholders(1, chunk.len())
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for key in chunk {
            query = query.bind(key);
        }
        if let Ok(rows) = query.fetch_all(db).await {
            for user in rows.iter().filter_map(|r| row_user_ref(r).ok()) {
                found.insert(user.username.clone(), user);
            }
        }
    }
    names
        .iter()
        .map(|name| {
            let user = match found.get(&name.to_lowercase()) {
                Some(user) => user.clone(),
                None => missing_user(name),
            };
            (name.clone(), user)
        })
        .collect()
}

pub(crate) fn user_from(refs: &HashMap<String, UserRef>, username: &str) -> UserRef {
    match refs.get(username) {
        Some(user) => user.clone(),
        None => missing_user(username),
    }
}

pub const LIST_PAGE: i64 = 50;
pub const LIST_MAX: i64 = 100;

pub(crate) fn unique_capped<I: IntoIterator<Item = String>>(items: I) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items.into_iter().filter(|s| !s.is_empty()) {
        if out.len() == LIST_MAX as usize {
            break;
        }
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

pub(crate) fn split_list(raw: &str) -> Vec<String> {
    unique_capped(raw.split(',').map(|s| s.trim().to_string()))
}

pub const NEXT_CURSOR: &str = "x-next-cursor";

pub(crate) fn encode_cursor(parts: &[&str]) -> String {
    hex::encode(parts.join("\u{1f}"))
}

pub(crate) fn decode_cursor(raw: &str, count: usize) -> Result<Vec<String>, ApiError> {
    let invalid = || ApiError(StatusCode::BAD_REQUEST, "Invalid cursor".to_string());
    let bytes = hex::decode(raw.trim()).map_err(|_| invalid())?;
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    let parts: Vec<String> = text.split('\u{1f}').map(str::to_string).collect();
    match parts.len() == count {
        true => Ok(parts),
        false => Err(invalid()),
    }
}

pub(crate) fn cursor_int(part: &str) -> Result<i64, ApiError> {
    part.parse()
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid cursor".to_string()))
}

pub struct Paged<T>(pub Vec<T>, pub Option<String>);

impl<T: Serialize> IntoResponse for Paged<T> {
    fn into_response(self) -> Response {
        let Paged(items, next) = self;
        let mut res = axum::Json(items).into_response();
        if let Some(cursor) = next
            && let Ok(value) = header::HeaderValue::from_str(&cursor)
        {
            res.headers_mut().insert(NEXT_CURSOR, value);
        }
        res
    }
}

pub(crate) const OFFSET_MAX: i64 = 1_000_000;

pub(crate) fn page_bounds(offset: Option<i64>, limit: Option<i64>) -> (i64, i64) {
    (
        offset.unwrap_or(0).clamp(0, OFFSET_MAX),
        limit.unwrap_or(LIST_PAGE).clamp(1, LIST_MAX),
    )
}

#[derive(Clone, Serialize, ToSchema)]
pub struct ServerSummary {
    pub name: String,
    pub display_name: String,
    pub creator: Option<String>,
    pub is_admin: bool,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ServerSummaryLite {
    pub name: String,
    pub display_name: String,
    pub creator: Option<String>,
    pub has_password: bool,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Channel {
    pub id: i64,
    pub name: String,
    pub kind: ChannelKind,
    pub slowmode_seconds: i64,
}

#[derive(Clone, Serialize, ToSchema)]
pub struct Role {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub perms: i64,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ChannelPerm {
    pub subject: String,
    pub can_view: bool,
    pub can_send: bool,
    pub can_read_history: bool,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Member {
    #[serde(flatten)]
    pub user: UserRef,
    pub is_admin: bool,
    pub is_creator: bool,
    pub online: bool,
    pub perms: i64,
    pub role_ids: Vec<i64>,
}

#[derive(Clone, Serialize, ToSchema)]
pub struct ServerDetail {
    pub name: String,
    pub display_name: String,
    pub creator: Option<String>,
    pub has_password: bool,
    pub channels: Vec<Channel>,
    pub roles: Vec<Role>,
    pub member_count: i64,
    pub online_count: i64,
}

#[derive(Clone, Serialize, ToSchema)]
pub struct DmSummary {
    pub id: i64,
    pub other: UserRef,
    pub is_self: bool,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct MediaRef {
    pub id: String,
    pub filename: String,
    pub kind: MediaKind,
    pub hoster: Option<String>,
    pub expires_at: Option<i64>,
    pub size: Option<i64>,
    pub mime: Option<String>,
    pub removed: bool,
    pub removed_by_author: bool,
    pub spoiler: bool,
}

impl MediaRef {
    pub fn server(id: String, filename: String, spoiler: bool, expires_at: i64) -> MediaRef {
        MediaRef {
            id,
            filename,
            kind: MediaKind::Server,
            hoster: None,
            expires_at: Some(expires_at),
            size: None,
            mime: None,
            removed: false,
            removed_by_author: false,
            spoiler,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Embed {
    pub ord: i64,
    pub url: String,
    pub site_name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub banner_removed: bool,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct CallLog {
    pub from: String,
    pub answered_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub outcome: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Message {
    pub id: i64,
    pub channel_id: Option<i64>,
    pub dm_id: Option<i64>,
    pub thread_root_id: Option<i64>,
    pub author: UserRef,
    pub content: String,
    pub created_at: i64,
    pub reply_count: i64,
    pub media: Option<MediaRef>,
    pub embeds: Vec<Embed>,
    pub kind: String,
    pub call: Option<CallLog>,
}

#[derive(Clone, Copy, Serialize, Deserialize, ToSchema)]
pub struct Settings {
    pub profanity_filter: bool,
    pub asset_previews: bool,
    pub asset_uploads: bool,
    pub guests_enabled: bool,
}

const SETTINGS_TTL: Duration = Duration::from_secs(5);

static SETTINGS_CACHE: LazyLock<Mutex<HashMap<String, (Instant, Settings)>>> =
    LazyLock::new(Default::default);

impl Settings {
    pub const DENY: Settings = Settings {
        profanity_filter: true,
        asset_previews: false,
        asset_uploads: false,
        guests_enabled: false,
    };

    pub async fn load(db: &Db) -> Settings {
        let rows = match sqlx::query(
            "SELECT key, value FROM settings WHERE key IN ('profanity_filter', 'asset_previews', 'asset_uploads', 'guests_enabled')",
        )
            .fetch_all(db)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("settings could not be read, using the last known values: {e}");
                return SETTINGS_CACHE
                    .lock()
                    .ok()
                    .and_then(|cache| cache.get(&pool_key(db)).map(|(_, settings)| *settings))
                    .unwrap_or(Settings::DENY);
            }
        };
        let on = |key: &str| {
            rows.iter()
                .find(|r| r.try_get::<String, _>(0).is_ok_and(|k| k == key))
                .and_then(|r| r.try_get::<String, _>(1).ok())
                .is_none_or(|v| v == "1")
        };
        let settings = Settings {
            profanity_filter: on("profanity_filter"),
            asset_previews: on("asset_previews"),
            asset_uploads: on("asset_uploads"),
            guests_enabled: on("guests_enabled"),
        };
        if let Ok(mut cache) = SETTINGS_CACHE.lock() {
            cache.insert(pool_key(db), (Instant::now(), settings));
        }
        settings
    }

    pub async fn cached(db: &Db) -> Settings {
        let hit = SETTINGS_CACHE.lock().ok().and_then(|cache| {
            cache
                .get(&pool_key(db))
                .filter(|(at, _)| at.elapsed() < SETTINGS_TTL)
                .map(|(_, settings)| *settings)
        });
        match hit {
            Some(settings) => settings,
            None => Settings::load(db).await,
        }
    }

    pub fn forget(db: &Db) {
        if let Ok(mut cache) = SETTINGS_CACHE.lock() {
            cache.remove(&pool_key(db));
        }
    }
}

pub async fn require_guest_ok(db: &Db, user: Option<&User>) -> Result<(), ApiError> {
    match user {
        Some(_) => Ok(()),
        None => match Settings::cached(db).await.guests_enabled {
            true => Ok(()),
            false => Err(ApiError(
                StatusCode::UNAUTHORIZED,
                "Guest access is disabled".to_string(),
            )),
        },
    }
}

pub(crate) const GRANTS_MAX: usize = 100;

pub(crate) fn header_grants(headers: &HeaderMap) -> Vec<String> {
    let mut seen = HashSet::new();
    match headers.get("x-guest-grant").and_then(|v| v.to_str().ok()) {
        Some(v) => v
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty() && seen.insert(*s))
            .take(GRANTS_MAX)
            .map(str::to_string)
            .collect(),
        None => Vec::new(),
    }
}

pub(crate) async fn grant_matches(db: &Db, grant: &str, server: &str) -> sqlx::Result<bool> {
    crate::db::grant_live(db, grant, server).await
}

pub(crate) async fn require_guest_view(
    db: &Db,
    headers: &HeaderMap,
    server: &str,
) -> Result<(), ApiError> {
    let grants = header_grants(headers);
    if grants.is_empty() {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Server is password protected".to_string(),
        ));
    }
    for grant in &grants {
        if grant_matches(db, grant, server).await? {
            return Ok(());
        }
    }
    Err(ApiError(
        StatusCode::UNAUTHORIZED,
        "Invalid grant".to_string(),
    ))
}

pub(crate) async fn require_server_view(
    db: &Db,
    headers: &HeaderMap,
    server: &ServerSummaryLite,
    viewer: Option<&User>,
) -> Result<(), ApiError> {
    if let Some(u) = viewer
        && crate::db::is_banned(db, &server.name, &u.username).await?
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "You are banned from this server".to_string(),
        ));
    }
    if !server.has_password {
        return Ok(());
    }
    match viewer {
        None => require_guest_view(db, headers, &server.name).await,
        Some(u) => {
            if u.is_site_admin {
                return Ok(());
            }
            let member = sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
                .bind(&server.name)
                .bind(&u.username)
                .fetch_optional(db)
                .await?
                .is_some();
            match member {
                true => Ok(()),
                false => Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "Server is password protected".to_string(),
                )),
            }
        }
    }
}

pub const NAME_MAX: usize = 100;
pub const MESSAGE_MAX: usize = 4000;
pub const SLOWMODE_MAX: i64 = 21600;

pub fn check_len(text: &str, max: usize, what: &str) -> Result<(), ApiError> {
    match text.chars().count() > max {
        true => Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("{what} must be at most {max} characters"),
        )),
        false => Ok(()),
    }
}

pub fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

const URL_PUNCT: &str = "-._~:/?#[]@!$&'()*+,;=%";
const URL_DELIMS: [char; 7] = ['/', '?', '#', '&', '=', ':', '@'];

fn url_len(text: &str, at: usize) -> Option<usize> {
    let rest = &text[at..];
    let scheme = ["http://", "https://"].iter().any(|s| {
        rest.get(..s.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(s))
    });
    let bounded = !text[..at]
        .chars()
        .next_back()
        .is_some_and(|c| c.is_alphanumeric() || c == '_');
    match scheme && bounded {
        true => Some(
            rest.find(|c: char| !c.is_ascii_alphanumeric() && !URL_PUNCT.contains(c))
                .unwrap_or(rest.len()),
        ),
        false => None,
    }
}

fn words(text: &str) -> impl DoubleEndedIterator<Item = &str> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
}

fn push_words(phrases: &mut Vec<String>, phrase: &mut String, text: &str, gap: &str) {
    let short = |w: &str| w.chars().count() <= 2;
    let before = words(phrase).next_back().map(short);
    let after = words(text).next().map(short);
    match (before, after) {
        (Some(a), Some(b)) if a != b => phrases.push(std::mem::take(phrase)),
        _ => phrase.push_str(gap),
    }
    phrase.push_str(text);
}

fn issue_refs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev = None;
    for (i, c) in text.char_indices() {
        let rest = &text[i + c.len_utf8()..];
        let digits = rest.len() - rest.trim_start_matches(|d: char| d.is_ascii_digit()).len();
        let reference = c == '#'
            && !prev.is_some_and(|p: char| p.is_alphanumeric())
            && digits > 0
            && !rest[digits..].starts_with(|n: char| n.is_alphanumeric());
        out.push(if reference { ' ' } else { c });
        prev = Some(c);
    }
    out
}

fn phrases(text: &str, bridge: bool) -> Vec<String> {
    let mut phrases = Vec::new();
    let mut phrase = String::with_capacity(text.len());
    let mut at = 0;
    for (i, _) in text.char_indices() {
        if i < at {
            continue;
        }
        let Some(len) = url_len(text, i) else {
            continue;
        };
        push_words(&mut phrases, &mut phrase, &text[at..i], "");
        let url = percent_encoding::percent_decode_str(&text[i..i + len]).decode_utf8_lossy();
        for (n, part) in url.split(URL_DELIMS).filter(|p| !p.is_empty()).enumerate() {
            match (bridge, n) {
                (true, 0 | 1) => {}
                (false, 0) => push_words(&mut phrases, &mut phrase, part, ""),
                (false, 1) => push_words(&mut phrases, &mut phrase, &part.replace('.', " "), " "),
                _ => push_words(&mut phrases, &mut phrase, part, " "),
            }
        }
        at = i + len;
    }
    push_words(&mut phrases, &mut phrase, &text[at..], "");
    phrases.push(phrase);
    phrases
}

pub(crate) fn is_profane(text: &str) -> bool {
    let text = issue_refs(text);
    [false, true]
        .into_iter()
        .flat_map(|bridge| phrases(&text, bridge))
        .any(|p| p.is_inappropriate())
}

pub async fn check_profanity(db: &Db, text: &str) -> Result<(), ApiError> {
    match Settings::cached(db).await.profanity_filter && is_profane(text) {
        true => Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Content blocked by profanity filter".to_string(),
        )),
        false => Ok(()),
    }
}

pub struct Authed(pub User);
pub struct MaybeAuthed(pub Option<User>);

pub(crate) async fn user_for_token(state: &AppState, token: &str) -> Option<User> {
    let row = sqlx::query(
        "SELECT u.* FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1 AND u.password_hash <> '!purging'",
    )
    .bind(token)
    .fetch_optional(&state.read())
    .await
    .ok()??;
    User::from_row(&row).ok()
}

async fn bearer_user(parts: &Parts, state: &AppState) -> Option<User> {
    let header = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = header.strip_prefix("Bearer ")?;
    user_for_token(state, token).await
}

pub(crate) fn request_token(headers: &HeaderMap) -> Option<String> {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match bearer {
        Some(token) => Some(token.to_string()),
        None => headers
            .get(header::COOKIE)?
            .to_str()
            .ok()?
            .split(';')
            .find_map(|part| part.trim().strip_prefix("rchat_token=").map(str::to_string)),
    }
}

async fn require_token(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let user = match request_token(req.headers()) {
        Some(token) => user_for_token(&state, &token).await,
        None => None,
    };
    match user {
        Some(_) => next.run(req).await,
        None => ApiError(StatusCode::UNAUTHORIZED, "Unauthorized".to_string()).into_response(),
    }
}

impl FromRequestParts<AppState> for Authed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Authed, ApiError> {
        match bearer_user(parts, state).await {
            Some(user) => Ok(Authed(user)),
            None => Err(ApiError(
                StatusCode::UNAUTHORIZED,
                "Unauthorized".to_string(),
            )),
        }
    }
}

impl FromRequestParts<AppState> for MaybeAuthed {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<MaybeAuthed, ApiError> {
        Ok(MaybeAuthed(bearer_user(parts, state).await))
    }
}

pub fn routes(state: AppState, roles: &Roles, key: ClientIp) -> Router<AppState> {
    let limiter = || {
        GovernorLayer::new(
            GovernorConfigBuilder::default()
                .per_millisecond(500)
                .burst_size(30)
                .key_extractor(key.clone())
                .finish()
                .expect("invalid strict rate limit config"),
        )
    };
    let strict = limiter();
    let mut router = Router::new();
    if roles.api {
        let invite_routes = Router::new()
            .route("/invites/{name}", get(servers::get_invite))
            .route_layer(limiter())
            .merge(
                Router::new()
                    .route("/servers/{name}/join", post(servers::join_server))
                    .route_layer(limiter()),
            );
        let strict_routes = Router::new()
            .route("/auth/register", post(auth::register))
            .route("/auth/login", post(auth::login))
            .route("/auth/words/{username}", get(auth::words))
            .route("/me/password", post(auth::change_password))
            .route("/servers/{name}/guest_access", post(servers::guest_access))
            .route_layer(strict.clone());
        router = router.merge(api_routes(state, strict_routes, invite_routes));
    }
    if roles.gateway {
        router = router.route("/ws", get(crate::ws::handler));
    }
    if roles.media {
        let upload = Router::new()
            .route(
                "/media",
                post(media::upload_media).layer(DefaultBodyLimit::max(26 * 1024 * 1024)),
            )
            .route_layer(strict);
        router = router
            .merge(upload)
            .route("/media/{id}", get(media::download_media));
    }
    if roles.search {
        router = router
            .route("/search", get(messages::search))
            .route("/server_search", get(servers::search_servers));
    }
    router
}

fn api_routes(
    state: AppState,
    strict_routes: Router<AppState>,
    invite_routes: Router<AppState>,
) -> Router<AppState> {
    Router::new()
        .route("/me", get(auth::me).patch(auth::patch_me))
        .route("/auth/logout", post(auth::logout))
        .route("/me/servers", get(servers::list_my_servers))
        .route("/users/{username}/profile", get(users::profile))
        .route("/servers", post(servers::create_server))
        .route(
            "/servers/{name}",
            get(servers::get_server)
                .patch(servers::update_server)
                .delete(servers::delete_server),
        )
        .route("/servers/{name}/exists", get(servers::server_exists))
        .route("/servers/{name}/members", get(servers::list_members))
        .route("/servers/{name}/interacted", get(servers::list_interacted))
        .route("/servers/{name}/leave", post(servers::leave_server))
        .route("/servers/{name}/channels", post(servers::create_channel))
        .route(
            "/channels/{id}",
            patch(servers::update_channel).delete(servers::delete_channel),
        )
        .route("/servers/{name}/kick", post(servers::kick_member))
        .route(
            "/servers/{name}/bans",
            get(servers::list_bans).post(servers::ban_member),
        )
        .route(
            "/servers/{name}/bans/{username}",
            delete(servers::unban_member),
        )
        .route("/servers/{name}/admins", post(servers::grant_admin))
        .route(
            "/servers/{name}/admins/{username}",
            delete(servers::revoke_admin),
        )
        .route(
            "/servers/{name}/transfer_admin",
            post(servers::transfer_admin),
        )
        .route(
            "/servers/{name}/admins/{username}/perms",
            patch(servers::set_admin_perms),
        )
        .route("/servers/{name}/roles", post(servers::create_role))
        .route(
            "/servers/{name}/roles/{id}",
            patch(servers::update_role).delete(servers::delete_role),
        )
        .route(
            "/servers/{name}/roles/{id}/assign",
            post(servers::assign_role),
        )
        .route(
            "/servers/{name}/roles/{id}/assign/{username}",
            delete(servers::unassign_role),
        )
        .route(
            "/channels/{id}/perms",
            get(servers::list_channel_perms).put(servers::set_channel_perm),
        )
        .route(
            "/channels/{id}/perms/{subject}",
            delete(servers::clear_channel_perm),
        )
        .route(
            "/channels/{id}/messages",
            get(messages::channel_messages).post(messages::send_channel_message),
        )
        .route("/dms", get(dms::list_dms).post(dms::open_dm))
        .route(
            "/dms/{id}/messages",
            get(messages::dm_messages).post(messages::send_dm_message),
        )
        .route("/messages/{id}", delete(messages::delete_message))
        .route("/messages/{id}/media", delete(media::delete_media))
        .route("/messages/{id}/embeds/{ord}", delete(embeds::delete_embed))
        .route(
            "/messages/{id}/thread",
            get(messages::thread_messages).post(messages::send_thread_message),
        )
        .route("/unreads", get(messages::unreads))
        .route("/read", post(messages::mark_read))
        .route("/settings", get(admin::get_settings))
        .route("/instance", get(instance::instance))
        .route("/identity/assertion", post(instance::assertion))
        .route("/admin/settings", patch(admin::patch_settings))
        .route("/admin/overview", get(admin::overview))
        .route("/admin/users", get(admin::list_users))
        .route("/admin/servers", get(admin::list_servers))
        .route("/admin/servers/{name}", delete(admin::delete_server))
        .route("/admin/users/{username}", delete(admin::delete_user))
        .route("/admin/users/{username}/servers", get(admin::user_servers))
        .route("/admin/messages/{id}", delete(admin::delete_message))
        .route("/admin/ban", post(admin::ban_user))
        .merge(strict_routes)
        .merge(invite_routes)
        .merge(openapi::routes().route_layer(from_fn_with_state(state, require_token)))
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::PathBuf;

    use crate::db::{AvatarKind, Db, User, now, open};
    use crate::instance::{Instance, InstanceConfig};
    use crate::state::AppState;
    use crate::ws::Hub;

    pub(crate) async fn temp_state(tag: &str) -> (AppState, PathBuf) {
        let path = std::env::temp_dir().join(format!("rchat_{tag}_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = open(path.to_str()).await.expect("open db");
        let instance = Instance::load(&db, &InstanceConfig::default())
            .await
            .expect("instance");
        (AppState::new(db, Hub::new(), None, None, instance), path)
    }

    pub(crate) async fn done(state: AppState, path: PathBuf) {
        crate::db::close(&state.db).await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    pub(crate) fn mem_user(username: &str, site_admin: bool) -> User {
        User {
            username: username.to_string(),
            display_name: username.to_string(),
            password_hash: String::new(),
            password_kind: "text".to_string(),
            avatar_kind: AvatarKind::Identicon,
            avatar_color: None,
            banner_color: None,
            is_site_admin: site_admin,
            appear_offline: false,
            created_at: now(),
        }
    }

    pub(crate) async fn add_member(
        db: &Db,
        server: &str,
        username: &str,
        is_admin: i64,
        perms: i64,
        joined_at: i64,
    ) {
        sqlx::query("INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES($1, $2, $3, $4, $5)")
            .bind(server)
            .bind(username)
            .bind(is_admin)
            .bind(perms)
            .bind(joined_at)
            .execute(db)
            .await
            .expect("insert member");
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;
    use crate::api::test_util::{done, temp_state};
    use crate::server::client_ip::ProxyTrust;

    #[tokio::test]
    async fn settings_fail_closed_and_never_cache_errors() {
        let (state, path) = temp_state("settings_errors").await;
        let db = state.db.clone();
        sqlx::query("UPDATE settings SET value = '1' WHERE key = 'guests_enabled'")
            .execute(&db)
            .await
            .expect("guests on");
        let good = Settings::load(&db).await;
        assert!(good.guests_enabled && good.asset_uploads);
        crate::db::close(&db).await;
        let stale = Settings::load(&db).await;
        assert!(stale.guests_enabled && stale.asset_uploads);
        Settings::forget(&db);
        let denied = Settings::load(&db).await;
        assert!(!denied.guests_enabled && !denied.asset_uploads && !denied.asset_previews);
        assert!(denied.profanity_filter);
        let still = Settings::cached(&db).await;
        assert!(!still.guests_enabled);
        assert!(SETTINGS_CACHE.lock().unwrap().get(&pool_key(&db)).is_none());
        assert!(crate::db::setting_on(&db, "guests_enabled").await.is_err());
        done(state, path).await;
    }

    #[test]
    fn profanity_ignores_url_punctuation() {
        let clean = [
            "http://localhost:3000/invite/p0/?password=secret",
            "join http://localhost:3000/invite/p0/?password=hunter2 now",
            "HTTPS://Example.com/invite/p0/?password=x and https://example.com/docs/",
            "https://example.com/invite/gamma%20secret/?password=secret",
            "[invite](https://example.com/invite/p0/?password=secret)",
            "https://example.com/invite/p0/?password=p0",
            "https://example.com/invite/p0/ please join",
            "come to https://example.com/invite/p0/?password=secret please",
            "https://example.com/v1/photos/p0/pizza",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://github.com/RobbyV2/RChat/pull/12#issuecomment-123",
            "https://rchat-rebase.example/page",
            "see https://rchat-rebase.example/page please",
            "see #55",
            "PR #1550 merged",
            "issue #560",
            "fixed in (#66) and #65, #656",
            "plain words",
        ];
        for text in clean {
            assert!(!is_profane(text), "{text}");
        }
    }

    #[test]
    fn profanity_reads_phrases_in_urls() {
        let dirty = [
            "you are a fucking idiot",
            "https://example.com/fuck",
            "https://example.com/?q=shit",
            "nice https://example.com/ but fuck this",
            "p0/?password",
            "f u c k",
            "https://x.co/f.u.c.k",
            "https://x.co/sh.it",
            "https://x.co/f_ck",
            "https://x.co/kill-yourself",
            "xhttp://a\u{2800}f\u{2800}u\u{2800}c\u{2800}k",
            "https://x.co/kill\u{2800}yourself",
            "https://x.co/a\u{2800}f\u{2800}u\u{2800}c\u{2800}k",
            "x https://a\u{2800}f\u{2800}u\u{2800}c\u{2800}k",
            "https://x.co/f%75ck",
            "https://x.co/f/u/c/k",
            // Blocked by design: single-letter path parts are read together.
            "https://x.co/a/s/s",
            "https://example.com/a/s/s",
            "https://x.co/kill/yourself",
            "https://x.co/?q=kill+yourself",
            "https://x.co/kill%20yourself",
            "https://x.co/sh!t",
            "kill https://x.co/yourself",
            "kill https://rchat-rebase.example/yourself",
            "https://f.u.c.k/",
            "ass",
            "a55",
            "#ss",
            "#55hole",
            "you a#55",
        ];
        for text in dirty {
            assert!(is_profane(text), "{text}");
        }
    }

    #[tokio::test]
    async fn invites_have_their_own_strict_limiter() {
        let (state, path) = temp_state("strict_invites").await;
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app = routes(state.clone(), &Roles::ALL, ClientIp(trusted)).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        let client = reqwest::Client::new();
        let mut limited = HashMap::new();
        let mut first = HashMap::new();
        for (post, path, tries) in [
            (true, "/servers/rchat/join", 40),
            (false, "/invites/rchat", 40),
            (false, "/auth/words/nobody", 20),
            (false, "/settings", 40),
        ] {
            let mut count = 0;
            for n in 0..tries {
                let url = format!("http://{addr}{path}");
                let req = match post {
                    true => client.post(url),
                    false => client.get(url),
                };
                let res = req
                    .header("X-Forwarded-For", "203.0.113.7")
                    .send()
                    .await
                    .expect("request");
                if n == 0 {
                    first.insert(path, res.status());
                }
                if res.status() == StatusCode::TOO_MANY_REQUESTS {
                    count += 1;
                }
            }
            limited.insert(path, count);
        }
        assert!(limited["/servers/rchat/join"] >= 5, "{limited:?}");
        assert_eq!(first["/invites/rchat"], StatusCode::OK, "{first:?}");
        let other = client
            .get(format!("http://{addr}/invites/rchat"))
            .header("X-Forwarded-For", "198.51.100.9")
            .send()
            .await
            .expect("request");
        server.abort();
        assert_eq!(other.status(), StatusCode::OK);
        assert!(limited["/invites/rchat"] >= 5, "{limited:?}");
        assert_eq!(limited["/auth/words/nobody"], 0, "{limited:?}");
        assert_eq!(limited["/settings"], 0, "{limited:?}");
        done(state, path).await;
    }
}
