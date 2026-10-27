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

/// The JSON body of every error the API itself returns.
#[derive(Serialize, ToSchema)]
pub struct ApiErrorBody {
    /// A short, human-readable reason, e.g. `Server not found` or `Unauthorized`.
    pub error: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let ApiError(status, error) = self;
        (status, axum::Json(ApiErrorBody { error })).into_response()
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

/// A user as shown next to messages and in lists. A deleted account still appears, as its
/// username on a grey color avatar.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct UserRef {
    /// Lowercase username, the user's unique key.
    #[schema(example = "alice")]
    pub username: String,
    /// The username in the casing chosen at registration.
    #[schema(example = "Alice")]
    pub display_name: String,
    /// How the avatar is drawn.
    pub avatar_kind: AvatarKind,
    /// Avatar background as lowercase `#rrggbb` when `avatar_kind` is `color`; `null` for
    /// identicons.
    #[schema(example = "#4caf50")]
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

/// A server the signed-in user is a member of.
#[derive(Clone, Serialize, ToSchema)]
pub struct ServerSummary {
    /// Lowercase server name, the server's unique key used in URLs.
    #[schema(example = "rustaceans")]
    pub name: String,
    /// The name in its original casing.
    #[schema(example = "Rustaceans")]
    pub display_name: String,
    /// Username of the creator; `null` for the built-in `rchat` server.
    pub creator: Option<String>,
    /// Whether the signed-in user is an admin of this server.
    pub is_admin: bool,
    /// Background of the server-name header above the channel list as `#rrggbb`; `null`
    /// uses the theme color.
    pub banner_color: Option<String>,
    /// Color of the server name in that header as `#rrggbb`; `null` uses the theme color.
    pub name_color: Option<String>,
}

/// Public facts about a server, without membership details.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ServerSummaryLite {
    /// Lowercase server name, the server's unique key used in URLs.
    #[schema(example = "rustaceans")]
    pub name: String,
    /// The name in its original casing.
    #[schema(example = "Rustaceans")]
    pub display_name: String,
    /// Username of the creator; `null` for the built-in `rchat` server.
    pub creator: Option<String>,
    /// Whether joining (or viewing as a non-member) needs the server password.
    pub has_password: bool,
    /// Background of the server-name header above the channel list as `#rrggbb`; `null`
    /// uses the theme color.
    #[serde(default)]
    pub banner_color: Option<String>,
    /// Color of the server name in that header as `#rrggbb`; `null` uses the theme color.
    #[serde(default)]
    pub name_color: Option<String>,
}

/// A channel in a server.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Channel {
    /// Channel id, unique across the instance.
    pub id: i64,
    /// Channel name, unique within the server, at most 100 characters.
    #[schema(example = "general")]
    pub name: String,
    /// Text or voice.
    pub kind: ChannelKind,
    /// Minimum seconds between two messages from the same member, 0 (off) to 21600; members
    /// with Manage channels or Delete messages are exempt.
    pub slowmode_seconds: i64,
}

/// A server role.
#[derive(Clone, Serialize, ToSchema)]
pub struct Role {
    /// Role id, unique across the instance.
    pub id: i64,
    /// Role name, at most 100 characters.
    #[schema(example = "Moderator")]
    pub name: String,
    /// Name color as `#rrggbb`.
    #[schema(example = "#e91e63")]
    pub color: String,
    /// Permission bits the role grants: 1 Manage channels, 2 Delete messages, 4 Kick (also
    /// bans), 8 Delete server (also edits the server), 16 Manage admins.
    #[schema(example = 6)]
    pub perms: i64,
}

/// Roles the caller can't edit, delete or assign because of who holds them or of the channel
/// permission rules that name them. Every list is empty unless the caller has the Manage admins
/// permission.
#[derive(Clone, Default, Serialize, ToSchema)]
pub struct RoleLimits {
    /// Roles held by another member whose server permissions are not a strict subset of yours.
    /// You can't edit or delete them.
    pub held_above: Vec<i64>,
    /// Roles whose channel permission rules give access you don't have in that channel. You
    /// can't assign them. Always empty when you have Manage channels.
    pub channel_grants: Vec<i64>,
    /// Roles that are the only permission rule on some channel. Deleting one would open that
    /// channel to everyone, so it needs Manage channels. Always empty when you have Manage
    /// channels.
    pub sole_rules: Vec<i64>,
}

/// One permission rule on a channel. A channel with no rules is open to everyone who can see
/// the server. Once it has rules, only members matching a rule with `can_view` (plus members
/// with Manage channels) can see it, and the flags of every matching rule are combined.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ChannelPerm {
    /// Who the rule applies to: `u:<username>` for a user or `r:<role id>` for a role.
    #[schema(example = "r:12")]
    pub subject: String,
    /// The subject can see the channel. Without it the other flags grant nothing.
    pub can_view: bool,
    /// The subject can send messages in the channel.
    pub can_send: bool,
    /// The subject can read messages sent before now.
    pub can_read_history: bool,
}

/// A server member: the user's `UserRef` fields plus their standing in the server.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Member {
    /// The user, flattened into this object.
    #[serde(flatten)]
    pub user: UserRef,
    /// Whether the member is a server admin.
    pub is_admin: bool,
    /// Whether the member created the server.
    pub is_creator: bool,
    /// Whether the member is online in this server right now. Members who chose to appear
    /// offline are always `false`.
    pub online: bool,
    /// Admin permission bits (see `Role.perms`). For an admin, 0 means every permission and
    /// any other value is the granted subset; always 0 for non-admins, whose permissions come
    /// from their roles.
    pub perms: i64,
    /// Ids of the server roles assigned to the member.
    pub role_ids: Vec<i64>,
}

/// A server with its channels and roles.
#[derive(Clone, Serialize, ToSchema)]
pub struct ServerDetail {
    /// Lowercase server name, the server's unique key used in URLs.
    #[schema(example = "rustaceans")]
    pub name: String,
    /// The name in its original casing.
    #[schema(example = "Rustaceans")]
    pub display_name: String,
    /// Username of the creator; `null` for the built-in `rchat` server.
    pub creator: Option<String>,
    /// Whether joining (or viewing as a non-member) needs the server password.
    pub has_password: bool,
    /// Background of the server-name header above the channel list as `#rrggbb`; `null`
    /// uses the theme color.
    pub banner_color: Option<String>,
    /// Color of the server name in that header as `#rrggbb`; `null` uses the theme color.
    pub name_color: Option<String>,
    /// Channels the caller can see, oldest first. Channels with permission rules that do not
    /// grant the caller `can_view` are left out.
    pub channels: Vec<Channel>,
    /// Every role of the server, oldest first.
    pub roles: Vec<Role>,
    /// Roles the caller can't change even though the permission rules on `perms` allow it.
    pub role_limits: RoleLimits,
    /// Number of members.
    pub member_count: i64,
    /// Number of members online in this server right now.
    pub online_count: i64,
}

/// A direct-message conversation of the signed-in user.
#[derive(Clone, Serialize, ToSchema)]
pub struct DmSummary {
    /// Conversation id, used in `/api/dms/{id}/messages`.
    pub id: i64,
    /// The other participant; the signed-in user for the conversation with yourself.
    pub other: UserRef,
    /// Whether this is the conversation with yourself.
    pub is_self: bool,
}

/// A file attached to a message, stored on the server or shared peer to peer.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct MediaRef {
    /// 32 hex characters. For `server` media, download it from `/api/media/{id}`; for `p2p`
    /// it is the id the hoster's browser shares the file under.
    #[schema(example = "9f86d081884c7d659a2feaa0c55ad015")]
    pub id: String,
    /// Original file name.
    #[schema(example = "photo.png")]
    pub filename: String,
    /// Where the bytes live.
    pub kind: MediaKind,
    /// Username of the user sharing a `p2p` file; `null` for `server` media.
    pub hoster: Option<String>,
    /// Unix seconds when the file goes away: 24 hours after upload for `server` media, and
    /// the sender's chosen expiry for `p2p` media (`null` means no expiry).
    pub expires_at: Option<i64>,
    /// Size in bytes, known for `p2p` media; `null` for `server` media.
    pub size: Option<i64>,
    /// MIME type, known for `p2p` media; `null` for `server` media.
    pub mime: Option<String>,
    /// The attachment is gone: it expired, or its author or a moderator removed it.
    pub removed: bool,
    /// The attachment was removed on purpose rather than expiring.
    pub removed_by_author: bool,
    /// Clients blur the attachment until it is clicked.
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

/// A link preview built from a page's OpenGraph, Twitter card or `<title>` metadata. Up to 3
/// per message, fetched after the message is sent when link previews are on.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Embed {
    /// Position of the link among the message's previewed links, from 0.
    pub ord: i64,
    /// The linked URL.
    #[schema(example = "https://example.com/post")]
    pub url: String,
    /// Site name, at most 200 characters, or `null` if the page has none.
    pub site_name: Option<String>,
    /// Page title, at most 300 characters, or `null`.
    pub title: Option<String>,
    /// Page description, at most 600 characters, or `null`.
    pub description: Option<String>,
    /// Absolute http(s) URL of the preview image, or `null`.
    pub image_url: Option<String>,
    /// The preview image was removed; the text part stays.
    pub banner_removed: bool,
}

/// What happened to a direct-message call.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct CallLog {
    /// Username of the caller.
    pub from: String,
    /// Unix seconds when the call was answered; `null` if it was not (yet).
    pub answered_at: Option<i64>,
    /// Unix seconds when the call ended; `null` while it is still ringing or in progress.
    pub ended_at: Option<i64>,
    /// `completed`, `declined` or `missed` once ended; `null` before that.
    #[schema(example = "completed")]
    pub outcome: Option<String>,
}

/// A message in a channel, a direct-message conversation or a thread.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Message {
    /// Message id, unique across the instance and increasing over time.
    pub id: i64,
    /// The channel it was sent in; `null` for direct messages.
    pub channel_id: Option<i64>,
    /// The direct-message conversation it was sent in; `null` for channel messages.
    pub dm_id: Option<i64>,
    /// For a thread reply, the id of the message the thread hangs off; `null` otherwise.
    pub thread_root_id: Option<i64>,
    /// Who sent it.
    pub author: UserRef,
    /// Text, at most 4000 characters; may be empty when there is an attachment, and is empty
    /// for call logs.
    pub content: String,
    /// Unix seconds when it was sent.
    pub created_at: i64,
    /// Number of thread replies to this message.
    pub reply_count: i64,
    /// The attachment, or `null`.
    pub media: Option<MediaRef>,
    /// Link previews; empty until they are fetched, then delivered by the `embeds_resolved`
    /// WebSocket event and included in later reads.
    pub embeds: Vec<Embed>,
    /// `user` for a normal message or `call` for a direct-message call log.
    #[schema(example = "user")]
    pub kind: String,
    /// Call details when `kind` is `call`; `null` otherwise.
    pub call: Option<CallLog>,
}

/// A text field the profanity filter can check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfanityTarget {
    Messages,
    Usernames,
    ServerNames,
    ChannelNames,
    RoleNames,
    FileNames,
    Bios,
}

impl ProfanityTarget {
    pub const ALL: [ProfanityTarget; 7] = [
        ProfanityTarget::Messages,
        ProfanityTarget::Usernames,
        ProfanityTarget::ServerNames,
        ProfanityTarget::ChannelNames,
        ProfanityTarget::RoleNames,
        ProfanityTarget::FileNames,
        ProfanityTarget::Bios,
    ];

    pub fn switch(self) -> ProfanitySwitch {
        match self {
            ProfanityTarget::Messages => ProfanitySwitch::Messages,
            ProfanityTarget::Usernames => ProfanitySwitch::Usernames,
            ProfanityTarget::ServerNames => ProfanitySwitch::ServerNames,
            ProfanityTarget::ChannelNames => ProfanitySwitch::ChannelNames,
            ProfanityTarget::RoleNames => ProfanitySwitch::RoleNames,
            ProfanityTarget::FileNames => ProfanitySwitch::FileNames,
            ProfanityTarget::Bios => ProfanitySwitch::Bios,
        }
    }
}

/// A stored profanity setting: one per target, plus `Links`, which only modifies `Messages`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfanitySwitch {
    Messages,
    Links,
    Usernames,
    ServerNames,
    ChannelNames,
    RoleNames,
    FileNames,
    Bios,
}

impl ProfanitySwitch {
    pub const ALL: [ProfanitySwitch; 8] = [
        ProfanitySwitch::Messages,
        ProfanitySwitch::Links,
        ProfanitySwitch::Usernames,
        ProfanitySwitch::ServerNames,
        ProfanitySwitch::ChannelNames,
        ProfanitySwitch::RoleNames,
        ProfanitySwitch::FileNames,
        ProfanitySwitch::Bios,
    ];

    pub fn name(self) -> &'static str {
        match self {
            ProfanitySwitch::Messages => "messages",
            ProfanitySwitch::Links => "links",
            ProfanitySwitch::Usernames => "usernames",
            ProfanitySwitch::ServerNames => "server_names",
            ProfanitySwitch::ChannelNames => "channel_names",
            ProfanitySwitch::RoleNames => "role_names",
            ProfanitySwitch::FileNames => "file_names",
            ProfanitySwitch::Bios => "bios",
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            ProfanitySwitch::Messages => "profanity_messages",
            ProfanitySwitch::Links => "profanity_links",
            ProfanitySwitch::Usernames => "profanity_usernames",
            ProfanitySwitch::ServerNames => "profanity_server_names",
            ProfanitySwitch::ChannelNames => "profanity_channel_names",
            ProfanitySwitch::RoleNames => "profanity_role_names",
            ProfanitySwitch::FileNames => "profanity_file_names",
            ProfanitySwitch::Bios => "profanity_bios",
        }
    }

    pub fn parse(name: &str) -> Option<ProfanitySwitch> {
        ProfanitySwitch::ALL
            .into_iter()
            .find(|t| t.name().eq_ignore_ascii_case(name))
    }
}

const DEPRECATED_DISPLAY_NAMES: &str = "display_names";

static DISPLAY_NAMES_WARNED: std::sync::Once = std::sync::Once::new();

fn warn_display_names() {
    DISPLAY_NAMES_WARNED.call_once(|| {
        tracing::warn!(
            "profanity target \"display_names\" is deprecated and ignored: display names are covered by usernames and server_names"
        );
    });
}

/// Where the profanity filter applies when `profanity_filter` is on. `links` covers the
/// domain part of URLs inside messages: off skips `scheme://host` and still reads the
/// path and the prose.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProfanityTargets {
    /// Message text in server channels and threads (not direct messages).
    pub messages: bool,
    /// The domain part of URLs inside messages.
    pub links: bool,
    /// Usernames at registration.
    pub usernames: bool,
    /// Server names.
    pub server_names: bool,
    /// Channel names.
    pub channel_names: bool,
    /// Role names.
    pub role_names: bool,
    /// File names of attachments in server channels and threads.
    pub file_names: bool,
    /// Profile descriptions.
    #[serde(default = "target_default")]
    pub bios: bool,
}

fn target_default() -> bool {
    true
}

impl Default for ProfanityTargets {
    fn default() -> ProfanityTargets {
        ProfanityTargets::ALL
    }
}

impl ProfanityTargets {
    pub const ALL: ProfanityTargets = ProfanityTargets {
        messages: true,
        links: true,
        usernames: true,
        server_names: true,
        channel_names: true,
        role_names: true,
        file_names: true,
        bios: true,
    };

    pub fn from_fn(mut on: impl FnMut(ProfanitySwitch) -> bool) -> ProfanityTargets {
        ProfanityTargets {
            messages: on(ProfanitySwitch::Messages),
            links: on(ProfanitySwitch::Links),
            usernames: on(ProfanitySwitch::Usernames),
            server_names: on(ProfanitySwitch::ServerNames),
            channel_names: on(ProfanitySwitch::ChannelNames),
            role_names: on(ProfanitySwitch::RoleNames),
            file_names: on(ProfanitySwitch::FileNames),
            bios: on(ProfanitySwitch::Bios),
        }
    }

    pub fn get(&self, switch: ProfanitySwitch) -> bool {
        let ProfanityTargets {
            messages,
            links,
            usernames,
            server_names,
            channel_names,
            role_names,
            file_names,
            bios,
        } = *self;
        match switch {
            ProfanitySwitch::Messages => messages,
            ProfanitySwitch::Links => links,
            ProfanitySwitch::Usernames => usernames,
            ProfanitySwitch::ServerNames => server_names,
            ProfanitySwitch::ChannelNames => channel_names,
            ProfanitySwitch::RoleNames => role_names,
            ProfanitySwitch::FileNames => file_names,
            ProfanitySwitch::Bios => bios,
        }
    }

    pub fn parse_list(list: &str) -> ProfanityTargets {
        let names: Vec<&str> = list
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if names
            .iter()
            .any(|n| n.eq_ignore_ascii_case(DEPRECATED_DISPLAY_NAMES))
        {
            warn_display_names();
        }
        let names: Vec<&str> = names
            .into_iter()
            .filter(|n| !n.eq_ignore_ascii_case(DEPRECATED_DISPLAY_NAMES))
            .collect();
        let unknown: Vec<&str> = names
            .iter()
            .copied()
            .filter(|n| {
                ProfanitySwitch::parse(n).is_none()
                    && !n.eq_ignore_ascii_case("none")
                    && !n.eq_ignore_ascii_case("all")
            })
            .collect();
        let none = names.iter().any(|n| n.eq_ignore_ascii_case("none"));
        let all = names.iter().any(|n| n.eq_ignore_ascii_case("all"));
        let known = names.iter().any(|n| ProfanitySwitch::parse(n).is_some());
        if !unknown.is_empty() {
            tracing::warn!(
                "PROFANITY_TARGETS: unknown target(s) {unknown:?}, filtering everything instead"
            );
            return ProfanityTargets::ALL;
        }
        match (all, known, none) {
            (true, _, _) | (false, false, false) => ProfanityTargets::ALL,
            _ => ProfanityTargets::from_fn(|t| {
                names.iter().any(|n| ProfanitySwitch::parse(n) == Some(t))
            }),
        }
    }
}

pub fn profanity_seed(filter: Option<&str>, targets: Option<&str>) -> Vec<(&'static str, bool)> {
    let filter = !filter.is_some_and(|v| {
        matches!(
            v.trim().to_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        )
    });
    let targets = match targets.map(str::trim).filter(|v| !v.is_empty()) {
        Some(list) => ProfanityTargets::parse_list(list),
        None => ProfanityTargets::ALL,
    };
    std::iter::once(("profanity_filter", filter))
        .chain(
            ProfanitySwitch::ALL
                .into_iter()
                .map(|t| (t.key(), targets.get(t))),
        )
        .collect()
}

/// Instance-wide feature switches. Changes reach clients through the `settings_changed`
/// WebSocket event.
#[derive(Clone, Copy, Serialize, Deserialize, ToSchema)]
pub struct Settings {
    /// Master switch of the profanity filter. When on, content matching a target in
    /// `profanity_targets` is rejected with 400 `Content blocked by profanity filter`.
    pub profanity_filter: bool,
    /// Which texts the filter checks while `profanity_filter` is on.
    #[serde(default)]
    pub profanity_targets: ProfanityTargets,
    /// Link previews: the server fetches page metadata for links in messages.
    pub asset_previews: bool,
    /// File uploads through `POST /api/media`.
    pub asset_uploads: bool,
    /// Guest access: reading servers without an account.
    pub guests_enabled: bool,
}

const SETTINGS_TTL: Duration = Duration::from_secs(5);

static SETTINGS_CACHE: LazyLock<Mutex<HashMap<String, (Instant, Settings)>>> =
    LazyLock::new(Default::default);

impl Settings {
    pub const DENY: Settings = Settings {
        profanity_filter: true,
        profanity_targets: ProfanityTargets::ALL,
        asset_previews: false,
        asset_uploads: false,
        guests_enabled: false,
    };

    pub async fn load(db: &Db) -> Settings {
        let rows = match sqlx::query(
            "SELECT key, value FROM settings WHERE key IN ('profanity_filter', 'asset_previews', 'asset_uploads', 'guests_enabled') OR key LIKE 'profanity\\_%' ESCAPE '\\'",
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
        if rows.iter().any(|r| {
            r.try_get::<String, _>(0)
                .is_ok_and(|k| k == "profanity_display_names")
        }) {
            warn_display_names();
        }
        let on = |key: &str| {
            rows.iter()
                .find(|r| r.try_get::<String, _>(0).is_ok_and(|k| k == key))
                .and_then(|r| r.try_get::<String, _>(1).ok())
                .is_none_or(|v| v == "1")
        };
        let settings = Settings {
            profanity_filter: on("profanity_filter"),
            profanity_targets: ProfanityTargets::from_fn(|t| on(t.key())),
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

const NUMBER_RUN: usize = 5;
const NUMBER_KEEP: usize = 3;
const NUMBER_WORDS: [&str; 6] = ["58008", "80085", "800855", "5318008", "8008135", "55378008"];

fn long_numbers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut prev = None;
    while let Some(c) = rest.chars().next() {
        let digits = rest.len() - rest.trim_start_matches(|d: char| d.is_ascii_digit()).len();
        if digits == 0 {
            out.push(c);
            prev = Some(c);
            rest = &rest[c.len_utf8()..];
            continue;
        }
        let run = &rest[..digits];
        let number = digits >= NUMBER_RUN
            && !rest[digits..].starts_with(|n: char| n.is_alphanumeric())
            && !NUMBER_WORDS.contains(&run);
        let keep = match (number, prev.is_some_and(|p: char| p.is_alphanumeric())) {
            (false, _) => digits,
            (true, true) => NUMBER_KEEP,
            (true, false) => 0,
        };
        out.push_str(&run[..keep]);
        out.extend(std::iter::repeat_n(' ', digits - keep));
        prev = run.chars().next_back();
        rest = &rest[digits..];
    }
    out
}

fn phrases(text: &str, bridge: bool, links: bool) -> Vec<String> {
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
        let span = &text[i..i + len];
        let skip_host = bridge || (!links && skips_host(span));
        let url = percent_encoding::percent_decode_str(span).decode_utf8_lossy();
        for (n, part) in url.split(URL_DELIMS).filter(|p| !p.is_empty()).enumerate() {
            match (skip_host, n) {
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

const URL_TRAILING: &str = ".,;:!?)'\"";

fn plausible_host(authority: &str) -> bool {
    let host = match authority.rsplit_once(':') {
        Some((host, port))
            if !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            host
        }
        Some(_) => return false,
        None => authority,
    };
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |l: &&str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    let ipv4 = labels.len() == 4
        && labels
            .iter()
            .all(|l| !l.is_empty() && l.len() <= 3 && l.parse::<u8>().is_ok());
    let tld = labels
        .last()
        .is_some_and(|t| t.len() >= 2 && t.bytes().all(|b| b.is_ascii_alphabetic()));
    host.eq_ignore_ascii_case("localhost")
        || ipv4
        || (labels.len() >= 2 && host.len() <= 253 && labels.iter().all(label_ok) && tld)
}

fn skips_host(span: &str) -> bool {
    let span = span.trim_end_matches(|c| URL_TRAILING.contains(c));
    let after_scheme = &span[span.find("://").map_or(span.len(), |n| n + 3)..];
    let end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    plausible_host(&after_scheme[..end])
}

pub(crate) fn is_profane(text: &str, links: bool) -> bool {
    let text = long_numbers(&issue_refs(text));
    [false, true]
        .into_iter()
        .flat_map(|bridge| phrases(&text, bridge, links))
        .any(|p| p.is_inappropriate())
}

impl Settings {
    pub fn blocks(&self, target: ProfanityTarget, text: &str) -> bool {
        let targets = self.profanity_targets;
        let links = match target {
            ProfanityTarget::Messages => targets.links,
            ProfanityTarget::Usernames
            | ProfanityTarget::ServerNames
            | ProfanityTarget::ChannelNames
            | ProfanityTarget::RoleNames
            | ProfanityTarget::FileNames
            | ProfanityTarget::Bios => true,
        };
        self.profanity_filter && targets.get(target.switch()) && is_profane(text, links)
    }

    pub fn check_profanity(&self, target: ProfanityTarget, text: &str) -> Result<(), ApiError> {
        match self.blocks(target, text) {
            true => Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Content blocked by profanity filter".to_string(),
            )),
            false => Ok(()),
        }
    }
}

pub async fn check_profanity(db: &Db, target: ProfanityTarget, text: &str) -> Result<(), ApiError> {
    Settings::cached(db).await.check_profanity(target, text)
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
            bio: None,
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

    fn settings_with(filter: bool, targets: ProfanityTargets) -> Settings {
        Settings {
            profanity_filter: filter,
            profanity_targets: targets,
            ..Settings::DENY
        }
    }

    #[test]
    fn each_profanity_target_switches_alone() {
        for switch in ProfanitySwitch::ALL {
            let off = ProfanityTargets::from_fn(|t| t != switch);
            let all = settings_with(true, ProfanityTargets::ALL);
            let without = settings_with(true, off);
            let (checked, text) = match ProfanityTarget::ALL
                .into_iter()
                .find(|t| t.switch() == switch)
            {
                Some(target) => (target, "fuck"),
                None => (ProfanityTarget::Messages, "see https://fuck.co/"),
            };
            assert!(all.blocks(checked, text), "{switch:?} on");
            assert!(!without.blocks(checked, text), "{switch:?} off");
            assert!(all.check_profanity(checked, "hello there").is_ok());
            for other in ProfanityTarget::ALL {
                if other.switch() != switch {
                    assert!(without.blocks(other, "fuck"), "{switch:?} off, {other:?}");
                }
            }
            assert_eq!(ProfanitySwitch::parse(switch.name()), Some(switch));
        }
        assert_eq!(ProfanitySwitch::parse("display_names"), None);
    }

    #[test]
    fn master_switch_off_disables_every_target() {
        let off = settings_with(false, ProfanityTargets::ALL);
        for target in ProfanityTarget::ALL {
            assert!(!off.blocks(target, "fuck https://x.co/shit"), "{target:?}");
            assert!(off.check_profanity(target, "fuck").is_ok());
        }
    }

    #[test]
    fn links_off_skips_urls_and_still_reads_prose() {
        let s = settings_with(
            true,
            ProfanityTargets {
                links: false,
                ..ProfanityTargets::ALL
            },
        );
        let m = ProfanityTarget::Messages;
        let on = settings_with(true, ProfanityTargets::ALL);
        for clean in [
            "https://fuck.co/",
            "see https://shit.example.com/page and more",
            "https://f.u.c.k.co/",
            "https://cockburn.ca/",
            "https://therapist.com/",
        ] {
            assert!(!s.blocks(m, clean), "{clean}");
        }
        for dirty in [
            "nice https://example.com/ but fuck this",
            "fuck https://x.co/",
            "you are a fucking idiot",
            "f u c k",
            "http://fuck",
            "http://nigger",
            "http://you-fucking-idiot",
            "http://x/you,are,a,fucking,idiot",
            "http://x.co/kill-yourself",
            "http://x.co/%66uck",
            "http://x.co/!fuck!you",
            "https://example.com/fuck",
            "nice https://x.co/?q=shit see",
            "kill https://x.co/yourself",
            "kill http://x.co yourself",
            "fu http://x.co ck",
            "https://x.co/#fuck",
            "https://x.co:8080/fuck",
            "http://127.0.0.1/fuck",
            "http://localhost:3000/a?b=fuck",
            "http://fuck@x.co/",
            "http://fuck.c0/",
            "http://x.co:fuck/",
            "see https://x.co/fuck).",
        ] {
            assert!(s.blocks(m, dirty), "{dirty}");
            assert!(on.blocks(m, dirty), "links on: {dirty}");
        }
        for clean in [
            "http://localhost:3000/invite/p0/?password=hunter2",
            "join https://rchat.example.com/invite/My%20Club/?password=correct-horse-battery now",
            "https://rchat-rebase.example/page",
            "https://github.com/org/repo/pull/1550",
            "see https://x.co/abc).",
            "http://192.168.1.10:8080/status?ok=1",
        ] {
            assert!(!s.blocks(m, clean), "links off: {clean}");
            assert!(!on.blocks(m, clean), "links on: {clean}");
        }
        assert!(s.blocks(ProfanityTarget::ChannelNames, "https://x.co/fuck"));
        let no_messages = settings_with(
            true,
            ProfanityTargets {
                messages: false,
                ..ProfanityTargets::ALL
            },
        );
        assert!(!no_messages.blocks(m, "https://x.co/fuck and fuck"));
    }

    #[test]
    fn profanity_env_seed_parsing() {
        let seed = |f: Option<&str>, t: Option<&str>| profanity_seed(f, t);
        let on = |pairs: &[(&str, bool)], key: &str| {
            pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
        };
        let defaults = seed(None, None);
        assert_eq!(defaults.len(), 1 + ProfanitySwitch::ALL.len());
        assert!(defaults.iter().all(|(_, v)| *v));
        for off in ["off", "0", "false", " OFF ", "no"] {
            assert_eq!(
                on(&seed(Some(off), None), "profanity_filter"),
                Some(false),
                "{off}"
            );
        }
        for v in ["on", "1", "true", ""] {
            assert_eq!(
                on(&seed(Some(v), None), "profanity_filter"),
                Some(true),
                "{v}"
            );
        }
        let some = seed(None, Some(" Messages, server_names,display_names "));
        for switch in ProfanitySwitch::ALL {
            let want = matches!(
                switch,
                ProfanitySwitch::Messages | ProfanitySwitch::ServerNames
            );
            assert_eq!(on(&some, switch.key()), Some(want), "{switch:?}");
        }
        assert!(!some.iter().any(|(k, _)| k.contains("display")));
        for typo in [
            "message",
            "bogus",
            "messages,bogus",
            "none,bogus",
            "display_names",
            ",",
        ] {
            assert!(
                seed(None, Some(typo)).iter().all(|(_, v)| *v),
                "{typo} must fail closed"
            );
        }
        assert!(seed(None, Some("all")).iter().all(|(_, v)| *v));
        assert!(seed(None, Some("messages,all")).iter().all(|(_, v)| *v));
        assert!(seed(None, Some("  ")).iter().all(|(_, v)| *v));
        let none = seed(None, Some("none"));
        assert!(none.iter().all(|(k, v)| *v == (*k == "profanity_filter")));
        let bios = seed(None, Some("bios"));
        for switch in ProfanitySwitch::ALL {
            let want = switch == ProfanitySwitch::Bios;
            assert_eq!(on(&bios, switch.key()), Some(want), "{switch:?}");
        }
        assert_eq!(on(&bios, "profanity_bios"), Some(true));
    }

    #[tokio::test]
    async fn profanity_env_seed_fills_only_missing_settings() {
        let (state, path) = temp_state("profanity_seed").await;
        let db = state.db.clone();
        sqlx::query("DELETE FROM settings WHERE key LIKE 'profanity%'")
            .execute(&db)
            .await
            .expect("clear");
        sqlx::query("INSERT INTO settings(key, value) VALUES('profanity_role_names', '1'), ('profanity_display_names', '0')")
            .execute(&db)
            .await
            .expect("stored");
        let mut conn = db.acquire().await.expect("conn");
        crate::db::seed_settings(
            &mut conn,
            &profanity_seed(Some("off"), Some("messages,links")),
        )
        .await
        .expect("seed");
        crate::db::seed_settings(&mut conn, &profanity_seed(None, None))
            .await
            .expect("reseed");
        drop(conn);
        let s = Settings::load(&db).await;
        assert!(!s.profanity_filter);
        assert_eq!(
            s.profanity_targets,
            ProfanityTargets {
                messages: true,
                links: true,
                role_names: true,
                ..ProfanityTargets::from_fn(|_| false)
            }
        );
        done(state, path).await;
    }

    #[test]
    fn settings_without_profanity_targets_parse_as_all_on() {
        let old: Settings = serde_json::from_value(serde_json::json!({
            "profanity_filter": true,
            "asset_previews": true,
            "asset_uploads": false,
            "guests_enabled": true,
        }))
        .expect("old replica settings");
        assert_eq!(old.profanity_targets, ProfanityTargets::ALL);
        let stale: Settings = serde_json::from_value(serde_json::json!({
            "profanity_filter": true,
            "profanity_targets": {
                "messages": false, "links": true, "usernames": true, "display_names": false,
                "server_names": true, "channel_names": true, "role_names": true, "file_names": true,
            },
            "asset_previews": true,
            "asset_uploads": false,
            "guests_enabled": true,
        }))
        .expect("stale display_names field");
        assert!(stale.profanity_targets.bios);
        assert!(!stale.profanity_targets.messages && stale.profanity_targets.usernames);
    }

    #[tokio::test]
    async fn profanity_settings_fail_closed() {
        let (state, path) = temp_state("profanity_errors").await;
        let db = state.db.clone();
        sqlx::query("UPDATE settings SET value = '0' WHERE key LIKE 'profanity%'")
            .execute(&db)
            .await
            .expect("all off");
        let off = Settings::load(&db).await;
        assert!(!off.profanity_filter);
        assert_eq!(off.profanity_targets, ProfanityTargets::from_fn(|_| false));
        crate::db::close(&db).await;
        Settings::forget(&db);
        let denied = Settings::cached(&db).await;
        assert!(denied.profanity_filter);
        assert_eq!(denied.profanity_targets, ProfanityTargets::ALL);
        for target in ProfanityTarget::ALL {
            assert!(denied.blocks(target, "fuck"), "{target:?}");
        }
        assert!(denied.blocks(ProfanityTarget::Messages, "https://fuck.co/"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn profanity_targets_gate_each_write_path() {
        use axum::Json;
        use axum::extract::Path;
        use serde_json::{Value, json};

        use crate::api::test_util::mem_user;

        fn req<T: serde::de::DeserializeOwned>(v: Value) -> Json<T> {
            Json(serde_json::from_value(v).expect("request"))
        }
        fn blocked<T>(res: Result<T, ApiError>) -> bool {
            matches!(res, Err(ApiError(StatusCode::BAD_REQUEST, ref m)) if m.contains("profanity"))
        }
        let (state, path) = temp_state("profanity_paths").await;
        let st = || State(state.clone());
        let alice = || Authed(mem_user("alice", false));
        let patch = |body: Value| {
            let state = state.clone();
            async move {
                admin::patch_settings(State(state), Authed(mem_user("root", true)), req(body))
                    .await
                    .expect("patch")
                    .0
            }
        };
        let server = |name: &str| servers::create_server(st(), alice(), req(json!({"name": name})));
        let channel = |name: &str| {
            servers::create_channel(
                st(),
                alice(),
                Path("club".into()),
                req(json!({"name": name})),
            )
        };
        let role = |name: &str| {
            servers::create_role(
                st(),
                alice(),
                Path("club".into()),
                req(json!({"name": name, "color": "#123456", "perms": 0})),
            )
        };
        let register = |name: &str| {
            auth::register(
                st(),
                req(json!({"username": name, "password": "a", "avatar_kind": "identicon"})),
            )
        };

        assert!(
            admin::patch_settings(st(), alice(), req(json!({"profanity_filter": false})))
                .await
                .is_err()
        );
        for name in ["alice", "bob"] {
            sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $1, '', 'text', 'identicon', 0)")
                .bind(name)
                .execute(&state.db)
                .await
                .expect("user");
        }
        let media_seq = std::sync::atomic::AtomicU8::new(0);
        let upload = |filename: &str| {
            let n = media_seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let id = format!("{n:02x}").repeat(16);
            let state = state.clone();
            let filename = filename.to_string();
            async move {
                sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES($1, $2, 'image/png', 1, $3, 'alice', $4)")
                    .bind(&id)
                    .bind(filename)
                    .bind(vec![0u8])
                    .bind(crate::db::now())
                    .execute(&state.db)
                    .await
                    .expect("media");
                json!({"content": "", "media_id": id})
            }
        };
        let club = server("Club").await.expect("club").0;
        let _ = server("Spare").await.expect("spare");
        let general = club.channels[0].id;
        let mods = role("mods").await.expect("mods").0;
        let send =
            |body: Value| messages::send_channel_message(st(), Path(general), alice(), req(body));
        let root = send(json!({"content": "hello"})).await.expect("root").0.id;
        let reply =
            |body: Value| messages::send_thread_message(st(), Path(root), alice(), req(body));
        let rename_server = |key: &str, name: &str| {
            servers::update_server(st(), alice(), Path(key.into()), req(json!({"name": name})))
        };
        let rename_channel = |name: &str| {
            servers::update_channel(st(), alice(), Path(general), req(json!({"name": name})))
        };
        let rename_role = |name: &str| {
            servers::update_role(
                st(),
                alice(),
                Path(("club".into(), mods.id)),
                req(json!({"name": name})),
            )
        };
        let p2p = |filename: &str| json!({"content": "", "p2p": {"filename": filename, "size": 1, "mime": "image/png", "p2p_id": "0123456789abcdef0123456789abcdef"}});

        assert!(blocked(server("shit club").await));
        assert!(blocked(rename_server("club", "shit club").await));
        assert!(rename_server("club", "CLUB").await.is_ok());
        assert!(blocked(channel("shit").await));
        assert!(blocked(rename_channel("shit").await));
        assert!(blocked(role("shit").await));
        assert!(blocked(rename_role("shit").await));
        assert!(blocked(send(json!({"content": "fuck"})).await));
        assert!(blocked(reply(json!({"content": "fuck"})).await));
        assert!(blocked(
            send(json!({"content": "see https://x.co/fuck"})).await
        ));
        assert!(blocked(send(p2p("fuck.png")).await));
        assert!(blocked(send(upload("fuck.png").await).await));
        assert!(blocked(reply(upload("shit.png").await).await));
        assert!(send(upload("cat.png").await).await.is_ok());
        assert!(blocked(register("Fuck").await));

        let dm = dms::open_dm(st(), alice(), req(json!({"username": "bob"})))
            .await
            .expect("dm")
            .0
            .id;
        let dm_send = |body: Value| messages::send_dm_message(st(), Path(dm), alice(), req(body));
        assert!(dm_send(json!({"content": "fuck"})).await.is_ok());
        assert!(dm_send(p2p("fuck.png")).await.is_ok());
        assert!(dm_send(upload("fuck.png").await).await.is_ok());

        let got = patch(json!({"profanity_targets": {"usernames": false}})).await;
        assert!(got.profanity_filter && !got.profanity_targets.usernames);
        assert!(register("Fuck").await.is_ok());
        let ignored = patch(json!({"profanity_targets": {"display_names": false}})).await;
        assert_eq!(ignored.profanity_targets, got.profanity_targets);

        patch(json!({"profanity_targets": {"server_names": false}})).await;
        assert!(server("shit club").await.is_ok());
        assert!(rename_server("spare", "shit spare").await.is_ok());
        assert!(blocked(send(json!({"content": "fuck"})).await));
        assert!(blocked(channel("shit").await));
        assert!(blocked(rename_channel("shit").await));

        patch(json!({"profanity_targets": {"channel_names": false}})).await;
        assert!(channel("shit").await.is_ok());
        assert!(rename_channel("shitpost").await.is_ok());
        assert!(blocked(role("shit").await));
        assert!(blocked(rename_role("shit").await));
        patch(json!({"profanity_targets": {"role_names": false}})).await;
        assert!(role("shit").await.is_ok());
        assert!(rename_role("shitty").await.is_ok());

        assert!(blocked(
            send(json!({"content": "see https://fuck.co/"})).await
        ));
        patch(json!({"profanity_targets": {"links": false}})).await;
        assert!(
            send(json!({"content": "see https://fuck.co/"}))
                .await
                .is_ok()
        );
        assert!(
            reply(json!({"content": "see https://fuck.co/"}))
                .await
                .is_ok()
        );
        assert!(blocked(
            send(json!({"content": "see https://x.co/fuck"})).await
        ));
        assert!(blocked(send(json!({"content": "http://fuck"})).await));
        assert!(blocked(
            send(json!({"content": "fuck https://x.co/"})).await
        ));
        assert!(blocked(send(p2p("fuck.png")).await));
        assert!(blocked(send(upload("fuck.png").await).await));
        patch(json!({"profanity_targets": {"file_names": false}})).await;
        assert!(send(p2p("fuck.png")).await.is_ok());
        assert!(send(upload("fuck.png").await).await.is_ok());
        assert!(reply(upload("shit.png").await).await.is_ok());
        assert!(blocked(reply(json!({"content": "fuck"})).await));
        patch(json!({"profanity_targets": {"messages": false}})).await;
        assert!(send(json!({"content": "fuck"})).await.is_ok());
        assert!(reply(json!({"content": "fuck"})).await.is_ok());

        let all_on = json!({"profanity_targets": {
            "messages": true, "links": true, "usernames": true,
            "server_names": true, "channel_names": true, "role_names": true, "file_names": true,
        }});
        let got = patch(all_on).await;
        assert_eq!(got.profanity_targets, ProfanityTargets::ALL);
        assert!(blocked(send(json!({"content": "fuck"})).await));
        let got = patch(json!({"profanity_filter": false})).await;
        assert_eq!(got.profanity_targets, ProfanityTargets::ALL);
        assert!(send(json!({"content": "fuck"})).await.is_ok());
        assert!(server("fuck club").await.is_ok());
        assert!(channel("fuck").await.is_ok());
        assert!(role("fuck").await.is_ok());
        assert!(register("Shit").await.is_ok());
        let Json(fetched) = admin::get_settings(st()).await;
        assert!(!fetched.profanity_filter);
        assert_eq!(fetched.profanity_targets, ProfanityTargets::ALL);
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
            for links in [true, false] {
                assert!(!is_profane(text, links), "{text} links={links}");
            }
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
            for links in [true, false] {
                assert!(is_profane(text, links), "{text} links={links}");
            }
        }
    }

    #[test]
    fn profanity_reads_long_numbers_as_numbers() {
        let all = settings_with(true, ProfanityTargets::ALL);
        let clean = [
            "club1793",
            "room42",
            "team2024",
            "club1793012345678",
            "club 1793012345678",
            "Club Night 1802167024629",
            "club1800884551090",
            "1801598980006",
            "order 40056 shipped",
            "see https://github.com/org/repo/pull/12#issuecomment-1799207890733",
        ];
        for text in clean {
            for links in [true, false] {
                assert!(!is_profane(text, links), "{text} links={links}");
            }
            assert!(!all.blocks(ProfanityTarget::ServerNames, text), "{text}");
            assert!(!all.blocks(ProfanityTarget::Messages, text), "{text}");
        }
        let dirty = [
            "a55",
            "a555",
            "a55555",
            "a5555555555",
            "a55555555hole",
            "5h1t",
            "sh17",
            "sh1t1234567",
            "f4ck",
            "fuck12345",
            "fuck 1793012345678",
            "1793012345678 fuck",
            "b00b55555",
            "pu55y",
            "n1663r",
            "8008",
            "1488",
            "80085",
            "58008",
            "5318008",
            "club80085",
        ];
        for text in dirty {
            for links in [true, false] {
                assert!(is_profane(text, links), "{text} links={links}");
            }
            assert!(all.blocks(ProfanityTarget::ServerNames, text), "{text}");
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
