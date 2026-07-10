pub mod admin;
pub mod auth;
pub mod dms;
pub mod embeds;
pub mod media;
pub mod messages;
pub mod openapi;
pub mod servers;

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

use crate::db::{AvatarKind, ChannelKind, Db, MediaKind, User, get_user, setting_on};
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

#[derive(Clone, Serialize, ToSchema)]
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

pub async fn user_ref(db: &Db, username: &str) -> UserRef {
    match get_user(db, username).await {
        Ok(Some(user)) => UserRef::from_user(&user),
        _ => UserRef {
            username: username.to_string(),
            display_name: username.to_string(),
            avatar_kind: AvatarKind::Color,
            avatar_color: Some("#9e9e9e".to_string()),
        },
    }
}

#[derive(Clone, Serialize, ToSchema)]
pub struct ServerSummary {
    pub name: String,
    pub display_name: String,
    pub creator: Option<String>,
    pub is_admin: bool,
}

#[derive(Clone, Serialize, ToSchema)]
pub struct ServerSummaryLite {
    pub name: String,
    pub display_name: String,
    pub creator: Option<String>,
    pub has_password: bool,
}

#[derive(Clone, Serialize, ToSchema)]
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

#[derive(Clone, Serialize, ToSchema)]
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

#[derive(Clone, Serialize, ToSchema)]
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

#[derive(Clone, Serialize, ToSchema)]
pub struct Embed {
    pub ord: i64,
    pub url: String,
    pub site_name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub banner_removed: bool,
}

#[derive(Clone, Serialize, ToSchema)]
pub struct CallLog {
    pub from: String,
    pub answered_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub outcome: Option<String>,
}

#[derive(Clone, Serialize, ToSchema)]
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

#[derive(Clone, Copy, Serialize, ToSchema)]
pub struct Settings {
    pub profanity_filter: bool,
    pub asset_previews: bool,
    pub asset_uploads: bool,
    pub guests_enabled: bool,
}

impl Settings {
    pub async fn load(db: &Db) -> Settings {
        Settings {
            profanity_filter: setting_on(db, "profanity_filter").await,
            asset_previews: setting_on(db, "asset_previews").await,
            asset_uploads: setting_on(db, "asset_uploads").await,
            guests_enabled: setting_on(db, "guests_enabled").await,
        }
    }
}

pub async fn require_guest_ok(db: &Db, user: Option<&User>) -> Result<(), ApiError> {
    match user {
        Some(_) => Ok(()),
        None => match setting_on(db, "guests_enabled").await {
            true => Ok(()),
            false => Err(ApiError(
                StatusCode::UNAUTHORIZED,
                "Guest access is disabled".to_string(),
            )),
        },
    }
}

pub(crate) fn header_grants(headers: &HeaderMap) -> Vec<String> {
    match headers.get("x-guest-grant").and_then(|v| v.to_str().ok()) {
        Some(v) => v
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        None => Vec::new(),
    }
}

pub(crate) async fn grant_matches(db: &Db, grant: &str, server: &str) -> sqlx::Result<bool> {
    Ok(
        sqlx::query("SELECT 1 FROM guest_grants WHERE \"grant\" = $1 AND server = $2")
            .bind(grant)
            .bind(server)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
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

pub fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

pub async fn check_profanity<'e, E>(ex: E, text: &str) -> Result<(), ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    match setting_on(ex, "profanity_filter").await && text.is_inappropriate() {
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
    let row = sqlx::query("SELECT username FROM tokens WHERE token = $1")
        .bind(token)
        .fetch_optional(&state.db)
        .await
        .ok()??;
    let username: String = row.try_get(0).ok()?;
    get_user(&state.db, &username).await.ok()?
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

pub fn routes(state: AppState) -> Router<AppState> {
    let strict = GovernorConfigBuilder::default()
        .per_millisecond(500)
        .burst_size(30)
        .finish()
        .expect("invalid strict rate limit config");
    let strict_routes = Router::new()
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/words/{username}", get(auth::words))
        .route(
            "/media",
            post(media::upload_media).layer(DefaultBodyLimit::max(26 * 1024 * 1024)),
        )
        .route("/servers/{name}/guest_access", post(servers::guest_access))
        .route_layer(GovernorLayer::new(strict));
    Router::new()
        .route("/me", get(auth::me).patch(auth::patch_me))
        .route("/servers", post(servers::create_server))
        .route(
            "/servers/{name}",
            get(servers::get_server)
                .patch(servers::update_server)
                .delete(servers::delete_server),
        )
        .route("/servers/{name}/exists", get(servers::server_exists))
        .route("/server_search", get(servers::search_servers))
        .route("/servers/{name}/members", get(servers::list_members))
        .route("/servers/{name}/interacted", get(servers::list_interacted))
        .route("/servers/{name}/join", post(servers::join_server))
        .route("/servers/{name}/leave", post(servers::leave_server))
        .route("/servers/{name}/channels", post(servers::create_channel))
        .route(
            "/channels/{id}",
            patch(servers::update_channel).delete(servers::delete_channel),
        )
        .route("/servers/{name}/kick", post(servers::kick_member))
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
        .route("/search", get(messages::search))
        .route("/unreads", get(messages::unreads))
        .route("/read", post(messages::mark_read))
        .route("/media/{id}", get(media::download_media))
        .route("/settings", get(admin::get_settings))
        .route("/admin/settings", patch(admin::patch_settings))
        .route("/admin/overview", get(admin::overview))
        .route("/admin/users", get(admin::list_users))
        .route("/admin/servers", get(admin::list_servers))
        .route("/admin/servers/{name}", delete(admin::delete_server))
        .route("/admin/users/{username}", delete(admin::delete_user))
        .route("/admin/users/{username}/servers", get(admin::user_servers))
        .route("/admin/messages/{id}", delete(admin::delete_message))
        .route("/admin/ban", post(admin::ban_user))
        .route("/ws", get(crate::ws::handler))
        .merge(strict_routes)
        .merge(openapi::routes().route_layer(from_fn_with_state(state, require_token)))
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::PathBuf;

    use crate::db::{AvatarKind, Db, User, now, open};
    use crate::state::AppState;
    use crate::ws::Hub;

    pub(crate) async fn temp_state(tag: &str) -> (AppState, PathBuf) {
        let path = std::env::temp_dir().join(format!("rchat_{tag}_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = open(path.to_str()).await.expect("open db");
        (
            AppState {
                db,
                hub: Hub::new(),
                s3: None,
            },
            path,
        )
    }

    pub(crate) async fn done(state: AppState, path: PathBuf) {
        state.db.close().await;
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
            is_site_admin: site_admin,
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
