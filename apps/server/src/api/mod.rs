pub mod access;
pub mod admin;
pub mod audit;
pub mod auth;
pub mod blocks;
pub mod budget;
pub mod bulk_delete;
pub mod categories;
pub mod config_shares;
pub mod dms;
pub mod embeds;
pub mod features;
pub mod friends;
pub mod health;
pub mod inbox;
pub mod instance;
pub mod media;
pub mod messages;
pub mod openapi;
pub mod passwords;
pub mod pings;
pub mod pins;
pub mod polls;
pub mod preview_images;
pub mod reactions;
pub mod reauth;
pub mod recovery;
pub mod servers;
pub mod system_messages;
pub mod timeouts;
pub mod users;
pub mod webhooks;

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{Next, from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
pub(crate) use rchat_profanity::is_profane;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::any::AnyRow;
use tower_governor::key_extractor::KeyExtractor;
use tower_governor::{GovernorLayer, governor::GovernorConfigBuilder};
use utoipa::ToSchema;

use crate::api::features::{Feature, Registration};
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

/// Generic success response.
#[derive(Serialize, ToSchema)]
pub struct OkResp {
    /// Always `true`.
    #[schema(example = true)]
    ok: bool,
}

pub(crate) fn ok() -> axum::Json<OkResp> {
    axum::Json(OkResp { ok: true })
}

pub(crate) fn bad(msg: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.to_string())
}

/// A gate result with denials as `None`, so callers can answer them their own way. Server
/// errors stay errors.
pub(crate) fn allowed<T>(res: Result<T, ApiError>) -> Result<Option<T>, ApiError> {
    match res {
        Ok(v) => Ok(Some(v)),
        Err(e @ ApiError(StatusCode::INTERNAL_SERVER_ERROR, _)) => Err(e),
        Err(_) => Ok(None),
    }
}

/// Unix milliseconds, for timestamps that must keep their order within one second.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct UserRef {
    /// Lowercase username, the user's unique key.
    #[schema(example = "alice")]
    pub username: String,
    /// The username in the casing chosen at registration.
    #[schema(example = "Alice")]
    pub display_name: String,
    /// How the avatar is drawn.
    pub avatar_kind: AvatarKind,
    /// Avatar color as lowercase `#rrggbb` when `avatar_kind` is `color`. For identicons it is
    /// the chosen background color, or `null` for the default background.
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
    let hooks: Vec<i64> = keys.iter().filter_map(|k| webhooks::hook_of(k)).collect();
    if !hooks.is_empty() {
        found.extend(webhooks::current_refs(db, &hooks).await);
        keys.retain(|k| webhooks::hook_of(k).is_none());
    }
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

pub const CORS_REQUEST_HEADERS: [&str; 12] = [
    "content-type",
    "authorization",
    "accept",
    "upgrade",
    "connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "x-guest-grant",
    "x-invite-password",
    "x-trust-token",
    "x-trust-client",
];

pub const CORS_RESPONSE_HEADERS: [&str; 6] = [
    NEXT_CURSOR,
    "retry-after",
    "x-trust-required",
    "x-trust-remaining",
    "x-trust-renew",
    "date",
];

pub(crate) fn encode_cursor(parts: &[&str]) -> String {
    hex::encode(parts.join("\u{1f}"))
}

pub(crate) fn decode_cursor(raw: &str, count: usize) -> Result<Vec<String>, ApiError> {
    let invalid = || bad("Invalid cursor");
    let bytes = hex::decode(raw.trim()).map_err(|_| invalid())?;
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    let parts: Vec<String> = text.split('\u{1f}').map(str::to_string).collect();
    match parts.len() == count {
        true => Ok(parts),
        false => Err(invalid()),
    }
}

pub(crate) fn cursor_int(part: &str) -> Result<i64, ApiError> {
    part.parse().map_err(|_| bad("Invalid cursor"))
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
    /// When your timeout in this server ends (unix seconds), while you are timed out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timed_out_until: Option<i64>,
    /// Seconds left of that timeout when the response was made (count down from this, so a
    /// device clock that is off does not matter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timed_out_remaining: Option<i64>,
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
    /// with Manage channels or Manage messages are exempt.
    pub slowmode_seconds: i64,
    /// Only the channel's allowed roles and members (rules with `can_view`) and people who manage
    /// channels can see it.
    #[serde(default)]
    pub restrict_view: bool,
    /// Only the channel's allowed roles and members (rules with `can_send`) and people who manage
    /// channels can send in it.
    #[serde(default)]
    pub restrict_send: bool,
    /// Channel topic: plain text, links are shown as links. At most 1024 characters, no
    /// control characters other than newlines; `null` when the channel has none.
    #[serde(default)]
    pub topic: Option<String>,
    /// Id of the category the channel is listed under; `null` lists it above all categories.
    #[serde(default)]
    pub category_id: Option<i64>,
    /// Sort key within its category (or among channels without one): ascending, then by `id`.
    /// Counted over the channels the caller can see, so it has no gaps.
    #[serde(default)]
    pub position: i64,
}

/// A channel category: a named, collapsible group of text and voice channels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Category {
    /// Category id, unique across the instance.
    pub id: i64,
    /// Category name, at most 100 characters.
    #[schema(example = "Games")]
    pub name: String,
    /// Sort key: categories are listed by ascending `position`, then by `id`. Counted over the
    /// categories the caller gets.
    pub position: i64,
}

/// A category in a channel layout, with its channels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct LayoutCategory {
    /// Category id.
    pub id: i64,
    /// Category name.
    pub name: String,
    /// Ids of the category's channels, top first.
    pub channels: Vec<i64>,
}

/// The order of a server's channel list: channels without a category first, then each
/// category with its channels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ChannelLayout {
    /// Layout version. Every change through the layout or category endpoints, and creating or
    /// deleting a channel, raises it; send it back when reordering.
    pub version: i64,
    /// Ids of channels without a category, top first.
    pub uncategorized: Vec<i64>,
    /// Categories, top first.
    pub categories: Vec<LayoutCategory>,
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
    /// Permission bits of the role: 1 Manage channels, 2 Manage messages (delete and pin messages
    /// of others), 4 Kick (also bans), 8 Delete server (also edits the server), 16 Manage admins,
    /// 32 Mention everyone and roles (`@everyone`, `@here` and every role), 64 View audit log,
    /// 128 Timeout members, 256 Manage webhooks, 512 Manage reports (see and act on reports in the
    /// server).
    #[schema(example = 6)]
    pub perms: i64,
    /// Anyone who can send in a channel may mention the role with `@name`. Otherwise only members
    /// with the Mention everyone permission can.
    pub mentionable: bool,
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
    /// Roles with a channel permission rule that allows less than a member matching no rule gets
    /// in that channel (under its `restrict_view` / `restrict_send`). Deleting one or taking it
    /// away from anyone, yourself included, would widen access, so it needs Manage channels.
    /// Always empty when you have Manage channels.
    pub channel_denies: Vec<i64>,
}

/// One permission rule on a channel. Members with Manage channels pass every rule. A member
/// matching one or more rules gets what any of them allows (the flags are combined). A member
/// matching none can view and send unless the channel's `restrict_view` / `restrict_send` is on,
/// and reads history. A role rule that denies something only holds while the member keeps the
/// role: leaving the server drops every role, so a member can lose a deny by leaving and
/// rejoining. Turn on the matching restriction and allow the others explicitly for strict control.
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
    /// Whether the member is online right now: signed in with at least one open connection,
    /// whatever server or page they have open. Members who chose to appear offline are always
    /// `false`.
    pub online: bool,
    /// Admin permission bits (see `Role.perms`). For an admin, 0 means every permission and
    /// any other value is the granted subset; always 0 for non-admins, whose permissions come
    /// from their roles.
    pub perms: i64,
    /// Ids of the server roles assigned to the member.
    pub role_ids: Vec<i64>,
    /// The extra password the member joined with. Only in `GET /api/v1/servers/{name}/members`
    /// for callers with the Delete server permission, and only for members who joined with an
    /// extra password that is still listed; absent otherwise. It disappears once the password
    /// row is purged, 30 days after the password was revoked, expired or used up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_via: Option<JoinedVia>,
    /// The member's running timeout. Only in `GET /api/v1/servers/{name}/members` for callers with
    /// the Timeout members permission; absent otherwise and when none is running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<timeouts::MemberTimeout>,
}

/// The extra server password a member joined with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct JoinedVia {
    /// Id of the password.
    pub id: i64,
    /// Its label; `null` when it has none.
    pub label: Option<String>,
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
    /// Channels the caller can see, in list order (see `category_id` and `position`). Channels
    /// with permission rules that do not grant the caller `can_view` are left out.
    pub channels: Vec<Channel>,
    /// Channel categories, ordered by `position`. Categories without a channel the caller can
    /// see are left out, unless the caller manages channels.
    pub categories: Vec<Category>,
    /// Version of the channel layout, for `PUT /api/v1/servers/{name}/layout`.
    pub layout_version: i64,
    /// Ids of listed text channels where the caller, a member, can read but not send messages
    /// or add reactions (their own reactions can still be removed). Empty for non-members, who
    /// cannot send anywhere.
    pub read_only: Vec<i64>,
    /// Every role of the server, oldest first.
    pub roles: Vec<Role>,
    /// Roles the caller can't change even though the permission rules on `perms` allow it.
    pub role_limits: RoleLimits,
    /// Number of members.
    pub member_count: i64,
    /// Number of members of this server who are online right now (anywhere on the site).
    pub online_count: i64,
}

/// A direct-message conversation of the signed-in user.
#[derive(Clone, Serialize, ToSchema)]
pub struct DmSummary {
    /// Conversation id, used in `/api/v1/dms/{id}/messages`.
    pub id: i64,
    /// The other participant; the signed-in user for the conversation with yourself.
    pub other: UserRef,
    /// Whether this is the conversation with yourself.
    pub is_self: bool,
    /// You closed it, so it is hidden from your DM list. Only `GET /api/v1/dms?ids=` returns
    /// closed DMs; a new message in it or opening it again reopens it.
    pub closed: bool,
}

/// A file attached to a message, stored on the server or shared peer to peer.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct MediaRef {
    /// 32 hex characters. For `server` media, download it from `/api/v1/media/{id}`; for `p2p`
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
    /// MIME type, known for `p2p` media; `null` for `server` media. Declared by the sender and
    /// not verified: clients decide how to show a file from its bytes.
    pub mime: Option<String>,
    /// SHA-256 of a `p2p` file (64 lowercase hex characters), computed by the sender when
    /// attaching it, so recipients can check what the hoster serves. `null` for `server` media
    /// and for files sent by clients that predate it (unverified).
    #[serde(default)]
    pub sha256: Option<String>,
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
            sha256: None,
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
    /// Path on this instance that serves the preview image
    /// (`/api/messages/{id}/embeds/{ord}/image?v=...`), or `null` when there is none or it was
    /// removed. The instance fetches the image itself; the page's image host is never named.
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
    /// `true` for a direct (P2P) call, `false` through the server; `null` for calls logged
    /// before this was recorded.
    #[serde(default)]
    pub p2p: Option<bool>,
    /// `true` when the call started with video; `null` for calls logged before this was
    /// recorded.
    #[serde(default)]
    pub video: Option<bool>,
}

/// The message a reply quotes, as shown above the reply.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ReplyRef {
    /// Id of the quoted message.
    pub id: i64,
    /// Who wrote it; `null` when `deleted`.
    pub author: Option<UserRef>,
    /// First line of its text as plain text (formatting removed), at most 200 characters; empty
    /// when it has only an attachment or is `deleted`. Spoilers are wrapped in `||` (always
    /// closed, also when cut off), and a literal pipe or backslash has a backslash before it, so
    /// `||` only ever marks a spoiler.
    #[schema(example = "See you at 8")]
    pub content: String,
    /// It has an attachment.
    pub has_media: bool,
    /// The quoted message was deleted or cannot be shown to you (sent before you joined and you
    /// cannot read the channel's history). Only `id` and `mention` are set then.
    pub deleted: bool,
    /// The reply pinged the quoted message's author (`mention_reply`).
    pub mention: bool,
    /// Only `id` and `mention` are set: WebSocket events never carry the quoted message.
    /// Clients fill it from a loaded copy of the original or by reading the reply through the
    /// message list (`around` = the reply's id).
    #[serde(default)]
    pub partial: bool,
    /// The quoted message is itself a forward (shown with a small "Forwarded" marker).
    #[serde(default)]
    pub forwarded: bool,
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
    /// Text, at most `limits.message_chars` characters (by default 4000,
    /// `MESSAGE_MAX_CHARS`); may be empty when there is an attachment, and is empty
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
    /// `user` for a normal message, `poll` for a poll (`poll`; `content` is the question),
    /// `call` for a direct-message call log, `pin` when someone pinned a message
    /// (`pin_message_id`; empty `content`), or `join` / `leave` when the author joined or left
    /// the server (empty `content`; leaving includes kicks and bans).
    #[schema(example = "user")]
    pub kind: String,
    /// Call details when `kind` is `call`; `null` otherwise.
    pub call: Option<CallLog>,
    /// Emoji reactions in the order they were first added, with `me` for the caller. Filled in
    /// message lists; empty in WebSocket events (clients apply `reaction_added` and
    /// `reaction_removed`).
    #[serde(default)]
    pub reactions: Vec<reactions::Reaction>,
    /// For an inline reply, the message it quotes; `null` otherwise and in search results.
    #[serde(default)]
    pub reply_to: Option<ReplyRef>,
    /// Unix seconds of the last edit; `null` if the message was never edited.
    #[serde(default)]
    pub edited_at: Option<i64>,
    /// For a forwarded message, where its content came from; `null` otherwise. The content,
    /// attachment and link previews above are a copy made when it was forwarded.
    #[serde(default)]
    pub forward: Option<ForwardRef>,
    /// Unix seconds when the message was pinned; `null` if it is not pinned.
    #[serde(default)]
    pub pinned_at: Option<i64>,
    /// For a `pin` message (someone pinned a message), the id of the pinned message; `null`
    /// once that message is deleted, when it was sent before you could read the channel's
    /// history, and for other kinds.
    #[serde(default)]
    pub pin_message_id: Option<i64>,
    /// `@everyone`, `@here` and role mentions that pinged when the message was sent (the author
    /// had the Mention everyone permission, or the role allows anyone to mention it). Only
    /// top-level channel messages have them; edits never change them. Empty otherwise.
    #[serde(default)]
    pub group_mentions: Vec<pings::GroupMention>,
    /// For a `poll` message, the poll as you see it (counts only when you may see them; your
    /// own vote only in message lists and `GET /api/v1/polls/{id}`). For a forwarded poll, a frozen
    /// `snapshot` that takes no votes. `null` otherwise.
    #[serde(default)]
    pub poll: Option<polls::Poll>,
    /// For a message posted through an incoming webhook, the webhook and its rich embeds;
    /// `null` otherwise. `author` then carries the name and avatar the webhook posted with (its
    /// `username` is `@webhook:<id>`, which no account can have). Clients show a WEBHOOK badge.
    #[serde(default)]
    pub webhook: Option<webhooks::MessageWebhook>,
}

/// The original of a forwarded message. The copy never changes when the original is edited or
/// deleted.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ForwardRef {
    /// Who wrote the original; `null` once that account is deleted or banned (shown as a
    /// deleted user). The copy itself stays.
    pub author: Option<UserRef>,
    /// Unix seconds when the original was sent.
    pub created_at: i64,
    /// Id of the forwarded message. `GET /api/v1/messages/{id}/location` tells where it is, if you
    /// can read it.
    pub source_id: i64,
    /// Where it came from, as a label: `Direct message`, `#channel - Server` when forwarded
    /// inside the same server, or the server's display name when that server had no password.
    /// `null` otherwise (a password-protected server's name never leaves it). Kept for older
    /// clients; use `origin_dm`, `origin_channel` and `origin_server`. Fixed at forward time:
    /// later renames or password changes do not update it.
    #[schema(example = "#general - Rustaceans")]
    pub origin: Option<String>,
    /// Whether it came from a direct message.
    #[serde(default)]
    pub origin_dm: bool,
    /// Name of the channel it came from, without `#`, when forwarded inside the same server
    /// and everyone there may see that channel; `null` otherwise.
    #[serde(default)]
    #[schema(example = "general")]
    pub origin_channel: Option<String>,
    /// Display name of the server it came from, when forwarded inside the same server or when
    /// that server had no password; `null` otherwise.
    #[serde(default)]
    #[schema(example = "Rustaceans")]
    pub origin_server: Option<String>,
    /// File name of an attachment of the original that was not forwarded: a peer-to-peer
    /// attachment, or a file that already travels in 50 messages.
    #[schema(example = "notes.pdf")]
    pub dropped: Option<String>,
}

impl ForwardRef {
    /// Builds the reference from the stored `fwd_origin`.
    pub(crate) fn new(
        author: Option<UserRef>,
        created_at: i64,
        source_id: i64,
        stored_origin: Option<&str>,
        dropped: Option<String>,
    ) -> Self {
        let origin = stored_origin.map(Origin::parse);
        let label = origin.as_ref().map(Origin::label);
        let (origin_dm, origin_channel, origin_server) = match origin {
            Some(Origin::Dm) => (true, None, None),
            Some(Origin::Server { server }) => (false, None, Some(server)),
            Some(Origin::Channel { channel, server }) => (false, Some(channel), Some(server)),
            None => (false, None, None),
        };
        ForwardRef {
            author,
            created_at,
            source_id,
            origin: label,
            origin_dm,
            origin_channel,
            origin_server,
            dropped,
        }
    }
}

/// Where a forwarded message came from, stored as JSON in `messages.fwd_origin`. Rows forwarded
/// by older versions hold the display label instead.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Origin {
    Dm,
    Server { server: String },
    Channel { channel: String, server: String },
}

impl Origin {
    pub(crate) fn stored(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    fn label(&self) -> String {
        match self {
            Origin::Dm => "Direct message".to_string(),
            Origin::Server { server } => server.clone(),
            Origin::Channel { channel, server } => format!("#{channel} - {server}"),
        }
    }

    /// Reads the stored value, which is a bare display label in rows forwarded by older versions.
    fn parse(stored: &str) -> Origin {
        if let Ok(origin) = serde_json::from_str::<Origin>(stored) {
            return origin;
        }
        match stored {
            "Direct message" => Origin::Dm,
            _ => match stored
                .strip_prefix('#')
                .and_then(|s| s.split_once(" \u{b7} "))
            {
                Some((channel, server)) => Origin::Channel {
                    channel: channel.to_string(),
                    server: server.to_string(),
                },
                None => Origin::Server {
                    server: stored.to_string(),
                },
            },
        }
    }
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
    ChannelTopics,
    CategoryNames,
}

impl ProfanityTarget {
    pub const ALL: [ProfanityTarget; 9] = [
        ProfanityTarget::Messages,
        ProfanityTarget::Usernames,
        ProfanityTarget::ServerNames,
        ProfanityTarget::ChannelNames,
        ProfanityTarget::RoleNames,
        ProfanityTarget::FileNames,
        ProfanityTarget::Bios,
        ProfanityTarget::ChannelTopics,
        ProfanityTarget::CategoryNames,
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
            ProfanityTarget::ChannelTopics => ProfanitySwitch::ChannelTopics,
            ProfanityTarget::CategoryNames => ProfanitySwitch::CategoryNames,
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
    ChannelTopics,
    CategoryNames,
}

impl ProfanitySwitch {
    pub const ALL: [ProfanitySwitch; 10] = [
        ProfanitySwitch::Messages,
        ProfanitySwitch::Links,
        ProfanitySwitch::Usernames,
        ProfanitySwitch::ServerNames,
        ProfanitySwitch::ChannelNames,
        ProfanitySwitch::RoleNames,
        ProfanitySwitch::FileNames,
        ProfanitySwitch::Bios,
        ProfanitySwitch::ChannelTopics,
        ProfanitySwitch::CategoryNames,
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
            ProfanitySwitch::ChannelTopics => "channel_topics",
            ProfanitySwitch::CategoryNames => "category_names",
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
            ProfanitySwitch::ChannelTopics => "profanity_channel_topics",
            ProfanitySwitch::CategoryNames => "profanity_category_names",
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
    /// Channel topics.
    #[serde(default = "target_default")]
    pub channel_topics: bool,
    /// Channel category names.
    #[serde(default = "target_default")]
    pub category_names: bool,
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
        channel_topics: true,
        category_names: true,
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
            channel_topics: on(ProfanitySwitch::ChannelTopics),
            category_names: on(ProfanitySwitch::CategoryNames),
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
            channel_topics,
            category_names,
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
            ProfanitySwitch::ChannelTopics => channel_topics,
            ProfanitySwitch::CategoryNames => category_names,
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

/// A switch that starts off: on only for `1`, `true`, `on` or `yes`.
pub fn switch_off_seed(value: Option<&str>) -> bool {
    value.is_some_and(|v| {
        matches!(
            v.trim().to_lowercase().as_str(),
            "1" | "true" | "on" | "yes"
        )
    })
}

/// Seed value of an on/off setting from its environment variable: on unless it says off.
pub fn switch_seed(value: Option<&str>) -> bool {
    !value.is_some_and(|v| {
        matches!(
            v.trim().to_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        )
    })
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
/// WebSocket event. A switched-off feature's endpoints answer 404, except that uploads, P2P
/// attachments and outgoing webhooks answer 403, guests get 401 while guest access is off, and
/// `client_other_instances` gates no endpoint.
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
    /// File uploads through `POST /api/v1/media`.
    pub asset_uploads: bool,
    /// Peer-to-peer attachments: files hosted by the sender's browser, without a size limit.
    /// With this and `asset_uploads` off the instance is text only: messages carrying any
    /// attachment are rejected and existing ones are no longer offered.
    #[serde(default = "yes")]
    pub p2p_attachments: bool,
    /// Guest access: reading servers without an account.
    pub guests_enabled: bool,
    /// Outgoing webhooks: servers may have the instance POST signed event payloads to URLs
    /// their managers choose. Off by default (`OUTGOING_WEBHOOKS` seeds it); while off, nothing
    /// is queued or sent and outgoing webhooks cannot be created.
    #[serde(default)]
    pub outgoing_webhooks: bool,
    /// Reports to a server's moderators.
    #[serde(default = "yes")]
    pub server_reports: bool,
    /// Reports to the instance.
    #[serde(default = "yes")]
    pub instance_reports: bool,
    /// Embeddable widgets.
    #[serde(default = "yes")]
    pub widgets: bool,
    /// Sending from widgets, and Quick join.
    #[serde(default = "yes")]
    pub widget_chat: bool,
    /// Read-only widget links.
    #[serde(default = "yes")]
    pub widget_read_links: bool,
    /// Widgets for P2P servers through the instance's bridge. Off by default.
    #[serde(default)]
    pub widget_bridge: bool,
    /// End-to-end encryption. Off by default.
    #[serde(default)]
    pub e2ee: bool,
    /// The compliance archive in new encrypted spaces. Off by default.
    #[serde(default)]
    pub e2ee_compliance: bool,
    /// Setting and resetting backup phrases.
    #[serde(default = "yes")]
    pub backup_phrase: bool,
    /// P2P backups stored on the instance.
    #[serde(default = "yes")]
    pub p2p_backup: bool,
    /// Changing display names.
    #[serde(default = "yes")]
    pub display_names: bool,
    /// The tour for new accounts.
    #[serde(default = "yes")]
    pub onboarding: bool,
    /// Password sign-in. Off: no new passwords (see `registration`); existing passwords still
    /// sign in.
    #[serde(default = "yes")]
    pub password_login: bool,
    /// Calls through the instance's media server when it runs (`sfu` in `GET /api/v1/instance`).
    /// Off by default.
    #[serde(default)]
    pub sfu: bool,
    /// Peer-to-peer servers and conversations in the app this instance serves. Off: the app
    /// hides them and `POST /api/v1/identity/p2p_binding` answers 404. Data on devices is kept.
    #[serde(default = "yes")]
    pub p2p: bool,
    /// Adding other instances in the web app this instance serves. Only that app reads it:
    /// the desktop and mobile apps and other web apps ignore it, and it gates no endpoint.
    #[serde(default = "yes")]
    pub client_other_instances: bool,
    /// Who may create an account with a password: `open`, `sso` (only through single
    /// sign-on) or `closed`. `POST /api/v1/auth/register` answers 404 unless it is `open` and
    /// `password_login` is on.
    #[serde(default)]
    pub registration: Registration,
}

pub(crate) fn yes() -> bool {
    true
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
        p2p_attachments: false,
        guests_enabled: false,
        outgoing_webhooks: false,
        server_reports: false,
        instance_reports: false,
        widgets: false,
        widget_chat: false,
        widget_read_links: false,
        widget_bridge: false,
        e2ee: false,
        e2ee_compliance: false,
        backup_phrase: false,
        p2p_backup: false,
        display_names: false,
        onboarding: false,
        password_login: false,
        sfu: false,
        p2p: false,
        client_other_instances: false,
        registration: Registration::Closed,
    };

    pub async fn load(db: &Db) -> Settings {
        let rows = match sqlx::query(
            "SELECT key, value FROM settings WHERE key IN ('profanity_filter', 'asset_previews', 'asset_uploads', 'p2p_attachments', 'guests_enabled', 'outgoing_webhooks', 'server_reports', 'instance_reports', 'widgets', 'widget_chat', 'widget_read_links', 'widget_bridge', 'e2ee', 'e2ee_compliance', 'backup_phrase', 'p2p_backup', 'display_names', 'onboarding', 'password_login', 'sfu', 'p2p', 'client_other_instances', 'registration') OR key LIKE 'profanity\\_%' ESCAPE '\\'",
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
        let value = |key: &str| {
            rows.iter()
                .find(|r| r.try_get::<String, _>(0).is_ok_and(|k| k == key))
                .and_then(|r| r.try_get::<String, _>(1).ok())
        };
        let on = |key: &str| value(key).is_none_or(|v| v == "1");
        let feature = |f: Feature| value(f.key()).map_or(f.default_on(), |v| v == "1");
        let settings = Settings {
            profanity_filter: on("profanity_filter"),
            profanity_targets: ProfanityTargets::from_fn(|t| on(t.key())),
            asset_previews: on("asset_previews"),
            asset_uploads: on("asset_uploads"),
            p2p_attachments: on("p2p_attachments"),
            guests_enabled: on("guests_enabled"),
            outgoing_webhooks: rows
                .iter()
                .find(|r| {
                    r.try_get::<String, _>(0)
                        .is_ok_and(|k| k == "outgoing_webhooks")
                })
                .and_then(|r| r.try_get::<String, _>(1).ok())
                .is_some_and(|v| v == "1"),
            server_reports: feature(Feature::ServerReports),
            instance_reports: feature(Feature::InstanceReports),
            widgets: feature(Feature::Widgets),
            widget_chat: feature(Feature::WidgetChat),
            widget_read_links: feature(Feature::WidgetReadLinks),
            widget_bridge: feature(Feature::WidgetBridge),
            e2ee: feature(Feature::E2ee),
            e2ee_compliance: feature(Feature::E2eeCompliance),
            backup_phrase: feature(Feature::BackupPhrase),
            p2p_backup: feature(Feature::P2pBackup),
            display_names: feature(Feature::DisplayNames),
            onboarding: feature(Feature::Onboarding),
            password_login: feature(Feature::PasswordLogin),
            sfu: feature(Feature::Sfu),
            p2p: feature(Feature::P2p),
            client_other_instances: feature(Feature::ClientOtherInstances),
            registration: value(Registration::KEY)
                .map_or(Some(Registration::Open), |v| Registration::parse(&v))
                .unwrap_or(Registration::Closed),
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

    /// Neither uploads nor P2P attachments: messages are text and emoji only.
    pub fn text_only(&self) -> bool {
        !self.asset_uploads && !self.p2p_attachments
    }

    /// Whether the feature switch is on.
    pub fn on(&self, feature: Feature) -> bool {
        let Settings {
            profanity_filter: _,
            profanity_targets: _,
            asset_previews: _,
            asset_uploads: _,
            p2p_attachments: _,
            guests_enabled: _,
            outgoing_webhooks: _,
            server_reports,
            instance_reports,
            widgets,
            widget_chat,
            widget_read_links,
            widget_bridge,
            e2ee,
            e2ee_compliance,
            backup_phrase,
            p2p_backup,
            display_names,
            onboarding,
            password_login,
            sfu,
            p2p,
            client_other_instances,
            registration: _,
        } = *self;
        match feature {
            Feature::ServerReports => server_reports,
            Feature::InstanceReports => instance_reports,
            Feature::Widgets => widgets,
            Feature::WidgetChat => widget_chat,
            Feature::WidgetReadLinks => widget_read_links,
            Feature::WidgetBridge => widget_bridge,
            Feature::E2ee => e2ee,
            Feature::E2eeCompliance => e2ee_compliance,
            Feature::BackupPhrase => backup_phrase,
            Feature::P2pBackup => p2p_backup,
            Feature::DisplayNames => display_names,
            Feature::Onboarding => onboarding,
            Feature::PasswordLogin => password_login,
            Feature::Sfu => sfu,
            Feature::P2p => p2p,
            Feature::ClientOtherInstances => client_other_instances,
        }
    }

    /// New accounts with a password: registration is open and password sign-in is on.
    pub fn password_signup(&self) -> bool {
        self.password_login && self.registration == Registration::Open
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

/// Grants have the form of `auth::new_token`: 64 lowercase hex characters.
pub(crate) fn grant_shaped(grant: &str) -> bool {
    grant.len() == 64
        && grant
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A comma-separated grant list: well-formed grants only, without repeats, at most
/// `GRANTS_MAX`.
pub(crate) fn parse_grants<'a>(lists: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    lists
        .into_iter()
        .flat_map(|list| list.split(','))
        .map(str::trim)
        .filter(|s| grant_shaped(s) && seen.insert(*s))
        .take(GRANTS_MAX)
        .map(str::to_string)
        .collect()
}

pub(crate) fn header_grants(headers: &HeaderMap) -> Vec<String> {
    parse_grants(headers.get("x-guest-grant").and_then(|v| v.to_str().ok()))
}

pub const NAME_MAX: usize = 100;
pub const SLOWMODE_MAX: i64 = 21600;
pub const TOPIC_MAX: usize = 1024;

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
            | ProfanityTarget::Bios
            | ProfanityTarget::ChannelTopics
            | ProfanityTarget::CategoryNames => true,
        };
        self.profanity_filter && targets.get(target.switch()) && is_profane(text, links)
    }

    pub fn check_profanity(&self, target: ProfanityTarget, text: &str) -> Result<(), ApiError> {
        match self.blocks(target, text) {
            true => Err(bad("Content blocked by profanity filter")),
            false => Ok(()),
        }
    }
}

pub async fn check_profanity(db: &Db, target: ProfanityTarget, text: &str) -> Result<(), ApiError> {
    Settings::cached(db).await.check_profanity(target, text)
}

pub struct Authed(pub User);
pub struct MaybeAuthed(pub Option<User>);

pub const AUTH_UNAVAILABLE: &str = "Cannot check your session right now. Try again soon";

fn auth_unavailable(e: sqlx::Error) -> ApiError {
    tracing::warn!("session lookup failed: {e}");
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        AUTH_UNAVAILABLE.to_string(),
    )
}

/// The account row (`users.*`, plus the session's `session_created_at`) holding session
/// `token`, `None` when no live account has it. REST sign-in and the realtime sign-in and
/// session checks all use it. Never answers a client.
pub(crate) async fn token_row(db: &Db, token: &str) -> sqlx::Result<Option<AnyRow>> {
    sqlx::query(
        "SELECT u.*, t.created_at AS session_created_at FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1 AND u.password_hash <> '!purging'",
    )
    .bind(crate::db::secret_key(token))
    .fetch_optional(db)
    .await
}

/// The account of a session token. `Ok(None)` only when no live account has that token; any
/// other failure (pool closed or starved, query or row errors) is a 503, so clients keep the
/// token and retry.
pub(crate) async fn user_for_token(
    state: &AppState,
    token: &str,
) -> Result<Option<User>, ApiError> {
    Ok(session_for_token(state, token).await?.map(|(user, _)| user))
}

/// The account of session `token` and when that session was created, with the errors of
/// `user_for_token`.
pub(crate) async fn session_for_token(
    state: &AppState,
    token: &str,
) -> Result<Option<(User, i64)>, ApiError> {
    let row = token_row(&state.read(), token)
        .await
        .map_err(auth_unavailable)?;
    row.map(|row| Ok((User::from_row(&row)?, row.try_get("session_created_at")?)))
        .transpose()
        .map_err(auth_unavailable)
}

/// The token of an `Authorization: Bearer <token>` header.
pub(crate) fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

pub(crate) fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "Unauthorized".to_string())
}

async fn bearer_user(parts: &Parts, state: &AppState) -> Result<Option<User>, ApiError> {
    match bearer_token(&parts.headers) {
        Some(token) => user_for_token(state, token).await,
        None => Ok(None),
    }
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
        None => Ok(None),
    };
    match user {
        Ok(Some(_)) => next.run(req).await,
        Ok(None) => unauthorized().into_response(),
        Err(e) => e.into_response(),
    }
}

impl FromRequestParts<AppState> for Authed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Authed, ApiError> {
        match bearer_user(parts, state).await? {
            Some(user) => Ok(Authed(user)),
            None => Err(unauthorized()),
        }
    }
}

impl FromRequestParts<AppState> for MaybeAuthed {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<MaybeAuthed, ApiError> {
        Ok(MaybeAuthed(bearer_user(parts, state).await?))
    }
}

pub fn routes(
    state: AppState,
    roles: &Roles,
    key: ClientIp,
    swagger_ui: Option<&str>,
) -> Router<AppState> {
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
    let upload_body = DefaultBodyLimit::max(state.limits.upload_body_bytes());
    let mut router = Router::new();
    if roles.api {
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async {
                auth::dummy_hash().await;
            });
        }
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
            .route("/auth/recovery/challenge", post(recovery::challenge))
            .route("/auth/recovery", post(recovery::recover))
            .route("/me/password", post(auth::change_password))
            .route(
                "/me/recovery",
                put(recovery::set_phrase).delete(recovery::remove_phrase),
            )
            .route("/servers/{name}/guest_access", post(servers::guest_access))
            .route("/servers", post(servers::create_server))
            .route("/servers/{name}", patch(servers::update_server))
            .route(
                "/servers/{name}/passwords",
                post(passwords::create_password),
            )
            .route("/servers/{name}/available", get(servers::server_available))
            .route("/identity/p2p_binding", post(instance::p2p_binding))
            .route(
                "/config_shares",
                get(config_shares::list_shares).post(config_shares::create_share),
            )
            .route(
                "/config_shares/{id}",
                get(config_shares::get_share).delete(config_shares::delete_share),
            )
            .route("/servers/{name}/webhooks", post(webhooks::create_webhook))
            .route(
                "/servers/{name}/webhooks/{id}/token",
                post(webhooks::reset_token),
            )
            .route(
                "/servers/{name}/outgoing_webhooks",
                post(webhooks::create_outgoing),
            )
            .route(
                "/servers/{name}/outgoing_webhooks/{id}/secret",
                post(webhooks::reset_secret),
            )
            .route(
                "/servers/{name}/outgoing_webhooks/{id}/test",
                post(webhooks::test_outgoing),
            )
            .route_layer(strict.clone());
        let invite_routes = invite_routes.merge(
            Router::new()
                .route(
                    "/webhooks/{id}/{token}",
                    get(webhooks::webhook_info)
                        .post(webhooks::execute)
                        .layer(upload_body),
                )
                .route(
                    "/webhooks/{id}/{token}/messages/{message_id}",
                    patch(webhooks::edit_hook_message).delete(webhooks::delete_hook_message),
                )
                .route_layer(limiter()),
        );
        router = router.merge(api_routes(state, strict_routes, invite_routes, swagger_ui));
    }
    if roles.gateway {
        router = router.route(
            "/ws",
            get(crate::ws::handler).layer(axum::Extension(key.clone())),
        );
    }
    if roles.media {
        let upload = Router::new()
            .route("/media", post(media::upload_media).layer(upload_body))
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
    router.layer(from_fn(move |req: Request, next: Next| {
        let ip = key
            .extract(&req)
            .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        budget::with_client(ip, req, next)
    }))
}

fn api_routes(
    state: AppState,
    strict_routes: Router<AppState>,
    invite_routes: Router<AppState>,
    swagger_ui: Option<&str>,
) -> Router<AppState> {
    Router::new()
        .route("/me", get(auth::me).patch(auth::patch_me))
        .route("/me/recovery", get(recovery::status))
        .route("/auth/logout", post(auth::logout))
        .route("/me/servers", get(servers::list_my_servers))
        .route("/users/{username}/profile", get(users::profile))
        .route(
            "/servers/{name}",
            get(servers::get_server).delete(servers::delete_server),
        )
        .route("/servers/{name}/members", get(servers::list_members))
        .route("/servers/{name}/interacted", get(servers::list_interacted))
        .route("/servers/{name}/leave", post(servers::leave_server))
        .route("/servers/{name}/channels", post(servers::create_channel))
        .route(
            "/servers/{name}/categories",
            post(categories::create_category),
        )
        .route("/servers/{name}/layout", put(categories::reorder_layout))
        .route(
            "/categories/{id}",
            patch(categories::rename_category).delete(categories::delete_category),
        )
        .route(
            "/channels/{id}",
            patch(servers::update_channel).delete(servers::delete_channel),
        )
        .route("/servers/{name}/passwords", get(passwords::list_passwords))
        .route(
            "/servers/{name}/passwords/{id}",
            delete(passwords::revoke_password),
        )
        .route(
            "/servers/{name}/system_messages",
            get(system_messages::get_system_messages)
                .patch(system_messages::update_system_messages),
        )
        .route("/servers/{name}/kick", post(servers::kick_member))
        .route(
            "/servers/{name}/timeouts/{username}",
            put(timeouts::set_timeout).delete(timeouts::remove_timeout),
        )
        .route("/servers/{name}/audit", get(audit::list_audit))
        .route("/servers/{name}/webhooks", get(webhooks::list_webhooks))
        .route(
            "/servers/{name}/webhooks/{id}",
            patch(webhooks::update_webhook).delete(webhooks::delete_webhook),
        )
        .route(
            "/servers/{name}/outgoing_webhooks",
            get(webhooks::list_outgoing),
        )
        .route(
            "/servers/{name}/outgoing_webhooks/{id}",
            patch(webhooks::update_outgoing).delete(webhooks::delete_outgoing),
        )
        .route(
            "/servers/{name}/outgoing_webhooks/{id}/deliveries",
            get(webhooks::list_deliveries),
        )
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
        .route("/channels/{id}/pins", get(pins::channel_pins))
        .route("/dms", get(dms::list_dms).post(dms::open_dm))
        .route(
            "/dms/{id}/messages",
            get(messages::dm_messages).post(messages::send_dm_message),
        )
        .route("/dms/{id}/pins", get(pins::dm_pins))
        .route("/dms/{id}/close", post(dms::close_dm))
        .route("/blocks", get(blocks::list_blocks).post(blocks::block_user))
        .route("/blocks/usernames", get(blocks::blocked_usernames))
        .route("/blocks/{username}", delete(blocks::unblock_user))
        .route("/friends", get(friends::list_friends))
        .route("/friends/summary", get(friends::summary))
        .route("/friends/seen", post(friends::mark_seen))
        .route("/inbox", get(inbox::list_inbox))
        .route("/inbox/read", post(inbox::read_item))
        .route("/inbox/read_all", post(inbox::read_all))
        .route(
            "/friends/requests",
            get(friends::list_requests).post(friends::send_request),
        )
        .route(
            "/friends/requests/{username}",
            delete(friends::cancel_request),
        )
        .route(
            "/friends/requests/{username}/accept",
            post(friends::accept_request),
        )
        .route(
            "/friends/requests/{username}/deny",
            post(friends::deny_request),
        )
        .route(
            "/users/{username}/friendship",
            get(friends::friendship).delete(friends::remove_friend),
        )
        .route(
            "/me/privacy",
            get(friends::get_privacy).patch(friends::patch_privacy),
        )
        .route(
            "/messages/{id}",
            delete(messages::delete_message).patch(messages::edit_message),
        )
        .route("/messages/{id}/media", delete(media::delete_media))
        .route("/messages/{id}/location", get(messages::message_location))
        .route("/messages/locations", post(messages::message_locations))
        .route("/messages/bulk_delete", post(bulk_delete::bulk_delete))
        .route("/messages/bulk_delete/jobs", get(bulk_delete::list_jobs))
        .route(
            "/messages/bulk_delete/jobs/{id}",
            delete(bulk_delete::cancel_job),
        )
        .route(
            "/messages/{id}/pin",
            put(pins::pin_message).delete(pins::unpin_message),
        )
        .route(
            "/messages/{id}/reactions/{emoji}",
            get(reactions::list_reactors)
                .put(reactions::add_reaction)
                .delete(reactions::remove_reaction),
        )
        .route("/messages/{id}/embeds/{ord}", delete(embeds::delete_embed))
        .route(
            "/messages/{id}/embeds/{ord}/image",
            get(preview_images::preview_image),
        )
        .route("/polls/{id}", get(polls::get_poll))
        .route(
            "/polls/{id}/vote",
            put(polls::vote).delete(polls::retract_vote),
        )
        .route("/polls/{id}/options", post(polls::add_option))
        .route("/polls/{id}/close", post(polls::close_poll))
        .route("/polls/{id}/reopen", post(polls::reopen_poll))
        .route("/polls/{id}/voters", get(polls::list_voters))
        .route(
            "/messages/{id}/thread",
            get(messages::thread_messages).post(messages::send_thread_message),
        )
        .route("/unreads", get(messages::unreads))
        .route("/read", post(messages::mark_read))
        .route("/read/batch", post(messages::mark_read_batch))
        .route("/settings", get(admin::get_settings))
        .route("/instance", get(instance::instance))
        .route("/identity/assertion", post(instance::assertion))
        .route("/p2p/ice", get(instance::ice))
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
        .merge(openapi::routes(swagger_ui).route_layer(from_fn_with_state(state, require_token)))
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::PathBuf;

    use crate::db::{AvatarKind, Db, User, now, open};
    use crate::instance::{Instance, InstanceConfig};
    use crate::state::AppState;
    use crate::ws::Hub;

    /// `src` with each top-level `#[cfg(test)]` inline module blanked, from its attribute to its
    /// closing `}` at column 0, keeping the line numbers: the code the source scans check.
    pub(crate) fn non_test_code(src: &str) -> String {
        let lines: Vec<&str> = src.split('\n').collect();
        let mut kept = Vec::with_capacity(lines.len());
        let mut skip = false;
        for (i, line) in lines.iter().enumerate() {
            skip |= *line == "#[cfg(test)]"
                && lines.get(i + 1).is_some_and(|next| {
                    let decl = next.strip_prefix("pub(crate) ").unwrap_or(next);
                    decl.starts_with("mod ") && decl.ends_with(" {")
                });
            kept.push(match skip {
                true => "",
                false => line,
            });
            if skip && line.starts_with('}') {
                skip = false;
            }
        }
        kept.join("\n")
    }

    pub(crate) async fn temp_state(tag: &str) -> (AppState, PathBuf) {
        let path = crate::db::temp_db_path(tag);
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

    /// An empty database of its own on the Postgres server `TEST_POSTGRES_URL` points to, dropped
    /// when this is dropped (also when the test panics).
    pub(crate) struct PgTemp {
        pub(crate) url: String,
        admin: String,
        name: String,
    }

    /// `None` unless `TEST_POSTGRES_URL` is a postgres:// URL (never `DATABASE_URL`).
    pub(crate) async fn pg_temp(tag: &str) -> Option<PgTemp> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let admin = std::env::var("TEST_POSTGRES_URL")
            .ok()
            .filter(|u| u.starts_with("postgres://") || u.starts_with("postgresql://"))?;
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let name = format!("rchat_test_{tag}_{}_{n}", std::process::id());
        let mut url = url::Url::parse(&admin).expect("TEST_POSTGRES_URL");
        url.set_path(&name);
        let temp = PgTemp {
            url: url.to_string(),
            admin,
            name,
        };
        admin_sql(&temp.admin, &format!("CREATE DATABASE {}", temp.name))
            .await
            .expect("create the test database");
        Some(temp)
    }

    async fn admin_sql(admin: &str, sql: &str) -> sqlx::Result<()> {
        use sqlx::Connection;
        sqlx::any::install_default_drivers();
        let mut conn = sqlx::AnyConnection::connect(admin).await?;
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut conn)
            .await?;
        conn.close().await
    }

    impl Drop for PgTemp {
        fn drop(&mut self) {
            let admin = self.admin.clone();
            let sql = format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name);
            let dropped = std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| e.to_string())?
                    .block_on(admin_sql(&admin, &sql))
                    .map_err(|e| e.to_string())
            })
            .join();
            if !matches!(dropped, Ok(Ok(()))) {
                eprintln!("test database {} was not dropped: {dropped:?}", self.name);
            }
        }
    }

    /// `temp_state` on a `pg_temp` database.
    pub(crate) async fn pg_state(tag: &str) -> Option<(AppState, PgTemp)> {
        let temp = pg_temp(tag).await?;
        let db = open(Some(temp.url.as_str())).await.expect("open postgres");
        let instance = Instance::load(&db, &InstanceConfig::default())
            .await
            .expect("instance");
        Some((AppState::new(db, Hub::new(), None, None, instance), temp))
    }

    pub(crate) async fn pg_done(state: AppState, temp: PgTemp) {
        crate::db::close(&state.db).await;
        drop(temp);
    }

    /// The account key of the backup phrase `abandon` x11 `about`.
    pub(crate) const PHRASE_KEY: &str = "IOGfm4VeaU9qsds79702OGowi43niF7E3YP1w8Qi4qM";

    /// A signature by `PHRASE_KEY` over `phrase_message`, as base64url without padding.
    pub(crate) fn phrase_sign(purpose: &str, username: &str, nonce: &str, context: &str) -> String {
        use base64::Engine;
        use ed25519_dalek::{Signer, SigningKey};
        let secret: [u8; 32] =
            hex::decode("3ce6f2b19c948b2c6f3cc5d0f429bab3812866054615593caf48839dec55ca2f")
                .expect("hex")
                .try_into()
                .expect("32 bytes");
        let message = crate::api::reauth::phrase_message(purpose, username, nonce, context);
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(SigningKey::from_bytes(&secret).sign(&message).to_bytes())
    }

    /// A grant-shaped value (64 hex characters) derived from `name`, for tests.
    pub(crate) fn test_grant(name: &str) -> String {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(name.as_bytes()))
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
            recovery_pub: None,
            recovery_set_at: None,
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
        crate::db::recount_members(db, server)
            .await
            .expect("recount");
    }

    /// Requires roles to view on every channel with rules, as the upgrade backfill does for
    /// channels that were private before restrictions existed.
    pub(crate) async fn restrict_ruled(db: &Db) {
        sqlx::query("UPDATE channels SET restrict_view = 1 WHERE EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = channels.id)")
            .execute(db)
            .await
            .expect("restrict ruled channels");
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;
    use crate::api::test_util::{done, temp_state};
    use crate::server::client_ip::ProxyTrust;

    #[test]
    fn source_scans_see_all_code_outside_test_modules() {
        let db_mod = include_str!("../db/mod.rs");
        assert_eq!(test_util::non_test_code(db_mod), db_mod);
        let code = [
            "fn a() {}",
            "#[cfg(test)]",
            "mod tests;",
            "fn b() {}",
            "#[cfg(test)]",
            "pub(crate) mod util {",
            "    fn c() {}",
            "}",
            "fn d() {}",
            "#[cfg(test)]",
            "mod more {",
            "    fn f() {}",
            "} // tests",
            "pub fn g() {",
            "    h();",
            "}",
            "#[cfg(test)]",
            "mod tests {",
            "    fn e() {}",
            "}",
            "",
        ]
        .join("\n");
        let kept = test_util::non_test_code(&code);
        assert_eq!(
            kept.lines().count(),
            code.lines().count(),
            "line numbers stay"
        );
        let kept: Vec<&str> = kept.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(
            kept,
            [
                "fn a() {}",
                "#[cfg(test)]",
                "mod tests;",
                "fn b() {}",
                "fn d() {}",
                "pub fn g() {",
                "    h();",
                "}"
            ]
        );
    }

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
        for f in features::Feature::ALL {
            assert!(!denied.on(f), "{f:?} is off while settings can't be read");
        }
        assert_eq!(denied.registration, features::Registration::Closed);
        assert!(!denied.password_signup());
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
        let topics = seed(None, Some("channel_topics"));
        for switch in ProfanitySwitch::ALL {
            let want = switch == ProfanitySwitch::ChannelTopics;
            assert_eq!(on(&topics, switch.key()), Some(want), "{switch:?}");
        }
        let categories = seed(None, Some("category_names"));
        for switch in ProfanitySwitch::ALL {
            let want = switch == ProfanitySwitch::CategoryNames;
            assert_eq!(on(&categories, switch.key()), Some(want), "{switch:?}");
        }
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
        assert!(stale.profanity_targets.channel_topics);
        assert!(stale.profanity_targets.category_names);
        assert!(!stale.profanity_targets.messages && stale.profanity_targets.usernames);
    }

    #[test]
    fn settings_from_an_older_copy_get_the_switch_defaults() {
        let old: Settings = serde_json::from_value(serde_json::json!({
            "profanity_filter": true,
            "asset_previews": true,
            "asset_uploads": false,
            "guests_enabled": true,
        }))
        .expect("older settings");
        for f in features::Feature::ALL {
            assert_eq!(old.on(f), f.default_on(), "{f:?}");
        }
        assert_eq!(old.registration, features::Registration::Open);
        assert!(old.password_signup());
        let signup = |registration: &str, password_login: bool| {
            serde_json::from_value::<Settings>(serde_json::json!({
                "profanity_filter": true,
                "asset_previews": true,
                "asset_uploads": true,
                "guests_enabled": true,
                "registration": registration,
                "password_login": password_login,
            }))
            .expect("settings")
            .password_signup()
        };
        assert!(signup("open", true));
        assert!(!signup("open", false) && !signup("sso", true) && !signup("closed", true));
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
        // P2P files are never checked by the instance filter, in channels too.
        assert!(send(p2p("fuck.png")).await.is_ok());
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
        assert!(send(p2p("fuck.png")).await.is_ok());
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
    fn client_matcher_agrees_with_the_server_filter() {
        let all = settings_with(true, ProfanityTargets::ALL);
        for text in rchat_profanity::SAMPLES.lines() {
            let profane = rust_next_wasm::is_profane(text);
            assert_eq!(
                all.blocks(ProfanityTarget::ServerNames, text),
                profane,
                "{text}"
            );
            assert_eq!(
                all.blocks(ProfanityTarget::Messages, text),
                profane,
                "{text}"
            );
            let masked = rust_next_wasm::mask_profanity(text);
            assert_eq!(masked.chars().count(), text.chars().count(), "{text}");
            assert_eq!(masked != text, profane, "{text:?} -> {masked:?}");
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

    async fn get_as(state: &AppState, path: &str, token: Option<&str>) -> (StatusCode, String) {
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app =
            routes(state.clone(), &Roles::ALL, ClientIp(trusted), None).with_state(state.clone());
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
        let req = reqwest::Client::new().get(format!("http://{addr}{path}"));
        let req = match token {
            Some(token) => req.bearer_auth(token),
            None => req,
        };
        let res = req.send().await.expect("request");
        let status = res.status();
        let body = res.text().await.expect("body");
        server.abort();
        (status, body)
    }

    #[tokio::test]
    async fn a_token_lookup_that_fails_is_503_not_401() {
        let (state, path) = temp_state("auth_unavailable").await;
        let db = &state.db;
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('bob', 'bob', 'x', 'text', 'identicon', 0)")
            .execute(db)
            .await
            .expect("user");
        sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'bob', 0)")
            .bind(crate::db::secret_key("tok-bob"))
            .execute(db)
            .await
            .expect("token");
        let found = user_for_token(&state, "tok-bob").await.expect("lookup");
        assert_eq!(found.map(|u| u.username).as_deref(), Some("bob"));
        assert!(
            user_for_token(&state, "tok-nobody")
                .await
                .expect("lookup")
                .is_none()
        );
        assert_eq!(
            get_as(&state, "/me", Some("tok-bob")).await.0,
            StatusCode::OK
        );
        assert_eq!(
            get_as(&state, "/me", Some("tok-nobody")).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert!(AUTH_UNAVAILABLE.is_ascii());
        let unavailable = serde_json::json!({ "error": AUTH_UNAVAILABLE }).to_string();
        let url = format!("sqlite://{}?mode=rwc", path.display());
        let starved = sqlx::any::AnyPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_millis(200))
            .connect(&url)
            .await
            .expect("starved pool");
        let held = starved.acquire().await.expect("the only connection");
        let stalled = state.clone().with_reader(starved.clone());
        for token in ["tok-bob", "tok-nobody"] {
            let ApiError(code, msg) = user_for_token(&stalled, token)
                .await
                .err()
                .expect("lookup fails");
            assert_eq!(
                (code, msg.as_str()),
                (StatusCode::SERVICE_UNAVAILABLE, AUTH_UNAVAILABLE)
            );
        }
        for path in ["/me", "/invites/rchat", "/openapi.json"] {
            assert_eq!(
                get_as(&stalled, path, Some("tok-bob")).await,
                (StatusCode::SERVICE_UNAVAILABLE, unavailable.clone()),
                "{path}"
            );
        }
        assert_eq!(
            get_as(&stalled, "/me", None).await.0,
            StatusCode::UNAUTHORIZED
        );
        drop(held);
        starved.close().await;
        crate::db::close(&state.db).await;
        assert_eq!(
            get_as(&state, "/me", Some("tok-bob")).await,
            (StatusCode::SERVICE_UNAVAILABLE, unavailable)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn invites_have_their_own_strict_limiter() {
        let (state, path) = temp_state("strict_invites").await;
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app =
            routes(state.clone(), &Roles::ALL, ClientIp(trusted), None).with_state(state.clone());
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
            (true, "/config_shares", 40),
            (true, "/identity/p2p_binding", 40),
            (true, "/auth/recovery/challenge", 40),
            (true, "/auth/recovery", 40),
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
        assert!(limited["/config_shares"] >= 5, "{limited:?}");
        assert!(limited["/identity/p2p_binding"] >= 5, "{limited:?}");
        assert!(limited["/auth/recovery/challenge"] >= 5, "{limited:?}");
        assert!(limited["/auth/recovery"] >= 5, "{limited:?}");
        assert_eq!(limited["/auth/words/nobody"], 0, "{limited:?}");
        assert_eq!(limited["/settings"], 0, "{limited:?}");
        done(state, path).await;
    }

    #[tokio::test]
    async fn server_names_and_passwords_change_in_the_strict_bucket() {
        let (state, path) = temp_state("strict_servers").await;
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app =
            routes(state.clone(), &Roles::ALL, ClientIp(trusted), None).with_state(state.clone());
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
        for (n, (method, path)) in [
            ("PATCH", "/servers/club"),
            ("POST", "/servers"),
            ("POST", "/servers/club/passwords"),
            ("GET", "/servers/club"),
            ("GET", "/servers/club/passwords"),
        ]
        .into_iter()
        .enumerate()
        {
            let mut count = 0;
            for _ in 0..40 {
                let res = client
                    .request(
                        method.parse().expect("method"),
                        format!("http://{addr}{path}"),
                    )
                    .header("X-Forwarded-For", format!("203.0.113.{n}"))
                    .send()
                    .await
                    .expect("request");
                if res.status() == StatusCode::TOO_MANY_REQUESTS {
                    count += 1;
                }
            }
            limited.insert(format!("{method} {path}"), count);
        }
        server.abort();
        assert!(limited["PATCH /servers/club"] >= 5, "{limited:?}");
        assert!(limited["POST /servers"] >= 5, "{limited:?}");
        assert!(limited["POST /servers/club/passwords"] >= 5, "{limited:?}");
        assert_eq!(limited["GET /servers/club"], 0, "{limited:?}");
        assert_eq!(limited["GET /servers/club/passwords"], 0, "{limited:?}");
        done(state, path).await;
    }

    #[test]
    fn grant_lists_are_shaped_deduped_and_capped() {
        let one = "a".repeat(64);
        let list = format!("{one},{one}, bogus,{},{}", "A".repeat(64), "b".repeat(65));
        assert_eq!(parse_grants([list.as_str()]), vec![one.clone()]);
        let many: Vec<String> = (0..500).map(|n| format!("{n:064x}")).collect();
        let joined = many.join(",");
        let parsed = parse_grants([joined.as_str(), one.as_str()]);
        assert_eq!(parsed.len(), GRANTS_MAX);
        assert_eq!(parsed[..], many[..GRANTS_MAX]);
    }

    #[test]
    fn media_removed_events_carry_no_file_name() {
        let ev = crate::ws::WsEvent::MediaRemoved {
            server: Some("rchat".to_string()),
            channel_id: Some(1),
            dm_id: None,
            dm_users: None,
            message_id: 2,
            removed_by_author: false,
        };
        let json = serde_json::to_value(&ev).expect("json");
        assert!(json.get("filename").is_none(), "{json}");
        assert_eq!(json["message_id"], 2);
    }

    #[test]
    fn forward_origins_are_structured_and_old_labels_still_read() {
        let channel = Origin::Channel {
            channel: "general".to_string(),
            server: "Rust \u{b7} Club".to_string(),
        };
        let fwd = ForwardRef::new(None, 1, 2, Some(&channel.stored()), None);
        assert_eq!(
            (
                fwd.origin.as_deref(),
                fwd.origin_dm,
                fwd.origin_channel.as_deref(),
                fwd.origin_server.as_deref()
            ),
            (
                Some("#general - Rust \u{b7} Club"),
                false,
                Some("general"),
                Some("Rust \u{b7} Club")
            )
        );
        let dm = ForwardRef::new(None, 1, 2, Some(&Origin::Dm.stored()), None);
        assert_eq!(
            (dm.origin.as_deref(), dm.origin_dm, dm.origin_server),
            (Some("Direct message"), true, None)
        );
        let none = ForwardRef::new(None, 1, 2, None, None);
        assert_eq!((none.origin, none.origin_dm), (None, false));
        for (old, origin) in [
            ("Direct message", Origin::Dm),
            (
                "#general \u{b7} RChat",
                Origin::Channel {
                    channel: "general".to_string(),
                    server: "RChat".to_string(),
                },
            ),
            (
                "Pub Hall",
                Origin::Server {
                    server: "Pub Hall".to_string(),
                },
            ),
        ] {
            assert_eq!(Origin::parse(old), origin);
        }
    }
}
